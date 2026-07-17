import { Context } from 'grammy';
import {
  sendToAgent,
  sendLoopToAgent,
  clearConversation,
  CLAUDE_CANCEL_SENTINEL_TEXT,
  StaleTurnError,
  assertTurnIsCurrent,
  type AgentUsage,
} from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { config } from '../../config.js';
import { messageSender } from '../../telegram/message-sender.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage, shouldNotifyStale, getStaleAgeMinutes } from '../middleware/stale-filter.js';
import {
  queueRequest,
  isProcessing,
  getQueuePosition,
  setAbortController,
  cancelRequest,
  clearQueue,
  QueueFailsafeTimeoutError,
  QueueWaitTimeoutError,
} from '../../claude/request-queue.js';
import { isClaudeCommand } from '../../claude/command-parser.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';
import { createTelegraphFromFile } from '../../telegram/telegraph.js';
import { getStreamingMode, executeRedditFetch, executeMediumFetch, showExtractMenu, projectStatusSuffix, resumeCommandMessage } from './command.handler.js';
import { executeVReddit } from '../../reddit/vreddit.js';
import { detectPlatform, isValidUrl } from '../../media/extract.js';
import { detectInboxUrl, processLinkInbox } from '../../media/link-inbox.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import { setVoiceFirstMode } from '../../tts/tts-settings.js';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot, isPathWithinRoot } from '../../utils/workspace-guard.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { sendFollowUpButtons, dismissFollowUpButtons } from '../../telegram/followup-buttons.js';
import { getInputLogRowId, forgetInputLogRowId } from '../middleware/input-log.middleware.js';
import { markProcessing, markDone, markDropped, markError } from '../../inbox/input-log.js';
import { detectCapture, formatCaptureProof, getCaptureLedger } from '../../memory/capture-ledger.js';
import { sendProactiveRecall } from '../../memory/proactive-recall.js';
import {
  createRequestContext,
  disposeRequestContext,
  markSuccess,
  markCancelled,
  HandlerState,
  type RequestContext,
  type RequestOrigin,
} from '../../handler/request-context.js';

async function replyFeatureDisabled(ctx: Context, feature: string): Promise<void> {
  await ctx.reply(`⚠️ ${feature} feature is disabled in configuration.`, { parse_mode: undefined });
}


function extractRedditUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/\S+/gi);
  if (!matches) return null;
  for (const match of matches) {
    try {
      const url = new URL(match);
      if (url.hostname === 'reddit.com' || url.hostname.endsWith('.reddit.com') || url.hostname === 'redd.it' || url.hostname === 'v.redd.it') {
        return match;
      }
    } catch {
      // ignore malformed URLs
    }
  }
  return null;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function getProgressBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round(clamped / 10);
  const empty = 10 - filled;
  const color = clamped >= 80 ? '🔴' : clamped >= 60 ? '🟡' : '🟢';
  return color + ' [' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

async function sendUsageFooter(
  ctx: Context,
  usage: AgentUsage | undefined,
): Promise<void> {
  if (!config.CONTEXT_SHOW_USAGE || !usage) return;
  const u = usage;
  const pct = u.contextWindow > 0
    ? Math.round(((u.inputTokens + u.outputTokens + u.cacheReadTokens) / u.contextWindow) * 100)
    : 0;
  const bar = getProgressBar(pct);
  const footer = `${bar} ${pct}% context · ${fmtTokens(u.inputTokens + u.outputTokens + u.cacheReadTokens)}/${fmtTokens(u.contextWindow)} · $${u.totalCostUsd.toFixed(4)} · ${u.numTurns} turns`;
  await ctx.reply(footer, { parse_mode: undefined });
}

async function sendCompactionNotification(
  ctx: Context,
  compaction: { trigger: 'manual' | 'auto'; preTokens: number } | undefined,
): Promise<void> {
  if (!config.CONTEXT_NOTIFY_COMPACTION || !compaction) return;
  const c = compaction;
  console.log(`[Compaction] Sending notification: trigger=${c.trigger}, preTokens=${c.preTokens}`);
  const emoji = c.trigger === 'auto' ? '⚠️' : 'ℹ️';
  const triggerLabel = c.trigger === 'auto' ? 'Auto-compacted' : 'Manually compacted';
  try {
    const msg = `${emoji} *Context Compacted*\n\n`
      + `${esc(triggerLabel)} — previous context was ${esc(fmtTokens(c.preTokens))} tokens\\.\n`
      + `The agent now has a summarized version of your conversation\\.\n\n`
      + `_Tip: Use /handoff before compaction to save a detailed context document\\._`;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('[Compaction] Failed to send notification:', err);
    // Fallback to plain text if MarkdownV2 fails
    try {
      await ctx.reply(
        `${emoji} Context Compacted\n\n`
        + `${triggerLabel} — previous context was ${fmtTokens(c.preTokens)} tokens.\n`
        + `The agent now has a summarized version of your conversation.`,
        { parse_mode: undefined }
      );
    } catch (fallbackErr) {
      console.error('[Compaction] Fallback notification also failed:', fallbackErr);
    }
  }
}

