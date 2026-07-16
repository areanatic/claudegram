import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-nofinalize-test-'));
process.env.NEXUSGRAM_ENV_PATH = path.join(TMP, 'nonexistent.env');
process.env.CLAUDEGRAM_ENV_PATH = process.env.NEXUSGRAM_ENV_PATH;
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'TestBot';
process.env.NEXUS_MEMORY_SCOPE = 'public';
process.env.DATA_DIR = TMP;
const DB_PATH = path.join(TMP, 'input-log.db');
let pass = 0, fail = 0;
function check(cond, msg) {
    if (cond) {
        pass++;
        console.log(`  ✅ ${msg}`);
    }
    else {
        fail++;
        console.error(`  ❌ ${msg}`);
    }
}
const m = await import('./input-log.js');
m.ensureInputLogInitialized();
const db = new Database(DB_PATH);
const rowOf = (id) => db.prepare('SELECT status, dropped_reason, response_sent_at FROM input_log WHERE id = ?').get(id);
function newRow(msgId) {
    return m.recordInput({ messageId: msgId, chatId: 1, sessionKey: '1', inputType: 'photo', rawContent: 'test', fileId: 'f', privacy: 'public' });
}
console.log('\n=== RI-23: markDone/markProcessing clear stale handler_no_finalize ===');
// (1) unmarked row → finalizeIfOpen tags handler_no_finalize (the artefact)
const r1 = newRow(101);
m.finalizeIfOpen(r1);
check(rowOf(r1).dropped_reason === 'handler_no_finalize', '(1) finalizeIfOpen tags unmarked row handler_no_finalize (the artefact)');
// (2) later markDone CLEARS the stale tag (the fix)
m.markDone(r1);
const a = rowOf(r1);
check(a.status === 'done', '(2a) markDone → status=done');
check(a.dropped_reason === null, '(2b) markDone CLEARS stale dropped_reason (was handler_no_finalize)');
check(a.response_sent_at !== null, '(2c) markDone stamps response_sent_at');
// (3) markProcessing also clears a stale reason (slow handler that started after finalizeIfOpen raced)
const r2 = newRow(102);
m.finalizeIfOpen(r2);
check(rowOf(r2).dropped_reason === 'handler_no_finalize', '(3a) r2 pre-tagged by finalizeIfOpen');
m.markProcessing(r2);
check(rowOf(r2).dropped_reason === null, '(3b) markProcessing clears the stale tag');
check(rowOf(r2).status === 'processing', '(3c) markProcessing → status=processing');
// (4) a genuinely dropped/errored row keeps its REAL reason (no over-clearing)
const r3 = newRow(103);
m.markError(r3, 'real failure');
check(rowOf(r3).dropped_reason === 'real failure', '(4a) markError keeps real reason');
const r4 = newRow(104);
m.markDropped(r4, 'superseded');
check(rowOf(r4).dropped_reason === 'superseded', '(4b) markDropped keeps real reason');
const r5 = newRow(105);
m.markHandledNoAgent(r5, 'transcribe_only');
check(rowOf(r5).dropped_reason === 'transcribe_only' && rowOf(r5).status === 'done', '(4c) markHandledNoAgent: done + honest reason (NOT handler_no_finalize)');
// (5) null rowId is a safe no-op (handlers may pass null)
let threw = false;
try {
    m.markDone(null);
    m.markProcessing(null);
    m.markError(null, 'x');
}
catch {
    threw = true;
}
check(!threw, '(5) null rowId is a safe no-op');
console.log(`\n${fail === 0 ? '✅' : '❌'} no-finalize-clear: ${pass} passed, ${fail} failed`);
db.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
//# sourceMappingURL=no-finalize-clear.test.js.map