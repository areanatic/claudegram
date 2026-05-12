/**
 * RequestContext — V2.5-1 Vollspec, Mai-Intervention Phase C.1.
 *
 * Every user-message handler (streaming, wait, /plan, /explore, /loop) runs inside
 * a RequestContext that owns:
 *  - a deterministic state machine (HandlerState)
 *  - a hard-cap timer (gracefulCancel on expiry)
 *  - an optional long-running heartbeat (one user-facing notification, no finalize)
 *  - an atomic `finalizeOnce()` guard so success, cancel and timeout never double-reply
 *  - a `deadline_ms` (absolute epoch ms) for queue + watchdog visibility
 *
 * This replaces the legacy `Promise.race(handler, setTimeout-reject)` pattern that
 * could deliver both a late real response AND a timeout error to the user (the
 * "Doppel-Message" pattern observed on 2026-05-11 21:01).
 *
 * Cross-Refs:
 *  - shared-memory/nexus/v25_phase_c_handoff_2026-05-12.md V2.5-1
 *  - shared-memory/nexus/codex_phase_c_pre_review_2026-05-12.md §10
 *  - shared-memory/nexus/cross_review_spar-handleagentreply-scope_2026-05-12.md (Option B)
 *  - shared-memory/nexus/phase_c_observation_doppel_message_2026-05-11.md
 */

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { gracefulCancel } from '../claude/request-queue.js';
import {
  registerRequestContext,
  unregisterRequestContext,
  getActiveQueueLength,
} from './request-registry.js';

export enum HandlerState {
  /** Initial — no user-visible reply yet. */
  WAITING = 'WAITING',
  /** > heartbeat threshold — single notification sent. NOT terminal. */
  LONG_RUNNING = 'LONG_RUNNING',
  /** Real response was delivered (finalizeOnce won). Terminal. */
  RESPONDED = 'RESPONDED',
  /** User /cancel or stream error before result. Terminal. */
  CANCELLED = 'CANCELLED',
  /** Hard-cap fired before result. gracefulCancel issued. Terminal. */
  TIMED_OUT = 'TIMED_OUT',
}

export type CancelReason =
  | 'timeout'
  | 'user-cancel'
  | 'system'
  | 'success'
  | null;

export interface RequestContext {
  /** Idempotency key for cross-component correlation (logs, registry, watchdog). */
  readonly requestId: string;
  /** session key (chat:thread). */
  readonly sessionKey: string;
  /** Origin of the request — used by /health for breakdown. */
  readonly origin: RequestOrigin;
  /** Current state machine position. Mutated only via finalize/transition helpers. */
  state: HandlerState;
  /** Absolute epoch-ms deadline. Visible to queue + watchdog for cooperative skip. */
  readonly deadline_ms: number;
  /** Set on transition to a terminal state. */
  cancelReason: CancelReason;
  /** Epoch-ms when context was created — used for /health uptime + adaptive logging. */
  readonly startTime_ms: number;
  /** Effective per-request timeout (after adaptive shrink). */
  readonly effectiveTimeoutMs: number;
  /** Atomic finalize guard. Returns true ONLY on the first call. */
  finalizeOnce: () => boolean;
  /** Hard-cap timer — cleared on finalize. */
  hardCapTimer: NodeJS.Timeout | null;
  /** Optional long-running heartbeat — cleared on finalize. */
  heartbeatTimer: NodeJS.Timeout | null;
  /** Set true after the first LONG_RUNNING notification fires. */
  longRunningNotified: boolean;
}

export type RequestOrigin =
  | 'streaming'
  | 'wait'
  | 'plan'
  | 'explore'
  | 'loop';

