import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getPollingFailureSnapshot,
  observePollingFailure,
  resetPollingFailureSnapshotForTests,
} from '../src/telegram/polling-observability.js';

test('expected getUpdates timeouts are counted and sampled while real failures stay loud', () => {
  resetPollingFailureSnapshotForTests();
  const debug: string[] = [];
  const errors: string[] = [];
  const sink = { debug: (line: string) => debug.push(line), error: (line: string) => errors.push(line) };
  for (let i = 0; i < 101; i++) {
    observePollingFailure(new Error("Request to 'getUpdates' timed out after 60 seconds"), sink as never);
  }
  observePollingFailure(new Error('401 Unauthorized'), sink as never);

  assert.deepEqual(getPollingFailureSnapshot(), { expectedTimeouts: 101, actionableFailures: 1 });
  assert.equal(debug.length, 2, 'only timeout 1 and 100 are sampled');
  assert.match(debug[1]!, /count=100/);
  assert.deepEqual(errors, ['[TelegramPolling] actionable getUpdates failure count=1: 401 Unauthorized']);
});
