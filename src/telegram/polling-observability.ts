import { sanitizeError } from '../utils/sanitize.js';

export interface PollingFailureSnapshot {
  expectedTimeouts: number;
  actionableFailures: number;
}

let expectedTimeouts = 0;
let actionableFailures = 0;

export function isExpectedLongPollTimeout(error: unknown): boolean {
  return /Request to 'getUpdates' timed out after \d+ seconds/i.test(sanitizeError(error));
}

/**
 * The runner retries getUpdates itself. Keep expected transport timeouts as a
 * counter and emit only a sampled debug line; preserve every actionable class.
 */
export function observePollingFailure(
  error: unknown,
  sink: Pick<Console, 'debug' | 'error'> = console,
): void {
  if (isExpectedLongPollTimeout(error)) {
    expectedTimeouts += 1;
    if (expectedTimeouts === 1 || expectedTimeouts % 100 === 0) {
      sink.debug(`[TelegramPolling] expected long-poll timeout count=${expectedTimeouts}; runner will retry`);
    }
    return;
  }
  actionableFailures += 1;
  sink.error(`[TelegramPolling] actionable getUpdates failure count=${actionableFailures}: ${sanitizeError(error)}`);
}

export function getPollingFailureSnapshot(): PollingFailureSnapshot {
  return { expectedTimeouts, actionableFailures };
}

export function resetPollingFailureSnapshotForTests(): void {
  expectedTimeouts = 0;
  actionableFailures = 0;
}
