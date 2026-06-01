/**
 * INV-01 Auto-Resume — preface / re-send-notice formatting.
 * Run: npx tsx src/inbox/auto-resume.test.ts
 *
 * Unit-level: the pure UX-string helpers (snippet truncation, whitespace
 * collapse, markers). The replay ORCHESTRATION (queue, markDone-after-reply,
 * side-effect/private exclusion, crash-loop) is proven by the boot-restart E2E
 * (test_boot_restart_replay) — the only layer that can drive a real restart.
 *
 * Env is set before the (dynamic) import because auto-resume.ts → agent.ts →
 * config.ts hard-fails on missing env.
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-autoresume-test-'));
process.env.NEXUSGRAM_ENV_PATH = path.join(TMP, 'nonexistent.env');
process.env.CLAUDEGRAM_ENV_PATH = process.env.NEXUSGRAM_ENV_PATH;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'TestBot';
process.env.NEXUS_MEMORY_SCOPE = 'public';
process.env.DATA_DIR = TMP;

let pass = 0;
function check(cond: boolean, msg: string) {
  assert.equal(cond, true, msg);
  pass++;
}

(async () => {
  const { buildResumePreface, buildResendNotice } = await import('./auto-resume.js');

  // Preface: marker + quoted snippet + trailing blank line so the answer follows.
  const p = buildResumePreface('Mach mir bitte eine Zusammenfassung');
  check(p.startsWith('↩️'), 'preface starts with resume marker');
  check(p.includes('Mach mir bitte eine Zusammenfassung'), 'preface includes the original text');
  check(p.endsWith('\n\n'), 'preface ends with a blank line (answer follows)');

  // Whitespace collapse + truncation to 120 chars.
  const messy = 'a'.repeat(200);
  const pTrunc = buildResumePreface(messy);
  check(pTrunc.includes('a'.repeat(120)) && !pTrunc.includes('a'.repeat(121)), 'snippet truncated to 120 chars');
  const multiline = buildResumePreface('line one\n\n   line   two\ttabbed');
  check(multiline.includes('line one line two tabbed'), 'whitespace collapsed in snippet');

  // Re-send notice: warning marker + snippet.
  const n = buildResendNotice('etwas Wichtiges');
  check(n.startsWith('⚠️'), 're-send notice starts with warning marker');
  check(n.includes('nochmal senden'), 're-send notice asks to resend');
  check(n.includes('etwas Wichtiges'), 're-send notice includes the original snippet');

  console.log(`✅ auto-resume helpers: ${pass}/${pass} cases PASS`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
})().catch((err) => {
  console.error('❌ auto-resume.test.ts FAILED:', err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
