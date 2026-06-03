import Database from 'better-sqlite3';

// Default points at the live shared NEXUS memory DB. Overridable via env ONLY so
// deterministic tests / sandboxed migrations can target a throwaway copy. In prod
// the env is unset → behaviour is byte-identical to the previous hardcoded constant.
const NEXUS_MEMORY_DB = process.env.NEXUS_MEMORY_DB_PATH || '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db';

let db: Database.Database | null = null;

function getDb(): Database.Database | null {
  if (db) return db;
  try {
    db = new Database(NEXUS_MEMORY_DB, { readonly: false });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch (err) {
    console.error('[NexusMemory] Failed to open DB:', err);
    return null;
  }
}

export interface MemoryRow {
  id: number;
  type: string;
  content: string;
  source: string | null;
  project: string | null;
  tags: string | null;
  score: number;
  created_at: string;
  last_accessed: string;
}

// ── Phase 7.1 Privacy A2 scope-aware retrieval ──────────────────────────────
// Codex pre-review: cross_review_phase-7-1-privacy-a2-architecture_2026-05-27.md (0.84)
// Phase-7 brief:    omi_bridge_phase7_context_layer_brief_2026-05-27.md

export type MemoryScope = 'public' | 'self_private' | 'operator_all';

export interface MemoryRetrievalPolicy {
  scope: MemoryScope;
  trustedPrivateSources: string[];
  caller?: 'master-bot' | 'family-bot' | 'test-bot' | 'cli';
}

/** Audited allowlist of `memories.source` values whose 'private' rows are
 *  considered operator-owned and therefore visible under scope='self_private'.
 *  Verified 2026-05-27: omi=194, omi-bridge=111, omi-bridge-task=413,
 *  omi-synthesis=21, scanner-pro=20. nexusgram/link-inbox currently public-only
 *  but pre-authorized. omi-bridge-task added Phase 7.2 (2026-05-27).
 *  auto-index added Phase 7.5 P0 follow-up (2026-05-28): NEXUS internal memory
 *  representations (User Profile, Memory Architecture, Session Logs, etc.) are
 *  operator-private journaling and must not leak to Family/Test bots. */
export const DEFAULT_TRUSTED_PRIVATE_SOURCES: readonly string[] = Object.freeze([
  'omi',
  'omi-bridge',
  'omi-bridge-task',
  'omi-synthesis',
  'nexusgram',
  'scanner-pro',
  'link-inbox',
  'auto-index',
]);

/** Sanity-bound for trusted sources to avoid pathological IN-lists. */
const MAX_TRUSTED_SOURCES = 32;
/** Slug-validator: alphanumerics, dash, underscore, dot. Matches every legitimate
 *  source name in the DB. Anything else is rejected silently with a warning. */
const SOURCE_SLUG_REGEX = /^[A-Za-z0-9._-]+$/;

function sanitizeTrustedSources(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of raw) {
    const t = (s || '').trim();
    if (!t) continue;
    if (!SOURCE_SLUG_REGEX.test(t)) {
      console.error(`[NexusMemory] trusted-private-source rejected (invalid slug): ${JSON.stringify(t)}`);
      continue;
    }
    if (!out.includes(t)) out.push(t);
    if (out.length >= MAX_TRUSTED_SOURCES) break;
  }
  return out;
}

/** Derive a retrieval policy from process env. Never throws.
 *  - NEXUS_MEMORY_SCOPE: 'public' | 'self_private' | 'operator_all' (default: public)
 *  - NEXUS_TRUSTED_PRIVATE_SOURCES: CSV (default: DEFAULT_TRUSTED_PRIVATE_SOURCES) */
export function readMemoryPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): MemoryRetrievalPolicy {
  const rawScope = (env.NEXUS_MEMORY_SCOPE ?? '').toLowerCase().trim();
  let scope: MemoryScope = 'public';
  if (rawScope === 'self_private' || rawScope === 'operator_all') {
    scope = rawScope;
  }
  const rawSources = env.NEXUS_TRUSTED_PRIVATE_SOURCES;
  const trustedPrivateSources = rawSources
    ? sanitizeTrustedSources(rawSources.split(','))
    : [...DEFAULT_TRUSTED_PRIVATE_SOURCES];
  return { scope, trustedPrivateSources };
}

export interface PrivacyClauseBuild {
  clause: string;
  params: unknown[];
}

/** Build a parameterized privacy WHERE-clause for a given retrieval policy.
 *  Always uses COALESCE(privacy,'public') so pre-migration NULL rows behave
 *  consistently with the DEFAULT 'public' on new inserts.
 *
 *  public        → COALESCE(privacy,'public')='public'
 *  self_private  → public rows OR (privacy='private' AND source IN <trusted>)
 *  operator_all  → no privacy filter (private rows from any source visible).
 *                  Reserved for forensic CLI use; never expose via MCP tool. */
export function buildPrivacyClause(
  conn: Database.Database,
  policy: MemoryRetrievalPolicy,
  alias = 'm',
): PrivacyClauseBuild {
  if (!hasPrivacyColumn(conn)) return { clause: '', params: [] };
  if (policy.scope === 'operator_all') {
    return {
      clause: `AND COALESCE(${alias}.privacy,'public') IN ('public','private')`,
      params: [],
    };
  }
  if (policy.scope === 'self_private' && policy.trustedPrivateSources.length > 0) {
    const placeholders = policy.trustedPrivateSources.map(() => '?').join(',');
    return {
      clause:
        `AND (COALESCE(${alias}.privacy,'public')='public' ` +
        `OR (${alias}.privacy='private' AND ${alias}.source IN (${placeholders})))`,
      params: [...policy.trustedPrivateSources],
    };
  }
  return {
    clause: `AND COALESCE(${alias}.privacy,'public')='public'`,
    params: [],
  };
}

/**
 * Detect whether the `privacy` column exists on the memories table.
 * Cached after first check. Allows the code to work on both pre-migration
 * and post-migration DBs without crashing.
 */
let privacyColumnAvailable: boolean | null = null;
function hasPrivacyColumn(conn: Database.Database): boolean {
  if (privacyColumnAvailable !== null) return privacyColumnAvailable;
  try {
    const rows = conn.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
    privacyColumnAvailable = rows.some(r => r.name === 'privacy');
  } catch {
    privacyColumnAvailable = false;
  }
  return privacyColumnAvailable;
}

