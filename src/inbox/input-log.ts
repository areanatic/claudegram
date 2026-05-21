/**
 * Durable Input-Log — Schlachtplan Akt 1.2 (2026-05-21).
 *
 * Every Telegram input (text / voice / photo / document / audio) is written to
 * SQLite the moment it arrives — BEFORE transcription, BEFORE the agent call,
 * BEFORE per-chat serialization. This is the single hard invariant against
 * RI-19 (Input-Loss): if a watchdog timeout or crash kills the in-flight turn,
 * the input row survives on disk and can be inspected later.
 *
 * Flow:
 *   Telegram update -> input_log INSERT (status='received') -> ACK reaction
 *     -> sequentialize -> handler -> markProcessing -> markDone / markDropped
 *
 * Design notes:
 *  - Own DB file (`<DATA_DIR>/input-log.db`) — intentionally isolated from
 *    `.nexus-memory/memory.db` so a forensic log can never corrupt the memory
 *    store and vice versa.
 *  - Fail-safe: every function swallows DB errors and logs. The input-log must
 *    never be able to crash a message handler — it is a safety net, not a
 *    feature gate.
 *  - No new subsystem: ~120 LOC, one table, no cron, no command (Akt 1 scope).
 *
 * Cross-Refs:
 *  - shared-memory/nexus/bug_report_lost_inputs_2026-05-21.md (RC-1/2/3 spec)
 *  - shared-memory/nexus/postmortem_mai_intervention_2026-05-21.md (Akt 1.2)
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config.js';

export type InputType = 'text' | 'voice' | 'audio' | 'photo' | 'document' | 'other';
export type InputStatus = 'received' | 'processing' | 'done' | 'dropped' | 'error';

let db: Database.Database | null = null;
let initFailed = false;

/**
 * Lazily open (and migrate) the input-log DB. Returns null if the DB cannot be
 * opened — callers treat that as "logging disabled" and continue normally.
 */
