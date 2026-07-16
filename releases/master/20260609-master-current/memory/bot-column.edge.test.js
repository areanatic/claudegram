/**
 * EDGE-CASE companion to bot-column.test.ts. Run: npx tsx src/memory/bot-column.edge.test.ts
 *
 * Gaps targeted (POST-migration DB shape — bot + privacy columns present):
 *  - botId() slug derivation for unicode / leading+trailing+inner whitespace / very long /
 *    EMPTY BOT_NAME (→ default 'Nexusgram' slug) / tab+newline whitespace
 *  - botId() does NOT apply SOURCE_SLUG_REGEX — special chars pass through verbatim
 *    (documented behaviour: bot is metadata only, never used in a privacy IN-list)
 *  - saveMemory: explicit bot='' (empty string) is stored as NULL (|| null short-circuits)
 *  - saveMemory: explicit bot=null stored as NULL; whitespace-only BOT_NAME default behaviour
 *  - saveMemory persists very-long + unicode bot slug verbatim (no truncation, no slug filter)
 *  - source param ('source' col) accepts a non-allowlist value verbatim (it's free-text on write;
 *    the allowlist only gates READ visibility) and that row stays HIDDEN under self_private
 *
 * The pre-migration fallbacks (NO bot column / NO privacy+bot column) live in their OWN
 * processes (bot-column.nobot.test.ts / bot-column.legacy.test.ts) because hasBotColumn /
 * hasPrivacyColumn are cached module-level singletons after the first PRAGMA check.
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-botedge-'));
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
const KW = 'ZZBOTEDGEKW';
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
      file_path TEXT,
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
    db.close();
}
seed();
const mem = await import('./nexus-memory.js');
const { saveMemory, botId, DEFAULT_TRUSTED_PRIVATE_SOURCES, searchMemoryReadOnly, closeMemoryDb } = mem;
const inspect = new Database(DB_PATH, { readonly: true });
const botOf = (marker) => {
    const row = inspect.prepare(`SELECT bot FROM memories WHERE content LIKE ? LIMIT 1`).get(`%${marker}%`);
    return row ? row.bot : null;
};
// ── 1. botId() slug derivation edge cases ──────────────────────────────────────
{
    process.env.BOT_NAME = ''; // empty → default fallback
    check(botId() === 'nexusgram', `botId() empty BOT_NAME → default nexusgram (got ${botId()})`);
    process.env.BOT_NAME = '   '; // whitespace only → NOT empty, falls through
    // '   '.toLowerCase().replace(/\s+/g,'-') === '-'  (one collapsed run, leading+trailing)
    check(botId() === '-', `botId() whitespace-only → '-' (collapsed run) (got ${JSON.stringify(botId())})`);
    process.env.BOT_NAME = '  Multi   Word\tName \n'; // mixed inner/edge whitespace incl tab/newline
    check(botId() === '-multi-word-name-', `botId() collapses all \\s+ runs incl tab/newline (got ${JSON.stringify(botId())})`);
    process.env.BOT_NAME = 'Alinas Ärztin Über'; // unicode (umlauts) preserved, NOT regex-filtered
    check(botId() === 'alinas-ärztin-über', `botId() preserves unicode verbatim (got ${botId()})`);
    process.env.BOT_NAME = '日本 ボット'; // non-latin
    check(botId() === '日本-ボット', `botId() preserves CJK verbatim (got ${botId()})`);
    process.env.BOT_NAME = 'Bot!@#$%^&*()'; // special chars — NO SOURCE_SLUG_REGEX on botId
    check(botId() === 'bot!@#$%^&*()', `botId() does NOT slug-sanitize special chars (got ${botId()})`);
    const longName = 'X'.repeat(500);
    process.env.BOT_NAME = longName;
    check(botId() === longName.toLowerCase(), `botId() very-long name not truncated (len ${botId().length})`);
    process.env.BOT_NAME = 'Nexusgram'; // restore
}
// ── 2. saveMemory: explicit bot='' → NULL (|| null) ────────────────────────────
{
    const id = saveMemory(`${KW} EMPTY_BOT row`, 'episodic', 'nexus', 't', 'nexusgram', 'public', '');
    check(id !== null, 'saveMemory explicit empty bot returned id');
    check(botOf('EMPTY_BOT') === null, `explicit bot='' stored as NULL (got ${JSON.stringify(botOf('EMPTY_BOT'))})`);
}
// ── 3. saveMemory: explicit bot=null → NULL ────────────────────────────────────
{
    const id = saveMemory(`${KW} NULL_BOT row`, 'episodic', 'nexus', 't', 'nexusgram', 'public', null);
    check(id !== null, 'saveMemory explicit null bot returned id');
    check(botOf('NULL_BOT') === null, `explicit bot=null stored as NULL (got ${JSON.stringify(botOf('NULL_BOT'))})`);
}
// ── 4. saveMemory persists unicode/long bot slug verbatim (default path) ────────
{
    process.env.BOT_NAME = 'Alinas Ärztin';
    const id = saveMemory(`${KW} UNICODE_BOT row`, 'episodic', 'nexus', 't');
    check(id !== null, 'saveMemory unicode-bot returned id');
    check(botOf('UNICODE_BOT') === 'alinas-ärztin', `default bot stores unicode slug verbatim (got ${botOf('UNICODE_BOT')})`);
    const longSlug = 'y'.repeat(300);
    const id2 = saveMemory(`${KW} LONG_BOT row`, 'episodic', 'nexus', 't', 'nexusgram', 'public', longSlug);
    check(id2 !== null, 'saveMemory long-bot returned id');
    check(botOf('LONG_BOT') === longSlug, `explicit long bot slug stored untruncated (len ${botOf('LONG_BOT')?.length})`);
    process.env.BOT_NAME = 'Nexusgram';
}
// ── 5. whitespace-only BOT_NAME on the saveMemory default path ──────────────────
{
    process.env.BOT_NAME = '   ';
    const id = saveMemory(`${KW} WS_BOT row`, 'episodic', 'nexus', 't');
    check(id !== null, 'saveMemory whitespace-bot returned id');
    check(botOf('WS_BOT') === '-', `whitespace-only BOT_NAME default → bot='-' stored (got ${JSON.stringify(botOf('WS_BOT'))})`);
    process.env.BOT_NAME = 'Nexusgram';
}
// ── 6. source col accepts non-allowlist free-text on WRITE; READ still gates it ─
{
    // Write a PRIVATE row whose source is NOT in the trusted allowlist.
    const id = saveMemory(`${KW} ROGUE private row`, 'semantic', 'nexus', 't', 'totally-not-trusted', 'private', 'rogue-bot');
    check(id !== null, 'saveMemory accepts arbitrary source on write');
    // Direct disk check: row landed with that source + privacy.
    const disk = inspect.prepare(`SELECT source, privacy FROM memories WHERE content LIKE ?`).get(`%ROGUE%`);
    check(disk.source === 'totally-not-trusted' && disk.privacy === 'private', 'rogue private row persisted with free-text source');
    // READ under self_private with DEFAULT trusted list → MUST stay hidden.
    const trusted = [...DEFAULT_TRUSTED_PRIVATE_SOURCES];
    const sp = searchMemoryReadOnly(KW, 20, undefined, { policy: { scope: 'self_private', trustedPrivateSources: trusted } });
    check(!sp.some(r => r.content.includes('ROGUE')), 'rogue private row from non-allowlist source HIDDEN under self_private (read-gate holds)');
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
console.log(`\n✅ bot-column.edge: ${pass}/${pass} assertions passed`);
//# sourceMappingURL=bot-column.edge.test.js.map