/** Cross-Bot T2 (a): per-bot origin slug. Read from BOT_NAME env DIRECTLY (not via the
 *  config module) so this file stays import-light and usable in deterministic tests that
 *  don't set the full bot env. Mirrors src/inbox/capture-router.ts botId() exactly. */
export function botId(): string {
  return (process.env.BOT_NAME || 'Nexusgram').toLowerCase().replace(/\s+/g, '-');
}

/** Detect the additive `bot` column (Cross-Bot T2 migration). Cached after first check.
 *  Lets the code work on both pre- and post-migration DBs without crashing — the column
 *  is metadata only and NEVER participates in the privacy clause. */
let botColumnAvailable: boolean | null = null;
function hasBotColumn(conn: Database.Database): boolean {
  if (botColumnAvailable !== null) return botColumnAvailable;
  try {
    const rows = conn.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
    botColumnAvailable = rows.some(r => r.name === 'bot');
  } catch {
    botColumnAvailable = false;
  }
  return botColumnAvailable;
}

/**
 * Build the privacy WHERE-clause fragment based on the caller's mode.
 *
 * - includePrivate=false (default): only rows with privacy='public' are returned.
 *   Rows predating the migration (NULL) are also public because the migration
 *   backfills to 'public' and the DEFAULT covers new inserts.
 * - includePrivate=true: rows with privacy IN ('public','private') are returned.
 *   'needs_review' (Phase 2 auto-classification) is NEVER surfaced until an
 *   operator has reviewed it.
 *
 * Returns empty string when the column does not exist (pre-migration DB).
 */
function privacyClause(conn: Database.Database, includePrivate: boolean, alias = 'm'): string {
  if (!hasPrivacyColumn(conn)) return '';
  return includePrivate
    ? `AND ${alias}.privacy IN ('public', 'private')`
    : `AND ${alias}.privacy = 'public'`;
}

/**
 * FTS5 search — finds ALL memories (including archived) sorted by relevance.
 * Privacy filter: by default only 'public' rows are returned. Callers in
 * active private-mode sessions must pass includePrivate=true explicitly.
 */
