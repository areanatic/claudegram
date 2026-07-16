/**
 * RI-23 regression: transcribe-prompt freshness registry.
 * Run: npx tsx src/bot/handlers/transcribe-pending.test.ts
 *
 * Proves the precise-detection fix: only a FRESH, same-user, non-expired,
 * unconsumed reply to a registered /transcribe prompt routes transcribe-only;
 * everything else (stale phrase, wrong user, expired, second reply) goes to the
 * agent and is answered. Maps to Codex Pattern-A correction #5 / RI-23.
 */
import assert from 'node:assert/strict';
import { registerTranscribePrompt, isFreshTranscribeReply, takeFreshTranscribeReply, __resetTranscribePendingForTest, } from './transcribe-pending.js';
const CHAT = 100;
const USER = 7;
const PROMPT = 555;
const T0 = 1_000_000;
const TTL = 600_000; // module default
let pass = 0;
function check(cond, msg) {
    assert.equal(cond, true, msg);
    pass++;
}
// 1. POSITIVE: fresh reply to the registered prompt → transcribe-only
__resetTranscribePendingForTest();
registerTranscribePrompt(CHAT, USER, PROMPT, T0);
check(isFreshTranscribeReply(CHAT, USER, PROMPT, T0 + 5_000), 'fresh reply is recognized');
// 2. ONE-SHOT: take consumes; a second take returns false (→ agent path)
check(takeFreshTranscribeReply(CHAT, USER, PROMPT, T0 + 5_000) === true, 'first take = transcribe-only');
check(takeFreshTranscribeReply(CHAT, USER, PROMPT, T0 + 6_000) === false, 'second take = agent path (one-shot)');
// 3. STALE: reply after TTL → NOT transcribe-only (the RI-23 hijack case)
__resetTranscribePendingForTest();
registerTranscribePrompt(CHAT, USER, PROMPT, T0);
check(isFreshTranscribeReply(CHAT, USER, PROMPT, T0 + TTL + 1) === false, 'expired prompt → agent path');
// 4. WRONG MESSAGE: reply to some OTHER bot message (not the prompt) → agent path
__resetTranscribePendingForTest();
registerTranscribePrompt(CHAT, USER, PROMPT, T0);
check(isFreshTranscribeReply(CHAT, USER, 999, T0 + 1_000) === false, 'reply to a different message → agent path');
// 5. WRONG USER: another user's reply in a group → agent path
__resetTranscribePendingForTest();
registerTranscribePrompt(CHAT, USER, PROMPT, T0);
check(isFreshTranscribeReply(CHAT, USER + 1, PROMPT, T0 + 1_000) === false, 'different user → agent path');
// 6. NO REPLY: a plain voice message (no reply_to) → agent path
check(isFreshTranscribeReply(CHAT, USER, null, T0 + 1_000) === false, 'no reply_to → agent path');
check(isFreshTranscribeReply(CHAT, USER, undefined, T0 + 1_000) === false, 'undefined reply_to → agent path');
console.log(`✅ transcribe-pending: ${pass}/8 cases PASS`);
//# sourceMappingURL=transcribe-pending.test.js.map