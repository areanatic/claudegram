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
export declare enum HandlerState {
    /** Initial — no user-visible reply yet. */
    WAITING = "WAITING",
    /** > heartbeat threshold — single notification sent. NOT terminal. */
    LONG_RUNNING = "LONG_RUNNING",
    /** Real response was delivered (finalizeOnce won). Terminal. */
    RESPONDED = "RESPONDED",
    /** User /cancel or stream error before result. Terminal. */
    CANCELLED = "CANCELLED",
    /** Hard-cap fired before result. gracefulCancel issued. Terminal. */
    TIMED_OUT = "TIMED_OUT"
}
export type CancelReason = 'timeout' | 'user-cancel' | 'system' | 'success' | null;
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
export type RequestOrigin = 'streaming' | 'wait' | 'plan' | 'explore' | 'loop';
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
 * Compute the effective per-request timeout based on current per-session
 * queue pressure. V2.5-3 / Sprint 5 Adaptive Timeout.
 *
 * Formula:
 *   if queueLength <= threshold: baseTimeout
 *   else: max(baseTimeout * (1 - (queueLength - threshold) * step), baseTimeout * floor)
 *
 * Stage 2b Action 2: `queueLength` is now the sum of the pending request-queue
 * length AND the live RequestContext registry length. In serial workloads the
 * registry is at most 1 (the in-flight handler), so the pending queue is the
 * real pressure-signal. Combining both is forward-safe in case future workloads
 * have multiple in-flight contexts per session.
 *
 * Defaults yield: queueLen 6 → 90%, 7 → 80%, 10 → 50%, 100 → 50% (floored).
 *
 * Config-Validation Stage 2b: threshold/step/floor are clamped to a sane range
 * inside the function so a misconfigured `.env` cannot produce a 0ms timeout.
 */
export declare function computeAdaptiveTimeout(sessionKey: string, baseTimeoutMs: number): {
    effectiveTimeoutMs: number;
    queueLength: number;
};
/**
 * Create a RequestContext, register it for visibility (watchdog, /health),
 * and install hard-cap + heartbeat timers.
 *
 * Caller is responsible for calling `disposeRequestContext(ctx)` in a finally
 * block — that clears timers, drops the registry entry, and is idempotent with
 * finalizeOnce so nothing leaks if both fire.
 */
export declare function createRequestContext(sessionKey: string, origin: RequestOrigin, options?: CreateRequestContextOptions): RequestContext;
/**
 * Mark a successful response. Returns true if this caller "won" finalize and
 * should send the response to the user. If false: a hard-cap or cancel already
 * fired — the caller MUST silently drop the late response (do not send to user).
 */
export declare function markSuccess(ctx: RequestContext): boolean;
/**
 * Mark a cancellation (user /cancel or upstream AbortError). Returns true if
 * this caller "won" finalize and should send the cancel reply.
 */
export declare function markCancelled(ctx: RequestContext, reason?: Extract<CancelReason, 'user-cancel' | 'system'>): boolean;
/**
 * Idempotent cleanup. Always call in a `finally` block. Clears timers, drops
 * the registry entry, leaves the state and finalizeOnce result intact for the
 * caller to inspect.
 */
export declare function disposeRequestContext(ctx: RequestContext): void;
//# sourceMappingURL=request-context.d.ts.map