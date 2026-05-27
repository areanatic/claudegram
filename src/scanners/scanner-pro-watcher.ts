/**
 * Scanner-Pro Master-Bot Watcher
 *
 * In-Process Scheduler in the master bot (NexusGram) that periodically
 * triggers scripts/scanner-pro-sync.sh. Pragmatic workaround for the
 * standalone launchd-spawned bash hitting TCC/EX_CONFIG (exit 78) while
 * the master bot's user-context process has full /Volumes + rclone access.
 *
 * Codex Pre-Review: cross_review_scanner-watcher-architecture_2026-05-27.md (0.76)
 *
 * Triple-gated (all required):
 *   - config.SCANNER_PRO_WATCHER_ENABLED === true
 *   - config.BOT_NAME === 'Nexusgram' (master-bot identity)
 *   - config.NEXUS_MEMORY_SCOPE === 'self_private' (operator scope)
 *
 * Safety:
 *   - Cross-process lock lives in scanner-pro-sync.sh itself (mkdir lock dir)
 *   - stdio: 'ignore' — script writes its own log file, don't pollute bot log
 *   - currentChild tracked → SIGTERM on bot shutdown with 8s grace
 *   - consecutiveFailures counter for backoff (Codex P1-2)
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, appendFileSync } from 'fs';
import { config } from '../config.js';

const WATCHER_LOG = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/scanner-pro-sync.log';

let intervalTimer: NodeJS.Timeout | null = null;
let firstRunTimer: NodeJS.Timeout | null = null;
let currentChild: ChildProcess | null = null;
let consecutiveFailures = 0;
let lastRunAt: string | null = null;
let lastExitCode: number | null = null;
let lastDurationMs: number | null = null;
let totalRuns = 0;
let totalSuccessRuns = 0;

function watcherLog(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] [Watcher] ${msg}\n`;
  try {
    appendFileSync(WATCHER_LOG, line);
  } catch {
    // log file may live on unmounted volume — fall back to stderr
    console.error(line.trimEnd());
  }
}

function gateOk(): { ok: true } | { ok: false; reason: string } {
  if (!config.SCANNER_PRO_WATCHER_ENABLED) {
    return { ok: false, reason: 'SCANNER_PRO_WATCHER_ENABLED=false' };
  }
  if (config.BOT_NAME !== 'Nexusgram') {
    return { ok: false, reason: `BOT_NAME='${config.BOT_NAME}' (master-only)` };
  }
  if (config.NEXUS_MEMORY_SCOPE !== 'self_private') {
    return { ok: false, reason: `NEXUS_MEMORY_SCOPE='${config.NEXUS_MEMORY_SCOPE ?? '(unset)'}'` };
  }
  return { ok: true };
}

function triggerRun(): Promise<void> {
  return new Promise((resolve) => {
    if (currentChild !== null) {
      watcherLog('skip: previous child still alive');
      return resolve();
    }
    const scriptPath = config.SCANNER_PRO_SCRIPT_PATH;
    if (!existsSync(scriptPath)) {
      watcherLog(`skip: script not found at ${scriptPath}`);
      return resolve();
    }
    const t0 = Date.now();
    totalRuns += 1;
    lastRunAt = new Date().toISOString();
    watcherLog(`run start (script=${scriptPath})`);
    try {
      const child = spawn('/bin/bash', [scriptPath], {
        stdio: 'ignore', // script writes its own log; don't double-log
        detached: false,
      });
      currentChild = child;

      child.on('exit', (code) => {
        currentChild = null;
        lastDurationMs = Date.now() - t0;
        lastExitCode = code;
        if (code === 0) {
          totalSuccessRuns += 1;
          consecutiveFailures = 0;
          watcherLog(`run done exit=0 duration=${lastDurationMs}ms`);
        } else {
          consecutiveFailures += 1;
          watcherLog(`run done exit=${code} duration=${lastDurationMs}ms (consecutive_failures=${consecutiveFailures})`);
        }
        resolve();
      });

      child.on('error', (err) => {
        currentChild = null;
        consecutiveFailures += 1;
        lastExitCode = null;
        lastDurationMs = Date.now() - t0;
        watcherLog(`spawn error: ${err.message} (consecutive_failures=${consecutiveFailures})`);
        resolve();
      });
    } catch (err) {
      currentChild = null;
      consecutiveFailures += 1;
      watcherLog(`spawn threw: ${err instanceof Error ? err.message : String(err)}`);
      resolve();
    }
  });
}

export function startScannerProWatcher(): void {
  const gate = gateOk();
  if (!gate.ok) {
    watcherLog(`disabled (${gate.reason})`);
    return;
  }
  const intervalMs = config.SCANNER_PRO_WATCHER_INTERVAL_MS;
  watcherLog(`enabled (interval=${intervalMs}ms script=${config.SCANNER_PRO_SCRIPT_PATH})`);

  // Initial run after 30s grace (let bot poll-stable first)
  firstRunTimer = setTimeout(() => {
    firstRunTimer = null;
    triggerRun().catch(() => { /* always swallow */ });
  }, 30_000);

  intervalTimer = setInterval(() => {
    triggerRun().catch(() => { /* always swallow */ });
  }, intervalMs);
}

export async function stopScannerProWatcher(): Promise<void> {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (firstRunTimer) {
    clearTimeout(firstRunTimer);
    firstRunTimer = null;
  }
  if (currentChild !== null) {
    watcherLog('shutdown: sending SIGTERM to running child');
    try {
      currentChild.kill('SIGTERM');
    } catch {
      // best-effort
    }
    // Grace period — wait up to 8s for child to exit
    const child = currentChild;
    await new Promise<void>((resolve) => {
      const grace = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 8_000);
      child.on('exit', () => {
        clearTimeout(grace);
        resolve();
      });
    });
    currentChild = null;
  }
  watcherLog('stopped');
}

export interface WatcherStatus {
  enabled: boolean;
  reason?: string;
  running: boolean;
  totalRuns: number;
  totalSuccessRuns: number;
  consecutiveFailures: number;
  lastRunAt: string | null;
  lastExitCode: number | null;
  lastDurationMs: number | null;
}

export function getScannerWatcherStatus(): WatcherStatus {
  const gate = gateOk();
  return {
    enabled: gate.ok && intervalTimer !== null,
    reason: gate.ok ? undefined : gate.reason,
    running: currentChild !== null,
    totalRuns,
    totalSuccessRuns,
    consecutiveFailures,
    lastRunAt,
    lastExitCode,
    lastDurationMs,
  };
}