async function sendSessionInitNotification(
  ctx: Context,
  sessionKey: string,
  sessionInit: { model: string; sessionId: string } | undefined,
): Promise<void> {
  if (!config.CONTEXT_NOTIFY_COMPACTION || !sessionInit) return;
  const previousSessionId = sessionManager.getSession(sessionKey)?.claudeSessionId;
  if (previousSessionId && sessionInit.sessionId !== previousSessionId) {
    const msg = `🔄 *New Agent Session*\n\n`
      + `A new agent session has started \\(previous context may be summarized\\)\\.\n`
      + `Model: \`${esc(sessionInit.model)}\`\n\n`
      + `_The agent may not remember earlier details\\. Consider sharing context\\._`;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  }
}

/**
 * Build the standard onLongRunning / onHardCap callbacks for a Telegram-context
 * RequestContext. Mai-Intervention Phase C.1 / V2.5-1.
 *
 * onLongRunning sends ONE non-finalizing heartbeat. The agent stream keeps
 * running; this is purely UX.
 *
 * onHardCap is invoked AFTER finalizeOnce has been won by the timer and AFTER
 * gracefulCancel has been issued. It sends the user-facing timeout reply.
 * Late real responses are silently discarded by the handler's success branch
 * because their finalizeOnce() call returns false.
 */
function buildContextCallbacks(ctx: Context): {
  onLongRunning: (reqCtx: RequestContext) => Promise<void>;
  onHardCap: (reqCtx: RequestContext) => Promise<void>;
} {
  const onLongRunning = async (reqCtx: RequestContext): Promise<void> => {
    const msg = config.HANDLER_LONG_RUNNING_MESSAGE;
    if (!msg) return;
    try {
      await ctx.reply(msg, { parse_mode: undefined });
    } catch (err) {
      console.debug(
        `[RequestContext ${reqCtx.requestId}] long-running notify failed:`,
        err,
      );
    }
  };

  const onHardCap = async (reqCtx: RequestContext): Promise<void> => {
    const minutes = Math.round(reqCtx.effectiveTimeoutMs / 60000); // allow-hardcoded: reason="ms→min display conversion, not a timeout value"
    try {
      await ctx.reply(
        `⏱ Timeout: Keine Antwort nach ${minutes} Min. Bitte nochmal senden.`,
        { parse_mode: undefined },
      );
    } catch (err) {
      console.debug(
        `[RequestContext ${reqCtx.requestId}] hard-cap notify failed:`,
        err,
      );
    }
  };

  return { onLongRunning, onHardCap };
}

function getAutoVRedditUrl(text: string): string | null {
  if (!config.VREDDIT_ENABLED) return null;

  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return null;

  const url = extractRedditUrl(trimmed);
  if (!url) return null;

  const tokens = trimmed.split(/\s+/);
  const isSolo = tokens.length === 1;
  const askedForVReddit = /\bvreddit\b|\bv\s*reddit\b/i.test(trimmed);

  return isSolo || askedForVReddit ? url : null;
}

