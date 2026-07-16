/**
 * Input-Log middleware — Schlachtplan Akt 1.2 (2026-05-21).
 *
 * Registered AFTER auth, BEFORE `sequentialize`. For every content update
 * (text / voice / audio / photo / document) it:
 *   1. INSERTs a durable `input_log` row (status='received') — survives a
 *      crash or watchdog cancel that happens later in the turn.
 *   2. Sends a lightweight ACK reaction (👀) so the user sees "received"
 *      immediately, even while a long agent turn is still queued.
 *
 * The middleware NEVER blocks: DB and ACK errors are swallowed. The row id is
 * stashed in a bounded in-process map keyed by `chatId:messageId` so the
 * per-type handlers can later call `markProcessing` / `markDone` / `markDropped`.
 *
 * Why a map instead of `ctx.state`: grammY's Context has no typed `state`
 * without a context-flavor refactor. A small bounded map keeps Akt 1 minimal
 * (no cross-cutting type change) and is isolated to this file.
 */
import { Context, NextFunction } from 'grammy';
/** Resolve the input_log row id for a received message, if one was recorded. */
export declare function getInputLogRowId(chatId: number | undefined, messageId: number | undefined): number | null;
/** Drop a tracked row id once the handler is fully done with it. */
export declare function forgetInputLogRowId(chatId: number | undefined, messageId: number | undefined): void;
export declare function inputLogMiddleware(ctx: Context, next: NextFunction): Promise<void>;
//# sourceMappingURL=input-log.middleware.d.ts.map