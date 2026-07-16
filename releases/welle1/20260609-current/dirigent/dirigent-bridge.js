// Dirigent-Bridge v0 — connect @AstronOne (ONE channel) to the existing Dirigent worker queue.
//
// Architecture (Codex 0.86): @AstronOne stays a single channel; the Dirigent is a worker
// BACKEND, not separate bots. v0 vertical slice: the bot enqueues ONE sub-task row into the
// Dirigent queue (dirigent.db), the existing dispatcher.sh tick claims+runs it, and the bot
// polls the result back via dirigent_status. No new worker, no callback, no migration —
// `source_type='telegram'` already exists in the tasks CHECK (migrations/001_initial.sql).
//
// Plan: shared-memory/nexus/dirigent_bridge_v0_impl_plan_2026-06-03.md
//
// PRIVACY (fail-closed): private/sensitive sessions are REFUSED in v0 — NOT silently
// downgraded. The dispatcher's enforce_privacy_routing is warn-only AND the backend has
// `model_fallback_on_ollama_fail=claude-haiku` (migrations/002_model_routing.sql:17), so a
// private task forced to a local model could still leak to cloud if the local model fails.
// Until the v1 backend hard-override lands, the only honest fail-closed posture is to refuse
// dispatching private tasks. Public tasks dispatch normally (fire + poll).
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { isPrivate } from '../memory/privacy-state.js';
const DEFAULT_DIRIGENT_DB = '/Volumes/AstronOne/shared-memory/nexus/dirigent/dirigent.db';
/** DB path. Env-overridable ONLY for deterministic tests (mirrors lib/db.sh:8). */
function dirigentDbPath() {
    return process.env.DIRIGENT_DB_PATH || DEFAULT_DIRIGENT_DB;
}
/** Time-sortable id matching the backend's gen_id (lib/db.sh:13-17): YYYYMMDDHHMMSS-<8hex>, UTC. */
function genId() {
    const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    return `${ts}-${randomBytes(4).toString('hex')}`;
}
/** v0 exposes ONLY read-only, low-budget task types (prompt-injection containment, R6).
 *  profile + budget mirror enqueue.sh:138-155 but capped MORE conservatively for the bot ingress. */
