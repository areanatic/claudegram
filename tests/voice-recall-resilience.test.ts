import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-voice-recall-resilience-'));
const dbPath = path.join(tmp, 'memory.db');
process.env.NEXUSGRAM_ENV_PATH = path.join(tmp, 'missing.env');
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'VoiceRecallTest';
process.env.BOT_ROLE = 'person';
process.env.DATA_DIR = tmp;
process.env.NEXUS_MEMORY_DB_PATH = dbPath;

const seed = new Database(dbPath);
seed.exec(`
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('semantic','episodic')),
    content TEXT NOT NULL,
    source TEXT,
    project TEXT,
    tags TEXT,
    score REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
    last_accessed TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
    access_count INTEGER NOT NULL DEFAULT 0,
    decay_rate REAL NOT NULL DEFAULT 0.02,
    archived INTEGER NOT NULL DEFAULT 0,
    file_path TEXT,
    privacy TEXT NOT NULL DEFAULT 'public' CHECK(privacy IN ('public','private')),
    bot TEXT
  );
  INSERT INTO memories (type,content,source,project,tags,privacy,bot)
  VALUES ('episodic','LegacyVoiceBeforeMigration','nexusgram','42','voice_inbox','private','voice-recall-test');
`);
seed.close();

const captures = await import('../src/inbox/captures-db.js');
const ledger = await import('../src/inbox/task-ledger.js');
const recall = await import('../src/inbox/voice-recall.js');

test('missing FTS never blocks the voice turn and queues one durable retry', async () => {
  captures.initCapturesSchema();
  let delayedNotices = 0;
  let answerDelivered = false;

  const result = await recall.commitVoiceRecallNonBlocking({
    chatId: '42',
    messageId: 9001,
    botId: 'voice-recall-test',
    transcript: 'Die resiliente Voice-Antwort muss trotz fehlendem Index weiterlaufen.',
    privacy: 'private',
    parentTaskId: null,
    notifyDelayed: async (message) => {
      delayedNotices++;
      assert.equal(message, recall.VOICE_RECALL_DELAY_NOTICE);
    },
  });
  // This is the handler's continuation seam: a resolved recall side effect
  // permits normal answer delivery instead of entering the Voice catch block.
  answerDelivered = true;

  assert.equal(result.memoryId, null);
  assert.equal(result.retryQueued, true);
  assert.equal(answerDelivered, true);
  assert.equal(delayedNotices, 1, 'the user sees one honest delay notice');
  assert.equal(ledger.pendingTaskRetryCount('voice_recall_index'), 1);
});

test('boot migration creates the FTS table/triggers idempotently and queued retry completes', () => {
  assert.equal(captures.ensureVoiceRecallSchema().status, 'ok');
  assert.equal(captures.ensureVoiceRecallSchema().status, 'ok', 'second boot migration is a no-op');

  const inspectSchema = new Database(dbPath, { readonly: true });
  const objects = inspectSchema.prepare(`SELECT name FROM sqlite_master
    WHERE name IN ('memories_fts','memories_ai','memories_ad','memories_au') ORDER BY name`)
    .all() as Array<{ name: string }>;
  assert.deepEqual(objects.map((row) => row.name), [
    'memories_ad', 'memories_ai', 'memories_au', 'memories_fts',
  ]);
  const rebuiltLegacy = inspectSchema.prepare(
    `SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'LegacyVoiceBeforeMigration'`,
  ).get();
  inspectSchema.close();
  assert.ok(rebuiltLegacy, 'migration rebuilds pre-existing memories into a newly-created FTS index');

  const run = recall.retryDueVoiceRecallJobs();
  assert.deepEqual(run, { claimed: 1, completed: 1, failed: 0 });
  assert.equal(ledger.pendingTaskRetryCount('voice_recall_index'), 0);

  const inspect = new Database(dbPath, { readonly: true });
  const linked = inspect.prepare(`SELECT c.memory_id AS memoryId,m.privacy,m.bot
    FROM captures c JOIN memories m ON m.id=c.memory_id
    WHERE c.chat_id='42' AND c.message_id=9001 AND c.bot_id='voice-recall-test'`).get() as {
      memoryId: number;
      privacy: string;
      bot: string;
    };
  const fts = inspect.prepare('SELECT rowid FROM memories_fts WHERE rowid=?').get(linked.memoryId);
  inspect.close();
  assert.ok(linked.memoryId);
  assert.equal(linked.privacy, 'private');
  assert.equal(linked.bot, 'voice-recall-test');
  assert.ok(fts, 'retry satisfies the trigger-backed FTS postcondition');
});

test('primary voice and transcribe-only paths share the same non-blocking recall seam', () => {
  const source = fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/bot/handlers/voice.handler.ts'),
    'utf8',
  );
  assert.equal(
    (source.match(/await commitVoiceRecallNonBlocking\(/g) ?? []).length,
    2,
    'both successful voice paths must preserve answer parity',
  );
  assert.doesNotMatch(source, /Voice transcript could not be committed to the recall index/);
});

test.after(() => {
  ledger.closeTaskLedger();
  fs.rmSync(tmp, { recursive: true, force: true });
});
