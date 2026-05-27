/**
 * OMI-Bridge Auto-Orchestrator — Phase 7.7
 *
 * In-process scheduler in the master bot that periodically orchestrates the
 * OMI-Bridge pipeline (snapshot-pull + phase1 + phase2 → ocr → ner → tasks).
 *
 * Codex Pre-Review: cross_review_phase-7-7-auto-orchestrator-architecture_2026-05-27.md (0.82 CONDITIONAL-GO)
 *
 * Triple-gated (all required):
 *   - config.OMI_BRIDGE_WATCHER_ENABLED === true
 *   - config.BOT_NAME === 'Nexusgram' (master-only)
 *   - config.NEXUS_MEMORY_SCOPE === 'self_private' (operator scope)
 *
 * Honors Codex P0s:
 *   - P0-1: wraps `omi_bridge_pipeline.sh` (NOT `phase1_export.py` directly) so
 *     the snapshot-pull + quick_check + rsync stages run as designed.
 *   - P0-2: orchestrator-lock under `shared-memory/omi-bridge/.locks/orchestrator.lock`
 *     and SKIPS phases when pre-existing `pipeline.lock` or `ocr.lock` are held
 *     by another live process.
 *   - P0-3 (v1 path): NER claim is `memories + segments + scanner_pro` ONLY.
 *     OCR-source NER deferred until `phase7_ner_import.py` learns iter_ocr_priority.
 *   - P0-4: privacy postcondition SQL after writer-phases; trusted-private
 *     source rows must NEVER be `privacy='public'`. Triple-gate Master-only +
 *     env explicitly passed to children.
 *   - P0-5: strictly sequential — pipeline → ocr → ner → tasks. No parallelism.
 *
 * Honors Codex P1s:
 *   - P1-2 persistent state in `.nexus-memory/omi-bridge-watcher-state.json`
 *     survives bot restarts. Three consecutive failures → disabled=true.
 *   - P1-3 process-group spawn (detached:true + negative-PID kill) so
 *     ssh/rsync/ffmpeg/python subprocesses get SIGTERM together.
 *   - P2-3 initial delay = 120s (longer than Scanner-Pro's 30s).
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, statSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const NEXUS_MEMORY_DB = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db';
const WATCHER_LOG = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/omi-bridge-sync.log';
const STATE_FILE = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/omi-bridge-watcher-state.json';
const ORCHESTRATOR_LOCK_DIR = '/Volumes/AstronOne/shared-memory/omi-bridge/.locks/orchestrator.lock';
const PIPELINE_LOCK_DIR = '/Volumes/AstronOne/shared-memory/omi-bridge/.locks/pipeline.lock';
const OCR_LOCK_DIR = '/Volumes/AstronOne/shared-memory/omi-bridge/.locks/ocr.lock';

const TRUSTED_PRIVATE_SOURCES = ['omi', 'omi-bridge', 'omi-bridge-task', 'scanner-pro'] as const;

const SIGTERM_GRACE_MS = 8_000;
const INITIAL_DELAY_MS = 120_000;
const FAILURE_DISABLE_AFTER = 3;
const LOCK_STALE_MS = 30 * 60 * 1000; // 30min — orchestrator runs are at most ~5min

interface WatcherState {
  disabled: boolean;
  disabled_reason: string | null;
  disabled_at: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  last_pipeline_at: string | null;
  last_ocr_at: string | null;
  last_ner_at: string | null;
  last_tasks_at: string | null;
  last_phase: string | null;
  last_run_id: string | null;
}

const DEFAULT_STATE: WatcherState = {
  disabled: false,
  disabled_reason: null,
  disabled_at: null,
  consecutive_failures: 0,
  last_success_at: null,
  last_pipeline_at: null,
  last_ocr_at: null,
  last_ner_at: null,
  last_tasks_at: null,
  last_phase: null,
  last_run_id: null,
};

let intervalTimer: NodeJS.Timeout | null = null;
let firstRunTimer: NodeJS.Timeout | null = null;
let currentChild: ChildProcess | null = null;
let currentPhase: string | null = null;
let totalRuns = 0;
let totalSuccessRuns = 0;
let lastRunStartedAt: string | null = null;
let lastRunDurationMs: number | null = null;

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function watcherLog(msg: string): void {
  const line = `[${ts()}] [OmiBridgeWatcher] ${msg}\n`;
  try { appendFileSync(WATCHER_LOG, line); }
  catch { console.error(line.trimEnd()); }
}

function watcherJsonl(event: Record<string, unknown>): void {
  // Codex P2-1: machine-readable JSONL alongside the human tail line.
  const payload = JSON.stringify({ ts: new Date().toISOString(), ...event });
  try { appendFileSync(WATCHER_LOG, payload + '\n'); }
  catch { /* fallback already covered by watcherLog */ }
}

