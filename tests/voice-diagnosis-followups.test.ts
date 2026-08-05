import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-voice-followups-'));
const memoryDbPath = path.join(tmp, 'memory.db');
process.env.NEXUSGRAM_ENV_PATH = path.join(tmp, 'missing.env');
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'VoiceFollowupTest';
process.env.BOT_ROLE = 'master';
process.env.DATA_DIR = tmp;
process.env.NEXUS_MEMORY_DB_PATH = memoryDbPath;
process.env.NEXUS_MEMORY_SCOPE = 'self_private';

const memorySeed = new Database(memoryDbPath);
memorySeed.exec(`
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
`);
memorySeed.close();

const miniTap = await import('../src/bot/handlers/voice-mini-tap.js');
const inputLog = await import('../src/inbox/input-log.js');
const captures = await import('../src/inbox/captures-db.js');
const voiceRecall = await import('../src/inbox/voice-recall.js');
const memory = await import('../src/memory/nexus-memory.js');
const recall = await import('../src/memory/recall-orchestrator.js');
const health = await import('../src/health/bot-health.js');

test('0.5s mini tap gets a friendly reply and stops before transcription, memory, or agent work', async () => {
  const rowId = inputLog.recordInput({
    messageId: 501,
    chatId: 42,
    sessionKey: 'mini-tap-session',
    inputType: 'voice',
    fileId: 'mini-tap-fixture',
  });
  assert.ok(rowId);

  let transcribeRuns = 0;
  let memoryWrites = 0;
  let agentRuns = 0;
  let taskInterrupts = 0;
  const replies: string[] = [];

  const processFixture = async () => {
    const stopped = await miniTap.handleMiniTapVoice(
      { duration: 0.5, fileSize: 3_038 },
      {
        markDropped: (reason) => inputLog.markDropped(rowId, reason),
        interruptTask: (reason) => {
          assert.equal(reason, 'mini_tap');
          taskInterrupts++;
        },
        reply: async (message) => { replies.push(message); },
      },
    );
    if (stopped) return;
    transcribeRuns++;
    memoryWrites++;
    agentRuns++;
  };

  await processFixture();

  const inspect = new Database(path.join(tmp, 'input-log.db'), { readonly: true });
  const row = inspect.prepare(
    'SELECT status,dropped_reason,raw_content FROM input_log WHERE id=?',
  ).get(rowId) as { status: string; dropped_reason: string; raw_content: string | null };
  inspect.close();

  assert.deepEqual(replies, [miniTap.MINI_TAP_REPLY]);
  assert.equal(miniTap.MINI_TAP_REPLY, 'Das war nur ein Sekundenbruchteil — wolltest du etwas sagen?');
  assert.deepEqual(row, { status: 'dropped', dropped_reason: 'mini_tap', raw_content: null });
  assert.equal(taskInterrupts, 1);
  assert.equal(transcribeRuns, 0);
  assert.equal(memoryWrites, 0);
  assert.equal(agentRuns, 0);
});

test('successful Voice delivery updates health.json and the handler owns that call', () => {
  const before = health.getBotEffectivenessHealth().turns.last_success_at;
  health.recordSuccessfulTurn();
  const written = JSON.parse(fs.readFileSync(path.join(tmp, 'health.json'), 'utf8')) as {
    turns: { last_success_at: string | null };
  };
  assert.notEqual(written.turns.last_success_at, before);
  assert.ok(written.turns.last_success_at);

  const handlerPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../src/bot/handlers/voice.handler.ts',
  );
  const source = fs.readFileSync(handlerPath, 'utf8');
  const delivery = source.indexOf('await messageSender.sendMessage(ctx, response.text);');
  const healthRecord = source.indexOf('recordSuccessfulTurn();');
  const completion = source.indexOf('markDone(inputLogRowId);');
  assert.ok(delivery >= 0 && healthRecord > delivery && completion > healthRecord,
    'Voice success must update health after delivery and before durable completion');
});

test('RI-28 immediate recall excludes the current turn memory id', async () => {
  assert.equal(captures.ensureVoiceRecallSchema().status, 'ok');
  const captureId = captures.insertCapture({
    chat_id: 'echo-chat',
    message_id: 777,
    bot_id: 'voicefollowuptest',
    capture_type: 'voice',
    telegram_file_id: 'echo-fixture',
    tags: 'voice',
    privacy: 'public',
  });
  assert.ok(captureId);

  const transcript = 'SelbstEchoQuasar wurde in diesem Turn gerade erst gesagt.';
  const commit = await voiceRecall.commitVoiceRecallNonBlocking({
    chatId: 'echo-chat',
    messageId: 777,
    botId: 'voicefollowuptest',
    transcript,
    privacy: 'public',
    parentTaskId: null,
  });
  assert.ok(commit.memoryId);

  const visibleLater = memory.searchMemoryReadOnly('SelbstEchoQuasar', 5, undefined, {
    policy: { scope: 'public', trustedPrivateSources: [] },
  });
  assert.equal(visibleLater.length, 1, 'the durable memory remains available to later turns');

  const hiddenNow = recall.runRecallContract('SelbstEchoQuasar', {
    scope: {
      kind: 'operator',
      sessionKey: 'echo-session',
      allowSessionArchive: false,
      allowOperatorFiles: false,
    },
    policy: { scope: 'public', trustedPrivateSources: [] },
    excludeMemoryIds: [commit.memoryId!],
  });
  assert.equal(hiddenNow.found, false);
  assert.deepEqual(hiddenNow.evidence, []);

  const hiddenFromToolSearch = memory.searchMemoryReadOnly('SelbstEchoQuasar', 5, undefined, {
    policy: { scope: 'public', trustedPrivateSources: [] },
    excludeMemoryIds: [commit.memoryId!],
  });
  assert.deepEqual(hiddenFromToolSearch, []);

  const hiddenFromRecent = memory.recentMemoriesReadOnly(5, undefined, {
    policy: { scope: 'public', trustedPrivateSources: [] },
    excludeMemoryIds: [commit.memoryId!],
  });
  assert.equal(hiddenFromRecent.some((hit) => hit.content.includes('SelbstEchoQuasar')), false);

  const hiddenFromPromptInjection = memory.injectContext(
    'SelbstEchoQuasar',
    undefined,
    false,
    undefined,
    [commit.memoryId!],
  );
  assert.doesNotMatch(hiddenFromPromptInjection, /SelbstEchoQuasar/);
});

test.after(() => {
  memory.closeMemoryDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});
