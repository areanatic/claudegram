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
import { spawn } from 'child_process';
import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, statSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
const PROD_NEXUS_MEMORY_DB = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db';
// The postcondition reads the SAME DB the OMI Python writers mutate. To unit-test
// it against a throwaway fixture we use a DEDICATED override env (OMI_WATCHER_TEST_DB),
// NOT the generic NEXUS_MEMORY_DB. Codex M-11 finding (2026-06-07): the writers
// hardcode the prod DB, so honoring NEXUS_MEMORY_DB here would let an accidental
// service-env value point the check at a different DB than the writers touch —
// real leaks would go undetected. A dedicated test-only var can't be set by accident.
const NEXUS_MEMORY_DB = process.env.OMI_WATCHER_TEST_DB || PROD_NEXUS_MEMORY_DB;
const OMI_BRIDGE_DB = '/Volumes/AstronOne/shared-memory/omi-bridge/indexed/omi_bridge.db';
const WATCHER_LOG = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/omi-bridge-sync.log';
const STATE_FILE = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/omi-bridge-watcher-state.json';
const ORCHESTRATOR_LOCK_DIR = '/Volumes/AstronOne/shared-memory/omi-bridge/.locks/orchestrator.lock';
const PIPELINE_LOCK_DIR = '/Volumes/AstronOne/shared-memory/omi-bridge/.locks/pipeline.lock';
const OCR_LOCK_DIR = '/Volumes/AstronOne/shared-memory/omi-bridge/.locks/ocr.lock';
const BOOT_RECOVERY_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30min — anything older is definitely dead
// Retrieval allowlist — kept here ONLY as a documentation anchor that must stay
// in sync with DEFAULT_TRUSTED_PRIVATE_SOURCES in src/memory/nexus-memory.ts
// (which is the real allowlist deciding what an operator bot may privately READ).
// This watcher no longer uses it for the privacy postcondition — see
// OMI_WRITER_SOURCES below for why.
const TRUSTED_PRIVATE_SOURCES = [
    'omi', 'omi-bridge', 'omi-bridge-task', 'omi-synthesis',
    'scanner-pro', 'nexusgram', 'link-inbox', 'auto-index',
];
// Sources actually WRITTEN by the OMI-Bridge pipeline phases this watcher runs
// (pipeline → ocr → ner → tasks). Includes both the legacy writer name
// (`scanner-pro-original`) and the current ones — every row a watcher phase can
// create must be private. The privacy postcondition checks ONLY these.
//
// Why this differs from TRUSTED_PRIVATE_SOURCES: that list also contains
// `nexusgram`, `link-inbox` and `auto-index`, which the watcher does NOT write
// and which legitimately hold public rows (e.g. shared TikTok links). Checking
// them after an OMI run produced false PRIVACY VIOLATIONS → 3 consecutive
// failures → watcher self-disabled (2026-05-27). A writer-phase postcondition
// must only assert about the rows the writer phases can touch.
// Exported so a test can pin the inventory and catch drift (Codex M-11 finding):
// a future typo or a new writer source added outside this list would silently
// slip past the exact `source IN (...)` check.
export const OMI_WRITER_SOURCES = [
    'omi', 'omi-bridge', 'omi-bridge-task', 'omi-synthesis',
    'scanner-pro', 'scanner-pro-original',
];
const SIGTERM_GRACE_MS = 8_000;
const INITIAL_DELAY_MS = 120_000;
const FAILURE_DISABLE_AFTER = 3;
const LOCK_STALE_MS = 30 * 60 * 1000; // 30min — orchestrator runs are at most ~5min
const DEFAULT_STATE = {
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
let intervalTimer = null;
let firstRunTimer = null;
let currentChild = null;
let currentPhase = null;
let totalRuns = 0;
let totalSuccessRuns = 0;
let lastRunStartedAt = null;
let lastRunDurationMs = null;
function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function watcherLog(msg) {
    const line = `[${ts()}] [OmiBridgeWatcher] ${msg}\n`;
    try {
        appendFileSync(WATCHER_LOG, line);
    }
    catch {
        console.error(line.trimEnd());
    }
}
function watcherJsonl(event) {
    // Codex P2-1: machine-readable JSONL alongside the human tail line.
    const payload = JSON.stringify({ ts: new Date().toISOString(), ...event });
    try {
        appendFileSync(WATCHER_LOG, payload + '\n');
    }
    catch { /* fallback already covered by watcherLog */ }
}
function loadState() {
    try {
        if (!existsSync(STATE_FILE))
            return { ...DEFAULT_STATE };
        const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
        return { ...DEFAULT_STATE, ...raw };
    }
    catch (err) {
        watcherLog(`state-load failed (using defaults): ${err instanceof Error ? err.message : String(err)}`);
        return { ...DEFAULT_STATE };
    }
}
function saveState(state) {
    try {
        writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }
    catch (err) {
        watcherLog(`state-save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function gateOk() {
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
function acquireLock(lockPath) {
    try {
        mkdirSync(lockPath, { recursive: false });
        writeFileSync(join(lockPath, 'pid'), String(process.pid));
        writeFileSync(join(lockPath, 'started_at'), new Date().toISOString());
        return true;
    }
    catch {
        // Lock dir already exists — check staleness
        try {
            const ageMs = Date.now() - statSync(lockPath).mtimeMs;
            const pidFile = join(lockPath, 'pid');
            let alive = false;
            if (existsSync(pidFile)) {
                const pid = Number((readFileSync(pidFile, 'utf-8') || '').trim());
                if (Number.isFinite(pid) && pid > 0) {
                    try {
                        process.kill(pid, 0);
                        alive = true;
                    }
                    catch {
                        alive = false;
                    }
                }
            }
            if (!alive && ageMs > LOCK_STALE_MS) {
                watcherLog(`stale lock detected (age=${Math.floor(ageMs / 1000)}s, PID-dead) — breaking`);
                try {
                    rmdirSync(lockPath, { recursive: true });
                }
                catch { /* try direct rm */ }
                return acquireLock(lockPath);
            }
            watcherLog(`lock held by alive PID — skipping this tick (age=${Math.floor(ageMs / 1000)}s)`);
        }
        catch (err) {
            watcherLog(`lock-check error: ${err instanceof Error ? err.message : String(err)}`);
        }
        return false;
    }
}
function releaseLock(lockPath) {
    try {
        rmdirSync(lockPath, { recursive: true });
    }
    catch (err) {
        watcherLog(`lock-release error: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function isLockHeldByOther(lockPath) {
    if (!existsSync(lockPath))
        return false;
    const pidFile = join(lockPath, 'pid');
    if (!existsSync(pidFile))
        return false;
    try {
        const pid = Number((readFileSync(pidFile, 'utf-8') || '').trim());
        if (!Number.isFinite(pid) || pid <= 0)
            return false;
        if (pid === process.pid)
            return false;
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            return false;
        }
    }
    catch {
        return false;
    }
}
/** Run a child process in its own process group; resolves with exit code (or null on spawn-error). */
function runChild(command, args, env) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        try {
            const child = spawn(command, args, {
                stdio: 'ignore', // wrapped scripts/python write their own logs
                detached: true, // P1-3: own process-group for SIGTERM-group on shutdown
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
        }
        catch (err) {
            watcherLog(`spawn threw: ${err instanceof Error ? err.message : String(err)}`);
            currentChild = null;
            resolve(null);
        }
    });
}
function isDue(lastIso, minIntervalMs) {
    if (!lastIso)
        return true;
    const last = Date.parse(lastIso);
    if (!Number.isFinite(last))
        return true;
    return Date.now() - last >= minIntervalMs;
}
function childEnv() {
    // Codex P0-4: explicitly pass scope-aware env to child. Don't rely on inheritance.
    return {
        ...process.env,
        BOT_NAME: config.BOT_NAME,
        NEXUS_MEMORY_SCOPE: config.NEXUS_MEMORY_SCOPE ?? 'self_private',
    };
}
/** Codex P0-4: privacy postcondition — OMI writer-phase sources MUST NOT have
 *  public rows. Exported so it can be unit-tested against a fixture DB
 *  (NEXUS_MEMORY_DB env override). Checks OMI_WRITER_SOURCES only (the rows the
 *  watcher's phases can actually create), NOT the broader retrieval allowlist. */
export function privacyPostcondition() {
    let conn = null;
    try {
        conn = new Database(NEXUS_MEMORY_DB, { readonly: true, fileMustExist: true });
        conn.pragma('busy_timeout = 3000');
        const placeholders = OMI_WRITER_SOURCES.map(() => '?').join(',');
        const rows = conn.prepare(`SELECT source, COUNT(*) AS n FROM memories
       WHERE source IN (${placeholders})
         AND COALESCE(privacy,'public')='public'
       GROUP BY source`).all(...OMI_WRITER_SOURCES);
        if (rows.length === 0)
            return { ok: true, details: 'clean' };
        const details = rows.map(r => `${r.source}:${r.n}`).join(',');
        return { ok: false, details };
    }
    catch (err) {
        return { ok: false, details: `check-error:${err instanceof Error ? err.message : String(err)}` };
    }
    finally {
        try {
            conn?.close();
        }
        catch { /* swallow */ }
    }
}
async function runPhase(name, command, args) {
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
async function tick() {
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
    if (!acquireLock(ORCHESTRATOR_LOCK_DIR))
        return;
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
            }
            else {
                anyPhaseRan = true;
                const ok = await runPhase('pipeline', '/bin/bash', [config.OMI_BRIDGE_PIPELINE_SCRIPT_PATH]);
                if (ok)
                    state.last_pipeline_at = new Date().toISOString();
                else
                    anyPhaseFailed = true;
            }
        }
        // Phase 3 (OCR) — wraps omi_bridge_ocr.sh; skip if external lock present
        if (!anyPhaseFailed && isDue(state.last_ocr_at, ocrMinMs)) {
            if (isLockHeldByOther(OCR_LOCK_DIR)) {
                watcherLog('skip ocr: external ocr.lock held by another process');
            }
            else {
                anyPhaseRan = true;
                const ok = await runPhase('ocr', '/bin/bash', [config.OMI_BRIDGE_OCR_SCRIPT_PATH]);
                if (ok)
                    state.last_ocr_at = new Date().toISOString();
                else
                    anyPhaseFailed = true;
            }
        }
        // Phase 7.3 NER (memories + segments + scanner_pro — P0-3 v1 path, OCR-source deferred)
        if (!anyPhaseFailed && isDue(state.last_ner_at, nerMinMs)) {
            anyPhaseRan = true;
            const ok = await runPhase('ner', '/usr/bin/env', ['python3', config.OMI_BRIDGE_NER_SCRIPT_PATH, 'import', '--apply',
                '--sources', 'memories,segments,scanner_pro']);
            if (ok)
                state.last_ner_at = new Date().toISOString();
            else
                anyPhaseFailed = true;
        }
        // Phase 7.2 Tasks (continuously refreshes /todos)
        if (!anyPhaseFailed && isDue(state.last_tasks_at, tasksMinMs)) {
            anyPhaseRan = true;
            const ok = await runPhase('tasks', '/usr/bin/env', ['python3', config.OMI_BRIDGE_TASKS_SCRIPT_PATH, 'import', '--apply']);
            if (ok)
                state.last_tasks_at = new Date().toISOString();
            else
                anyPhaseFailed = true;
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
        }
        else if (anyPhaseRan) {
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
    }
    finally {
        releaseLock(ORCHESTRATOR_LOCK_DIR);
    }
}
/** Codex P1-4: at watcher boot, mark any `running` runs older than 30min as
 *  `aborted`. They are leftovers from a previous Master process that got
 *  SIGTERMed (e.g. during a deploy). Without cleanup, /health stats lie and
 *  the failure-counter can over-trigger.
 *
 *  Tables:
 *   - omi_bridge.db.export_runs (P1+P2)
 *   - omi_bridge.db.ocr_runs (P3)
 *   - memory.db.entity_extraction_runs (P7.3 NER)
 */
function bootRecovery() {
    const cutoff = new Date(Date.now() - BOOT_RECOVERY_STALE_THRESHOLD_MS).toISOString();
    const summary = [];
    // memory.db NER runs
    try {
        const conn = new Database(NEXUS_MEMORY_DB, { fileMustExist: true });
        try {
            conn.pragma('busy_timeout = 5000');
            const result = conn.prepare("UPDATE entity_extraction_runs SET status='aborted', " +
                "error=COALESCE(error,'') || ' [boot-recovery: marked aborted, started before ' || ? || ']', " +
                "finished_at_utc=strftime('%Y-%m-%dT%H:%M:%SZ', 'now') " +
                "WHERE status='running' AND started_at_utc < ?").run(cutoff, cutoff);
            if (result.changes > 0)
                summary.push(`ner:${result.changes}`);
        }
        finally {
            conn.close();
        }
    }
    catch (err) {
        watcherLog(`boot-recovery memory.db error: ${err instanceof Error ? err.message : String(err)}`);
    }
    // omi_bridge.db export + ocr runs
    try {
        const conn = new Database(OMI_BRIDGE_DB, { fileMustExist: true });
        try {
            conn.pragma('busy_timeout = 5000');
            const exportResult = conn.prepare("UPDATE export_runs SET status='aborted', " +
                "error=COALESCE(error,'') || ' [boot-recovery: marked aborted, started before ' || ? || ']', " +
                "finished_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now') " +
                "WHERE status='running' AND started_at < ?").run(cutoff, cutoff);
            if (exportResult.changes > 0)
                summary.push(`export:${exportResult.changes}`);
            const ocrResult = conn.prepare("UPDATE ocr_runs SET status='aborted', " +
                "error=COALESCE(error,'') || ' [boot-recovery: marked aborted, started before ' || ? || ']', " +
                "finished_at=strftime('%Y-%m-%dT%H:%M:%SZ', 'now') " +
                "WHERE status='running' AND started_at < ?").run(cutoff, cutoff);
            if (ocrResult.changes > 0)
                summary.push(`ocr:${ocrResult.changes}`);
        }
        finally {
            conn.close();
        }
    }
    catch (err) {
        watcherLog(`boot-recovery omi_bridge.db error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (summary.length > 0) {
        watcherLog(`boot-recovery: aborted stale 'running' runs older than ${cutoff} — ${summary.join(', ')}`);
        watcherJsonl({ event: 'boot_recovery', aborted: summary.join(','), cutoff });
    }
}
export function startOmiBridgeWatcher() {
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
    // Phase 7.7 v1.1 (Codex P1-4): mark stale running runs as aborted before scheduling
    bootRecovery();
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
export async function stopOmiBridgeWatcher() {
    if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
    }
    if (firstRunTimer) {
        clearTimeout(firstRunTimer);
        firstRunTimer = null;
    }
    if (currentChild !== null && currentChild.pid != null) {
        watcherLog('shutdown: sending SIGTERM to process group');
        const child = currentChild;
        try {
            // P1-3: negative-PID kills the whole process group (ssh/rsync/ffmpeg/python descendants)
            process.kill(-child.pid, 'SIGTERM');
        }
        catch (err) {
            watcherLog(`SIGTERM-group failed (${err instanceof Error ? err.message : String(err)}) — falling back to direct child kill`);
            try {
                child.kill('SIGTERM');
            }
            catch { /* best-effort */ }
        }
        await new Promise((resolve) => {
            const grace = setTimeout(() => {
                watcherLog('shutdown: SIGKILL after grace');
                try {
                    process.kill(-child.pid, 'SIGKILL');
                }
                catch { /* ignore */ }
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
        }
        catch { /* swallow */ }
    }
    watcherLog('stopped');
}
export function getOmiBridgeWatcherStatus() {
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
//# sourceMappingURL=omi-bridge-watcher.js.map