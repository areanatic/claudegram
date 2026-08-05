/**
 * R17 / Roadmap Sprint 4 — deterministic recall contract.
 *
 * Explicit recall questions do not let the model choose a convenient store.
 * This service executes the fixed ladder itself and returns already-cited
 * evidence (or an honest, deterministic miss) before any model is called.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readMemoryPolicyFromEnv,
  searchMemoryReadOnly,
  type MemoryRetrievalPolicy,
} from './nexus-memory.js';

export type RecallSource = 'memory' | 'daily' | 'shared-index' | 'session-archive';

export interface RecallScope {
  kind: 'operator' | 'person';
  /** Mandatory for person scope. No value means fail closed for Memory-FTS. */
  project?: string;
  /** Mandatory for person scope. Matches memories.bot. */
  botId?: string;
  /** Current Telegram session only; prevents cross-chat transcript reads. */
  sessionKey: string;
  /** False in /private: old public transcript context must not bleed in. */
  allowSessionArchive: boolean;
  /** Operator files are disabled in /private and for every person bot. */
  allowOperatorFiles: boolean;
}

export interface RecallPaths {
  dailyDir: string;
  sharedIndexPath: string;
  transcriptDir: string;
}

export interface RecallEvidence {
  source: RecallSource;
  content: string;
  citation: string;
  date?: string;
  location: string;
}

export interface RecallContractResult {
  topic: string;
  found: boolean;
  evidence: RecallEvidence[];
  searched: RecallSource[];
  /** Only explicit "general/model knowledge" wording permits this. */
  allowModelKnowledge: boolean;
  answer: string;
}

export interface RecallOptions {
  scope: RecallScope;
  paths?: Partial<RecallPaths>;
  policy?: MemoryRetrievalPolicy;
  limit?: number;
  /** Rows written by this same turn are not historical recall evidence yet. */
  excludeMemoryIds?: readonly number[];
}

const DEFAULT_DAILY_DIR =
  '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/daily';
const DEFAULT_SHARED_INDEX = '/Volumes/AstronOne/shared-memory/nexus/MEMORY.md';

const RECALL_PATTERNS = [
  /^was\s+(?:wei(?:ss|\u00dft)|weisst)\s+du\s+(?:noch\s+)?(?:(?:allgemein|aus\s+modellwissen)\s+)?(?:\u00fcber|ueber)\s+(.+?)\??$/iu,
  /^was\s+wei(?:\u00df|ss)t\s+du\s+noch\s+(?:von|zu)\s+(.+?)\??$/iu,
  /^erinnerst\s+du\s+dich\s+(?:an|noch\s+an)\s+(.+?)\??$/iu,
  /^what\s+do\s+you\s+know\s+(?:(?:in\s+general|from\s+model\s+knowledge)\s+)?about\s+(.+?)\??$/iu,
  /^do\s+you\s+remember\s+(.+?)\??$/iu,
];

const STOP_WORDS = new Set([
  'aber', 'alle', 'also', 'about', 'dass', 'deine', 'einer', 'eines', 'etwas',
  'from', 'habe', 'haben', 'noch', 'oder', 'the', 'this', 'ueber', 'uber', 'und',
  'unsere', 'unser', 'was', 'wei\u00dft', 'weisst', 'with', 'you', 'your', '\u00fcber',
]);

function defaultPaths(): RecallPaths {
  const dataDir = process.env.DATA_DIR?.trim();
  return {
    dailyDir: process.env.NEXUS_DAILY_DIR?.trim() || DEFAULT_DAILY_DIR,
    sharedIndexPath:
      process.env.NEXUS_SHARED_MEMORY_INDEX_PATH?.trim() || DEFAULT_SHARED_INDEX,
    transcriptDir:
      process.env.NEXUS_SESSION_ARCHIVE_DIR?.trim() ||
      path.join(dataDir || path.join(process.env.HOME || '.', '.nexusgram'), 'transcripts'),
  };
}

