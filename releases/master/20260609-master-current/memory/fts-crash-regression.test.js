import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-ftscrash-'));
const DB_PATH = path.join(TMP, 'memory.db');
process.env.NEXUS_MEMORY_DB_PATH = DB_PATH;
delete process.env.NEXUS_MEMORY_SCOPE;
delete process.env.NEXUS_TRUSTED_PRIVATE_SOURCES;
process.env.BOT_NAME = 'Nexusgram';
let pass = 0;
let fail = 0;
function check(cond, msg) {
    if (cond) {
        pass++;
    }
    else {
        fail++;
        console.error(`  ❌ FAIL: ${msg}`);
    }
}
function seed() {
    const db = new Database(DB_PATH);
    db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('semantic','episodic')),
      content TEXT NOT NULL, source TEXT, project TEXT, tags TEXT,
      score REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
      last_accessed TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
      access_count INTEGER NOT NULL DEFAULT 0, decay_rate REAL NOT NULL DEFAULT 0.02,
      archived INTEGER NOT NULL DEFAULT 0, file_path TEXT,
      privacy TEXT NOT NULL DEFAULT 'public' CHECK(privacy IN ('public','private')),
      bot TEXT
    );
    CREATE INDEX idx_memories_bot ON memories(bot);
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      content, tags, project, content=memories, content_rowid=id,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags, project)
      VALUES (new.id, new.content, new.tags, new.project);
    END;
  `);
    // A memory that contains the words OMI and Sync, but NOT the exact phrase "OMI-Sync Mai"
    // (so the phrase-pass returns 0 and the token-fallback runs — the crash path).
    const ins = db.prepare(`INSERT INTO memories (type, content, project) VALUES ('semantic', ?, 'test')`);
    ins.run('OMI Sync status: seit dem 24. Mai keine Sessions mehr extrahierbar, Workaround gebaut');
    ins.run('Auto Continue feature for voice timeouts works');
    ins.run('Cross Bot Awareness across the family');
    db.close();
}
seed();
// import AFTER env + seed (module reads NEXUS_MEMORY_DB_PATH and caches column checks)
const { searchMemoryReadOnly } = await import('./nexus-memory.js');
// Every one of these is a real thing a user types. NONE may throw.
const HOSTILE_QUERIES = [
    ['OMI-Sync Mai', 'hyphen → FTS5 reads as column-negation "no such column: Sync" (the live bug)'],
    ['Auto-Continue', 'hyphenated common project term'],
    ['Cross-Bot Awareness', 'hyphenated'],
    ['e-mail check', 'hyphenated everyday word'],
    ['Sync AND Mai', 'bare AND operator'],
    ['Sync OR Mai', 'bare OR operator'],
    ['NOT found here', 'bare NOT operator'],
    ['Sync NEAR Mai', 'bare NEAR operator'],
    ['status: Mai', 'colon → column-filter syntax'],
    ['@handle test', 'at-sign'],
    ['unbalanced " quote', 'lone double-quote'],
    ['wildcard*', 'trailing star'],
    ['^anchor', 'caret anchor'],
    ['(group) test', 'parens'],
];
console.log('\n=== FTS5 crash-regression: none of these user inputs may throw ===');
let threw = 0;
for (const [q, why] of HOSTILE_QUERIES) {
    try {
        const r = searchMemoryReadOnly(q, 5);
        check(Array.isArray(r), `returns array for ${JSON.stringify(q)}`);
        console.log(`  ✅ no-throw  ${JSON.stringify(q).padEnd(28)} → ${r.length} hits  (${why})`);
    }
    catch (e) {
        threw++;
        check(false, `THREW on ${JSON.stringify(q)}: ${e.message}`);
        console.log(`  💥 THREW    ${JSON.stringify(q).padEnd(28)} → ${e.message}`);
    }
}
// The load-bearing assertion: a hyphenated query MUST still FIND the memory, not silently
// return [] (the silent-failure that made the bot say "nothing found" about OMI).
console.log('\n=== correctness: hyphenated query must still FIND the memory (not silent-empty) ===');
const omiHit = searchMemoryReadOnly('OMI-Sync', 5);
check(omiHit.length > 0, `"OMI-Sync" finds the OMI memory (got ${omiHit.length} hits — 0 = the silent-failure bug)`);
console.log(`  ${omiHit.length > 0 ? '✅' : '❌'} "OMI-Sync" → ${omiHit.length} hits (must be ≥1)`);
const autoHit = searchMemoryReadOnly('Auto-Continue', 5);
check(autoHit.length > 0, `"Auto-Continue" finds its memory (got ${autoHit.length})`);
console.log(`  ${autoHit.length > 0 ? '✅' : '❌'} "Auto-Continue" → ${autoHit.length} hits (must be ≥1)`);
console.log(`\n${fail === 0 ? '✅' : '❌'} FTS crash-regression: ${pass} passed, ${fail} failed, ${threw} threw`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
//# sourceMappingURL=fts-crash-regression.test.js.map