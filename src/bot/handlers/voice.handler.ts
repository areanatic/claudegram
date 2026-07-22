import { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../../config.js';
import {
  sendToAgent,
  CLAUDE_CANCEL_SENTINEL_TEXT,
  StaleTurnError,
  assertTurnIsCurrent,
} from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { messageSender } from '../../telegram/message-sender.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage, shouldNotifyStale, getStaleAgeMinutes } from '../middleware/stale-filter.js';
import {
  queueRequest,
  isProcessing,
  getQueuePosition,
  setAbortController,
  gracefulCancel,
} from '../../claude/request-queue.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';
import { getStreamingMode } from './command.handler.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import { transcribeFile, transcribeFileWithLanguage } from '../../audio/transcribe.js';
import { setVoiceFirstMode, setDetectedLanguage, isVoiceActive } from '../../tts/tts-settings.js';
import { sendTranscriptResult } from './command.handler.js';
import { downloadFileSecure, getTelegramFileUrl } from '../../utils/download.js';
import { sanitizeError, sanitizePath } from '../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { sendFollowUpButtons, dismissFollowUpButtons } from '../../telegram/followup-buttons.js';
import { runPostAgentSuccess } from './post-agent.js';
import { takeFreshTranscribeReply } from './transcribe-pending.js';
import { getInputLogRowId, forgetInputLogRowId } from '../middleware/input-log.middleware.js';
import { getTaskLedgerId } from '../middleware/task-ledger.middleware.js';
import { markProcessing, markDone, markDropped, markError, attachContent, markHandledNoAgent } from '../../inbox/input-log.js';
import { completeTask, failTask, interruptTask, startTask } from '../../inbox/task-ledger.js';
import { tryAutoDispatch } from '../../inbox/input-auto-dispatch.js';
import { withHardTimeout, HardTimeoutError } from '../../utils/hard-timeout.js';
import { commitVoiceRecallNonBlocking } from '../../inbox/voice-recall.js';
import { isPrivate } from '../../memory/privacy-state.js';

export async function handleVoice(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  const voice = ctx.message?.voice;

  if (!keyInfo || !messageId || !messageDate || !voice) return;
  const { chatId, sessionKey } = keyInfo;

  // Schlachtplan Akt 1.2: durable Input-Log row recorded by the middleware
  // before sequentialize. Track its lifecycle so a watchdog-cancel or error
  // leaves an honest status on disk instead of a silently-lost input.
  const inputLogRowId = getInputLogRowId(chatId, messageId);
  const taskLedgerId = getTaskLedgerId(chatId, messageId);

  // Stale/duplicate filters
  if (isStaleMessage(messageDate)) {
    console.log(`[Voice] Ignoring stale voice message ${messageId}`);
    if (shouldNotifyStale(sessionKey)) {
      const mins = getStaleAgeMinutes(messageDate);
      try {
        await ctx.reply(`⚡ Ich war kurz offline. Deine Nachricht von vor ~${mins} Minute${mins === 1 ? '' : 'n'} habe ich leider verpasst — bitte schick sie nochmal!`);
      } catch { /* ignore — notification is best-effort */ }
    }
    return;
  }
  if (isDuplicate(messageId)) {
    console.log(`[Voice] Ignoring duplicate voice message ${messageId}`);
    return;
  }
  markProcessed(messageId);

  // Dismiss previous follow-up buttons
  await dismissFollowUpButtons(ctx, sessionKey);

  // RI-23 (Tier-1): route transcribe-only ONLY for a reply to a FRESH /transcribe
  // ForceReply — matched by exact prompt msg-id + same user + TTL + one-shot. A
  // stale "Transcribe Audio" bot text no longer hijacks a real voice question;
  // those fall through to the agent below and ARE answered. (Must run BEFORE
  // session auto-creation — transcribe-only must never spawn an agent session.)
  const replyTo = ctx.message?.reply_to_message;
  if (takeFreshTranscribeReply(chatId, ctx.from?.id ?? 0, replyTo?.message_id)) {
    await handleTranscribeOnly(ctx, chatId, sessionKey, messageId, voice, inputLogRowId, taskLedgerId);
    return;
  }

  // Auto-resume or create session — voice notes must never be blocked
  let session = sessionManager.getOrResumeSession(sessionKey);
  if (!session) {
    session = sessionManager.createSession(sessionKey, config.WORKSPACE_DIR || process.env.HOME || '.');
    console.log(`[Voice] Auto-created session for ${sessionKey}`);
  }

  // Check file size
  const fileSizeBytes = voice.file_size || 0;
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  if (fileSizeMB > config.VOICE_MAX_FILE_SIZE_MB) {
    await ctx.reply(
      `❌ Voice note too large \\(${esc(fileSizeMB.toFixed(1))}MB\\)\\.\n\nPlease send shorter notes \\(max ${config.VOICE_MAX_FILE_SIZE_MB}MB\\)\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Acknowledge receipt
  const ackMsg = await ctx.reply('🎤 Transcribing...', { parse_mode: undefined });

  let tempFilePath: string | null = null;
  // Codex re-review MEDIUM: function-scoped so the outer catch can cancel a
  // dangling streaming bubble when the hard-cap fires while a stream was open.
  let streamingStarted = false;
  // P0 Seamless-Input (2026-06-02): function-scoped copy of the transcript so the
  // outer hard-cap catch can re-dispatch it through the agent (auto-continue)
  // instead of dropping it with "please re-send". null until transcription lands.
  let recoveredTranscript: string | null = null;
  // P0 Seamless-Input (Codex P1-1): the hard-cap onTimeout fires gracefulCancel
  // fire-and-forget and rejects immediately. Capture its promise so the catch can
  // AWAIT the SDK drain BEFORE re-dispatching — otherwise a late-starting mutating
  // tool of the original (zombie) turn could double-execute against the fresh turn.
  let hardCancelDrain: Promise<void> | null = null;

  try {
    // Download voice file from Telegram (with retry for transient network errors)
    console.log(`[Voice] Voice object: file_id=${voice.file_id}, duration=${voice.duration}s, mime=${voice.mime_type}, file_size=${voice.file_size}`);
    const file = await ctx.api.getFile(voice.file_id);
    console.log(`[Voice] getFile response: file_path=${file.file_path}, file_size=${file.file_size}`);
    if (!file.file_path) {
      throw new Error('Telegram did not provide a file path.');
    }
    const fileUrl = getTelegramFileUrl(config.TELEGRAM_BOT_TOKEN, file.file_path);

    // Download using curl with secure stdin config (prevents token exposure in ps)
    const ext = voice.mime_type?.includes('ogg') ? '.ogg' : '.oga';
    tempFilePath = path.join(os.tmpdir(), `nexusgram_voice_${messageId}${ext}`);

    console.log(`[Voice] Downloading voice: expected=${fileSizeBytes} bytes, url=${sanitizePath(fileUrl.replace(/bot[^/]+/, 'bot***'))}`);
    await downloadFileSecure(fileUrl, tempFilePath);

    const audioBuffer = fs.readFileSync(tempFilePath);
    if (!audioBuffer.length) {
      throw new Error('Downloaded empty voice file.');
    }

    // Debug: log actual file size and first bytes to diagnose Groq errors
    const actualSizeMB = audioBuffer.length / (1024 * 1024);
    const headerHex = audioBuffer.subarray(0, 8).toString('hex');
    console.log(`[Voice] Downloaded ${actualSizeMB.toFixed(3)}MB (${audioBuffer.length} bytes, expected ${fileSizeBytes}), header: ${headerHex}`);

    if (audioBuffer.length < 500) {
      console.error(`[Voice] WARNING: Downloaded file suspiciously small (${audioBuffer.length} bytes, expected ${fileSizeBytes}). Possible Telegram client upload bug.`);
      throw new Error('Voice note has no audio data (only OGG headers) — known Telegram Web/Desktop bug. Try sending from the native iOS/Android app, or just send again.');
    }

    // Transcribe using Groq Whisper API with auto language detection.
    // Codex Pattern-B Review Residual #2 (2026-05-28): allowEmpty:true so a
    // genuinely empty Whisper return surfaces as qualityFlag='empty_or_silent'
    // (drop-reason 'voice_empty_silent') instead of being thrown out of
    // transcribeFileWithLanguage as a generic Error and falling into the
    // outer catch where it gets logged as a sanitised error message.
    const transcribeResult = await transcribeFileWithLanguage(tempFilePath, { allowEmpty: true });
    const transcript = transcribeResult.text;
    const detectedLanguage = transcribeResult.languageCode;

    console.log(`[Voice] Transcript received (${transcript.length} chars, lang=${detectedLanguage})`);

    // FIX 6+ Step 1 (2026-05-25): RESCUE-FIRST. Attach transcript to the
    // durable Input-Log row BEFORE any confidence-gate / agent-turn so that
    // even a low-confidence reject, a hard-cap timeout, or a /cancel still
    // leaves the raw transcript searchable via nexusgram_input_log_search.
    // Pre-fix, attachContent ran AFTER the confidence-gate — a dropped voice
    // (e.g. 2026-05-24 21:39 ChatGPT briefing) lost its content forever.
    attachContent(inputLogRowId, transcript);
    // P0 Seamless-Input: capture for the outer hard-cap catch (auto re-dispatch).
    recoveredTranscript = transcript;

    // Stage 2 Voice-Quality-Gate (2026-05-28): differentiated drop-reasons.
    // qualityFlag from transcribe.ts already classifies empty / hollow-bitrate
    // / loop-hallucination / low-confidence. Language-mismatch stays a handler
    // concern (config.VOICE_ALLOWED_LANGUAGES is policy, not signal quality).
    const allowedLangs = config.VOICE_ALLOWED_LANGUAGES;
    const languageOk = allowedLangs.length === 0 || allowedLangs.includes(detectedLanguage);
    const qualityFlag = transcribeResult.qualityFlag;

    if (qualityFlag !== 'ok' || !languageOk) {
      const dropReason = !languageOk
        ? 'language_mismatch'
        : qualityFlag === 'empty_or_silent'
          ? 'voice_empty_silent'
          : qualityFlag === 'low_bitrate_hollow'
            ? 'low_quality_voice'
            : qualityFlag === 'loop_hallucination'
              ? 'loop_hallucination'
              : 'low_confidence_transcript';

      console.warn(
        `[Voice] transcript rejected: lang=${detectedLanguage} languageOk=${languageOk} ` +
        `qualityFlag=${qualityFlag} dropReason=${dropReason} ` +
        `bytesPerSec=${transcribeResult.bytesPerSec ?? 'n/a'} durationSec=${transcribeResult.durationSec ?? 'n/a'} ` +
        `len=${transcript.length} avg_logprob=${transcribeResult.avgLogprob ?? 'n/a'}`,
      );
      markDropped(inputLogRowId, dropReason);

      const hint = !languageOk
        ? `Ich hab dich als "${detectedLanguage}" verstanden — das passt nicht. `
        : qualityFlag === 'empty_or_silent'
          ? 'Das war zu kurz oder leise. '
          : qualityFlag === 'low_bitrate_hollow'
            ? '⚠️ Die Sprachnachricht klingt hohl/leer (oft ein Telegram-Upload-Bug). '
            : qualityFlag === 'loop_hallucination'
              ? '⚠️ Das Audio hat keine erkennbare Sprache enthalten (Whisper hat halluziniert). '
              : 'Das Audio war zu leise, zu kurz oder unklar. ';
      const askResend = `🎤 ${hint}Schick die Sprachnachricht bitte nochmal — oder tipp sie kurz.\n📝 Falls verwertbar: dein Transkript ist gespeichert (input_log).`;
      try {
        await ctx.api.editMessageText(chatId, ackMsg.message_id, askResend, { parse_mode: undefined });
      } catch {
        try { await ctx.reply(askResend); } catch { /* best-effort */ }
      }
      return;
    }

    // RI-28: the primary Voice handler owns the earliest trustworthy
    // transcript. Mirror it into memories + memories_fts now; the asynchronous
    // Capture-Enrichment path repeats the same idempotent postcondition as a
    // recovery belt, never as a duplicate insert.
    await commitVoiceRecallNonBlocking({
      chatId: String(chatId),
      messageId,
      botId: (config.BOT_NAME || 'Nexusgram').toLowerCase().replace(/\s+/g, '-'),
      transcript,
      privacy: isPrivate(sessionKey) ? 'private' : 'public',
      parentTaskId: taskLedgerId,
      notifyDelayed: (notice) => ctx.reply(notice, { parse_mode: undefined }),
    });

    // Activate voice-first mode (if enabled in config) and store detected language
    if (config.VOICE_FIRST_MODE_ENABLED) {
      setVoiceFirstMode(sessionKey, true);
    }
    setDetectedLanguage(sessionKey, detectedLanguage);

    const voiceActive = isVoiceActive(sessionKey);

    // In voice-first mode: minimal transcript display to reduce noise
    // In normal mode: show full transcript if configured
    if (voiceActive) {
      // Show a brief inline transcript (first ~80 chars) so user knows what was heard
      const preview = transcript.length > 80 ? transcript.slice(0, 80) + '...' : transcript;
      try {
        await ctx.api.editMessageText(chatId, ackMsg.message_id, `🎤 "${preview}"`, { parse_mode: undefined });
      } catch {
        try { await ctx.api.deleteMessage(chatId, ackMsg.message_id); } catch { /* ignore */ }
      }
    } else if (config.VOICE_SHOW_TRANSCRIPT) {
      try {
        await ctx.api.editMessageText(
          chatId,
          ackMsg.message_id,
          '🎤 Transcript received\\.',
          { parse_mode: 'MarkdownV2' }
        );
      } catch {
        try { await ctx.api.deleteMessage(chatId, ackMsg.message_id); } catch { /* ignore */ }
      }

      await messageSender.sendMessage(ctx, `👤 ${transcript}`);
    } else {
      try { await ctx.api.deleteMessage(chatId, ackMsg.message_id); } catch { /* ignore */ }
    }

    // Check if already processing - show queue position
    if (isProcessing(sessionKey)) {
      const position = getQueuePosition(sessionKey) + 1;
      await ctx.reply(`⏳ Queued \\(position ${position}\\)`, { parse_mode: 'MarkdownV2' });
    }

    // Schlachtplan Akt 1.3 Fix B: hard cap for the Voice agent turn. The Voice
    // path has no RequestContext state machine — this local cap is its
    // fail-fast guard. On expiry: gracefulCancel tears down the SDK and the
    // turn rejects with HardTimeoutError (handled in the catch below).
    const voiceHardCapMs = config.VOICE_AGENT_HARD_CAP_MS;

    // Codex BLOCKER 1 fix: finalize-once guard. `withHardTimeout` ignores the
    // RESULT of a late-settling op() but cannot stop op()'s side effects. This
    // boolean is the single source of truth for "this turn already produced a
    // user-visible outcome". The hard-cap onTimeout claims it; the agent path
    // checks it before sending any Telegram reply. Whoever loses stays silent.
    let turnFinalized = false;
    const finalizeTurn = (): boolean => {
      if (turnFinalized) return false;
      turnFinalized = true;
      return true;
    };
    // Feed transcript into agent. The queue handler receives `turnEpoch` —
    // the dequeue-bound ownership token — and threads it into sendToAgent.
    await queueRequest(sessionKey, transcript, async (turnEpoch) => {
      // D0 Hardening Item 1 / Amendment A (2026-05-27): close pre-side-effect
      // race-window. Voice handler runs replyWithChatAction + setAbortController
      // + withHardTimeout BEFORE the existing sendToAgent epoch-guard would
      // fire. Same pattern as message.handler.
      assertTurnIsCurrent(sessionKey, turnEpoch);
      startTask(taskLedgerId);
      // Input-Log: turn has been dequeued and is now actually running.
      markProcessing(inputLogRowId);

      await withHardTimeout(
        async () => {
          // Resolve the agent response WITHOUT sending anything yet, so the
          // finalize-once guard can be checked between agent-return and send.
          let response;
          if (isVoiceActive(sessionKey)) {
            // Voice-first mode: skip streaming display, just show typing indicator
            await ctx.replyWithChatAction('typing');
            const abortController = new AbortController();
            setAbortController(sessionKey, abortController, turnEpoch);
            response = await sendToAgent(sessionKey, transcript, {
              abortController,
              voiceMode: true,
              telegramCtx: ctx,
              currentInputLogRowId: inputLogRowId,
              turnEpoch,
            });
          } else if (getStreamingMode() === 'streaming') {
            await messageSender.startStreaming(ctx);
            streamingStarted = true;
            const abortController = new AbortController();
            setAbortController(sessionKey, abortController, turnEpoch);
            try {
              response = await sendToAgent(sessionKey, transcript, {
                onProgress: (progressText) => {
                  messageSender.updateStream(ctx, progressText);
                },
                abortController,
                telegramCtx: ctx,
                currentInputLogRowId: inputLogRowId,
                turnEpoch,
              });
            } catch (error) {
              await messageSender.cancelStreaming(ctx);
              throw error;
            }
          } else {
            await ctx.replyWithChatAction('typing');
            const abortController = new AbortController();
            setAbortController(sessionKey, abortController, turnEpoch);
            response = await sendToAgent(sessionKey, transcript, {
              abortController,
              telegramCtx: ctx,
              currentInputLogRowId: inputLogRowId,
              turnEpoch,
            });
          }

          // Codex BLOCKER 1: if the hard-cap already fired (or /cancel won),
          // the agent return is stale — drop it silently, no double reply.
          if (!finalizeTurn()) {
            console.log(`[Voice] late agent return discarded for ${sessionKey} — turn already finalized`);
            if (streamingStarted) {
              try { await messageSender.cancelStreaming(ctx); } catch { /* best-effort */ }
            }
            return;
          }

          // A /cancel mid-turn returns the cancel sentinel verbatim — the Voice
          // path previously sent it as a normal reply. Suppress it like the
          // text path does. (A tool-budget stop is no longer an error here — it
          // returns a normal partial answer, see interruptForToolBudget.)
          if (response.text === CLAUDE_CANCEL_SENTINEL_TEXT) {
            console.log(`[Voice] cancel-sentinel suppressed for ${sessionKey}`);
            if (streamingStarted) {
              try { await messageSender.cancelStreaming(ctx); } catch { /* best-effort */ }
            }
            markDropped(inputLogRowId, 'cancelled');
            return;
          }

          if (streamingStarted) {
            await messageSender.finishStreaming(ctx, response.text);
            await maybeSendVoiceReply(ctx, response.text, { language: detectedLanguage });
          } else if (isVoiceActive(sessionKey)) {
            // Send voice reply FIRST (primary output in voice mode)
            await maybeSendVoiceReply(ctx, response.text, { language: detectedLanguage, voiceMode: true });
            await messageSender.sendMessage(ctx, response.text);
          } else {
            await messageSender.sendMessage(ctx, response.text);
            await maybeSendVoiceReply(ctx, response.text, { language: detectedLanguage });
          }
          await sendFollowUpButtons(ctx, sessionKey, response.text, response.buttons);
          // Tier-1: same post-agent work as the text path (usage footer + Bug-A
          // rotation guard + compaction/new-session notices). Voice was guard-blind
          // before, so a voice-heavy session could fill the window unchecked.
          await runPostAgentSuccess(ctx, sessionKey, response);
          markDone(inputLogRowId);
          completeTask(taskLedgerId);
        },
        voiceHardCapMs,
        () => {
          // Hard-cap won the race. Claim the turn so a late agent return stays
          // silent, then tear down the SDK. The catch block awaits this drain
          // (hardCancelDrain) before any auto-continue re-dispatch (Codex P1-1).
          finalizeTurn();
          hardCancelDrain = gracefulCancel(sessionKey, 'voice-hard-timeout');
          return hardCancelDrain;
        },
        'voice-turn',
      );
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') {
      markDropped(inputLogRowId, 'queue_cleared');
      interruptTask(taskLedgerId, 'queue_cleared');
      return;
    }
    // Codex round 7: a stale turn was superseded by a newer one. Swallow
    // silently — the newer turn owns the user-facing reply, no error shown.
    if (error instanceof StaleTurnError) {
      console.log(`[Voice] stale turn discarded for ${sessionKey} (epoch ${error.turnEpoch})`);
      markDropped(inputLogRowId, 'superseded');
      interruptTask(taskLedgerId, 'superseded');
      return;
    }

    const isHardTimeout = error instanceof HardTimeoutError;
    let errorMessage: string;
    if (isHardTimeout) {
      // P0 Seamless-Input (2026-06-02): instead of dropping a timed-out voice with
      // "please re-send", try to re-dispatch the stored transcript on a FRESH turn
      // and answer proactively in the channel (flag-gated, side-effect/loop/dedup-
      // guarded — see input-auto-dispatch.ts). Cancel any dangling stream bubble
      // first so the recovery answer is the clean output.
      if (streamingStarted) {
        try { await messageSender.cancelStreaming(ctx); } catch { /* best-effort */ }
        streamingStarted = false;
      }
      // Codex P1-1: wait for the original turn's hard-cancel/SDK drain to finish
      // BEFORE re-dispatch, so a late mutating tool is reflected in tryAutoDispatch's
      // side-effect guard re-read → no double-side-effect against the fresh turn.
      if (hardCancelDrain) {
        try { await hardCancelDrain; } catch { /* best-effort — drain errors don't block */ }
      }
      const outcome = await tryAutoDispatch({
        api: ctx.api,
        chatId,
        sessionKey,
        rowId: inputLogRowId,
        rawContent: recoveredTranscript ?? '',
        inputType: 'voice',
        reason: 'voice_hard_timeout',
        // RF-2/RF-4: reuse the "🎤 Transcribing…" ack as the working-status → answer
        // surface, so no stale ack bubble is left and the user sees honest progress.
        statusMessageId: ackMsg.message_id,
      });
      // 'answered' (re-dispatch replied) or 'handled' (dedup/resend — audit already
      // set) → suppress the fallback. Only 'fallback' sends the re-send notice (P1-2).
      if (outcome !== 'fallback') return; // finally still runs cleanup
      // Fallback (auto-dispatch off or declined): the honest transcript-rescue notice.
      // FIX 6+ Step 1 (2026-05-25): explicit Transcript-Rescue acknowledgement.
      // Pre-fix reply hid the fact that the transcript is in input_log and
      // can be recovered via nexusgram_input_log_search — user thought the
      // briefing was lost (2026-05-24 21:39 ChatGPT-briefing voice_hard_timeout).
      errorMessage = '⏱️ Das hat zu lange gedauert und wurde abgebrochen.\n📝 Dein Transkript ist gespeichert (input_log) und ich kann später drauf zugreifen.\nWenn du eine Antwort brauchst, schick die Frage nochmal — gern etwas kürzer.';
      markDropped(inputLogRowId, 'voice_hard_timeout');
      interruptTask(taskLedgerId, 'voice_hard_timeout');
    } else {
      errorMessage = sanitizeError(error);
      markError(inputLogRowId, errorMessage.slice(0, 200));
      failTask(taskLedgerId, errorMessage);
    }
    console.error('[Voice] Error:', isHardTimeout ? 'voice-hard-timeout' : errorMessage);

    // Codex re-review MEDIUM: if a streaming bubble was open when the hard-cap
    // fired, cancel it immediately so it does not hang as a partial-UI artefact
    // while the (possibly stuck) SDK is still being torn down in the background.
    if (streamingStarted) {
      try { await messageSender.cancelStreaming(ctx); } catch { /* best-effort */ }
    }

    const plainReply = isHardTimeout;
    // Try to update ack message with error
    try {
      await ctx.api.editMessageText(
        chatId,
        ackMsg.message_id,
        `❌ ${errorMessage}`,
        { parse_mode: undefined }
      );
    } catch {
      await ctx.reply(plainReply ? errorMessage : `❌ Voice error: ${esc(errorMessage)}`,
        plainReply ? { parse_mode: undefined } : { parse_mode: 'MarkdownV2' });
    }
  } finally {
    forgetInputLogRowId(chatId, messageId);
    // Clean up temp file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        console.log(`[Voice] Cleaned up ${sanitizePath(tempFilePath)}`);
      } catch (e) {
        console.warn(`[Voice] Cleanup failed for ${sanitizePath(tempFilePath)}:`, sanitizeError(e));
      }
    }
  }
}

/**
 * Transcribe-only flow: voice note sent as reply to "Transcribe Audio" ForceReply.
 * Does NOT send transcript to the Claude agent.
 */
async function handleTranscribeOnly(
  ctx: Context,
  chatId: number,
  sessionKey: string,
  messageId: number,
  voice: { file_id: string; file_size?: number; mime_type?: string },
  inputLogRowId: number | null,
  taskLedgerId: number | null,
): Promise<void> {
  const ackMsg = await ctx.reply('🎤 Transcribing...', { parse_mode: undefined });

  let tempFilePath: string | null = null;

  try {
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) {
      throw new Error('Telegram did not provide a file path.');
    }
    const fileUrl = getTelegramFileUrl(config.TELEGRAM_BOT_TOKEN, file.file_path);

    const ext = voice.mime_type?.includes('ogg') ? '.ogg' : '.oga';
    tempFilePath = path.join(os.tmpdir(), `nexusgram_transcribe_${messageId}${ext}`);

    await downloadFileSecure(fileUrl, tempFilePath);

    const audioBuffer = fs.readFileSync(tempFilePath);
    if (!audioBuffer.length) {
      throw new Error('Downloaded empty voice file.');
    }

    const transcript = await transcribeFile(tempFilePath);

    // Remove ack
    try {
      await ctx.api.deleteMessage(chatId, ackMsg.message_id);
    } catch (e) {
      console.debug('[Transcribe] Failed to delete ack message:', e instanceof Error ? e.message : e);
    }

    await sendTranscriptResult(ctx, transcript);
    // RI-23 (Tier-1): a successful transcribe-only is a HANDLED outcome, not a
    // lost input. Attach the transcript + mark done-without-agent so the
    // catch-all finalizer doesn't tag it 'handler_no_finalize' (would read as
    // "unanswered") and contextAvailability never sees it as 'dropped'.
    attachContent(inputLogRowId, transcript);
    await commitVoiceRecallNonBlocking({
      chatId: String(chatId),
      messageId,
      botId: (config.BOT_NAME || 'Nexusgram').toLowerCase().replace(/\s+/g, '-'),
      transcript,
      privacy: isPrivate(sessionKey) ? 'private' : 'public',
      parentTaskId: taskLedgerId,
      notifyDelayed: (notice) => ctx.reply(notice, { parse_mode: undefined }),
    });
    markHandledNoAgent(inputLogRowId, 'transcribe_only');
    completeTask(taskLedgerId);
  } catch (error) {
    const errorMessage = sanitizeError(error);
    console.error('[Transcribe] Voice ForceReply error:', errorMessage);
    markError(inputLogRowId, errorMessage.slice(0, 200));
    failTask(taskLedgerId, errorMessage);
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `❌ ${errorMessage}`, { parse_mode: undefined });
    } catch {
      await ctx.reply(`❌ Transcription error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        console.warn(`[Transcribe] Cleanup failed for ${sanitizePath(tempFilePath)}:`, sanitizeError(e));
      }
    }
  }
}
