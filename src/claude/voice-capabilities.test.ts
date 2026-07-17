import assert from 'node:assert/strict';
import { buildVoiceCapabilityPrompt, effectiveToolsForVoice, toolBudgetForVoice } from './voice-capabilities.js';

const readOnlyVoice = buildVoiceCapabilityPrompt(['Read', 'Glob', 'Grep', 'Read']);

assert.match(readOnlyVoice, /Generic tools currently available: Glob, Grep, Read\./);
assert.match(readOnlyVoice, /MCP domain tools .* remain available in voice mode/);
assert.match(readOnlyVoice, /does NOT mean "no tools"/);
assert.match(readOnlyVoice, /cannot read\/search files/);
assert.doesNotMatch(readOnlyVoice, /currently available: .*Bash/);

const mcpOnlyVoice = buildVoiceCapabilityPrompt([]);
assert.match(mcpOnlyVoice, /Generic tools currently available: none\./);
assert.match(mcpOnlyVoice, /Connected MCP domain tools/);

const configured = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];
assert.deepEqual(
  effectiveToolsForVoice(configured, [], true),
  configured,
  'BOT_ROLE=master voice keeps full CLI-equivalent configured tools',
);
assert.deepEqual(
  effectiveToolsForVoice(configured, [], false),
  ['Read', 'Glob', 'Grep'],
  'person-bot voice policy remains narrowed',
);
assert.deepEqual(
  effectiveToolsForVoice(configured, ['Read'], true),
  ['Bash', 'Write', 'Edit', 'Glob', 'Grep', 'Task'],
  'explicit deny still wins for the Master',
);
assert.equal(toolBudgetForVoice(true, 10, 15), 15, 'Master voice uses text tool budget');
assert.equal(toolBudgetForVoice(false, 10, 15), 10, 'person voice keeps voice tool budget');
