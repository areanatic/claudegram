/** Durable task ledger for user-accepted work. */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../config.js';

export type TaskState = 'accepted' | 'working' | 'interrupted' | 'failed' | 'completed';

export interface TaskInput {
  messageId: number;
  chatId: number;
  sessionKey: string;
  inputType: string;
  text: string | null;
  fileId: string | null;
}

export interface OpenTask {
  id: number;
  chatId: number;
  sessionKey: string;
  inputType: string;
  taskKind: string;
  summary: string;
  state: TaskState;
  reason: string | null;
  acceptedAt: string;
  mediaPath?: string | null;
}

export type TaskRetryKind = 'voice_recall_index';

export interface TaskRetryJob {
  id: number;
  parentTaskId: number | null;
  retryKind: TaskRetryKind;
  dedupeKey: string;
  payloadJson: string;
  attempts: number;
  lastError: string | null;
}

export interface EnqueueTaskRetryInput {
  parentTaskId: number | null;
  retryKind: TaskRetryKind;
  dedupeKey: string;
  payloadJson: string;
  lastError: string;
}

export class TaskLedgerError extends Error { readonly name = 'TaskLedgerError'; }

let db: Database.Database | null = null;
const botId = () => (config.BOT_NAME || 'nexusgram').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
const dbPath = () => path.join(config.DATA_DIR, `task-ledger-${botId()}.db`);

function taskKind(input: TaskInput): string {
  if (input.inputType === 'document' || input.inputType === 'photo' || input.inputType === 'video') return 'upload_processing';
  const value = (input.text ?? '').toLowerCase();
  if (/\b(erinner|remind)\b/.test(value)) return 'reminder';
  if (/\b(mail|e-mail|email)\b/.test(value) && /\b(entwurf|draft|schreib|formul)\b/.test(value)) return 'mail_draft';
  if (/\b(analy|pr[üu]f|zusammenfass|auswert)\b/.test(value)) return 'analysis';
  return 'user_request';
}

function summary(input: TaskInput): string {
  return (input.text?.replace(/\s+/g, ' ').trim() || `${input.inputType} upload`).slice(0, 240);
}

