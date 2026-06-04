/**
 * P0 regression — /private must be isolated PER BOT (per DATA_DIR), not global.
 *
 * Run: npx tsx src/memory/privacy-state-isolation.test.ts
 *
 * Bug (bug_private_cross_bot_sessionkey_collision_2026-06-04): privacy-state.json
 * used to live at a SHARED NEXUS_ROOT/.nexus-memory path, while the sessionKey is
 * just the chatId. In private Telegram DMs the chatId == user-id, IDENTICAL across
 * all bots for the same user. So `/private on` in bot A leaked into bot B.
 *
 * Fix anchors the state file in config.DATA_DIR (distinct per bot). This test
 * proves: two bots with DISTINCT DATA_DIR + the SAME sessionKey ("7067348774",
 * Arash's user-id) do NOT share private mode.
 *
 * Implementation note: privacy-state.ts resolves STATE_DIR at module-load time, so
 * we load a FRESH module instance per bot via the cache-busting query trick, each
 * with its own NEXUS_PRIVACY_STATE_DIR pointing at a throwaway dir (stands in for
 * the per-bot DATA_DIR — same resolveStateDir() branch behavior).
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ARASH = '7067348774'; // identical chatId across all bots in private DMs

let pass = 0;
function check(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  pass++;
}

async function loadFor(dir: string, tag: string) {
  // Each bot gets its own state dir (stands in for DATA_DIR). Set env, then load
  // a fresh module instance (query string busts the ESM module cache).
  process.env.NEXUS_PRIVACY_STATE_DIR = dir;
  const mod = await import(`./privacy-state.js?bot=${tag}`);
  return mod as typeof import('./privacy-state.js');
}

async function main() {
  const botA = fs.mkdtempSync(path.join(os.tmpdir(), 'priv-botA-'));
  const botB = fs.mkdtempSync(path.join(os.tmpdir(), 'priv-botB-'));

  const A = await loadFor(botA, 'A');
  const B = await loadFor(botB, 'B');

  // Baseline: both public.
  check(A.isPrivate(ARASH) === false, 'baseline: bot A public');
  check(B.isPrivate(ARASH) === false, 'baseline: bot B public');

  // Bot A enables /private for Arash's chatId.
  A.setPrivate(ARASH);
  check(A.isPrivate(ARASH) === true, 'bot A is now private');

  // THE LOAD-BEARING ASSERTION: bot B with the SAME sessionKey must stay public.
  check(B.isPrivate(ARASH) === false, 'bot B NOT affected by bot A /private (cross-bot isolation)');

  // And turning A off must not touch B either.
  A.setPublic(ARASH);
  check(A.isPrivate(ARASH) === false, 'bot A back to public');
  check(B.isPrivate(ARASH) === false, 'bot B still public after A toggled off');

  // Verify each wrote to its OWN dir, not a shared location.
  const aFile = path.join(botA, 'privacy-state.json');
  // A wrote then cleared; file may exist but empty-object. The key check is that
  // B's dir was never written for this key by A's action.
  const bHadWrite = fs.existsSync(path.join(botB, 'privacy-state.json'));
  check(!bHadWrite || JSON.parse(fs.readFileSync(path.join(botB, 'privacy-state.json'), 'utf-8'))[ARASH] === undefined,
    'bot B state file never gained Arash private record from bot A');

  // Cleanup
  fs.rmSync(botA, { recursive: true, force: true });
  fs.rmSync(botB, { recursive: true, force: true });

  console.log(`\n✅ privacy-state isolation: ${pass}/${pass} assertions passed`);
}

main().catch((e) => {
  console.error('❌ privacy-state isolation FAILED:', e.message);
  process.exit(1);
});
