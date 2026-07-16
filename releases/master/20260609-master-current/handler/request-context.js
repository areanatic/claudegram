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
import { getPendingQueueLength, gracefulCancel, } from '../claude/request-queue.js';
import { registerRequestContext, unregisterRequestContext, getActiveQueueLength, } from './request-registry.js';
export var HandlerState;
(function (HandlerState) {
    /** Initial — no user-visible reply yet. */
    HandlerState["WAITING"] = "WAITING";
    /** > heartbeat threshold — single notification sent. NOT terminal. */
    HandlerState["LONG_RUNNING"] = "LONG_RUNNING";
    /** Real response was delivered (finalizeOnce won). Terminal. */
    HandlerState["RESPONDED"] = "RESPONDED";
    /** User /cancel or stream error before result. Terminal. */
    HandlerState["CANCELLED"] = "CANCELLED";
    /** Hard-cap fired before result. gracefulCancel issued. Terminal. */
    HandlerState["TIMED_OUT"] = "TIMED_OUT";
})(HandlerState || (HandlerState = {}));
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
export function computeAdaptiveTimeout(sessionKey, baseTimeoutMs) {
    // Combine pending-queue (real pressure) with active-registry (forward-safe).
    const pending = safePendingQueueLength(sessionKey);
    const active = getActiveQueueLength(sessionKey);
    const queueLength = pending + active;
    // Clamp config so a misconfigured deployment cannot break the timer.
    const rawThreshold = config.ADAPTIVE_TIMEOUT_QUEUE_THRESHOLD;
    const rawStep = config.ADAPTIVE_TIMEOUT_STEP_RATIO;
    const rawFloor = config.ADAPTIVE_TIMEOUT_FLOOR_RATIO;
    const threshold = Number.isFinite(rawThreshold) && rawThreshold >= 0
        ? rawThreshold
        : 5; // allow-hardcoded: reason="config-fallback when env is invalid, not a timeout"
    const step = Number.isFinite(rawStep) && rawStep >= 0 && rawStep <= 1
        ? rawStep
        : 0.1; // allow-hardcoded: reason="config-fallback ratio for invalid env"
    const floor = Number.isFinite(rawFloor) && rawFloor > 0 && rawFloor <= 1
        ? rawFloor
        : 0.5; // allow-hardcoded: reason="config-fallback ratio for invalid env"
    if (rawThreshold !== threshold ||
        rawStep !== step ||
        rawFloor !== floor) {
        console.warn(`[ComputeAdaptiveTimeout] config clamp applied (env values out of range): ` +
            `threshold=${rawThreshold}->${threshold}, step=${rawStep}->${step}, ` +
            `floor=${rawFloor}->${floor}`);
    }
    if (queueLength <= threshold) {
        return { effectiveTimeoutMs: baseTimeoutMs, queueLength };
    }
    const excess = queueLength - threshold;
    const shrunkRatio = Math.max(1 - excess * step, floor);
    const effective = Math.round(baseTimeoutMs * shrunkRatio);
    return { effectiveTimeoutMs: effective, queueLength };
}
function safePendingQueueLength(sessionKey) {
    // Defensive: request-queue.ts is loaded above; in pathological reload
    // scenarios the function could be undefined. Treat as zero pressure.
    try {
        return getPendingQueueLength(sessionKey);
    }
    catch {
        return 0;
    }
}
/**
 * Create a RequestContext, register it for visibility (watchdog, /health),
 * and install hard-cap + heartbeat timers.
 *
 * Caller is responsible for calling `disposeRequestContext(ctx)` in a finally
 * block — that clears timers, drops the registry entry, and is idempotent with
 * finalizeOnce so nothing leaks if both fire.
 */
