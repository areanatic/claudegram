import { config } from '../config.js';
import { getEarliestDeadline } from '../handler/request-registry.js';
/**
 * Stage 2b Action 1 + Action 3: wait-bound timeout. Raised at dequeue when
 * the queued item is older than its deadline. Distinct from
 * `QueueFailsafeTimeoutError` because no RequestContext was ever created —
 * the outer error-handler crafts the user reply for this case.
 */
export class QueueWaitTimeoutError extends Error {
    sessionKey;
    waitedMs;
    name = 'QueueWaitTimeoutError';
    constructor(sessionKey, waitedMs) {
        super(`Queued request waited ${Math.round(waitedMs / 1000)}s before dequeue — ` + // allow-hardcoded: reason="ms→s log conversion, not a timeout value"
            `exceeds AGENT_RESPONSE_TIMEOUT_MS for session=${sessionKey}.`);
        this.sessionKey = sessionKey;
        this.waitedMs = waitedMs;
    }
}
const activeAbortControllers = new Map();
const activeQueries = new Map();
const pendingQueues = new Map();
const processingFlags = new Map();
/**
 * Codex BLOCKER (Akt 1.3 round 5): per-session turn epoch.
 *
 * Incremented every time `processQueue` dequeues a request — i.e. at the
 * START of a turn, BEFORE the handler runs any `await` and long before
 * `setActiveQuery()`. This is the authoritative "which turn is current"
 * signal. It closes the window the active-query slot could not: between
 * `clearActiveQuery()` in processQueue's finally and the next turn's
 * `setActiveQuery()`, the slot is empty but the epoch has already advanced.
 *
 * A handler captures the epoch at entry (`currentTurnEpoch`) and later asks
 * `isCurrentTurnEpoch()` to know whether a NEWER turn has since taken over.
 */
const turnEpochs = new Map();
/**
 * True if `epoch` is still the latest turn epoch for this session — i.e. no
 * newer turn has been dequeued since `epoch` was assigned. agent.ts uses this
 * to guard every shared-session-state mutation against a late old turn.
 */
export function isCurrentTurnEpoch(sessionKey, epoch) {
    return (turnEpochs.get(sessionKey) ?? 0) === epoch;
}
/**
 * Stage 2 M-024 Cancel-HARD-Rollback (2026-05-28, Codex Iterate-Patch B):
 *
 * Advance the turn epoch WITHOUT dequeueing a new request. After /cancel, the
 * currently-running turn (or a recently-released failsafe turn) still holds
 * the live epoch until `processQueue` dequeues the next item — wide enough for
 * a late `success` message from the cancelled turn to slip past
 * `isStillOwnerTurn()` in agent.ts and re-write `chatSessionIds` /
 * `claudeSessionId` with the stale Claude-session-ID we are deliberately
 * destroying. Calling this from `handleCancel` makes all ownership-guards
 * downstream consider the cancelled turn stale immediately.
 *
 * Returns the new epoch (mostly for logging).
 */
export function invalidateCurrentTurn(sessionKey, reason) {
    const newEpoch = (turnEpochs.get(sessionKey) ?? 0) + 1;
    turnEpochs.set(sessionKey, newEpoch);
    console.log(`[request-queue] invalidateCurrentTurn ${sessionKey} reason=${reason} newEpoch=${newEpoch}`);
    return newEpoch;
}
/**
 * Hard ceiling for handler completion. Stage 2b Action 3 / Action 10:
 *
 * Pure internal failsafe — NOT a user-facing timer. The single source of
 * timeout truth for the user is the per-request RequestContext hard-cap
 * timer created in message.handler.ts / handleAgentReply. If this failsafe
 * fires it means the handler did not honour its own RequestContext deadline
 * (e.g. SDK hang past hard-cap + interrupt + AbortController fallback all
 * failed). gracefulCancel tears down the SDK; the failsafe rejects with a
 * QueueFailsafeTimeoutError that the outer handler MUST silently swallow —
 * no second user-reply because RequestContext.onHardCap already sent one.
 *
 * Previously this comment referenced an in-flight `Promise.race` timer in
 * message.handler.ts; that timer was removed in Stage 2 when the agent-call
 * paths migrated to RequestContext. Stage 2b updated the comment to reflect
 * the new contract.
 */