function getDb(): Database.Database | null {
  if (db) return db;
  if (initFailed) return null;
  try {
    const dir = config.DATA_DIR;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dbPath = path.join(dir, 'input-log.db');
    const conn = new Database(dbPath);
    conn.pragma('journal_mode = WAL');
    conn.pragma('busy_timeout = 5000');
    conn.exec(`
      CREATE TABLE IF NOT EXISTS input_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at TEXT NOT NULL,
        message_id INTEGER,
        chat_id INTEGER NOT NULL,
        session_key TEXT NOT NULL,
        input_type TEXT NOT NULL,
        raw_content TEXT,
        file_id TEXT,
        status TEXT NOT NULL DEFAULT 'received',
        dropped_reason TEXT,
        processed_at TEXT,
        response_sent_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_input_log_chat ON input_log(chat_id);
      CREATE INDEX IF NOT EXISTS idx_input_log_status ON input_log(status);
    `);

    // Codex re-review HIGH: migrate a pre-existing table. `CREATE TABLE IF NOT
    // EXISTS` does NOT add new columns to an older table — without this an
    // older `input_log` (e.g. from a round-1 build) would be missing
    // `updated_at`, every INSERT would throw, and the durable-input invariant
    // would be silently lost. Add the column if absent before any write.
    const cols = (conn.prepare('PRAGMA table_info(input_log)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (!cols.includes('updated_at')) {
      console.log('[InputLog] migrating: adding column updated_at');
      conn.exec('ALTER TABLE input_log ADD COLUMN updated_at TEXT');
    }

    // Idempotent INSERT needs a unique key. Build the index AFTER the table is
    // guaranteed to have the right columns. If a pre-existing table already
    // contains duplicate (chat_id, message_id) rows the CREATE UNIQUE INDEX
    // would fail — collapse duplicates first (keep the lowest id).
    const dupCheck = conn
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT chat_id, message_id FROM input_log
           WHERE message_id IS NOT NULL
           GROUP BY chat_id, message_id HAVING COUNT(*) > 1
         )`,
      )
      .get() as { n: number };
    if (dupCheck.n > 0) {
      console.warn(`[InputLog] migrating: removing ${dupCheck.n} duplicate (chat_id,message_id) group(s)`);
      conn.exec(`
        DELETE FROM input_log
        WHERE id NOT IN (
          SELECT MIN(id) FROM input_log GROUP BY chat_id, message_id
        );
      `);
    }
    // Codex BLOCKER 2: idempotent INSERT. Telegram retries the same update;
    // without a uniqueness guard each retry created a duplicate row of which
    // only one ever got finalized. (chat_id, message_id) is the natural key.
    conn.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_input_log_msg ON input_log(chat_id, message_id)',
    );

    db = conn;
    return db;
  } catch (err) {
    initFailed = true;
    console.error('[InputLog] Failed to open DB — input logging disabled:', err);
    return null;
  }
}

export interface RecordInputOptions {
  messageId: number | undefined;
  chatId: number;
  sessionKey: string;
  inputType: InputType;
  /** Text content if known at receive-time (text messages). Voice transcript is filled later. */
  rawContent?: string | null;
  /** Telegram file_id for media inputs. */
  fileId?: string | null;
}

/**
 * INSERT a freshly received input. Called as the very first action in the
 * input-log middleware, before any handler runs. Returns the row id (for later
 * status updates) or null if logging is unavailable.
 *
 * Codex BLOCKER 2: idempotent. A Telegram retry of the same (chat_id,
 * message_id) does NOT create a duplicate row — `ON CONFLICT DO NOTHING` keeps
 * the original, and the existing row id is looked up and returned.
 */
export function recordInput(opts: RecordInputOptions): number | null {
  const conn = getDb();
  if (!conn) return null;
  try {
    const now = new Date().toISOString();
    const stmt = conn.prepare(`
      INSERT INTO input_log
        (received_at, message_id, chat_id, session_key, input_type, raw_content, file_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?)
      ON CONFLICT(chat_id, message_id) DO NOTHING
    `);
    const info = stmt.run(
      now,
      opts.messageId ?? null,
      opts.chatId,
      opts.sessionKey,
      opts.inputType,
      opts.rawContent ?? null,
      opts.fileId ?? null,
      now,
    );
    if (info.changes > 0) {
      return Number(info.lastInsertRowid);
    }
    // Conflict — a row for this (chat_id, message_id) already exists. Reuse it.
    const existing = conn
      .prepare('SELECT id FROM input_log WHERE chat_id = ? AND message_id = ?')
      .get(opts.chatId, opts.messageId ?? null) as { id: number } | undefined;
    return existing ? existing.id : null;
  } catch (err) {
    console.error('[InputLog] recordInput failed:', err);
    return null;
  }
}

/** Transition a row to status='processing'. Best-effort. */
export function markProcessing(rowId: number | null): void {
  updateStatus(rowId, 'processing', { processed_at: new Date().toISOString() });
}

/** Transition a row to status='done' and stamp response_sent_at. Best-effort. */
export function markDone(rowId: number | null): void {
  updateStatus(rowId, 'done', { response_sent_at: new Date().toISOString() });
}

/**
 * Transition a row to status='dropped' with a reason (e.g. 'watchdog_cancel',
 * 'queue_cleared', 'error'). Best-effort.
 */
export function markDropped(rowId: number | null, reason: string): void {
  updateStatus(rowId, 'dropped', { dropped_reason: reason });
}

/** Transition a row to status='error'. Best-effort. */
export function markError(rowId: number | null, reason: string): void {
  updateStatus(rowId, 'error', { dropped_reason: reason });
}

/** Fill in / overwrite the raw_content (used to attach the voice transcript). */
export function attachContent(rowId: number | null, content: string): void {
  const conn = getDb();
  if (!conn || rowId == null) return;
  try {
    conn.prepare('UPDATE input_log SET raw_content = ? WHERE id = ?').run(content, rowId);
  } catch (err) {
    console.error('[InputLog] attachContent failed:', err);
  }
}

function updateStatus(
  rowId: number | null,
  status: InputStatus,
  extra: { processed_at?: string; response_sent_at?: string; dropped_reason?: string } = {},
): void {
  const conn = getDb();
  if (!conn || rowId == null) return;
  try {
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const values: unknown[] = [status, new Date().toISOString()];
    if (extra.processed_at !== undefined) {
      sets.push('processed_at = ?');
      values.push(extra.processed_at);
    }
    if (extra.response_sent_at !== undefined) {
      sets.push('response_sent_at = ?');
      values.push(extra.response_sent_at);
    }
    if (extra.dropped_reason !== undefined) {
      sets.push('dropped_reason = ?');
      values.push(extra.dropped_reason);
    }
    values.push(rowId);
    conn.prepare(`UPDATE input_log SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  } catch (err) {
    console.error('[InputLog] updateStatus failed:', err);
  }
}

