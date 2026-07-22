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

const NEXUS_MEMORY_DB =
  process.env.NEXUS_MEMORY_DB_PATH ||
  '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db';

let db: Database.Database | null = null;
let initialized = false;

export interface VoiceRecallSchemaHealth {
  status: 'not_run' | 'ok' | 'error';
  checkedAt: string | null;
  error: string | null;
}

let voiceRecallSchemaHealth: VoiceRecallSchemaHealth = {
  status: 'not_run',
  checkedAt: null,
  error: null,
};

function getDb(): Database.Database | null {
  if (db) return db;
  try {
    db = new Database(NEXUS_MEMORY_DB, { readonly: false });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch (err) {
    console.error('[Captures] Failed to open DB:', err);
    return null;
  }
}

export function initCapturesSchema(): void {
  if (initialized) return;
  const conn = getDb();
  if (!conn) throw new Error(`cannot open NEXUS memory DB: ${NEXUS_MEMORY_DB}`);
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

/**
 * Idempotent boot migration for the trigger-backed voice recall contract.
 * It deliberately records failure instead of throwing out of boot so /health
 * remains reachable and reports the schema error loudly.
 */
export function ensureVoiceRecallSchema(): VoiceRecallSchemaHealth {
  const checkedAt = new Date().toISOString();
  try {
    initCapturesSchema();
    const conn = getDb();
    if (!conn) throw new Error(`cannot open NEXUS memory DB: ${NEXUS_MEMORY_DB}`);

    const memoryColumns = conn.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    const names = new Set(memoryColumns.map((column) => column.name));
    for (const required of ['id', 'content', 'tags', 'project']) {
      if (!names.has(required)) throw new Error(`memories schema missing required column: ${required}`);
    }

    const requiredObjects = ['memories_fts', 'memories_ai', 'memories_ad', 'memories_au'];
    const existingObjects = new Set(
      (conn.prepare(`SELECT name FROM sqlite_master WHERE name IN (?,?,?,?)`).all(
        ...requiredObjects,
      ) as Array<{ name: string }>).map((row) => row.name),
    );
    const schemaWasComplete = requiredObjects.every((name) => existingObjects.has(name));

    conn.transaction(() => {
      conn.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content, tags, project, content=memories, content_rowid=id,
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, tags, project)
          VALUES (new.id, new.content, new.tags, new.project);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, project)
          VALUES ('delete', old.id, old.content, old.tags, old.project);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories
        WHEN old.content IS NOT new.content OR old.tags IS NOT new.tags OR old.project IS NOT new.project
        BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, project)
          VALUES ('delete', old.id, old.content, old.tags, old.project);
          INSERT INTO memories_fts(rowid, content, tags, project)
          VALUES (new.id, new.content, new.tags, new.project);
        END;
      `);

      const ftsColumns = new Set(
        (conn.prepare('PRAGMA table_info(memories_fts)').all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      for (const required of ['content', 'tags', 'project']) {
        if (!ftsColumns.has(required)) throw new Error(`memories_fts schema missing required column: ${required}`);
      }

      const memoryCount = (conn.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
      const ftsCount = (conn.prepare('SELECT COUNT(*) AS n FROM memories_fts').get() as { n: number }).n;
      // An external-content FTS table can report the content-table row count
      // even before its index is populated. Rebuild whenever any schema object
      // had to be created, as well as on an observable count mismatch.
      if (!schemaWasComplete || memoryCount !== ftsCount) {
        conn.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run();
      }
    })();

    voiceRecallSchemaHealth = { status: 'ok', checkedAt, error: null };
    console.log('[VoiceRecall] FTS schema migration verified');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    voiceRecallSchemaHealth = { status: 'error', checkedAt, error: message.slice(0, 240) };
    console.error('[VoiceRecall] FTS schema migration FAILED:', message);
  }
  return { ...voiceRecallSchemaHealth };
}

export function getVoiceRecallSchemaHealth(): VoiceRecallSchemaHealth {
  return { ...voiceRecallSchemaHealth };
}

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

export function insertCapture(row: CaptureInsert): number | null {
  const conn = getDb();
  if (!conn) return null;
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE constraint failed')) {
      // Duplicate update from Telegram retry — silently ignore
      return null;
    }
    console.error('[Captures] Insert error:', err);
    return null;
  }
}

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
  memory_id: number | null;
  privacy: string;
  created_at: string;
}

export function getCaptureById(id: number): CaptureRow | null {
  const conn = getDb();
  if (!conn) return null;
  try {
    const row = conn
      .prepare(
        `SELECT id, chat_id, message_id, bot_id, capture_type, platform, source_url,
                raw_text, status, transcript, summary, tags, memory_id, privacy, created_at
         FROM captures WHERE id = ?`,
      )
      .get(id) as CaptureRow | undefined;
    return row ?? null;
  } catch (err) {
    console.error('[Captures] getById error:', err);
    return null;
  }
}

export function getCaptureByMessage(
  chatId: string,
  messageId: number,
  botId: string,
): CaptureRow | null {
  const conn = getDb();
  if (!conn) return null;
  try {
    const row = conn
      .prepare(
        `SELECT id, chat_id, message_id, bot_id, capture_type, platform, source_url,
                raw_text, status, transcript, summary, tags, memory_id, privacy, created_at
         FROM captures WHERE chat_id = ? AND message_id = ? AND bot_id = ?`,
      )
      .get(chatId, messageId, botId) as CaptureRow | undefined;
    return row ?? null;
  } catch (err) {
    console.error('[Captures] getByMessage error:', err);
    return null;
  }
}

export function recentCapturesForChat(chatId: string, limit = 10): CaptureRow[] {
  const conn = getDb();
  if (!conn) return [];
  try {
    return conn
      .prepare(
        `SELECT id, chat_id, message_id, bot_id, capture_type, platform, source_url,
                raw_text, status, transcript, summary, tags, memory_id, privacy, created_at
         FROM captures WHERE chat_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(chatId, limit) as CaptureRow[];
  } catch (err) {
    console.error('[Captures] recent error:', err);
    return [];
  }
}

export function appendTags(id: number, newTags: string): boolean {
  const conn = getDb();
  if (!conn) return false;
  try {
    const row = conn
      .prepare('SELECT tags FROM captures WHERE id = ?')
      .get(id) as { tags: string | null } | undefined;
    if (!row) return false;
    const merged = row.tags ? `${row.tags},${newTags}` : newTags;
    conn.prepare('UPDATE captures SET tags = ? WHERE id = ?').run(merged, id);
    return true;
  } catch (err) {
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
export function markCaptureReplied(
  chatId: string,
  messageId: number,
  botIdValue: string,
): void {
  const conn = getDb();
  if (!conn) return;
  try {
    conn
      .prepare(
        `UPDATE captures
         SET status = CASE WHEN status='queued' THEN 'processed' ELSE status END,
             tags = COALESCE(tags || ',', '') || 'replied',
             processed_at = COALESCE(processed_at, strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
         WHERE chat_id = ? AND message_id = ? AND bot_id = ?
           AND (tags IS NULL OR tags NOT LIKE '%replied%')`,
      )
      .run(chatId, messageId, botIdValue);
  } catch (err) {
    console.error('[Captures] markReplied error:', err);
  }
}

/**
 * Mark a capture as "the agent watchdog killed this query before reply".
 * Used by recovery to know which captures the user actually missed.
 */
export function markCaptureWatchdogTimeout(
  chatId: string,
  messageId: number,
  botIdValue: string,
): void {
  const conn = getDb();
  if (!conn) return;
  try {
    conn
      .prepare(
        `UPDATE captures
         SET status = 'failed',
             last_error = 'agent_watchdog_timeout',
             tags = COALESCE(tags || ',', '') || 'watchdog_timeout'
         WHERE chat_id = ? AND message_id = ? AND bot_id = ?
           AND (tags IS NULL OR tags NOT LIKE '%watchdog_timeout%')`,
      )
      .run(chatId, messageId, botIdValue);
  } catch (err) {
    console.error('[Captures] markWatchdogTimeout error:', err);
  }
}

export function updateCaptureProcessed(
  id: number,
  fields: {
    transcript?: string | null;
    summary?: string | null;
    category?: string | null;
    status?: 'processed' | 'failed';
    last_error?: string | null;
  },
): boolean {
  const conn = getDb();
  if (!conn) return false;
  try {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
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
    if (!sets.length) return false;
    conn
      .prepare(`UPDATE captures SET ${sets.join(', ')} WHERE id = @id`)
      .run(params);
    return true;
  } catch (err) {
    console.error('[Captures] updateProcessed error:', err);
    return false;
  }
}

/**
 * RI-28 postcondition: a successfully transcribed voice capture is not
 * "processed" until the same text has a linked row in memories_fts.
 *
 * The insert + FTS verification + captures.memory_id link run in one SQLite
 * transaction. Replays are idempotent: an existing memory_id is returned and
 * no second memory row is created.
 */
export function persistVoiceTranscriptMemory(
  chatId: string,
  messageId: number,
  botIdValue: string,
  transcript: string,
  privacy: 'public' | 'private' = 'public',
): number | null {
  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) return null;
  const conn = getDb();
  if (!conn) return null;

  try {
    const persist = conn.transaction((): number | null => {
      // bed37b5 assumed captureRouter had already created this row. The router
      // is not in the current middleware stack, so materialize the minimal
      // voice capture here in the same transaction. This keeps the contract
      // independent of optional capture enrichment and remains idempotent.
      conn.prepare(`INSERT INTO captures
        (chat_id,message_id,bot_id,capture_type,status,transcript,tags,privacy)
        VALUES (?,?,?,'voice','queued',?,'voice',?)
        ON CONFLICT(chat_id,message_id,bot_id) DO NOTHING`).run(
        chatId, messageId, botIdValue, cleanTranscript, privacy,
      );
      const capture = conn
        .prepare(
          `SELECT id, capture_type, tags, privacy, memory_id
           FROM captures
           WHERE chat_id = ? AND message_id = ? AND bot_id = ?`,
        )
        .get(chatId, messageId, botIdValue) as {
          id: number;
          capture_type: string;
          tags: string | null;
          privacy: 'public' | 'private';
          memory_id: number | null;
        } | undefined;

      if (!capture) return null;
      if (!['voice', 'audio', 'video_note'].includes(capture.capture_type)) return null;
      if (capture.memory_id !== null) return capture.memory_id;

      const memoryColumns = conn
        .prepare('PRAGMA table_info(memories)')
        .all() as Array<{ name: string }>;
      const names = new Set(memoryColumns.map((column) => column.name));
      if (!names.has('content') || !names.has('project')) {
        throw new Error('memories schema unavailable');
      }

      const columns = ['type', 'content', 'source', 'project', 'tags', 'decay_rate'];
      const values: unknown[] = [
        'episodic',
        cleanTranscript,
        // Keep the established trusted source slug; voice provenance lives in
        // tags. A new untrusted source='voice_inbox' would make private voice
        // rows invisible even to the master self_private scope.
        'nexusgram',
        chatId,
        ['voice_inbox', `capture:${capture.id}`, capture.tags]
          .filter(Boolean)
          .join(','),
        0.02,
      ];
      if (names.has('privacy')) {
        columns.push('privacy');
        values.push(capture.privacy);
      }
      if (names.has('bot')) {
        columns.push('bot');
        values.push(botIdValue);
      }

      const placeholders = columns.map(() => '?').join(',');
      const result = conn
        .prepare(`INSERT INTO memories (${columns.join(',')}) VALUES (${placeholders})`)
        .run(...values);
      const memoryId = Number(result.lastInsertRowid);

      // The trigger-backed FTS row is the actual RI-28 contract, not merely a
      // memories insert. Roll back if the index postcondition is not true.
      const ftsRow = conn
        .prepare('SELECT rowid FROM memories_fts WHERE rowid = ?')
        .get(memoryId) as { rowid: number } | undefined;
      if (!ftsRow) throw new Error(`memory ${memoryId} missing from memories_fts`);

      conn.prepare(
        `UPDATE captures
         SET transcript = ?, summary = ?, status = 'processed',
             processed_at = COALESCE(processed_at, strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
             memory_id = ?
         WHERE id = ? AND memory_id IS NULL`,
      ).run(cleanTranscript, cleanTranscript.slice(0, 200), memoryId, capture.id);
      return memoryId;
    });

    return persist();
  } catch (err) {
    console.error(
      '[Captures] voice FTS persistence failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
