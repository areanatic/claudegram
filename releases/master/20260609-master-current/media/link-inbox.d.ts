/**
 * Lightweight Link-Inbox
 *
 * When a user sends a solo YouTube / TikTok / Instagram URL the bot
 * automatically:
 *   1. Acknowledges immediately
 *   2. Extracts a text transcript (no video download)
 *   3. Categorises by keyword matching (no extra API call)
 *   4. Saves to L2 SQLite memory for later retrieval
 *   5. Replies with a short summary + category tag
 *
 * "Cortex aus" by default — no deep analysis unless the user explicitly
 * flags a link as important.
 */
import { type Context } from 'grammy';
/**
 * Returns the URL if `text` is a single supported media URL, otherwise null.
 * Solo = no extra words around the URL.
 */
export declare function detectInboxUrl(text: string): string | null;
/**
 * Main entry point: transcribe → categorise → save → reply with summary.
 * Non-blocking ack sent first; result edits the ack message.
 */
export declare function processLinkInbox(ctx: Context, url: string, sessionKey: string): Promise<void>;
//# sourceMappingURL=link-inbox.d.ts.map