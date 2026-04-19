import type { Query } from '@anthropic-ai/claude-agent-sdk';

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
// Tracks chats where a cancel was initiated — checked by agent.ts to detect
// user-initiated cancellation without calling controller.abort() (which crashes the SDK).
const cancelledChats: Set<string> = new Set();

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
  // Interrupt all active SDK queries
  for (const [sessionKey, q] of activeQueries) {
    cancelledChats.add(sessionKey);
    try {
      await q.interrupt();
    } catch (err) {
      console.debug('[cancelAllRequests] interrupt() threw for', sessionKey, err);
    }
  }
  activeQueries.clear();

  // Abort any remaining controllers
  for (const [sessionKey, controller] of activeAbortControllers) {
    cancelledChats.add(sessionKey);
    controller.abort();
  }
  activeAbortControllers.clear();

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

  try {
    const result = await request.handler();
    request.resolve(result);
  } catch (error) {
    request.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    processingFlags.set(sessionKey, false);
    clearAbortController(sessionKey);
    clearActiveQuery(sessionKey);
    clearCancelled(sessionKey);

    if (queue.length > 0) {
      processQueue(sessionKey);
    }
  }
}

/** Soft cancel: interrupt the running query but keep the session alive. */
export async function cancelRequest(sessionKey: string): Promise<boolean> {
  const q = activeQueries.get(sessionKey);

  if (q) {
    // Set the cancelled flag BEFORE interrupt so agent.ts can detect it
    // when the error_during_execution result arrives.
    // Do NOT call controller.abort() — that crashes the SDK subprocess.
    cancelledChats.add(sessionKey);
    try {
      await q.interrupt();
    } catch (err) {
      console.debug('[cancelRequest] interrupt() threw for chat', sessionKey, err);
    }
    clearActiveQuery(sessionKey);
    return true;
  }

  // Fallback to AbortController if no query stored.
  // NOTE: this branch is the race-window case (handler set a controller but
  // hasn't yet called setActiveQuery). Logging explicitly so we can tell
  // later whether a "Request cancelled" came from /cancel vs. elsewhere.
  const controller = activeAbortControllers.get(sessionKey);
  if (controller) {
    console.log(`[cancelRequest] Fallback abort (no active query yet) for ${sessionKey}`);
    cancelledChats.add(sessionKey);
    controller.abort();
    clearAbortController(sessionKey, controller);
    return true;
  }

  return false;
}

/** Soft reset: interrupt query + signal abort to fully tear down the session. */
export async function resetRequest(sessionKey: string): Promise<boolean> {
  const q = activeQueries.get(sessionKey);
  const controller = activeAbortControllers.get(sessionKey);

  if (q) {
    cancelledChats.add(sessionKey);
    try {
      await q.interrupt();
    } catch (err) {
      console.debug('[resetRequest] interrupt() threw for chat', sessionKey, err);
    }
    // Also abort controller to fully tear down
    if (controller) controller.abort();
    clearActiveQuery(sessionKey);
    clearAbortController(sessionKey);
    return true;
  }

  if (controller) {
    cancelledChats.add(sessionKey);
    controller.abort();
    clearAbortController(sessionKey);
    return true;
  }

  return false;
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
