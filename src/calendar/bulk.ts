import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

export type CalendarBulkOperation = 'create' | 'cancel';
export interface CalendarBulkItem {
  account: string;
  calendarId: string;
  title: string;
  start?: string;
  end?: string;
  eventId?: string;
}
export interface CalendarBulkPlan {
  id: string;
  operation: CalendarBulkOperation;
  idempotencyKey: string;
  items: CalendarBulkItem[];
}
export interface CalendarBulkResult { ok: boolean; eventId?: string; detail?: string; }
export interface CalendarBulkExecutor { execute(plan: CalendarBulkPlan): Promise<CalendarBulkResult[]>; }
export interface CalendarBulkJob extends CalendarBulkPlan {
  userId: number;
  chatId: number;
  sessionKey: string;
  state: 'prepared' | 'committing' | 'completed' | 'failed' | 'cancelled';
  results: CalendarBulkResult[] | null;
  failure: string | null;
}

export const CALENDAR_COMMIT_TIMEOUT_MS = 120_000;

let db: Database.Database | null = null;
function connection(): Database.Database {
  if (db) return db;
  fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
  db = new Database(path.join(config.DATA_DIR, 'calendar-bulk-ledger.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_bulk_jobs (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
    session_key TEXT NOT NULL, operation TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
    items_json TEXT NOT NULL, state TEXT NOT NULL, results_json TEXT, failure TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  return db;
}

function rowToJob(row: Record<string, unknown>): CalendarBulkJob {
  return {
    id: String(row.id), userId: Number(row.user_id), chatId: Number(row.chat_id), sessionKey: String(row.session_key),
    operation: row.operation as CalendarBulkOperation, idempotencyKey: String(row.idempotency_key),
    items: JSON.parse(String(row.items_json)) as CalendarBulkItem[], state: row.state as CalendarBulkJob['state'],
    results: row.results_json ? JSON.parse(String(row.results_json)) as CalendarBulkResult[] : null,
    failure: row.failure ? String(row.failure) : null,
  };
}

export function formatCalendarBulkPreview(plan: Pick<CalendarBulkPlan, 'operation' | 'items'>): string {
  const verb = plan.operation === 'create' ? 'angelegt' : 'abgesagt';
  const lines = plan.items.map((item, index) => {
    const when = item.start ? ` – ${item.start}` : '';
    return `${index + 1}. ${item.title}${when} (${item.calendarId})`;
  });
  return `${plan.items.length} Termine werden ${verb}:\n${lines.join('\n')}\n\nBitte bestätigen oder abbrechen.`;
}

export function prepareCalendarBulk(input: Omit<CalendarBulkJob, 'id' | 'idempotencyKey' | 'state' | 'results' | 'failure'>): CalendarBulkJob {
  if (!input.items.length) throw new Error('calendar bulk requires at least one event');
  const id = randomUUID();
  const idempotencyKey = randomUUID();
  const now = new Date().toISOString();
  connection().prepare(`INSERT INTO calendar_bulk_jobs
    (id,user_id,chat_id,session_key,operation,idempotency_key,items_json,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'prepared',?,?)`).run(
    id, input.userId, input.chatId, input.sessionKey, input.operation, idempotencyKey,
    JSON.stringify(input.items), now, now,
  );
  return { ...input, id, idempotencyKey, state: 'prepared', results: null, failure: null };
}

export function getCalendarBulkJob(id: string): CalendarBulkJob | null {
  expireStaleCalendarBulkJobs();
  const row = connection().prepare('SELECT * FROM calendar_bulk_jobs WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

/** A crash after the CAS claim must not leave an invisible permanent commit. */
export function expireStaleCalendarBulkJobs(now = new Date(), timeoutMs = CALENDAR_COMMIT_TIMEOUT_MS): number {
  const cutoff = new Date(now.getTime() - timeoutMs).toISOString();
  const result = connection().prepare(`UPDATE calendar_bulk_jobs
    SET state='failed', failure=?, updated_at=?
    WHERE state='committing' AND updated_at<=?`).run(
    `calendar_commit_timeout_after_${Math.round(timeoutMs / 1000)}s`, now.toISOString(), cutoff,
  );
  return result.changes;
}

function normalizeResults(job: CalendarBulkJob, received: CalendarBulkResult[], fallbackDetail: string): CalendarBulkResult[] {
  return job.items.map((_, index) => {
    const result = received[index];
    return result
      ? { ok: result.ok === true, eventId: result.eventId, detail: result.detail }
      : { ok: false, detail: fallbackDetail };
  });
}

/** Compare-and-set claim makes double confirmation a no-op before any mutation. */
export async function confirmCalendarBulk(id: string, executor: CalendarBulkExecutor): Promise<CalendarBulkJob> {
  expireStaleCalendarBulkJobs();
  const now = new Date().toISOString();
  const claimed = connection().prepare(`UPDATE calendar_bulk_jobs SET state='committing',updated_at=? WHERE id=? AND state='prepared'`).run(now, id);
  const job = getCalendarBulkJob(id);
  if (!job) throw new Error('calendar bulk preview is unavailable');
  if (claimed.changes !== 1) return job;
  try {
    const received = await executor.execute(job);
    const results = normalizeResults(job, received, 'calendar backend returned no result for this event');
    const failure = results.some((result) => !result.ok)
      ? `calendar bulk partially failed (${results.filter((result) => !result.ok).length}/${job.items.length} events)`
      : null;
    connection().prepare(`UPDATE calendar_bulk_jobs SET state=?,results_json=?,failure=?,updated_at=? WHERE id=? AND state='committing'`)
      .run(failure ? 'failed' : 'completed', JSON.stringify(results), failure, new Date().toISOString(), id);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    const results = normalizeResults(job, [], failure.slice(0, 240));
    connection().prepare(`UPDATE calendar_bulk_jobs SET state='failed',results_json=?,failure=?,updated_at=? WHERE id=? AND state='committing'`)
      .run(JSON.stringify(results), failure.slice(0, 500), new Date().toISOString(), id);
  }
  return getCalendarBulkJob(id)!;
}

export function cancelCalendarBulk(id: string): CalendarBulkJob | null {
  connection().prepare(`UPDATE calendar_bulk_jobs SET state='cancelled',updated_at=? WHERE id=? AND state='prepared'`)
    .run(new Date().toISOString(), id);
  return getCalendarBulkJob(id);
}

/** Explicit, shell-free adapter contract. The configured worker must apply the
 * plan transactionally and return JSON {results:[{ok,eventId?,detail?}]}. */
export const configuredCalendarBulkExecutor: CalendarBulkExecutor = {
  async execute(plan) {
    if (!config.CALENDAR_BULK_COMMAND) throw new Error('calendar bulk backend is not configured');
    const { stdout } = await execFileAsync(config.CALENDAR_BULK_COMMAND, [JSON.stringify(plan)], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout) as { results?: CalendarBulkResult[] };
    if (!Array.isArray(parsed.results)) throw new Error('calendar bulk backend returned no results');
    return parsed.results;
  },
};

export function closeCalendarBulkLedger(): void { db?.close(); db = null; }
