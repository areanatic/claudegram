import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-fix-offensive-'));
process.env.NEXUSGRAM_ENV_PATH = path.join(tmp, 'missing.env');
process.env.CLAUDEGRAM_ENV_PATH = process.env.NEXUSGRAM_ENV_PATH;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'FixOffensiveTest';
process.env.DATA_DIR = tmp;

const { MessageSender, TelegramDeliveryError } = await import('../src/telegram/message-sender.js');
const relay = await import('../src/crossbot/relay.js');
const actions = await import('../src/telegram/action-buttons.js');
const ledger = await import('../src/inbox/task-ledger.js');
const { sanitizeError } = await import('../src/utils/sanitize.js');

test('P0: persistent error logs redact Telegram credentials and ignore nested context', () => {
  const token = `123456789:${'A'.repeat(35)}`;
  const raw = Object.assign(new Error(`request failed with ${token}`), {
    ctx: { api: { token } },
  });
  const safe = sanitizeError(raw);
  assert.doesNotMatch(safe, /123456789:/);
  assert.match(safe, /<redacted-telegram-token>/);
  assert.doesNotMatch(safe, /ctx|api/);
});

test('P0: unconfirmed Telegram sends reject instead of being silently accepted', async () => {
  const sender = new MessageSender();
  const unavailableCtx = {
    reply: async () => { throw new Error('Telegram network unavailable'); },
  };
  await assert.rejects(
    sender.sendMessage(unavailableCtx as never, 'Antwort'),
    TelegramDeliveryError,
  );

  let calls = 0;
  const fallbackCtx = {
    reply: async () => {
      calls++;
      if (calls === 1) throw new Error('Markdown parse failure');
      return { message_id: 1 };
    },
  };
  await sender.sendMessage(fallbackCtx as never, 'Antwort');
  assert.equal(calls, 2, 'a confirmed plain-text fallback remains a successful delivery');
});

test('P1: relay rejects forged lines, refuses symlinked inbox files, and writes receipt before handoff processing', () => {
  const relayRoot = path.join(tmp, 'relay');
  const recipientData = path.join(tmp, 'recipient');
  const signingKey = 'test-crossbot-signing-key-that-is-at-least-32-bytes';
  const delivered = relay.enqueueRelay({
    relayDir: relayRoot, target: 'alina', kind: 'note', payload: 'Echte Nachricht', sourceUserId: 1, signingKey,
  });
  const inbox = path.join(relayRoot, 'inbox', 'alina.jsonl');
  fs.appendFileSync(inbox, `${JSON.stringify({ ...delivered, id: 'forged', signature: '0'.repeat(64) })}\n`);

  const claimed = relay.claimPendingRelays({ relayDir: relayRoot, recipient: 'alina', recipientDataDir: recipientData, signingKey });
  assert.deepEqual(claimed.map((item) => item.id), [delivered.id]);
  assert.equal(relay.pendingRelays({ relayDir: relayRoot, recipient: 'alina', recipientDataDir: recipientData, signingKey }).length, 0);
  assert.match(fs.readFileSync(path.join(recipientData, 'crossbot-received.jsonl'), 'utf8'), new RegExp(delivered.id));

  const outside = path.join(tmp, 'outside.jsonl');
  fs.writeFileSync(outside, '');
  const symlinkRoot = path.join(tmp, 'relay-symlink');
  fs.mkdirSync(path.join(symlinkRoot, 'inbox'), { recursive: true });
  fs.symlinkSync(outside, path.join(symlinkRoot, 'inbox', 'mom.jsonl'));
  assert.throws(
    () => relay.enqueueRelay({ relayDir: symlinkRoot, target: 'mom', kind: 'note', payload: 'Nicht schreiben', sourceUserId: 1, signingKey }),
    /symbolic link/,
  );
});

test('P1: legacy taskresume callbacks are forwarded through the scoped action router', async () => {
  const taskId = ledger.acceptTask({ messageId: 601, chatId: 9, sessionKey: '9', inputType: 'text', text: 'offener Auftrag', fileId: null });
  ledger.startTask(taskId); // make the durable retry CAS a no-op; no agent call is possible in this test
  const answers: Array<{ text?: string }> = [];
  const ctx = {
    from: { id: 1 }, chat: { id: 9 },
    callbackQuery: { data: `taskresume:${taskId}`, message: { chat: { id: 9 } } },
    answerCallbackQuery: async (payload: { text?: string }) => { answers.push(payload); },
    reply: async () => undefined,
  };
  assert.equal(await actions.handleLegacyTaskResumeCallback(ctx as never, {} as never), true);
  assert.match(answers[0]?.text ?? '', /Aktion wird ausgeführt/);
  assert.equal(ledger.getOpenTask(taskId)?.state, 'working', 'the legacy payload reached the router, then the ledger CAS prevented duplicate execution');

  const foreign = { ...ctx, from: { id: 2 } };
  const foreignAnswers: Array<{ text?: string }> = [];
  foreign.answerCallbackQuery = async (payload: { text?: string }) => { foreignAnswers.push(payload); };
  await actions.handleLegacyTaskResumeCallback(foreign as never, {} as never);
  assert.match(foreignAnswers[0]?.text ?? '', /Nicht berechtigt/);
});

test('P1: release hook writes a verifiable BUILD_INFO.json through build-manifest.sh', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const releaseDir = fs.mkdtempSync(path.join(repoRoot, 'releases', 'test-build-info-'));
  try {
    execFileSync(path.join(repoRoot, 'scripts/release/write-build-info.sh'), [releaseDir], { stdio: 'pipe' });
    const info = JSON.parse(fs.readFileSync(path.join(releaseDir, 'BUILD_INFO.json'), 'utf8')) as Record<string, string>;
    assert.match(info.commit_sha, /^[a-f0-9]{40}$/);
    assert.equal(info.branch, execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).trim());
    assert.match(info.built_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
});

test.after(() => {
  ledger.closeTaskLedger();
  fs.rmSync(tmp, { recursive: true, force: true });
});
