/**
 * Universal Telegram Capture — DB Layer
 *
 * Concept: shared-memory/nexus/concept_universal_telegram_capture_2026-05-04.md (v3 LEAN)
 *
 * Phase-1-Scope: only insert metadata sub-ms. NO file download, NO transcript,
 * NO categorisation. Worker (Phase 2) and "wichtig"-trigger (Phase 3) handle
 * the heavy lifting on demand.
 */
import Database from 'better-sqlite3';
const NEXUS_MEMORY_DB = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db';
let db = null;
let initialized = false;
function getDb() {
    if (db)
        return db;
    try {
        db = new Database(NEXUS_MEMORY_DB, { readonly: false });
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');
        return db;
    }
    catch (err) {
        console.error('[Captures] Failed to open DB:', err);
        return null;
    }
}
export function initCapturesSchema() {
    if (initialized)
        return;
    const conn = getDb();
    if (!conn)
        return;
    try {
        conn.exec(`
      CREATE TABLE IF NOT EXISTS captures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        bot_id TEXT NOT NULL,
        user_id TEXT,
        message_thread_id INTEGER,
        update_id INTEGER,
        media_group_id TEXT,

        capture_type TEXT NOT NULL CHECK(capture_type IN
          ('url','photo','voice','video','video_note','document','audio','sticker','text','forward','animation')),
        platform TEXT,
        source_url TEXT,

        raw_text TEXT,
        raw_meta_json TEXT,
        telegram_file_id TEXT,
        telegram_file_unique_id TEXT,
        mime_type TEXT,
        file_size INTEGER,
        original_filename TEXT,
        file_path TEXT,

        status TEXT NOT NULL DEFAULT 'queued'
          CHECK(status IN ('queued','processing','processed','failed','skipped')),
        claimed_by TEXT,
        claimed_at TEXT,
        processing_attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        retry_after TEXT,
        processed_at TEXT,
        analyzed_at TEXT,

        transcript TEXT,
        summary TEXT,
        category TEXT,
        tags TEXT,

        memory_id INTEGER,
        privacy TEXT NOT NULL DEFAULT 'public'
          CHECK(privacy IN ('public','private')),

        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),

        UNIQUE(chat_id, message_id, bot_id)
      );

      CREATE INDEX IF NOT EXISTS idx_captures_queue
        ON captures(status, retry_after, created_at)
        WHERE status IN ('queued','failed');

      CREATE INDEX IF NOT EXISTS idx_captures_chat
        ON captures(chat_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_captures_type_plat
        ON captures(capture_type, platform);

      CREATE INDEX IF NOT EXISTS idx_captures_public_processed
        ON captures(status, privacy, analyzed_at)
        WHERE status='processed' AND privacy='public';
    `);
        initialized = true;
        console.log('[Captures] Schema initialized');
    }
    catch (err) {
        console.error('[Captures] Schema init failed:', err);
    }
}
export function insertCapture(row) {
    const conn = getDb();
    if (!conn)
        return null;
    try {
        const stmt = conn.prepare(`
      INSERT INTO captures (
        chat_id, message_id, bot_id, user_id, message_thread_id, update_id, media_group_id,
        capture_type, platform, source_url,
        raw_text, raw_meta_json, telegram_file_id, telegram_file_unique_id,
        mime_type, file_size, original_filename, file_path,
        status, transcript, tags, privacy
      ) VALUES (
        @chat_id, @message_id, @bot_id, @user_id, @message_thread_id, @update_id, @media_group_id,
        @capture_type, @platform, @source_url,
        @raw_text, @raw_meta_json, @telegram_file_id, @telegram_file_unique_id,
        @mime_type, @file_size, @original_filename, @file_path,
        @status, @transcript, @tags, @privacy
      )
    `);
        const result = stmt.run({
            chat_id: row.chat_id,
            message_id: row.message_id,
            bot_id: row.bot_id,
            user_id: row.user_id ?? null,
            message_thread_id: row.message_thread_id ?? null,
            update_id: row.update_id ?? null,
            media_group_id: row.media_group_id ?? null,
            capture_type: row.capture_type,
            platform: row.platform ?? null,
            source_url: row.source_url ?? null,
            raw_text: row.raw_text ?? null,
            raw_meta_json: row.raw_meta_json ?? null,
            telegram_file_id: row.telegram_file_id ?? null,
            telegram_file_unique_id: row.telegram_file_unique_id ?? null,
            mime_type: row.mime_type ?? null,
            file_size: row.file_size ?? null,
            original_filename: row.original_filename ?? null,
            file_path: row.file_path ?? null,
            status: row.status ?? 'queued',
            transcript: row.transcript ?? null,
            tags: row.tags ?? null,
            privacy: row.privacy ?? 'public',
        });
        return Number(result.lastInsertRowid);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('UNIQUE constraint failed')) {
            // Duplicate update from Telegram retry — silently ignore
            return null;
        }
        console.error('[Captures] Insert error:', err);
        return null;
    }
}
export function getCaptureById(id) {
    const conn = getDb();
    if (!conn)
        return null;
    try {
        const row = conn
            .prepare(`SELECT id, chat_id, message_id, bot_id, capture_type, platform, source_url,
                raw_text, status, transcript, summary, tags, privacy, created_at
         FROM captures WHERE id = ?`)
            .get(id);
        return row ?? null;
    }
    catch (err) {
        console.error('[Captures] getById error:', err);
        return null;
    }
}
export function getCaptureByMessage(chatId, messageId, botId) {
    const conn = getDb();
    if (!conn)
        return null;
    try {
        const row = conn
            .prepare(`SELECT id, chat_id, message_id, bot_id, capture_type, platform, source_url,
                raw_text, status, transcript, summary, tags, privacy, created_at
         FROM captures WHERE chat_id = ? AND message_id = ? AND bot_id = ?`)
            .get(chatId, messageId, botId);
        return row ?? null;
    }
    catch (err) {
        console.error('[Captures] getByMessage error:', err);
        return null;
    }
}
export function recentCapturesForChat(chatId, limit = 10) {
    const conn = getDb();
    if (!conn)
        return [];
    try {
        return conn
            .prepare(`SELECT id, chat_id, message_id, bot_id, capture_type, platform, source_url,
                raw_text, status, transcript, summary, tags, privacy, created_at
         FROM captures WHERE chat_id = ?
         ORDER BY created_at DESC LIMIT ?`)
            .all(chatId, limit);
    }
    catch (err) {
        console.error('[Captures] recent error:', err);
        return [];
    }
}
export function appendTags(id, newTags) {
    const conn = getDb();
    if (!conn)
        return false;
    try {
        const row = conn
            .prepare('SELECT tags FROM captures WHERE id = ?')
            .get(id);
        if (!row)
            return false;
        const merged = row.tags ? `${row.tags},${newTags}` : newTags;
        conn.prepare('UPDATE captures SET tags = ? WHERE id = ?').run(merged, id);
        return true;
    }
    catch (err) {
        console.error('[Captures] appendTags error:', err);
        return false;
    }
}
/**
 * Mark a capture as "the user got a normal bot reply" — used by voice/audio
 * handlers to signal that recovery does NOT need to deliver this capture again
 * after a restart.
 *
 * Idempotent: looks up the capture by (chat_id, message_id, bot_id), no-op if
 * not found (capture-router might not have inserted it for some edge case).
 */
