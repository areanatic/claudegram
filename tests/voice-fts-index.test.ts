import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-voice-fts-'));
const dbPath = path.join(tmp, 'memory.db');
process.env.NEXUS_MEMORY_DB_PATH = dbPath;
delete process.env.NEXUS_MEMORY_SCOPE;
delete process.env.NEXUS_TRUSTED_PRIVATE_SOURCES;

const db = new Database(dbPath);
db.exec(`
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
  CREATE VIRTUAL TABLE memories_fts USING fts5(
    content, tags, project, content=memories, content_rowid=id,
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tags, project)
    VALUES (new.id, new.content, new.tags, new.project);
  END;
`);
db.close();

const captures = await import('../src/inbox/captures-db.js');
const memory = await import('../src/memory/nexus-memory.js');

test('voice transcript is linked idempotently into memories_fts and searchable', () => {
  captures.initCapturesSchema();
  const captureId = captures.insertCapture({
    chat_id: 'memo-chat',
    message_id: 77,
    bot_id: 'astron-memo-bot',
    capture_type: 'voice',
    telegram_file_id: 'fixture-file-id',
    tags: 'voice',
    privacy: 'public',
  });
  assert.ok(captureId);

  const transcript = 'VoiceNebulaFact wurde nur in dieser Sprachnachricht genannt.';
  const memoryId = captures.persistVoiceTranscriptMemory(
    'memo-chat',
    77,
    'astron-memo-bot',
    transcript,
  );
  assert.ok(memoryId);
  assert.equal(
    captures.persistVoiceTranscriptMemory('memo-chat', 77, 'astron-memo-bot', transcript),
    memoryId,
    'replay must return the existing link, not duplicate the memory',
  );

  const hits = memory.searchMemoryReadOnly('VoiceNebulaFact', 5, 'memo-chat', {
    policy: { scope: 'public', trustedPrivateSources: [] },
    originBot: 'astron-memo-bot',
  });
  assert.equal(hits.length, 1);
  assert.match(hits[0]?.content ?? '', /VoiceNebulaFact/);

  const inspect = new Database(dbPath, { readonly: true });
  const fts = inspect.prepare(
    'SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?',
  ).all('"VoiceNebulaFact"') as Array<{ rowid: number }>;
  const linked = inspect.prepare(
    'SELECT memory_id FROM captures WHERE id = ?',
  ).get(captureId) as { memory_id: number };
  const duplicates = inspect.prepare(
    'SELECT count(*) AS count FROM memories WHERE tags LIKE ?',
  ).get(`%capture:${captureId}%`) as { count: number };
  inspect.close();

  assert.deepEqual(fts.map((row) => row.rowid), [memoryId]);
  assert.equal(linked.memory_id, memoryId);
  assert.equal(duplicates.count, 1);
});

test.after(() => {
  memory.closeMemoryDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});
