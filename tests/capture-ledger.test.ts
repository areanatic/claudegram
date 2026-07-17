import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  CaptureLedger,
  detectCapture,
  formatCaptureProof,
} from '../src/memory/capture-ledger.js';

function newLedger(): { ledger: CaptureLedger; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'nexusgram-capture-test-'));
  return { ledger: new CaptureLedger(path.join(dir, 'capture-ledger.db')), dbPath: path.join(dir, 'capture-ledger.db') };
}

test('merk dir commits before its acknowledgement and exposes an immutable capture id', () => {
  const { ledger } = newLedger();
  const detected = detectCapture('Merk dir: Das Vertragsprojekt heißt Aurora.');
  assert.ok(detected);
  const record = ledger.capture({
    sessionKey: '42', chatId: 42, content: 'Merk dir: Das Vertragsprojekt heißt Aurora.',
    kind: detected.kind, dueAtUtc: detected.dueAtUtc,
  });

  assert.match(record.id, /^cap_[0-9a-f-]+$/);
  assert.match(formatCaptureProof(record), new RegExp(`Gespeichert unter ${record.id}`));
  assert.equal(ledger.pendingForSession('42').length, 0, 'facts are durable but not noisy reminders');
  ledger.close();
});

test('captured reminders survive a process restart and retain their structured due date', () => {
  const { ledger, dbPath } = newLedger();
  const detected = detectCapture('Erinnere mich am 2026-07-16 an den Termin.');
  assert.ok(detected);
  assert.equal(detected.kind, 'reminder');
  assert.equal(detected.dueAtUtc, '2026-07-16T00:00:00.000Z');
  ledger.capture({
    sessionKey: '42', chatId: 42, content: 'Erinnere mich am 2026-07-16 an den Termin.',
    kind: detected.kind, dueAtUtc: detected.dueAtUtc,
  });
  ledger.close();

  const restarted = new CaptureLedger(dbPath);
  assert.equal(restarted.pendingForSession('42', new Date('2026-07-17T09:00:00Z')).length, 1);
  restarted.close();
});

test('a due reminder is reserved for the next turn exactly once per session/day', () => {
  const { ledger } = newLedger();
  const record = ledger.capture({
    sessionKey: '42', chatId: 42, content: 'Frist: Rechnung einreichen.', kind: 'deadline',
    dueAtUtc: '2026-07-16T00:00:00.000Z',
  });
  const now = new Date('2026-07-17T09:00:00Z');
  const pending = ledger.pendingForSession('42', now);
  assert.deepEqual(pending.map((item) => item.key), [`capture:${record.id}`]);
  assert.equal(ledger.reserveForDelivery('42', pending, now).length, 1);
  assert.equal(ledger.reserveForDelivery('42', pending, now).length, 0, 'no double report on a later turn');
  ledger.close();
});

test('appointments are captured with a structured date, not text only', () => {
  const detected = detectCapture('Termin am 03.08.2026 beim Amt');
  assert.deepEqual(detected, { kind: 'appointment', dueAtUtc: '2026-08-03T00:00:00.000Z' });
});
