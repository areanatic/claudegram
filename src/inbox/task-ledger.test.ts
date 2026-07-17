import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-task-ledger-test-'));
process.env.NEXUSGRAM_ENV_PATH = path.join(TMP, 'nonexistent.env');
process.env.CLAUDEGRAM_ENV_PATH = process.env.NEXUSGRAM_ENV_PATH;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'TestBot';
process.env.NEXUS_MEMORY_SCOPE = 'public';
process.env.DATA_DIR = TMP;

let pass = 0;
const check = (value: boolean, message: string) => { assert.equal(value, true, message); pass++; };
const row = (id: number): Record<string, unknown> => {
  const db = new Database(path.join(TMP, 'task-ledger-TestBot.db'));
  try { return db.prepare('SELECT * FROM task_ledger WHERE id=?').get(id) as Record<string, unknown>; }
  finally { db.close(); }
};

(async () => {
  const ledger = await import('./task-ledger.js');
  const input = { messageId: 101, chatId: 7, sessionKey: '7', inputType: 'document', text: 'Bitte analysiere das Dokument', fileId: 'file-1' };

  // Write-ahead acceptance is idempotent and survives closing/reopening the DB.
  const id = ledger.acceptTask(input);
  check(row(id).state === 'accepted', 'accepted upload is persisted before processing');
  check(ledger.acceptTask(input) === id, 'duplicate Telegram delivery does not create a second task');
  ledger.closeTaskLedger();
  ledger.ensureTaskLedgerInitialized();
  check(row(id).state === 'accepted', 'accepted task survives restart');

  ledger.startTask(id);
  const open = ledger.recoverOpenTasks(new Date(Date.now() + 11 * 60_000)); // allow-hardcoded: reason="test fixture exceeds the 10-minute orphan threshold"
  check(open.some((task) => task.id === id && task.state === 'interrupted' && task.reason === 'orphaned_over_10_minutes'), 'over-10-minute orphan is interrupted and presented again');

  // Resume is a compare-and-set claim: only one consumer may start it.
  check(ledger.claimInterruptedTask(id) === true, 'first resume claims interrupted task');
  check(ledger.claimInterruptedTask(id) === false, 'second resume cannot execute task twice');
  ledger.failTask(id, 'download failed');
  check(row(id).state === 'failed' && row(id).failure_reason === 'download failed', 'failure stays visible with its reason');

  const otherId = ledger.acceptTask({ ...input, messageId: 102, chatId: 8, sessionKey: '8' });
  ledger.interruptTask(otherId, 'restart_interrupted');
  const sessionTasks = ledger.listOpenTasksForSession('7');
  check(sessionTasks.length === 1 && sessionTasks[0]?.id === id, 'open-task recall is isolated to the requested session');

  // A corrupt DB never degrades to an untracked acceptance.
  ledger.closeTaskLedger();
  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-task-ledger-corrupt-'));
  const corruptPath = path.join(corruptDir, 'task-ledger-TestBot.db');
  fs.writeFileSync(corruptPath, 'not a sqlite database');
  const originalDataDir = process.env.DATA_DIR;
  // config is intentionally immutable, so exercise the same fail-loud path by
  // replacing the configured ledger atomically only after its connection closed.
  fs.renameSync(corruptPath, path.join(TMP, 'task-ledger-TestBot.db'));
  let corruptFailed = false;
  try { ledger.ensureTaskLedgerInitialized(); } catch (error) { corruptFailed = error instanceof ledger.TaskLedgerError; }
  check(corruptFailed, 'corrupt ledger fails loud instead of accepting untracked work');
  process.env.DATA_DIR = originalDataDir;

  console.log(`✅ task-ledger: ${pass}/${pass} cases PASS`);
})().catch((error) => { console.error('❌ task-ledger.test.ts FAILED:', error); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
