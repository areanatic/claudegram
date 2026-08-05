import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERSON_RESOURCE_UNAVAILABLE,
  PERSON_SYSTEM_PROMPT,
  PERSON_TECHNICAL_FAILURE,
  personResourceUnavailable,
  userFacingFailure,
} from '../src/bot/person-policy.js';
import { isRestrictedEngineCommand } from '../src/engines/engine.js';

test('R31: real foreign and invented resources are byte-identical and reveal no identifier', () => {
  const foreign = personResourceUnavailable('zamaniaria@example.invalid');
  const invented = personResourceUnavailable('fantasy-account-r31');
  assert.equal(foreign, invented);
  assert.equal(foreign, PERSON_RESOURCE_UNAVAILABLE);
  assert.doesNotMatch(foreign, /zamaniaria|example|fantasy|konto|account/i);
});

test('R31: person-facing failures never contain technical diagnostics', () => {
  const diagnostic = 'ENOENT /Users/operator/.nexus token=secret HTTP 500 MCP traceback stderr';
  const visible = userFacingFailure(diagnostic, false);
  assert.equal(visible, PERSON_TECHNICAL_FAILURE);
  assert.doesNotMatch(visible, /ENOENT|Users|token|HTTP|MCP|traceback|stderr/i);
  assert.equal(userFacingFailure(diagnostic, true), diagnostic);
});

test('R31: prompt repeats the same hard egress contract', () => {
  assert.match(PERSON_SYSTEM_PROMPT, new RegExp(PERSON_RESOURCE_UNAVAILABLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(PERSON_SYSTEM_PROMPT, new RegExp(PERSON_TECHNICAL_FAILURE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(PERSON_SYSTEM_PROMPT, /bestaetige nicht, ob sie existiert/i);
});

test('R31: /engine and /codex are classified before person text reaches the model', () => {
  assert.equal(isRestrictedEngineCommand('/engine'), true);
  assert.equal(isRestrictedEngineCommand('/engine@FamilyTest ollama'), true);
  assert.equal(isRestrictedEngineCommand('/codex inspect'), true);
  assert.equal(isRestrictedEngineCommand('/unknown'), false);
});
