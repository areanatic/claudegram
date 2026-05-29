/**
 * Test-first regression for Bug-A context-pressure rotation.
 * Run: npx tsx src/claude/context-pressure.test.ts
 *
 * Maps to audit scenarios T-A1/T-A2 (audit_nexusgram_bug_audit_2026-05-27-28.md):
 * the bot must decide to rotate BEFORE the context window wall, not after the
 * "Prompt is too long" reject. The real death-spiral session sat at ~196.8k/200k
 * (~0.98) — well above the 0.90 hard threshold.
 */
import assert from 'node:assert/strict';
import {
  classifyContextPressure,
  CONTEXT_ROTATE_WARN,
  CONTEXT_ROTATE_HARD,
  type ContextPressure,
} from './context-pressure.js';

const W = 200_000;
const cases: Array<[number, number, ContextPressure]> = [
  [Math.floor(0.5 * W), W, 'none'],     // mid-session, fine
  [Math.floor(0.79 * W), W, 'none'],    // just below warn
  [Math.floor(0.8 * W), W, 'warned'],   // exactly at warn
  [Math.floor(0.89 * W), W, 'warned'],  // below hard
  [Math.floor(0.9 * W), W, 'rotated'],  // exactly at hard
  [Math.floor(0.98 * W), W, 'rotated'], // the real death-spiral
  [W, W, 'rotated'],                    // full
  [W * 2, W, 'rotated'],                // over (shouldn't happen, but safe)
  [50_000, 0, 'none'],                  // no contextWindow -> never crash/rotate
  [-1, W, 'none'],                      // garbage usage -> safe
  [NaN, W, 'none'],                     // garbage usage -> safe
];

let pass = 0;
for (const [used, win, want] of cases) {
  const got = classifyContextPressure(used, win);
  assert.equal(got, want, `classifyContextPressure(${used}, ${win}) = ${got}, want ${want}`);
  pass++;
}

assert.equal(CONTEXT_ROTATE_WARN, 0.8, 'warn threshold drifted');
assert.equal(CONTEXT_ROTATE_HARD, 0.9, 'hard threshold drifted');

console.log(`✅ context-pressure: ${pass}/${cases.length} cases PASS`);
