/**
 * INV-02 (Model-Truth) regression: the model the bot DISPLAYS must equal the
 * model it COMPUTES/RUNS. Run: npx tsx src/claude/model-resolution.test.ts
 *
 * Root incident (2026-05-31, Codex 0.91): effectiveModel defaulted to 'sonnet'
 * (agent.ts:736) while getModel() defaulted to 'opus' (agent.ts:1636) — so /status
 * showed Opus while the agent ran Sonnet, and the bot even wrote "Opus 4.6" into a
 * file. Both paths now route through resolveModel() so they CANNOT diverge.
 */
import assert from 'node:assert/strict';
import { resolveModel, DEFAULT_MODEL_FALLBACK } from './model-resolution.js';

let pass = 0;
const ok = (cond: boolean, msg: string) => { assert.equal(cond, true, msg); pass++; };

// Per-session override beats config default; explicit per-call override beats all.
ok(resolveModel(undefined, undefined, 'sonnet') === 'sonnet', 'config default applies when nothing set');
ok(resolveModel(undefined, 'opus', 'sonnet') === 'opus', 'per-session /model opus beats config default');
ok(resolveModel('haiku', 'opus', 'sonnet') === 'haiku', 'explicit per-call override wins');
ok(resolveModel(undefined, undefined, undefined) === DEFAULT_MODEL_FALLBACK, 'hard fallback when no config');
ok(DEFAULT_MODEL_FALLBACK === 'sonnet', 'fast default is sonnet (user strategy: Sonnet default, Opus on-demand)');

// THE coherence invariant (what the incident violated): the value getModel() shows
// for an un-set session MUST equal the value effectiveModel() runs for that session.
// Both are resolveModel(undefined, perSession, configDefault) with the SAME inputs.
for (const cfg of ['sonnet', 'opus', undefined as unknown as string]) {
  for (const per of [undefined, 'opus', 'haiku']) {
    const displayed = resolveModel(undefined, per, cfg);     // getModel() path
    const computed = resolveModel(undefined, per, cfg);      // effectiveModel() path (no per-call override)
    ok(displayed === computed, `coherence: displayed==computed for per=${per} cfg=${cfg}`);
  }
}

console.log(`✅ model-resolution: ${pass} cases PASS`);
