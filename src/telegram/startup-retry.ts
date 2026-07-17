import { GrammyError } from 'grammy';

export interface StartupRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (input: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void;
}

export class StartupRetryExhaustedError extends Error {
  readonly name = 'StartupRetryExhaustedError';

  constructor(readonly attempts: number, readonly cause: unknown) {
    super(`Telegram bootstrap failed after ${attempts} bounded attempt(s).`);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Telegram init failures that can be transient in the observed restart incidents. */
export function isRetryableStartupError(error: unknown): boolean {
  if (error instanceof GrammyError) {
    return error.error_code === 401 || error.error_code === 429 || error.error_code >= 500;
  }
  const telegramCode = typeof error === 'object' && error !== null && 'error_code' in error
    ? Number((error as { error_code?: unknown }).error_code)
    : Number.NaN;
  if (telegramCode === 401 || telegramCode === 429 || telegramCode >= 500) return true;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (/^(ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/.test(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:network|fetch failed|socket hang up|timed out|ECONNRESET|EAI_AGAIN)/i.test(message);
}

export function startupRetryDelayMs(attempt: number, options: Pick<StartupRetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'>): number {
  const unclamped = options.baseDelayMs * (2 ** Math.max(0, attempt - 1));
  const capped = Math.min(unclamped, options.maxDelayMs);
  // ±20% jitter prevents launchd-restarted bots from retrying in lockstep.
  const jitter = 0.8 + (options.random?.() ?? Math.random()) * 0.4;
  return Math.round(capped * jitter);
}

/**
 * Retries only before polling starts. A 409 is intentionally not retryable here:
 * retrying while another poller owns getUpdates would recreate a poller storm.
 */
export async function initializeWithRetry<T>(
  initialize: () => Promise<T>,
  options: StartupRetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await initialize();
    } catch (error) {
      lastError = error;
      const retryable = isRetryableStartupError(error);
      if (!retryable || attempt === options.maxAttempts) {
        throw new StartupRetryExhaustedError(attempt, error);
      }
      const delayMs = startupRetryDelayMs(attempt, options);
      options.onRetry?.({ attempt, maxAttempts: options.maxAttempts, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw new StartupRetryExhaustedError(options.maxAttempts, lastError);
}

/** Keeps command registration in the same retryable, strictly post-init boot transaction. */
export async function initializeBotStartup<T>(
  initialize: () => Promise<T>,
  registerCommands: () => Promise<void>,
  options: StartupRetryOptions,
): Promise<T> {
  return initializeWithRetry(async () => {
    const value = await initialize();
    await registerCommands();
    return value;
  }, options);
}