const QUEUE_HANDLER_TIMEOUT_MS = config.AGENT_RESPONSE_TIMEOUT_MS + 60_000;
/**
 * Stage 2b Action 3: failsafe-timeout marker error. The outer error-handler
 * in message.handler.ts checks `error.name === 'QueueFailsafeTimeoutError'`
 * and suppresses the user-reply because the RequestContext has already
 * delivered the timeout message via `onHardCap`.
 */
export class QueueFailsafeTimeoutError extends Error {
    sessionKey;
    name = 'QueueFailsafeTimeoutError';
    constructor(sessionKey) {
        super(`Queue handler failsafe timeout fired for session=${sessionKey}`);
        this.sessionKey = sessionKey;
    }
}
/**
 * Stage 2b Action 8: timeout for the SDK `query.interrupt()` call inside
 * gracefulCancel. If the SDK does not respect interrupt within this window,
 * fall back to last-resort AbortController.abort(). 5s is generous for a
 * well-behaved SDK but short enough to keep the user from waiting.
 */
const INTERRUPT_TIMEOUT_MS = 5_000;
// Tracks chats where a cancel was initiated. Cleared by gracefulCancel after
// the SDK has actually torn down. See gracefulCancel() below for the canonical
// pathway — direct SDK-aborts outside that function are banned.
const cancelledChats = new Set();
/**
 * gracefulCancel — single canonical cancel pathway.
 * Mai-Intervention 2026-05-11 Phase B.6 (V2.4-6).
 *
 * Contract:
 *  - Prefers Query.interrupt() (SDK-safe, does not crash subprocess)
 *  - Falls back to direct SDK-abort ONLY as last resort, with explicit risk acknowledgement
 *  - Idempotent: safe to call multiple times for the same sessionKey
 *  - Marks the session as cancelled so agent.ts can detect on its next stream event
 *
 * Replaces all direct SDK-abort call-sites in this module and in agent.ts:736.
 * Forensik 2026-05-11: 8 direct abort call-sites had landed across the codebase despite
 * the in-code "Do NOT call" comment — gracefulCancel makes the safe path the only path.
 */
