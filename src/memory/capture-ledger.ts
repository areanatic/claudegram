/**
 * Durable capture contract for explicit memories, reminders and commitments.
 *
 * This is intentionally separate from the best-effort input log: a capture
 * acknowledgement is only allowed after this ledger committed its row.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../config.js';

export type CaptureKind = 'memory' | 'reminder' | 'appointment' | 'deadline' | 'task';

export interface CaptureRecord {
  id: string;
  sessionKey: string;
  chatId: number;
  content: string;
  kind: CaptureKind;
  dueAtUtc: string | null;
  createdAt: string;
}

export interface ProactiveItem {
  key: string;
  text: string;
  dueAtUtc: string | null;
}

export class CaptureLedger {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capture_records (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        kind TEXT NOT NULL,
        due_at_utc TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_capture_due
        ON capture_records(session_key, completed_at, due_at_utc);
      CREATE TABLE IF NOT EXISTS proactive_deliveries (
        item_key TEXT NOT NULL,
        session_key TEXT NOT NULL,
        delivery_day TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY (item_key, session_key, delivery_day)
      );
    `);
  }

  capture(input: Omit<CaptureRecord, 'id' | 'createdAt'>, now = new Date()): CaptureRecord {
    const record: CaptureRecord = {
      ...input,
      id: `cap_${randomUUID()}`,
      createdAt: now.toISOString(),
    };
    this.db.prepare(`
      INSERT INTO capture_records
        (id, session_key, chat_id, content, kind, due_at_utc, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.sessionKey, record.chatId, record.content, record.kind,
      record.dueAtUtc, record.createdAt,
    );
    return record;
  }

  /** Due reminders/deadlines plus open, explicit task commitments. */
  pendingForSession(sessionKey: string, now = new Date()): ProactiveItem[] {
    const rows = this.db.prepare(`
      SELECT id, content, kind, due_at_utc
      FROM capture_records
      WHERE session_key = ?
        AND completed_at IS NULL
        AND (
          kind = 'task'
          OR (due_at_utc IS NOT NULL AND due_at_utc <= ?)
        )
      ORDER BY CASE WHEN due_at_utc IS NULL THEN 1 ELSE 0 END, due_at_utc ASC, created_at ASC
      LIMIT 20
    `).all(sessionKey, now.toISOString()) as Array<{
      id: string; content: string; kind: CaptureKind; due_at_utc: string | null;
    }>;
    return rows.map((row) => ({
      key: `capture:${row.id}`,
      text: `${labelFor(row.kind)}: ${row.content}`,
      dueAtUtc: row.due_at_utc,
    }));
  }

  /** Atomically reserve items for one daily/session digest, preventing duplicates. */
  reserveForDelivery(sessionKey: string, items: readonly ProactiveItem[], now = new Date()): ProactiveItem[] {
    const day = now.toISOString().slice(0, 10);
    const deliveredAt = now.toISOString();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO proactive_deliveries (item_key, session_key, delivery_day, delivered_at)
      VALUES (?, ?, ?, ?)
    `);
    const reserve = this.db.transaction(() => items.filter((item) =>
      insert.run(item.key, sessionKey, day, deliveredAt).changes === 1,
    ));
    return reserve();
  }

  releaseDeliveryReservations(sessionKey: string, items: readonly ProactiveItem[], now = new Date()): void {
    if (items.length === 0) return;
    const day = now.toISOString().slice(0, 10);
    const remove = this.db.prepare(`
      DELETE FROM proactive_deliveries WHERE item_key = ? AND session_key = ? AND delivery_day = ?
    `);
    const release = this.db.transaction(() => {
      for (const item of items) remove.run(item.key, sessionKey, day);
    });
    release();
  }

  close(): void { this.db.close(); }
}

function labelFor(kind: CaptureKind): string {
  switch (kind) {
    case 'appointment': return 'Termin';
    case 'deadline': return 'Frist';
    case 'reminder': return 'Erinnerung';
    case 'task': return 'Offener Auftrag';
    default: return 'Merksatz';
  }
}

const CAPTURE_TRIGGER = /\b(merk(?:e)?\s+dir|speicher(?:e)?\s+(?:dir\s+)?|erinnere\s+mich|termin\b|frist\b|deadline\b|auftrag\b|aufgabe\b)\b/i;

export function detectCapture(text: string, now = new Date()): { kind: CaptureKind; dueAtUtc: string | null } | null {
  if (!CAPTURE_TRIGGER.test(text)) return null;
  const lower = text.toLocaleLowerCase('de-DE');
  const dueAtUtc = detectDueAt(text, now);
  if (/\berinnere\s+mich\b/.test(lower)) return { kind: 'reminder', dueAtUtc };
  if (/\btermin\b/.test(lower)) return { kind: 'appointment', dueAtUtc };
  if (/\b(frist|deadline|bis\s+\d)/.test(lower)) return { kind: 'deadline', dueAtUtc };
  if (/\b(auftrag|aufgabe)\b/.test(lower)) return { kind: 'task', dueAtUtc };
  return { kind: 'memory', dueAtUtc };
}

/** Extract an unambiguous calendar date into a structured ISO field. */
export function detectDueAt(text: string, now = new Date()): string | null {
  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  const german = text.match(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/);
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  }
  if (german) {
    day = Number(german[1]);
    month = Number(german[2]);
    year = Number(german[3]);
  }
  if (/\bmorgen\b/i.test(text)) {
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate())).toISOString();
  }
  if (year == null || month == null || day == null) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return parsed.toISOString();
}

export function formatCaptureProof(record: CaptureRecord): string {
  const due = record.dueAtUtc ? ` Termin/Frist: ${record.dueAtUtc.slice(0, 10)}.` : '';
  return `💾 Gespeichert unter ${record.id}, abrufbar via /wo-stehen-wir.${due}`;
}

let defaultLedger: CaptureLedger | null = null;

export function getCaptureLedger(): CaptureLedger {
  if (!defaultLedger) defaultLedger = new CaptureLedger(path.join(config.DATA_DIR, 'capture-ledger.db'));
  return defaultLedger;
}

export function closeCaptureLedger(): void {
  defaultLedger?.close();
  defaultLedger = null;
}