function safePaths(overrides: Partial<RecallPaths> = {}): RecallPaths {
  return { ...defaultPaths(), ...overrides };
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('de-DE');
}

function queryTokens(topic: string): string[] {
  return Array.from(new Set(
    normalize(topic)
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  ));
}

function scoreText(content: string, topic: string): number {
  const haystack = normalize(content);
  const phrase = normalize(topic).trim();
  if (phrase && haystack.includes(phrase)) return 100;
  const tokens = queryTokens(topic);
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  // Do not turn a single generic token from a multi-word query into a false
  // "found". Two-token topics require both; longer topics require a stable
  // majority while still tolerating inflection/noise.
  const required = tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.6);
  return matched >= required ? matched * 10 : 0;
}

function shortDate(value?: string): string | undefined {
  const match = value?.match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}.${match[2]}.` : undefined;
}

function clip(value: string, max = 600): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}\u2026` : clean;
}

function safeRead(filePath: string): string | null {
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function rankedChunks(content: string, topic: string, limit: number): string[] {
  return content
    .split(/\n(?=#{1,4}\s)|\n{2,}/)
    .map((chunk, index) => ({ chunk: chunk.trim(), index, score: scoreText(chunk, topic) }))
    .filter((item) => item.chunk && item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => clip(item.chunk));
}

function searchDaily(
  dailyDir: string,
  topic: string,
  limit: number,
): RecallEvidence[] {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(dailyDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const ranked: Array<{ evidence: RecallEvidence; score: number; order: number }> = [];
  filenames.forEach((filename, order) => {
    const filePath = path.join(dailyDir, filename);
    const content = safeRead(filePath);
    if (!content) return;
    for (const chunk of rankedChunks(content, topic, limit)) {
      const date = filename.slice(0, 10);
      ranked.push({
        score: scoreText(chunk, topic),
        order,
        evidence: {
          source: 'daily',
          content: chunk,
          citation: `aus Daily ${shortDate(date)}`,
          date,
          location: filePath,
        },
      });
    }
  });
  return ranked
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((item) => item.evidence);
}

function searchSharedIndex(
  indexPath: string,
  topic: string,
  limit: number,
): RecallEvidence[] {
  const content = safeRead(indexPath);
  if (!content) return [];
  return rankedChunks(content, topic, limit).map((chunk) => {
    const date = chunk.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
    return {
      source: 'shared-index' as const,
      content: chunk,
      citation: date
        ? `aus Shared-Memory-Index ${shortDate(date)}`
        : 'aus Shared-Memory-Index',
      date,
      location: indexPath,
    };
  });
}

function searchSessionArchive(
  transcriptDir: string,
  sessionKey: string,
  topic: string,
  limit: number,
): RecallEvidence[] {
  if (!sessionKey || sessionKey.includes('/') || sessionKey.includes('\\')) return [];
  let dates: string[];
  try {
    dates = fs.readdirSync(transcriptDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const hits: RecallEvidence[] = [];
  for (const date of dates) {
    const filePath = path.resolve(transcriptDir, date, `${sessionKey}.md`);
    const allowedRoot = `${path.resolve(transcriptDir)}${path.sep}`;
    if (!filePath.startsWith(allowedRoot)) continue;
    const content = safeRead(filePath);
    if (!content) continue;
    for (const chunk of rankedChunks(content, topic, limit)) {
      hits.push({
        source: 'session-archive',
        content: chunk,
        citation: `aus Session ${shortDate(date)}`,
        date,
        location: filePath,
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

export function parseRecallRequest(message: string): {
  topic: string;
  allowModelKnowledge: boolean;
} | null {
  const trimmed = message.trim();
  for (const pattern of RECALL_PATTERNS) {
    const match = trimmed.match(pattern);
    const topic = match?.[1]?.replace(/[?.!]+$/g, '').trim();
    if (!topic) continue;
    const allowModelKnowledge =
      /\b(allgemein|general|modellwissen|model knowledge)\b/iu.test(trimmed);
    return { topic, allowModelKnowledge };
  }
  return null;
}

function formatAnswer(
  topic: string,
  evidence: RecallEvidence[],
  searched: RecallSource[],
): string {
  if (evidence.length === 0) {
    return `Ich habe zu \u201e${topic}\u201c nichts in meinen Quellen gefunden. ` +
      `Durchsucht: ${searched.join(' \u2192 ')}. Ich erfinde dazu nichts.`;
  }
  const facts = evidence.map((hit) => `- ${hit.content} (${hit.citation})`);
  return [`Zu \u201e${topic}\u201c habe ich Folgendes gefunden:`, '', ...facts].join('\n');
}

export function runRecallContract(
  topic: string,
  options: RecallOptions,
  allowModelKnowledge = false,
): RecallContractResult {
  const limit = Math.max(1, Math.min(5, Math.floor(options.limit ?? 3)));
  const paths = safePaths(options.paths);
  const searched: RecallSource[] = [];
  const policy = options.policy ?? readMemoryPolicyFromEnv();

  // Step 1: Memory DB / FTS5. Person bots must have BOTH project and bot
  // attribution; missing attribution fails closed instead of searching broad.
  searched.push('memory');
  let evidence: RecallEvidence[] = [];
  if (options.scope.kind === 'operator' || (options.scope.project && options.scope.botId)) {
    const hits = searchMemoryReadOnly(
      topic,
      limit,
      options.scope.kind === 'person' ? options.scope.project : undefined,
      {
        policy,
        originBot: options.scope.kind === 'person' ? options.scope.botId : undefined,
        excludeMemoryIds: options.excludeMemoryIds,
      },
    );
    evidence = hits
      .filter((hit) => scoreText(
        `${hit.content}\n${hit.tags ?? ''}\n${hit.project ?? ''}`,
        topic,
      ) > 0)
      .map((hit) => {
        const date = hit.created_at?.slice(0, 10);
        return {
          source: 'memory' as const,
          content: clip(hit.content),
          citation: date ? `aus Memory ${shortDate(date)}` : 'aus Memory',
          date,
          location: `memory.db:${hit.project ?? 'global'}`,
        };
      });
  }

  // The ladder stops on a positive stage. A negative answer is legal only
  // after every source available to this caller has been traversed.
  if (evidence.length === 0 && options.scope.allowOperatorFiles) {
    searched.push('daily');
    evidence = searchDaily(paths.dailyDir, topic, limit);
  }
  if (evidence.length === 0 && options.scope.allowOperatorFiles) {
    searched.push('shared-index');
    evidence = searchSharedIndex(paths.sharedIndexPath, topic, limit);
  }
  if (evidence.length === 0 && options.scope.allowSessionArchive) {
    searched.push('session-archive');
    evidence = searchSessionArchive(
      paths.transcriptDir,
      options.scope.sessionKey,
      topic,
      limit,
    );
  }

  return {
    topic,
    found: evidence.length > 0,
    evidence,
    searched,
    allowModelKnowledge,
    answer: formatAnswer(topic, evidence, searched),
  };
}

export function runRecallContractForMessage(
  message: string,
  options: RecallOptions,
): RecallContractResult | null {
  const request = parseRecallRequest(message);
  if (!request) return null;
  return runRecallContract(request.topic, options, request.allowModelKnowledge);
}

/** Explicit general-knowledge requests may continue to a model, but the model
 *  receives a hard provenance contract. Default personal/project recall never
 *  takes this path: a local miss returns the deterministic honest answer. */
export function renderModelFallbackPrompt(result: RecallContractResult): string {
  return [
    '<recall-contract>',
    result.answer,
    'The local recall ladder is authoritative. Do not present any unsupported statement as remembered fact.',
    'The user explicitly requested general/model knowledge. Put it in a separate section and end EVERY factual paragraph with "(aus Modellwissen - unsicher)".',
    '</recall-contract>',
  ].join('\n');
}