export function searchMemory(
  query: string,
  limit = 5,
  project?: string,
  includePrivate = false
): MemoryRow[] {
  const conn = getDb();
  if (!conn) return [];
  try {
    // Escape FTS5 special characters by wrapping in double quotes (phrase search)
    const safeQuery = `"${query.replace(/"/g, '""')}"`;
    const projectFilter = project ? 'AND m.project = ?' : '';
    const privacyFilter = privacyClause(conn, includePrivate);
    const params: unknown[] = [safeQuery, limit];
    if (project) params.splice(1, 0, project);

    const stmt = conn.prepare(`
      SELECT m.id, m.type, m.content, m.source, m.project, m.tags, m.score, m.created_at, m.last_accessed
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
      ${projectFilter}
      ${privacyFilter}
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(...params) as MemoryRow[];
  } catch (err) {
    console.error('[NexusMemory] Search error:', err);
    return [];
  }
}

/**
 * Get recent active (non-archived) memories sorted by last_accessed.
 * Privacy filter: by default only 'public' rows are returned.
 */
export function recentMemories(
  limit = 5,
  project?: string,
  includePrivate = false
): MemoryRow[] {
  const conn = getDb();
  if (!conn) return [];
  try {
    const projectFilter = project ? 'AND project = ?' : '';
    const privacyFilter = privacyClause(conn, includePrivate, 'memories');
    const params: unknown[] = project ? [project, limit] : [limit];

    const stmt = conn.prepare(`
      SELECT id, type, content, source, project, tags, score, created_at, last_accessed
      FROM memories
      WHERE archived = 0 AND score > 0.3
      ${projectFilter}
      ${privacyFilter}
      ORDER BY last_accessed DESC
      LIMIT ?
    `);
    return stmt.all(...params) as MemoryRow[];
  } catch (err) {
    console.error('[NexusMemory] Recent error:', err);
    return [];
  }
}

/**
 * Save a new memory (episodic by default for bot-generated memories).
 *
 * `privacy` defaults to 'public'. When the calling session is in private mode,
 * pass 'private' so the row is excluded from default retrieval and from the
 * wiki synthesizer. Silently degrades to the pre-migration insert shape if
 * the `privacy` column does not exist.
 */
export function saveMemory(
  content: string,
  type: 'semantic' | 'episodic' = 'episodic',
  project?: string,
  tags?: string,
  source = 'nexusgram',
  privacy: 'public' | 'private' = 'public',
  // Cross-Bot T2 (a): per-bot origin. Defaults to the current bot's slug. Metadata only —
  // does NOT affect privacy/visibility. NULL on legacy rows / pre-migration DBs.
  bot: string | null = botId(),
): number | null {
  const conn = getDb();
  if (!conn) return null;
  try {
    const decayRate = type === 'episodic' ? 0.02 : 0.0;
    if (hasPrivacyColumn(conn)) {
      // Post-bot-migration: also persist the per-bot origin column.
      if (hasBotColumn(conn)) {
        const stmt = conn.prepare(`
          INSERT INTO memories (type, content, source, project, tags, decay_rate, privacy, bot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
          type, content, source, project || null, tags || null, decayRate, privacy, bot || null,
        );
        return Number(result.lastInsertRowid);
      }
      const stmt = conn.prepare(`
        INSERT INTO memories (type, content, source, project, tags, decay_rate, privacy)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        type, content, source, project || null, tags || null, decayRate, privacy,
      );
      return Number(result.lastInsertRowid);
    }
    // Pre-migration fallback (Arash has not yet applied the schema change).
    const stmt = conn.prepare(`
      INSERT INTO memories (type, content, source, project, tags, decay_rate)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(type, content, source, project || null, tags || null, decayRate);
    return Number(result.lastInsertRowid);
  } catch (err) {
    console.error('[NexusMemory] Save error:', err);
    return null;
  }
}

/**
 * Build a context injection block for the system prompt.
 * Combines FTS5 matches (if query given) + recent memories.
 * Budget: ~800 chars to keep prompt lean.
 *
 * `includePrivate` MUST only be true when the current session is in private
 * mode. Default is false so accidental callers never leak private memories.
 */
export function injectContext(
  query?: string,
  project?: string,
  includePrivate = false
): string {
  const ftsResults = query ? searchMemory(query, 3, project, includePrivate) : [];
  const recentResults = recentMemories(5, project, includePrivate);

  // Deduplicate: recent may overlap with FTS results
  const seenIds = new Set(ftsResults.map(r => r.id));
  const uniqueRecent = recentResults.filter(r => !seenIds.has(r.id));

  const allResults = [...ftsResults, ...uniqueRecent];
  if (allResults.length === 0) return '';

  let block = '\n\nNEXUS Memory Context:\n';
  let charCount = block.length;
  const maxChars = 1500;

  for (const mem of allResults) {
    const preview = mem.content.length > 120 ? mem.content.slice(0, 120) + '...' : mem.content;
    const line = `- [${mem.type}${mem.project ? '/' + mem.project : ''}] ${preview}\n`;
    if (charCount + line.length > maxChars) break;
    block += line;
    charCount += line.length;
  }

  return block;
}

/**
 * Close the database connection (call on graceful shutdown).
 */
/**
 * Read-only Memory-Search for the MCP-Tool exposed to Claude (nexus_memory_search).
 * Mai-Intervention 2026-05-11 Phase B.5; Phase 7.1 scope-aware 2026-05-27.
 *
 * Differences from searchMemory():
 *  - Opens its OWN read-only connection (separate from the write-capable singleton)
 *  - Fail-CLOSED by default (scope='public'); broader scopes only via explicit
 *    MemoryRetrievalPolicy in options.policy, or env-derived policy at call-time
 *  - Phrase-search first, falls back to bare-token search when 0 results
 *  - Output stripped to {content, tags, project, score} — no file_path/source/privacy leak
 *  - Limit clamped to [1, 20]
 *
 * Each call opens a transient connection; safer than mutating the shared db.
 */
export interface McpMemoryHit {
  content: string;
  tags: string | null;
  project: string | null;
  score: number;
  /** Cross-Bot T2 (a): which bot saved this (slug). NULL on legacy / pre-migration rows.
   *  Metadata only — surfaced so the agent can say "saved by family-bot"; never gates visibility. */
  bot?: string | null;
}

export interface MemorySearchOptions {
  /** Retrieval policy. If omitted, policy is derived from process env at call-time. */
  policy?: MemoryRetrievalPolicy;
}

export function searchMemoryReadOnly(
  query: string,
  limit = 5,
  project?: string,
  options: MemorySearchOptions = {},
): McpMemoryHit[] {
  const clampedLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  if (!query.trim()) return [];

  const policy = options.policy ?? readMemoryPolicyFromEnv();
  const auditEnabled = (process.env.NEXUS_MEMORY_AUDIT ?? '') === '1';

  let conn: Database.Database | null = null;
  try {
    conn = new Database(NEXUS_MEMORY_DB, { readonly: true, fileMustExist: true });
    conn.pragma('busy_timeout = 5000');

    const { clause: privClause, params: privParams } = buildPrivacyClause(conn, policy);
    const projectClause = project ? `AND m.project = ?` : '';
    const botCol = hasBotColumn(conn) ? ', m.bot' : '';   // T2(a) additive; absent pre-migration

    const buildStmt = () => conn!.prepare(`
      SELECT m.content, m.tags, m.project, m.score, m.privacy, m.source${botCol}
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
      ${projectClause}
      ${privClause}
      ORDER BY rank
      LIMIT ?
    `);

    const buildParams = (matchExpr: string): unknown[] => {
      const p: unknown[] = [matchExpr];
      if (project) p.push(project);
      p.push(...privParams);
      p.push(clampedLimit);
      return p;
    };

    type RawRow = McpMemoryHit & { privacy?: string | null; source?: string | null };
    const phraseQuery = `"${query.replace(/"/g, '""')}"`;
    let rows = buildStmt().all(...buildParams(phraseQuery)) as RawRow[];

    // Fallback: when phrase-search returns 0, try a bare token search
    if (rows.length === 0) {
      const tokenQuery = query
        .replace(/[^\p{L}\p{N}\s@-]/gu, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .join(' OR ');
      if (tokenQuery) {
        rows = buildStmt().all(...buildParams(tokenQuery)) as RawRow[];
      }
    }

    if (auditEnabled) {
      const privateHits = rows.filter(r => r.privacy === 'private');
      const sourceCounts = new Map<string, number>();
      for (const r of privateHits) {
        const s = r.source || '(unknown)';
        sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1);
      }
      const breakdown = Array.from(sourceCounts.entries())
        .map(([s, n]) => `${s}:${n}`)
        .join(',') || 'none';
      console.error(
        `[NexusMemory/MCP] scope=${policy.scope} hits=${rows.length} ` +
        `private_hits=${privateHits.length} private_sources=${breakdown}`,
      );
    }

    // Strip privacy/source from output, truncate per V2.4-5 spec. `bot` (T2 metadata) kept.
    return rows.map(r => ({
      content: r.content.length > 500 ? r.content.slice(0, 500) + '…' : r.content,
      tags: r.tags,
      project: r.project,
      score: r.score,
      bot: r.bot ?? null,
    }));
  } catch (err) {
    console.error('[NexusMemory/MCP] searchMemoryReadOnly error:', err);
    return [];
  } finally {
    try { conn?.close(); } catch { /* swallow */ }
  }
}

/**
 * Read-only recency listing for the MCP tool `nexus_memory_recent` (WAVE-1 Cross-Bot T1).
 * Complements searchMemoryReadOnly (keyword/FTS5) with "latest N memories, no keyword"
 * for recall-before-ask. Mirrors searchMemoryReadOnly's hardening EXACTLY:
 *  - Opens its OWN read-only connection (separate from the write-capable singleton)
 *  - query_only=ON, busy_timeout=5000
 *  - Fail-CLOSED by default (scope='public'); broader scopes only via explicit
 *    MemoryRetrievalPolicy in options.policy, or env-derived policy at call-time
 *  - Scope-aware privacy via buildPrivacyClause(conn, policy, 'm') — identical gating
 *    to the search tool; NO broader exposure
 *  - archived=0 only; NO score>0.3 filter (recency tool must surface fresh 0-score rows)
 *  - ORDER BY created_at DESC, id DESC (id tie-breaker for sub-second collisions, Codex P1-2)
 *  - Output stripped to {content, tags, project, score, created_at} — no
 *    file_path/source/privacy/id leak (Codex P1-3)
 *  - Limit clamped to [1, 20]
 */
export function recentMemoriesReadOnly(
  limit = 5,
  project?: string,
  options: MemorySearchOptions = {},
): (McpMemoryHit & { created_at: string })[] {
  const clampedLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const policy = options.policy ?? readMemoryPolicyFromEnv();

  let conn: Database.Database | null = null;
  try {
    conn = new Database(NEXUS_MEMORY_DB, { readonly: true, fileMustExist: true });
    conn.pragma('busy_timeout = 5000');
    conn.pragma('query_only = ON');

    const { clause: privClause, params: privParams } = buildPrivacyClause(conn, policy, 'm');
    const projectClause = project ? 'AND m.project = ?' : '';
    const botCol = hasBotColumn(conn) ? ', m.bot' : '';   // T2(a) additive; absent pre-migration

    const stmt = conn.prepare(`
      SELECT m.content, m.tags, m.project, m.score, m.created_at${botCol}
      FROM memories m
      WHERE m.archived = 0
      ${projectClause}
      ${privClause}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?
    `);
    const params: unknown[] = [];
    if (project) params.push(project);
    params.push(...privParams);
    params.push(clampedLimit);

    const rows = stmt.all(...params) as Array<McpMemoryHit & { created_at: string }>;
    // Strip to {content, tags, project, score, created_at, bot}, truncate per V2.4-5 spec
    return rows.map(r => ({
      content: r.content.length > 500 ? r.content.slice(0, 500) + '…' : r.content,
      tags: r.tags,
      project: r.project,
      score: r.score,
      created_at: r.created_at,
      bot: r.bot ?? null,
    }));
  } catch (err) {
    console.error('[NexusMemory/MCP] recentMemoriesReadOnly error:', err);
    return [];
  } finally {
    try { conn?.close(); } catch { /* swallow */ }
  }
}

// ── Phase 7.2 Task-Sidecar search ───────────────────────────────────────────
// Codex pre-review: cross_review_phase-7-2-task-sidecar-architecture_2026-05-27.md (0.86)

export type TaskStatus = 'open' | 'completed' | 'all';

export interface TaskSearchOptions {
  status?: TaskStatus;
  from?: string;       // ISO date floor for due_at_utc
  to?: string;         // ISO date ceiling
  priority?: 'high' | 'medium' | 'low';
  category?: string;
  limit?: number;
  policy?: MemoryRetrievalPolicy;
}

export interface TaskHit {
  source_kind: string;
  source_id: string;
  description: string;
  priority: string | null;
  category: string | null;
  due_at_utc: string | null;
  completed: number;
  source_app: string | null;
  age_days: number | null;
  memory_id: number;
}

export function searchTasks(opts: TaskSearchOptions = {}): TaskHit[] {
  const policy = opts.policy ?? readMemoryPolicyFromEnv();
  // Tasks are private rows under 'omi-bridge-task'. Anything below self_private
  // sees nothing, which is the correct fail-closed for family/test.
  if (policy.scope === 'public' ||
      !policy.trustedPrivateSources.includes('omi-bridge-task')) {
    return [];
  }

  const status: TaskStatus = opts.status ?? 'open';
  const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 20)));

  let conn: Database.Database | null = null;
  try {
    conn = new Database(NEXUS_MEMORY_DB, { readonly: true, fileMustExist: true });
    conn.pragma('busy_timeout = 5000');

    // Alias-prefix all where-clauses to disambiguate from memories.* columns
    // (archived, source, privacy all exist on both tables).
    const where: string[] = ['mt.deleted=0', 'mt.archived=0'];
    const params: unknown[] = [];

    if (status === 'open') {
      where.push('mt.completed=0');
    } else if (status === 'completed') {
      where.push('mt.completed=1');
    }
    if (opts.from) {
      where.push('mt.due_at_utc IS NOT NULL AND mt.due_at_utc >= ?');
      params.push(opts.from);
    }
    if (opts.to) {
      where.push('mt.due_at_utc IS NOT NULL AND mt.due_at_utc <= ?');
      params.push(opts.to);
    }
    if (opts.priority) {
      where.push('mt.priority = ?');
      params.push(opts.priority);
    }
    if (opts.category) {
      where.push('mt.category = ?');
      params.push(opts.category);
    }

    // Defensive JOIN to memories: ensures sidecar rows whose owning memories row
    // was manually deleted are not surfaced (Codex P2-1 in diff-review 2026-05-27).
    // SQLite-FKs are per-connection; non-importer writers may not enforce CASCADE.
    const sql = `
      SELECT mt.source_kind, mt.source_id, mt.description, mt.priority,
             mt.category, mt.due_at_utc, mt.completed, mt.source_app,
             mt.created_at_utc, mt.memory_id
      FROM memory_tasks mt
      JOIN memories m ON m.id = mt.memory_id
      WHERE m.source = 'omi-bridge-task'
        AND m.privacy = 'private'
        AND ${where.join(' AND ')}
      ORDER BY CASE WHEN mt.due_at_utc IS NULL THEN 1 ELSE 0 END,
               mt.due_at_utc ASC,
               CASE mt.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END
      LIMIT ?
    `;
    params.push(limit);

    const rows = conn.prepare(sql).all(...params) as Array<{
      source_kind: string;
      source_id: string;
      description: string;
      priority: string | null;
      category: string | null;
      due_at_utc: string | null;
      completed: number;
      source_app: string | null;
      created_at_utc: string | null;
      memory_id: number;
    }>;

    const now = Date.now();
    return rows.map(r => {
      let age: number | null = null;
      if (r.created_at_utc) {
        const t = Date.parse(r.created_at_utc);
        if (!Number.isNaN(t)) age = Math.floor((now - t) / 86_400_000);
      }
      return {
        source_kind: r.source_kind,
        source_id: r.source_id,
        description: r.description,
        priority: r.priority,
        category: r.category,
        due_at_utc: r.due_at_utc,
        completed: r.completed,
        source_app: r.source_app,
        age_days: age,
        memory_id: r.memory_id,
      };
    });
  } catch (err) {
    console.error('[NexusMemory/MCP] searchTasks error:', err);
    return [];
  } finally {
    try { conn?.close(); } catch { /* swallow */ }
  }
}

