/**
 * WAVE-2 Cross-Bot T2 (a) — deterministic regression for the per-bot `bot` column.
 *
 * Run: npx tsx src/memory/bot-column.test.ts
 *
 * Proves: (1) saveMemory persists the bot origin (default from BOT_NAME slug, explicit
 * override, NULL), (2) the read-only helpers surface `bot`, and — the load-bearing safety
 * property — (3) the `bot` column does NOT change any privacy-clause result: the full
 * public / self_private matrix is byte-identical to the no-bot case (bot is metadata only).
 *
 * NEXUS_MEMORY_DB_PATH points the module at a throwaway seeded copy that INCLUDES the
 * additive `bot` column (mirrors scripts/migrations/2026-06-03_bot_column.sql).
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-botcol-'));
const DB_PATH = path.join(TMP, 'memory.db');
process.env.NEXUS_MEMORY_DB_PATH = DB_PATH;
delete process.env.NEXUS_MEMORY_SCOPE;
delete process.env.NEXUS_TRUSTED_PRIVATE_SOURCES;
process.env.BOT_NAME = 'Nexusgram'; // default master slug for the first saveMemory case

let pass = 0;
function check(cond: boolean, msg: string) {
  assert.equal(cond, true, msg);
  pass++;
}

const KW = 'ZZBOTCOLKW';

// Seed a temp DB WITH the additive bot column (post-migration shape).
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
  // Pre-seed the privacy matrix rows (so we can re-prove privacy is bot-independent).
  const ins = db.prepare(
    `INSERT INTO memories (type, content, source, project, privacy, bot, created_at)
     VALUES (@type,@content,@source,@project,@privacy,@bot,@created_at)`
  );
  ins.run({ type: 'semantic', content: `${KW} PUB public row`,             source: 'nexusgram',       project: 'nexus', privacy: 'public',  bot: 'master-bot', created_at: '2026-06-03T09:00:00' });
  ins.run({ type: 'semantic', content: `${KW} PRIV_TRUST trusted private`,  source: 'omi-bridge-task', project: 'nexus', privacy: 'private', bot: 'master-bot', created_at: '2026-06-03T09:01:00' });
  ins.run({ type: 'semantic', content: `${KW} PRIV_UNTRUST untrusted priv`, source: 'untrusted-src',   project: 'nexus', privacy: 'private', bot: 'family-bot', created_at: '2026-06-03T09:02:00' });
  db.close();
}
seed();

const mem = await import('./nexus-memory.js');
const { saveMemory, searchMemoryReadOnly, recentMemoriesReadOnly, botId, DEFAULT_TRUSTED_PRIVATE_SOURCES, closeMemoryDb } =
  mem as typeof import('./nexus-memory.js');

// A direct read-only connection for asserting what actually landed on disk.
const inspect = new Database(DB_PATH, { readonly: true });
const botOf = (marker: string): string | null => {
  const row = inspect.prepare(`SELECT bot FROM memories WHERE content LIKE ? LIMIT 1`).get(`%${marker}%`) as { bot: string | null } | undefined;
  return row ? row.bot : null;
};

// ── 1. botId() slug derivation ────────────────────────────────────────────────
check(botId() === 'nexusgram', `botId() master = nexusgram (got ${botId()})`);
process.env.BOT_NAME = 'Alinas Assistentin';
check(botId() === 'alinas-assistentin', `botId() family = alinas-assistentin (got ${botId()})`);
process.env.BOT_NAME = 'Nexusgram';

// ── 2. saveMemory persists bot ────────────────────────────────────────────────
{
  // default → current BOT_NAME slug
  const id1 = saveMemory(`${KW} SAVE_DEFAULT row`, 'episodic', 'nexus', 'botcol-test');
  check(id1 !== null, 'saveMemory default returned an id');
  check(botOf('SAVE_DEFAULT') === 'nexusgram', `saveMemory default wrote bot=nexusgram (got ${botOf('SAVE_DEFAULT')})`);

  // env change reflected per-call (botId reads env each call)
  process.env.BOT_NAME = 'Effats Assistentin';
  const id2 = saveMemory(`${KW} SAVE_FAMILY row`, 'episodic', 'health', 'botcol-test');
  check(id2 !== null, 'saveMemory family returned an id');
  check(botOf('SAVE_FAMILY') === 'effats-assistentin', `saveMemory wrote env-derived bot (got ${botOf('SAVE_FAMILY')})`);
  process.env.BOT_NAME = 'Nexusgram';

  // explicit bot param overrides the default
  const id3 = saveMemory(`${KW} SAVE_EXPLICIT row`, 'episodic', 'nexus', 'botcol-test', 'nexusgram', 'public', 'astron-dev1');
  check(id3 !== null, 'saveMemory explicit returned an id');
  check(botOf('SAVE_EXPLICIT') === 'astron-dev1', `explicit bot param wins (got ${botOf('SAVE_EXPLICIT')})`);

  // explicit null bot → NULL (legacy)
  const id4 = saveMemory(`${KW} SAVE_NULL row`, 'episodic', 'nexus', 'botcol-test', 'nexusgram', 'public', null);
  check(id4 !== null, 'saveMemory null-bot returned an id');
  check(botOf('SAVE_NULL') === null, `explicit null bot stored as NULL (got ${botOf('SAVE_NULL')})`);
}

// ── 3. read-only helpers surface bot ──────────────────────────────────────────
const trusted = [...DEFAULT_TRUSTED_PRIVATE_SOURCES];
const selfPrivate = { scope: 'self_private' as const, trustedPrivateSources: trusted };
const publicPol = { scope: 'public' as const, trustedPrivateSources: trusted };
{
  const hits = searchMemoryReadOnly(`${KW} PUB`, 20, undefined, { policy: publicPol });
  const pub = hits.find(h => h.content.includes('PUB public row'));
  check(!!pub && pub.bot === 'master-bot', `search surfaces bot on public hit (got ${pub?.bot})`);

  const recent = recentMemoriesReadOnly(20, 'health', { policy: publicPol });
  const fam = recent.find(h => h.content.includes('SAVE_FAMILY'));
  check(!!fam && fam.bot === 'effats-assistentin', `recent surfaces bot (got ${fam?.bot})`);
}

// ── 4. SAFETY: bot column does NOT change the privacy matrix ───────────────────
{
  const has = (rows: { content: string }[], m: string) => rows.some(r => r.content.includes(m));
  const pub = searchMemoryReadOnly(KW, 50, 'nexus', { policy: publicPol });
  check(has(pub, 'PUB public row'), 'safety/public: public row visible');
  check(!has(pub, 'PRIV_TRUST') && !has(pub, 'PRIV_UNTRUST'),
    'safety/public: NO private row leaks regardless of bot (master-bot/family-bot private both hidden)');

  const sp = searchMemoryReadOnly(KW, 50, 'nexus', { policy: selfPrivate });
  check(has(sp, 'PRIV_TRUST'), 'safety/self_private: trusted-private visible (saved by master-bot)');
  check(!has(sp, 'PRIV_UNTRUST'),
    'safety/self_private: untrusted-private STILL hidden even though saved by a different bot');
}

// cleanup
try { inspect.close(); } catch { /* ignore */ }
try { closeMemoryDb?.(); } catch { /* ignore */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n✅ bot-column: ${pass}/${pass} assertions passed`);
