import Database from 'better-sqlite3';
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
export declare const DEFAULT_TRUSTED_PRIVATE_SOURCES: readonly string[];
/** Derive a retrieval policy from process env. Never throws.
 *  - NEXUS_MEMORY_SCOPE: 'public' | 'self_private' | 'operator_all' (default: public)
 *  - NEXUS_TRUSTED_PRIVATE_SOURCES: CSV (default: DEFAULT_TRUSTED_PRIVATE_SOURCES) */
export declare function readMemoryPolicyFromEnv(env?: NodeJS.ProcessEnv): MemoryRetrievalPolicy;
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
export declare function buildPrivacyClause(conn: Database.Database, policy: MemoryRetrievalPolicy, alias?: string): PrivacyClauseBuild;
/** Cross-Bot T2 (a): per-bot origin slug. Read from BOT_NAME env DIRECTLY (not via the
 *  config module) so this file stays import-light and usable in deterministic tests that
 *  don't set the full bot env. Mirrors src/inbox/capture-router.ts botId() exactly. */
export declare function botId(): string;
/**
 * FTS5 search — finds ALL memories (including archived) sorted by relevance.
 * Privacy filter: by default only 'public' rows are returned. Callers in
 * active private-mode sessions must pass includePrivate=true explicitly.
 */
export declare function searchMemory(query: string, limit?: number, project?: string, includePrivate?: boolean): MemoryRow[];
/**
 * Get recent active (non-archived) memories sorted by last_accessed.
 * Privacy filter: by default only 'public' rows are returned.
 */
export declare function recentMemories(limit?: number, project?: string, includePrivate?: boolean): MemoryRow[];
/**
 * Save a new memory (episodic by default for bot-generated memories).
 *
 * `privacy` defaults to 'public'. When the calling session is in private mode,
 * pass 'private' so the row is excluded from default retrieval and from the
 * wiki synthesizer. Silently degrades to the pre-migration insert shape if
 * the `privacy` column does not exist.
 */
export declare function saveMemory(content: string, type?: 'semantic' | 'episodic', project?: string, tags?: string, source?: string, privacy?: 'public' | 'private', bot?: string | null): number | null;
/**
 * Build a context injection block for the system prompt.
 * Combines FTS5 matches (if query given) + recent memories.
 * Budget: ~800 chars to keep prompt lean.
 *
 * `includePrivate` MUST only be true when the current session is in private
 * mode. Default is false so accidental callers never leak private memories.
 */
export declare function injectContext(query?: string, project?: string, includePrivate?: boolean): string;
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
export declare function searchMemoryReadOnly(query: string, limit?: number, project?: string, options?: MemorySearchOptions): McpMemoryHit[];
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
export declare function recentMemoriesReadOnly(limit?: number, project?: string, options?: MemorySearchOptions): (McpMemoryHit & {
    created_at: string;
})[];
export type TaskStatus = 'open' | 'completed' | 'all';
export interface TaskSearchOptions {
    status?: TaskStatus;
    from?: string;
    to?: string;
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
export declare function searchTasks(opts?: TaskSearchOptions): TaskHit[];
/** Canonical whitelist of source_kind values an entity-search caller may pass.
 *  Hardcoded to prevent SQL-table-name injection (Codex P0-3 caveat). */
declare const ALLOWED_SOURCE_KINDS: readonly ["omi_memories", "omi_transcription_segments", "memory_db_memories"];
type SourceKind = typeof ALLOWED_SOURCE_KINDS[number];
export interface PersonResolution {
    /** Canonical persons row matched (or first of ambiguous set). */
    personId: string | null;
    canonicalName: string | null;
    status: 'active' | 'merged' | 'ignored' | null;
    /** When >1 alias/canonical matches, list candidates so caller can disambiguate. */
    ambiguous: Array<{
        person_id: string;
        canonical_name: string;
        mention_count: number;
    }>;
    /** When 0 matches, suggest prefix/contains hits from aliases + unresolved canonical_text. */
    suggestions: Array<{
        label: string;
        mention_count: number;
        source: 'alias' | 'unresolved';
    }>;
}
/** Resolve a person-name to a persons row, strict-first then suggest. Codex P1-1. */
export declare function resolvePerson(query: string): PersonResolution;
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
/** Phase 7.5 P0-3: ATTACH omi_bridge.db read-only and UNION over the three
 *  source-kinds. Privacy gate is enforced HERE (P0-4): only operator scope
 *  may read these rows; non-operators get an empty result with scope_denied=true. */
export declare function searchPersonTimeline(opts: PersonTimelineOptions): PersonTimelineResult;
export interface EntitySearchHit {
    source_kind: SourceKind;
    source_id: string;
    source_created_at_utc: string | null;
    entity_kind: 'person' | 'organization' | 'place';
    canonical_text: string;
    resolved_canonical_name: string | null;
    resolved_person_id: string | null;
    match_method: string | null;
    snippet: string;
}
export interface EntitySearchOptions {
    query?: string;
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
    top_entities_in_window: Array<{
        canonical_text: string;
        resolved_person_id: string | null;
        resolved_canonical_name: string | null;
        entity_kind: string;
        mention_count: number;
    }>;
}
export declare function searchEntities(opts?: EntitySearchOptions): EntitySearchResult;
export declare function closeMemoryDb(): void;
export {};
//# sourceMappingURL=nexus-memory.d.ts.map