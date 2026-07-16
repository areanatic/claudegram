/**
 * INV-01 Auto-Resume — claim-selection regression.
 * Run: npx tsx src/inbox/input-log.test.ts
 *
 * Proves the resumable-orphan partition (Tier-2 FINAL Codex corrections #2/#3 +
 * Teil B §2.2/§3/§7): on boot only RECENT, PUBLIC, non-empty TEXT rows with
 * attempts left and NO mutating tool started are claimed for replay; private /
 * media / side-effect / attempts-exhausted / over-cap / old-drift rows are not.
 * The resume_attempts increment is durable (crash-loop terminates at MAX).
 *
 * The config module hard-fails on missing env, so the env below is set BEFORE
 * the (dynamic) import of input-log.js. DATA_DIR points at a throwaway temp dir.
 */
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-inputlog-test-'));
process.env.NEXUSGRAM_ENV_PATH = path.join(TMP, 'nonexistent.env'); // dotenv no-op → use only our env
process.env.CLAUDEGRAM_ENV_PATH = process.env.NEXUSGRAM_ENV_PATH;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'TestBot'; // not 'Nexusgram' → skip master scope-assertion
process.env.NEXUS_MEMORY_SCOPE = 'public';
process.env.DATA_DIR = TMP;
process.env.NEXUSGRAM_MAX_RESUME_ATTEMPTS = '2';
process.env.NEXUSGRAM_MAX_BOOT_RESUME = '5';
const DB_PATH = path.join(TMP, 'input-log.db');
const RECENT_WINDOW_MS = 600_000; // mirrors RECENT_ORPHAN_WINDOW_MS
let pass = 0;
function check(cond, msg) {
    assert.equal(cond, true, msg);
    pass++;
}
// Direct connection for test setup/inspection (the real module owns its own).
function withDb(fn) {
    const db = new Database(DB_PATH);
    try {
        return fn(db);
    }
    finally {
        db.close();
    }
}
function setRow(id, fields) {
    withDb((db) => {
        const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
        db.prepare(`UPDATE input_log SET ${sets} WHERE id = @id`).run({ ...fields, id });
    });
}
function getRow(id) {
    return withDb((db) => db.prepare('SELECT * FROM input_log WHERE id = ?').get(id));
}
function clearRows() {
    withDb((db) => db.exec('DELETE FROM input_log'));
}
function iso(offsetMs) {
    return new Date(Date.now() + offsetMs).toISOString();
}
(async () => {
    const { recordInput, claimResumableOrphans, markSideEffectStarted, ensureInputLogInitialized, clampBootCap, clampInt, hasNewerDuplicate, } = await import('./input-log.js');
    // Force the module to create the schema before any direct test connection
    // (clearRows/setRow) touches the DB file.
    ensureInputLogInitialized();
    let msg = 1000;
    // Insert a 'received' row, then force-set received_at / extra fields so the
    // recency window + ordering are deterministic.
    function insert(opts) {
        const id = recordInput({
            messageId: msg++,
            chatId: opts.chatId,
            sessionKey: opts.sessionKey,
            inputType: opts.inputType ?? 'text',
            rawContent: opts.rawContent ?? 'hello',
            privacy: opts.privacy ?? 'public',
        });
        assert.ok(id != null, 'recordInput returned a row id');
        const fields = { received_at: iso(opts.receivedAtMs) };
        if (opts.resumeAttempts != null)
            fields.resume_attempts = opts.resumeAttempts;
        if (opts.sideEffectAt !== undefined)
            fields.side_effect_tool_started_at = opts.sideEffectAt;
        setRow(id, fields);
        return id;
    }
    // ── Phase 1: partition over one claim ──────────────────────────────────────
    clearRows();
    // B is OLDER than A (both recent) → B must come first (ASC received_at).
    const B = insert({ chatId: 10, sessionKey: '10', receivedAtMs: -120_000, rawContent: 'second oldest' });
    const A = insert({ chatId: 10, sessionKey: '10', receivedAtMs: -60_000, rawContent: 'most recent' });
    const C = insert({ chatId: 11, sessionKey: '11', receivedAtMs: -60_000, privacy: 'private', rawContent: 'secret' });
    const D = insert({ chatId: 12, sessionKey: '12', receivedAtMs: -60_000, rawContent: 'had tool', sideEffectAt: iso(-50_000) });
    const E = insert({ chatId: 13, sessionKey: '13', receivedAtMs: -60_000, rawContent: 'poison', resumeAttempts: 2 });
    const F = insert({ chatId: 14, sessionKey: '14', receivedAtMs: -60_000, inputType: 'photo', rawContent: null });
    const G = insert({ chatId: 15, sessionKey: '15', receivedAtMs: -60_000, rawContent: '   ' });
    const H = insert({ chatId: 16, sessionKey: '16', receivedAtMs: -(2 * RECENT_WINDOW_MS), rawContent: 'old drift' });
    const r1 = claimResumableOrphans();
    check(r1.resumable.length === 2, `exactly 2 rows claimed (got ${r1.resumable.length})`);
    check(r1.resumable[0].id === B && r1.resumable[1].id === A, 'claimed in ASC received_at order (B before A)');
    check(r1.resumable.every((o) => o.privacy === 'public'), 'only public rows claimed');
    check(getRow(A).status === 'processing' && getRow(B).status === 'processing', 'claimed rows → processing');
    check(getRow(A).resume_attempts === 1 && getRow(B).resume_attempts === 1, 'claimed rows incremented to 1');
    const recentChats = new Set(r1.recentOrphans.map((o) => o.chatId));
    check(recentChats.has(11), 'private row surfaced for re-send');
    check(recentChats.has(12), 'side-effect row surfaced for re-send');
    check(recentChats.has(13), 'attempts-exhausted row surfaced for re-send');
    check(recentChats.has(14), 'media row surfaced for re-send');
    check(recentChats.has(15), 'empty-content row surfaced for re-send');
    check(!recentChats.has(16), 'old-drift row NOT surfaced (silent drop)');
    check(!recentChats.has(10), 'claimed chat NOT in re-send notice');
    for (const id of [C, D, E, F, G, H]) {
        check(getRow(id).status === 'dropped', `non-replayable row ${id} dropped`);
    }
    check(getRow(C).resume_attempts === 0, 'private row attempts untouched');
    check(getRow(E).resume_attempts === 2, 'exhausted row attempts untouched (not re-incremented)');
    // ── Phase 2: per-boot cap (MAX_BOOT_RESUME = 5) ─────────────────────────────
    clearRows();
    const seven = [];
    for (let i = 0; i < 7; i++) {
        seven.push(insert({ chatId: 20 + i, sessionKey: `${20 + i}`, receivedAtMs: -60_000 + i * 1_000, rawContent: `m${i}` }));
    }
    const r2 = claimResumableOrphans();
    check(r2.resumable.length === 5, `boot cap honoured: 5 claimed (got ${r2.resumable.length})`);
    check(r2.recentOrphans.length === 2, `2 over-cap rows surfaced for re-send (got ${r2.recentOrphans.length})`);
    const claimedSet = new Set(r2.resumable.map((o) => o.id));
    const overCap = seven.filter((id) => !claimedSet.has(id));
    check(overCap.every((id) => getRow(id).status === 'dropped'), 'over-cap rows dropped (re-send)');
    // ── Phase 3: crash-loop terminates at MAX_RESUME_ATTEMPTS ───────────────────
    clearRows();
    const P = insert({ chatId: 30, sessionKey: '30', receivedAtMs: -60_000, rawContent: 'retry me' });
    const c1 = claimResumableOrphans(); // attempt 1
    check(c1.resumable.some((o) => o.id === P) && getRow(P).resume_attempts === 1, 'attempt 1 claims P → 1');
    const c2 = claimResumableOrphans(); // attempt 2 (still processing, recent, <MAX)
    check(c2.resumable.some((o) => o.id === P) && getRow(P).resume_attempts === 2, 'attempt 2 re-claims P → 2');
    const c3 = claimResumableOrphans(); // attempt 3 → exhausted, must NOT claim
    check(!c3.resumable.some((o) => o.id === P), 'attempt 3 does NOT claim P (== MAX)');
    check(getRow(P).status === 'dropped', 'exhausted P dropped after MAX');
    // ── Phase 4: markSideEffectStarted contract ─────────────────────────────────
    clearRows();
    const S = insert({ chatId: 40, sessionKey: '40', receivedAtMs: -60_000, rawContent: 'tool turn' });
    markSideEffectStarted(S, 'Bash');
    const firstStamp = getRow(S).side_effect_tool_started_at;
    check(!!firstStamp, 'side_effect_tool_started_at stamped on first mutating tool');
    check(getRow(S).tool_execution_names === 'Bash', 'tool name recorded');
    markSideEffectStarted(S, 'Write');
    check(getRow(S).side_effect_tool_started_at === firstStamp, 'timestamp stable (first tool wins)');
    check(getRow(S).tool_execution_names.split(',').sort().join(',') === 'Bash,Write', 'second tool appended');
    markSideEffectStarted(S, 'Bash'); // dedup
    check(getRow(S).tool_execution_names.split(',').filter((t) => t === 'Bash').length === 1, 'duplicate tool name deduped');
    // A side-effect row is now excluded from claim.
    const c4 = claimResumableOrphans();
    check(!c4.resumable.some((o) => o.id === S), 'side-effect row never claimed');
    // ── Phase 5: clampBootCap hard ceiling [1,5] (Codex P1-1) ───────────────────
    check(clampBootCap(undefined) === 5, 'unset → 5');
    check(clampBootCap('5') === 5, "'5' → 5");
    check(clampBootCap('50') === 5, "'50' clamped → 5");
    check(clampBootCap('-1') === 1, "'-1' clamped → 1");
    check(clampBootCap('0') === 5, "'0' → default 5");
    check(clampBootCap('3') === 3, "'3' → 3");
    check(clampBootCap('abc') === 5, "garbage → 5");
    check(clampBootCap('4.9') === 4, "'4.9' floored → 4");
    // clampInt with the MAX_RESUME_ATTEMPTS config (def=2, [1,5]) — Codex round-2 P2
    check(clampInt(undefined, 2, 1, 5) === 2, 'attempts unset → 2');
    check(clampInt('0', 2, 1, 5) === 2, "attempts '0' → default 2");
    check(clampInt('50', 2, 1, 5) === 5, "attempts '50' clamped → 5");
    check(clampInt('-1', 2, 1, 5) === 1, "attempts '-1' clamped → 1");
    check(clampInt('3', 2, 1, 5) === 3, "attempts '3' → 3");
    // ── Phase 6: hasNewerDuplicate dedup (Codex P1-2) ───────────────────────────
    clearRows();
    const O = insert({ chatId: 50, sessionKey: '50', receivedAtMs: -120_000, rawContent: 'same text' });
    // newer row, identical content, same session → duplicate
    const N = insert({ chatId: 50, sessionKey: '50', receivedAtMs: -30_000, rawContent: 'same text' });
    check(hasNewerDuplicate('50', 'same text', O, getRow(O).received_at), 'newer identical re-send detected');
    check(!hasNewerDuplicate('50', 'same text', N, getRow(N).received_at), 'newest row has no newer duplicate');
    check(!hasNewerDuplicate('50', 'different text', O, getRow(O).received_at), 'different content is NOT a duplicate');
    // different session with same text must not match
    insert({ chatId: 51, sessionKey: '51', receivedAtMs: -10_000, rawContent: 'same text' });
    check(!hasNewerDuplicate('50', 'same text', N, getRow(N).received_at), 'cross-session same text does not dedupe');
    // status filter (Codex round-2 P2): only a newer row that WILL be answered
    // (received/processing/done) suppresses O's replay; a dropped/error one must
    // NOT, or O's question would go permanently unanswered.
    const Ot = getRow(O).received_at;
    setRow(N, { status: 'dropped' });
    check(!hasNewerDuplicate('50', 'same text', O, Ot), 'newer DROPPED duplicate does NOT suppress');
    setRow(N, { status: 'error' });
    check(!hasNewerDuplicate('50', 'same text', O, Ot), 'newer ERROR duplicate does NOT suppress');
    setRow(N, { status: 'done' });
    check(hasNewerDuplicate('50', 'same text', O, Ot), 'newer DONE duplicate suppresses (already answered)');
    setRow(N, { status: 'processing' });
    check(hasNewerDuplicate('50', 'same text', O, Ot), 'newer PROCESSING duplicate suppresses (live turn owns it)');
    console.log(`✅ input-log auto-resume claim: ${pass}/${pass} cases PASS`);
    // Best-effort cleanup.
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    }
    catch {
        /* ignore */
    }
})().catch((err) => {
    console.error('❌ input-log.test.ts FAILED:', err);
    try {
        fs.rmSync(TMP, { recursive: true, force: true });
    }
    catch {
        /* ignore */
    }
    process.exit(1);
});
//# sourceMappingURL=input-log.test.js.map