function getDb(): Database.Database {
  if (db) return db;
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
    const conn = new Database(dbPath());
    conn.pragma('journal_mode = WAL');
    conn.pragma('busy_timeout = 5000');
    const integrity = conn.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      conn.close();
      throw new TaskLedgerError(`integrity_check failed: ${String(integrity)}`);
    }
    conn.exec(`
      CREATE TABLE IF NOT EXISTS task_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL, session_key TEXT NOT NULL, input_type TEXT NOT NULL,
        task_kind TEXT NOT NULL, summary TEXT NOT NULL, file_id TEXT, media_path TEXT,
        state TEXT NOT NULL CHECK(state IN ('accepted','working','interrupted','failed','completed')),
        failure_reason TEXT, accepted_at TEXT NOT NULL, started_at TEXT, terminal_at TEXT,
        updated_at TEXT NOT NULL, resume_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(bot_id, chat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_ledger_open ON task_ledger(bot_id, state, accepted_at);
      CREATE TABLE IF NOT EXISTS task_retry_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        parent_task_id INTEGER,
        retry_kind TEXT NOT NULL CHECK(retry_kind IN ('voice_recall_index')),
        dedupe_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','processing','failed','completed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(bot_id, retry_kind, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS idx_task_retry_due
        ON task_retry_queue(bot_id, retry_kind, state, next_attempt_at);
    `);
    const columns = (conn.prepare('PRAGMA table_info(task_ledger)').all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes('media_path')) conn.exec('ALTER TABLE task_ledger ADD COLUMN media_path TEXT');
    db = conn;
    return conn;
  } catch (error) {
    if (error instanceof TaskLedgerError) throw error;
    throw new TaskLedgerError(`cannot open task ledger ${dbPath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function ensureTaskLedgerInitialized(): void { getDb(); }

export function acceptTask(input: TaskInput): number {
  const conn = getDb();
  const now = new Date().toISOString();
  const write = conn.transaction(() => {
    const result = conn.prepare(`INSERT INTO task_ledger
      (bot_id,chat_id,message_id,session_key,input_type,task_kind,summary,file_id,state,accepted_at,updated_at)
      VALUES (@botId,@chatId,@messageId,@sessionKey,@inputType,@taskKind,@summary,@fileId,'accepted',@now,@now)
      ON CONFLICT(bot_id,chat_id,message_id) DO NOTHING`).run({
      botId: botId(), chatId: input.chatId, messageId: input.messageId, sessionKey: input.sessionKey,
      inputType: input.inputType, taskKind: taskKind(input), summary: summary(input), fileId: input.fileId, now,
    });
    if (result.changes) return Number(result.lastInsertRowid);
    const row = conn.prepare('SELECT id FROM task_ledger WHERE bot_id=? AND chat_id=? AND message_id=?')
      .get(botId(), input.chatId, input.messageId) as { id: number } | undefined;
    if (!row) throw new TaskLedgerError('idempotent task lookup failed');
    return row.id;
  });
  return write();
}

function transition(id: number | null, state: TaskState, reason: string | null = null): void {
  if (id == null) return;
  const conn = getDb();
  const now = new Date().toISOString();
  const allowed = state === 'completed' ? "state IN ('accepted','working')" : "state IN ('accepted','working','interrupted','failed')";
  const result = conn.prepare(`UPDATE task_ledger SET state=?, failure_reason=?,
    started_at=CASE WHEN ?='working' THEN COALESCE(started_at,?) ELSE started_at END,
    terminal_at=CASE WHEN ?='completed' THEN ? ELSE terminal_at END, updated_at=?
    WHERE id=? AND ${allowed}`).run(state, reason, state, now, state, now, now, id);
  if (state === 'working' && result.changes !== 1) {
    const row = conn.prepare('SELECT state FROM task_ledger WHERE id=?').get(id) as { state: TaskState } | undefined;
    if (!row) throw new TaskLedgerError(`missing task ${id}`);
  }
}

export const startTask = (id: number | null) => transition(id, 'working');
export const completeTask = (id: number | null) => transition(id, 'completed');
export const failTask = (id: number | null, reason: string) => transition(id, 'failed', reason.slice(0, 240));
export const interruptTask = (id: number | null, reason: string) => transition(id, 'interrupted', reason.slice(0, 240));

/**
 * Add a durable side-effect retry without keeping the user-facing task open.
 * The parent voice task can complete after Telegram delivery while this row
 * independently preserves the delayed recall-index write.
 */
export function enqueueTaskRetry(input: EnqueueTaskRetryInput): number {
  const conn = getDb();
  const now = new Date().toISOString();
  const result = conn.prepare(`INSERT INTO task_retry_queue
    (bot_id,parent_task_id,retry_kind,dedupe_key,payload_json,state,attempts,last_error,
     next_attempt_at,created_at,updated_at)
    VALUES (?,?,?,?,?,'pending',0,?,?,?,?)
    ON CONFLICT(bot_id,retry_kind,dedupe_key) DO UPDATE SET
      parent_task_id=excluded.parent_task_id,
      payload_json=excluded.payload_json,
      state=CASE WHEN task_retry_queue.state='completed' THEN 'completed' ELSE 'pending' END,
      last_error=CASE WHEN task_retry_queue.state='completed' THEN task_retry_queue.last_error ELSE excluded.last_error END,
      next_attempt_at=CASE WHEN task_retry_queue.state='completed' THEN task_retry_queue.next_attempt_at ELSE excluded.next_attempt_at END,
      updated_at=excluded.updated_at`).run(
    botId(), input.parentTaskId, input.retryKind, input.dedupeKey, input.payloadJson,
    input.lastError.slice(0, 240), now, now, now,
  );
  const existing = conn.prepare(`SELECT id FROM task_retry_queue
    WHERE bot_id=? AND retry_kind=? AND dedupe_key=?`).get(
    botId(), input.retryKind, input.dedupeKey,
  ) as { id: number } | undefined;
  if (!result.changes || !existing) throw new TaskLedgerError('idempotent task retry lookup failed');
  return existing.id;
}

/** Atomically claim due retries so overlapping timer ticks cannot duplicate work. */
export function claimDueTaskRetries(retryKind: TaskRetryKind, limit = 10): TaskRetryJob[] {
  const conn = getDb();
  const now = new Date().toISOString();
  return conn.transaction(() => {
    // A process crash can strand a claim in processing. Re-open claims older
    // than ten minutes before selecting this bounded batch.
    const stale = new Date(Date.now() - 10 * 60_000).toISOString(); // allow-hardcoded: reason="Sprint-3 retry orphan threshold"
    conn.prepare(`UPDATE task_retry_queue SET state='failed',last_error='retry_worker_restart',
      next_attempt_at=?,updated_at=? WHERE bot_id=? AND retry_kind=? AND state='processing' AND updated_at<=?`)
      .run(now, now, botId(), retryKind, stale);
    const rows = conn.prepare(`SELECT id,parent_task_id AS parentTaskId,retry_kind AS retryKind,
      dedupe_key AS dedupeKey,payload_json AS payloadJson,attempts,last_error AS lastError
      FROM task_retry_queue WHERE bot_id=? AND retry_kind=? AND state IN ('pending','failed')
        AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT ?`).all(
      botId(), retryKind, now, Math.max(1, Math.min(limit, 100)),
    ) as TaskRetryJob[];
    const claim = conn.prepare(`UPDATE task_retry_queue SET state='processing',attempts=attempts+1,
      updated_at=? WHERE id=? AND bot_id=? AND state IN ('pending','failed')`);
    return rows.filter((row) => claim.run(now, row.id, botId()).changes === 1)
      .map((row) => ({ ...row, attempts: row.attempts + 1 }));
  })();
}

export function completeTaskRetry(id: number): void {
  const now = new Date().toISOString();
  getDb().prepare(`UPDATE task_retry_queue SET state='completed',completed_at=?,updated_at=?
    WHERE id=? AND bot_id=? AND state='processing'`).run(now, now, id, botId());
}

export function rescheduleTaskRetry(id: number, error: string, delayMs: number): void {
  const now = new Date();
  const next = new Date(now.getTime() + Math.max(1_000, delayMs)).toISOString();
  getDb().prepare(`UPDATE task_retry_queue SET state='failed',last_error=?,next_attempt_at=?,updated_at=?
    WHERE id=? AND bot_id=? AND state='processing'`).run(
    error.slice(0, 240), next, now.toISOString(), id, botId(),
  );
}

export function pendingTaskRetryCount(retryKind?: TaskRetryKind): number {
  const row = retryKind
    ? getDb().prepare(`SELECT COUNT(*) AS n FROM task_retry_queue
        WHERE bot_id=? AND retry_kind=? AND state<>'completed'`).get(botId(), retryKind)
    : getDb().prepare(`SELECT COUNT(*) AS n FROM task_retry_queue
        WHERE bot_id=? AND state<>'completed'`).get(botId());
  return (row as { n: number }).n;
}

/** Persist the locally validated media path before the agent may inspect it. */
export function attachTaskMediaPath(id: number | null, mediaPath: string): void {
  if (id == null) return;
  getDb().prepare(`UPDATE task_ledger SET media_path=?, updated_at=? WHERE id=? AND state IN ('accepted','working','interrupted','failed')`)
    .run(mediaPath, new Date().toISOString(), id);
}

/** Atomically claim a user-approved retry. A second resume press cannot execute it twice. */
export function claimInterruptedTask(id: number): boolean {
  const conn = getDb();
  const now = new Date().toISOString();
  const result = conn.prepare(`UPDATE task_ledger SET state='working', resume_count=resume_count+1,
    started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND state IN ('interrupted','failed')`)
    .run(now, now, id);
  return result.changes === 1;
}

export function completeAcceptedTask(id: number | null): void {
  if (id == null) return;
  const now = new Date().toISOString();
  getDb().prepare("UPDATE task_ledger SET state='completed',terminal_at=?,updated_at=? WHERE id=? AND state='accepted'")
    .run(now, now, id);
}

/** Explicit user completion from an inline action; safe on a repeated press. */
export function completeOpenTask(id: number): boolean {
  const now = new Date().toISOString();
  const result = getDb().prepare(`UPDATE task_ledger SET state='completed', terminal_at=?, updated_at=?
    WHERE id=? AND state<>'completed'`).run(now, now, id);
  return result.changes === 1;
}

/** Retain an audit reason while removing a user-discarded task from the open queue. */
export function discardOpenTask(id: number): boolean {
  const now = new Date().toISOString();
  const result = getDb().prepare(`UPDATE task_ledger SET state='completed', failure_reason='user_discarded',
    terminal_at=?, updated_at=? WHERE id=? AND state<>'completed'`).run(now, now, id);
  return result.changes === 1;
}

export function recoverOpenTasks(now = new Date()): OpenTask[] {
  const conn = getDb();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - 10 * 60_000).toISOString(); // allow-hardcoded: reason="Sprint-3 orphan threshold: >10-minute work must be surfaced"
  conn.prepare(`UPDATE task_ledger SET state='interrupted',
    failure_reason=CASE WHEN accepted_at<=? THEN 'orphaned_over_10_minutes' ELSE 'restart_interrupted' END,
    updated_at=? WHERE bot_id=? AND state IN ('accepted','working')`).run(cutoff, nowIso, botId());
  return conn.prepare(`SELECT id,chat_id AS chatId,session_key AS sessionKey,input_type AS inputType,
    task_kind AS taskKind,summary,state,failure_reason AS reason,accepted_at AS acceptedAt,media_path AS mediaPath
    FROM task_ledger WHERE bot_id=? AND state<>'completed' ORDER BY accepted_at ASC`).all(botId()) as OpenTask[];
}

export function openTaskCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM task_ledger WHERE bot_id=? AND state<>'completed'")
    .get(botId()) as { n: number }).n;
}

/** Read-only, session-scoped view used by the integrated recall surface. */
export function listOpenTasksForSession(sessionKey: string): OpenTask[] {
  return getDb().prepare(`SELECT id,chat_id AS chatId,session_key AS sessionKey,input_type AS inputType,
    task_kind AS taskKind,summary,state,failure_reason AS reason,accepted_at AS acceptedAt,media_path AS mediaPath
    FROM task_ledger WHERE bot_id=? AND session_key=? AND state<>'completed'
    ORDER BY accepted_at ASC`).all(botId(), sessionKey) as OpenTask[];
}

export function getOpenTask(id: number): OpenTask | null {
  const row = getDb().prepare(`SELECT id,chat_id AS chatId,session_key AS sessionKey,input_type AS inputType,
    task_kind AS taskKind,summary,state,failure_reason AS reason,accepted_at AS acceptedAt,media_path AS mediaPath
    FROM task_ledger WHERE id=? AND bot_id=? AND state<>'completed'`).get(id, botId()) as OpenTask | undefined;
  return row ?? null;
}

export function closeTaskLedger(): void { if (db) db.close(); db = null; }
export function __resetTaskLedgerForTest(): void { closeTaskLedger(); }