export interface CreateRequestContextOptions {
  /** Override the base timeout (defaults to config.AGENT_RESPONSE_TIMEOUT_MS). */
  baseTimeoutMs?: number;
  /**
   * Invoked exactly once when state transitions to LONG_RUNNING.
   * The callback runs AFTER state mutation, so consumers can read the new state.
   * Heartbeat does NOT finalize the request and does NOT count as a reply.
   */
  onLongRunning?: (ctx: RequestContext) => void | Promise<void>;
  /**
   * Invoked exactly once when the hard-cap timer fires AND finalizeOnce wins.
   * `gracefulCancel` is already issued before this fires; consumers just send
   * the user-facing timeout reply.
   */
  onHardCap?: (ctx: RequestContext) => void | Promise<void>;
}

/**
 * Compute the effective per-request timeout based on current per-session queue
 * pressure. V2.5-3 / Sprint 5 Adaptive Timeout.
 *
 * Formula:
 *   if queueLength <= threshold: baseTimeout
 *   else: max(baseTimeout * (1 - (queueLength - threshold) * step), baseTimeout * floor)
 *
 * Defaults yield: queueLen 6 → 90%, 7 → 80%, 10 → 50%, 100 → 50% (floored).
 */
export function computeAdaptiveTimeout(
  sessionKey: string,
  baseTimeoutMs: number,
): { effectiveTimeoutMs: number; queueLength: number } {
  const queueLength = getActiveQueueLength(sessionKey);
  const threshold = config.ADAPTIVE_TIMEOUT_QUEUE_THRESHOLD;
  const step = config.ADAPTIVE_TIMEOUT_STEP_RATIO;
  const floor = config.ADAPTIVE_TIMEOUT_FLOOR_RATIO;

  if (queueLength <= threshold) {
    return { effectiveTimeoutMs: baseTimeoutMs, queueLength };
  }
  const excess = queueLength - threshold;
  const shrunkRatio = Math.max(1 - excess * step, floor);
  const effective = Math.round(baseTimeoutMs * shrunkRatio);
  return { effectiveTimeoutMs: effective, queueLength };
}

/**
 * Create a RequestContext, register it for visibility (watchdog, /health),
 * and install hard-cap + heartbeat timers.
 *
 * Caller is responsible for calling `disposeRequestContext(ctx)` in a finally
 * block — that clears timers, drops the registry entry, and is idempotent with
 * finalizeOnce so nothing leaks if both fire.
 */
