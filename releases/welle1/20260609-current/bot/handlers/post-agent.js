import { config } from '../../config.js';
import { maybeRotateAfterContextPressure } from '../../claude/agent.js';
import { occupancyTokens } from '../../claude/context-pressure.js';
import { sessionManager } from '../../claude/session-manager.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';
import { formatLatencyMarker } from '../../utils/agent-timer.js';
export function fmtTokens(n) {
    if (n >= 1_000_000)
        return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)
        return (n / 1_000).toFixed(1) + 'k';
    return String(n);
}
export function getProgressBar(pct) {
    const clamped = Math.max(0, Math.min(100, pct));
    const filled = Math.round(clamped / 10);
    const empty = 10 - filled;
    const color = clamped >= 80 ? '🔴' : clamped >= 60 ? '🟡' : '🟢';
    return color + ' [' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}
async function sendUsageFooter(ctx, usage) {
    if (!config.CONTEXT_SHOW_USAGE || !usage)
        return;
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
async function applyContextGuard(ctx, sessionKey, usage) {
    try {
        const pressure = maybeRotateAfterContextPressure(sessionKey, usage);
        if (pressure === 'rotated') {
            await ctx.reply('🧹 Kontext war fast voll — ich habe für die nächste Nachricht frisch aufgesetzt. Dein gespeichertes Wissen (Memory/OMI/Daily) bleibt erhalten.', { parse_mode: undefined });
        }
    }
    catch (e) {
        console.log(`[applyContextGuard] non-fatal: ${e.message}`);
    }
}
async function sendCompactionNotification(ctx, compaction) {
    if (!config.CONTEXT_NOTIFY_COMPACTION || !compaction)
        return;
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
    }
    catch (err) {
        console.error('[Compaction] Failed to send notification:', err);
        // Fallback to plain text if MarkdownV2 fails
        try {
            await ctx.reply(`${emoji} Context Compacted\n\n`
                + `${triggerLabel} — previous context was ${fmtTokens(c.preTokens)} tokens.\n`
                + `The agent now has a summarized version of your conversation.`, { parse_mode: undefined });
        }
        catch (fallbackErr) {
            console.error('[Compaction] Fallback notification also failed:', fallbackErr);
        }
    }
}
async function sendSessionInitNotification(ctx, sessionKey, sessionInit) {
    if (!config.CONTEXT_NOTIFY_COMPACTION || !sessionInit)
        return;
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
 * RF-6 Latenz-Transparenz (Wave 1 / Stream 1, 2026-06-03): on SLOW answers
 * (>= LATENCY_MARKER_MIN_MS) send an honest SEPARATE bubble "⏱ ~2 Min" so the
 * user sees that real work happened / how long it took. CRITICAL: a separate
 * bubble — NEVER appended to response.text (that text is fed to TTS and the
 * streaming/MarkdownV2 body). Fast answers (< threshold) show nothing. Instant
 * reversible via LATENCY_MARKER_ENABLED=false (needs a bot RESTART — config is
 * parsed at boot — but no rebuild).
 *
 * SCOPE (Codex P1-2 Option A — narrow T1): this fires only for answers that flow
 * through runPostAgentSuccess (main message/voice/photo/document + command-audio).
 * Reddit-chat, follow-up-button callbacks, PD-commands and auto-dispatch/auto-
 * resume are intentionally NOT covered (auto-dispatch already shows its own "⏳").
 *
 * durationMs honesty (Codex P2-3): it is the turn wall-clock from queue-dequeue
 * (incl. prompt/memory context-build), NOT exact query()-start, and EXCLUDES
 * queue-wait, telegram-send and TTS.
 */
async function sendLatencyMarker(ctx, durationMs) {
    if (!config.LATENCY_MARKER_ENABLED)
        return;
    // Codex P2-2: undefined OR non-finite (e.g. NaN from a misconfigured source)
    // must short-circuit — otherwise `NaN < MIN_MS` is false → marker on every reply.
    if (durationMs === undefined || !Number.isFinite(durationMs))
        return;
    if (durationMs < config.LATENCY_MARKER_MIN_MS)
        return;
    // Separate bubble; pure ASCII digits + emoji → no MarkdownV2 escaping needed.
    await ctx.reply(`⏱ ${formatLatencyMarker(durationMs)}`, { parse_mode: undefined });
}
/** Run one post-agent step in isolation: a failure here must never block the
 *  next step (esp. a footer error must not prevent the Bug-A rotation guard). */
async function safeStep(name, fn) {
    try {
        await fn();
    }
    catch (e) {
        console.log(`[postAgent:${name}] non-fatal: ${e.message}`);
    }
}
/**
 * The single after-reply hook for ALL successful agent paths. Order: usage footer
 * → Bug-A rotation guard → compaction notice → new-session notice. Call AFTER the
 * user-facing reply (and follow-up buttons) so the footer is the trailing bubble.
 */
export async function runPostAgentSuccess(ctx, sessionKey, response) {
    if (!response)
        return;
    // RF-6 latency marker first → clings right under the answer (text path runs
    // before follow-up buttons; voice path runs AFTER them, so in voice it is
    // "after the answer, possibly after follow-up buttons" — Codex P2-4).
    await safeStep('latencyMarker', () => sendLatencyMarker(ctx, response.durationMs));
    await safeStep('usageFooter', () => sendUsageFooter(ctx, response.usage));
    await safeStep('contextGuard', () => applyContextGuard(ctx, sessionKey, response.usage));
    await safeStep('compaction', () => sendCompactionNotification(ctx, response.compaction));
    await safeStep('sessionInit', () => sendSessionInitNotification(ctx, sessionKey, response.sessionInit));
}
//# sourceMappingURL=post-agent.js.map