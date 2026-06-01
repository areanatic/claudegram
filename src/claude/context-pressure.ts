/**
 * Context-pressure classification for Bug-A (death-spiral) prevention.
 *
 * Background: the Master bot ran with DISABLE_AUTO_COMPACT=1, so the Claude-Code
 * session JSONL grew unbounded until it hit the ~200k window and every turn
 * returned "Prompt is too long" (forensik: audit_nexusgram_bug_audit_2026-05-27-28.md).
 * The 20 MB isOversized airbag fired far too late (a 9.5 MB JSONL was already at
 * ~196.8k tokens). This module lets us rotate to a fresh session AFTER a
 * successful turn — before the next turn slams into the wall.
 *
 * Kept dependency-free on purpose so the decision logic is trivially unit-testable
 * without loading the agent/SDK (see context-pressure.test.ts).
 */
export const CONTEXT_ROTATE_WARN = 0.8;
export const CONTEXT_ROTATE_HARD = 0.9;

export type ContextPressure = 'none' | 'warned' | 'rotated';

/**
 * Minimal token shape needed to compute window occupancy. Kept local (not
 * AgentUsage from agent.ts) so this module stays dependency-free + unit-testable.
 * AgentUsage is structurally assignable to this.
 */
export interface OccupancyInput {
  /** TRUE per-step max window occupancy captured live from assistant messages
   *  (input + cache_read + cache_creation + output). NON-cumulative. Preferred. */
  windowTokens?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Single source of truth for "how full is the context window right now" — used by
 * the rotation guard, the usage footer AND /status, so all three agree.
 *
 * PREFERRED: windowTokens — the max per-assistant-step occupancy observed this
 * turn, captured live from the SDK assistant messages. This is NON-cumulative and
 * mirrors the SDK UI's context bar.
 *
 * FALLBACK (windowTokens missing/0/garbage, e.g. a stale cache entry): the
 * result-level counters summed. These are CUMULATIVE per query() call and will
 * OVER-estimate on long tool-loops — used only when no per-step value exists.
 *
 * Bug-A history: the old guard fed CUMULATIVE result counters straight into the
 * ratio, so a 45-message tool-loop reported 523% and HARD-rotated healthy
 * sessions. Fix verified in cross_review_tier1-plan-prereview_2026-05-31.md.
 */
export function occupancyTokens(u: OccupancyInput): number {
  if (typeof u.windowTokens === 'number' && Number.isFinite(u.windowTokens) && u.windowTokens > 0) {
    return u.windowTokens;
  }
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

/**
 * Classify how full the context window is.
 * @param usedTokens     TRUE current-window occupancy — ALWAYS from occupancyTokens(),
 *                       never the raw cumulative result counters (they over-fire).
 * @param contextWindow  the model's context window for this turn
 * @returns 'rotated' (>= 90%), 'warned' (>= 80%), or 'none'
 */
export function classifyContextPressure(usedTokens: number, contextWindow: number): ContextPressure {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 'none';
  if (!Number.isFinite(usedTokens) || usedTokens < 0) return 'none';
  const ratio = usedTokens / contextWindow;
  if (ratio >= CONTEXT_ROTATE_HARD) return 'rotated';
  if (ratio >= CONTEXT_ROTATE_WARN) return 'warned';
  return 'none';
}

/** Default context window — SDK 0.2.63 200k-class (sonnet/haiku/opus-4-6). */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Large-window class — opus-4-7 (observed cache_read ~720k) / opus-4-8 (1M). */
export const LARGE_CONTEXT_WINDOW = 1_000_000;

/**
 * Best-effort model → context-window mapping for the BOOT airbag (INV-01),
 * where no live SDK usage exists yet — the live rotation reads
 * `usage.contextWindow` straight from the SDK, but at process boot we only have
 * the on-disk JSONL.
 *
 * Codex correction #5: opus-4-7 must NOT be blind-mapped to 200k — it ran with
 * cache_read ~720k, i.e. a large window; mapping it to 200k would false-rotate a
 * perfectly healthy session. Known large-window models → 1M; everything else
 * (sonnet, haiku, opus-4-6, the SDK 'opus' alias, unknown) → 200k, which keeps
 * the Bug-A 196.8k/200k death-spiral case rotating correctly. Extend the
 * large-window list when the SDK gains real 1M opus-4-8 support.
 */
export function effectiveWindowTokens(model: string | undefined | null): number {
  const m = (model ?? '').toLowerCase();
  if (!m) return DEFAULT_CONTEXT_WINDOW;
  if (m.includes('opus-4-7') || m.includes('opus-4-8') || m.includes('1m')) {
    return LARGE_CONTEXT_WINDOW;
  }
  return DEFAULT_CONTEXT_WINDOW;
}