export async function handleMessage(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const text = ctx.message?.text;
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;

  if (!keyInfo || !text || !messageId || !messageDate) return;
  const { chatId, sessionKey } = keyInfo;

  // Deactivate voice-first mode when user switches to typing
  setVoiceFirstMode(sessionKey, false);

  // Filter stale messages (sent before bot started, older than 3 min)
  if (isStaleMessage(messageDate)) {
    console.log(`[Message] Ignoring stale message ${messageId} from before bot start`);
    if (shouldNotifyStale(sessionKey)) {
      const mins = getStaleAgeMinutes(messageDate);
      try {
        await ctx.reply(`⚡ Ich war kurz offline. Deine Nachricht von vor ~${mins} Minute${mins === 1 ? '' : 'n'} habe ich leider verpasst — bitte schick sie nochmal!`);
      } catch { /* ignore — notification is best-effort */ }
    }
    return;
  }

  // Check for duplicate messages (Telegram retries)
  if (isDuplicate(messageId)) {
    console.log(`[Message] Ignoring duplicate message ${messageId}`);
    return;
  }
  markProcessed(messageId);

  // Dismiss previous follow-up buttons
  await dismissFollowUpButtons(ctx, sessionKey);

  // Check if this is a reply to a ForceReply prompt
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from?.is_bot) {
    const replyText = replyTo.text || '';

    // Handle project path reply
    if (replyText.includes('Set Project Directory')) {
      await handleProjectReply(ctx, sessionKey, text);
      return;
    }

    // Handle telegraph/instant view reply (check BEFORE file - both have "file path")
    if (replyText.includes('Instant View') || replyText.includes('Markdown files')) {
      await handleTelegraphReply(ctx, sessionKey, text);
      return;
    }

    // Handle file download reply
    if (replyText.includes('Download File')) {
      await handleFileReply(ctx, sessionKey, text);
      return;
    }

    // Handle plan mode reply
    if (replyText.includes('Plan Mode') || replyText.includes('Describe your task')) {
      await handleAgentReply(ctx, sessionKey, text, 'plan');
      return;
    }

    // Handle explore mode reply
    if (replyText.includes('Explore Mode') || replyText.includes('What would you like to know')) {
      await handleAgentReply(ctx, sessionKey, text, 'explore');
      return;
    }

    // Handle loop mode reply
    if (replyText.includes('Loop Mode') || replyText.includes('work iteratively')) {
      await handleAgentReply(ctx, sessionKey, text, 'loop');
      return;
    }

    // Handle reddit fetch reply
    if (replyText.includes('Reddit Fetch') || replyText.includes('Reddit target')) {
      if (!config.REDDIT_ENABLED) {
        await replyFeatureDisabled(ctx, 'Reddit');
        return;
      }
      await executeRedditFetch(ctx, text.trim());
      return;
    }

    // Handle Reddit video fetch reply
    if (replyText.includes('Reddit Video')) {
      if (!config.VREDDIT_ENABLED) {
        await replyFeatureDisabled(ctx, 'Reddit video');
        return;
      }
      await executeVReddit(ctx, text.trim());
      return;
    }

    // Handle medium fetch reply
    if (replyText.includes('Medium Fetch') || replyText.includes('Medium article')) {
      if (!config.MEDIUM_ENABLED) {
        await replyFeatureDisabled(ctx, 'Medium');
        return;
      }
      await executeMediumFetch(ctx, text.trim());
      return;
    }

    // Handle extract media reply
    if (replyText.includes('Extract Media') || replyText.includes('Paste a URL')) {
      if (!config.EXTRACT_ENABLED) {
        await replyFeatureDisabled(ctx, 'Extract');
        return;
      }
      await showExtractMenu(ctx, text.trim());
      return;
    }
  }

  const vRedditUrl = getAutoVRedditUrl(text);
  if (vRedditUrl) {
    await executeVReddit(ctx, vRedditUrl);
    return;
  }

  const trimmedText = text.trim();

  // Auto Link-Inbox: solo YouTube/TikTok/Instagram URLs → transcript + save (no Claude)
  if (config.EXTRACT_ENABLED) {
    const inboxUrl = detectInboxUrl(trimmedText);
    if (inboxUrl) {
      await processLinkInbox(ctx, inboxUrl, sessionKey);
      return;
    }
  }

  // Skip if this is a Claude command (handled by command handler)
  if (isClaudeCommand(text)) {
    return;
  }

  // Sprint 5 capture contract: surface already-due items at the next turn,
  // then persist any explicit memory/term/commitment BEFORE acknowledging it.
  // A failed durable write is terminal for this capture; we never claim it was
  // remembered merely because the input-log received the Telegram update.
  await sendProactiveRecall(ctx, sessionKey);
  const capture = detectCapture(text);
  if (capture) {
    try {
      const record = getCaptureLedger().capture({
        sessionKey,
        chatId,
        content: text.trim(),
        kind: capture.kind,
        dueAtUtc: capture.dueAtUtc,
      });
      await ctx.reply(formatCaptureProof(record), { parse_mode: undefined });
    } catch (error) {
      console.error('[Capture] durable write failed:', error);
      await ctx.reply(
        '⚠️ Nicht gespeichert: Der dauerhafte Capture-Speicher konnte nicht schreiben. Ich behaupte deshalb nicht, es zu merken.',
        { parse_mode: undefined },
      );
      return;
    }
  }

  // Check for active session — auto-resume from disk if bot restarted
  const session = sessionManager.getOrResumeSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nUse `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // If CANCEL_ON_NEW_MESSAGE is enabled, auto-cancel the running query;
  // otherwise queue the new message behind it and show the queue position.
  if (isProcessing(sessionKey)) {
    if (config.CANCEL_ON_NEW_MESSAGE) {
      await cancelRequest(sessionKey);
      clearQueue(sessionKey);
    } else {
      const position = getQueuePosition(sessionKey) + 1;
      await ctx.reply(`⏳ Queued \\(position ${position}\\)`, { parse_mode: 'MarkdownV2' });
    }
  }

  // Schlachtplan Akt 1.2: durable Input-Log row recorded by the middleware
  // before sequentialize. Track its lifecycle through the agent turn.
  const inputLogRowId = getInputLogRowId(chatId, messageId);

  try {
    // Queue the request - process one at a time per session. The handler
    // receives `turnEpoch` (the dequeue-bound ownership token) and threads it
    // into sendToAgent so a late old turn cannot corrupt a newer turn's state.
    await queueRequest(sessionKey, text, async (turnEpoch) => {
      // D0 Hardening Item 1 / Codex Amendment B (2026-05-27): close the
      // dequeue→createRequestContext race-window BEFORE any side-effect.
      assertTurnIsCurrent(sessionKey, turnEpoch);
      markProcessing(inputLogRowId);
      if (getStreamingMode() === 'streaming') {
        await handleStreamingResponse(ctx, sessionKey, text, turnEpoch, inputLogRowId);
      } else {
        await handleWaitResponse(ctx, sessionKey, chatId, text, turnEpoch, inputLogRowId);
      }
    });
    markDone(inputLogRowId);
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') {
      markDropped(inputLogRowId, 'queue_cleared');
      forgetInputLogRowId(chatId, messageId);
      return;
    }
    // Codex round 7: stale turn superseded by a newer one — swallow silently.
    if (error instanceof StaleTurnError) {
      console.log(`[handleMessage] stale turn discarded for ${sessionKey} (epoch ${error.turnEpoch})`);
      markDropped(inputLogRowId, 'superseded');
      forgetInputLogRowId(chatId, messageId);
      return;
    }
    // Stage 2b Action 3: queue failsafe-timeout fired AFTER the RequestContext
    // hard-cap already replied to the user. Swallow silently to avoid a
    // doppel-message (the 2026-05-11 21:01 pattern observed by the user).
    if (error instanceof QueueFailsafeTimeoutError) {
      console.log(
        `[handleMessage] swallowing QueueFailsafeTimeoutError for ${sessionKey} ` +
          `— RequestContext.onHardCap already replied.`,
      );
      markDropped(inputLogRowId, 'queue_failsafe_timeout');
      forgetInputLogRowId(chatId, messageId);
      return;
    }
    // Stage 2b Action 1: queued item exceeded wait-bound BEFORE its
    // RequestContext was created. Surface a single timeout message — this is
    // the only layer that owns the user-reply for this case.
    if (error instanceof QueueWaitTimeoutError) {
      console.log(
        `[handleMessage] queue-wait timeout for ${sessionKey} after ${Math.round(error.waitedMs / 1000)}s`, // allow-hardcoded: reason="ms→s log conversion"
      );
      markDropped(inputLogRowId, 'queue_wait_timeout');
      try {
        await ctx.reply(
          '⏱ Timeout: Deine Anfrage hat zu lange in der Warteschlange gewartet. Bitte nochmal senden.',
          { parse_mode: undefined },
        );
      } catch { /* best-effort */ }
      forgetInputLogRowId(chatId, messageId);
      return;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error handling message:', error);
    markError(inputLogRowId, errorMessage.slice(0, 200));
    await ctx.reply(`❌ Error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
  } finally {
    forgetInputLogRowId(chatId, messageId);
  }
}