// ── Phase 7.5 Context-MCP-Tools — Person Timeline + Entity Search ──────────
// Codex pre-review: cross_review_phase-7-5-context-mcp-tools-architecture_2026-05-27.md (0.78)
// Honors P0-1 (entity query optional + date window), P0-3 (ATTACH source-date JOIN),
// P0-4 (privacy gate IN tool, not via persons-index trusted source),
// P0-5 (search unresolved canonical_text alongside resolved aliases).

const OMI_BRIDGE_DB_PATH = '/Volumes/AstronOne/shared-memory/omi-bridge/indexed/omi_bridge.db';

/** Canonical whitelist of source_kind values an entity-search caller may pass.
 *  Hardcoded to prevent SQL-table-name injection (Codex P0-3 caveat). */
const ALLOWED_SOURCE_KINDS = Object.freeze([
  'omi_memories',
  'omi_transcription_segments',
  'memory_db_memories',
] as const);
type SourceKind = typeof ALLOWED_SOURCE_KINDS[number];

/** Normalize a person-name input the same way the importer does. Mirrors
 *  scripts/omi-bridge/phase7_ner_import.py:62 normalize_alias(). */
function normalizePersonName(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export interface PersonResolution {
  /** Canonical persons row matched (or first of ambiguous set). */
  personId: string | null;
  canonicalName: string | null;
  status: 'active' | 'merged' | 'ignored' | null;
  /** When >1 alias/canonical matches, list candidates so caller can disambiguate. */
  ambiguous: Array<{ person_id: string; canonical_name: string; mention_count: number }>;
  /** When 0 matches, suggest prefix/contains hits from aliases + unresolved canonical_text. */
  suggestions: Array<{ label: string; mention_count: number; source: 'alias' | 'unresolved' }>;
}

/** Resolve a person-name to a persons row, strict-first then suggest. Codex P1-1. */
export function resolvePerson(query: string): PersonResolution {
  const empty: PersonResolution = {
    personId: null, canonicalName: null, status: null, ambiguous: [], suggestions: [],
  };
  const trimmed = (query ?? '').trim();
  if (!trimmed) return empty;
  const norm = normalizePersonName(trimmed);
  if (!norm) return empty;

  let conn: Database.Database | null = null;
  try {
    conn = new Database(NEXUS_MEMORY_DB, { readonly: true, fileMustExist: true });
    conn.pragma('busy_timeout = 5000');
    conn.pragma('query_only = ON');

    // 1) Exact alias_normalized match (the importer's stored form)
    const exactAliases = conn.prepare(
      `SELECT DISTINCT p.person_id, p.canonical_name, p.status, p.mention_count
       FROM person_aliases a JOIN persons p ON p.person_id = a.person_id
       WHERE a.alias_normalized = ? ORDER BY p.mention_count DESC`
    ).all(norm) as Array<{ person_id: string; canonical_name: string; status: string; mention_count: number }>;
    if (exactAliases.length === 1) {
      const r = exactAliases[0];
      return { personId: r.person_id, canonicalName: r.canonical_name, status: r.status as PersonResolution['status'], ambiguous: [], suggestions: [] };
    }
    if (exactAliases.length > 1) {
      return {
        personId: exactAliases[0].person_id,
        canonicalName: exactAliases[0].canonical_name,
        status: exactAliases[0].status as PersonResolution['status'],
        ambiguous: exactAliases.map(r => ({ person_id: r.person_id, canonical_name: r.canonical_name, mention_count: r.mention_count ?? 0 })),
        suggestions: [],
      };
    }

    // 2) Exact canonical_name NOCASE
    const canonicals = conn.prepare(
      `SELECT person_id, canonical_name, status, mention_count FROM persons
       WHERE canonical_name = ? COLLATE NOCASE ORDER BY mention_count DESC`
    ).all(trimmed) as Array<{ person_id: string; canonical_name: string; status: string; mention_count: number }>;
    if (canonicals.length >= 1) {
      const r = canonicals[0];
      return { personId: r.person_id, canonicalName: r.canonical_name, status: r.status as PersonResolution['status'],
        ambiguous: canonicals.length > 1 ? canonicals.map(c => ({ person_id: c.person_id, canonical_name: c.canonical_name, mention_count: c.mention_count ?? 0 })) : [],
        suggestions: [] };
    }

    // 3) Suggestions: prefix/contains over aliases + unresolved canonical_text
    const prefixLike = `${norm}%`;
    const containsLike = `%${norm}%`;
    const aliasSugg = conn.prepare(
      `SELECT DISTINCT p.canonical_name AS label, p.mention_count AS mention_count
       FROM person_aliases a JOIN persons p ON p.person_id = a.person_id
       WHERE a.alias_normalized LIKE ? OR a.alias_normalized LIKE ?
       ORDER BY p.mention_count DESC LIMIT 5`
    ).all(prefixLike, containsLike) as Array<{ label: string; mention_count: number }>;
    const unresolvedSugg = conn.prepare(
      `SELECT canonical_text AS label, COUNT(*) AS mention_count FROM entity_mentions
       WHERE resolved_person_id IS NULL AND entity_kind = 'person'
         AND (LOWER(canonical_text) LIKE ? OR LOWER(canonical_text) LIKE ?)
       GROUP BY canonical_text ORDER BY mention_count DESC LIMIT 5`
    ).all(prefixLike, containsLike) as Array<{ label: string; mention_count: number }>;

    return {
      ...empty,
      suggestions: [
        ...aliasSugg.map(s => ({ ...s, source: 'alias' as const })),
        ...unresolvedSugg.map(s => ({ ...s, source: 'unresolved' as const })),
      ].slice(0, 8),
    };
  } catch (err) {
    console.error('[NexusMemory/MCP] resolvePerson error:', err);
    return empty;
  } finally {
    try { conn?.close(); } catch { /* swallow */ }
  }
}

export interface TimelineHit {
  source_kind: SourceKind;
  source_id: string;
  source_created_at_utc: string | null;
  canonical_text: string;
  field_name: string;
  match_method: string | null;
  snippet: string;
}

export interface PersonTimelineOptions {
  person: string;
  from?: string;
  to?: string;
  limit?: number;
  policy?: MemoryRetrievalPolicy;
}

export interface PersonTimelineResult {
  resolution: PersonResolution;
  hits: TimelineHit[];
  more_available: boolean;
  scope_denied: boolean;
}

const TIMELINE_DEFAULT_LIMIT = 10;
const TIMELINE_MAX_LIMIT = 20;
const SNIPPET_CHARS = 200;

function compactSnippet(text: string | null | undefined): string {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SNIPPET_CHARS) return collapsed;
  return collapsed.slice(0, SNIPPET_CHARS - 1) + '…';
}

