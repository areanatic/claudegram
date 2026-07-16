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
export declare function registerRequestContext(ctx: RequestContext): void;
export declare function unregisterRequestContext(ctx: RequestContext): void;
/**
 * Number of live RequestContexts for this session. Used by adaptive-timeout
 * computation in request-context.ts. Includes the in-flight one if any.
 *
 * NOTE Stage 2b: combined with `getPendingQueueLength()` from request-queue.ts
 * to give a faithful pressure-signal for serial workloads (where contexts
 * exist only after dequeue). See computeAdaptiveTimeout() callers.
 */
export declare function getActiveQueueLength(sessionKey: string): number;
/**
 * Return all non-terminal RequestContexts for a session. Used by /cancel
 * (Stage 2b Action 5) to finalise everything the user explicitly aborts.
 */
export declare function getActiveContextsForSession(sessionKey: string): RequestContext[];
/**
 * Earliest deadline (epoch-ms) for this session, or undefined if no live ctx.
 * Used by request-queue.ts to decide whether to even dequeue the next item.
 */
export declare function getEarliestDeadline(sessionKey: string): number | undefined;
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
export declare function snapshotRegistry(): RegistrySnapshot;
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
export declare function sweepTerminalContexts(now?: number): number;
/**
 * Start the periodic sweep. Called once during bot bootstrap; safe to call
 * multiple times (idempotent — second call is a no-op).
 *
 * Defaults to 60s sweep cadence — fast enough to react to leaks within one
 * health-check window, slow enough that the wasted work is negligible.
 */
export declare function startRegistrySweep(intervalMs?: number): void;
export declare function stopRegistrySweep(): void;
//# sourceMappingURL=request-registry.d.ts.map