// Handle reply to project ForceReply prompt
async function handleProjectReply(ctx: Context, sessionKey: string, projectPath: string): Promise<void> {
  let resolvedPath = projectPath.trim();

  // Handle ~ expansion
  if (resolvedPath.startsWith('~')) {
    resolvedPath = path.join(process.env.HOME || '', resolvedPath.slice(1));
  }

  // Resolve to absolute path
  resolvedPath = path.resolve(resolvedPath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, resolvedPath)) {
    await ctx.reply(
      `❌ Path must be within workspace root: \`${esc(workspaceRoot)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Check if exists
  if (!fs.existsSync(resolvedPath)) {
    await ctx.reply(
      `❌ Path not found: \`${esc(resolvedPath)}\`\n\nPlease check the path and try again\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Check if directory
  if (!fs.statSync(resolvedPath).isDirectory()) {
    await ctx.reply(
      `❌ Not a directory: \`${esc(resolvedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Set the project
  sessionManager.setWorkingDirectory(sessionKey, resolvedPath);
  clearConversation(sessionKey);

  const projectName = path.basename(resolvedPath);
  await ctx.reply(
    `✅ Project set: *${esc(projectName)}*\n\n\`${esc(resolvedPath)}\`\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(sessionKey)}`,
    { parse_mode: 'MarkdownV2' }
  );

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await ctx.reply(resumeCommandMessage(s.claudeSessionId), { parse_mode: 'MarkdownV2' });
  }
}

