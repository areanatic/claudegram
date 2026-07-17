import assert from 'node:assert/strict';
import { initializeBotStartup, initializeWithRetry, StartupRetryExhaustedError } from './startup-retry.js';

let pass = 0;
const ok = (condition: boolean, message: string) => { assert.equal(condition, true, message); pass++; };

let calls = 0;
const delays: number[] = [];
const initialized = await initializeWithRetry(
  async () => {
    calls++;
    if (calls === 1) throw { error_code: 401, message: 'Unauthorized' };
    return 'ready';
  },
  { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, random: () => 0.5, sleep: async (ms) => { delays.push(ms); } },
);
ok(initialized === 'ready', 'transient 401 is retried until init succeeds');
ok(calls === 2 && delays.length === 1 && delays[0] === 10, 'retry uses one bounded exponential delay');

const bootOrder: string[] = [];
calls = 0;
await initializeBotStartup(
  async () => {
    calls++;
    bootOrder.push(`init:${calls}`);
    if (calls === 1) throw { error_code: 401, message: 'Unauthorized' };
    return 'ready';
  },
  async () => { bootOrder.push('commands'); },
  { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, random: () => 0.5, sleep: async () => {} },
);
ok(bootOrder.join(',') === 'init:1,init:2,commands', 'commands register only after a successful init attempt');

calls = 0;
await assert.rejects(
  () => initializeWithRetry(
    async () => {
      calls++;
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    },
    { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100, random: () => 0.5, sleep: async () => {} },
  ),
  (error: unknown) => error instanceof StartupRetryExhaustedError && error.attempts === 2,
);
ok(calls === 2, 'retry exhaustion fails loud after exactly maxAttempts');

console.log(`✅ startup retry: ${pass} cases PASS`);