export async function gracefulCancel(sessionKey, reason) {
    if (cancelledChats.has(sessionKey)) {
        return;
    }
    cancelledChats.add(sessionKey);
    console.log(`[gracefulCancel] ${sessionKey} reason=${reason}`);
    // Codex BLOCKER 1 (Akt 1.3 re-review): snapshot the Query + AbortController
    // this cancel OWNS, up front. After the interrupt window a newer turn may
    // have replaced the map slots — the cleanup below must only touch the
    // objects it captured here, never a newer turn's Query/Controller.
    const query = activeQueries.get(sessionKey);
    const ownedController = activeAbortControllers.get(sessionKey);
    let interruptHonoured = false;
    if (query) {
        // Stage 2b Action 8: wrap query.interrupt() with its own short timeout.
        // If the SDK ignores or hangs on interrupt(), we fall through to the
        // AbortController last-resort below within INTERRUPT_TIMEOUT_MS instead
        // of blocking the caller indefinitely.
        //
        // Note: Promise.race here is the *interrupt-fallback* race — not the
        // request-handler timeout. Removing this race would leave gracefulCancel
        // blocked indefinitely on a non-respecting SDK. If Phase D introduces
        // worker-process-isolation, this race can be replaced by a kill-signal
        // to the worker.
        let timeoutHandle = null;
        try {
            await Promise.race([
                query.interrupt().then(() => {
                    interruptHonoured = true;
                }),
                new Promise((resolve) => {
                    timeoutHandle = setTimeout(() => {
                        console.warn(`[gracefulCancel] ${sessionKey} query.interrupt() exceeded ${INTERRUPT_TIMEOUT_MS}ms — falling back to AbortController.abort()`);
                        resolve();
                    }, INTERRUPT_TIMEOUT_MS);
                }),
            ]);
        }
        catch (err) {
            console.debug(`[gracefulCancel] ${sessionKey} interrupt() threw`, err);
        }
        finally {
            if (timeoutHandle)
                clearTimeout(timeoutHandle);
        }
        // Ownership-guarded: only drop the slot if it still holds OUR Query. A
        // newer turn may have set its own Query during the interrupt window.
        if (activeQueries.get(sessionKey) === query) {
            activeQueries.delete(sessionKey);
        }
    }
    // Last-resort abort:
    //   - whenever no Query was registered (handler still in race window), OR
    //   - whenever query.interrupt() did NOT complete within INTERRUPT_TIMEOUT_MS
    //     (Stage 2b Action 8: SDK-AbortSignal-Non-Respect fallback).
    // SDK subprocess may crash; we accept that risk because nothing else can
    // cancel a stuck SDK. Phase D may replace this with worker-process kill if
    // AbortController is also ignored by the SDK.
    //
    // Codex BLOCKER 1: act ONLY on the controller captured at function start.
    // If a newer turn has since replaced the map slot, aborting/deleting the
    // current slot would kill that newer turn.
    const currentController = activeAbortControllers.get(sessionKey);
    const sameOwner = ownedController !== undefined && currentController === ownedController;
    if (ownedController && !ownedController.signal.aborted && !interruptHonoured) {
        console.warn(`[gracefulCancel] ${sessionKey} LAST-RESORT abort — SDK crash risk acknowledged. Reason: ${reason}`);
        ownedController.abort(); // allow-hardcoded: reason="last-resort fallback inside gracefulCancel only — SDK crash risk acknowledged"
        if (sameOwner) {
            activeAbortControllers.delete(sessionKey);
        }
    }
    else if (interruptHonoured && sameOwner) {
        // Interrupt won — drop the controller so a future request gets a fresh one.
        // Only if the slot still holds our controller (no newer turn took over).
        activeAbortControllers.delete(sessionKey);
    }
}
export function getAbortController(sessionKey) {
    return activeAbortControllers.get(sessionKey);
}
/**
 * Register the AbortController for the current turn.
 *
 * Codex BLOCKER (Akt 1.3 round 7): when `turnEpoch` is supplied, the set is
 * REFUSED if that epoch is no longer current — a failsafe-released old turn
 * must not overwrite the controller slot a newer turn owns (which would make
 * a later /cancel abort the wrong turn). Returns true if the set happened.
 */
export function setAbortController(sessionKey, controller, turnEpoch) {
    if (turnEpoch !== undefined && !isCurrentTurnEpoch(sessionKey, turnEpoch)) {
        console.warn(`[request-queue] setAbortController refused for ${sessionKey} — stale turn epoch ${turnEpoch}`);
        return false;
    }
    activeAbortControllers.set(sessionKey, controller);
    return true;
}
export function clearAbortController(sessionKey, expected) {
    if (expected) {
        const current = activeAbortControllers.get(sessionKey);
        if (current && current !== expected) {
            // A newer controller owns this slot — do not clear it.
            return;
        }
    }
    activeAbortControllers.delete(sessionKey);
}
export function setActiveQuery(sessionKey, q) {
    activeQueries.set(sessionKey, q);
}
/**
 * Clear the active Query for a session.
 *
 * Codex BLOCKER 1 (Akt 1.3 re-review): turn-ownership guard. When `expected`
 * is passed, the slot is only cleared if it STILL holds that exact Query — a
 * late teardown of an old (hard-capped) turn must not delete the Query of a
 * newer turn that already claimed the slot. Without `expected`, behaviour is
 * the legacy unconditional delete.
 */
export function clearActiveQuery(sessionKey, expected) {
    if (expected) {
        const current = activeQueries.get(sessionKey);
        if (current && current !== expected) {
            // A newer turn owns this slot — leave it alone.
            return;
        }
    }
    activeQueries.delete(sessionKey);
}
export function isCancelled(sessionKey) {
    return cancelledChats.has(sessionKey);
}
export function clearCancelled(sessionKey) {
    cancelledChats.delete(sessionKey);
}
export function isProcessing(sessionKey) {
    return processingFlags.get(sessionKey) === true;
}
/** Returns true if any session is currently processing a request. */
export function isAnyProcessing() {
    for (const [, flag] of processingFlags) {
        if (flag)
            return true;
    }
    return false;
}
/** Returns session keys with an active query or processing flag. */
export function getActiveSessionKeys() {
    const keys = new Set();
    for (const [key] of activeQueries)
        keys.add(key);
    for (const [key, flag] of processingFlags) {
        if (flag)
            keys.add(key);
    }
    return [...keys];
}
/**
 * Cancel all active requests across all sessions.
 * Pending queue items are rejected with 'Queue cleared' (consistent with clearQueue).
 * Used during graceful shutdown.
 */
