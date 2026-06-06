/**
 * T3 / RI-25 regression — OMI-Bridge watcher privacy postcondition must only
 * assert about the sources the watcher's phases actually WRITE.
 *
 * Run: npx tsx src/scanners/omi-bridge-watcher.postcondition.test.ts
 *
 * Bug (2026-05-27 → -06-07, Codex M-11 GO 0.88): the postcondition checked the
 * broad TRUSTED_PRIVATE_SOURCES list, which also contains `nexusgram`,
 * `link-inbox` and `auto-index`. Those legitimately hold public rows (shared
 * TikTok links, etc.) and are NOT written by any OMI watcher phase. So after a
 * perfectly clean OMI run the postcondition saw `nexusgram:131 link-inbox:45
 * auto-index:216` public rows → reported a PRIVACY VIOLATION → 3 consecutive
 * failures → the watcher self-disabled and never ran again (last_success_at=null).
 *
 * Fix: a dedicated OMI_WRITER_SOURCES list (omi, omi-bridge, omi-bridge-task,
 * omi-synthesis, scanner-pro, scanner-pro-original). privacyPostcondition() now
 * checks ONLY these. This test proves:
 *   (1) all OMI-writer rows private → ok:true,
 *   (2) public rows on a NON-writer source (nexusgram/link-inbox/auto-index)
 *       no longer trip the postcondition — the actual regression,
 *   (3) a genuinely leaked OMI-writer row (scanner-pro-original public) IS caught,
 *   (4) scanner-pro-original is covered (was missing from the old list),
 *   (5) NULL privacy (COALESCE→'public') on a writer source is caught.
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-omi-postcond-test-'));
const FIXTURE_DB = path.join(TMP, 'memory.db');

// MUST be set before importing the watcher module: the test-DB override is read
// at module-load time into a const. Uses the DEDICATED OMI_WATCHER_TEST_DB var
// (NOT the generic NEXUS_MEMORY_DB) so a stray service-env value can never point
// the production postcondition at the wrong DB (Codex M-11 hardening).
process.env.OMI_WATCHER_TEST_DB = FIXTURE_DB;
// Keep config.ts happy (it eagerly validates a few envs on import).
process.env.NEXUSGRAM_ENV_PATH = path.join(TMP, 'nonexistent.env');
process.env.CLAUDEGRAM_ENV_PATH = process.env.NEXUSGRAM_ENV_PATH;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'TestBot';
process.env.NEXUS_MEMORY_SCOPE = 'public';
process.env.DATA_DIR = TMP;

let pass = 0, fail = 0;
function check(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.error(`  ❌ ${msg}`); }
}

/** Build a fresh fixture memory.db with the given (source, privacy, count) rows. */
function buildFixture(rows: Array<{ source: string; privacy: string | null; n: number }>) {
  try { fs.rmSync(FIXTURE_DB); } catch { /* first run */ }
  const db = new Database(FIXTURE_DB);
  // Minimal schema: privacy may be NULL to exercise the COALESCE branch.
  db.exec(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    privacy TEXT,
    content TEXT
  )`);
  const ins = db.prepare('INSERT INTO memories (source, privacy, content) VALUES (?, ?, ?)');
  const tx = db.transaction((rs: typeof rows) => {
    for (const r of rs) for (let i = 0; i < r.n; i++) ins.run(r.source, r.privacy, `c${i}`);
  });
  tx(rows);
  db.close();
}

const watcher = await import('./omi-bridge-watcher.js');
const pc = () => watcher.privacyPostcondition();

console.log('\n=== T3 / RI-25: OMI-watcher privacy postcondition scoping ===');

// (1) all OMI-writer rows private → clean
buildFixture([
  { source: 'omi', privacy: 'private', n: 5 },
  { source: 'omi-bridge', privacy: 'private', n: 3 },
  { source: 'omi-bridge-task', privacy: 'private', n: 7 },
  { source: 'omi-synthesis', privacy: 'private', n: 2 },
  { source: 'scanner-pro', privacy: 'private', n: 4 },
  { source: 'scanner-pro-original', privacy: 'private', n: 6 },
]);
{
  const r = pc();
  check(r.ok === true, '(1a) all OMI-writer rows private → ok:true');
  check(r.details === 'clean', '(1b) details=clean');
}

// (2) THE REGRESSION: public rows on non-writer sources must NOT trip the check.
//     Mirrors live data: nexusgram:131 link-inbox:45 auto-index:216 are public.
buildFixture([
  { source: 'omi', privacy: 'private', n: 5 },
  { source: 'omi-bridge-task', privacy: 'private', n: 521 },
  { source: 'nexusgram', privacy: 'public', n: 131 },
  { source: 'link-inbox', privacy: 'public', n: 45 },
  { source: 'auto-index', privacy: 'public', n: 216 },
  { source: 'auto-index', privacy: 'private', n: 436 },
]);
{
  const r = pc();
  check(r.ok === true, '(2a) public nexusgram/link-inbox/auto-index rows DO NOT trip postcondition (the fix)');
  check(r.details === 'clean', '(2b) details=clean despite 392 non-writer public rows');
}

// (3) a real leak on an OMI-writer source IS caught
buildFixture([
  { source: 'omi', privacy: 'private', n: 5 },
  { source: 'omi-bridge', privacy: 'public', n: 2 },   // leaked!
  { source: 'nexusgram', privacy: 'public', n: 131 },  // noise, must be ignored
]);
{
  const r = pc();
  check(r.ok === false, '(3a) leaked omi-bridge public row → ok:false');
  check(r.details === 'omi-bridge:2', `(3b) details name the writer source only (got "${r.details}")`);
}

// (4) scanner-pro-original is now covered (was missing from the old list)
buildFixture([
  { source: 'scanner-pro-original', privacy: 'public', n: 3 },
]);
{
  const r = pc();
  check(r.ok === false, '(4a) leaked scanner-pro-original → ok:false (newly covered)');
  check(r.details === 'scanner-pro-original:3', `(4b) details="scanner-pro-original:3" (got "${r.details}")`);
}

// (5) NULL privacy on a writer source counts as public (COALESCE branch)
buildFixture([
  { source: 'omi-synthesis', privacy: null, n: 4 },
]);
{
  const r = pc();
  check(r.ok === false, '(5a) NULL-privacy omi-synthesis row treated as public → ok:false');
  check(r.details === 'omi-synthesis:4', `(5b) details="omi-synthesis:4" (got "${r.details}")`);
}

// (6) inventory-drift guard (Codex M-11 finding): pin the exact writer-source set
//     so a future typo or a new writer added outside the list is caught here.
{
  const expected = ['omi', 'omi-bridge', 'omi-bridge-task', 'omi-synthesis', 'scanner-pro', 'scanner-pro-original'];
  const actual = [...watcher.OMI_WRITER_SOURCES];
  check(
    actual.length === expected.length && expected.every((s, i) => actual[i] === s),
    `(6) OMI_WRITER_SOURCES inventory unchanged (got [${actual.join(', ')}])`,
  );
}

// cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
assert.equal(fail, 0, `${fail} assertions failed`);
console.log('All postcondition-scoping assertions passed ✅');