export function createRequestContext(
  sessionKey: string,
  origin: RequestOrigin,
  options: CreateRequestContextOptions = {},
): RequestContext {
  const baseTimeoutMs = options.baseTimeoutMs ?? config.AGENT_RESPONSE_TIMEOUT_MS;
  const { effectiveTimeoutMs, queueLength } = computeAdaptiveTimeout(
    sessionKey,
    baseTimeoutMs,
  );

  const startTime_ms = Date.now();
  const deadline_ms = startTime_ms + effectiveTimeoutMs;
  const requestId = randomUUID();

  // Atomic finalize guard. The closed-over `finalized` boolean is the single
  // source of truth — TS single-threaded execution makes the check-and-set
  // atomic for our purposes. Any caller that needs to "win" a terminal
  // transition must go through finalizeOnce().
  let finalized = false;
  const finalizeOnce = (): boolean => {
    if (finalized) return false;
    finalized = true;
    return true;
  };

  const ctx: RequestContext = {
    requestId,
    sessionKey,
    origin,
    state: HandlerState.WAITING,
    deadline_ms,
    cancelReason: null,
    startTime_ms,
    effectiveTimeoutMs,
    finalizeOnce,
    hardCapTimer: null,
    heartbeatTimer: null,
    longRunningNotified: false,
  };

  // Hard-cap timer — single source of timeout truth.
  ctx.hardCapTimer = setTimeout(() => {
    // Atomic: only one finalize wins. If success/cancel already finalized, the
    // hard-cap is silently discarded — no double-reply.
    if (!ctx.finalizeOnce()) return;
    ctx.state = HandlerState.TIMED_OUT;
    ctx.cancelReason = 'timeout';

    // Issue gracefulCancel to tear down the in-flight SDK Query. The Promise
    // returned by the handler will reject on AbortError; the handler's catch
    // block detects finalizeOnce==false (already won by us) and stays silent,
    // while the onHardCap callback below sends the user-facing timeout reply.
    gracefulCancel(sessionKey, 'request-context-hard-cap').catch((err) => {
      console.debug(
        `[RequestContext ${requestId}] gracefulCancel threw on hard-cap:`,
        err,
      );
    });

    if (options.onHardCap) {
      Promise.resolve()
        .then(() => options.onHardCap?.(ctx))
        .catch((err) => {
          console.error(
            `[RequestContext ${requestId}] onHardCap threw:`,
            err,
          );
        });
    }
  }, effectiveTimeoutMs);

  // Optional long-running heartbeat — non-finalizing UX nudge.
  const heartbeatMs = config.HANDLER_LONG_RUNNING_HEARTBEAT_MS;
  if (heartbeatMs > 0 && options.onLongRunning) {
    ctx.heartbeatTimer = setTimeout(() => {
      // Heartbeat must not finalize. If a terminal state is reached, the
      // disposer below clears this timer — but defensive check keeps us safe.
      if (
        ctx.state !== HandlerState.WAITING ||
        ctx.longRunningNotified
      ) {
        return;
      }
      ctx.state = HandlerState.LONG_RUNNING;
      ctx.longRunningNotified = true;
      Promise.resolve()
        .then(() => options.onLongRunning?.(ctx))
        .catch((err) => {
          console.error(
            `[RequestContext ${requestId}] onLongRunning threw:`,
            err,
          );
        });
    }, heartbeatMs);
  }

  registerRequestContext(ctx);

  console.log(
    `[RequestContext ${requestId}] created session=${sessionKey} origin=${origin} ` +
      `baseTimeout=${baseTimeoutMs}ms effectiveTimeout=${effectiveTimeoutMs}ms ` +
      `queueLength=${queueLength} deadline=${new Date(deadline_ms).toISOString()}`,
  );

  return ctx;
}

/**
 * Mark a successful response. Returns true if this caller "won" finalize and
 * should send the response to the user. If false: a hard-cap or cancel already
 * fired — the caller MUST silently drop the late response (do not send to user).
 */
export function markSuccess(ctx: RequestContext): boolean {
  if (!ctx.finalizeOnce()) return false;
  ctx.state = HandlerState.RESPONDED;
  ctx.cancelReason = 'success';
  return true;
}

/**
 * Mark a cancellation (user /cancel or upstream AbortError). Returns true if
 * this caller "won" finalize and should send the cancel reply.
 */
export function markCancelled(
  ctx: RequestContext,
  reason: Extract<CancelReason, 'user-cancel' | 'system'> = 'user-cancel',
): boolean {
  if (!ctx.finalizeOnce()) return false;
  ctx.state = HandlerState.CANCELLED;
  ctx.cancelReason = reason;
  return true;
}

/**
 * Idempotent cleanup. Always call in a `finally` block. Clears timers, drops
 * the registry entry, leaves the state and finalizeOnce result intact for the
 * caller to inspect.
 */
export function disposeRequestContext(ctx: RequestContext): void {
  if (ctx.hardCapTimer) {
    clearTimeout(ctx.hardCapTimer);
    ctx.hardCapTimer = null;
  }
  if (ctx.heartbeatTimer) {
    clearTimeout(ctx.heartbeatTimer);
    ctx.heartbeatTimer = null;
  }
  unregisterRequestContext(ctx);
}

/**
 * Inspect whether the deadline has already passed. Used by request-queue.ts
 * to skip dequeued items whose timeout fired while they were waiting in line
 * (Codex Test-Case 5).
 */
export function isDeadlineExpired(ctx: RequestContext): boolean {
  return Date.now() > ctx.deadline_ms;
}
