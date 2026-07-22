import assert from 'node:assert/strict';
import test from 'node:test';
import { codexFailureMessage, engineUnavailableMessage } from '../src/engines/recovery.js';

test('engine failures keep the active engine and always offer an executable next step', () => {
  const message = engineUnavailableMessage('codex', 'anthropic');

  assert.match(message, /Aktiv bleibt anthropic/);
  assert.match(message, /Nächster Schritt:.*\/engine/);
});

test('Codex failure copy does not expose raw process details', () => {
  const message = codexFailureMessage();

  assert.doesNotMatch(message, /stderr|ENOENT|token=/i);
  assert.match(message, /Nächster Schritt:/);
});