/** Phase 7.5 P0-3: ATTACH omi_bridge.db read-only and UNION over the three
 *  source-kinds. Privacy gate is enforced HERE (P0-4): only operator scope
 *  may read these rows; non-operators get an empty result with scope_denied=true. */
export function searchPersonTimeline(opts: PersonTimelineOptions): PersonTimelineResult {
  const policy = opts.policy ?? readMemoryPolicyFromEnv();
  const empty = (resolution: PersonResolution, scope_denied: boolean): PersonTimelineResult =>
    ({ resolution, hits: [], more_available: false, scope_denied });

  const resolution = resolvePerson(opts.person);

  // Codex P0-4: fail-closed for non-operator scope
  if (policy.scope !== 'self_private' || !policy.trustedPrivateSources.includes('omi-bridge')) {
    return empty(resolution, true);
  }
  // Honor 'ignored' status — these are FP markers (User/Sie/Miro/etc.)
  if (resolution.status === 'ignored') return empty(resolution, false);
  if (!resolution.personId) return empty(resolution, false);

  const limit = Math.max(1, Math.min(TIMELINE_MAX_LIMIT, Math.floor(opts.limit ?? TIMELINE_DEFAULT_LIMIT)));

  let conn: Database.Database | null = null;
  try {
    conn = new Database(NEXUS_MEMORY_DB, { readonly: true, fileMustExist: true });
    conn.pragma('busy_timeout = 5000');
    conn.pragma('query_only = ON');
    conn.exec(`ATTACH DATABASE 'file:${OMI_BRIDGE_DB_PATH}?mode=ro' AS omi`);

    // Build optional date filter (applied to source row's created_at_utc)
    const dateFilter = (col: string): { clause: string; params: unknown[] } => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (opts.from) { clauses.push(`${col} >= ?`); params.push(opts.from); }
      if (opts.to)   { clauses.push(`${col} <= ?`); params.push(opts.to); }
      return clauses.length ? { clause: ' AND ' + clauses.join(' AND '), params } : { clause: '', params: [] };
    };

    const fOmiMem = dateFilter('omi_mem.created_at_utc');
    const fSeg    = dateFilter('omi_sess.started_at_utc');
    const fMemDb  = dateFilter('m.created_at_utc');

    // We over-fetch (limit+1) per branch so we can compute more_available
    // after the global merge. Each branch is bounded; total ≤ 3*(limit+1).
    const perBranch = limit + 1;
    const personId = resolution.personId;

    const sql = `
      SELECT 'omi_memories' AS source_kind,
             CAST(omi_mem.omi_id AS TEXT) AS source_id,
             omi_mem.created_at_utc AS source_created_at_utc,
             em.canonical_text AS canonical_text,
             em.field_name AS field_name,
             em.match_method AS match_method,
             COALESCE(em.context_before,'') || em.canonical_text || COALESCE(em.context_after,'') AS raw_snippet
        FROM entity_mentions em
        JOIN omi.omi_memories omi_mem ON CAST(omi_mem.omi_id AS TEXT) = em.source_id
       WHERE em.resolved_person_id = ?
         AND em.source_db = 'omi_bridge'
         AND em.source_table = 'omi_memories'
         ${fOmiMem.clause}
       ORDER BY omi_mem.created_at_utc DESC
       LIMIT ${perBranch}

      UNION ALL

      SELECT 'omi_transcription_segments' AS source_kind,
             CAST(omi_seg.omi_id AS TEXT) AS source_id,
             omi_sess.started_at_utc AS source_created_at_utc,
             em.canonical_text AS canonical_text,
             em.field_name AS field_name,
             em.match_method AS match_method,
             COALESCE(em.context_before,'') || em.canonical_text || COALESCE(em.context_after,'') AS raw_snippet
        FROM entity_mentions em
        JOIN omi.omi_transcription_segments omi_seg ON CAST(omi_seg.omi_id AS TEXT) = em.source_id
        JOIN omi.omi_transcription_sessions omi_sess ON omi_sess.omi_id = omi_seg.session_omi_id
       WHERE em.resolved_person_id = ?
         AND em.source_db = 'omi_bridge'
         AND em.source_table = 'omi_transcription_segments'
         ${fSeg.clause}
       ORDER BY omi_sess.started_at_utc DESC
       LIMIT ${perBranch}

      UNION ALL

      SELECT 'memory_db_memories' AS source_kind,
             CAST(m.id AS TEXT) AS source_id,
             m.created_at AS source_created_at_utc,
             em.canonical_text AS canonical_text,
             em.field_name AS field_name,
             em.match_method AS match_method,
             COALESCE(em.context_before,'') || em.canonical_text || COALESCE(em.context_after,'') AS raw_snippet
        FROM entity_mentions em
        JOIN memories m ON CAST(m.id AS TEXT) = em.source_id
       WHERE em.resolved_person_id = ?
         AND em.source_db = 'memory_db'
         AND em.source_table = 'memories'
         ${fMemDb.clause}
       ORDER BY m.created_at DESC
       LIMIT ${perBranch}
    `;
    const params: unknown[] = [
      personId, ...fOmiMem.params,
      personId, ...fSeg.params,
      personId, ...fMemDb.params,
    ];

    const rows = conn.prepare(sql).all(...params) as Array<{
      source_kind: SourceKind;
      source_id: string;
      source_created_at_utc: string | null;
      canonical_text: string;
      field_name: string;
      match_method: string | null;
      raw_snippet: string;
    }>;

    rows.sort((a, b) => (b.source_created_at_utc ?? '').localeCompare(a.source_created_at_utc ?? ''));
    const more_available = rows.length > limit;
    const sliced = rows.slice(0, limit);

    if (process.env.NEXUS_MEMORY_AUDIT === '1') {
      const counts = new Map<string, number>();
      for (const r of sliced) counts.set(r.source_kind, (counts.get(r.source_kind) ?? 0) + 1);
      const summary = [...counts.entries()].map(([k, v]) => `${k}:${v}`).join(',');
      console.error(`[NexusMemory/MCP] person_timeline person=${resolution.canonicalName} resolved=${resolution.personId} hits=${sliced.length} more=${more_available} sources=${summary}`);
    }

    return {
      resolution,
      hits: sliced.map(r => ({
        source_kind: r.source_kind,
        source_id: r.source_id,
        source_created_at_utc: r.source_created_at_utc,
        canonical_text: r.canonical_text,
        field_name: r.field_name,
        match_method: r.match_method,
        snippet: compactSnippet(r.raw_snippet),
      })),
      more_available,
      scope_denied: false,
    };
  } catch (err) {
    console.error('[NexusMemory/MCP] searchPersonTimeline error:', err);
    return empty(resolution, false);
  } finally {
    try { conn?.exec('DETACH DATABASE omi'); } catch { /* swallow */ }
    try { conn?.close(); } catch { /* swallow */ }
  }
}

