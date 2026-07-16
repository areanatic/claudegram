import { queueRequest } from '../claude/request-queue.js';
import { sendToAgent, StaleTurnError } from '../claude/agent.js';
import { splitMessage } from '../telegram/markdown.js';
import { parseSessionKey } from '../utils/session-key.js';
import { hasNewerDuplicate, markDone, markDropped, markError, } from './input-log.js';
const PREFACE_SNIPPET_MAX = 120; // allow-hardcoded: reason="UI snippet length for resume preface, not a timeout"
function snippet(rawContent) {
    return rawContent.replace(/\s+/g, ' ').trim().slice(0, PREFACE_SNIPPET_MAX);
}
/** Prepended to a successful replayed answer so the user knows it is a resume. */
export function buildResumePreface(rawContent) {
    return `↩️ Ich mache da weiter, wo wir unterbrochen wurden:\n„${snippet(rawContent)}"\n\n`;
}
/** Shown when a row could not be replayed to completion → ask the user to resend. */
export function buildResendNotice(rawContent) {
    return ('⚠️ Ich konnte deine letzte Nachricht trotz Neustart nicht zu Ende bearbeiten — ' +
        'bitte nochmal senden:\n• ' + snippet(rawContent));
}
/**
 * Send a (possibly long) PLAIN-text reply, chunked to Telegram's limit. Plain
 * text (no parse_mode) avoids MarkdownV2 parse failures on arbitrary agent
 * output — same robustness as the boot re-send notices.
 *
 * Forum-topic awareness (2026-06-04): the resumed answer must land in the
 * ORIGINATING topic, not the General thread. threadId is losslessly encoded in
 * the row's sessionKey (`${chatId}:${threadId}`) → recovered by the caller via
 * parseSessionKey and passed here as `message_thread_id` (only when defined, so
 * non-forum chats stay byte-identical). Mirrors agent.ts:1136-1140.
 */
async function sendChunked(bot, chatId, text, threadId) {
    const sendOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
    for (const chunk of splitMessage(text)) {
        await bot.api.sendMessage(chatId, chunk, sendOpts);
    }
}
async function replayOne(bot, row) {
    // Codex Pattern-B P1-2: if the user already re-sent the IDENTICAL message
    // after the restart, a fresh live turn already owes them that answer — skip
    // the replay to avoid a double-answer. Exact-content + strictly-later match,
    // so a different unanswered input is never suppressed.
    if (hasNewerDuplicate(row.sessionKey, row.rawContent, row.id, row.receivedAt)) {
        console.log(`[AutoResume] row ${row.id} superseded by an identical live re-send — skipping replay`);
        markDropped(row.id, 'auto_resume_deduped_newer');
        return;
    }
    // Forum-topic thread of the originating message (undefined in regular chats).
    const threadId = parseSessionKey(row.sessionKey).threadId;
    try {
        const response = await queueRequest(row.sessionKey, row.rawContent, async (turnEpoch) => sendToAgent(row.sessionKey, row.rawContent, {
            turnEpoch,
            currentInputLogRowId: row.id,
        }));
        const answer = (response?.text ?? '').trim();
        if (!answer) {
            // Agent produced no text (e.g. a turn that only used the withheld
            // push-tools). Notice FIRST, then markError (Codex round-2 P2): a process
            // crash between must leave the row 'processing' (→ re-claimed/retried next
            // boot), never 'error' with the user never told.
            await sendChunked(bot, row.chatId, buildResendNotice(row.rawContent), threadId);
            markError(row.id, 'auto_resume_empty_response');
            return;
        }
        // Reply FIRST, then mark done — a send failure must never look "answered".
        await sendChunked(bot, row.chatId, buildResumePreface(row.rawContent) + answer, threadId);
        markDone(row.id);
    }
    catch (err) {
        if (err instanceof StaleTurnError) {
            // Edge case (Codex Pattern-B P1-2): a newer turn for this session advanced
            // the epoch WHILE this replay was suspended in the queue (not the normal
            // FIFO path — the queue serializes, so normally replay and a live resend
            // run sequentially). When it does happen, the newer turn owns the reply;
            // finalize this one without a re-send notice. The common "user re-sent the
            // same message" case is handled earlier by the hasNewerDuplicate dedup.
            console.log(`[AutoResume] row ${row.id} hit a stale-turn epoch advance — skipping replay`);
            markDropped(row.id, 'auto_resume_superseded');
            return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[AutoResume] replay failed for row ${row.id} (${row.sessionKey}):`, msg);
        // Notice FIRST (best-effort), then markError (Codex round-2 P2): a crash
        // between must leave the row 'processing' (re-claimed next boot), not a
        // silent 'error' the user never heard about.
        try {
            await sendChunked(bot, row.chatId, buildResendNotice(row.rawContent), threadId);
        }
        catch { /* best-effort */ }
        markError(row.id, `auto_resume_error:${msg.slice(0, 80)}`);
    }
}
/**
 * Replay all claimed resumable orphans in received-order. Per-session ordering
 * is preserved by awaiting each replay sequentially; the per-session request
 * queue additionally serializes against any live resend. Best-effort — never
 * throws (each row's failure is contained).
 */
export async function runAutoResume(bot, result) {
    if (!result.resumable.length)
        return;
    console.log(`[AutoResume] replaying ${result.resumable.length} orphaned input(s) after restart`);
    for (const row of result.resumable) {
        await replayOne(bot, row);
    }
}
//# sourceMappingURL=auto-resume.js.map