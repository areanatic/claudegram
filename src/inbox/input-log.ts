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
import { isPrivate as isSessionPrivate } from '../memory/privacy-state.js';

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
        updated_at TEXT,
        resume_attempts INTEGER NOT NULL DEFAULT 0,
        side_effect_tool_started_at TEXT,
        tool_execution_names TEXT
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

    // FIX 6+ Stage 2c (2026-05-25): privacy column with default 'public'.
    //
    // Stage 2b shipped this column with default 'private' (fail-CLOSED at the
    // DB level). Codex Pattern-B Re-Review (conf 0.66 — RESTART-BLOCK) showed
    // the resulting Public-Search blindness: searchInputLog correctly filters
    // privacy='public', but the writer (recordInput) never set privacy, so the
    // DEFAULT 'private' applied to BOTH historical 109 rows AND every new
    // row. Net effect: MCP `nexusgram_input_log_search` (which never sets
    // includePrivate) returned 0 hits even for the killer-test row 87.
    //
    // Stage 2c flips the default to 'public' and pairs it with two writer-side
    // guarantees below:
    //   (1) recordInput() now ALWAYS sets privacy explicitly — either from the
    //       sessionKey's privacy-state cache (`/private on` → 'private') or
    //       from an explicit caller override.
    //   (2) The migration backfills any pre-existing rows that were captured
    //       under the Stage 2b 'private'-default to 'public' (one-shot
    //       UPDATE), so the killer-test row 87 becomes searchable again.
    //
    // Rationale for default='public': the user is writing to their own bot in
    // their own chat. The expectation is "bot may use this". Privacy is an
    // explicit opt-in via the existing `/private on` command (see
    // src/memory/privacy-state.ts), and the writer honours that state below.
    if (!cols.includes('privacy')) {
      console.log('[InputLog] migrating: adding column privacy (default public)');
      conn.exec(`ALTER TABLE input_log ADD COLUMN privacy TEXT NOT NULL DEFAULT 'public'`);
    }

    // INV-01 Auto-Resume (2026-06-01): columns that gate resumable-orphan replay.
    //   resume_attempts            — crash-loop / poison guard. Incremented in
    //                                the SAME transaction that claims a row for
    //                                replay (claimResumableOrphans), so the
    //                                counter is on disk BEFORE the agent runs and
    //                                survives an immediate re-crash. Caps total
    //                                replays of one row across the bot's whole
    //                                lifetime at MAX_RESUME_ATTEMPTS (Teil B §3).
    //   side_effect_tool_started_at — set by the PreToolUse hook BEFORE a
    //                                mutating tool (Bash/Write/Edit/MultiEdit/
    //                                Task) runs. A row with this set is NEVER
    //                                auto-replayed (Codex correction #2): the
    //                                turn may have already performed a
    //                                non-idempotent external write that a blind
    //                                replay would duplicate.
    //   tool_execution_names       — audit: comma-separated mutating tool names.
    // Additive-ALTER (mirrors updated_at / privacy above) so a pre-existing
    // table gains the columns without data loss.
    if (!cols.includes('resume_attempts')) {
      console.log('[InputLog] migrating: adding column resume_attempts (default 0)');
      conn.exec('ALTER TABLE input_log ADD COLUMN resume_attempts INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.includes('side_effect_tool_started_at')) {
      console.log('[InputLog] migrating: adding column side_effect_tool_started_at');
      conn.exec('ALTER TABLE input_log ADD COLUMN side_effect_tool_started_at TEXT');
    }
    if (!cols.includes('tool_execution_names')) {
      console.log('[InputLog] migrating: adding column tool_execution_names');
      conn.exec('ALTER TABLE input_log ADD COLUMN tool_execution_names TEXT');
    }

    // FIX 6+ Stage 2d (2026-05-25): one-time backfill via migration marker.
    //
    // Codex Pattern-B Re-Re-Review (conf 0.62 — RESTART-BLOCK) flagged a
    // hard privacy regression in the Stage 2c backfill: the original UPDATE
    // matched `privacy IS NULL OR privacy='' OR privacy='private'` and ran
    // on EVERY boot. As soon as a user activated `/private on` and sent an
    // input, the writer correctly stored `privacy='private'` — but on the
    // next bot restart the always-on backfill demoted that legitimate
    // private row to `'public'`. Privacy leak across the restart boundary.
    //
    // Stage 2d wraps the backfill in a marker-table guard so it runs
    // EXACTLY ONCE per DB. After the first successful run, future boots
    // skip the UPDATE entirely — `/private on` rows are then immutable.
    //
    // Trade-off: a DB whose Stage 2b traffic genuinely included
    // user-intended private rows cannot be disambiguated from
    // Stage-2b-default-private rows; this one-time backfill assumes the
    // entire pre-Stage-2c population is migration-artefact. On the current
    // Mac-Mini production DB (Stage 2b was never live per Codex report)
    // that is correct. Future deployments with real Stage 2b history must
    // restore from backup before the first Stage 2c+2d boot.
    try {
      conn.exec(`
        CREATE TABLE IF NOT EXISTS input_log_migrations (
          name TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      const migrationName = 'stage_2c_privacy_default_backfill_2026-05-25';
      const alreadyApplied = conn
        .prepare(`SELECT 1 FROM input_log_migrations WHERE name = ?`)
        .get(migrationName);
      if (!alreadyApplied) {
        const stale = conn
          .prepare(
            "SELECT COUNT(*) AS n FROM input_log WHERE privacy IS NULL OR privacy = '' OR privacy = 'private'",
          )
          .get() as { n: number };
        const tx = conn.transaction(() => {
          const result = conn
            .prepare(
              "UPDATE input_log SET privacy = 'public' WHERE privacy IS NULL OR privacy = '' OR privacy = 'private'",
            )
            .run();
          conn.prepare(`INSERT INTO input_log_migrations (name) VALUES (?)`).run(migrationName);
          return result.changes;
        });
        const changes = tx();
        console.log(
          `[InputLog] Stage 2d one-time backfill applied: ${changes} historical row(s) → privacy='public' (stale=${stale.n}, marker '${migrationName}' stored)`,
        );
      } else {
        console.log(
          '[InputLog] Stage 2d backfill already applied — skipping (legitimate /private rows preserved across restart)',
        );
      }
    } catch (backfillErr) {
      // Non-fatal: a failed backfill leaves historical rows invisible to
      // public-mode search but does not corrupt the DB. Log loudly.
      console.error('[InputLog] Stage 2d backfill failed (non-fatal):', backfillErr);
    }

    // FTS5 virtual table (contentless, sync via triggers). Indexes raw_content
    // for full-text search; session_key / chat_id / input_type / status are
    // UNINDEXED columns so they round-trip through MATCH results without being
    // tokenized.
    conn.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS input_log_fts USING fts5(
        raw_content,
        session_key UNINDEXED,
        chat_id UNINDEXED,
        input_type UNINDEXED,
        status UNINDEXED,
        content='input_log',
        content_rowid='id'
      );
    `);

    // Sync triggers — keep FTS in lockstep with input_log. The UPDATE trigger
    // fires only when raw_content or status changes (raw_content because
    // voice transcripts are attached AFTER the initial INSERT; status because
    // operators search "all dropped voice last 24h" patterns).
    conn.exec(`
      CREATE TRIGGER IF NOT EXISTS input_log_ai AFTER INSERT ON input_log BEGIN
        INSERT INTO input_log_fts(rowid, raw_content, session_key, chat_id, input_type, status)
        VALUES (new.id, new.raw_content, new.session_key, new.chat_id, new.input_type, new.status);
      END;
      CREATE TRIGGER IF NOT EXISTS input_log_ad AFTER DELETE ON input_log BEGIN
        INSERT INTO input_log_fts(input_log_fts, rowid, raw_content, session_key, chat_id, input_type, status)
        VALUES ('delete', old.id, old.raw_content, old.session_key, old.chat_id, old.input_type, old.status);
      END;
      CREATE TRIGGER IF NOT EXISTS input_log_au AFTER UPDATE ON input_log
      WHEN old.raw_content IS NOT new.raw_content OR old.status IS NOT new.status
      BEGIN
        INSERT INTO input_log_fts(input_log_fts, rowid, raw_content, session_key, chat_id, input_type, status)
        VALUES ('delete', old.id, old.raw_content, old.session_key, old.chat_id, old.input_type, old.status);
        INSERT INTO input_log_fts(rowid, raw_content, session_key, chat_id, input_type, status)
        VALUES (new.id, new.raw_content, new.session_key, new.chat_id, new.input_type, new.status);
      END;
    `);

    // FIX 6+ Stage 2b (Codex Pattern-B F-01): the previous "is the FTS index
    // empty?" gate used `SELECT COUNT(*) FROM input_log_fts`. For an FTS5
    // external-content table that COUNT returns the size of the *content*
    // table (here: input_log), NOT the size of the inverted MATCH index. On a
    // production DB with 109 pre-existing rows the gate would therefore see
    // `count=109` and SKIP the backfill — every old row would remain
    // unsearchable via MATCH. Codex reproduced this against the live DB and
    // demonstrated `match_before_rebuild=0`.
    //
    // The SQLite-native fix for external-content FTS5 is the documented
    // `'rebuild'` command — it deletes and re-derives the inverted index from
    // the current content table. It is idempotent: safe to call on an empty
    // or already-populated index. At 109 rows this is trivial; if the table
    // grows past ~100k rows in the future this rebuild should be moved behind
    // a one-shot migration flag stored in `sqlite_user_version` / a marker
    // row, but for the current ~hundreds-of-rows scale the always-on rebuild
    // is the simplest correct option and runs once per process boot.
    //
    // Pair the rebuild with `synchronous=NORMAL` (default since WAL anyway,
    // but stated explicitly for documentation) so the bulk rebuild does not
    // pay an `fsync()` per page on machines where pragma defaults drifted.
    conn.pragma('synchronous = NORMAL');
    try {
      conn.exec(`INSERT INTO input_log_fts(input_log_fts) VALUES('rebuild')`);
      console.log('[InputLog] FTS5 rebuild: inverted index regenerated from input_log content');
    } catch (rebuildErr) {
      // Rebuild failure must not poison the whole DB-init. Log loudly so the
      // operator notices, but keep the connection usable — searches will
      // simply return 0 hits, which fails CLOSED (no privacy leak via stale
      // index).
      console.error('[InputLog] FTS5 rebuild failed (search disabled this boot):', rebuildErr);
    }

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
  /**
   * FIX 6+ Stage 2c: explicit privacy classification. When omitted, the
   * writer consults the per-session privacy-state cache (`isPrivate(sessionKey)`)
   * and falls back to 'public'. Callers that have an authoritative answer
   * (e.g. `/brief` — always public; future `/private-once` — explicitly
   * private) should set this field instead of relying on session state.
   */
  privacy?: 'public' | 'private';
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
    // FIX 6+ Stage 2c: privacy is now WRITER-DETERMINED, not DB-default.
    //
    // Resolution order:
    //   1. Explicit `opts.privacy` (callers like /brief that have ground truth).
    //   2. `isSessionPrivate(sessionKey)` — honours `/private on` per session.
    //   3. Default 'public' — matches user expectation ("bot may use this").
    //
    // This is the inverse policy from Stage 2b (DEFAULT 'private', fail-CLOSED
    // at DB level). The fail-CLOSED guarantee is preserved at the READ side
    // (searchInputLog filters privacy='public' unless an in-process caller
    // opts in via includePrivate). At write time, classifying every captured
    // turn as private (Stage 2b) made even the killer-test row 87 invisible
    // to the MCP tool; Stage 2c routes the classification through the
    // existing per-session privacy-state instead.
    let privacy: 'public' | 'private';
    if (opts.privacy === 'private' || opts.privacy === 'public') {
      privacy = opts.privacy;
    } else {
      try {
        privacy = isSessionPrivate(opts.sessionKey) ? 'private' : 'public';
      } catch {
        // privacy-state cache is best-effort — never crash the input-log on
        // a state-store error. Fall back to public (matches Stage 2c default).
        privacy = 'public';
      }
    }
    const stmt = conn.prepare(`
      INSERT INTO input_log
        (received_at, message_id, chat_id, session_key, input_type, raw_content, file_id, status, updated_at, privacy)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)
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
      privacy,
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
 * Tier-1 (RI-23): a successful NON-agent outcome (e.g. transcribe-only). status
 * stays 'done' (it WAS handled — not pending, not unanswered) with response_sent_at
 * set, and dropped_reason carries the handled-kind for audit. Crucially NOT
 * status='dropped' — buildContextAvailabilityPrompt warns only on 'dropped' rows,
 * and this is a successful outcome, not a loss.
 */
export function markHandledNoAgent(rowId: number | null, reason: string): void {
  updateStatus(rowId, 'done', { response_sent_at: new Date().toISOString(), dropped_reason: reason });
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

/**
 * INV-01 Auto-Resume (Codex correction #2): record that a MUTATING tool
 * (Bash / Write / Edit / MultiEdit / Task — anything not clearly read-only) has
 * STARTED for this turn. Called from the PreToolUse hook BEFORE the tool runs.
 *
 * A row with `side_effect_tool_started_at` set is excluded from auto-replay on
 * the next boot, because the turn may have already performed a non-idempotent
 * external write (git push, file overwrite, subagent spawn) that a blind replay
 * would duplicate. The FIRST mutating tool stamps the timestamp (COALESCE keeps
 * it stable); later tools only append their name to the audit list (deduped,
 * length-capped). Best-effort — must never crash a tool invocation.
 */
export function markSideEffectStarted(rowId: number | null, toolName: string): void {
  const conn = getDb();
  if (!conn || rowId == null) return;
  try {
    const now = new Date().toISOString();
    conn
      .prepare(
        `UPDATE input_log
            SET side_effect_tool_started_at = COALESCE(side_effect_tool_started_at, ?),
                tool_execution_names = CASE
                  WHEN tool_execution_names IS NULL OR tool_execution_names = '' THEN ?
                  WHEN INSTR(',' || tool_execution_names || ',', ',' || ? || ',') > 0 THEN tool_execution_names
                  WHEN LENGTH(tool_execution_names) > 200 THEN tool_execution_names
                  ELSE tool_execution_names || ',' || ?
                END,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(now, toolName, toolName, toolName, now, rowId);
  } catch (err) {
    console.error('[InputLog] markSideEffectStarted failed:', err);
  }
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
 *
 * Tier-1 (Codex Pattern-A 2026-05-31): catch-all completions are stamped with
 * dropped_reason='handler_no_finalize' so that status='done' alone no longer
 * means "an agent answered". A real agent reply (markDone) leaves dropped_reason
 * NULL + response_sent_at set; a catch-all finalize (early return, RI-23
 * transcribe hijack, non-agent media) is now distinguishable for audit
 * (countHandlerNoFinalize). COALESCE keeps any pre-set reason intact.
 */
export function finalizeIfOpen(rowId: number | null): void {
  const conn = getDb();
  if (!conn || rowId == null) return;
  try {
    conn
      .prepare(
        `UPDATE input_log
            SET status = 'done',
                dropped_reason = COALESCE(dropped_reason, 'handler_no_finalize'),
                updated_at = ?
          WHERE id = ? AND status IN ('received', 'processing')`,
      )
      .run(new Date().toISOString(), rowId);
  } catch (err) {
    console.error('[InputLog] finalizeIfOpen failed:', err);
  }
}

/**
 * Count rows completed by the catch-all finalizer rather than by an agent
 * (status='done' + dropped_reason='handler_no_finalize'). A rising count means
 * handlers return without answering — e.g. the RI-23 voice hijack or an early
 * return that should have produced a reply. Audit signal (Tier-1, /health).
 */
export function countHandlerNoFinalize(): number {
  const conn = getDb();
  if (!conn) return -1;
  try {
    const row = conn
      .prepare("SELECT COUNT(*) AS n FROM input_log WHERE status = 'done' AND dropped_reason = 'handler_no_finalize'")
      .get() as { n: number };
    return row.n;
  } catch (err) {
    console.error('[InputLog] countHandlerNoFinalize failed:', err);
    return -1;
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

/** A recent orphaned input surfaced by boot-recovery for user notification. */
export interface OrphanInput {
  chatId: number;
  inputType: string;
  rawContent: string | null;
  receivedAt: string;
  /** So the boot re-send notice can REDACT the snippet of a private row instead
   *  of echoing its content (defensive for group chats). */
  privacy: 'public' | 'private';
}

/**
 * Boot-recovery result: how many rows were dropped, plus the recent subset
 * (arrived <= RECENT_ORPHAN_WINDOW_MS before startup) worth notifying the user
 * about. Old drift is still dropped, just not surfaced.
 */
export interface RecoveryResult {
  recovered: number;
  recentOrphans: OrphanInput[];
}

/** Orphans newer than this before boot are surfaced to the user (FIX 4). */
const RECENT_ORPHAN_WINDOW_MS = 600_000; // allow-hardcoded: reason="10min boot-recovery user-notify window"

/**
 * Boot-recovery (Akt 1c): on startup every row still 'received'/'processing'
 * is necessarily orphaned — the only processor is this bot, which just started
 * fresh with no in-memory handler for those rows. Mark them 'dropped' with
 * reason 'startup_recovery' so they are visible and the /health pending count
 * does not drift upward forever. MUST run before the runner starts polling, so
 * freshly-arriving inputs are never affected.
 *
 * FIX 4 (2026-05-22): also returns the RECENT orphans so the caller can tell
 * the affected user their in-flight message was lost to the crash/restart.
 *
 * @deprecated INV-01 (2026-06-01): superseded by `claimResumableOrphans()`,
 * which CLAIMS+replays recoverable orphans instead of blanket-dropping them.
 * The boot path (index.ts) no longer calls this. Do NOT re-import it — that
 * would reinstate the drop-only behaviour that lost the user's in-flight task.
 * Kept only as a short-term rollback anchor; remove in a post-canary cleanup.
 */
export function recoverOrphanedInputs(): RecoveryResult {
  const conn = getDb();
  if (!conn) return { recovered: 0, recentOrphans: [] };
  try {
    const now = Date.now();
    const cutoff = new Date(now).toISOString();
    const recentCutoff = new Date(now - RECENT_ORPHAN_WINDOW_MS).toISOString();
    // Capture recent orphans BEFORE the UPDATE so the caller can notify the
    // user that their in-flight message was lost to a crash/restart.
    const recentOrphans = conn
      .prepare(
        `SELECT chat_id AS chatId, input_type AS inputType,
                raw_content AS rawContent, received_at AS receivedAt, privacy
           FROM input_log
          WHERE status IN ('received', 'processing')
            AND received_at <= ? AND received_at >= ?`,
      )
      .all(cutoff, recentCutoff) as OrphanInput[];
    const info = conn
      .prepare(
        `UPDATE input_log
            SET status = 'dropped', dropped_reason = 'startup_recovery', updated_at = ?
          WHERE status IN ('received', 'processing') AND received_at <= ?`,
      )
      .run(cutoff, cutoff);
    if (info.changes > 0) {
      console.log(
        `[InputLog] boot-recovery: marked ${info.changes} orphaned input(s) dropped ` +
          `(startup_recovery), ${recentOrphans.length} recent`,
      );
    }
    return { recovered: info.changes, recentOrphans };
  } catch (err) {
    console.error('[InputLog] recoverOrphanedInputs failed:', err);
    return { recovered: 0, recentOrphans: [] };
  }
}

// ── INV-01 Auto-Resume (2026-06-01): claim resumable orphans ─────────────────

/**
 * A recent orphaned TEXT input eligible to be REPLAYED through the real agent
 * path on boot (instead of dropped + "please re-send"). Selection AND the
 * resume_attempts increment happen atomically in `claimResumableOrphans()`;
 * `runAutoResume()` (src/inbox/auto-resume.ts) then replays each row via the
 * per-session request queue.
 */
export interface ResumableOrphan {
  id: number;
  chatId: number;
  sessionKey: string;
  rawContent: string;
  privacy: 'public' | 'private';
  receivedAt: string;
  resumeAttempts: number;
}

/**
 * Result of `claimResumableOrphans()`:
 *  - resumable     — public text rows CLAIMED for replay (status set to
 *                    'processing', resume_attempts incremented). `runAutoResume`
 *                    must process exactly these.
 *  - recentOrphans — recent rows that were NOT replayable (private / media /
 *                    side-effect-already-started / attempts-exhausted / beyond
 *                    the per-boot cap). Surfaced to the user as a "please
 *                    re-send" notice, same shape as the legacy boot-recovery.
 *  - recovered     — total rows marked dropped (recent non-replayable + old
 *                    drift), for log parity with `recoverOrphanedInputs`.
 */
export interface ClaimResult {
  resumable: ResumableOrphan[];
  recentOrphans: OrphanInput[];
  recovered: number;
}

/**
 * Hard cap on rows replayed per boot (Codex Q6 + Pattern-B P1-1). A deploy in
 * the middle of a voice/text burst must not spawn dozens of concurrent agent
 * turns; the overflow falls back to a re-send notice. The env override is
 * CLAMPED to [1,5] so a misconfigured `NEXUSGRAM_MAX_BOOT_RESUME=50` (or a
 * negative value → unlimited SQLite `LIMIT`) can never breach the invariant.
 */
const BOOT_CAP_HARD_MAX = 5; // allow-hardcoded: reason="per-boot replay fan-out hard ceiling (Codex P1-1)"

/**
 * Clamp an integer env override to [min,max] with a default for unset/0/NaN.
 * Shared by both replay guards so the clamp invariant is proven once (tested via
 * clampBootCap + clampInt cases). 0 is treated as unset (→ default), negatives
 * and overshoots are clamped into range.
 */
export function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const parsed = Number(raw);
  const v = Number.isFinite(parsed) && parsed !== 0 ? Math.floor(parsed) : def;
  return Math.min(max, Math.max(min, v));
}
export function clampBootCap(raw: string | undefined): number {
  return clampInt(raw, BOOT_CAP_HARD_MAX, 1, BOOT_CAP_HARD_MAX);
}
const MAX_BOOT_RESUME = clampBootCap(process.env.NEXUSGRAM_MAX_BOOT_RESUME);

/**
 * Max times a single row is EVER handed to the agent across the bot's whole
 * lifetime — crash-loop / poison-message guard (Teil B §3). Default 2 survives
 * one transient crash plus one genuine attempt. CLAMPED to [1,5] (Codex round-2
 * P2): a negative env value would stop all replay, a huge one would prolong a
 * crash-loop — neither may breach the poison-message ceiling.
 */
const MAX_RESUME_ATTEMPTS = clampInt(process.env.NEXUSGRAM_MAX_RESUME_ATTEMPTS, 2, 1, 5); // allow-hardcoded: reason="poison-input replay ceiling, clamped [1,5]"

/**
 * Boot-recovery + Auto-Resume (INV-01). Replaces the blanket-drop boot path:
 * recent, public, replayable TEXT orphans are CLAIMED (status→'processing',
 * resume_attempts+1) so the real agent can re-process them; everything else
 * still open is dropped exactly like `recoverOrphanedInputs`, with the recent
 * non-replayable subset surfaced for a "please re-send" notice.
 *
 * The claim + increment run in ONE transaction so the higher attempt counter is
 * durably on disk BEFORE any replay starts — an immediate re-crash therefore
 * still sees it and the crash-loop terminates at MAX_RESUME_ATTEMPTS.
 *
 * MUST run before the runner starts polling (like recoverOrphanedInputs), so a
 * freshly-arriving input is never mistaken for an orphan.
 */
export function claimResumableOrphans(): ClaimResult {
  const conn = getDb();
  if (!conn) return { resumable: [], recentOrphans: [], recovered: 0 };
  try {
    const now = Date.now();
    const cutoff = new Date(now).toISOString();
    const recentCutoff = new Date(now - RECENT_ORPHAN_WINDOW_MS).toISOString();

    const claim = conn.transaction((): ClaimResult => {
      // 1. Eligible resumable rows: recent, text, non-empty, public, no mutating
      //    tool started, attempts left. ASC received_at preserves user order.
      //    Capped at MAX_BOOT_RESUME per boot.
      const eligible = conn
        .prepare(
          `SELECT id, chat_id AS chatId, session_key AS sessionKey,
                  raw_content AS rawContent, privacy,
                  received_at AS receivedAt, resume_attempts AS resumeAttempts
             FROM input_log
            WHERE status IN ('received','processing')
              AND received_at <= @cutoff AND received_at >= @recentCutoff
              AND input_type = 'text'
              AND raw_content IS NOT NULL AND TRIM(raw_content) <> ''
              AND resume_attempts < @maxAttempts
              AND privacy = 'public'
              AND side_effect_tool_started_at IS NULL
            ORDER BY received_at ASC
            LIMIT @bootCap`,
        )
        .all({
          cutoff,
          recentCutoff,
          maxAttempts: MAX_RESUME_ATTEMPTS,
          bootCap: MAX_BOOT_RESUME,
        }) as ResumableOrphan[];

      const claimedIds = eligible.map((r) => r.id);
      // Row ids are DB-generated integers — safe to inline; named params can't
      // be used for a variable-length IN-list in better-sqlite3.
      const notClaimed = claimedIds.length > 0 ? `AND id NOT IN (${claimedIds.join(',')})` : '';

      // 2. Increment + mark 'processing' in the SAME transaction. Counter on
      //    disk before any replay → re-crash still terminates the loop at MAX.
      const inc = conn.prepare(
        `UPDATE input_log
            SET resume_attempts = resume_attempts + 1, status = 'processing', updated_at = @now
          WHERE id = @id`,
      );
      for (const r of eligible) inc.run({ id: r.id, now: cutoff });

      // 3. Recent rows we did NOT claim (private / media / side-effect /
      //    exhausted / over-cap) → surface for a re-send notice, BEFORE drop.
      const recentOrphans = conn
        .prepare(
          `SELECT chat_id AS chatId, input_type AS inputType,
                  raw_content AS rawContent, received_at AS receivedAt, privacy
             FROM input_log
            WHERE status IN ('received','processing')
              AND received_at <= @cutoff AND received_at >= @recentCutoff
              ${notClaimed}`,
        )
        .all({ cutoff, recentCutoff }) as OrphanInput[];

      // 4. Drop everything still open that we did NOT claim (recent
      //    non-replayable + old drift). Claimed rows stay 'processing'.
      const dropped = conn
        .prepare(
          `UPDATE input_log
              SET status = 'dropped', dropped_reason = 'startup_recovery', updated_at = @now
            WHERE status IN ('received','processing') AND received_at <= @cutoff
              ${notClaimed}`,
        )
        .run({ cutoff, now: cutoff });

      return { resumable: eligible, recentOrphans, recovered: dropped.changes };
    });

    const result = claim();
    if (result.resumable.length > 0 || result.recovered > 0) {
      console.log(
        `[InputLog] claimResumableOrphans: ${result.resumable.length} claimed for replay, ` +
          `${result.recovered} dropped (${result.recentOrphans.length} recent non-replayable)`,
      );
    }
    return result;
  } catch (err) {
    console.error('[InputLog] claimResumableOrphans failed:', err);
    return { resumable: [], recentOrphans: [], recovered: 0 };
  }
}

/**
 * INV-01 Auto-Resume (Codex Pattern-B P1-2): true if a NEWER row with the SAME
 * raw_content already exists for this session — i.e. the user re-sent the
 * identical message after the restart. Used by runAutoResume to skip the replay
 * of an orphan whose answer is already owed to a fresh live turn, preventing a
 * double-answer. Deliberately matches on EXACT content + a strictly-later
 * received_at, so it only dedupes genuine duplicates and never suppresses a
 * different (still-unanswered) input. Best-effort; on error returns false
 * (favours answering over silently dropping).
 */
export function hasNewerDuplicate(
  sessionKey: string,
  rawContent: string,
  excludeRowId: number,
  afterReceivedAt: string,
): boolean {
  const conn = getDb();
  if (!conn) return false;
  try {
    // Codex round-2 P2: only dedupe against a row that will ACTUALLY be answered
    // — a live turn (received/processing) or one already answered (done). A
    // newer identical row that is itself dropped/error must NOT suppress this
    // replay, or the user's question would go permanently unanswered.
    const row = conn
      .prepare(
        `SELECT 1 FROM input_log
          WHERE session_key = ? AND raw_content = ? AND id <> ? AND received_at > ?
            AND status IN ('received','processing','done')
          LIMIT 1`,
      )
      .get(sessionKey, rawContent, excludeRowId, afterReceivedAt);
    return row !== undefined;
  } catch (err) {
    console.error('[InputLog] hasNewerDuplicate failed:', err);
    return false;
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

// ── FIX 6+ Step 2 (2026-05-25): retrieval layer ──────────────────────────────

/** A row returned by searchInputLog / getLatestInputLog — UI-shaped. */
export interface InputLogSearchResult {
  id: number;
  received_at: string;
  session_key: string;
  chat_id: number | null;
  input_type: string;
  status: string;
  dropped_reason: string | null;
  raw_content_snippet: string;
}

const SNIPPET_MAX_CHARS = 240; // allow-hardcoded: reason="UI snippet truncation, not a timeout"
const DEFAULT_SEARCH_LIMIT = 10; // allow-hardcoded: reason="default MCP result limit, not a timeout"
const SEARCH_LIMIT_CAP = 50; // allow-hardcoded: reason="hard upper bound on MCP result limit"

function toSnippet(raw: string | null): string {
  if (!raw) return '';
  if (raw.length <= SNIPPET_MAX_CHARS) return raw;
  return raw.slice(0, SNIPPET_MAX_CHARS) + '…';
}

/**
 * Sanitize an FTS5 MATCH query — strip control chars and double-quote each
 * token so user input cannot accidentally invoke FTS5 syntax (NEAR, AND, etc).
 * Phrase-search first, fallback to ORed token-search if phrase yields nothing.
 */
function buildFtsQuery(raw: string): { phrase: string; tokens: string } {
  const cleaned = raw.replace(/[" -]/g, ' ').trim();
  const phrase = `"${cleaned}"`;
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`)
    .join(' OR ');
  return { phrase, tokens };
}

/**
 * Search input_log via FTS5.
 *
 * Privacy contract (FIX 6+ Stage 2b — Codex Pattern-B F-02):
 *  - The previous implementation treated `sessionKey` and `privacy` as an
 *    XOR scope: providing `sessionKey` REPLACED the privacy filter entirely,
 *    so a public-mode MCP search inside an otherwise-private session would
 *    surface that session's `privacy='private'` rows. Codex' privacy-killer
 *    test relied on this and failed-OPEN.
 *  - New contract:
 *      (a) `privacy='public'` is enforced by default ALWAYS, even when a
 *          sessionKey is provided.
 *      (b) A caller MAY opt into private rows by passing
 *          `includePrivate: true` AND a sessionKey — and then only rows of
 *          *that* session are returned regardless of privacy. Public-mode
 *          callers (in particular the MCP tool `nexusgram_input_log_search`)
 *          MUST NOT set `includePrivate=true`.
 *      (c) Without a sessionKey only `privacy='public'` rows are visible —
 *          unchanged from before, kept as fail-CLOSED default.
 *
 * Phrase-match first, falls back to OR-of-tokens when the phrase has 0 hits.
 */
export function searchInputLog(opts: {
  query: string;
  sessionKey?: string;
  since?: string;
  limit?: number;
  /**
   * Stage 2b F-02 opt-in: include rows with `privacy='private'`. Only
   * honoured when `sessionKey` is also set — global private-scan is never
   * allowed. Default false. The MCP-exposed tool must leave this unset.
   */
  includePrivate?: boolean;
}): InputLogSearchResult[] {
  const conn = getDb();
  if (!conn) return [];
  const limit = Math.min(SEARCH_LIMIT_CAP, Math.max(1, opts.limit ?? DEFAULT_SEARCH_LIMIT));
  const since = opts.since ?? null;
  const { phrase, tokens } = buildFtsQuery(opts.query);
  if (!tokens) return [];

  // Build the scope WHERE clause from independent conditions. Privacy is
  // enforced unless the caller explicitly opted into private rows AND
  // bound the search to a single session.
  const conditions: string[] = [];
  if (opts.sessionKey) {
    conditions.push(`il.session_key = @sessionKey`);
  }
  const privateAllowed = opts.includePrivate === true && !!opts.sessionKey;
  if (!privateAllowed) {
    conditions.push(`il.privacy = 'public'`);
  }
  // `conditions` is guaranteed non-empty: either privacy=public is added, or
  // (sessionKey + includePrivate) is present and `il.session_key=@sessionKey`
  // was already added — both cases produce a valid WHERE fragment.
  const scopeWhere = conditions.join(' AND ');
  const sinceWhere = since ? `AND il.received_at >= @since` : '';

  const sql = `
    SELECT il.id, il.received_at, il.session_key, il.chat_id,
           il.input_type, il.status, il.dropped_reason, il.raw_content
      FROM input_log_fts fts
      JOIN input_log il ON il.id = fts.rowid
     WHERE fts.raw_content MATCH @match
       AND ${scopeWhere}
       ${sinceWhere}
     ORDER BY il.received_at DESC
     LIMIT @limit
  `;
  try {
    const params: Record<string, unknown> = { match: phrase, limit };
    if (opts.sessionKey) params.sessionKey = opts.sessionKey;
    if (since) params.since = since;

    let rows = conn.prepare(sql).all(params) as Array<{
      id: number;
      received_at: string;
      session_key: string;
      chat_id: number | null;
      input_type: string;
      status: string;
      dropped_reason: string | null;
      raw_content: string | null;
    }>;

    // Phrase yielded nothing — retry with tokens-OR. Cheaper than running both
    // unconditionally; phrase-match wins relevance for the common case.
    if (rows.length === 0) {
      params.match = tokens;
      rows = conn.prepare(sql).all(params) as typeof rows;
    }

    return rows.map((r) => ({
      id: r.id,
      received_at: r.received_at,
      session_key: r.session_key,
      chat_id: r.chat_id,
      input_type: r.input_type,
      status: r.status,
      dropped_reason: r.dropped_reason,
      raw_content_snippet: toSnippet(r.raw_content),
    }));
  } catch (err) {
    console.error('[InputLog] searchInputLog failed:', err);
    return [];
  }
}

/**
 * Return the N most recent input_log rows for a session (independent of FTS).
 * Used by the Context Availability Prompt-Block to render "last user input"
 * freshness without a query string.
 *
 * FIX 6+ Stage 2b (Codex Pattern-B F-03): the input-log middleware writes the
 * current user message into `input_log` BEFORE `sendToAgent()` runs. Without
 * an exclusion the Context Availability snapshot saw exactly the row of the
 * just-arrived prompt as "prior context", and the "EMPTY → ask for briefing"
 * branch could never fire. `excludeRowId` lets the prompt-builder ask
 * specifically for *prior* turns — the current turn's input_log row id is
 * threaded down from the message handler through AgentOptions.
 */
export function getLatestInputLog(
  sessionKey: string,
  limit = 5,
  opts: { excludeRowId?: number | null } = {},
): InputLogSearchResult[] {
  const conn = getDb();
  if (!conn) return [];
  const cappedLimit = Math.min(SEARCH_LIMIT_CAP, Math.max(1, limit));
  const excludeRowId = opts.excludeRowId ?? null;
  try {
    const sql = excludeRowId != null
      ? `SELECT id, received_at, session_key, chat_id, input_type, status,
                dropped_reason, raw_content
           FROM input_log
          WHERE session_key = ?
            AND id <> ?
          ORDER BY received_at DESC
          LIMIT ?`
      : `SELECT id, received_at, session_key, chat_id, input_type, status,
                dropped_reason, raw_content
           FROM input_log
          WHERE session_key = ?
          ORDER BY received_at DESC
          LIMIT ?`;
    const params: unknown[] = excludeRowId != null
      ? [sessionKey, excludeRowId, cappedLimit]
      : [sessionKey, cappedLimit];
    const rows = conn.prepare(sql).all(...params) as Array<{
      id: number;
      received_at: string;
      session_key: string;
      chat_id: number | null;
      input_type: string;
      status: string;
      dropped_reason: string | null;
      raw_content: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      received_at: r.received_at,
      session_key: r.session_key,
      chat_id: r.chat_id,
      input_type: r.input_type,
      status: r.status,
      dropped_reason: r.dropped_reason,
      raw_content_snippet: toSnippet(r.raw_content),
    }));
  } catch (err) {
    console.error('[InputLog] getLatestInputLog failed:', err);
    return [];
  }
}

/**
 * FIX 6+ Stage 2b (Codex Pattern-B F-04): force eager initialization of the
 * input-log DB at process boot. The lazy `getDb()` defers migration and FTS
 * rebuild until the first caller — and the first caller in the live system
 * turned out to be `getLatestInputLog()` inside `buildContextAvailabilityPrompt`,
 * i.e. the prompt-build path. That meant DB migration could run during a
 * user turn while a parallel session (Family-Bot, Master-Bot worker, /health
 * call) was already holding a connection, which is a lock-risk surface.
 *
 * Calling `ensureInputLogInitialized()` from `index.ts:main()` BEFORE the
 * Grammy runner starts polling guarantees the migration completes once,
 * deterministically, with no concurrent user-input pressure. Idempotent: a
 * second call is a no-op once initialization has completed (or failed and
 * been marked).
 */
export function ensureInputLogInitialized(): void {
  if (db || initFailed) return;
  getDb();
}