/**
 * Codex BLOCKER 2: catch-all finalizer. Marks a row as 'done' ONLY if it is
 * still open ('received' or 'processing'). Called by the input-log middleware
 * after the whole handler chain returns — so non-agent inputs (audio / photo /
 * document) and early-return text/voice paths, which the agent handlers never
 * explicitly finalize, do not leave permanently-'received' rows that would
 * make `/health` pending count drift upward forever.
 *
 * Agent paths that already called markDone/markDropped/markError are no-ops
 * here (status is no longer open). Idempotent.
 */
export function finalizeIfOpen(rowId: number | null): void {
  const conn = getDb();
  if (!conn || rowId == null) return;
  try {
    conn
      .prepare(
        `UPDATE input_log SET status = 'done', updated_at = ?
         WHERE id = ? AND status IN ('received', 'processing')`,
      )
      .run(new Date().toISOString(), rowId);
  } catch (err) {
    console.error('[InputLog] finalizeIfOpen failed:', err);
  }
}

/** Count rows still in 'received' or 'processing' — used by /health. */
export function countPending(): number {
  const conn = getDb();
  if (!conn) return -1;
  try {
    const row = conn
      .prepare("SELECT COUNT(*) AS n FROM input_log WHERE status IN ('received', 'processing')")
      .get() as { n: number };
    return row.n;
  } catch (err) {
    console.error('[InputLog] countPending failed:', err);
    return -1;
  }
}

/**
 * Boot-recovery (Akt 1c): on startup every row still 'received'/'processing'
 * is necessarily orphaned — the only processor is this bot, which just started
 * fresh with no in-memory handler for those rows. Mark them 'dropped' with
 * reason 'startup_recovery' so they are visible and the /health pending count
 * does not drift upward forever. MUST run before the runner starts polling, so
 * freshly-arriving inputs are never affected.
 *
 * Returns the number of rows recovered (0 if none, -1 if logging unavailable).
 */
export function recoverOrphanedInputs(): number {
  const conn = getDb();
  if (!conn) return -1;
  try {
    const cutoff = new Date().toISOString();
    const info = conn
      .prepare(
        `UPDATE input_log
            SET status = 'dropped', dropped_reason = 'startup_recovery', updated_at = ?
          WHERE status IN ('received', 'processing') AND received_at <= ?`,
      )
      .run(cutoff, cutoff);
    if (info.changes > 0) {
      console.log(
        `[InputLog] boot-recovery: marked ${info.changes} orphaned input(s) dropped (startup_recovery)`,
      );
    }
    return info.changes;
  } catch (err) {
    console.error('[InputLog] recoverOrphanedInputs failed:', err);
    return -1;
  }
}

/** Close the DB on shutdown. Idempotent. */
export function closeInputLog(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}
