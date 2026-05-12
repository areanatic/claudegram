/**
 * RequestRegistry — V2.5-3 Deadline-Propagation for Watchdog + Queue.
 *
 * Tracks every live RequestContext so other components can answer:
 *  - "is this session's deadline already expired?" (request-queue.ts before dequeue)
 *  - "what is the current per-session queue pressure?" (request-context.ts adaptive timeout)
 *  - "what is the global state breakdown?" (/health command)
 *
 * Keeping this as a separate module avoids a circular import between
 * request-context.ts ↔ request-queue.ts.
 *
 * Cross-Refs:
 *  - shared-memory/nexus/codex_phase_c_pre_review_2026-05-12.md V2.5-3
 *  - shared-memory/nexus/v25_phase_c_handoff_2026-05-12.md V2.5-3
 */

import type { RequestContext, HandlerState } from './request-context.js';

// Imports must avoid a cycle — keep this file dependency-free aside from the
// type-only import above.

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
 */
export function getActiveQueueLength(sessionKey: string): number {
  const list = activeContextsBySession.get(sessionKey);
  return list ? list.length : 0;
}

export function getRequestContextById(
  requestId: string,
): RequestContext | undefined {
  return allContextsById.get(requestId);
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
