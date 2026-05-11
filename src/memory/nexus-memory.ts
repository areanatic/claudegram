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
 * Mai-Intervention 2026-05-11 Phase B.5.
 *
 * Differences from searchMemory():
 *  - Opens its OWN read-only connection (separate from the write-capable singleton)
 *  - Always fail-CLOSED: privacy='public' filter is hard-wired, no includePrivate option
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

export function searchMemoryReadOnly(
  query: string,
  limit = 5,
  project?: string
): McpMemoryHit[] {
  const clampedLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  if (!query.trim()) return [];

  let conn: Database.Database | null = null;
  try {
    conn = new Database(NEXUS_MEMORY_DB, { readonly: true, fileMustExist: true });
    conn.pragma('busy_timeout = 5000');

    const hasPriv = hasPrivacyColumn(conn);
    const privClause = hasPriv ? `AND m.privacy = 'public'` : '';
    const projectClause = project ? `AND m.project = ?` : '';

    const buildStmt = (matchExpr: string) => conn!.prepare(`
      SELECT m.content, m.tags, m.project, m.score
      FROM memories_fts fts
      JOIN memories m ON m.id = fts.rowid
      WHERE memories_fts MATCH ?
      ${projectClause}
      ${privClause}
      ORDER BY rank
      LIMIT ?
    `);

    const phraseQuery = `"${query.replace(/"/g, '""')}"`;
    const params: unknown[] = [phraseQuery];
    if (project) params.push(project);
    params.push(clampedLimit);

    let rows = buildStmt(phraseQuery).all(...params) as McpMemoryHit[];

    // Fallback: when phrase-search returns 0, try a bare token search
    if (rows.length === 0) {
      const tokenQuery = query
        .replace(/[^\p{L}\p{N}\s@-]/gu, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .join(' OR ');
      if (tokenQuery) {
        const fbParams: unknown[] = [tokenQuery];
        if (project) fbParams.push(project);
        fbParams.push(clampedLimit);
        rows = buildStmt(tokenQuery).all(...fbParams) as McpMemoryHit[];
      }
    }

    // Truncate long content to 500 chars per V2.4-5 spec
    return rows.map(r => ({
      ...r,
      content: r.content.length > 500 ? r.content.slice(0, 500) + '…' : r.content,
    }));
  } catch (err) {
    console.error('[NexusMemory/MCP] searchMemoryReadOnly error:', err);
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
