/**
 * EDGE-CASE companion to privacy-matrix.test.ts — covers GAPS the happy-path
 * matrix did NOT exercise. Run: npx tsx src/memory/privacy-matrix.edge.test.ts
 *
 * Gaps targeted:
 *  - NEXUS_TRUSTED_PRIVATE_SOURCES env override (custom CSV) re-shapes the trusted set
 *  - EMPTY trusted list under scope=self_private → buildPrivacyClause MUST fall through
 *    to the public-only branch (a private row from ANY source stays hidden — no leak)
 *  - a source present in the DB but NOT in the (custom) allowlist + privacy=private → hidden
 *  - >32 trusted sources → MAX_TRUSTED_SOURCES cap (the 33rd+ silently dropped)
 *  - invalid slug in the CSV → rejected, valid neighbours survive
 *  - project filter never bypasses privacy (already in happy-path, re-proven on recent path)
 *  - archived rows EXCLUDED from recentMemoriesReadOnly even when policy would allow them
 *  - whitespace / dup entries in the CSV are trimmed + de-duped
 *  - score=0 fresh rows ARE surfaced by recent (no score>0.3 floor on the read-only recency path)
 *
 * Uses NEXUS_MEMORY_DB_PATH → throwaway seeded DB (post-migration shape, with bot column
 * so it also exercises the additive-column read path).
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-privedge-'));
const DB_PATH = path.join(TMP, 'memory.db');
process.env.NEXUS_MEMORY_DB_PATH = DB_PATH;
delete process.env.NEXUS_MEMORY_SCOPE;
delete process.env.NEXUS_TRUSTED_PRIVATE_SOURCES;

let pass = 0;
function check(cond: boolean, msg: string) {
  assert.equal(cond, true, msg);
  pass++;
}

const KW = 'ZZPRIVEDGEKW';

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
  const ins = db.prepare(
    `INSERT INTO memories (type, content, source, project, privacy, score, archived, created_at)
     VALUES (@type,@content,@source,@project,@privacy,@score,@archived,@created_at)`
  );
  // A public row, a private row from a CUSTOM-trusted source, a private row from a
  // source that is in the DEFAULT list but NOT in our custom override, an archived
  // public row, and a fresh score=0 public row.
  ins.run({ type: 'semantic', content: `${KW} PUB public row`,                 source: 'nexusgram',     project: 'nexus',  privacy: 'public',  score: 1.0, archived: 0, created_at: '2026-06-03T10:00:00' });
  ins.run({ type: 'semantic', content: `${KW} PRIV_CUSTOM custom trusted`,      source: 'my-custom-src', project: 'nexus',  privacy: 'private', score: 1.0, archived: 0, created_at: '2026-06-03T10:01:00' });
  ins.run({ type: 'semantic', content: `${KW} PRIV_DEFAULT default-trusted`,    source: 'omi',           project: 'nexus',  privacy: 'private', score: 1.0, archived: 0, created_at: '2026-06-03T10:02:00' });
  ins.run({ type: 'semantic', content: `${KW} PUB_ARCHIVED archived public`,    source: 'nexusgram',     project: 'family', privacy: 'public',  score: 1.0, archived: 1, created_at: '2026-06-03T10:03:00' });
  ins.run({ type: 'semantic', content: `${KW} PUB_ZERO fresh zero-score`,       source: 'nexusgram',     project: 'nexus',  privacy: 'public',  score: 0.0, archived: 0, created_at: '2026-06-03T10:04:00' });
  db.close();
}
seed();

const mem = await import('./nexus-memory.js');
const {
  searchMemoryReadOnly,
  recentMemoriesReadOnly,
  readMemoryPolicyFromEnv,
  DEFAULT_TRUSTED_PRIVATE_SOURCES,
} = mem as typeof import('./nexus-memory.js');

type Policy = ReturnType<typeof readMemoryPolicyFromEnv>;
const has = (rows: { content: string }[], m: string) => rows.some(r => r.content.includes(m));
const markers = (rows: { content: string }[]) =>
  ['PUB ', 'PRIV_CUSTOM', 'PRIV_DEFAULT', 'PUB_ARCHIVED', 'PUB_ZERO'].filter(m => has(rows, m)).sort();

// ── 1. Custom CSV override re-shapes the trusted set ───────────────────────────
{
  // Only 'my-custom-src' is trusted now; 'omi' (a DEFAULT) is NOT.
  const pol: Policy = { scope: 'self_private', trustedPrivateSources: ['my-custom-src'] };
  const rows = searchMemoryReadOnly(KW, 20, undefined, { policy: pol });
  check(has(rows, 'PRIV_CUSTOM'), 'custom-CSV: private row from custom-trusted source IS visible');
  check(!has(rows, 'PRIV_DEFAULT'), 'custom-CSV: private row from a DEFAULT source NOT in the override is HIDDEN');
  check(has(rows, 'PUB public'), 'custom-CSV: public row always visible');
}

// ── 2. env override path (readMemoryPolicyFromEnv parses NEXUS_TRUSTED_PRIVATE_SOURCES) ─
{
  process.env.NEXUS_MEMORY_SCOPE = 'self_private';
  process.env.NEXUS_TRUSTED_PRIVATE_SOURCES = '  my-custom-src , my-custom-src ,, omi ';
  const envPol = readMemoryPolicyFromEnv();
  check(envPol.scope === 'self_private', 'env: scope parsed self_private');
  check(envPol.trustedPrivateSources.length === 2, `env: whitespace trimmed + dup deduped → 2 (got ${envPol.trustedPrivateSources.length}: ${envPol.trustedPrivateSources})`);
  check(envPol.trustedPrivateSources.includes('my-custom-src') && envPol.trustedPrivateSources.includes('omi'),
    'env: both distinct trimmed sources retained');
  const rows = searchMemoryReadOnly(KW, 20); // no explicit policy → uses env
  check(has(rows, 'PRIV_CUSTOM') && has(rows, 'PRIV_DEFAULT'),
    'env: both env-trusted private rows visible via env-derived policy');
  delete process.env.NEXUS_MEMORY_SCOPE;
  delete process.env.NEXUS_TRUSTED_PRIVATE_SOURCES;
}

// ── 3. EMPTY trusted list under self_private → behaves like public (no leak) ────
{
  const pol: Policy = { scope: 'self_private', trustedPrivateSources: [] };
  const rows = searchMemoryReadOnly(KW, 20, undefined, { policy: pol });
  check(!has(rows, 'PRIV_CUSTOM') && !has(rows, 'PRIV_DEFAULT'),
    'empty-trusted self_private: NO private row leaks (falls through to public branch)');
  check(has(rows, 'PUB public'), 'empty-trusted self_private: public rows still visible');
  // recent path identical
  const rec = recentMemoriesReadOnly(20, undefined, { policy: pol });
  check(!has(rec, 'PRIV_CUSTOM') && !has(rec, 'PRIV_DEFAULT'),
    'empty-trusted self_private (recent): no private leak');
}

// ── 4. CSV with an INVALID slug → rejected, valid neighbours survive ───────────
{
  process.env.NEXUS_TRUSTED_PRIVATE_SOURCES = 'my-custom-src,bad source!,omi'; // "bad source!" has space+!
  const p = readMemoryPolicyFromEnv();
  check(!p.trustedPrivateSources.includes('bad source!'), 'invalid-slug: "bad source!" rejected');
  check(p.trustedPrivateSources.includes('my-custom-src') && p.trustedPrivateSources.includes('omi'),
    `invalid-slug: valid neighbours survived (got ${p.trustedPrivateSources})`);
  check(p.trustedPrivateSources.length === 2, `invalid-slug: exactly the 2 valid (got ${p.trustedPrivateSources.length})`);
  delete process.env.NEXUS_TRUSTED_PRIVATE_SOURCES;
}

// ── 5. >32 trusted sources → MAX_TRUSTED_SOURCES cap at 32 ──────────────────────
{
  const fifty = Array.from({ length: 50 }, (_, i) => `src-${i}`).join(',');
  process.env.NEXUS_TRUSTED_PRIVATE_SOURCES = fifty;
  const p = readMemoryPolicyFromEnv();
  check(p.trustedPrivateSources.length === 32, `max-cap: 50 sources capped to 32 (got ${p.trustedPrivateSources.length})`);
  check(p.trustedPrivateSources[0] === 'src-0' && p.trustedPrivateSources[31] === 'src-31',
    'max-cap: first 32 kept in order, 33rd+ dropped');
  delete process.env.NEXUS_TRUSTED_PRIVATE_SOURCES;
}

// ── 6. archived rows excluded from recent even under operator_all ───────────────
{
  const trusted = [...DEFAULT_TRUSTED_PRIVATE_SOURCES];
  const opAll: Policy = { scope: 'operator_all', trustedPrivateSources: trusted };
  const rec = recentMemoriesReadOnly(20, undefined, { policy: opAll });
  check(!has(rec, 'PUB_ARCHIVED'), 'recent/operator_all: archived row EXCLUDED (archived=0 filter holds)');
  check(has(rec, 'PRIV_CUSTOM') && has(rec, 'PRIV_DEFAULT'), 'recent/operator_all: both private rows visible (forensic)');
  // search path DOES include archived (by design) — re-prove the asymmetry.
  const srch = searchMemoryReadOnly(KW, 20, undefined, { policy: opAll });
  check(has(srch, 'PUB_ARCHIVED'), 'search/operator_all: archived row INCLUDED (search has no archived filter — surprising-but-by-design)');
}

// ── 7. fresh score=0 row surfaced by recent (no score>0.3 floor on read-only path) ─
{
  const trusted = [...DEFAULT_TRUSTED_PRIVATE_SOURCES];
  const pub: Policy = { scope: 'public', trustedPrivateSources: trusted };
  const rec = recentMemoriesReadOnly(20, undefined, { policy: pub });
  check(has(rec, 'PUB_ZERO'), 'recent: fresh score=0 row surfaced (recency tool intentionally drops the score>0.3 floor)');
}

// ── 8. project filter never bypasses privacy (recent path, family project) ──────
{
  const trusted = [...DEFAULT_TRUSTED_PRIVATE_SOURCES];
  // PUB_ARCHIVED is the only family row and it is archived → recent/family must be empty.
  const pub: Policy = { scope: 'public', trustedPrivateSources: trusted };
  const recFam = recentMemoriesReadOnly(20, 'family', { policy: pub });
  check(recFam.length === 0, `recent/public+project=family: empty (only family row is archived) (got ${recFam.length})`);
  // nexus project under public: PUB + PUB_ZERO, never the private rows
  const recNexus = recentMemoriesReadOnly(20, 'nexus', { policy: pub });
  check(!has(recNexus, 'PRIV_CUSTOM') && !has(recNexus, 'PRIV_DEFAULT'),
    'recent/public+project=nexus: project filter does NOT bypass privacy');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n✅ privacy-matrix.edge: ${pass}/${pass} assertions passed`);
