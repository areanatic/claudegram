/**
 * RI-23 fix — transcribe-prompt freshness registry (Tier-1, Codex Pattern-A).
 *
 * Bug: a voice/audio message that REPLIES to any bot text containing the words
 * "Transcribe Audio" was routed transcribe-only (no agent). A stale /transcribe
 * ForceReply (or any old bot message with that phrase) therefore SWALLOWED real
 * voice questions — the user spoke, got only a transcript back, never an answer.
 *
 * Fix: route transcribe-only ONLY when the reply targets a FRESH, still-pending
 * /transcribe ForceReply — matched by exact prompt message-id, same chat + user,
 * within a TTL, and consumed one-shot. Every other voice/audio goes to the agent
 * and is always answered. This makes the detection precise instead of removing
 * it (removing it would re-break /transcribe — regression from 2026-05-01).
 *
 * In-memory by design: on bot restart the registry is empty, so a reply to a
 * pre-restart prompt degrades to the agent path (answered) — never a hijack.
 *
 * `now` is injectable so the decision logic is unit-testable without timers.
 */
/** TTL for a pending /transcribe prompt. Env-overridable for CI (deterministic
 *  stale-case tests). Default 10 min — generous for "tap reply, then record". */
const TTL_MS = Number(process.env.NEXUSGRAM_TRANSCRIBE_TTL_MS) || 600_000;
const pending = new Map();
function key(chatId, promptMessageId) {
    return `${chatId}:${promptMessageId}`;
}
/** Register the ForceReply prompt sent by /transcribe (Path B, no audio yet). */
export function registerTranscribePrompt(chatId, userId, promptMessageId, now = Date.now()) {
    pending.set(key(chatId, promptMessageId), {
        chatId,
        userId,
        promptMessageId,
        expiresAt: now + TTL_MS,
        consumed: false,
    });
}
/**
 * Is this voice/audio a reply to a FRESH, unconsumed, non-expired /transcribe
 * prompt from the same user? Pure read — does not consume. Expired entries are
 * swept on lookup.
 */
export function isFreshTranscribeReply(chatId, userId, replyToMessageId, now = Date.now()) {
    if (replyToMessageId == null)
        return false;
    const k = key(chatId, replyToMessageId);
    const e = pending.get(k);
    if (!e)
        return false;
    if (e.consumed)
        return false;
    if (e.userId !== userId)
        return false;
    if (now >= e.expiresAt) {
        pending.delete(k);
        return false;
    }
    return true;
}
/**
 * Check + consume one-shot. Returns true exactly once for a fresh prompt reply;
 * subsequent replies to the same prompt return false (→ agent path). Handlers
 * call THIS to decide the transcribe-only route.
 */
export function takeFreshTranscribeReply(chatId, userId, replyToMessageId, now = Date.now()) {
    if (!isFreshTranscribeReply(chatId, userId, replyToMessageId, now))
        return false;
    pending.delete(key(chatId, replyToMessageId));
    return true;
}
/** Test-only: clear the registry between cases. */
export function __resetTranscribePendingForTest() {
    pending.clear();
}
//# sourceMappingURL=transcribe-pending.js.map