export function markCaptureReplied(chatId, messageId, botIdValue) {
    const conn = getDb();
    if (!conn)
        return;
    try {
        conn
            .prepare(`UPDATE captures
         SET status = CASE WHEN status='queued' THEN 'processed' ELSE status END,
             tags = COALESCE(tags || ',', '') || 'replied',
             processed_at = COALESCE(processed_at, strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
         WHERE chat_id = ? AND message_id = ? AND bot_id = ?
           AND (tags IS NULL OR tags NOT LIKE '%replied%')`)
            .run(chatId, messageId, botIdValue);
    }
    catch (err) {
        console.error('[Captures] markReplied error:', err);
    }
}
/**
 * Mark a capture as "the agent watchdog killed this query before reply".
 * Used by recovery to know which captures the user actually missed.
 */
export function markCaptureWatchdogTimeout(chatId, messageId, botIdValue) {
    const conn = getDb();
    if (!conn)
        return;
    try {
        conn
            .prepare(`UPDATE captures
         SET status = 'failed',
             last_error = 'agent_watchdog_timeout',
             tags = COALESCE(tags || ',', '') || 'watchdog_timeout'
         WHERE chat_id = ? AND message_id = ? AND bot_id = ?
           AND (tags IS NULL OR tags NOT LIKE '%watchdog_timeout%')`)
            .run(chatId, messageId, botIdValue);
    }
    catch (err) {
        console.error('[Captures] markWatchdogTimeout error:', err);
    }
}
export function updateCaptureProcessed(id, fields) {
    const conn = getDb();
    if (!conn)
        return false;
    try {
        const sets = [];
        const params = { id };
        if (fields.transcript !== undefined) {
            sets.push('transcript = @transcript');
            params.transcript = fields.transcript;
        }
        if (fields.summary !== undefined) {
            sets.push('summary = @summary');
            params.summary = fields.summary;
        }
        if (fields.category !== undefined) {
            sets.push('category = @category');
            params.category = fields.category;
        }
        if (fields.status) {
            sets.push('status = @status');
            params.status = fields.status;
            if (fields.status === 'processed') {
                sets.push("processed_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')");
            }
        }
        if (fields.last_error !== undefined) {
            sets.push('last_error = @last_error');
            params.last_error = fields.last_error;
        }
        if (!sets.length)
            return false;
        conn
            .prepare(`UPDATE captures SET ${sets.join(', ')} WHERE id = @id`)
            .run(params);
        return true;
    }
    catch (err) {
        console.error('[Captures] updateProcessed error:', err);
        return false;
    }
}
//# sourceMappingURL=captures-db.js.map