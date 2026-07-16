/**
 * EDGE-CASE companion to dirigent-bridge.test.ts. Run: npx tsx src/dirigent/dirigent-bridge.edge.test.ts
 *
 * Gaps targeted:
 *  - EVERY task_type → correct budget + profile (happy-path only covered adhoc + code-audit)
 *  - priority bounds 1 and 10 accepted + persisted; default 5 when omitted
 *  - genId uniqueness across N rapid successive dispatches (no PK collision)
 *  - status of every NON-terminal status (running) → "still <status>"; every TERMINAL status
 *    (needs_review, done, failed, cancelled, rejected, stuck) → surfaced (failed → error path)
 *  - malformed result_json (not JSON) → status returns gracefully, raw text shown, no crash
 *  - result_json without a `result` key → falls back to JSON.stringify(parsed)
 *  - result_json with a non-string `result` (object) → falls back to stringify
 *  - HUGE result (>3000 chars) → truncated with the … sentinel
 *  - SQLITE_BUSY resilience: hold a competing EXCLUSIVE write txn, dispatch must still land
 *    (busy_timeout=30000) once the competing txn commits
 *  - private dispatch refused writes NO task row AND NO event row (header claims "NO row")
 *  - empty-string result_json behaviour ('(no result captured)' only when result_json is NULL)
 *
 * Temp dirigent.db via DIRIGENT_DB_PATH; temp NEXUS_ROOT via NEXUS_ROOT_PATH.
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-dirigent-edge-'));
const DB_PATH = path.join(TMP, 'dirigent.db');
process.env.DIRIGENT_DB_PATH = DB_PATH;
process.env.NEXUS_ROOT_PATH = TMP;
fs.mkdirSync(path.join(TMP, '.nexus-memory'), { recursive: true });
let pass = 0;
function check(cond, msg) {
    assert.equal(cond, true, msg);
    pass++;
}
function seed() {
    const db = new Database(DB_PATH);
    db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','stuck','done','failed','needs_review','rejected','cancelled')),
      priority INTEGER DEFAULT 5,
      created_at DATETIME DEFAULT (datetime('now')),
      finished_at DATETIME,
      depth INTEGER DEFAULT 0,
      privacy TEXT NOT NULL DEFAULT 'public'
        CHECK (privacy IN ('public','private','redacted','needs_review')),
      channel TEXT NOT NULL DEFAULT 'nexus-dev',
      source_type TEXT NOT NULL DEFAULT 'cli'
        CHECK (source_type IN ('cli','telegram','omi','scheduled','webhook','spawned')),
      actor TEXT NOT NULL DEFAULT 'arash',
      permission_profile TEXT NOT NULL DEFAULT 'read-only',
      budget_usd_max REAL DEFAULT 0.50,
      cost_usd REAL,
      result_json TEXT,
      error_message TEXT,
      model_profile TEXT
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      event_type TEXT NOT NULL,
      actor TEXT,
      payload TEXT,
      created_at DATETIME DEFAULT (datetime('now'))
    );
  `);
    db.close();
}
seed();
const bridge = await import('./dirigent-bridge.js');
const priv = await import('../memory/privacy-state.js');
const ctx = { sessionKey: 'edge-1', telegramCtx: {} };
const dispatch = bridge.dirigentDispatchTool(ctx);
const status = bridge.dirigentStatusTool(ctx);
const inspect = new Database(DB_PATH, { readonly: true });
const taskCount = () => inspect.prepare(`SELECT COUNT(*) c FROM tasks`).get().c;
const eventCount = () => inspect.prepare(`SELECT COUNT(*) c FROM events`).get().c;
const idFromText = (t) => {
    const m = t.match(/`([0-9]{14}-[0-9a-f]{8})`/);
    return m ? m[1] : '';
};
// ── 1. EVERY task_type → expected budget + profile ─────────────────────────────
{
    const expected = { adhoc: 0.20, 'code-audit': 0.40, 'morning-brief': 0.30, 'ask-chat': 0.05 };
    for (const [tt, budget] of Object.entries(expected)) {
        const res = await dispatch.handler({ prompt: `do ${tt}`, task_type: tt, priority: undefined }, {});
        const id = idFromText(res.content[0].text);
        check(id !== '', `dispatch ${tt} returned id`);
        const row = inspect.prepare(`SELECT budget_usd_max, permission_profile, priority FROM tasks WHERE id=?`).get(id);
        check(row.budget_usd_max === budget, `${tt}: budget ${budget} (got ${row.budget_usd_max})`);
        check(row.permission_profile === 'read-only', `${tt}: profile read-only (got ${row.permission_profile})`);
        check(row.priority === 5, `${tt}: default priority 5 (got ${row.priority})`);
    }
}
// ── 2. priority bounds 1 and 10 accepted + persisted ───────────────────────────
{
    const r1 = await dispatch.handler({ prompt: 'p1', task_type: 'adhoc', priority: 1 }, {});
    const id1 = idFromText(r1.content[0].text);
    check(inspect.prepare(`SELECT priority FROM tasks WHERE id=?`).get(id1).priority === 1, 'priority=1 (high bound) persisted');
    const r10 = await dispatch.handler({ prompt: 'p10', task_type: 'adhoc', priority: 10 }, {});
    const id10 = idFromText(r10.content[0].text);
    check(inspect.prepare(`SELECT priority FROM tasks WHERE id=?`).get(id10).priority === 10, 'priority=10 (low bound) persisted');
}
// ── 3. genId uniqueness across N rapid dispatches (no PK collision) ─────────────
{
    const N = 25;
    const ids = new Set();
    const before = taskCount();
    for (let i = 0; i < N; i++) {
        const res = await dispatch.handler({ prompt: `rapid-${i}`, task_type: 'ask-chat', priority: undefined }, {});
        const id = idFromText(res.content[0].text);
        check(id !== '', `rapid dispatch ${i} returned id`);
        ids.add(id);
    }
    check(ids.size === N, `genId unique across ${N} rapid calls (got ${ids.size} distinct)`);
    check(taskCount() === before + N, `all ${N} rapid rows landed (no swallowed PK collision)`);
}
// ── 4. status: NON-terminal 'running' → "still running" ────────────────────────
{
    const w = new Database(DB_PATH);
    w.prepare(`INSERT INTO tasks (id, prompt, task_type, status, source_type, actor, channel, privacy, permission_profile)
             VALUES ('edge-running','x','adhoc','running','telegram','arash','nexus-dev','public','read-only')`).run();
    w.close();
    const res = await status.handler({ task_id: 'edge-running' }, {});
    check(res.content[0].text.includes('still running'), 'status non-terminal running → "still running"');
}
// ── 5. status: every TERMINAL status surfaced correctly ────────────────────────
{
    const mk = (id, st, extra = '') => {
        const w = new Database(DB_PATH);
        w.prepare(`INSERT INTO tasks (id, prompt, task_type, status, source_type, actor, channel, privacy, permission_profile, result_json, error_message)
               VALUES (?,?,?,?,'telegram','arash','nexus-dev','public','read-only',?,?)`)
            .run(id, 'x', 'adhoc', st, extra ? JSON.stringify({ result: extra }) : null, st === 'failed' ? 'boom-reason' : null);
        w.close();
    };
    mk('edge-done', 'done', 'DONE-PAYLOAD');
    mk('edge-cancelled', 'cancelled', 'CANCEL-PAYLOAD');
    mk('edge-rejected', 'rejected', 'REJECT-PAYLOAD');
    mk('edge-stuck', 'stuck', 'STUCK-PAYLOAD');
    mk('edge-failed', 'failed');
    const done = (await status.handler({ task_id: 'edge-done' }, {})).content[0].text;
    check(done.includes('done') && done.includes('DONE-PAYLOAD'), 'terminal done surfaces result');
    const canc = (await status.handler({ task_id: 'edge-cancelled' }, {})).content[0].text;
    check(canc.includes('cancelled') && canc.includes('CANCEL-PAYLOAD'), 'terminal cancelled surfaces result');
    const rej = (await status.handler({ task_id: 'edge-rejected' }, {})).content[0].text;
    check(rej.includes('rejected') && rej.includes('REJECT-PAYLOAD'), 'terminal rejected surfaces result');
    const stuck = (await status.handler({ task_id: 'edge-stuck' }, {})).content[0].text;
    check(stuck.includes('stuck') && stuck.includes('STUCK-PAYLOAD'), 'terminal stuck surfaces result');
    const failed = (await status.handler({ task_id: 'edge-failed' }, {})).content[0].text;
    check(failed.includes('failed') && failed.includes('boom-reason'), 'terminal failed → error_message (not result_json)');
}
// ── 6. failed with NULL error_message → "unknown error" ────────────────────────
{
    const w = new Database(DB_PATH);
    w.prepare(`INSERT INTO tasks (id, prompt, task_type, status, source_type, actor, channel, privacy, permission_profile)
             VALUES ('edge-failed-noerr','x','adhoc','failed','telegram','arash','nexus-dev','public','read-only')`).run();
    w.close();
    const txt = (await status.handler({ task_id: 'edge-failed-noerr' }, {})).content[0].text;
    check(txt.includes('unknown error'), 'failed w/ null error_message → "unknown error"');
}
// ── 7. malformed result_json (not JSON) → graceful, raw shown, no crash ─────────
{
    const w = new Database(DB_PATH);
    w.prepare(`INSERT INTO tasks (id, prompt, task_type, status, source_type, actor, channel, privacy, permission_profile, result_json)
             VALUES ('edge-malformed','x','adhoc','done','telegram','arash','nexus-dev','public','read-only', 'this is { not json')`).run();
    w.close();
    const txt = (await status.handler({ task_id: 'edge-malformed' }, {})).content[0].text;
    check(txt.includes('this is { not json'), 'malformed result_json → raw string surfaced (catch → row.result_json)');
    check(!txt.toLowerCase().includes('status error'), 'malformed result_json did NOT throw to the outer error path');
}
// ── 8. result_json WITHOUT a `result` key → falls back to JSON.stringify(parsed) ─
{
    const w = new Database(DB_PATH);
    w.prepare(`INSERT INTO tasks (id, prompt, task_type, status, source_type, actor, channel, privacy, permission_profile, result_json)
             VALUES ('edge-nokey','x','adhoc','done','telegram','arash','nexus-dev','public','read-only', ?)`)
        .run(JSON.stringify({ summary: 'NO-RESULT-KEY-HERE', count: 7 }));
    w.close();
    const txt = (await status.handler({ task_id: 'edge-nokey' }, {})).content[0].text;
    check(txt.includes('NO-RESULT-KEY-HERE') && txt.includes('"count":7'), 'no result key → JSON.stringify(parsed) fallback');
}
// ── 9. result_json with a NON-STRING `result` (object) → stringify fallback ─────
{
    const w = new Database(DB_PATH);
    w.prepare(`INSERT INTO tasks (id, prompt, task_type, status, source_type, actor, channel, privacy, permission_profile, result_json)
             VALUES ('edge-objresult','x','adhoc','done','telegram','arash','nexus-dev','public','read-only', ?)`)
        .run(JSON.stringify({ result: { nested: 'OBJ-RESULT-VAL' } }));
    w.close();
    const txt = (await status.handler({ task_id: 'edge-objresult' }, {})).content[0].text;
    check(txt.includes('OBJ-RESULT-VAL'), 'non-string result (object) → JSON.stringify(parsed) fallback shows nested value');
}
// ── 10. HUGE result (>3000 chars) → truncated with … ───────────────────────────
{
    const big = 'A'.repeat(5000);
    const w = new Database(DB_PATH);
    w.prepare(`INSERT INTO tasks (id, prompt, task_type, status, source_type, actor, channel, privacy, permission_profile, result_json)
             VALUES ('edge-huge','x','adhoc','needs_review','telegram','arash','nexus-dev','public','read-only', ?)`)
        .run(JSON.stringify({ result: big }));
    w.close();
    const txt = (await status.handler({ task_id: 'edge-huge' }, {})).content[0].text;
    check(txt.includes('…'), 'huge result truncated with … sentinel');
    // The truncated payload must be exactly 3000 'A's + '…' embedded in the message.
    check(txt.includes('A'.repeat(3000) + '…'), 'huge result truncated at exactly 3000 chars');
    check(!txt.includes('A'.repeat(3001)), 'huge result does NOT contain 3001 consecutive A (cut enforced)');
}
// ── 11. NULL result_json on terminal non-failed → "(no result captured)" ───────
{
    const w = new Database(DB_PATH);
    w.prepare(`INSERT INTO tasks (id, prompt, task_type, status, source_type, actor, channel, privacy, permission_profile)
             VALUES ('edge-noresult','x','adhoc','needs_review','telegram','arash','nexus-dev','public','read-only')`).run();
    w.close();
    const txt = (await status.handler({ task_id: 'edge-noresult' }, {})).content[0].text;
    check(txt.includes('(no result captured)'), 'terminal w/ NULL result_json → "(no result captured)"');
}
// ── 12. SQLITE_BUSY resilience: competing write lock held by a SEPARATE OS PROCESS ──
{
    // better-sqlite3 is SYNCHRONOUS: an in-process blocker can't release while the bridge's
    // synchronous INSERT blocks the single JS thread (it would just deadlock → spurious
    // SQLITE_BUSY). The REAL contender is dispatcher.sh in another OS process. So we spawn a
    // detached child that BEGIN IMMEDIATE-locks the DB, sleeps ~600ms, then COMMITs. The
    // bridge's INSERT (busy_timeout=30000) must wait for the OS-level lock and then succeed.
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const betterSqlitePath = req.resolve('better-sqlite3');
    const blockerScript = path.join(TMP, 'blocker.cjs');
    fs.writeFileSync(blockerScript, `
    const Database = require(${JSON.stringify(betterSqlitePath)});
    const db = new Database(${JSON.stringify(DB_PATH)});
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO tasks (id, prompt, task_type, status, source_type, actor, channel, privacy, permission_profile) VALUES ('blocker-row','x','adhoc','pending','cli','arash','nexus-dev','public','read-only')").run();
    setTimeout(() => { try { db.exec('COMMIT'); } catch (e) {} db.close(); process.exit(0); }, 600);
  `);
    const { spawnSync, spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [blockerScript], { detached: true, stdio: 'ignore' });
    // Give the child time to acquire the IMMEDIATE lock before we dispatch.
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 150)']);
    const t0 = Date.now();
    const res = await dispatch.handler({ prompt: 'busy-test', task_type: 'adhoc', priority: undefined }, {});
    const waited = Date.now() - t0;
    try {
        child.kill();
    }
    catch { /* already exited */ }
    const text = res.content[0].text;
    const busyId = idFromText(text);
    check(busyId !== '', `dispatch under cross-process lock still returned an id (waited ${waited}ms; text: ${text.slice(0, 60)})`);
    check(!text.toLowerCase().includes('dispatch error'), 'dispatch did NOT error under cross-process write contention (busy_timeout absorbed it)');
    // Assert by the bridge's OWN id (the child also commits its blocker-row, so total count grows by 2).
    const landed = inspect.prepare(`SELECT COUNT(*) c FROM tasks WHERE id=? AND prompt='busy-test'`).get(busyId);
    check(landed.c === 1, `the bridge's own row landed exactly once despite contention (got ${landed.c})`);
    check(waited >= 150, `dispatch actually BLOCKED on the lock before succeeding (waited ${waited}ms — proves busy_timeout in play)`);
}
// ── 13. private dispatch refused → NO task row AND NO event row ─────────────────
{
    const beforeTasks = taskCount();
    const beforeEvents = eventCount();
    priv.setPrivate('edge-1');
    check(priv.isPrivate('edge-1') === true, 'session marked private');
    const res = await dispatch.handler({ prompt: 'sensitive', task_type: 'adhoc', priority: undefined }, {});
    const text = res.content[0].text;
    check(text.includes('⛔') || text.toLowerCase().includes("can't"), 'private dispatch refused');
    check(taskCount() === beforeTasks, `NO task row written for private dispatch (before=${beforeTasks}, after=${taskCount()})`);
    check(eventCount() === beforeEvents, `NO event row written for private dispatch (before=${beforeEvents}, after=${eventCount()})`);
    priv.setPublic('edge-1');
}
// ── 14. dispatch on a missing/uncreatable DB → graceful isError (no throw) ──────
{
    // Point at a non-existent DB path (fileMustExist:true) for ONE call to prove the error path.
    const realPath = process.env.DIRIGENT_DB_PATH;
    process.env.DIRIGENT_DB_PATH = path.join(TMP, 'does-not-exist.db');
    const res = await dispatch.handler({ prompt: 'orphan', task_type: 'adhoc', priority: undefined }, {});
    const text = res.content[0].text;
    check(res.isError === true, 'dispatch on missing DB returns isError=true (no unhandled throw)');
    check(text.includes('Dirigent dispatch error'), 'dispatch on missing DB surfaces a friendly error message');
    process.env.DIRIGENT_DB_PATH = realPath; // restore
}
try {
    inspect.close();
}
catch { /* ignore */ }
try {
    fs.rmSync(TMP, { recursive: true, force: true });
}
catch { /* ignore */ }
console.log(`\n✅ dirigent-bridge.edge: ${pass}/${pass} assertions passed`);
//# sourceMappingURL=dirigent-bridge.edge.test.js.map