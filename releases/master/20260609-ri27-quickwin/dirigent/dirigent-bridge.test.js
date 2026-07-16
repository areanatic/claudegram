/**
 * Dirigent-Bridge v0 — deterministic regression. Run: npx tsx src/dirigent/dirigent-bridge.test.ts
 *
 * Proves the bot↔queue slice WITHOUT a live bot or a real worker:
 *   - dirigent_dispatch enqueues exactly ONE pending row (source_type='telegram', public,
 *     read-only profile, budget from task_type)
 *   - a worker-stub writeback (status=needs_review, result_json) is read back by dirigent_status
 *   - unknown id + still-pending paths
 *   - PRIVACY fail-closed: a /private session is REFUSED — NO row is written
 *
 * Temp dirigent.db via DIRIGENT_DB_PATH; temp NEXUS_ROOT via NEXUS_ROOT_PATH so setPrivate
 * never touches the live privacy-state.json.
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-dirigent-'));
const DB_PATH = path.join(TMP, 'dirigent.db');
process.env.DIRIGENT_DB_PATH = DB_PATH;
process.env.NEXUS_ROOT_PATH = TMP; // redirect privacy-state.json to temp
fs.mkdirSync(path.join(TMP, '.nexus-memory'), { recursive: true });
let pass = 0;
function check(cond, msg) {
    assert.equal(cond, true, msg);
    pass++;
}
// Faithful subset of the live `tasks` + `events` schema (constraints the bridge relies on).
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
const ctx = { sessionKey: '1', telegramCtx: {} };
const inspect = new Database(DB_PATH, { readonly: true });
const taskCount = () => inspect.prepare(`SELECT COUNT(*) c FROM tasks`).get().c;
const idFromText = (t) => {
    const m = t.match(/`([0-9]{14}-[0-9a-f]{8})`/);
    return m ? m[1] : '';
};
// ── 1. public dispatch enqueues exactly one pending telegram row ───────────────
const dispatch = bridge.dirigentDispatchTool(ctx);
const status = bridge.dirigentStatusTool(ctx);
let taskId = '';
{
    const res = await dispatch.handler({ prompt: 'audit the repo', task_type: 'adhoc', priority: 3 }, {});
    const text = res.content[0].text;
    taskId = idFromText(text);
    check(taskId !== '', `dispatch returned a task id (text: ${text.slice(0, 80)})`);
    check(taskCount() === 1, `exactly 1 row enqueued (got ${taskCount()})`);
    const row = inspect.prepare(`SELECT * FROM tasks WHERE id=?`).get(taskId);
    check(row.status === 'pending', `row status=pending (got ${row.status})`);
    check(row.source_type === 'telegram', `source_type=telegram (got ${row.source_type})`);
    check(row.privacy === 'public', `privacy=public (got ${row.privacy})`);
    check(row.permission_profile === 'read-only', `profile read-only (got ${row.permission_profile})`);
    check(row.budget_usd_max === 0.20, `adhoc budget 0.20 (got ${row.budget_usd_max})`);
    check(row.priority === 3, `priority passed through (got ${row.priority})`);
    const ev = inspect.prepare(`SELECT COUNT(*) c FROM events WHERE task_id=? AND event_type='enqueued'`).get(taskId);
    check(ev.c === 1, `enqueued event written (got ${ev.c})`);
}
// ── 2. budget mapping per task_type ───────────────────────────────────────────
{
    const res = await dispatch.handler({ prompt: 'audit', task_type: 'code-audit', priority: undefined }, {});
    const id = idFromText(res.content[0].text);
    const row = inspect.prepare(`SELECT budget_usd_max FROM tasks WHERE id=?`).get(id);
    check(row.budget_usd_max === 0.40, `code-audit budget 0.40 (got ${row.budget_usd_max})`);
}
// ── 3. status: still-pending, unknown, then finished writeback ─────────────────
{
    const pendingRes = await status.handler({ task_id: taskId }, {});
    check(pendingRes.content[0].text.includes('still pending'), 'status reports still pending');
    const unknownRes = await status.handler({ task_id: 'nope-does-not-exist' }, {});
    check(unknownRes.content[0].text.includes('No Dirigent task found'), 'status reports unknown id');
    // worker stub: simulate dispatcher.sh writeback into the SAME row
    const w = new Database(DB_PATH);
    w.prepare(`UPDATE tasks SET status='needs_review', result_json=?, finished_at=datetime('now'), cost_usd=0.03 WHERE id=?`)
        .run(JSON.stringify({ result: 'DONE-42 audit complete' }), taskId);
    w.close();
    const doneRes = await status.handler({ task_id: taskId }, {});
    const dt = doneRes.content[0].text;
    check(dt.includes('needs_review'), 'status surfaces terminal needs_review');
    check(dt.includes('DONE-42 audit complete'), 'status extracts result_json.result');
}
// ── 3b. SECURITY (Codex P1): status must NOT read foreign / non-bridge tasks ───
{
    // a private omi-created task (other ingress) with a result — must be invisible to the bridge
    const w = new Database(DB_PATH);
    w.prepare(`INSERT INTO tasks (id, prompt, task_type, status, source_type, actor, channel, privacy, result_json)
     VALUES ('foreign-omi-001','secret','adhoc','needs_review','omi','automation','privat','private',?)`).run(JSON.stringify({ result: 'SECRET-OMI-RESULT' }));
    w.close();
    const res = await status.handler({ task_id: 'foreign-omi-001' }, {});
    const txt = res.content[0].text;
    check(txt.includes('No Dirigent task found'), 'status refuses a non-bridge task id');
    check(!txt.includes('SECRET-OMI-RESULT'), 'status NEVER leaks a foreign task result_json');
}
// ── 4. PRIVACY fail-closed: /private session is refused, NO row written ─────────
{
    const before = taskCount();
    priv.setPrivate('1'); // make session '1' private
    check(priv.isPrivate('1') === true, 'session marked private');
    const res = await dispatch.handler({ prompt: 'something sensitive', task_type: 'adhoc', priority: undefined }, {});
    const text = res.content[0].text;
    check(text.includes('⛔') || text.toLowerCase().includes("can't"), `private dispatch refused (text: ${text.slice(0, 60)})`);
    check(taskCount() === before, `NO row written for private dispatch (before=${before}, after=${taskCount()})`);
    priv.setPublic('1'); // cleanup (temp file anyway)
}
// cleanup
try {
    inspect.close();
}
catch { /* ignore */ }
try {
    fs.rmSync(TMP, { recursive: true, force: true });
}
catch { /* ignore */ }
console.log(`\n✅ dirigent-bridge: ${pass}/${pass} assertions passed`);
//# sourceMappingURL=dirigent-bridge.test.js.map