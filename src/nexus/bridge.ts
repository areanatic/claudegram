import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';

type NexusAgent = {
  description?: string;
  trigger_keywords?: string[];
  specializes_in?: string[];
};

type NexusRegistry = {
  agents?: Record<string, NexusAgent>;
};

function readJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readTextSafe(filePath: string, maxChars = 6000): string {
  try {
    const text = fs.readFileSync(filePath, 'utf8').trim();
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
  } catch {
    return '';
  }
}

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findAncestorWithMarkers(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const hasClaude = exists(path.join(current, 'CLAUDE.md'));
    const hasRegistry = exists(path.join(current, '00_NEXUS_CORE', 'agent_registry.json'));
    const hasContext = exists(path.join(current, '99_META', 'nexus_context_LIVE.json'));
    if (hasClaude && hasRegistry && hasContext) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function findDefaultNexusRoot(): string | null {
  const candidates = [
    process.env.NEXUS_ROOT,
    path.join(config.WORKSPACE_DIR, 'NEXUS'),
    '/Volumes/AstronOne/NEXUS_miniM_13-03-26',
    '/Volumes/Astron One/NEXUS_miniM_13-03-26',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (findAncestorWithMarkers(resolved) === resolved) {
      return resolved;
    }
  }
  return null;
}

export function detectNexusRoot(cwd: string): string | null {
  return findAncestorWithMarkers(cwd);
}

export function buildNexusBridgePrompt(cwd: string): string {
  const nexusRoot = detectNexusRoot(cwd);
  if (!nexusRoot) return '';

  const registry = readJsonSafe<NexusRegistry>(path.join(nexusRoot, '00_NEXUS_CORE', 'agent_registry.json'));
  const context = readJsonSafe<Record<string, unknown>>(path.join(nexusRoot, '99_META', 'nexus_context_LIVE.json'));
  const chatInstruction = readTextSafe(path.join(nexusRoot, '99_META', 'CLAUDE_CHAT_INSTRUCTION_v2.4.md'), 2200);
  const claudeMd = readTextSafe(path.join(nexusRoot, 'CLAUDE.md'), 2600);

  const agentSummaries = Object.entries(registry?.agents || {})
    .slice(0, 9)
    .map(([name, agent]) => {
      const triggers = (agent.trigger_keywords || []).slice(0, 4).join(', ');
      const specialties = (agent.specializes_in || []).slice(0, 2).join(', ');
      return `- ${name}: ${agent.description || 'No description'} | triggers: ${triggers || 'n/a'} | focus: ${specialties || 'n/a'}`;
    })
    .join('\n');

  const currentPhase = typeof context?.current_phase === 'string' ? context.current_phase : 'unknown';
  const sessionCount = typeof context?.session_count === 'number' ? context.session_count : 'unknown';

  return `

NEXUS Bridge Mode:
You are working inside a NEXUS repository. Treat the local NEXUS instruction files as project-specific operating context.

NEXUS root:
${nexusRoot}

Bridging goals:
- Respect NEXUS operating principles when working in this repo.
- Prefer simple direct actions first, agents/orchestration second.
- Use NEXUS agent names, routing concepts, and terminology when relevant.
- Treat CLAUDE.md and the chat instruction as the local project constitution.
- Do not claim production-readiness unless verified by actual files/tests.
- Keep a strict distinction between implemented systems vs plans/docs.

NEXUS current state:
- current_phase: ${String(currentPhase)}
- session_count: ${String(sessionCount)}

NEXUS agent registry summary:
${agentSummaries || '- No agent registry summary available'}

NEXUS chat instruction excerpt:
${chatInstruction || '[missing]'}

NEXUS CLAUDE.md excerpt:
${claudeMd || '[missing]'}
`;
}
