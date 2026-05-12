/**
 * RequestRegistry — V2.5-3 Deadline-Propagation for Watchdog + Queue.
 *
 * Tracks every live RequestContext so other components can answer:
 *  - "is this session's deadline already expired?" (request-queue.ts before dequeue)
 *  - "what is the current per-session queue pressure?" (request-context.ts adaptive timeout)
 *  - "what is the global state breakdown?" (/health command)
 *  - "finalise all active contexts for this session" (/cancel — Stage 2b Action 5)
 *
 * Keeping this as a separate module avoids a circular import between
 * request-context.ts ↔ request-queue.ts.
 *
 * Cross-Refs:
 *  - shared-memory/nexus/codex_phase_c_pre_review_2026-05-12.md V2.5-3
 *  - shared-memory/nexus/v25_phase_c_handoff_2026-05-12.md V2.5-3
 *  - shared-memory/nexus/cross_review_phase-c-stage3-diff_2026-05-12.md (Stage 2b Action 5+9)
 */

import { HandlerState, type RequestContext } from './request-context.js';

// Imports must avoid a cycle — keep this file dependency-free aside from the
// type-only import above (HandlerState is used at runtime for sweep + terminal-detect).

/** sessionKey → array of live contexts (queued + in-flight for this session). */
const activeContextsBySession: Map<string, RequestContext[]> = new Map();

/** requestId → context (global lookup, e.g. for /health summary). */
const allContextsById: Map<string, RequestContext> = new Map();

export function registerRequestContext(ctx: RequestContext): void {
  let list = activeContextsBySession.get(ctx.sessionKey);
  if (!list) {
    list = [];
    activeContextsBySession.set(ctx.sessionKey, list);
  }
  list.push(ctx);
  allContextsById.set(ctx.requestId, ctx);
}

export function unregisterRequestContext(ctx: RequestContext): void {
  const list = activeContextsBySession.get(ctx.sessionKey);
  if (list) {
    const idx = list.indexOf(ctx);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) {
      activeContextsBySession.delete(ctx.sessionKey);
    }
  }
  allContextsById.delete(ctx.requestId);
}

/**
 * Number of live RequestContexts for this session. Used by adaptive-timeout
 * computation in request-context.ts. Includes the in-flight one if any.
 *
 * NOTE Stage 2b: combined with `getPendingQueueLength()` from request-queue.ts
 * to give a faithful pressure-signal for serial workloads (where contexts
 * exist only after dequeue). See computeAdaptiveTimeout() callers.
 */
export function getActiveQueueLength(sessionKey: string): number {
  const list = activeContextsBySession.get(sessionKey);
  return list ? list.length : 0;
}

/**
 * Return all non-terminal RequestContexts for a session. Used by /cancel
 * (Stage 2b Action 5) to finalise everything the user explicitly aborts.
 */
export function getActiveContextsForSession(
  sessionKey: string,
): RequestContext[] {
  const list = activeContextsBySession.get(sessionKey);
  if (!list || list.length === 0) return [];
  // Filter out terminal contexts to avoid double-finalize attempts.
  return list.filter(
    (c) =>
      c.state === HandlerState.WAITING ||
      c.state === HandlerState.LONG_RUNNING,
  );
}

/**
 * Earliest deadline (epoch-ms) for this session, or undefined if no live ctx.
 * Used by request-queue.ts to decide whether to even dequeue the next item.
 */
export function getEarliestDeadline(sessionKey: string): number | undefined {
  const list = activeContextsBySession.get(sessionKey);
  if (!list || list.length === 0) return undefined;
  let earliest = list[0].deadline_ms;
  for (let i = 1; i < list.length; i++) {
    if (list[i].deadline_ms < earliest) earliest = list[i].deadline_ms;
  }
  return earliest;
}

/**
 * Snapshot for /health output. Includes per-state counts so the operator can
 * see "5 waiting, 2 long-running, 0 timed-out" at a glance.
 */