export interface EntitySearchHit {
  source_kind: SourceKind;
  source_id: string;
  source_created_at_utc: string | null;
  entity_kind: 'person' | 'organization' | 'place';
  canonical_text: string;
  resolved_canonical_name: string | null;  // null if unresolved
  resolved_person_id: string | null;
  match_method: string | null;
  snippet: string;
}

export interface EntitySearchOptions {
  query?: string;                               // OPTIONAL (Codex P0-1)
  entity_kind?: 'person' | 'organization' | 'place' | 'any';
  from?: string;
  to?: string;
  limit?: number;
  policy?: MemoryRetrievalPolicy;
}

export interface EntitySearchResult {
  hits: EntitySearchHit[];
  more_available: boolean;
  scope_denied: boolean;
  /** When query is empty + window given, top entities aggregated for that window. */
  top_entities_in_window: Array<{ canonical_text: string; resolved_person_id: string | null; resolved_canonical_name: string | null; entity_kind: string; mention_count: number }>;
}

const ENTITY_SEARCH_DEFAULT_LIMIT = 10;
const ENTITY_SEARCH_MAX_LIMIT = 20;

export function searchEntities(opts: EntitySearchOptions = {}): EntitySearchResult {
  const policy = opts.policy ?? readMemoryPolicyFromEnv();
  const empty = (scope_denied: boolean): EntitySearchResult =>
    ({ hits: [], more_available: false, scope_denied, top_entities_in_window: [] });

  // Codex P0-4: operator-only fail-closed for omi_bridge source rows
  if (policy.scope !== 'self_private' || !policy.trustedPrivateSources.includes('omi-bridge')) {
    return empty(true);
  }

  const limit = Math.max(1, Math.min(ENTITY_SEARCH_MAX_LIMIT, Math.floor(opts.limit ?? ENTITY_SEARCH_DEFAULT_LIMIT)));
  const kind = (opts.entity_kind && opts.entity_kind !== 'any') ? opts.entity_kind : null;
  const queryTrimmed = (opts.query ?? '').trim();
  const queryNorm = queryTrimmed ? normalizePersonName(queryTrimmed) : '';
  const hasQuery = queryNorm.length > 0;
  const hasWindow = !!(opts.from || opts.to);

  let conn: Database.Database | null = null;
  try {
    conn = new Database(NEXUS_MEMORY_DB, { readonly: true, fileMustExist: true });
    conn.pragma('busy_timeout = 5000');
    conn.pragma('query_only = ON');
    conn.exec(`ATTACH DATABASE 'file:${OMI_BRIDGE_DB_PATH}?mode=ro' AS omi`);

    // Date filter on each source_table's source-date column
    const fOmiMem = (() => {
      const clauses: string[] = []; const params: unknown[] = [];
      if (opts.from) { clauses.push('omi_mem.created_at_utc >= ?'); params.push(opts.from); }
      if (opts.to)   { clauses.push('omi_mem.created_at_utc <= ?'); params.push(opts.to); }
      return { clause: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
    })();
    const fSeg = (() => {
      const clauses: string[] = []; const params: unknown[] = [];
      if (opts.from) { clauses.push('omi_sess.started_at_utc >= ?'); params.push(opts.from); }
      if (opts.to)   { clauses.push('omi_sess.started_at_utc <= ?'); params.push(opts.to); }
      return { clause: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
    })();
    const fMemDb = (() => {
      const clauses: string[] = []; const params: unknown[] = [];
      if (opts.from) { clauses.push('m.created_at >= ?'); params.push(opts.from); }
      if (opts.to)   { clauses.push('m.created_at <= ?'); params.push(opts.to); }
      return { clause: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
    })();

    // Optional query filter (alias normalized OR unresolved canonical_text)
    const buildQueryFilter = (): { clause: string; params: unknown[] } => {
      if (!hasQuery) return { clause: '', params: [] };
      // Match either:
      //  - resolved person whose canonical/alias contains queryNorm
      //  - unresolved entity_mentions.canonical_text contains queryNorm
      const like = `%${queryNorm}%`;
      return {
        clause: ` AND (
          em.resolved_person_id IN (
            SELECT a.person_id FROM person_aliases a
            WHERE a.alias_normalized LIKE ?
            UNION SELECT p.person_id FROM persons p WHERE LOWER(p.canonical_name) LIKE ?
          )
          OR LOWER(em.canonical_text) LIKE ?
        )`,
        params: [like, like, like],
      };
    };
    const qFilter = buildQueryFilter();

    // Kind filter
    const kindClause = kind ? ' AND em.entity_kind = ?' : '';
    const kindParam = kind ? [kind] : [];

    const perBranch = limit + 1;
    const sql = `
      SELECT 'omi_memories' AS source_kind,
             CAST(omi_mem.omi_id AS TEXT) AS source_id,
             omi_mem.created_at_utc AS source_created_at_utc,
             em.entity_kind AS entity_kind,
             em.canonical_text AS canonical_text,
             em.resolved_person_id AS resolved_person_id,
             p.canonical_name AS resolved_canonical_name,
             em.match_method AS match_method,
             COALESCE(em.context_before,'') || em.canonical_text || COALESCE(em.context_after,'') AS raw_snippet
        FROM entity_mentions em
        LEFT JOIN persons p ON p.person_id = em.resolved_person_id
        JOIN omi.omi_memories omi_mem ON CAST(omi_mem.omi_id AS TEXT) = em.source_id
       WHERE em.source_db = 'omi_bridge'
         AND em.source_table = 'omi_memories'
         AND (p.status IS NULL OR p.status != 'ignored')
         ${kindClause} ${qFilter.clause} ${fOmiMem.clause}
       ORDER BY omi_mem.created_at_utc DESC
       LIMIT ${perBranch}

      UNION ALL

      SELECT 'omi_transcription_segments' AS source_kind,
             CAST(omi_seg.omi_id AS TEXT) AS source_id,
             omi_sess.started_at_utc AS source_created_at_utc,
             em.entity_kind AS entity_kind,
             em.canonical_text AS canonical_text,
             em.resolved_person_id AS resolved_person_id,
             p.canonical_name AS resolved_canonical_name,
             em.match_method AS match_method,
             COALESCE(em.context_before,'') || em.canonical_text || COALESCE(em.context_after,'') AS raw_snippet
        FROM entity_mentions em
        LEFT JOIN persons p ON p.person_id = em.resolved_person_id
        JOIN omi.omi_transcription_segments omi_seg ON CAST(omi_seg.omi_id AS TEXT) = em.source_id
        JOIN omi.omi_transcription_sessions omi_sess ON omi_sess.omi_id = omi_seg.session_omi_id
       WHERE em.source_db = 'omi_bridge'
         AND em.source_table = 'omi_transcription_segments'
         AND (p.status IS NULL OR p.status != 'ignored')
         ${kindClause} ${qFilter.clause} ${fSeg.clause}
       ORDER BY omi_sess.started_at_utc DESC
       LIMIT ${perBranch}

      UNION ALL

      SELECT 'memory_db_memories' AS source_kind,
             CAST(m.id AS TEXT) AS source_id,
             m.created_at AS source_created_at_utc,
             em.entity_kind AS entity_kind,
             em.canonical_text AS canonical_text,
             em.resolved_person_id AS resolved_person_id,
             p.canonical_name AS resolved_canonical_name,
             em.match_method AS match_method,
             COALESCE(em.context_before,'') || em.canonical_text || COALESCE(em.context_after,'') AS raw_snippet
        FROM entity_mentions em
        LEFT JOIN persons p ON p.person_id = em.resolved_person_id
        JOIN memories m ON CAST(m.id AS TEXT) = em.source_id
       WHERE em.source_db = 'memory_db'
         AND em.source_table = 'memories'
         AND (p.status IS NULL OR p.status != 'ignored')
         ${kindClause} ${qFilter.clause} ${fMemDb.clause}
       ORDER BY m.created_at DESC
       LIMIT ${perBranch}
    `;
    const params: unknown[] = [
      ...kindParam, ...qFilter.params, ...fOmiMem.params,
      ...kindParam, ...qFilter.params, ...fSeg.params,
      ...kindParam, ...qFilter.params, ...fMemDb.params,
    ];

    const rows = conn.prepare(sql).all(...params) as Array<{
      source_kind: SourceKind;
      source_id: string;
      source_created_at_utc: string | null;
      entity_kind: 'person' | 'organization' | 'place';
      canonical_text: string;
      resolved_person_id: string | null;
      resolved_canonical_name: string | null;
      match_method: string | null;
      raw_snippet: string;
    }>;

    rows.sort((a, b) => (b.source_created_at_utc ?? '').localeCompare(a.source_created_at_utc ?? ''));
    const more_available = rows.length > limit;
    const sliced = rows.slice(0, limit);

    // Phase 7.5 P0-1: query-less + window → aggregate top entities in window
    let topEntities: EntitySearchResult['top_entities_in_window'] = [];
    if (!hasQuery && hasWindow) {
      // Aggregate over the same window using a parallel query (only entity_mentions,
      // joined by source_table to apply the correct source-date filter).
      const aggSql = `
        WITH windowed AS (
          SELECT em.entity_kind, em.canonical_text, em.resolved_person_id
            FROM entity_mentions em
            JOIN omi.omi_memories omi_mem ON CAST(omi_mem.omi_id AS TEXT) = em.source_id
           WHERE em.source_db = 'omi_bridge' AND em.source_table = 'omi_memories'
             ${kindClause} ${fOmiMem.clause}
          UNION ALL
          SELECT em.entity_kind, em.canonical_text, em.resolved_person_id
            FROM entity_mentions em
            JOIN omi.omi_transcription_segments omi_seg ON CAST(omi_seg.omi_id AS TEXT) = em.source_id
            JOIN omi.omi_transcription_sessions omi_sess ON omi_sess.omi_id = omi_seg.session_omi_id
           WHERE em.source_db = 'omi_bridge' AND em.source_table = 'omi_transcription_segments'
             ${kindClause} ${fSeg.clause}
        )
        SELECT w.entity_kind, w.canonical_text, w.resolved_person_id,
               p.canonical_name AS resolved_canonical_name, COUNT(*) AS mention_count
          FROM windowed w LEFT JOIN persons p ON p.person_id = w.resolved_person_id
         WHERE (p.status IS NULL OR p.status != 'ignored')
         GROUP BY w.entity_kind, COALESCE(w.resolved_person_id, w.canonical_text)
         ORDER BY mention_count DESC LIMIT ${limit}
      `;
      const aggParams: unknown[] = [
        ...kindParam, ...fOmiMem.params,
        ...kindParam, ...fSeg.params,
      ];
      const aggRows = conn.prepare(aggSql).all(...aggParams) as Array<{
        entity_kind: string; canonical_text: string; resolved_person_id: string | null; resolved_canonical_name: string | null; mention_count: number;
      }>;
      topEntities = aggRows;
    }

    if (process.env.NEXUS_MEMORY_AUDIT === '1') {
      console.error(`[NexusMemory/MCP] entity_search query=${queryTrimmed || '∅'} kind=${kind ?? 'any'} from=${opts.from ?? '-'} to=${opts.to ?? '-'} hits=${sliced.length} top_in_window=${topEntities.length} more=${more_available}`);
    }

    return {
      hits: sliced.map(r => ({
        source_kind: r.source_kind,
        source_id: r.source_id,
        source_created_at_utc: r.source_created_at_utc,
        entity_kind: r.entity_kind,
        canonical_text: r.canonical_text,
        resolved_canonical_name: r.resolved_canonical_name,
        resolved_person_id: r.resolved_person_id,
        match_method: r.match_method,
        snippet: compactSnippet(r.raw_snippet),
      })),
      more_available,
      scope_denied: false,
      top_entities_in_window: topEntities,
    };
  } catch (err) {
    console.error('[NexusMemory/MCP] searchEntities error:', err);
    return empty(false);
  } finally {
    try { conn?.exec('DETACH DATABASE omi'); } catch { /* swallow */ }
    try { conn?.close(); } catch { /* swallow */ }
  }
}

export function closeMemoryDb(): void {
  if (db) {
    try {
      db.close();
    } catch { /* ignore */ }
    db = null;
  }
}
