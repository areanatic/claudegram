import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { getEarliestDeadline } from '../handler/request-registry.js';

type QueuedRequest<T> = {
  message: string;
  handler: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

const activeAbortControllers: Map<string, AbortController> = new Map();
const activeQueries: Map<string, Query> = new Map();
const pendingQueues: Map<string, Array<QueuedRequest<unknown>>> = new Map();
const processingFlags: Map<string, boolean> = new Map();

/**
 * Hard ceiling for handler completion. Set to AGENT_RESPONSE_TIMEOUT_MS + 60s
 * buffer so the handler-level timer always fires after the in-flight Promise.race
 * timer in message.handler.ts. Mai-Intervention 2026-05-11 Phase A.1.
 */
const QUEUE_HANDLER_TIMEOUT_MS = config.AGENT_RESPONSE_TIMEOUT_MS + 60_000;
// Tracks chats where a cancel was initiated. Cleared by gracefulCancel after
// the SDK has actually torn down. See gracefulCancel() below for the canonical
// pathway — direct SDK-aborts outside that function are banned.
const cancelledChats: Set<string> = new Set();

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
export async function gracefulCancel(sessionKey: string, reason: string): Promise<void> {
  if (cancelledChats.has(sessionKey)) {
    return;
  }
  cancelledChats.add(sessionKey);
  console.log(`[gracefulCancel] ${sessionKey} reason=${reason}`);

  const query = activeQueries.get(sessionKey);
  if (query) {
    try {
      await query.interrupt();
    } catch (err) {
      console.debug(`[gracefulCancel] ${sessionKey} interrupt() threw`, err);
    }
    activeQueries.delete(sessionKey);
  }

  // Last-resort abort, only when no Query existed (handler still in race window).
  // SDK subprocess may crash; we accept that risk only because nothing else can cancel.
  const controller = activeAbortControllers.get(sessionKey);
  if (controller && !controller.signal.aborted) {
    console.warn(`[gracefulCancel] ${sessionKey} LAST-RESORT abort — SDK crash risk acknowledged. Reason: ${reason}`);
    controller.abort(); // allow-hardcoded: reason="last-resort fallback inside gracefulCancel only — SDK crash risk acknowledged"
    activeAbortControllers.delete(sessionKey);
  }
}

export function getAbortController(sessionKey: string): AbortController | undefined {
  return activeAbortControllers.get(sessionKey);
}

export function setAbortController(sessionKey: string, controller: AbortController): void {
  activeAbortControllers.set(sessionKey, controller);
}

export function clearAbortController(sessionKey: string, expected?: AbortController): void {
  if (expected) {
    const current = activeAbortControllers.get(sessionKey);
    if (current && current !== expected) {
      // A newer controller owns this slot — do not clear it.
      return;
    }
  }
  activeAbortControllers.delete(sessionKey);
}

export function setActiveQuery(sessionKey: string, q: Query): void {
  activeQueries.set(sessionKey, q);
}

export function clearActiveQuery(sessionKey: string): void {
  activeQueries.delete(sessionKey);
}

export function isCancelled(sessionKey: string): boolean {
  return cancelledChats.has(sessionKey);
}

export function clearCancelled(sessionKey: string): void {
  cancelledChats.delete(sessionKey);
}

export function isProcessing(sessionKey: string): boolean {
  return processingFlags.get(sessionKey) === true;
}

/** Returns true if any session is currently processing a request. */
export function isAnyProcessing(): boolean {
  for (const [, flag] of processingFlags) {
    if (flag) return true;
  }
  return false;
}

/** Returns session keys with an active query or processing flag. */
export function getActiveSessionKeys(): string[] {
  const keys = new Set<string>();
  for (const [key] of activeQueries) keys.add(key);
  for (const [key, flag] of processingFlags) {
    if (flag) keys.add(key);
  }
  return [...keys];
}

/**
 * Cancel all active requests across all sessions.
 * Pending queue items are rejected with 'Queue cleared' (consistent with clearQueue).
 * Used during graceful shutdown.
 */
export async function cancelAllRequests(): Promise<void> {
  // Use gracefulCancel for every active session — handles Query.interrupt + last-resort abort uniformly.
  const sessionKeys = new Set<string>([
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

export function getQueuePosition(sessionKey: string): number {
  const queue = pendingQueues.get(sessionKey);
  return queue ? queue.length : 0;
}

export async function queueRequest<T>(
  sessionKey: string,
  message: string,
  handler: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request: QueuedRequest<T> = {
      message,
      handler,
      resolve: resolve as (value: unknown) => void,
      reject,
    };

    let queue = pendingQueues.get(sessionKey);
    if (!queue) {
      queue = [];
      pendingQueues.set(sessionKey, queue);
    }
    queue.push(request as QueuedRequest<unknown>);

    processQueue(sessionKey);
  });
}

async function processQueue(sessionKey: string): Promise<void> {
  if (processingFlags.get(sessionKey)) {
    return;
  }

  const queue = pendingQueues.get(sessionKey);
  if (!queue || queue.length === 0) {
    return;
  }

  processingFlags.set(sessionKey, true);
  const request = queue.shift()!;

  // Defense-in-depth: ensure no stale cancel flag leaks from the previous
  // request onto this fresh handler execution. finally also clears it, but
  // clearing here guarantees a clean slate even if the previous finally
  // ran out of order or was bypassed by an uncaught error upstream.
  clearCancelled(sessionKey);

  // Phase C.1 / V2.5-3: Deadline-Propagation. If a RequestContext for this
  // session already expired while sitting in the queue (Codex Test-Case 5:
  // "Queue-Drain mit bereits abgelaufener Deadline startet keinen Agent-Call
  // mehr"), reject immediately without spawning a fresh SDK call. The handler
  // itself will create its own RequestContext on dequeue; this guard fires
  // ONLY for stale upstream contexts that already finalised TIMED_OUT.
  const earliestDeadline = getEarliestDeadline(sessionKey);
  if (earliestDeadline !== undefined && Date.now() > earliestDeadline) {
    processingFlags.set(sessionKey, false);
    request.reject(
      new Error(
        '⏱ Timeout: Deadline ist abgelaufen, bevor die Anfrage drankam. Bitte nochmal senden.',
      ),
    );
    if (queue.length > 0) {
      processQueue(sessionKey);
    }
    return;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  try {
    const result = await Promise.race([
      request.handler(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          // T1 Fix: Interrupt the active query to prevent ghost processes.
          // Mai-Intervention Phase B.6: routed through gracefulCancel to avoid
          // duplicating the interrupt/abort logic.
          gracefulCancel(sessionKey, 'queue-handler-timeout').catch(err => {
            console.debug('[processQueue] gracefulCancel threw', err);
          });
          reject(new Error(`⏱ Timeout: Anfrage nach ${QUEUE_HANDLER_TIMEOUT_MS / 60000} Min abgebrochen. Bitte nochmal senden.`));
        }, QUEUE_HANDLER_TIMEOUT_MS);
      }),
    ]);
    request.resolve(result);
  } catch (error) {
    request.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
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
export async function cancelRequest(sessionKey: string): Promise<boolean> {
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
export async function resetRequest(sessionKey: string): Promise<boolean> {
  const had = activeQueries.has(sessionKey) || activeAbortControllers.has(sessionKey);
  if (had) {
    await gracefulCancel(sessionKey, 'user-reset');
  }
  return had;
}

export function clearQueue(sessionKey: string): number {
  const queue = pendingQueues.get(sessionKey);
  if (!queue) return 0;

  const count = queue.length;
  for (const request of queue) {
    request.reject(new Error('Queue cleared'));
  }
  queue.length = 0;
  return count;
}
