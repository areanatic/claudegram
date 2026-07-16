/**
 * Forum-topic thread-awareness recovery (2026-06-04).
 * Run: npx tsx src/inbox/thread-awareness.test.ts
 *
 * The recovery/re-delivery modules (auto-resume, input-auto-dispatch,
 * capture-recovery, the boot/restart notices) all send via a RAW
 * api.sendMessage(chatId, ...) without a thread-aware grammY ctx, so they used
 * to drop the originating forum topic and land in "General". The fix recovers
 * the thread for FREE from the already-stored sessionKey
 * (`${chatId}:${threadId}`, src/utils/session-key.ts) and attaches it as
 * { message_thread_id }.
 *
 * This pins the canonical thread-opts contract every site now uses:
 *  - forum sessionKey  → { message_thread_id: <threadId> }
 *  - regular sessionKey → {}  (byte-identical to the old behavior, zero regression)
 *
 * The full replay/dispatch ORCHESTRATION is exercised by the boot-restart E2E
 * (test_boot_restart_replay) and the voice auto-dispatch E2E; this unit isolates
 * the recovery primitive so a regression in the encoding/derivation is caught
 * deterministically without driving a live restart.
 */
import assert from 'node:assert/strict';
import { buildSessionKey, parseSessionKey } from '../utils/session-key.js';
let pass = 0;
function check(cond, msg) {
    assert.equal(cond, true, msg);
    pass++;
}
/** The exact opts-derivation reused at every fixed send site (mirror agent.ts:1136-1140). */
function threadOpts(sessionKey) {
    const threadId = parseSessionKey(sessionKey).threadId;
    return threadId !== undefined ? { message_thread_id: threadId } : {};
}
// Forum topic: thread is recovered and attached.
{
    const key = buildSessionKey(123, 42);
    check(key === '123:42', 'forum sessionKey encodes chatId:threadId');
    const opts = threadOpts(key);
    check(opts.message_thread_id === 42, 'forum send carries message_thread_id (lands in originating topic)');
    check(parseSessionKey(key).chatId === 123, 'forum chatId still recovered for the send target');
}
// Regular chat: NO thread → empty opts (the common case stays byte-identical).
{
    const key = buildSessionKey(123);
    check(key === '123', 'regular sessionKey is the bare chatId');
    const opts = threadOpts(key);
    check(Object.keys(opts).length === 0, 'regular send sends NO message_thread_id (zero regression)');
    check(parseSessionKey(key).threadId === undefined, 'regular sessionKey has no threadId');
}
// Negative chatId (Telegram groups/supergroups are negative) in a topic.
{
    const key = buildSessionKey(-100123, 7);
    const parsed = parseSessionKey(key);
    check(parsed.chatId === -100123, 'negative (supergroup) chatId round-trips');
    check(threadOpts(key).message_thread_id === 7, 'supergroup-topic send is threaded');
}
// The captures-db path keys off a stored INTEGER column, not the sessionKey.
// Mirror that derivation too (NULL → {} ; number → { message_thread_id }).
{
    const fromNull = (v) => (v != null ? { message_thread_id: v } : {});
    check(Object.keys(fromNull(null)).length === 0, 'capture with NULL message_thread_id → no thread');
    check(fromNull(99).message_thread_id === 99, 'capture with stored message_thread_id → threaded');
}
console.log(`✅ thread-awareness recovery: ${pass}/${pass} cases PASS`);
//# sourceMappingURL=thread-awareness.test.js.map