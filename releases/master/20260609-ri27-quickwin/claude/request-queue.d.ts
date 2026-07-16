import type { Query } from '@anthropic-ai/claude-agent-sdk';
/**
 * Codex BLOCKER (Akt 1.3 round 6): the handler receives the turn epoch that
 * `processQueue` assigned to THIS dequeue. It must be threaded through to
 * `sendToAgent` so ownership is bound to the dequeue moment — NOT read later
 * inside `sendToAgent`, where a failsafe-released old handler could observe a
 * newer turn's epoch.
 */
export type QueueHandler<T> = (turnEpoch: number) => Promise<T>;
/**
 * Stage 2b Action 1 + Action 3: wait-bound timeout. Raised at dequeue when
 * the queued item is older than its deadline. Distinct from
 * `QueueFailsafeTimeoutError` because no RequestContext was ever created —
 * the outer error-handler crafts the user reply for this case.
 */
export declare class QueueWaitTimeoutError extends Error {
    readonly sessionKey: string;
    readonly waitedMs: number;
    readonly name = "QueueWaitTimeoutError";
    constructor(sessionKey: string, waitedMs: number);
}
/**
 * True if `epoch` is still the latest turn epoch for this session — i.e. no
 * newer turn has been dequeued since `epoch` was assigned. agent.ts uses this
 * to guard every shared-session-state mutation against a late old turn.
 */
export declare function isCurrentTurnEpoch(sessionKey: string, epoch: number): boolean;
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
export declare function invalidateCurrentTurn(sessionKey: string, reason: string): number;
/**
 * Stage 2b Action 3: failsafe-timeout marker error. The outer error-handler
 * in message.handler.ts checks `error.name === 'QueueFailsafeTimeoutError'`
 * and suppresses the user-reply because the RequestContext has already
 * delivered the timeout message via `onHardCap`.
 */
export declare class QueueFailsafeTimeoutError extends Error {
    readonly sessionKey: string;
    readonly name = "QueueFailsafeTimeoutError";
    constructor(sessionKey: string);
}
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
export declare function gracefulCancel(sessionKey: string, reason: string): Promise<void>;
export declare function getAbortController(sessionKey: string): AbortController | undefined;
/**
 * Register the AbortController for the current turn.
 *
 * Codex BLOCKER (Akt 1.3 round 7): when `turnEpoch` is supplied, the set is
 * REFUSED if that epoch is no longer current — a failsafe-released old turn
 * must not overwrite the controller slot a newer turn owns (which would make
 * a later /cancel abort the wrong turn). Returns true if the set happened.
 */
export declare function setAbortController(sessionKey: string, controller: AbortController, turnEpoch?: number): boolean;
export declare function clearAbortController(sessionKey: string, expected?: AbortController): void;
export declare function setActiveQuery(sessionKey: string, q: Query): void;
/**
 * Clear the active Query for a session.
 *
 * Codex BLOCKER 1 (Akt 1.3 re-review): turn-ownership guard. When `expected`
 * is passed, the slot is only cleared if it STILL holds that exact Query — a
 * late teardown of an old (hard-capped) turn must not delete the Query of a
 * newer turn that already claimed the slot. Without `expected`, behaviour is
 * the legacy unconditional delete.
 */
export declare function clearActiveQuery(sessionKey: string, expected?: Query): void;
export declare function isCancelled(sessionKey: string): boolean;
export declare function clearCancelled(sessionKey: string): void;
export declare function isProcessing(sessionKey: string): boolean;
/** Returns true if any session is currently processing a request. */
export declare function isAnyProcessing(): boolean;
/** Returns session keys with an active query or processing flag. */
export declare function getActiveSessionKeys(): string[];
/**
 * Cancel all active requests across all sessions.
 * Pending queue items are rejected with 'Queue cleared' (consistent with clearQueue).
 * Used during graceful shutdown.
 */
export declare function cancelAllRequests(): Promise<void>;
export declare function getQueuePosition(sessionKey: string): number;
/**
 * Stage 2b Action 2: real per-session pending-queue pressure signal. Used by
 * `computeAdaptiveTimeout()` so adaptive shrink reacts to actual queue depth
 * (not just the in-flight RequestContext count). Read-only.
 */
export declare function getPendingQueueLength(sessionKey: string): number;
export declare function queueRequest<T>(sessionKey: string, message: string, handler: QueueHandler<T>): Promise<T>;
/**
 * Soft cancel: backward-compat wrapper around gracefulCancel.
 * Returns true when there was actually something to cancel for this sessionKey.
 */
export declare function cancelRequest(sessionKey: string): Promise<boolean>;
/**
 * Soft reset: backward-compat wrapper around gracefulCancel with reset semantics.
 * gracefulCancel handles both Query.interrupt and last-resort abort uniformly.
 */
export declare function resetRequest(sessionKey: string): Promise<boolean>;
export declare function clearQueue(sessionKey: string): number;
//# sourceMappingURL=request-queue.d.ts.map