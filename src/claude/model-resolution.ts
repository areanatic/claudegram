/**
 * INV-02 (Model-Truth) — single source for "which model does this session use".
 *
 * Kept dependency-free so it can be unit-tested and so the model the bot DISPLAYS
 * (getModel) and the model it RUNS (effectiveModel) are computed by the EXACT same
 * function — they can never diverge again. Before this, effectiveModel defaulted to
 * 'sonnet' and getModel to 'opus', so /status lied about the running model.
 *
 * Precedence: explicit per-call override > per-session (/model X) > config default
 * > hard fallback. Values are SDK model aliases ('sonnet' | 'opus' | 'haiku') or a
 * full id; the SDK resolves them. Default is 'sonnet' per the user strategy: fast
 * Sonnet default, Opus only on-demand.
 */
export const DEFAULT_MODEL_FALLBACK = 'sonnet';

export function resolveModel(
  override: string | undefined,
  perSession: string | undefined,
  configDefault: string | undefined,
): string {
  return override || perSession || configDefault || DEFAULT_MODEL_FALLBACK;
}