export interface RegistrySnapshot {
  totalActive: number;
  sessionsActive: number;
  byState: Record<HandlerState, number>;
  byOrigin: Record<string, number>;
}

export function snapshotRegistry(): RegistrySnapshot {
  const byState: Record<string, number> = {};
  const byOrigin: Record<string, number> = {};
  let totalActive = 0;

  for (const ctx of allContextsById.values()) {
    totalActive++;
    byState[ctx.state] = (byState[ctx.state] ?? 0) + 1;
    byOrigin[ctx.origin] = (byOrigin[ctx.origin] ?? 0) + 1;
  }

  return {
    totalActive,
    sessionsActive: activeContextsBySession.size,
    byState: byState as Record<HandlerState, number>,
    byOrigin,
  };
}

/**
 * Sweep terminal RequestContexts that linger in the registry. Stage 2b
 * Action 9: defensive safety-net on top of eager `disposeRequestContext` in
 * the handler `finally` blocks. Catches the rare leak where a handler crashes
 * outside the try/finally guard.
 *
 * Returns the number of entries removed (for /health observability + tests).
 *
 * Sweep policy:
 *  - RESPONDED / CANCELLED / TIMED_OUT contexts → drop (eager-remove backup).
 *  - WAITING / LONG_RUNNING contexts whose deadline is > 2× past → mark
 *    TIMED_OUT (best-effort, no callbacks) and drop. This is a circuit-breaker
 *    in case `disposeRequestContext()` was never called (handler hung outside
 *    try/finally). 2× factor avoids fighting a still-running handler that may
 *    legitimately exceed the soft deadline by a few seconds.
 */
export function sweepTerminalContexts(now: number = Date.now()): number {
  let removed = 0;
  // Snapshot first — mutating during iteration of the underlying Map is unsafe
  // when `unregisterRequestContext` reshuffles the per-session arrays.
  const candidates: RequestContext[] = [];
  for (const ctx of allContextsById.values()) {
    if (
      ctx.state === HandlerState.RESPONDED ||
      ctx.state === HandlerState.CANCELLED ||
      ctx.state === HandlerState.TIMED_OUT
    ) {
      candidates.push(ctx);
      continue;
    }
    // Hard circuit-breaker for non-terminal contexts whose deadline is
    // long-overdue (defensive safety-net only).
    const overdueBy = now - ctx.deadline_ms;
    if (overdueBy > ctx.effectiveTimeoutMs) {
      candidates.push(ctx);
    }
  }
  for (const ctx of candidates) {
    if (
      ctx.state !== HandlerState.RESPONDED &&
      ctx.state !== HandlerState.CANCELLED &&
      ctx.state !== HandlerState.TIMED_OUT
    ) {
      // finalize best-effort so nothing else thinks it can still reply.
      try {
        if (ctx.finalizeOnce()) {
          ctx.state = HandlerState.TIMED_OUT;
          ctx.cancelReason = 'timeout';
        }
      } catch {
        // ignore — finalizeOnce is closed-over boolean, throws extremely unlikely
      }
      console.warn(
        `[RequestRegistry sweep] dropping orphaned non-terminal ctx ` +
          `requestId=${ctx.requestId} session=${ctx.sessionKey} ` +
          `state=${ctx.state} (handler did not dispose).`,
      );
    }
    unregisterRequestContext(ctx);
    removed++;
  }
  return removed;
}

let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic sweep. Called once during bot bootstrap; safe to call
 * multiple times (idempotent — second call is a no-op).
 *
 * Defaults to 60s sweep cadence — fast enough to react to leaks within one
 * health-check window, slow enough that the wasted work is negligible.
 */
export function startRegistrySweep(intervalMs: number = 60_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      const removed = sweepTerminalContexts();
      if (removed > 0) {
        console.log(
          `[RequestRegistry] periodic sweep removed ${removed} terminal/orphan ctx`,
        );
      }
    } catch (err) {
      console.error('[RequestRegistry] sweep threw', err);
    }
  }, intervalMs);
  // Don't prevent process shutdown.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

export function stopRegistrySweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
