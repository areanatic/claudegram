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
}

export class TaskLedgerError extends Error { readonly name = 'TaskLedgerError'; }

let db: Database.Database | null = null;
const botId = () => (config.BOT_NAME || 'nexusgram').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
const dbPath = () => path.join(config.DATA_DIR, `task-ledger-${botId()}.db`);

function taskKind(input: TaskInput): string {
  if (input.inputType === 'document' || input.inputType === 'photo') return 'upload_processing';
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
        task_kind TEXT NOT NULL, summary TEXT NOT NULL, file_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('accepted','working','interrupted','failed','completed')),
        failure_reason TEXT, accepted_at TEXT NOT NULL, started_at TEXT, terminal_at TEXT,
        updated_at TEXT NOT NULL, resume_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(bot_id, chat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_ledger_open ON task_ledger(bot_id, state, accepted_at);
    `);
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

export function recoverOpenTasks(now = new Date()): OpenTask[] {
  const conn = getDb();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - 10 * 60_000).toISOString(); // allow-hardcoded: reason="Sprint-3 orphan threshold: >10-minute work must be surfaced"
  conn.prepare(`UPDATE task_ledger SET state='interrupted',
    failure_reason=CASE WHEN accepted_at<=? THEN 'orphaned_over_10_minutes' ELSE 'restart_interrupted' END,
    updated_at=? WHERE bot_id=? AND state IN ('accepted','working')`).run(cutoff, nowIso, botId());
  return conn.prepare(`SELECT id,chat_id AS chatId,session_key AS sessionKey,input_type AS inputType,
    task_kind AS taskKind,summary,state,failure_reason AS reason,accepted_at AS acceptedAt
    FROM task_ledger WHERE bot_id=? AND state<>'completed' ORDER BY accepted_at ASC`).all(botId()) as OpenTask[];
}

export function openTaskCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM task_ledger WHERE bot_id=? AND state<>'completed'")
    .get(botId()) as { n: number }).n;
}

export function closeTaskLedger(): void { if (db) db.close(); db = null; }
export function __resetTaskLedgerForTest(): void { closeTaskLedger(); }
