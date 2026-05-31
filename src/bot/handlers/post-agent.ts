/**
 * Shared post-agent-success hook (Tier-1, Codex Pattern-A 2026-05-31).
 *
 * Every successful agent reply — text, voice, photo, document, command-audio —
 * must run the SAME after-reply work: the context-usage footer, the Bug-A
 * rotation guard, and the compaction / new-session notifications. Before Tier-1
 * these lived only in message.handler, so the Bug-A guard never fired on
 * voice/photo/document/command replies (it could fill the window and hit the
 * wall). This module is the single home for that work.
 *
 * STATIC GATE: nothing outside this module may call sendUsageFooter /
 * applyContextGuard directly — handlers call runPostAgentSuccess() instead.
 *
 * Each step is wrapped in its own try/catch (safeStep) so a failing footer can
 * never prevent the rotation guard from running, and a notification error can
 * never bubble into the reply path.
 */
import { Context } from 'grammy';
import { config } from '../../config.js';
import { type AgentUsage, maybeRotateAfterContextPressure } from '../../claude/agent.js';
import { occupancyTokens } from '../../claude/context-pressure.js';
import { sessionManager } from '../../claude/session-manager.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';

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
  // Single-source occupancy (Bug-A metric) — same value the rotation guard fires
  // on, so the % the user sees == what triggers rotation. Clamp display to 100%.
  const used = occupancyTokens(u);
  const pct = u.contextWindow > 0
    ? Math.min(100, Math.round((used / u.contextWindow) * 100))
    : 0;
  const bar = getProgressBar(pct);
  const footer = `${bar} ${pct}% context · ${fmtTokens(used)}/${fmtTokens(u.contextWindow)} · $${u.totalCostUsd.toFixed(4)} · ${u.numTurns} turns`;
  await ctx.reply(footer, { parse_mode: undefined });
}

/**
 * Bug-A guard: after the usage footer, rotate to a fresh Claude session for the
 * NEXT turn if the context window is filling up (>= 90%). Informs the operator
 * once, transparently. Must never throw into the reply path.
 */
async function applyContextGuard(
  ctx: Context,
  sessionKey: string,
  usage: AgentUsage | undefined,
): Promise<void> {
  try {
    const pressure = maybeRotateAfterContextPressure(sessionKey, usage);
    if (pressure === 'rotated') {
      await ctx.reply(
        '🧹 Kontext war fast voll — ich habe für die nächste Nachricht frisch aufgesetzt. Dein gespeichertes Wissen (Memory/OMI/Daily) bleibt erhalten.',
        { parse_mode: undefined },
      );
    }
  } catch (e) {
    console.log(`[applyContextGuard] non-fatal: ${(e as Error).message}`);
  }
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

/** Minimal shape of an agent reply needed for the post-agent work. AgentResponse
 *  (agent.ts) is structurally assignable. */
export interface PostAgentResult {
  usage?: AgentUsage;
  compaction?: { trigger: 'manual' | 'auto'; preTokens: number };
  sessionInit?: { model: string; sessionId: string };
}

/** Run one post-agent step in isolation: a failure here must never block the
 *  next step (esp. a footer error must not prevent the Bug-A rotation guard). */
async function safeStep(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.log(`[postAgent:${name}] non-fatal: ${(e as Error).message}`);
  }
}

/**
 * The single after-reply hook for ALL successful agent paths. Order: usage footer
 * → Bug-A rotation guard → compaction notice → new-session notice. Call AFTER the
 * user-facing reply (and follow-up buttons) so the footer is the trailing bubble.
 */
export async function runPostAgentSuccess(
  ctx: Context,
  sessionKey: string,
  response: PostAgentResult | undefined,
): Promise<void> {
  if (!response) return;
  await safeStep('usageFooter', () => sendUsageFooter(ctx, response.usage));
  await safeStep('contextGuard', () => applyContextGuard(ctx, sessionKey, response.usage));
  await safeStep('compaction', () => sendCompactionNotification(ctx, response.compaction));
  await safeStep('sessionInit', () => sendSessionInitNotification(ctx, sessionKey, response.sessionInit));
}
