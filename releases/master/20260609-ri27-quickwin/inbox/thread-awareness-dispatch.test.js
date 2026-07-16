/**
 * Forum-topic thread-awareness — REAL delivery-path proof (2026-06-04).
 *
 * Run: npx tsx --experimental-test-module-mocks src/inbox/thread-awareness-dispatch.test.ts
 *
 * Sibling of thread-awareness.test.ts (which pins the pure parseSessionKey →
 * threadOpts derivation). THIS test drives the actual PRODUCTION function
 * `tryAutoDispatch()` (src/inbox/input-auto-dispatch.ts) end-to-end and INSPECTS
 * the real `api.sendMessage` call args it emits, proving the FUNCTIONAL fix:
 *
 *   - a re-dispatched delivery for a forum sessionKey ("chatId:threadId")
 *     passes { message_thread_id: <threadId> } on EVERY fresh send
 *     (chunk[0] fallback AND every follow-up chunk), so the recovered answer
 *     lands in the originating forum topic;
 *   - a plain chat ("chatId") passes NO thread (opts === {}), byte-identical
 *     to the pre-fix behavior → zero regression.
 *
 * Method (mirrors the repo's env-before-dynamic-import + temp-DB + node:assert
 * convention; the api is captured, never hitting Telegram):
 *   - env is set BEFORE the dynamic import because input-auto-dispatch.ts →
 *     config.ts hard-fails on missing env (and we enable INPUT_AUTODISPATCH).
 *   - the deep agent path (sendToAgent / queueRequest / sessionManager) is
 *     mocked with node:test mock.module so the function runs its REAL branching
 *     (parseSessionKey → sendOpts → chunk loop) against a DETERMINISTIC answer,
 *     with no Claude / no network. queueRequest just runs the handler.
 *   - a real temp input-log DB row is seeded so getRowExecutionState /
 *     incrementResumeAttempt / markDoneRecovered operate on actual SQLite.
 *   - the api stub records every (chatId, text, opts) it is asked to send.
 *
 * The full restart/voice-timeout ORCHESTRATION is covered by the boot-restart
 * and voice auto-dispatch E2E; this isolates the thread-routing of the live
 * P0 auto-dispatch send sites deterministically.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-threaddispatch-test-'));
process.env.NEXUSGRAM_ENV_PATH = path.join(TMP, 'nonexistent.env');
process.env.CLAUDEGRAM_ENV_PATH = process.env.NEXUSGRAM_ENV_PATH;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'TestBot';
process.env.NEXUS_MEMORY_SCOPE = 'public';
process.env.DATA_DIR = TMP;
// Enable the live auto-dispatch path under test (default OFF in prod).
process.env.INPUT_AUTODISPATCH_ENABLED = 'true';
process.env.INPUT_AUTODISPATCH_MAX_ATTEMPTS = '3';
let pass = 0;
function check(cond, msg) {
    assert.equal(cond, true, msg);
    pass++;
}
// A deterministic agent answer LONGER than Telegram's 4096-char limit so
// splitMessage yields >=2 chunks → exercises BOTH the chunk[0] fresh send
// (input-auto-dispatch.ts:194) AND a follow-up chunk send (:201). No preface
// is added (the seeded content is short → not "long voice"), so the answer is
// delivered verbatim and the chunk count is predictable.
const AGENT_ANSWER = 'X'.repeat(5000);
// ── Mock the deep agent dependencies (no Claude, no network) ────────────────
// queueRequest must actually RUN the handler so the real sendOpts-derivation +
// chunk loop in tryAutoDispatch execute. sendToAgent returns the canned answer.
mock.module('../claude/agent.js', {
    namedExports: {
        sendToAgent: async () => ({ text: AGENT_ANSWER, toolsUsed: [] }),
        forgetChatSession: () => { },
        // StaleTurnError is imported by auto-resume.ts (transitively unused here)
        // but keep a shape-compatible export so the module graph resolves.
        StaleTurnError: class StaleTurnError extends Error {
        },
    },
});
mock.module('../claude/request-queue.js', {
    namedExports: {
        queueRequest: async (_sessionKey, _message, handler) => handler(1),
    },
});
mock.module('../claude/session-manager.js', {
    namedExports: {
        sessionManager: { forceFreshSession: () => undefined },
    },
});
function makeApiStub() {
    const sent = [];
    const api = {
        sendMessage: async (chatId, text, opts = {}) => {
            sent.push({ chatId, text, opts });
            return { message_id: sent.length };
        },
        editMessageText: async () => { throw new Error('no status message — force the sendMessage fallback'); },
    };
    return { api, sent };
}
(async () => {
    const { recordInput, attachContent } = await import('./input-log.js');
    const { tryAutoDispatch } = await import('./input-auto-dispatch.js');
    // ── Case 1: FORUM topic — sessionKey "chatId:threadId" → message_thread_id ──
    {
        const chatId = -100123;
        const threadId = 42;
        const sessionKey = `${chatId}:${threadId}`;
        const rowId = recordInput({
            messageId: 1001,
            chatId,
            sessionKey,
            inputType: 'voice',
            rawContent: 'kurzer Sprachauftrag',
        });
        check(rowId != null, 'forum: input row seeded in temp DB');
        attachContent(rowId, 'kurzer Sprachauftrag');
        const { api, sent } = makeApiStub();
        const outcome = await tryAutoDispatch({
            api: api,
            chatId,
            sessionKey,
            rowId,
            rawContent: 'kurzer Sprachauftrag',
            inputType: 'voice',
            reason: 'voice_hard_timeout',
            // No statusMessageId → editMessageText is NOT used; every delivery is a
            // fresh api.sendMessage, which is exactly the threaded send site.
        });
        check(outcome === 'answered', 'forum: tryAutoDispatch delivered the recovered answer');
        check(sent.length >= 2, `forum: long answer chunked into >=2 sends (got ${sent.length})`);
        check(sent.every((c) => c.chatId === chatId), 'forum: every send targets the originating chat');
        // THE FIX: every fresh send carries the recovered thread id.
        check(sent.every((c) => c.opts.message_thread_id === threadId), 'forum: EVERY api.sendMessage carries message_thread_id (lands in originating topic)');
        // chunk[0] (the COMMIT point) specifically threaded.
        check(sent[0].opts.message_thread_id === threadId, 'forum: chunk[0] (commit) is threaded');
        // a follow-up chunk specifically threaded.
        check(sent[1].opts.message_thread_id === threadId, 'forum: follow-up chunk is threaded');
    }
    // ── Case 2: PLAIN chat — sessionKey is the bare chatId → NO thread ──────────
    {
        const chatId = 555;
        const sessionKey = `${chatId}`;
        const rowId = recordInput({
            messageId: 2002,
            chatId,
            sessionKey,
            inputType: 'voice',
            rawContent: 'plain chat auftrag',
        });
        check(rowId != null, 'plain: input row seeded in temp DB');
        attachContent(rowId, 'plain chat auftrag');
        const { api, sent } = makeApiStub();
        const outcome = await tryAutoDispatch({
            api: api,
            chatId,
            sessionKey,
            rowId,
            rawContent: 'plain chat auftrag',
            inputType: 'voice',
            reason: 'voice_hard_timeout',
        });
        check(outcome === 'answered', 'plain: tryAutoDispatch delivered the recovered answer');
        check(sent.length >= 2, `plain: long answer chunked into >=2 sends (got ${sent.length})`);
        check(sent.every((c) => c.chatId === chatId), 'plain: every send targets the chat');
        // THE NON-REGRESSION: no thread is ever attached for a plain chat.
        check(sent.every((c) => c.opts.message_thread_id === undefined), 'plain: NO api.sendMessage carries message_thread_id (zero regression)');
        check(sent.every((c) => Object.keys(c.opts).length === 0), 'plain: send opts are byte-identical to old behavior ({})');
    }
    console.log(`\n✅ thread-awareness REAL-dispatch: ${pass}/${pass} assertions PASS`);
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    }
    catch { /* ignore */ }
})().catch((err) => {
    console.error('\n❌ thread-awareness-dispatch.test.ts FAILED:', err);
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    }
    catch { /* ignore */ }
    process.exit(1);
});
//# sourceMappingURL=thread-awareness-dispatch.test.js.map