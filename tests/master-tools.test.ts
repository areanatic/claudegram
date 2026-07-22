import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MASTER_DEFAULT_BOT_TOOLS,
  STANDARD_DEFAULT_BOT_TOOLS,
  resolveBotTools,
} from '../src/claude/master-tools.js';

test('R7: BOT_ROLE=master gets the SDK tools NexusGram can render when BOT_TOOLS is unset', () => {
  const tools = resolveBotTools({
    configuredTools: STANDARD_DEFAULT_BOT_TOOLS,
    explicitlyConfigured: false,
    botRole: 'master',
    botName: 'R7Test',
  });
  assert.deepEqual(tools, [...MASTER_DEFAULT_BOT_TOOLS]);
  for (const expected of ['WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite', 'Skill']) {
    assert.ok(tools.includes(expected), `${expected} is part of the Master default`);
  }
});

test('R7 tool expansion never changes person defaults or an explicit operator override', () => {
  assert.deepEqual(resolveBotTools({
    configuredTools: STANDARD_DEFAULT_BOT_TOOLS,
    explicitlyConfigured: false,
    botRole: 'person',
    botName: 'PersonBot',
  }), [...STANDARD_DEFAULT_BOT_TOOLS]);
  assert.deepEqual(resolveBotTools({
    configuredTools: ['Read'],
    explicitlyConfigured: true,
    botRole: 'master',
    botName: 'MasterBot',
  }), ['Read']);
});
