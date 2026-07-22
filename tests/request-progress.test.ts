import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-progress-'));
process.env.NEXUSGRAM_ENV_PATH = path.join(tmp, 'missing.env');
process.env.CLAUDEGRAM_ENV_PATH = process.env.NEXUSGRAM_ENV_PATH;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'ProgressTest';
process.env.DATA_DIR = tmp;
process.env.HANDLER_LONG_RUNNING_HEARTBEAT_MS = '5';
process.env.HANDLER_PROGRESS_UPDATE_INTERVAL_MS = '1000';

const requestContext = await import('../src/handler/request-context.js');

test('RI-19/RI-23: a long request receives recurring progress instead of one notice then silence', async () => {
  const updates: number[] = [];
  const ctx = requestContext.createRequestContext('progress-session', 'wait', {
    baseTimeoutMs: 2_500,
    onLongRunning: (current) => { updates.push(current.progressUpdateCount); },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    assert.deepEqual(updates, [1, 2]);
    assert.equal(ctx.state, requestContext.HandlerState.LONG_RUNNING);
    assert.equal(requestContext.markSuccess(ctx), true);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    assert.deepEqual(updates, [1, 2], 'no progress update survives terminal success');
  } finally {
    requestContext.disposeRequestContext(ctx);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
