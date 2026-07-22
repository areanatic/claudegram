import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-voice-recall-health-'));
process.env.NEXUSGRAM_ENV_PATH = path.join(tmp, 'missing.env');
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.ALLOWED_USER_IDS = '1';
process.env.BOT_NAME = 'VoiceRecallHealthTest';
process.env.BOT_ROLE = 'person';
process.env.DATA_DIR = tmp;
process.env.NEXUS_MEMORY_DB_PATH = path.join(tmp, 'memory.db');

const captures = await import('../src/inbox/captures-db.js');

test('migration failure is retained as an explicit /health error state', () => {
  const migration = captures.ensureVoiceRecallSchema();
  assert.equal(migration.status, 'error');
  assert.match(migration.error ?? '', /memories schema missing required column/);
  assert.deepEqual(captures.getVoiceRecallSchemaHealth(), migration);

  const healthSource = fs.readFileSync(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/bot/handlers/command.handler.ts'),
    'utf8',
  );
  assert.match(healthSource, /\*Voice recall:\*/);
  assert.match(healthSource, /SCHEMA=.*TOUPPERCASE|SCHEMA=.*toUpperCase/i);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
