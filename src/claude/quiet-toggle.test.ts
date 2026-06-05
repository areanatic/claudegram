/**
 * REGRESSION — per-chat quiet mode (suppresses the "🐌 brauche länger" heartbeat).
 *
 * Run: npx tsx src/claude/quiet-toggle.test.ts
 *
 * User feedback 2026-06-05 (Screenshot): the long-running status fired "fast immer" and felt
 * like noise / a half-truth while merely waiting for an MCP permission. /quiet lets a user
 * mute it PER CHAT. This test verifies the pure state machine (set/is/toggle, per-session
 * isolation) — the message.handler onLongRunning early-returns when isQuiet(sessionKey).
 */
import assert from 'node:assert/strict';

// config validation runs at import; supply the minimum.
process.env.TELEGRAM_BOT_TOKEN ||= '0:test';
process.env.ALLOWED_USER_IDS ||= '7067348774';
process.env.BOT_NAME ||= 'NexusgramTest';
process.env.NEXUS_MEMORY_SCOPE ||= 'public';

const { setQuiet, isQuiet } = await import('./agent.js');

let pass = 0, fail = 0;
function check(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.error(`  ❌ ${msg}`); }
}

const A = 'chatA', B = 'chatB';

// default OFF (updates ON) — no /quiet ever issued
check(isQuiet(A) === false, 'default: a fresh chat is NOT quiet (status updates ON)');

// enable
setQuiet(A, true);
check(isQuiet(A) === true, 'after setQuiet(A,true): A is quiet');
check(isQuiet(B) === false, 'per-chat isolation: B unaffected by A');

// toggle semantics (what /quiet with no arg does)
setQuiet(A, !isQuiet(A));
check(isQuiet(A) === false, 'toggle: A back to not-quiet');
setQuiet(A, !isQuiet(A));
check(isQuiet(A) === true, 'toggle again: A quiet');

// explicit off
setQuiet(A, false);
check(isQuiet(A) === false, 'setQuiet(A,false): A not quiet');

// idempotency
setQuiet(B, true); setQuiet(B, true);
check(isQuiet(B) === true, 'idempotent enable');
setQuiet(B, false); setQuiet(B, false);
check(isQuiet(B) === false, 'idempotent disable');

console.log(`\n${fail === 0 ? '✅' : '❌'} quiet-toggle: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