export async function cancelAllRequests() {
    // Use gracefulCancel for every active session — handles Query.interrupt + last-resort abort uniformly.
    const sessionKeys = new Set([
        ...activeQueries.keys(),
        ...activeAbortControllers.keys(),
    ]);
    for (const sessionKey of sessionKeys) {
        await gracefulCancel(sessionKey, 'shutdown');
    }
    // Reject all pending queue items — 'Queue cleared' is handled silently by all handlers
    for (const [, queue] of pendingQueues) {
        for (const request of queue) {
            request.reject(new Error('Queue cleared'));
        }
        queue.length = 0;
    }
    pendingQueues.clear();
}
export function getQueuePosition(sessionKey) {
    const queue = pendingQueues.get(sessionKey);
    return queue ? queue.length : 0;
}
/**
 * Stage 2b Action 2: real per-session pending-queue pressure signal. Used by
 * `computeAdaptiveTimeout()` so adaptive shrink reacts to actual queue depth
 * (not just the in-flight RequestContext count). Read-only.
 */
export function getPendingQueueLength(sessionKey) {
    const queue = pendingQueues.get(sessionKey);
    return queue ? queue.length : 0;
}
export async function queueRequest(sessionKey, message, handler) {
    return new Promise((resolve, reject) => {
        const enqueuedAt_ms = Date.now();
        const request = {
            message,
            handler,
            resolve: resolve,
            reject,
            enqueuedAt_ms,
            // Stage 2b Action 1: enqueue-time deadline. Uses the base
            // AGENT_RESPONSE_TIMEOUT_MS — adaptive shrink applies later at the
            // RequestContext layer when the handler actually runs.
            deadline_ms: enqueuedAt_ms + config.AGENT_RESPONSE_TIMEOUT_MS,
        };
        let queue = pendingQueues.get(sessionKey);
        if (!queue) {
            queue = [];
            pendingQueues.set(sessionKey, queue);
        }
        queue.push(request);
        processQueue(sessionKey);
    });
}
async function processQueue(sessionKey) {
    if (processingFlags.get(sessionKey)) {
        return;
    }
    const queue = pendingQueues.get(sessionKey);
    if (!queue || queue.length === 0) {
        return;
    }
    processingFlags.set(sessionKey, true);
    const request = queue.shift();
    // Codex BLOCKER (Akt 1.3 round 5/6): advance the turn epoch at dequeue. This
    // marks "a new turn has begun" BEFORE the handler runs any await. The value
    // is captured here and passed EXPLICITLY into the handler — never re-read
    // later — so a failsafe-released old handler cannot observe a newer turn's
    // epoch and falsely consider itself the owner.
    const thisTurnEpoch = (turnEpochs.get(sessionKey) ?? 0) + 1;
    turnEpochs.set(sessionKey, thisTurnEpoch);
    // Defense-in-depth: ensure no stale cancel flag leaks from the previous
    // request onto this fresh handler execution. finally also clears it, but
    // clearing here guarantees a clean slate even if the previous finally
    // ran out of order or was bypassed by an uncaught error upstream.
    clearCancelled(sessionKey);
    // Phase C.1 / V2.5-3: Deadline-Propagation, two layers.
    //
    // Layer 1 (Stage 2b Action 1): per-queue-item enqueue-time deadline.
    // The user expects total wait (from "send" to first reply) to be bounded
    // by AGENT_RESPONSE_TIMEOUT_MS. If a queued item sat past that, skip it
    // and surface a single wait-bound timeout error to the caller. No
    // RequestContext was created yet for this item, so the OUTER handler owns
    // the user-reply via QueueWaitTimeoutError instanceof check.
    const nowAtDequeue = Date.now();
    if (nowAtDequeue > request.deadline_ms) {
        const waitedMs = nowAtDequeue - request.enqueuedAt_ms;
        processingFlags.set(sessionKey, false);
        request.reject(new QueueWaitTimeoutError(sessionKey, waitedMs));
        if (queue.length > 0) {
            processQueue(sessionKey);
        }
        return;
    }
    // Layer 2 (Stage 2 V2.5-3): stale RequestContext deadline.
    // Defense-in-depth check for the case where a previous handler crashed
    // without disposing its RequestContext — the registry still holds an
    // expired ctx that would falsely make `getEarliestDeadline` claim "past".
    // The Stage 2b registry sweep (`sweepTerminalContexts`) eventually clears
    // such orphans; this guard ensures correctness in the window before sweep.
    const earliestDeadline = getEarliestDeadline(sessionKey);
    if (earliestDeadline !== undefined && Date.now() > earliestDeadline) {
        processingFlags.set(sessionKey, false);
        request.reject(new QueueWaitTimeoutError(sessionKey, Date.now() - request.enqueuedAt_ms));
        if (queue.length > 0) {
            processQueue(sessionKey);
        }
        return;
    }
    let timeoutHandle = null;
    try {
        // Stage 2b Action 3: failsafe-timeout no longer crafts a user-facing
        // error message. The RequestContext hard-cap timer in message.handler /
        // handleAgentReply has ALREADY delivered the timeout reply via
        // `onHardCap`. If this race wins, it means the handler did not honour
        // its own deadline — we tear down the SDK + reject with a marker error
        // so the outer error-handler can swallow it silently.
        const result = await Promise.race([
            // Pass the dequeue-bound turn epoch explicitly (Codex round 6).
            request.handler(thisTurnEpoch),
            new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    // T1 Fix: Interrupt the active query to prevent ghost processes.
                    // Mai-Intervention Phase B.6: routed through gracefulCancel.
                    gracefulCancel(sessionKey, 'queue-handler-failsafe').catch(err => {
                        console.debug('[processQueue] gracefulCancel threw', err);
                    });
                    console.warn(`[processQueue] FAILSAFE timeout fired for ${sessionKey} after ` +
                        `${QUEUE_HANDLER_TIMEOUT_MS / 60_000}min. ` + // allow-hardcoded: reason="ms→min log conversion"
                        `Handler did not honour its RequestContext deadline — no user reply emitted from queue layer.`);
                    reject(new QueueFailsafeTimeoutError(sessionKey));
                }, QUEUE_HANDLER_TIMEOUT_MS);
            }),
        ]);
        request.resolve(result);
    }
    catch (error) {
        request.reject(error instanceof Error ? error : new Error(String(error)));
    }
    finally {
        if (timeoutHandle)
            clearTimeout(timeoutHandle);
        processingFlags.set(sessionKey, false);
        clearAbortController(sessionKey);
        clearActiveQuery(sessionKey);
        clearCancelled(sessionKey);
        if (queue.length > 0) {
            processQueue(sessionKey);
        }
    }
}
/**
 * Soft cancel: backward-compat wrapper around gracefulCancel.
 * Returns true when there was actually something to cancel for this sessionKey.
 */
export async function cancelRequest(sessionKey) {
    const had = activeQueries.has(sessionKey) || activeAbortControllers.has(sessionKey);
    if (had) {
        await gracefulCancel(sessionKey, 'user-cancel');
    }
    return had;
}
/**
 * Soft reset: backward-compat wrapper around gracefulCancel with reset semantics.
 * gracefulCancel handles both Query.interrupt and last-resort abort uniformly.
 */
export async function resetRequest(sessionKey) {
    const had = activeQueries.has(sessionKey) || activeAbortControllers.has(sessionKey);
    if (had) {
        await gracefulCancel(sessionKey, 'user-reset');
    }
    return had;
}
export function clearQueue(sessionKey) {
    const queue = pendingQueues.get(sessionKey);
    if (!queue)
        return 0;
    const count = queue.length;
    for (const request of queue) {
        request.reject(new Error('Queue cleared'));
    }
    queue.length = 0;
    return count;
}
//# sourceMappingURL=request-queue.js.map