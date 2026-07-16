import { spawn } from 'node:child_process';
import { config } from '../config.js';

export const ENGINE_NAMES = ['anthropic', 'ollama', 'codex'] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export const OLLAMA_MODELS = [
  'qwen3-coder:30b-a3b-q4_K_M',
  'gpt-oss:20b',
  'qwen3:14b',
  'gemma3:12b',
  'llama3.1:8b',
] as const;

export const ENGINE_DEFAULT_MODELS: Record<EngineName, string> = {
  anthropic: 'sonnet',
  ollama: 'qwen3-coder:30b-a3b-q4_K_M',
  codex: 'gpt-5.6-terra',
};

export interface EngineSelection {
  engine: EngineName;
  model: string;
}

export interface EngineAvailability {
  engine: EngineName;
  available: boolean;
  detail: string;
}

export interface EngineRequest {
  sessionKey: string;
  prompt: string;
  workingDirectory: string;
  abortSignal?: AbortSignal;
  onProgress?: (text: string) => void;
}

export interface EngineResponse {
  text: string;
  toolsUsed: string[];
  durationMs: number;
}

export class EngineUnavailableError extends Error {
  readonly name = 'EngineUnavailableError';
}

const sessionEngines = new Map<string, EngineSelection>();
const engineHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();

export function isEngineName(value: string): value is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(value);
}

/** Model values are arguments to child processes, never a free-form CLI fragment. */
export function isSafeEngineModel(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function defaultModelFor(engine: EngineName): string {
  if (engine === config.BOT_ENGINE && config.BOT_ENGINE_MODEL.trim()) {
    return config.BOT_ENGINE_MODEL.trim();
  }
  if (engine === 'anthropic') return config.CLAUDE_DEFAULT_MODEL;
  return ENGINE_DEFAULT_MODELS[engine];
}

export function configuredEngine(): EngineSelection {
  return { engine: config.BOT_ENGINE, model: defaultModelFor(config.BOT_ENGINE) };
}

export function getEngineSelection(sessionKey: string): EngineSelection {
  return sessionEngines.get(sessionKey) ?? configuredEngine();
}

export function setEngineSelection(sessionKey: string, engine: EngineName, model?: string): EngineSelection {
  const selectedModel = model?.trim() || defaultModelFor(engine);
  if (!isSafeEngineModel(selectedModel)) throw new Error('Invalid engine model identifier');
  const selection = { engine, model: selectedModel };
  sessionEngines.set(sessionKey, selection);
  return selection;
}

export function clearEngineSelection(sessionKey: string): void {
  sessionEngines.delete(sessionKey);
  engineHistory.delete(sessionKey);
}

/** Hard code gate: only the Master bot and an allowlisted Telegram user may use these paths. */
export function isMasterEngineLane(botName: string, allowedUserIds: readonly number[], userId: number | undefined): boolean {
  return botName === 'Nexusgram' && userId !== undefined && allowedUserIds.includes(userId);
}

/** Used by the text fallback so an unregistered person-bot command is silently ignored. */
export function isRestrictedEngineCommand(text: string): boolean {
  return /^\/(?:engine|codex)(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

export function buildCodexExecArgs(model: string, prompt: string): string[] {
  // Keep this list fixed and shell-free. In particular, never add a
  // --dangerously-* flag here or accept arbitrary user supplied CLI flags.
  if (!isSafeEngineModel(model)) throw new Error('Invalid Codex model identifier');
  // `--` prevents a prompt beginning with `--` from ever being parsed as a CLI flag.
  return ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--model', model, '--', prompt];
}

export async function checkEngineAvailability(engine: EngineName): Promise<EngineAvailability> {
  if (engine === 'anthropic') {
    return { engine, available: true, detail: 'configured (Claude Agent SDK)' };
  }
  if (engine === 'ollama') {
    const result = await checkOllamaReachability(config.OLLAMA_BASE_URL);
    return { engine, ...result };
  }

  try {
    await runChild(config.CODEX_EXECUTABLE_PATH, ['--version'], process.cwd(), 5_000);
    return { engine, available: true, detail: 'CLI available' };
  } catch (error) {
    return { engine, available: false, detail: error instanceof Error ? error.message : 'CLI unavailable' };
  }
}

export async function checkOllamaReachability(baseUrl: string): Promise<Omit<EngineAvailability, 'engine'>> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return { available: false, detail: `HTTP ${response.status}` };
    return { available: true, detail: 'reachable' };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : 'not reachable' };
  }
}

export async function assertEngineAvailable(engine: EngineName): Promise<void> {
  const status = await checkEngineAvailability(engine);
  if (!status.available) throw new EngineUnavailableError(`${engine} is unavailable: ${status.detail}`);
}

export async function runAlternativeEngine(
  selection: EngineSelection,
  request: EngineRequest,
): Promise<EngineResponse> {
  if (selection.engine === 'ollama') return runOllama(selection, request);
  if (selection.engine === 'codex') return runCodex(selection.model, request.prompt, request.workingDirectory, request.abortSignal);
  throw new Error('Anthropic is handled by the Claude Agent SDK path');
}

async function runOllama(selection: EngineSelection, request: EngineRequest): Promise<EngineResponse> {
  await assertEngineAvailable('ollama');
  const started = Date.now();
  const history = engineHistory.get(request.sessionKey) ?? [];
  const messages = [...history, { role: 'user' as const, content: request.prompt }].slice(-20);
  let response: Response;
  try {
    response = await fetch(`${config.OLLAMA_BASE_URL.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: selection.model, messages, stream: false }),
      signal: request.abortSignal ?? AbortSignal.timeout(300_000),
    });
  } catch (error) {
    throw new EngineUnavailableError(`ollama request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (!response.ok) throw new Error(`ollama returned HTTP ${response.status}`);
  const payload = await response.json() as { message?: { content?: string } };
  const text = payload.message?.content?.trim();
  if (!text) throw new Error('ollama returned no response text');
  const updated = [...messages, { role: 'assistant' as const, content: text }].slice(-20);
  engineHistory.set(request.sessionKey, updated);
  request.onProgress?.(text);
  return { text, toolsUsed: [], durationMs: Date.now() - started };
}

export async function runCodex(
  model: string,
  prompt: string,
  workingDirectory: string,
  abortSignal?: AbortSignal,
): Promise<EngineResponse> {
  const started = Date.now();
  const raw = await runChild(
    config.CODEX_EXECUTABLE_PATH,
    buildCodexExecArgs(model, prompt),
    workingDirectory,
    300_000,
    abortSignal,
  );
  const text = parseCodexJsonOutput(raw);
  if (!text) throw new Error('codex returned no assistant response');
  return { text, toolsUsed: [], durationMs: Date.now() - started };
}

export function parseCodexJsonOutput(raw: string): string {
  const messages: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string; content?: string } };
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        const text = event.item.text ?? event.item.content;
        if (text) messages.push(text);
      }
    } catch {
      // Codex --json should be JSONL. Ignore incidental non-JSON diagnostics.
    }
  }
  return messages.join('\n\n').trim();
}

function runChild(command: string, args: string[], cwd: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      abortSignal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(stdout);
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      finish(new Error('engine request cancelled'));
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`engine timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => finish(new Error(`${command} unavailable: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`${command} exited with code ${code}: ${stderr.trim() || 'no diagnostic'}`));
    });
  });
}
