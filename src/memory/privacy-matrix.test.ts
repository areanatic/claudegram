/**
 * WAVE-2 fast-follow — deterministic privacy-matrix regression for the read-only
 * MCP memory helpers (`searchMemoryReadOnly` + `recentMemoriesReadOnly`).
 *
 * Run: npx tsx src/memory/privacy-matrix.test.ts
 *
 * Codex (cross_review_wave1-crossbot-t1-prereview, conf 0.86) required a deterministic
 * privacy-matrix test BEFORE the search tool's description may promise a /private
 * downgrade and before the fast-follow ships to Master. This proves the enforcement
 * engine (buildPrivacyClause via options.policy) across the full scope matrix:
 *
 *   policy.scope = 'public'        → ONLY privacy='public' rows (0 private leak)
 *   policy.scope = 'self_private'  → public + private-from-TRUSTED-source,
 *                                    but NEVER private-from-untrusted-source
 *   policy.scope = 'operator_all'  → everything (forensic; the MCP tools NEVER pass this —
 *                                    they downgrade operator_all → public at boot)
 *   /private on (tool path)        → effectivePolicy.scope forced to 'public'
 *                                    → identical to the public row-set even when the
 *                                      boot policy was self_private (the fast-follow fix)
 *   env default (nothing set)      → fail-closed scope='public'
 *
 * NEXUS_MEMORY_DB_PATH points the helpers at a throwaway seeded copy (the only reason
 * the path was made env-overridable; prod leaves it unset → identical behaviour).
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-privmatrix-'));
const DB_PATH = path.join(TMP, 'memory.db');
// Point the module's read-only helpers at our seeded throwaway DB BEFORE importing it.
process.env.NEXUS_MEMORY_DB_PATH = DB_PATH;
// Ensure no ambient scope/sources env bleeds into the env-default fail-closed assertion.
delete process.env.NEXUS_MEMORY_SCOPE;
delete process.env.NEXUS_TRUSTED_PRIVATE_SOURCES;

let pass = 0;
function check(cond: boolean, msg: string) {
  assert.equal(cond, true, msg);
  pass++;
}

// ── Seed a temp DB mirroring the live schema (memories + FTS5 + triggers) ──────
function seed() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('semantic', 'episodic')),
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

  // Common FTS keyword so a single query reaches every row; unique markers distinguish them.
  const KW = 'ZZMATRIXKEYWORD';
  const ins = db.prepare(
    `INSERT INTO memories (type, content, source, project, privacy, created_at)
     VALUES (@type, @content, @source, @project, @privacy, @created_at)`
  );
  // created_at strictly increasing so recency order is deterministic (untrusted-private is newest).
  ins.run({ type: 'semantic',  content: `${KW} PUB_ONE public row`,                source: 'nexusgram',           project: 'nexus',  privacy: 'public',  created_at: '2026-06-03T10:00:00' });
  ins.run({ type: 'semantic',  content: `${KW} PRIV_TRUST private trusted row`,     source: 'omi-bridge-task',     project: 'nexus',  privacy: 'private', created_at: '2026-06-03T10:01:00' });
  ins.run({ type: 'semantic',  content: `${KW} PUB_TWO another public row`,         source: 'link-inbox',          project: 'family', privacy: 'public',  created_at: '2026-06-03T10:02:00' });
  ins.run({ type: 'episodic',  content: `${KW} PRIV_UNTRUST private untrusted row`, source: 'scanner-pro-original', project: 'nexus',  privacy: 'private', created_at: '2026-06-03T10:03:00' });
  db.close();
  return { KW };
}

const { KW } = seed();

// Dynamic import AFTER env + seed so the module reads NEXUS_MEMORY_DB_PATH at load.
const mem = await import('./nexus-memory.js');
const {
  searchMemoryReadOnly,
  recentMemoriesReadOnly,
  readMemoryPolicyFromEnv,
  DEFAULT_TRUSTED_PRIVATE_SOURCES,
} = mem as typeof import('./nexus-memory.js');

type Policy = ReturnType<typeof readMemoryPolicyFromEnv>;
const trusted = [...DEFAULT_TRUSTED_PRIVATE_SOURCES];
const publicPolicy:      Policy = { scope: 'public',       trustedPrivateSources: trusted };
const selfPrivatePolicy: Policy = { scope: 'self_private', trustedPrivateSources: trusted };
const operatorAllPolicy: Policy = { scope: 'operator_all', trustedPrivateSources: trusted };

const has = (rows: { content: string }[], marker: string) => rows.some(r => r.content.includes(marker));
const markers = (rows: { content: string }[]) =>
  ['PUB_ONE', 'PUB_TWO', 'PRIV_TRUST', 'PRIV_UNTRUST'].filter(m => has(rows, m)).sort();

// ── searchMemoryReadOnly (FTS5 path) ──────────────────────────────────────────
{
  const pub = searchMemoryReadOnly(KW, 20, undefined, { policy: publicPolicy });
  check(has(pub, 'PUB_ONE') && has(pub, 'PUB_TWO'), 'search/public: both public rows visible');
  check(!has(pub, 'PRIV_TRUST'), 'search/public: trusted-private row HIDDEN');
  check(!has(pub, 'PRIV_UNTRUST'), 'search/public: untrusted-private row HIDDEN (0 private leak)');
  check(markers(pub).join(',') === 'PUB_ONE,PUB_TWO', `search/public: exactly the 2 public rows (got ${markers(pub)})`);

  const sp = searchMemoryReadOnly(KW, 20, undefined, { policy: selfPrivatePolicy });
  check(has(sp, 'PUB_ONE') && has(sp, 'PUB_TWO'), 'search/self_private: public rows visible');
  check(has(sp, 'PRIV_TRUST'), 'search/self_private: TRUSTED-private row visible');
  check(!has(sp, 'PRIV_UNTRUST'), 'search/self_private: UNtrusted-private row STILL hidden');
  check(markers(sp).join(',') === 'PRIV_TRUST,PUB_ONE,PUB_TWO', `search/self_private: public+trusted only (got ${markers(sp)})`);

  const all = searchMemoryReadOnly(KW, 20, undefined, { policy: operatorAllPolicy });
  check(markers(all).join(',') === 'PRIV_TRUST,PRIV_UNTRUST,PUB_ONE,PUB_TWO', `search/operator_all: every row (got ${markers(all)})`);

  // The fast-follow fix: /private on forces effectivePolicy.scope='public' even though
  // the boot policy is self_private → the trusted-private row must vanish.
  const privateModeEffective = searchMemoryReadOnly(KW, 20, undefined, { policy: { ...selfPrivatePolicy, scope: 'public' } });
  check(markers(privateModeEffective).join(',') === markers(pub).join(','),
    'search: /private-on effective policy == public row-set (trusted-private downgraded away)');
}

// ── recentMemoriesReadOnly (recency path, same buildPrivacyClause) ─────────────
{
  const pub = recentMemoriesReadOnly(20, undefined, { policy: publicPolicy });
  check(markers(pub).join(',') === 'PUB_ONE,PUB_TWO', `recent/public: only public rows (got ${markers(pub)})`);
  check(!has(pub, 'PRIV_TRUST') && !has(pub, 'PRIV_UNTRUST'), 'recent/public: no private leak');

  const sp = recentMemoriesReadOnly(20, undefined, { policy: selfPrivatePolicy });
  check(markers(sp).join(',') === 'PRIV_TRUST,PUB_ONE,PUB_TWO', `recent/self_private: public+trusted only (got ${markers(sp)})`);
  check(!has(sp, 'PRIV_UNTRUST'), 'recent/self_private: untrusted-private hidden');

  const all = recentMemoriesReadOnly(20, undefined, { policy: operatorAllPolicy });
  check(markers(all).join(',') === 'PRIV_TRUST,PRIV_UNTRUST,PUB_ONE,PUB_TWO', `recent/operator_all: every row (got ${markers(all)})`);
}

// ── env default must be fail-closed (no scope set → public) ────────────────────
{
  const envPolicy = readMemoryPolicyFromEnv();
  check(envPolicy.scope === 'public', `env default scope is fail-closed public (got ${envPolicy.scope})`);
  // No options.policy → helper falls back to readMemoryPolicyFromEnv() → public.
  const def = searchMemoryReadOnly(KW, 20);
  check(markers(def).join(',') === 'PUB_ONE,PUB_TWO', `search default (no policy): public-only fail-closed (got ${markers(def)})`);
}

// ── project filter must not bypass privacy ────────────────────────────────────
{
  // project=nexus contains PUB_ONE (public), PRIV_TRUST (trusted-private), PRIV_UNTRUST (untrusted-private).
  const pubNexus = searchMemoryReadOnly(KW, 20, 'nexus', { policy: publicPolicy });
  check(markers(pubNexus).join(',') === 'PUB_ONE', `search/public+project=nexus: only public nexus row (got ${markers(pubNexus)})`);
  const spNexus = searchMemoryReadOnly(KW, 20, 'nexus', { policy: selfPrivatePolicy });
  check(markers(spNexus).join(',') === 'PRIV_TRUST,PUB_ONE', `search/self_private+project=nexus: public+trusted, no untrusted (got ${markers(spNexus)})`);
}

// cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n✅ privacy-matrix: ${pass}/${pass} assertions passed`);
