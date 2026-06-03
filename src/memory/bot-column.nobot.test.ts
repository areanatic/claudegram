/**
 * BACKWARD-COMPAT (own process): DB has `privacy` column but NOT the additive `bot` column.
 * Run: npx tsx src/memory/bot-column.nobot.test.ts
 *
 * Must be a separate process because hasBotColumn()/hasPrivacyColumn() cache the FIRST
 * PRAGMA result for the whole module lifetime.
 *
 * Proves saveMemory takes the "privacy present, bot absent" branch (nexus-memory.ts:306-313):
 *  - returns a valid id (no crash on the missing column)
 *  - the row persists with privacy honoured, and reads back bot=null (column simply absent)
 *  - the read-only helper omits the bot select fragment → bot field defaults to null in output
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-nobot-'));
const DB_PATH = path.join(TMP, 'memory.db');
process.env.NEXUS_MEMORY_DB_PATH = DB_PATH;
delete process.env.NEXUS_MEMORY_SCOPE;
delete process.env.NEXUS_TRUSTED_PRIVATE_SOURCES;
process.env.BOT_NAME = 'Nexusgram';

let pass = 0;
function check(cond: boolean, msg: string) {
  assert.equal(cond, true, msg);
  pass++;
}

const KW = 'ZZNOBOTKW';

// Seed WITH privacy but WITHOUT the bot column (pre-T2-migration, post-privacy-migration).
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
      privacy TEXT NOT NULL DEFAULT 'public' CHECK(privacy IN ('public','private'))
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
const { saveMemory, searchMemoryReadOnly, recentMemoriesReadOnly, closeMemoryDb } =
  mem as typeof import('./nexus-memory.js');

const inspect = new Database(DB_PATH, { readonly: true });

// ── saveMemory still works (privacy branch, bot absent) — even with explicit bot param ─
{
  const id = saveMemory(`${KW} NOBOT public`, 'episodic', 'nexus', 't', 'nexusgram', 'public', 'astron-dev1');
  check(id !== null, 'saveMemory returns id on no-bot-column DB');
  const cols = inspect.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
  check(!cols.some(c => c.name === 'bot'), 'sanity: DB really has NO bot column');
  const row = inspect.prepare(`SELECT privacy FROM memories WHERE content LIKE ?`).get(`%NOBOT public%`) as { privacy: string };
  check(row.privacy === 'public', 'no-bot DB: privacy still persisted via privacy branch');

  // a private row to confirm privacy branch honours privacy even without bot
  const id2 = saveMemory(`${KW} NOBOT private`, 'semantic', 'nexus', 't', 'nexusgram', 'private', 'astron-dev1');
  check(id2 !== null, 'saveMemory private returns id on no-bot-column DB');
  const row2 = inspect.prepare(`SELECT privacy FROM memories WHERE content LIKE ?`).get(`%NOBOT private%`) as { privacy: string };
  check(row2.privacy === 'private', 'no-bot DB: private row honoured');
}

// ── read-only helpers omit bot fragment → bot=null in output, no crash ─────────
{
  const hits = searchMemoryReadOnly(KW, 20);   // env default scope=public
  const pub = hits.find(h => h.content.includes('NOBOT public'));
  check(!!pub, 'search finds the public row on no-bot DB');
  check(pub!.bot === null, `search output bot defaults to null when column absent (got ${JSON.stringify(pub!.bot)})`);
  check(!hits.some(h => h.content.includes('NOBOT private')), 'public scope still hides private row on no-bot DB');

  const rec = recentMemoriesReadOnly(20);
  const recPub = rec.find(h => h.content.includes('NOBOT public'));
  check(!!recPub && recPub.bot === null, 'recent output bot=null when column absent');
}

try { inspect.close(); } catch { /* ignore */ }
try { closeMemoryDb?.(); } catch { /* ignore */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n✅ bot-column.nobot: ${pass}/${pass} assertions passed`);