const TASK_PROFILES = {
    adhoc: { profile: 'read-only', budget: 0.20 },
    'code-audit': { profile: 'read-only', budget: 0.40 },
    'morning-brief': { profile: 'read-only', budget: 0.30 },
    'ask-chat': { profile: 'read-only', budget: 0.05 },
};
const TASK_TYPES = ['adhoc', 'code-audit', 'morning-brief', 'ask-chat'];
const TERMINAL = new Set(['needs_review', 'done', 'failed', 'cancelled', 'rejected', 'stuck']);
function openDb(readonly) {
    const db = new Database(dirigentDbPath(), { readonly, fileMustExist: true });
    db.pragma('busy_timeout = 30000');
    return db;
}
// ── Tool 1: dirigent_dispatch — enqueue ONE pending sub-task ───────────────────
export function dirigentDispatchTool(toolsCtx) {
    return tool('dirigent_dispatch', 'Dispatch ONE background sub-task to the Dirigent worker queue when a request is long-running ' +
        'or better handled out-of-band (e.g. "audit this repo", "draft the morning brief"). The worker ' +
        'runs asynchronously on its own tick (~15 min); this returns a task_id immediately. Poll the ' +
        'result later with dirigent_status(task_id). v0 supports read-only, low-budget task types only. ' +
        'NOTE: while /private mode is on, dispatch is REFUSED (the worker cannot yet guarantee local-only ' +
        'execution) — handle sensitive work in-channel instead.', {
        prompt: z.string().min(1).describe('The sub-task instruction for the background worker.'),
        task_type: z.enum(TASK_TYPES).optional().describe('Worker profile (default "adhoc"). All read-only/low-budget in v0.'),
        priority: z.number().int().min(1).max(10).optional().describe('1=high .. 10=low (default 5).'),
    }, async ({ prompt, task_type, priority }) => {
        // Fail-closed: never enqueue a private session's task (see file header).
        if (isPrivate(toolsCtx.sessionKey)) {
            return {
                content: [{
                        type: 'text',
                        text: '⛔ Private/sensitive sub-tasks can\'t be dispatched to the background worker yet — ' +
                            'the worker\'s local-only routing guarantee (backend hard-override) lands in v1, and until ' +
                            'then the dispatcher could fall back to a cloud model on local-model failure. Handle this ' +
                            'in-channel, or turn /private off if it is not sensitive.',
                    }],
            };
        }
        const tt = task_type ?? 'adhoc';
        const { profile, budget } = TASK_PROFILES[tt];
        const id = genId();
        let db = null;
        try {
            db = openDb(false);
            const insert = db.prepare(`INSERT INTO tasks (id, prompt, task_type, priority, channel, privacy, source_type, actor, permission_profile, budget_usd_max, depth)
           VALUES (?, ?, ?, ?, 'nexus-dev', 'public', 'telegram', 'arash', ?, ?, 0)`);
            const ev = db.prepare(`INSERT INTO events (task_id, event_type, actor, payload) VALUES (?, 'enqueued', 'arash', ?)`);
            const txn = db.transaction(() => {
                insert.run(id, prompt, tt, priority ?? 5, profile, budget);
                ev.run(id, JSON.stringify({ task_type: tt, channel: 'nexus-dev', priority: priority ?? 5, source: 'telegram-bridge' }));
            });
            txn();
            return {
                content: [{
                        type: 'text',
                        text: `🎛 Dispatched sub-task \`${id}\` (type=${tt}, profile=${profile}, budget≤$${budget.toFixed(2)}). ` +
                            `The background worker runs on its next tick (~15 min). Poll with dirigent_status("${id}").`,
                    }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Dirigent dispatch error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
        finally {
            try {
                db?.close();
            }
            catch { /* swallow */ }
        }
    });
}
// ── Tool 2: dirigent_status — poll a dispatched task's result ──────────────────
export function dirigentStatusTool(_toolsCtx) {
    return tool('dirigent_status', 'Check the status / collect the result of a background sub-task previously created with ' +
        'dirigent_dispatch. Pass the task_id you got back. Returns the current state, or the worker\'s ' +
        'result once it has finished (status needs_review/done).', {
        task_id: z.string().min(1).describe('Task id returned by dirigent_dispatch.'),
    }, async ({ task_id }) => {
        let db = null;
        try {
            db = openDb(true);
            // Codex P1: scope reads to bridge-OWNED rows only. Without this, any known task id
            // (incl. CLI/omi/private tasks from other ingress) could leak its result_json via the
            // bot. These four constants are exactly what dirigent_dispatch writes — so the bridge
            // can only ever read back what it itself enqueued.
            const row = db.prepare(`SELECT status, result_json, error_message, cost_usd FROM tasks
           WHERE id = ? AND source_type = 'telegram' AND actor = 'arash'
                 AND channel = 'nexus-dev' AND privacy = 'public'`).get(task_id);
            if (!row) {
                return { content: [{ type: 'text', text: `No Dirigent task found with id "${task_id}".` }] };
            }
            if (!TERMINAL.has(row.status)) {
                return { content: [{ type: 'text', text: `Task ${task_id} is still ${row.status}. The worker runs ~every 15 min — check again shortly.` }] };
            }
            if (row.status === 'failed') {
                return { content: [{ type: 'text', text: `Task ${task_id} failed: ${row.error_message ?? 'unknown error'}.` }] };
            }
            let result = '(no result captured)';
            if (row.result_json) {
                try {
                    const parsed = JSON.parse(row.result_json);
                    result = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed);
                }
                catch {
                    result = row.result_json;
                }
            }
            const truncated = result.length > 3000 ? result.slice(0, 3000) + '…' : result;
            const cost = row.cost_usd != null ? ` (cost $${row.cost_usd})` : '';
            return { content: [{ type: 'text', text: `🎛 Task ${task_id} → ${row.status}${cost}:\n\n${truncated}` }] };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Dirigent status error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
        finally {
            try {
                db?.close();
            }
            catch { /* swallow */ }
        }
    });
}
//# sourceMappingURL=dirigent-bridge.js.map