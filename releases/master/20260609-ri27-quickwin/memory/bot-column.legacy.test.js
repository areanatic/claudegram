/**
 * BACKWARD-COMPAT (own process): TRUE pre-migration DB — NO privacy column AND NO bot column.
 * Run: npx tsx src/memory/bot-column.legacy.test.ts
 *
 * Separate process because hasPrivacyColumn()/hasBotColumn() are cached per module lifetime.
 *
 * Proves saveMemory takes the pre-migration fallback branch (nexus-memory.ts:315-321):
 *  - returns a valid id (the privacy + bot params are simply ignored, no crash)
 *  - row persists with content/source/project; privacy/bot columns don't exist
 *  - buildPrivacyClause returns '' (no privacy column) → BUT searchMemoryReadOnly hardcodes
 *    `SELECT ... m.privacy, m.source` so the PREPARE itself throws on a pre-migration DB and
 *    the catch returns [] (fail-empty, NOT a leak). recentMemoriesReadOnly does NOT select
 *    m.privacy and therefore works and returns the row. We assert this ACTUAL asymmetry and
 *    flag it as a robustness GAP (see FINDINGS at end of file).
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-legacy-'));
const DB_PATH = path.join(TMP, 'memory.db');
process.env.NEXUS_MEMORY_DB_PATH = DB_PATH;
delete process.env.NEXUS_MEMORY_SCOPE;
delete process.env.NEXUS_TRUSTED_PRIVATE_SOURCES;
process.env.BOT_NAME = 'Nexusgram';
let pass = 0;
function check(cond, msg) {
    assert.equal(cond, true, msg);
    pass++;
}
const KW = 'ZZLEGACYKW';
// Seed a TRUE pre-migration table: no privacy, no bot.
function seed() {
    const db = new Database(DB_PATH);
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
      file_path TEXT
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
}
seed();
const mem = await import('./nexus-memory.js');
const { saveMemory, searchMemoryReadOnly, recentMemoriesReadOnly, closeMemoryDb, DEFAULT_TRUSTED_PRIVATE_SOURCES } = mem;
const inspect = new Database(DB_PATH, { readonly: true });
// ── saveMemory pre-migration fallback (privacy + bot params ignored, no crash) ─
{
    // Pass privacy='private' + bot — both must be silently ignored on this legacy DB.
    const id = saveMemory(`${KW} LEGACY would-be-private`, 'semantic', 'nexus', 't', 'nexusgram', 'private', 'astron-dev1');
    check(id !== null, 'saveMemory returns id on pre-migration DB (no crash on ignored privacy/bot params)');
    const cols = inspect.prepare(`PRAGMA table_info(memories)`).all();
    check(!cols.some(c => c.name === 'privacy') && !cols.some(c => c.name === 'bot'), 'sanity: DB really has NEITHER privacy NOR bot column');
    const row = inspect.prepare(`SELECT content, source, project FROM memories WHERE content LIKE ?`).get(`%LEGACY would-be%`);
    check(row.source === 'nexusgram' && row.project === 'nexus', 'legacy row persisted with source+project');
}
// ── GAP: searchMemoryReadOnly is non-functional on a pre-migration DB ──────────
// It hardcodes `SELECT ... m.privacy, m.source` (nexus-memory.ts:420). On a DB with no
// privacy column the PREPARE throws (SqliteError: no such column: m.privacy) → caught →
// returns []. So search returns NOTHING (fail-empty). This is NOT a privacy leak, but it
// IS a robustness gap: on a pre-migration DB the keyword search tool silently yields zero.
{
    const hits = searchMemoryReadOnly(KW, 20); // scope=public env default
    check(hits.length === 0, `GAP: searchMemoryReadOnly returns [] on pre-migration DB (m.privacy SELECT throws → catch → []) (got ${hits.length})`);
    // self_private path is identical — the SELECT (not the privacy clause) is what throws.
    const trusted = [...DEFAULT_TRUSTED_PRIVATE_SOURCES];
    const sp = searchMemoryReadOnly(KW, 20, undefined, { policy: { scope: 'self_private', trustedPrivateSources: trusted } });
    check(sp.length === 0, 'GAP: search self_private also [] on pre-migration DB (same hardcoded SELECT)');
}
// ── recentMemoriesReadOnly DOES work pre-migration (does not SELECT m.privacy) ──
// Asymmetry vs search: recent only selects content/tags/project/score/created_at(+bot if
// present), so its PREPARE succeeds and the row is returned. Because there is no privacy
// column, the "private"-intended row IS surfaced (documented "pre-migration ⇒ effectively
// public" posture — exactly why the privacy migration must run before private mode is trusted).
{
    const rec = recentMemoriesReadOnly(20); // scope=public env default
    check(rec.some(h => h.content.includes('LEGACY would-be-private')), 'pre-migration: recent surfaces the "private"-intended row (no privacy column to gate — SURPRISING-but-documented)');
    check(rec[0].bot === null, 'pre-migration: recent bot field null (no column)');
}
try {
    inspect.close();
}
catch { /* ignore */ }
try {
    closeMemoryDb?.();
}
catch { /* ignore */ }
try {
    fs.rmSync(TMP, { recursive: true, force: true });
}
catch { /* ignore */ }
console.log(`\n✅ bot-column.legacy: ${pass}/${pass} assertions passed`);
/* FINDINGS (do NOT fix source from here — parallel session owns the file gate):
 * GAP-1 (robustness, NOT a security leak): searchMemoryReadOnly is non-functional on a
 *   pre-migration DB. nexus-memory.ts:420 hardcodes `SELECT ... m.privacy, m.source`; on a
 *   DB without a `privacy` column the prepare() throws (no such column: m.privacy), the
 *   catch logs and returns []. recentMemoriesReadOnly (line 522) does NOT select m.privacy
 *   so it works. Net effect: on a pre-migration DB the nexus_memory_search MCP tool always
 *   returns zero hits while nexus_memory_recent works — a silent, asymmetric degradation.
 *   saveMemory's hasPrivacyColumn() guard correctly avoids this on the WRITE path; the READ
 *   path has no equivalent guard. Low live-risk (the live DB already has privacy), but a real
 *   gap the happy-path tests (which always seed the privacy column) never exercised. */
//# sourceMappingURL=bot-column.legacy.test.js.map