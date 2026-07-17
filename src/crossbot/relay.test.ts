/** Run: npx tsx src/crossbot/relay.test.ts */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  enqueueRelay,
  isRestrictedCrossBotCommand,
  markRelayDelivered,
  parseMasterRelay,
  pendingRelays,
  readBotFamilyHealth,
  resolveCurrentBotId,
  type BotFamilyMember,
} from './relay.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-crossbot-'));
const relayDir = path.join(root, 'relay');
const alinaDataDir = path.join(root, 'alina-data');
const momDataDir = path.join(root, 'mom-data');

const alinaRelay = enqueueRelay({
  relayDir, target: 'alina', kind: 'ask', payload: 'Kannst du morgen kurz antworten?', sourceUserId: 42,
  now: new Date('2026-07-17T10:00:00.000Z'),
});
enqueueRelay({
  relayDir, target: 'mom', kind: 'note', payload: 'Bitte Bescheid geben.', sourceUserId: 42,
  now: new Date('2026-07-17T10:01:00.000Z'),
});

assert.deepEqual(
  pendingRelays({ relayDir, recipient: 'alina', recipientDataDir: alinaDataDir }).map((relay) => relay.id),
  [alinaRelay.id],
  'Alina reads only the inbox addressed to Alina, never Mom’s handoff',
);
markRelayDelivered(alinaDataDir, alinaRelay.id);
assert.equal(pendingRelays({ relayDir, recipient: 'alina', recipientDataDir: alinaDataDir }).length, 0, 'recipient receipt prevents duplicate delivery');
assert.equal(pendingRelays({ relayDir, recipient: 'mom', recipientDataDir: momDataDir }).length, 1, 'another recipient retains its own pending handoff');

assert.deepEqual(parseMasterRelay('Sag Mom-Bot, dass der Termin um 9 Uhr ist.'), {
  target: 'mom', kind: 'note', payload: 'der Termin um 9 Uhr ist.',
});
assert.equal(parseMasterRelay('Sage allen Bots alles.'), null, 'free-form targets cannot create a relay');
assert.equal(isRestrictedCrossBotCommand('/bots@AstronOneBot'), true, 'manually typed /bots is caught outside the command menu');
assert.equal(resolveCurrentBotId({ isMaster: false, botName: 'Alinas Assistentin' }), 'alina', 'legacy person identity resolves only to its own inbox');
assert.equal(resolveCurrentBotId({ isMaster: false, botName: 'unconfigured person bot' }), null, 'unknown person identity fails closed');

const healthRoot = path.join(root, 'health');
const onlineDir = path.join(healthRoot, 'online');
const staleDir = path.join(healthRoot, 'stale');
fs.mkdirSync(onlineDir, { recursive: true });
fs.mkdirSync(staleDir, { recursive: true });
fs.writeFileSync(path.join(onlineDir, 'health.json'), JSON.stringify({
  schema_version: 1, updated_at: '2026-07-17T10:00:00.000Z',
  turns: { last_success_at: '2026-07-17T09:59:00.000Z' }, telegram_get_me: { last_success_at: null },
}));
fs.writeFileSync(path.join(staleDir, 'health.json'), JSON.stringify({
  schema_version: 1, updated_at: '2026-07-17T09:40:00.000Z',
  turns: { last_success_at: null }, telegram_get_me: { last_success_at: '2026-07-17T09:40:00.000Z' },
}));
const members: BotFamilyMember[] = [
  { id: 'master', label: 'Master', handle: '@master', dataDir: onlineDir },
  { id: 'alina', label: 'Alina', handle: '@alina', dataDir: staleDir },
  { id: 'mom', label: 'Mom', handle: '@mom', dataDir: path.join(healthRoot, 'missing') },
];
assert.deepEqual(
  readBotFamilyHealth(members, new Date('2026-07-17T10:02:00.000Z')).map((entry) => entry.status),
  ['online', 'stale', 'offline'],
  'family health aggregates fresh, stale and missing health.json files',
);

fs.rmSync(root, { recursive: true, force: true });
console.log('✅ crossbot relay: isolation, receipt, parsing and health aggregation PASS');
