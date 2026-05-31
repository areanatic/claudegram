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
  occupancyTokens,
  CONTEXT_ROTATE_WARN,
  CONTEXT_ROTATE_HARD,
  type ContextPressure,
  type OccupancyInput,
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

// ── occupancyTokens: TRUE non-cumulative window occupancy (Bug-A metric, Tier-1) ──
// Root cause of the 523% over-fire: result.modelUsage is CUMULATIVE across a
// query() call, so a 45-message tool-loop summed cacheRead far past the window.
// occupancyTokens() MUST prefer the live per-step windowTokens and only fall back
// to the cumulative counters when no per-step value exists.
// Maps to Codex Pattern-A correction #1/#3 (cross_review_tier1-plan-prereview_2026-05-31.md).
let occPass = 0;
const occCases: Array<[OccupancyInput, number, string]> = [
  // The real 523% session (sanitized from cc609853…jsonl): cumulative sum ~1.48M,
  // but the per-step max occupancy is healthy ~96k. Must use windowTokens.
  [{ windowTokens: 96_000, inputTokens: 900_000, outputTokens: 40_000, cacheReadTokens: 1_480_000, cacheWriteTokens: 60_000 }, 96_000,
    '523% session uses per-step max, not cumulative'],
  // windowTokens missing/0 → fallback sums ALL four (incl. output, incl. cacheWrite)
  [{ windowTokens: 0, inputTokens: 50_000, outputTokens: 5_000, cacheReadTokens: 10_000, cacheWriteTokens: 2_000 }, 67_000,
    'fallback sums input+output+cacheRead+cacheWrite when no per-step value'],
  // windowTokens undefined → same fallback
  [{ inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, 11_000,
    'undefined windowTokens falls back'],
  // garbage windowTokens (negative) → fallback
  [{ windowTokens: -5, inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1_000,
    'negative windowTokens ignored → fallback'],
];
for (const [u, want, msg] of occCases) {
  const got = occupancyTokens(u);
  assert.equal(got, want, `occupancyTokens: ${msg} → got ${got}, want ${want}`);
  occPass++;
}

// End-to-end raw-occupancy guard checks (NOT clamped — Codex correction #4):
// the 523% session at its REAL 48% occupancy must NOT rotate…
const sess523: OccupancyInput = { windowTokens: 96_000, inputTokens: 900_000, outputTokens: 40_000, cacheReadTokens: 1_480_000, cacheWriteTokens: 60_000 };
assert.equal(classifyContextPressure(occupancyTokens(sess523), 200_000), 'none',
  '523% session at 48% real occupancy must NOT rotate');
occPass++;
// …but a genuinely full single turn (per-step) MUST still rotate.
const sessFull: OccupancyInput = { windowTokens: 190_000, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
assert.equal(classifyContextPressure(occupancyTokens(sessFull), 200_000), 'rotated',
  'genuinely full per-step occupancy still rotates');
occPass++;

console.log(`✅ occupancyTokens: ${occPass}/${occCases.length + 2} cases PASS`);
