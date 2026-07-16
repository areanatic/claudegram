/** Run: npx tsx src/engines/engine.test.ts */
import assert from 'node:assert/strict';
import {
  buildCodexExecArgs,
  checkOllamaReachability,
  clearEngineSelection,
  getEngineSelection,
  isMasterEngineLane,
  isRestrictedEngineCommand,
  isSafeEngineModel,
  parseCodexJsonOutput,
  setEngineSelection,
} from './engine.js';

let pass = 0;
const ok = (condition: boolean, message: string) => { assert.equal(condition, true, message); pass++; };

// Per-conversation selection overrides the configured per-bot default.
setEngineSelection('chat:1', 'ollama', 'qwen3:14b');
ok(getEngineSelection('chat:1').engine === 'ollama', 'engine selection is stored per conversation');
ok(getEngineSelection('chat:1').model === 'qwen3:14b', 'explicit engine model is retained');
clearEngineSelection('chat:1');

// Unreachable engines must report a failure; callers never silently fall back.
const unavailable = await checkOllamaReachability('http://127.0.0.1:1');
ok(!unavailable.available, 'unreachable Ollama is reported as unavailable');
setEngineSelection('chat:unavailable', 'anthropic', 'sonnet');
// Same order as /engine: the availability gate runs before any mutation.
ok(getEngineSelection('chat:unavailable').engine === 'anthropic', 'failed availability gate leaves the prior engine active');
clearEngineSelection('chat:unavailable');

// Code gate: only Master + an ALLOWED_USER_IDS member has the commands.
ok(isMasterEngineLane('Nexusgram', [42], 42), 'master allowlisted user passes engine ACL');
ok(!isMasterEngineLane('Alinas Assistentin', [42], 42), 'person bot never passes engine ACL');
ok(!isMasterEngineLane('Nexusgram', [42], 7), 'non-allowlisted user never passes engine ACL');
ok(isRestrictedEngineCommand('/codex inspect this'), 'codex command is recognised for silent person-bot suppression');
ok(isRestrictedEngineCommand('/engine@Nexusgram ollama'), 'mention-style engine command is recognised');

// Security invariant: model is an identifier and user input is one positional prompt.
const args = buildCodexExecArgs('gpt-5.6-terra', 'inspect the repository');
ok(args.join(' ') === 'exec --json --sandbox read-only --skip-git-repo-check --model gpt-5.6-terra -- inspect the repository', 'Codex uses only the fixed read-only arguments');
ok(!args.some((arg) => arg.startsWith('--dangerously-')), 'Codex arguments never include dangerously flags');
ok(!isSafeEngineModel('--dangerously-bypass-approvals-and-sandbox'), 'model values cannot smuggle a CLI flag');

const parsed = parseCodexJsonOutput('{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}\n');
ok(parsed === 'Done', 'Codex JSONL assistant message is extracted');

console.log(`✅ engines: ${pass} cases PASS`);