export function createRequestContext(sessionKey, origin, options = {}) {
    const baseTimeoutMs = options.baseTimeoutMs ?? config.AGENT_RESPONSE_TIMEOUT_MS;
    const { effectiveTimeoutMs, queueLength } = computeAdaptiveTimeout(sessionKey, baseTimeoutMs);
    const startTime_ms = Date.now();
    const deadline_ms = startTime_ms + effectiveTimeoutMs;
    const requestId = randomUUID();
    // Atomic finalize guard. The closed-over `finalized` boolean is the single
    // source of truth — TS single-threaded execution makes the check-and-set
    // atomic for our purposes. Any caller that needs to "win" a terminal
    // transition must go through finalizeOnce().
    let finalized = false;
    const finalizeOnce = () => {
        if (finalized)
            return false;
        finalized = true;
        return true;
    };
    const ctx = {
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
        if (!ctx.finalizeOnce())
            return;
        ctx.state = HandlerState.TIMED_OUT;
        ctx.cancelReason = 'timeout';
        // Issue gracefulCancel to tear down the in-flight SDK Query. The Promise
        // returned by the handler will reject on AbortError; the handler's catch
        // block detects finalizeOnce==false (already won by us) and stays silent,
        // while the onHardCap callback below sends the user-facing timeout reply.
        gracefulCancel(sessionKey, 'request-context-hard-cap').catch((err) => {
            console.debug(`[RequestContext ${requestId}] gracefulCancel threw on hard-cap:`, err);
        });
        if (options.onHardCap) {
            Promise.resolve()
                .then(() => options.onHardCap?.(ctx))
                .catch((err) => {
                console.error(`[RequestContext ${requestId}] onHardCap threw:`, err);
            });
        }
    }, effectiveTimeoutMs);
    // Optional long-running heartbeat — non-finalizing UX nudge.
    const heartbeatMs = config.HANDLER_LONG_RUNNING_HEARTBEAT_MS;
    if (heartbeatMs > 0 && options.onLongRunning) {
        ctx.heartbeatTimer = setTimeout(() => {
            // Heartbeat must not finalize. If a terminal state is reached, the
            // disposer below clears this timer — but defensive check keeps us safe.
            if (ctx.state !== HandlerState.WAITING ||
                ctx.longRunningNotified) {
                return;
            }
            ctx.state = HandlerState.LONG_RUNNING;
            ctx.longRunningNotified = true;
            Promise.resolve()
                .then(() => options.onLongRunning?.(ctx))
                .catch((err) => {
                console.error(`[RequestContext ${requestId}] onLongRunning threw:`, err);
            });
        }, heartbeatMs);
    }
    registerRequestContext(ctx);
    console.log(`[RequestContext ${requestId}] created session=${sessionKey} origin=${origin} ` +
        `baseTimeout=${baseTimeoutMs}ms effectiveTimeout=${effectiveTimeoutMs}ms ` +
        `queueLength=${queueLength} deadline=${new Date(deadline_ms).toISOString()}`);
    return ctx;
}
/**
 * Mark a successful response. Returns true if this caller "won" finalize and
 * should send the response to the user. If false: a hard-cap or cancel already
 * fired — the caller MUST silently drop the late response (do not send to user).
 */
export function markSuccess(ctx) {
    if (!ctx.finalizeOnce())
        return false;
    ctx.state = HandlerState.RESPONDED;
    ctx.cancelReason = 'success';
    return true;
}
/**
 * Mark a cancellation (user /cancel or upstream AbortError). Returns true if
 * this caller "won" finalize and should send the cancel reply.
 */
export function markCancelled(ctx, reason = 'user-cancel') {
    if (!ctx.finalizeOnce())
        return false;
    ctx.state = HandlerState.CANCELLED;
    ctx.cancelReason = reason;
    return true;
}
/**
 * Idempotent cleanup. Always call in a `finally` block. Clears timers, drops
 * the registry entry, leaves the state and finalizeOnce result intact for the
 * caller to inspect.
 */
export function disposeRequestContext(ctx) {
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
// (Stage 2b Action 10 dead-code removal): `isDeadlineExpired` was unused —
// request-queue.ts reads `getEarliestDeadline(sessionKey)` directly. Removed.
//# sourceMappingURL=request-context.js.map