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
 * Classify how full the context window is.
 * @param usedTokens     input + output + cacheRead (same definition as the usage footer)
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
