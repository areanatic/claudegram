/**
 * Document Handler — Receives files from Telegram and saves to NEXUS INBOX.
 *
 * Handles: PDFs, Word docs, spreadsheets, archives, text files, and any
 * other document type sent via Telegram (non-image documents).
 * Images sent as documents are forwarded to the existing photo handler.
 *
 * Flow:
 *   1. User sends document in Telegram
 *   2. Validate: size, MIME type, not stale/duplicate
 *   3. Download original file from Telegram API
 *   4. Save to NEXUS INBOX with metadata sidecar
 *   5. Notify user with confirmation
 *   6. Optionally feed context to agent for routing suggestions
 */
import { Context } from 'grammy';
/**
 * Handle non-image documents sent to the bot.
 * Downloads to INBOX and creates metadata sidecar.
 */
export declare function handleDocument(ctx: Context): Promise<void>;
/** Clear all pending batch timers — called during graceful shutdown. */
export declare function clearAllBatchTimers(): void;
//# sourceMappingURL=document.handler.d.ts.map