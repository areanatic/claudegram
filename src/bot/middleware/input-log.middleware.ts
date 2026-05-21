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
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { recordInput, finalizeIfOpen, type InputType } from '../../inbox/input-log.js';

/** chatId:messageId -> input_log row id. Bounded LRU-ish (oldest evicted). */
const rowIdByMessage = new Map<string, number>();
const MAX_TRACKED = 500;

function trackKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/** Resolve the input_log row id for a received message, if one was recorded. */
export function getInputLogRowId(chatId: number | undefined, messageId: number | undefined): number | null {
  if (chatId == null || messageId == null) return null;
  return rowIdByMessage.get(trackKey(chatId, messageId)) ?? null;
}

/** Drop a tracked row id once the handler is fully done with it. */
export function forgetInputLogRowId(chatId: number | undefined, messageId: number | undefined): void {
  if (chatId == null || messageId == null) return;
  rowIdByMessage.delete(trackKey(chatId, messageId));
}

function classify(ctx: Context): { type: InputType; text: string | null; fileId: string | null } | null {
  const msg = ctx.message;
  if (!msg) return null;
  if (msg.voice) return { type: 'voice', text: null, fileId: msg.voice.file_id };
  if (msg.audio) return { type: 'audio', text: null, fileId: msg.audio.file_id };
  if (msg.photo && msg.photo.length > 0) {
    return { type: 'photo', text: msg.caption ?? null, fileId: msg.photo[msg.photo.length - 1].file_id };
  }
  if (msg.document) return { type: 'document', text: msg.caption ?? null, fileId: msg.document.file_id };
  if (typeof msg.text === 'string') return { type: 'text', text: msg.text, fileId: null };
  return null;
}

export async function inputLogMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  let recordedRowId: number | null = null;

  try {
    const classified = classify(ctx);
    const keyInfo = getSessionKeyFromCtx(ctx);
    const messageId = ctx.message?.message_id;
    const chatId = ctx.chat?.id;

    // Skip bot commands (/cancel, /start, …): they are control messages, not
    // durable user inputs, and several of them bypass sequentialize entirely.
    const isCommand =
      classified?.type === 'text' &&
      typeof classified.text === 'string' &&
      classified.text.startsWith('/');

    if (classified && keyInfo && messageId != null && chatId != null && !isCommand) {
      const rowId = recordInput({
        messageId,
        chatId,
        sessionKey: keyInfo.sessionKey,
        inputType: classified.type,
        rawContent: classified.text,
        fileId: classified.fileId,
      });
      if (rowId != null) {
        recordedRowId = rowId;
        if (rowIdByMessage.size >= MAX_TRACKED) {
          const oldest = rowIdByMessage.keys().next().value;
          if (oldest !== undefined) rowIdByMessage.delete(oldest);
        }
        rowIdByMessage.set(trackKey(chatId, messageId), rowId);
      }

      // Lightweight ACK — a reaction, not a chat message, so it adds no noise.
      // Best-effort: reactions are unavailable in some chat types.
      ctx.react('👀').catch(() => {
        /* reaction unsupported / rate-limited — ignore, the row is what matters */
      });
    }
  } catch (err) {
    // The input-log is a safety net — it must never break the pipeline.
    console.error('[InputLog] middleware error (non-fatal):', err);
  }

  try {
    await next();
  } finally {
    // Codex BLOCKER 2: catch-all finalizer. The agent paths (text / voice)
    // explicitly set done/dropped/error — for those this is a no-op. For
    // non-agent inputs (audio / photo / document) and early-return text/voice
    // paths, completing the handler chain IS the "done" signal — without this
    // the row would stay 'received' forever and the /health pending count
    // would drift up. Only finalizes rows still in an open state.
    finalizeIfOpen(recordedRowId);
  }
}
