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
import { classifyContextPressure, occupancyTokens, effectiveWindowTokens, exceedsBootWindow, isContextOverflowSentinel, shouldRetryAfterOverflow, DEFAULT_CONTEXT_WINDOW, LARGE_CONTEXT_WINDOW, CONTEXT_ROTATE_WARN, CONTEXT_ROTATE_HARD, } from './context-pressure.js';
const W = 200_000;
const cases = [
    [Math.floor(0.5 * W), W, 'none'], // mid-session, fine
    [Math.floor(0.79 * W), W, 'none'], // just below warn
    [Math.floor(0.8 * W), W, 'warned'], // exactly at warn
    [Math.floor(0.89 * W), W, 'warned'], // below hard
    [Math.floor(0.9 * W), W, 'rotated'], // exactly at hard
    [Math.floor(0.98 * W), W, 'rotated'], // the real death-spiral
    [W, W, 'rotated'], // full
    [W * 2, W, 'rotated'], // over (shouldn't happen, but safe)
    [50_000, 0, 'none'], // no contextWindow -> never crash/rotate
    [-1, W, 'none'], // garbage usage -> safe
    [NaN, W, 'none'], // garbage usage -> safe
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
const occCases = [
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
const sess523 = { windowTokens: 96_000, inputTokens: 900_000, outputTokens: 40_000, cacheReadTokens: 1_480_000, cacheWriteTokens: 60_000 };
assert.equal(classifyContextPressure(occupancyTokens(sess523), 200_000), 'none', '523% session at 48% real occupancy must NOT rotate');
occPass++;
// …but a genuinely full single turn (per-step) MUST still rotate.
const sessFull = { windowTokens: 190_000, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
assert.equal(classifyContextPressure(occupancyTokens(sessFull), 200_000), 'rotated', 'genuinely full per-step occupancy still rotates');
occPass++;
console.log(`✅ occupancyTokens: ${occPass}/${occCases.length + 2} cases PASS`);
// ── effectiveWindowTokens: boot-airbag model→window map (INV-01, Codex #5) ──
// opus-4-7/opus-4-8 must NOT be mapped to 200k (would false-rotate a healthy
// large-window session); sonnet/haiku/opus-4-6/'opus'/unknown stay 200k so the
// Bug-A 196.8k/200k death-spiral still rotates at boot.
let winPass = 0;
const winCases = [
    ['sonnet', DEFAULT_CONTEXT_WINDOW, 'sonnet → 200k'],
    ['claude-haiku-4-5', DEFAULT_CONTEXT_WINDOW, 'haiku → 200k'],
    ['opus', DEFAULT_CONTEXT_WINDOW, "SDK 'opus' alias (=opus-4-6) → 200k"],
    ['claude-opus-4-6', DEFAULT_CONTEXT_WINDOW, 'opus-4-6 → 200k'],
    ['claude-opus-4-7', LARGE_CONTEXT_WINDOW, 'opus-4-7 → 1M (Codex #5: not blind-200k)'],
    ['claude-opus-4-8', LARGE_CONTEXT_WINDOW, 'opus-4-8 → 1M'],
    ['some-sonnet-1m', LARGE_CONTEXT_WINDOW, '1m variant → 1M'],
    ['', DEFAULT_CONTEXT_WINDOW, 'empty → 200k default'],
    [undefined, DEFAULT_CONTEXT_WINDOW, 'undefined → 200k default'],
    [null, DEFAULT_CONTEXT_WINDOW, 'null → 200k default'],
];
for (const [model, want, msg] of winCases) {
    assert.equal(effectiveWindowTokens(model), want, `effectiveWindowTokens: ${msg}`);
    winPass++;
}
console.log(`✅ effectiveWindowTokens: ${winPass}/${winCases.length} cases PASS`);
// ── exceedsBootWindow: boot-airbag size threshold, window-scaled (INV-01) ──
// 7MB baseline at 200k; scales to 35MB at 1M so a healthy large-window session
// is NOT false-rotated while the Bug-A 9.5MB/200k death-spiral still rotates.
const MB = 1024 * 1024; // allow-hardcoded: reason="MB unit for test byte-size fixtures"
let bwPass = 0;
const bwCases = [
    [7 * MB + 1, 'sonnet', true, '7MB+1 @200k → rotate'],
    [7 * MB - 1, 'sonnet', false, 'just under 7MB @200k → keep'],
    [Math.round(9.5 * MB), 'sonnet', true, 'Bug-A 9.5MB @200k → rotate'],
    [9.5 * MB | 0, 'claude-opus-4-8', false, '9.5MB @1M → keep (no false-rotate)'],
    [36 * MB, 'claude-opus-4-8', true, '36MB @1M → rotate'],
    [34 * MB, 'claude-opus-4-8', false, '34MB @1M → keep'],
    [100 * MB, undefined, true, 'huge @unknown(200k) → rotate'],
    [0, 'sonnet', false, '0 bytes → never'],
    [-5, 'sonnet', false, 'negative → never'],
    [NaN, 'sonnet', false, 'NaN → never'],
];
for (const [size, model, want, msg] of bwCases) {
    assert.equal(exceedsBootWindow(size, model), want, `exceedsBootWindow: ${msg}`);
    bwPass++;
}
console.log(`✅ exceedsBootWindow: ${bwPass}/${bwCases.length} cases PASS`);
// ── isContextOverflowSentinel: SDK surfaces a context overflow as a SUCCESS
// result whose TEXT is "Prompt is too long" (2026-06-02 stuck-loop root-cause).
// Must catch the real sentinel (incl. case/whitespace) but NOT misfire on real
// answers that merely quote the phrase. ──
let sentPass = 0;
const sentCases = [
    ['Prompt is too long', true, 'exact SDK sentinel'],
    ['prompt is too long', true, 'lowercase'],
    ['  Prompt is too long  ', true, 'whitespace-padded'],
    ['PROMPT IS TOO LONG', true, 'uppercase'],
    ['Input is too long', true, 'input variant'],
    ['', false, 'empty string'],
    [undefined, false, 'undefined'],
    [null, false, 'null'],
    ['pong', false, 'normal short answer'],
    ['Your prompt is too long.', false, 'Codex P2-3: SHORT real answer containing phrase → must NOT misfire'],
    ['Die Eingabe (prompt is too long) war grenzwertig.', false, 'short phrase-containing answer → must NOT misfire'],
    [
        'Guter Punkt: dein Prompt is too long, wenn du zu viele Keyframes auf einmal anfragst — schick lieber 2-3 pro Nachricht, dann passt es.',
        false,
        'long real answer quoting the phrase → must NOT misfire',
    ],
];
for (const [input, want, msg] of sentCases) {
    assert.equal(isContextOverflowSentinel(input), want, `isContextOverflowSentinel: ${msg}`);
    sentPass++;
}
console.log(`✅ isContextOverflowSentinel: ${sentPass}/${sentCases.length} cases PASS`);
// ── shouldRetryAfterOverflow: auto-replay only on a clean, side-effect-free
// failed turn (Codex P1-2). The real SDK sentinel has no text + no tools. ──
let retPass = 0;
const retCases = [
    [{ isOverflowRetry: false, toolsUsedCount: 0, hasText: false }, true, 'clean sentinel, first attempt → retry'],
    [{ isOverflowRetry: true, toolsUsedCount: 0, hasText: false }, false, 'already a retry → no recursion'],
    [{ isOverflowRetry: false, toolsUsedCount: 2, hasText: false }, false, 'tools ran → no replay (would duplicate side effects)'],
    [{ isOverflowRetry: false, toolsUsedCount: 0, hasText: true }, false, 'text streamed → no replay'],
    [{ isOverflowRetry: false, toolsUsedCount: 3, hasText: true }, false, 'tools + text → no replay'],
];
for (const [opts, want, msg] of retCases) {
    assert.equal(shouldRetryAfterOverflow(opts), want, `shouldRetryAfterOverflow: ${msg}`);
    retPass++;
}
console.log(`✅ shouldRetryAfterOverflow: ${retPass}/${retCases.length} cases PASS`);
//# sourceMappingURL=context-pressure.test.js.map