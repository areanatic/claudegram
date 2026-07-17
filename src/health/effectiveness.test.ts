import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BotEffectivenessReporter } from './effectiveness.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-health-'));
const reporter = new BotEffectivenessReporter({ dataDir: dir, botName: 'NexusgramTest', botRole: 'master' });
reporter.markGetMeSuccess(new Date('2026-07-17T01:00:00.000Z'));
reporter.markSuccessfulTurn(new Date('2026-07-17T01:01:00.000Z'));
const health = JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8'));
assert.equal(health.bot_name, 'NexusgramTest');
assert.equal(health.telegram_get_me.last_success_at, '2026-07-17T01:00:00.000Z');
assert.equal(health.turns.last_success_at, '2026-07-17T01:01:00.000Z');
assert.equal(fs.existsSync(path.join(dir, `health.json.${process.pid}.tmp`)), false, 'atomic writer leaves no partial health file');
fs.rmSync(dir, { recursive: true, force: true });
console.log('✅ effectiveness health: turn delivery updates health.json');
