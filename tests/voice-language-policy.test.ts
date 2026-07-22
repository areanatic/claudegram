import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVoiceAllowedLanguages } from '../src/audio/voice-language-policy.js';

test('R7 Master accepts every detected language when allowlist is unset', () => {
  assert.deepEqual(resolveVoiceAllowedLanguages(undefined, 'master', 'NexusgramTest'), []);
  assert.deepEqual(resolveVoiceAllowedLanguages(undefined, undefined, 'Nexusgram'), []);
});

test('person bots retain de,en by default and explicit Master policy wins', () => {
  assert.deepEqual(resolveVoiceAllowedLanguages(undefined, 'person', 'Alina'), ['de', 'en']);
  assert.deepEqual(resolveVoiceAllowedLanguages('de, ru, fa', 'master', 'Nexusgram'), ['de', 'ru', 'fa']);
  assert.deepEqual(resolveVoiceAllowedLanguages('', 'person', 'Alina'), []);
});
