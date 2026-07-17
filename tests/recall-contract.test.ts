import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-recall-contract-'));
const dbPath = path.join(tmp, 'memory.db');
const dailyDir = path.join(tmp, 'daily');
const transcriptDir = path.join(tmp, 'transcripts');
const sharedIndexPath = path.join(tmp, 'MEMORY.md');

fs.mkdirSync(dailyDir, { recursive: true });
fs.mkdirSync(path.join(transcriptDir, '2026-07-11'), { recursive: true });
fs.writeFileSync(
  path.join(dailyDir, '2026-07-11.md'),
  '# Daily\n\n## Operator only\nForeignSiloFact must never reach a person bot.\n\n' +
    '## Daily fact\nDailyOnlyFact lives on the second rung.\n',
);
fs.writeFileSync(
  sharedIndexPath,
  '# Index\n\n## 2026-07-10\nForeignSiloFact is also present in the operator index.\n\n' +
    '## 2026-07-09\nIndexOnlyFact lives on the third rung.\n',
);
fs.writeFileSync(
  path.join(transcriptDir, '2026-07-11', 'alina-session.md'),
  '# Own session\n\nNo matching foreign content here.\n',
);
fs.writeFileSync(
  path.join(transcriptDir, '2026-07-11', 'operator-session.md'),
  '# Operator session\n\nSessionOnlyFact lives in the scoped session archive.\n',
);

process.env.NEXUS_MEMORY_DB_PATH = dbPath;
process.env.NEXUS_DAILY_DIR = dailyDir;
process.env.NEXUS_SHARED_MEMORY_INDEX_PATH = sharedIndexPath;
process.env.NEXUS_SESSION_ARCHIVE_DIR = transcriptDir;
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
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags, project)
    VALUES ('delete', old.id, old.content, old.tags, old.project);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories
  WHEN old.content IS NOT new.content OR old.tags IS NOT new.tags OR old.project IS NOT new.project
  BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags, project)
    VALUES ('delete', old.id, old.content, old.tags, old.project);
    INSERT INTO memories_fts(rowid, content, tags, project)
    VALUES (new.id, new.content, new.tags, new.project);
  END;
`);
const insertMemory = db.prepare(`
  INSERT INTO memories (type, content, source, project, tags, created_at, bot)
  VALUES ('semantic', ?, 'test', ?, 'recall-test', ?, ?)
`);
insertMemory.run(
  'Projekt Aurora verwendet deterministische Recall-Vertraege.',
  'nexus',
  '2026-07-12T09:15:00',
  'nexusgram',
);
insertMemory.run(
  'ForeignSiloFact: operator private context disguised as a public fixture.',
  // Same project label as the person bot on purpose: the bot-attribution
  // filter, not project coincidence alone, must keep this invisible.
  'alina',
  '2026-07-12T10:00:00',
  'nexusgram',
);
db.close();

const recall = await import('../src/memory/recall-orchestrator.js');

const operatorOptions = {
  scope: {
    kind: 'operator' as const,
    sessionKey: 'operator-session',
    allowSessionArchive: true,
    allowOperatorFiles: true,
  },
  paths: { dailyDir, sharedIndexPath, transcriptDir },
};

test('known Memory fact is found and cited with its date', () => {
  const result = recall.runRecallContractForMessage(
    'Was weisst du ueber Projekt Aurora?',
    operatorOptions,
  );
  assert.ok(result);
  assert.equal(result.found, true);
  assert.equal(result.evidence[0]?.source, 'memory');
  assert.match(result.answer, /deterministische Recall-Vertraege/);
  assert.match(result.answer, /\(aus Memory 12\.07\.\)/);
  assert.deepEqual(result.searched, ['memory']);
});

test('unknown fact returns an honest full-ladder miss without invention', () => {
  const result = recall.runRecallContractForMessage(
    'Was weisst du ueber NonexistentZebraFact?',
    operatorOptions,
  );
  assert.ok(result);
  assert.equal(result.found, false);
  assert.deepEqual(result.searched, [
    'memory',
    'daily',
    'shared-index',
    'session-archive',
  ]);
  assert.match(result.answer, /nichts in meinen Quellen gefunden/);
  assert.match(result.answer, /Ich erfinde dazu nichts/);
  assert.doesNotMatch(result.answer, /ForeignSiloFact/);
});

test('ladder falls through Daily, shared index, then scoped session archive', () => {
  const cases = [
    ['DailyOnlyFact', 'daily', ['memory', 'daily'], 'aus Daily 11.07.'],
    [
      'IndexOnlyFact',
      'shared-index',
      ['memory', 'daily', 'shared-index'],
      'aus Shared-Memory-Index 09.07.',
    ],
    [
      'SessionOnlyFact',
      'session-archive',
      ['memory', 'daily', 'shared-index', 'session-archive'],
      'aus Session 11.07.',
    ],
  ] as const;
  for (const [topic, source, searched, citation] of cases) {
    const result = recall.runRecallContract(topic, operatorOptions);
    assert.equal(result.evidence[0]?.source, source);
    assert.deepEqual(result.searched, searched);
    assert.match(result.answer, new RegExp(citation.replaceAll('.', '\\.')));
  }
});

test('person bot cannot see foreign Memory, Daily, or shared-index silo data', () => {
  const result = recall.runRecallContractForMessage(
    'Was weisst du ueber ForeignSiloFact?',
    {
      scope: {
        kind: 'person',
        project: 'alina',
        botId: 'alina-check',
        sessionKey: 'alina-session',
        allowSessionArchive: true,
        allowOperatorFiles: false,
      },
      paths: { dailyDir, sharedIndexPath, transcriptDir },
    },
  );
  assert.ok(result);
  assert.equal(result.found, false);
  assert.deepEqual(result.searched, ['memory', 'session-archive']);
  assert.doesNotMatch(result.answer, /operator private context/);
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
