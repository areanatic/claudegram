/**
 * Universal Telegram Capture — DB Layer
 *
 * Concept: shared-memory/nexus/concept_universal_telegram_capture_2026-05-04.md (v3 LEAN)
 *
 * Phase-1-Scope: only insert metadata sub-ms. NO file download, NO transcript,
 * NO categorisation. Worker (Phase 2) and "wichtig"-trigger (Phase 3) handle
 * the heavy lifting on demand.
 */
export declare function initCapturesSchema(): void;
export interface CaptureInsert {
    chat_id: string;
    message_id: number;
    bot_id: string;
    user_id?: string | null;
    message_thread_id?: number | null;
    update_id?: number | null;
    media_group_id?: string | null;
    capture_type: string;
    platform?: string | null;
    source_url?: string | null;
    raw_text?: string | null;
    raw_meta_json?: string | null;
    telegram_file_id?: string | null;
    telegram_file_unique_id?: string | null;
    mime_type?: string | null;
    file_size?: number | null;
    original_filename?: string | null;
    tags?: string | null;
    privacy?: 'public' | 'private';
    status?: 'queued' | 'processed' | 'skipped';
    transcript?: string | null;
    file_path?: string | null;
}
export declare function insertCapture(row: CaptureInsert): number | null;
export interface CaptureRow {
    id: number;
    chat_id: string;
    message_id: number;
    bot_id: string;
    capture_type: string;
    platform: string | null;
    source_url: string | null;
    raw_text: string | null;
    status: string;
    transcript: string | null;
    summary: string | null;
    tags: string | null;
    privacy: string;
    created_at: string;
}
export declare function getCaptureById(id: number): CaptureRow | null;
export declare function getCaptureByMessage(chatId: string, messageId: number, botId: string): CaptureRow | null;
export declare function recentCapturesForChat(chatId: string, limit?: number): CaptureRow[];
export declare function appendTags(id: number, newTags: string): boolean;
/**
 * Mark a capture as "the user got a normal bot reply" — used by voice/audio
 * handlers to signal that recovery does NOT need to deliver this capture again
 * after a restart.
 *
 * Idempotent: looks up the capture by (chat_id, message_id, bot_id), no-op if
 * not found (capture-router might not have inserted it for some edge case).
 */
export declare function markCaptureReplied(chatId: string, messageId: number, botIdValue: string): void;
/**
 * Mark a capture as "the agent watchdog killed this query before reply".
 * Used by recovery to know which captures the user actually missed.
 */
export declare function markCaptureWatchdogTimeout(chatId: string, messageId: number, botIdValue: string): void;
export declare function updateCaptureProcessed(id: number, fields: {
    transcript?: string | null;
    summary?: string | null;
    category?: string | null;
    status?: 'processed' | 'failed';
    last_error?: string | null;
}): boolean;
//# sourceMappingURL=captures-db.d.ts.map