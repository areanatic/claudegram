import assert from 'node:assert/strict';
import { buildVoiceCapabilityPrompt } from './voice-capabilities.js';

const readOnlyVoice = buildVoiceCapabilityPrompt(['Read', 'Glob', 'Grep', 'Read']);

assert.match(readOnlyVoice, /Generic tools currently available: Glob, Grep, Read\./);
assert.match(readOnlyVoice, /MCP domain tools .* remain available in voice mode/);
assert.match(readOnlyVoice, /does NOT mean "no tools"/);
assert.match(readOnlyVoice, /cannot read\/search files/);
assert.doesNotMatch(readOnlyVoice, /currently available: .*Bash/);

const mcpOnlyVoice = buildVoiceCapabilityPrompt([]);
assert.match(mcpOnlyVoice, /Generic tools currently available: none\./);
assert.match(mcpOnlyVoice, /Connected MCP domain tools/);