function loadState(): WatcherState {
  try {
    if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as Partial<WatcherState>;
    return { ...DEFAULT_STATE, ...raw };
  } catch (err) {
    watcherLog(`state-load failed (using defaults): ${err instanceof Error ? err.message : String(err)}`);
    return { ...DEFAULT_STATE };
  }
}

function saveState(state: WatcherState): void {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (err) { watcherLog(`state-save failed: ${err instanceof Error ? err.message : String(err)}`); }
}

function gateOk(): { ok: true } | { ok: false; reason: string } {
  if (!config.OMI_BRIDGE_WATCHER_ENABLED) {
    return { ok: false, reason: 'OMI_BRIDGE_WATCHER_ENABLED=false' };
  }
  if (config.BOT_NAME !== 'Nexusgram') {
    return { ok: false, reason: `BOT_NAME='${config.BOT_NAME}' (master-only)` };
  }
  if (config.NEXUS_MEMORY_SCOPE !== 'self_private') {
    return { ok: false, reason: `NEXUS_MEMORY_SCOPE='${config.NEXUS_MEMORY_SCOPE ?? '(unset)'}'` };
  }
  return { ok: true };
}

/** Try to acquire the orchestrator-lock (mkdir-based; analog OMI shell scripts). */
function acquireLock(lockPath: string): boolean {
  try {
    mkdirSync(lockPath, { recursive: false });
    writeFileSync(join(lockPath, 'pid'), String(process.pid));
    writeFileSync(join(lockPath, 'started_at'), new Date().toISOString());
    return true;
  } catch {
    // Lock dir already exists — check staleness
    try {
      const ageMs = Date.now() - statSync(lockPath).mtimeMs;
      const pidFile = join(lockPath, 'pid');
      let alive = false;
      if (existsSync(pidFile)) {
        const pid = Number((readFileSync(pidFile, 'utf-8') || '').trim());
        if (Number.isFinite(pid) && pid > 0) {
          try { process.kill(pid, 0); alive = true; } catch { alive = false; }
        }
      }
      if (!alive && ageMs > LOCK_STALE_MS) {
        watcherLog(`stale lock detected (age=${Math.floor(ageMs / 1000)}s, PID-dead) — breaking`);
        try { rmdirSync(lockPath, { recursive: true } as object); } catch { /* try direct rm */ }
        return acquireLock(lockPath);
      }
      watcherLog(`lock held by alive PID — skipping this tick (age=${Math.floor(ageMs / 1000)}s)`);
    } catch (err) {
      watcherLog(`lock-check error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try { rmdirSync(lockPath, { recursive: true } as object); }
  catch (err) { watcherLog(`lock-release error: ${err instanceof Error ? err.message : String(err)}`); }
}

function isLockHeldByOther(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  const pidFile = join(lockPath, 'pid');
  if (!existsSync(pidFile)) return false;
  try {
    const pid = Number((readFileSync(pidFile, 'utf-8') || '').trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (pid === process.pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  } catch { return false; }
}

/** Run a child process in its own process group; resolves with exit code (or null on spawn-error). */
function runChild(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    try {
      const child = spawn(command, args, {
        stdio: 'ignore', // wrapped scripts/python write their own logs
        detached: true,  // P1-3: own process-group for SIGTERM-group on shutdown
        env,
      });
      currentChild = child;
      child.on('exit', (code) => {
        const dur = Date.now() - t0;
        watcherLog(`child exit code=${code} duration=${dur}ms cmd="${command} ${args.join(' ')}"`);
        currentChild = null;
        resolve(code);
      });
      child.on('error', (err) => {
        const dur = Date.now() - t0;
        watcherLog(`child spawn-error: ${err.message} duration=${dur}ms cmd="${command} ${args.join(' ')}"`);
        currentChild = null;
        resolve(null);
      });
    } catch (err) {
      watcherLog(`spawn threw: ${err instanceof Error ? err.message : String(err)}`);
      currentChild = null;
      resolve(null);
    }
  });
}

function isDue(lastIso: string | null, minIntervalMs: number): boolean {
  if (!lastIso) return true;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= minIntervalMs;
}

function childEnv(): NodeJS.ProcessEnv {
  // Codex P0-4: explicitly pass scope-aware env to child. Don't rely on inheritance.
  return {
    ...process.env,
    BOT_NAME: config.BOT_NAME,
    NEXUS_MEMORY_SCOPE: config.NEXUS_MEMORY_SCOPE ?? 'self_private',
  };
}

/** Codex P0-4: privacy postcondition — trusted-private sources MUST NOT have public rows. */
function privacyPostcondition(): { ok: boolean; details: string } {
  let conn: Database.Database | null = null;
  try {
    conn = new Database(NEXUS_MEMORY_DB, { readonly: true, fileMustExist: true });
    conn.pragma('busy_timeout = 3000');
    const placeholders = TRUSTED_PRIVATE_SOURCES.map(() => '?').join(',');
    const rows = conn.prepare(
      `SELECT source, COUNT(*) AS n FROM memories
       WHERE source IN (${placeholders})
         AND COALESCE(privacy,'public')='public'
       GROUP BY source`
    ).all(...TRUSTED_PRIVATE_SOURCES) as Array<{ source: string; n: number }>;
    if (rows.length === 0) return { ok: true, details: 'clean' };
    const details = rows.map(r => `${r.source}:${r.n}`).join(',');
    return { ok: false, details };
  } catch (err) {
    return { ok: false, details: `check-error:${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { conn?.close(); } catch { /* swallow */ }
  }
}

async function runPhase(name: string, command: string, args: string[]): Promise<boolean> {
  currentPhase = name;
  const env = childEnv();
  watcherLog(`phase=${name} start`);
  watcherJsonl({ event: 'phase_start', phase: name, cmd: command, args });
  const t0 = Date.now();
  const code = await runChild(command, args, env);
  const dur = Date.now() - t0;
  const ok = code === 0;
  watcherJsonl({ event: 'phase_done', phase: name, exit_code: code, duration_ms: dur, status: ok ? 'ok' : 'fail' });
  currentPhase = null;
  return ok;
}

async function tick(): Promise<void> {
  if (currentChild !== null) {
    watcherLog('skip tick: previous child still alive');
    return;
  }

  // Reload state at every tick (Codex P1-2: state can be operator-edited between ticks)
  const state = loadState();
  if (state.disabled) {
    watcherLog(`skip tick: state.disabled=true reason="${state.disabled_reason ?? 'unknown'}" since=${state.disabled_at ?? 'unknown'}`);
    return;
  }

  // P0-2: cross-process orchestrator lock
  if (!acquireLock(ORCHESTRATOR_LOCK_DIR)) return;

  const runId = `run-${Date.now()}`;
  totalRuns += 1;
  lastRunStartedAt = new Date().toISOString();
  const t0 = Date.now();
  watcherJsonl({ event: 'run_start', run_id: runId });

  try {
    const pipelineMinMs = config.OMI_BRIDGE_PIPELINE_MIN_INTERVAL_MS;
    const ocrMinMs = config.OMI_BRIDGE_OCR_MIN_INTERVAL_MS;
    const nerMinMs = config.OMI_BRIDGE_NER_MIN_INTERVAL_MS;
    const tasksMinMs = config.OMI_BRIDGE_TASKS_MIN_INTERVAL_MS;

    let anyPhaseRan = false;
    let anyPhaseFailed = false;

    // Phase 1+2 (snapshot-pull + export + match) — wraps omi_bridge_pipeline.sh
    if (isDue(state.last_pipeline_at, pipelineMinMs)) {
      if (isLockHeldByOther(PIPELINE_LOCK_DIR)) {
        watcherLog('skip pipeline: external pipeline.lock held by another process');
      } else {
        anyPhaseRan = true;
        const ok = await runPhase('pipeline', '/bin/bash', [config.OMI_BRIDGE_PIPELINE_SCRIPT_PATH]);
        if (ok) state.last_pipeline_at = new Date().toISOString();
        else anyPhaseFailed = true;
      }
    }

    // Phase 3 (OCR) — wraps omi_bridge_ocr.sh; skip if external lock present
    if (!anyPhaseFailed && isDue(state.last_ocr_at, ocrMinMs)) {
      if (isLockHeldByOther(OCR_LOCK_DIR)) {
        watcherLog('skip ocr: external ocr.lock held by another process');
      } else {
        anyPhaseRan = true;
        const ok = await runPhase('ocr', '/bin/bash', [config.OMI_BRIDGE_OCR_SCRIPT_PATH]);
        if (ok) state.last_ocr_at = new Date().toISOString();
        else anyPhaseFailed = true;
      }
    }

    // Phase 7.3 NER (memories + segments + scanner_pro — P0-3 v1 path, OCR-source deferred)
    if (!anyPhaseFailed && isDue(state.last_ner_at, nerMinMs)) {
      anyPhaseRan = true;
      const ok = await runPhase(
        'ner',
        '/usr/bin/env',
        ['python3', config.OMI_BRIDGE_NER_SCRIPT_PATH, 'import', '--apply',
         '--sources', 'memories,segments,scanner_pro'],
      );
      if (ok) state.last_ner_at = new Date().toISOString();
      else anyPhaseFailed = true;
    }

    // Phase 7.2 Tasks (continuously refreshes /todos)
    if (!anyPhaseFailed && isDue(state.last_tasks_at, tasksMinMs)) {
      anyPhaseRan = true;
      const ok = await runPhase(
        'tasks',
        '/usr/bin/env',
        ['python3', config.OMI_BRIDGE_TASKS_SCRIPT_PATH, 'import', '--apply'],
      );
      if (ok) state.last_tasks_at = new Date().toISOString();
      else anyPhaseFailed = true;
    }

    // P0-4: privacy postcondition AFTER any writer-phase that touched memory.db
    if (anyPhaseRan) {
      const pc = privacyPostcondition();
      watcherJsonl({ event: 'privacy_postcondition', ok: pc.ok, details: pc.details });
      if (!pc.ok) {
        watcherLog(`PRIVACY VIOLATION after run: ${pc.details}`);
        anyPhaseFailed = true;
      }
    }

    if (anyPhaseFailed) {
      state.consecutive_failures += 1;
      watcherLog(`run failed (consecutive_failures=${state.consecutive_failures})`);
      if (state.consecutive_failures >= FAILURE_DISABLE_AFTER) {
        state.disabled = true;
        state.disabled_reason = `${FAILURE_DISABLE_AFTER} consecutive failures`;
        state.disabled_at = new Date().toISOString();
        watcherLog(`CRITICAL: disabling watcher after ${FAILURE_DISABLE_AFTER} consecutive failures`);
      }
    } else if (anyPhaseRan) {
      state.consecutive_failures = 0;
      state.last_success_at = new Date().toISOString();
      totalSuccessRuns += 1;
    }

    state.last_phase = currentPhase;
    state.last_run_id = runId;
    saveState(state);

    lastRunDurationMs = Date.now() - t0;
    watcherJsonl({
      event: 'run_done', run_id: runId,
      duration_ms: lastRunDurationMs,
      any_phase_ran: anyPhaseRan, failed: anyPhaseFailed,
    });
  } finally {
    releaseLock(ORCHESTRATOR_LOCK_DIR);
  }
}

export function startOmiBridgeWatcher(): void {
  const gate = gateOk();
  if (!gate.ok) {
    watcherLog(`disabled (${gate.reason})`);
    return;
  }

  const state = loadState();
  if (state.disabled) {
    watcherLog(`startup: state.disabled=true reason="${state.disabled_reason ?? 'unknown'}" — NOT scheduling. Operator must clear state-file to re-enable.`);
    return;
  }

  const intervalMs = config.OMI_BRIDGE_WATCHER_INTERVAL_MS;
  watcherLog(`enabled (interval=${intervalMs}ms initial_delay=${INITIAL_DELAY_MS}ms)`);
  watcherJsonl({ event: 'watcher_start', interval_ms: intervalMs, initial_delay_ms: INITIAL_DELAY_MS });

  firstRunTimer = setTimeout(() => {
    firstRunTimer = null;
    tick().catch((err) => watcherLog(`first-tick threw: ${err}`));
  }, INITIAL_DELAY_MS);

  intervalTimer = setInterval(() => {
    tick().catch((err) => watcherLog(`tick threw: ${err}`));
  }, intervalMs);
}

export async function stopOmiBridgeWatcher(): Promise<void> {
  if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  if (firstRunTimer) { clearTimeout(firstRunTimer); firstRunTimer = null; }

  if (currentChild !== null && currentChild.pid != null) {
    watcherLog('shutdown: sending SIGTERM to process group');
    const child = currentChild;
    try {
      // P1-3: negative-PID kills the whole process group (ssh/rsync/ffmpeg/python descendants)
      process.kill(-child.pid!, 'SIGTERM');
    } catch (err) {
      watcherLog(`SIGTERM-group failed (${err instanceof Error ? err.message : String(err)}) — falling back to direct child kill`);
      try { child.kill('SIGTERM'); } catch { /* best-effort */ }
    }
    await new Promise<void>((resolve) => {
      const grace = setTimeout(() => {
        watcherLog('shutdown: SIGKILL after grace');
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, SIGTERM_GRACE_MS);
      child.on('exit', () => { clearTimeout(grace); resolve(); });
    });
    currentChild = null;
  }
  // Release lock if we still hold it
  if (existsSync(ORCHESTRATOR_LOCK_DIR)) {
    const pidFile = join(ORCHESTRATOR_LOCK_DIR, 'pid');
    try {
      if (existsSync(pidFile) && Number((readFileSync(pidFile, 'utf-8') || '').trim()) === process.pid) {
        releaseLock(ORCHESTRATOR_LOCK_DIR);
      }
    } catch { /* swallow */ }
  }
  watcherLog('stopped');
}

export interface OmiBridgeWatcherStatus {
  enabled: boolean;
  reason?: string;
  running: boolean;
  current_phase: string | null;
  disabled_persistent: boolean;
  disabled_reason: string | null;
  consecutive_failures: number;
  total_runs: number;
  total_success_runs: number;
  last_run_started_at: string | null;
  last_run_duration_ms: number | null;
  last_pipeline_at: string | null;
  last_ocr_at: string | null;
  last_ner_at: string | null;
  last_tasks_at: string | null;
}

export function getOmiBridgeWatcherStatus(): OmiBridgeWatcherStatus {
  const gate = gateOk();
  const state = loadState();
  return {
    enabled: gate.ok && intervalTimer !== null && !state.disabled,
    reason: gate.ok ? (state.disabled ? `persistent-disabled:${state.disabled_reason}` : undefined) : gate.reason,
    running: currentChild !== null,
    current_phase: currentPhase,
    disabled_persistent: state.disabled,
    disabled_reason: state.disabled_reason,
    consecutive_failures: state.consecutive_failures,
    total_runs: totalRuns,
    total_success_runs: totalSuccessRuns,
    last_run_started_at: lastRunStartedAt,
    last_run_duration_ms: lastRunDurationMs,
    last_pipeline_at: state.last_pipeline_at,
    last_ocr_at: state.last_ocr_at,
    last_ner_at: state.last_ner_at,
    last_tasks_at: state.last_tasks_at,
  };
}
