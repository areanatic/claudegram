import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NEXUSGRAM_ENV_PATH ||= '/tmp/nexusgram-action-buttons.env';
process.env.CLAUDEGRAM_ENV_PATH ||= process.env.NEXUSGRAM_ENV_PATH;
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME ||= 'test';
process.env.DATA_DIR ||= '/tmp/nexusgram-action-buttons';

const { ContextActionRouter, CALLBACK_DATA_MAX_BYTES } = await import('../src/telegram/action-buttons.js');
const { filterTelegramCommands } = await import('../src/bot/bot.js');

function callbackContext(userId = 1, chatId = 9, data = '') {
  const answers: Array<{ text?: string }> = [];
  const replies: string[] = [];
  return {
    ctx: {
      from: { id: userId },
      chat: { id: chatId },
      callbackQuery: { data, message: { chat: { id: chatId } } },
      answerCallbackQuery: async (payload: { text?: string }) => { answers.push(payload); },
      reply: async (text: string) => { replies.push(text); },
    },
    answers,
    replies,
  };
}

test('Telegram command validation skips a hyphenated command and logs it', () => {
  const logs: string[] = [];
  const valid = filterTelegramCommands([
    { command: 'wo-stehen-wir', description: 'invalid' },
    { command: 'wo_stehen_wir', description: 'valid' },
  ], (line) => logs.push(line));

  assert.deepEqual(valid.map((item) => item.command), ['wo_stehen_wir']);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /wo-stehen-wir/);
});

test('central action router resolves compact callback data to its typed server-side payload', async () => {
  const router = new ContextActionRouter();
  const data = router.register({ type: 'text', text: 'Bitte vertiefe den Digest.', userId: 1, chatId: 9, sessionKey: '9' });
  const { ctx, answers } = callbackContext(1, 9, data);
  const handled: string[] = [];

  assert.equal(await router.handle(ctx as never, async (action) => { handled.push(action.type === 'text' ? action.text : 'wrong'); }), true);
  assert.deepEqual(handled, ['Bitte vertiefe den Digest.']);
  assert.equal(answers.length, 1, 'answerCallbackQuery is always called before execution');
});

test('foreign callback user is denied, answered, and cannot execute the action', async () => {
  const router = new ContextActionRouter();
  const data = router.register({ type: 'text', text: 'GO', userId: 1, chatId: 9, sessionKey: '9' });
  const { ctx, answers } = callbackContext(2, 9, data);
  let executions = 0;

  await router.handle(ctx as never, async () => { executions++; });
  assert.equal(executions, 0);
  assert.equal(answers.length, 1);
  assert.match(answers[0]?.text ?? '', /Nicht berechtigt/);
});

test('double click is idempotent and each callback is answered', async () => {
  const router = new ContextActionRouter();
  const data = router.register({ type: 'text', text: 'GO', userId: 1, chatId: 9, sessionKey: '9' });
  const first = callbackContext(1, 9, data);
  const second = callbackContext(1, 9, data);
  let executions = 0;

  await router.handle(first.ctx as never, async () => { executions++; });
  await router.handle(second.ctx as never, async () => { executions++; });
  assert.equal(executions, 1);
  assert.equal(first.answers.length, 1);
  assert.equal(second.answers.length, 1);
  assert.match(second.answers[0]?.text ?? '', /bereits verarbeitet/);
});

test('a Telegram callback ACK timeout does not strand or skip the claimed action', async () => {
  const router = new ContextActionRouter();
  const data = router.register({ type: 'text', text: 'GO', userId: 1, chatId: 9, sessionKey: '9' });
  const failedAck = callbackContext(1, 9, data);
  failedAck.ctx.answerCallbackQuery = async () => { throw new Error("Request to 'answerCallbackQuery' timed out"); };
  let executions = 0;

  assert.equal(await router.handle(failedAck.ctx as never, async () => { executions++; }), true);
  assert.equal(executions, 1, 'the server-side action still executes exactly once');

  const retry = callbackContext(1, 9, data);
  await router.handle(retry.ctx as never, async () => { executions++; });
  assert.equal(executions, 1, 'a second click cannot duplicate the action');
  assert.match(retry.answers[0]?.text ?? '', /bereits verarbeitet/);
});

test('callback data remains below Telegram’s 64-byte limit even for a long server payload', () => {
  const router = new ContextActionRouter();
  const data = router.register({
    type: 'text', text: 'x'.repeat(10_000), userId: 1, chatId: 9,
    sessionKey: '9:thread:123456789',
  });
  assert.ok(Buffer.byteLength(data, 'utf8') <= CALLBACK_DATA_MAX_BYTES, `${data} must fit Telegram callback_data`);
  assert.ok(!data.includes('x'.repeat(20)), 'payload must remain server-side');
});
