import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-sprint8-'));
process.env.NEXUSGRAM_ENV_PATH = path.join(tmp, 'missing.env');
process.env.CLAUDEGRAM_ENV_PATH = process.env.NEXUSGRAM_ENV_PATH;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'Sprint8Test';
process.env.NEXUS_MEMORY_SCOPE = 'public';
process.env.DATA_DIR = tmp;

const voice = await import('../src/claude/voice-capabilities.js');
const ledger = await import('../src/inbox/task-ledger.js');
const calendar = await import('../src/calendar/bulk.js');

test('Master voice has full configured tool parity while person voice remains unchanged', () => {
  const configured = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];
  assert.deepEqual(voice.effectiveToolsForVoice(configured, [], true), configured);
  assert.deepEqual(voice.effectiveToolsForVoice(configured, [], false), ['Read', 'Glob', 'Grep']);
  assert.equal(voice.toolBudgetForVoice(true, 10, 15), 15);
  assert.equal(voice.toolBudgetForVoice(false, 10, 15), 10);
});

test('captioned photo, document, and video are durable media jobs with a retryable saved path', () => {
  for (const [offset, inputType] of ['photo', 'document', 'video'].entries()) {
    const id = ledger.acceptTask({
      messageId: 100 + offset, chatId: 1, sessionKey: '1', inputType,
      text: 'Bitte prüfen und zusammenfassen', fileId: `file-${inputType}`,
    });
    ledger.attachTaskMediaPath(id, `/safe/inbox/${inputType}.bin`);
    ledger.startTask(id);
    ledger.failTask(id, 'download failed');
    const task = ledger.getOpenTask(id);
    assert.equal(task?.taskKind, 'upload_processing');
    assert.equal(task?.mediaPath, `/safe/inbox/${inputType}.bin`);
    assert.equal(task?.state, 'failed');
    assert.equal(ledger.claimInterruptedTask(id), true, 'Retry button can claim a failed media task once');
    assert.equal(ledger.claimInterruptedTask(id), false, 'double retry cannot execute it twice');
  }
});

test('calendar bulk produces a preview and atomically confirms once with event_id results', async () => {
  const job = calendar.prepareCalendarBulk({
    userId: 1, chatId: 10, sessionKey: '10', operation: 'create',
    items: [
      { account: 'work', calendarId: 'primary', title: 'Termin A', start: '2026-07-20 09:00' },
      { account: 'work', calendarId: 'primary', title: 'Termin B', start: '2026-07-21 09:00' },
    ],
  });
  assert.match(calendar.formatCalendarBulkPreview(job), /2 Termine werden angelegt/);
  assert.match(calendar.formatCalendarBulkPreview(job), /Termin A/);
  let calls = 0;
  const executor = { execute: async () => {
    calls++;
    return [{ ok: true, eventId: 'evt-a' }, { ok: true, eventId: 'evt-b' }];
  } };
  const completed = await calendar.confirmCalendarBulk(job.id, executor);
  assert.equal(completed.state, 'completed');
  assert.deepEqual(completed.results?.map((result) => result.eventId), ['evt-a', 'evt-b']);
  const duplicate = await calendar.confirmCalendarBulk(job.id, executor);
  assert.equal(duplicate.state, 'completed');
  assert.equal(calls, 1, 'second confirmation does not execute the bulk mutation again');
});

test('calendar bulk keeps failed confirmation visible for recovery', async () => {
  const job = calendar.prepareCalendarBulk({
    userId: 1, chatId: 10, sessionKey: '10', operation: 'cancel',
    items: [{ account: 'work', calendarId: 'primary', title: 'Termin C', eventId: 'evt-c' }],
  });
  const failed = await calendar.confirmCalendarBulk(job.id, { execute: async () => { throw new Error('calendar backend unavailable'); } });
  assert.equal(failed.state, 'failed');
  assert.match(failed.failure ?? '', /backend unavailable/);
  assert.deepEqual(failed.results?.map((result) => result.ok), [false], 'failed batch retains per-event result');
});

test('calendar bulk persists partial event outcomes instead of claiming an atomic result', async () => {
  const job = calendar.prepareCalendarBulk({
    userId: 1, chatId: 10, sessionKey: '10', operation: 'create',
    items: [
      { account: 'work', calendarId: 'primary', title: 'Termin D' },
      { account: 'work', calendarId: 'primary', title: 'Termin E' },
    ],
  });
  const result = await calendar.confirmCalendarBulk(job.id, {
    execute: async () => [{ ok: true, eventId: 'evt-d' }, { ok: false, detail: 'quota exceeded' }],
  });
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.results?.map((event) => event.ok), [true, false]);
  assert.equal(result.results?.[0]?.eventId, 'evt-d');
  assert.match(result.results?.[1]?.detail ?? '', /quota exceeded/);
});

test('stale committing calendar jobs become visible failures', () => {
  const job = calendar.prepareCalendarBulk({
    userId: 1, chatId: 10, sessionKey: '10', operation: 'create',
    items: [{ account: 'work', calendarId: 'primary', title: 'Termin F' }],
  });
  const staleAt = new Date('2026-07-20T00:00:00.000Z');
  // First claim normally, then expire it as if the worker crashed before it
  // could persist an outcome. The test uses the public recovery primitive.
  const db = new Database(path.join(tmp, 'calendar-bulk-ledger.db'));
  db.prepare("UPDATE calendar_bulk_jobs SET state='committing', updated_at=? WHERE id=?").run(staleAt.toISOString(), job.id);
  db.close();
  assert.equal(calendar.expireStaleCalendarBulkJobs(new Date(staleAt.getTime() + calendar.CALENDAR_COMMIT_TIMEOUT_MS + 1)), 1);
  const recovered = calendar.getCalendarBulkJob(job.id);
  assert.equal(recovered?.state, 'failed');
  assert.match(recovered?.failure ?? '', /calendar_commit_timeout/);
});

test.after(() => {
  ledger.closeTaskLedger();
  calendar.closeCalendarBulkLedger();
  fs.rmSync(tmp, { recursive: true, force: true });
});