// Handle reply to file ForceReply prompt
async function handleFileReply(ctx: Context, sessionKey: string, filePath: string): Promise<void> {
  const trimmedPath = filePath.trim();

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const fullPath = trimmedPath.startsWith('/')
    ? trimmedPath
    : path.join(session.workingDirectory, trimmedPath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await ctx.reply(
      `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await ctx.reply(
      `❌ File not found: \`${esc(trimmedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  if (fs.statSync(fullPath).isDirectory()) {
    await ctx.reply(
      `❌ That's a directory, not a file: \`${esc(trimmedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const success = await messageSender.sendDocument(ctx, fullPath, `📎 ${path.basename(fullPath)}`);

  if (!success) {
    await ctx.reply(
      '❌ Failed to send file\\. It may be too large \\(\\>50MB\\) or inaccessible\\.',
      { parse_mode: 'MarkdownV2' }
    );
  }
}

/**
 * Handle reply to /plan, /explore, /loop ForceReply prompts AND direct
 * command-argument invocations (Stage 2b Action 4: command.handler.ts
 * `handlePlan`/`handleExplore`/`handleLoop` now delegate here so the
 * RequestContext state-machine is the single agent-call entry-point for
 * /plan, /explore, /loop. DRY-er than maintaining 4 near-identical bodies.
 */
export async function handleAgentReply(
  ctx: Context,
  sessionKey: string,
  input: string,
  mode: 'plan' | 'explore' | 'loop'
): Promise<void> {
  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const trimmedInput = input.trim();
  if (!trimmedInput) {
    await ctx.reply(
      '❌ Please provide a description\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  try {
    await queueRequest(sessionKey, trimmedInput, async (turnEpoch) => {
      // D0 Hardening Item 1 (2026-05-27): pre-RequestContext epoch guard.
      assertTurnIsCurrent(sessionKey, turnEpoch);
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(sessionKey, abortController, turnEpoch);

      // Phase C.1 / V2.5-2 Option B (Codex Sparring 2026-05-12 conf 0.82):
      // /plan /explore /loop previously had NO hard-cap and could wait forever
      // when the SDK stalls. Wrap with the same RequestContext state machine
      // used by streaming + wait paths so the timeout invariant is universal.
      const origin: RequestOrigin = mode; // 'plan' | 'explore' | 'loop'
      const callbacks = buildContextCallbacks(ctx);
      const reqCtx = createRequestContext(sessionKey, origin, callbacks);

      try {
        let response;
        try {
          if (mode === 'loop') {
            response = await sendLoopToAgent(sessionKey, trimmedInput, {
              onProgress: (progressText) => {
                messageSender.updateStream(ctx, progressText);
              },
              abortController,
              telegramCtx: ctx,
              turnEpoch,
            });
          } else {
            response = await sendToAgent(sessionKey, trimmedInput, {
              onProgress: (progressText) => {
                messageSender.updateStream(ctx, progressText);
              },
              onToolStart: (toolName, input) => {
                messageSender.updateToolOperation(sessionKey, toolName, input, ctx);
              },
              onToolEnd: () => {
                messageSender.clearToolOperation(sessionKey);
              },
              abortController,
              command: mode,
              telegramCtx: ctx,
              turnEpoch,
            });
          }
        } catch (innerErr) {
          const isAbort =
            innerErr instanceof Error &&
            (innerErr.name === 'AbortError' || innerErr.message.includes('aborted'));
          if (!markCancelled(reqCtx, isAbort ? 'user-cancel' : 'system')) {
            // Hard-cap already won: timeout reply has been sent. Cancel the
            // streaming UI and stay silent.
            console.log(
              `[RequestContext ${reqCtx.requestId}] error after finalize discarded: ` +
                (innerErr instanceof Error ? innerErr.message : String(innerErr)),
            );
            try {
              await messageSender.cancelStreaming(ctx);
            } catch { /* best-effort */ }
            return;
          }
          await messageSender.cancelStreaming(ctx);
          throw innerErr;
        }

        // Stage 2c (2026-05-12): cancel-sentinel guard — same rationale as
        // handleStreamingResponse below. Detect the canonical cancel reply and
        // route through cancelStreaming so /plan, /explore and /loop also obey
        // the single-reply invariant when /cancel races a clean agent return.
        const isCancelSentinel = response.text === CLAUDE_CANCEL_SENTINEL_TEXT;
        const wasAlreadyCancelled = reqCtx.state === HandlerState.CANCELLED;
        if (isCancelSentinel || wasAlreadyCancelled) {
          markCancelled(reqCtx, 'user-cancel');
          console.log(
            `[RequestContext ${reqCtx.requestId}] ${mode} cancel-sentinel routed via ` +
              `cancelStreaming (state=${reqCtx.state} sentinel=${isCancelSentinel})`,
          );
          try {
            await messageSender.cancelStreaming(ctx);
          } catch { /* best-effort */ }
          return;
        }

        if (!markSuccess(reqCtx)) {
          console.log(
            `[RequestContext ${reqCtx.requestId}] late ${mode} response discarded ` +
              `(state=${reqCtx.state} reason=${reqCtx.cancelReason})`,
          );
          try {
            await messageSender.cancelStreaming(ctx);
          } catch { /* best-effort */ }
          return;
        }

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);

        // Context visibility notifications
        await sendUsageFooter(ctx, response.usage);
        await sendCompactionNotification(ctx, response.compaction);
        await sendSessionInitNotification(ctx, sessionKey, response.sessionInit);

        // Follow-up action buttons
        await sendFollowUpButtons(ctx, sessionKey, response.text, response.buttons);
      } finally {
        disposeRequestContext(reqCtx);
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    // Codex round 7: stale turn superseded — swallow silently.
    if (error instanceof StaleTurnError) {
      console.log(`[handleAgentReply ${mode}] stale turn discarded for ${sessionKey} (epoch ${error.turnEpoch})`);
      return;
    }
    // Stage 2b Action 3: swallow failsafe (RequestContext already replied).
    if (error instanceof QueueFailsafeTimeoutError) {
      console.log(
        `[handleAgentReply ${mode}] swallowing QueueFailsafeTimeoutError ` +
          `for ${sessionKey} — RequestContext.onHardCap already replied.`,
      );
      return;
    }
    // Stage 2b Action 1: queued item timed out BEFORE RequestContext creation.
    if (error instanceof QueueWaitTimeoutError) {
      console.log(
        `[handleAgentReply ${mode}] queue-wait timeout for ${sessionKey} after ` +
          `${Math.round(error.waitedMs / 1000)}s`, // allow-hardcoded: reason="ms→s log conversion"
      );
      try {
        await ctx.reply(
          '⏱ Timeout: Deine Anfrage hat zu lange in der Warteschlange gewartet. Bitte nochmal senden.',
          { parse_mode: undefined },
        );
      } catch { /* best-effort */ }
      return;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`❌ Error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
  }
}

// Handle reply to telegraph ForceReply prompt
async function handleTelegraphReply(ctx: Context, sessionKey: string, filePath: string): Promise<void> {
  const trimmedPath = filePath.trim();

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const fullPath = trimmedPath.startsWith('/')
    ? trimmedPath
    : path.join(session.workingDirectory, trimmedPath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await ctx.reply(
      `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await ctx.reply(
      `❌ File not found: \`${esc(trimmedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  if (fs.statSync(fullPath).isDirectory()) {
    await ctx.reply(
      `❌ That's a directory, not a file: \`${esc(trimmedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const ext = path.extname(fullPath).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    await ctx.reply(
      '⚠️ Telegraph works best with Markdown files \\(\\.md\\)',
      { parse_mode: 'MarkdownV2' }
    );
  }

  await ctx.reply('📤 Creating Telegraph page\\.\\.\\.', { parse_mode: 'MarkdownV2' });

  const pageUrl = await createTelegraphFromFile(fullPath);

  if (pageUrl) {
    const fileName = path.basename(fullPath);
    await ctx.reply(
      `📄 *${esc(fileName)}*\n\n[Open in Instant View](${esc(pageUrl)})`,
      { parse_mode: 'MarkdownV2' }
    );
  } else {
    await ctx.reply(
      '❌ Failed to create Telegraph page\\.',
      { parse_mode: 'MarkdownV2' }
    );
  }
}

async function handleStreamingResponse(
  ctx: Context,
  sessionKey: string,
  message: string,
  turnEpoch: number,
  inputLogRowId: number | null,
): Promise<void> {
  // D0 Hardening Item 1 (2026-05-27): defense-in-depth epoch guard. Primary
  // guard is in handleMessage's queueRequest callback before markProcessing;
  // this one catches any direct caller that bypassed that path.
  assertTurnIsCurrent(sessionKey, turnEpoch);
  await messageSender.startStreaming(ctx);

  const abortController = new AbortController();
  setAbortController(sessionKey, abortController, turnEpoch);

  // Phase C.1 / V2.5-1+V2.5-2: replace legacy Promise.race(handler, setTimeout) with
  // RequestContext-driven state machine. Hard-cap is the SINGLE source of timeout
  // truth; late agent responses after a timeout are silently discarded by the
  // markSuccess() guard below.
  const callbacks = buildContextCallbacks(ctx);
  const reqCtx = createRequestContext(sessionKey, 'streaming', callbacks);

  let streamingFinished = false;
  try {
    const response = await sendToAgent(sessionKey, message, {
      onProgress: (progressText) => {
        messageSender.updateStream(ctx, progressText);
      },
      onToolStart: (toolName, input) => {
        messageSender.updateToolOperation(sessionKey, toolName, input, ctx);
      },
      onToolEnd: () => {
        messageSender.clearToolOperation(sessionKey);
      },
      abortController,
      telegramCtx: ctx,
      turnEpoch,
      currentInputLogRowId: inputLogRowId,
    });

    // Stage 2c (2026-05-12): cancel-sentinel guard.
    //
    // The agent returns CLAUDE_CANCEL_SENTINEL_TEXT verbatim when it observed
    // isCancelled(sessionKey) === true mid-stream. If we slipped past the
    // markCancelled() race in handleCancel (handleCancel marked AFTER the
    // streaming handler's await resolved), markSuccess() would otherwise win
    // and finishStreaming() would edit the streaming bubble to the sentinel
    // text — producing the live-reproduced doppel-message pattern
    // (1× "🛑 Cancelled." from handleCancel + 1× "✅ Successfully cancelled…"
    // edit on the streaming bubble).
    //
    // The single-reply invariant: handleCancel already sent "🛑 Cancelled." as
    // a fresh bubble. Route this response through the cancel-UI branch so the
    // initial streaming bubble gets edited to the neutral "⚠️ Request cancelled"
    // status (set by cancelStreaming) — never to a second Claude-style reply.
    const isCancelSentinel = response.text === CLAUDE_CANCEL_SENTINEL_TEXT;
    const wasAlreadyCancelled = reqCtx.state === HandlerState.CANCELLED;
    if (isCancelSentinel || wasAlreadyCancelled) {
      // Idempotent: markCancelled returns false if finalize was already won
      // by handleCancel — that's expected and fine, state is already CANCELLED.
      markCancelled(reqCtx, 'user-cancel');
      console.log(
        `[RequestContext ${reqCtx.requestId}] cancel-sentinel routed via ` +
          `cancelStreaming (state=${reqCtx.state} sentinel=${isCancelSentinel})`,
      );
      try {
        await messageSender.cancelStreaming(ctx);
      } catch { /* best-effort cleanup */ }
      return;
    }

    if (!markSuccess(reqCtx)) {
      // Hard-cap or external cancel already won finalize. The user has already
      // seen a timeout/cancel reply. Drop this late response on the floor.
      console.log(
        `[RequestContext ${reqCtx.requestId}] late agent response discarded ` +
          `(state=${reqCtx.state} reason=${reqCtx.cancelReason})`,
      );
      // Stage 2b Action 6: cancel the streaming UI / typing indicator so it
      // doesn't hang after the agent's late response was discarded.
      try {
        await messageSender.cancelStreaming(ctx);
      } catch { /* best-effort cleanup */ }
      return;
    }

    await messageSender.finishStreaming(ctx, response.text);
    streamingFinished = true;
    await maybeSendVoiceReply(ctx, response.text);

    // Context visibility notifications
    await sendUsageFooter(ctx, response.usage);
    await sendCompactionNotification(ctx, response.compaction);
    await sendSessionInitNotification(ctx, sessionKey, response.sessionInit);

    // Follow-up action buttons
    await sendFollowUpButtons(ctx, sessionKey, response.text, response.buttons);
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('aborted'));
    // If the hard-cap already won, suppress: user has seen the timeout message.
    if (!markCancelled(reqCtx, isAbort ? 'user-cancel' : 'system')) {
      console.log(
        `[RequestContext ${reqCtx.requestId}] error after finalize discarded: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      if (!streamingFinished) {
        try {
          await messageSender.cancelStreaming(ctx);
        } catch { /* best-effort cleanup */ }
      }
      return;
    }
    if (!streamingFinished) {
      await messageSender.cancelStreaming(ctx);
    }
    throw error;
  } finally {
    disposeRequestContext(reqCtx);
  }
}

async function handleWaitResponse(
  ctx: Context,
  sessionKey: string,
  chatId: number,
  message: string,
  turnEpoch: number,
  inputLogRowId: number | null,
): Promise<void> {
  // D0 Hardening Item 1 (2026-05-27): defense-in-depth epoch guard, see
  // handleStreamingResponse.
  assertTurnIsCurrent(sessionKey, turnEpoch);
  // Start continuous typing indicator (every 4s)
  const keyInfo = getSessionKeyFromCtx(ctx);
  const typingInterval = messageSender.startTypingIndicator(ctx.api, chatId, keyInfo?.threadId);

  const abortController = new AbortController();
  setAbortController(sessionKey, abortController, turnEpoch);

  // Phase C.1 / V2.5-1+V2.5-2: replace legacy Promise.race(handler, setTimeout)
  // with RequestContext state machine. Same contract as streaming path.
  const callbacks = buildContextCallbacks(ctx);
  const reqCtx = createRequestContext(sessionKey, 'wait', callbacks);

  try {
    let response;
    try {
      response = await sendToAgent(sessionKey, message, {
        abortController,
        telegramCtx: ctx,
        turnEpoch,
        currentInputLogRowId: inputLogRowId,
      });
    } catch (error) {
      const isAbort =
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('aborted'));
      if (!markCancelled(reqCtx, isAbort ? 'user-cancel' : 'system')) {
        // Hard-cap already won: silently swallow this late error — user has
        // seen the timeout message via onHardCap.
        console.log(
          `[RequestContext ${reqCtx.requestId}] error after finalize discarded: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      throw error;
    }

    // Stage 2c (2026-05-12): cancel-sentinel guard for the wait path. Same
    // rationale as the streaming variant: if /cancel races a clean agent
    // return (agent saw isCancelled mid-stream and returned the sentinel),
    // suppress the would-be second user-visible reply. handleCancel already
    // sent "🛑 Cancelled." — we stay silent here to keep the single-reply
    // invariant.
    const isCancelSentinel = response.text === CLAUDE_CANCEL_SENTINEL_TEXT;
    const wasAlreadyCancelled = reqCtx.state === HandlerState.CANCELLED;
    if (isCancelSentinel || wasAlreadyCancelled) {
      markCancelled(reqCtx, 'user-cancel');
      console.log(
        `[RequestContext ${reqCtx.requestId}] wait cancel-sentinel suppressed ` +
          `(state=${reqCtx.state} sentinel=${isCancelSentinel})`,
      );
      return;
    }

    if (!markSuccess(reqCtx)) {
      console.log(
        `[RequestContext ${reqCtx.requestId}] late agent response discarded ` +
          `(state=${reqCtx.state} reason=${reqCtx.cancelReason})`,
      );
      return;
    }

    await messageSender.sendMessage(ctx, response.text);
    await maybeSendVoiceReply(ctx, response.text);

    // Context visibility notifications
    await sendUsageFooter(ctx, response.usage);
    await sendCompactionNotification(ctx, response.compaction);
    await sendSessionInitNotification(ctx, sessionKey, response.sessionInit);

    // Follow-up action buttons
    await sendFollowUpButtons(ctx, sessionKey, response.text, response.buttons);
  } finally {
    // Always stop typing indicator — even on timeout or error
    messageSender.stopTypingInterval(typingInterval);
    disposeRequestContext(reqCtx);
  }
}
