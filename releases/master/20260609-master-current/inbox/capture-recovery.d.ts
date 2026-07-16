/**
 * Universal Telegram Capture — Recovery
 *
 * "Chronik ist heilig" (User, 2026-05-06).
 *
 * On bot start:
 *   1. Find all `captures` rows that are still `status='queued'` and were
 *      created since the last bot restart (or last 24h, whichever is shorter).
 *   2. For voice/audio types: run Whisper on the telegram_file_id, store
 *      transcript in DB, mark `status='processed' + tags+=',recovered'`.
 *   3. Send a "📥 Nachgeholt" message back to the chat so the user sees what
 *      was missed during the downtime.
 *
 * Runs in the background after `bot.start()` so it never blocks startup.
 */
import { type Bot } from 'grammy';
/**
 * Run recovery for all chats. Each capture is attempted in sequence to keep
 * Whisper/Telegram rate-limit pressure low.
 *
 * Public entry point — call once after bot.start() in a fire-and-forget manner.
 */
export declare function runCaptureRecovery(bot: Bot): Promise<void>;
//# sourceMappingURL=capture-recovery.d.ts.map