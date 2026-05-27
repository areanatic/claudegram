import Database from 'better-sqlite3';

const NEXUS_MEMORY_DB = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db';

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
 *  but pre-authorized. omi-bridge-task added Phase 7.2 (2026-05-27). */
export const DEFAULT_TRUSTED_PRIVATE_SOURCES: readonly string[] = Object.freeze([
  'omi',
  'omi-bridge',
  'omi-bridge-task',
  'omi-synthesis',
  'nexusgram',
  'scanner-pro',
  'link-inbox',
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
  privacy: 'public' | 'private' = 'public'
): number | null {
  const conn = getDb();
  if (!conn) return null;
  try {
    const decayRate = type === 'episodic' ? 0.02 : 0.0;
    if (hasPrivacyColumn(conn)) {
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

    const buildStmt = () => conn!.prepare(`
      SELECT m.content, m.tags, m.project, m.score, m.privacy, m.source
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

    // Strip privacy/source from output, truncate per V2.4-5 spec
    return rows.map(r => ({
      content: r.content.length > 500 ? r.content.slice(0, 500) + '…' : r.content,
      tags: r.tags,
      project: r.project,
      score: r.score,
    }));
  } catch (err) {
    console.error('[NexusMemory/MCP] searchMemoryReadOnly error:', err);
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

export function closeMemoryDb(): void {
  if (db) {
    try {
      db.close();
    } catch { /* ignore */ }
    db = null;
  }
}
