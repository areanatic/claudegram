/**
 * Durable Input-Log — Schlachtplan Akt 1.2 (2026-05-21).
 *
 * Every Telegram input (text / voice / photo / document / audio) is written to
 * SQLite the moment it arrives — BEFORE transcription, BEFORE the agent call,
 * BEFORE per-chat serialization. This is the single hard invariant against
 * RI-19 (Input-Loss): if a watchdog timeout or crash kills the in-flight turn,
 * the input row survives on disk and can be inspected later.
 *
 * Flow:
 *   Telegram update -> input_log INSERT (status='received') -> ACK reaction
 *     -> sequentialize -> handler -> markProcessing -> markDone / markDropped
 *
 * Design notes:
 *  - Own DB file (`<DATA_DIR>/input-log.db`) — intentionally isolated from
 *    `.nexus-memory/memory.db` so a forensic log can never corrupt the memory
 *    store and vice versa.
 *  - Fail-safe: every function swallows DB errors and logs. The input-log must
 *    never be able to crash a message handler — it is a safety net, not a
 *    feature gate.
 *  - No new subsystem: ~120 LOC, one table, no cron, no command (Akt 1 scope).
 *
 * Cross-Refs:
 *  - shared-memory/nexus/bug_report_lost_inputs_2026-05-21.md (RC-1/2/3 spec)
 *  - shared-memory/nexus/postmortem_mai_intervention_2026-05-21.md (Akt 1.2)
 */
export type InputType = 'text' | 'voice' | 'audio' | 'photo' | 'document' | 'other';
export type InputStatus = 'received' | 'processing' | 'done' | 'dropped' | 'error';
export interface RecordInputOptions {
    messageId: number | undefined;
    chatId: number;
    sessionKey: string;
    inputType: InputType;
    /** Text content if known at receive-time (text messages). Voice transcript is filled later. */
    rawContent?: string | null;
    /** Telegram file_id for media inputs. */
    fileId?: string | null;
    /**
     * FIX 6+ Stage 2c: explicit privacy classification. When omitted, the
     * writer consults the per-session privacy-state cache (`isPrivate(sessionKey)`)
     * and falls back to 'public'. Callers that have an authoritative answer
     * (e.g. `/brief` — always public; future `/private-once` — explicitly
     * private) should set this field instead of relying on session state.
     */
    privacy?: 'public' | 'private';
}
/**
 * INSERT a freshly received input. Called as the very first action in the
 * input-log middleware, before any handler runs. Returns the row id (for later
 * status updates) or null if logging is unavailable.
 *
 * Codex BLOCKER 2: idempotent. A Telegram retry of the same (chat_id,
 * message_id) does NOT create a duplicate row — `ON CONFLICT DO NOTHING` keeps
 * the original, and the existing row id is looked up and returned.
 */
export declare function recordInput(opts: RecordInputOptions): number | null;
/** Transition a row to status='processing'. Best-effort.
 *  RI-23 (2026-06-06): clear any prior dropped_reason. The catch-all finalizeIfOpen can race
 *  ahead of a slow handler (e.g. document's setTimeout confirmation) and stamp
 *  'handler_no_finalize'; once the handler actually starts processing, that stale reason must go. */
export declare function markProcessing(rowId: number | null): void;
/** Transition a row to status='done' and stamp response_sent_at. Best-effort.
 *  RI-23 (2026-06-06): also clear dropped_reason — a successful turn must not keep a stale
 *  'handler_no_finalize' that finalizeIfOpen may have set in a race (Codex M-11 Q4). */
export declare function markDone(rowId: number | null): void;
/**
 * Tier-1 (RI-23): a successful NON-agent outcome (e.g. transcribe-only). status
 * stays 'done' (it WAS handled — not pending, not unanswered) with response_sent_at
 * set, and dropped_reason carries the handled-kind for audit. Crucially NOT
 * status='dropped' — buildContextAvailabilityPrompt warns only on 'dropped' rows,
 * and this is a successful outcome, not a loss.
 */
export declare function markHandledNoAgent(rowId: number | null, reason: string): void;
/**
 * Transition a row to status='dropped' with a reason (e.g. 'watchdog_cancel',
 * 'queue_cleared', 'error'). Best-effort.
 */
export declare function markDropped(rowId: number | null, reason: string): void;
/** Transition a row to status='error'. Best-effort. */
export declare function markError(rowId: number | null, reason: string): void;
/**
 * P0 Seamless-Input (2026-06-02): finalize a row that live auto-dispatch RECOVERED
 * (e.g. a voice_hard_timeout we re-ran on a fresh turn and answered). status='done'
 * + response_sent_at set + dropped_reason rewritten to 'auto_continued_from_<reason>'
 * so the audit trail shows recovery, not a silent 'done' and not a final 'dropped'.
 * The old failure reason is intentionally replaced — the input WAS executed.
 */
export declare function markDoneRecovered(rowId: number | null, reason: string): void;
/**
 * P0 Seamless-Input: execution state needed by live auto-dispatch —
 * `sideEffectStarted` (Decision D: never blind-replay a turn that already started
 * a mutating tool), `resumeAttempts` (loop bound), `receivedAt` (dedup window).
 */
export declare function getRowExecutionState(rowId: number | null): {
    sideEffectStarted: boolean;
    resumeAttempts: number;
    receivedAt: string;
} | null;
/**
 * P0 Seamless-Input (Codex P1-3 guard): true if a STRICTLY-LATER voice row for
 * this session is still open ('received'/'processing'). A manually re-sent voice
 * note is inserted with raw_content=NULL and only filled after Whisper, so the
 * content-based hasNewerDuplicate() can't catch it during the timeout/auto-dispatch
 * window. Live auto-dispatch uses this to DEFER to the newer turn and avoid a
 * double answer (old voice auto-answered + new voice answered).
 */
export declare function hasLaterOpenVoiceRow(sessionKey: string, excludeRowId: number, receivedAt: string): boolean;
/** P0 Seamless-Input: bump resume_attempts for a LIVE auto-dispatch (loop bound). */
export declare function incrementResumeAttempt(rowId: number | null): void;
/**
 * INV-01 Auto-Resume (Codex correction #2): record that a MUTATING tool
 * (Bash / Write / Edit / MultiEdit / Task — anything not clearly read-only) has
 * STARTED for this turn. Called from the PreToolUse hook BEFORE the tool runs.
 *
 * A row with `side_effect_tool_started_at` set is excluded from auto-replay on
 * the next boot, because the turn may have already performed a non-idempotent
 * external write (git push, file overwrite, subagent spawn) that a blind replay
 * would duplicate. The FIRST mutating tool stamps the timestamp (COALESCE keeps
 * it stable); later tools only append their name to the audit list (deduped,
 * length-capped). Best-effort — must never crash a tool invocation.
 */
export declare function markSideEffectStarted(rowId: number | null, toolName: string): void;
/** Fill in / overwrite the raw_content (used to attach the voice transcript). */
export declare function attachContent(rowId: number | null, content: string): void;
/**
 * Codex BLOCKER 2: catch-all finalizer. Marks a row as 'done' ONLY if it is
 * still open ('received' or 'processing'). Called by the input-log middleware
 * after the whole handler chain returns — so non-agent inputs (audio / photo /
 * document) and early-return text/voice paths, which the agent handlers never
 * explicitly finalize, do not leave permanently-'received' rows that would
 * make `/health` pending count drift upward forever.
 *
 * Agent paths that already called markDone/markDropped/markError are no-ops
 * here (status is no longer open). Idempotent.
 *
 * Tier-1 (Codex Pattern-A 2026-05-31): catch-all completions are stamped with
 * dropped_reason='handler_no_finalize' so that status='done' alone no longer
 * means "an agent answered". A real agent reply (markDone) leaves dropped_reason
 * NULL + response_sent_at set; a catch-all finalize (early return, RI-23
 * transcribe hijack, non-agent media) is now distinguishable for audit
 * (countHandlerNoFinalize). COALESCE keeps any pre-set reason intact.
 */
export declare function finalizeIfOpen(rowId: number | null): void;
/**
 * Count rows completed by the catch-all finalizer rather than by an agent
 * (status='done' + dropped_reason='handler_no_finalize'). A rising count means
 * handlers return without answering — e.g. the RI-23 voice hijack or an early
 * return that should have produced a reply. Audit signal (Tier-1, /health).
 */
export declare function countHandlerNoFinalize(): number;
/** Count rows still in 'received' or 'processing' — used by /health. */
export declare function countPending(): number;
/** A recent orphaned input surfaced by boot-recovery for user notification. */
export interface OrphanInput {
    chatId: number;
    /** Full session key (`${chatId}:${threadId}` in forum topics) so the boot
     *  re-send notice can land in the originating thread via parseSessionKey. */
    sessionKey: string;
    inputType: string;
    rawContent: string | null;
    receivedAt: string;
    /** So the boot re-send notice can REDACT the snippet of a private row instead
     *  of echoing its content (defensive for group chats). */
    privacy: 'public' | 'private';
}
/**
 * Boot-recovery result: how many rows were dropped, plus the recent subset
 * (arrived <= RECENT_ORPHAN_WINDOW_MS before startup) worth notifying the user
 * about. Old drift is still dropped, just not surfaced.
 */
export interface RecoveryResult {
    recovered: number;
    recentOrphans: OrphanInput[];
}
/**
 * Boot-recovery (Akt 1c): on startup every row still 'received'/'processing'
 * is necessarily orphaned — the only processor is this bot, which just started
 * fresh with no in-memory handler for those rows. Mark them 'dropped' with
 * reason 'startup_recovery' so they are visible and the /health pending count
 * does not drift upward forever. MUST run before the runner starts polling, so
 * freshly-arriving inputs are never affected.
 *
 * FIX 4 (2026-05-22): also returns the RECENT orphans so the caller can tell
 * the affected user their in-flight message was lost to the crash/restart.
 *
 * @deprecated INV-01 (2026-06-01): superseded by `claimResumableOrphans()`,
 * which CLAIMS+replays recoverable orphans instead of blanket-dropping them.
 * The boot path (index.ts) no longer calls this. Do NOT re-import it — that
 * would reinstate the drop-only behaviour that lost the user's in-flight task.
 * Kept only as a short-term rollback anchor; remove in a post-canary cleanup.
 */
export declare function recoverOrphanedInputs(): RecoveryResult;
/**
 * A recent orphaned TEXT input eligible to be REPLAYED through the real agent
 * path on boot (instead of dropped + "please re-send"). Selection AND the
 * resume_attempts increment happen atomically in `claimResumableOrphans()`;
 * `runAutoResume()` (src/inbox/auto-resume.ts) then replays each row via the
 * per-session request queue.
 */
export interface ResumableOrphan {
    id: number;
    chatId: number;
    sessionKey: string;
    rawContent: string;
    privacy: 'public' | 'private';
    receivedAt: string;
    resumeAttempts: number;
}
/**
 * Result of `claimResumableOrphans()`:
 *  - resumable     — public text rows CLAIMED for replay (status set to
 *                    'processing', resume_attempts incremented). `runAutoResume`
 *                    must process exactly these.
 *  - recentOrphans — recent rows that were NOT replayable (private / media /
 *                    side-effect-already-started / attempts-exhausted / beyond
 *                    the per-boot cap). Surfaced to the user as a "please
 *                    re-send" notice, same shape as the legacy boot-recovery.
 *  - recovered     — total rows marked dropped (recent non-replayable + old
 *                    drift), for log parity with `recoverOrphanedInputs`.
 */
export interface ClaimResult {
    resumable: ResumableOrphan[];
    recentOrphans: OrphanInput[];
    recovered: number;
}
/**
 * Clamp an integer env override to [min,max] with a default for unset/0/NaN.
 * Shared by both replay guards so the clamp invariant is proven once (tested via
 * clampBootCap + clampInt cases). 0 is treated as unset (→ default), negatives
 * and overshoots are clamped into range.
 */
export declare function clampInt(raw: string | undefined, def: number, min: number, max: number): number;
export declare function clampBootCap(raw: string | undefined): number;
/**
 * Boot-recovery + Auto-Resume (INV-01). Replaces the blanket-drop boot path:
 * recent, public, replayable TEXT orphans are CLAIMED (status→'processing',
 * resume_attempts+1) so the real agent can re-process them; everything else
 * still open is dropped exactly like `recoverOrphanedInputs`, with the recent
 * non-replayable subset surfaced for a "please re-send" notice.
 *
 * The claim + increment run in ONE transaction so the higher attempt counter is
 * durably on disk BEFORE any replay starts — an immediate re-crash therefore
 * still sees it and the crash-loop terminates at MAX_RESUME_ATTEMPTS.
 *
 * MUST run before the runner starts polling (like recoverOrphanedInputs), so a
 * freshly-arriving input is never mistaken for an orphan.
 */
export declare function claimResumableOrphans(): ClaimResult;
/**
 * INV-01 Auto-Resume (Codex Pattern-B P1-2): true if a NEWER row with the SAME
 * raw_content already exists for this session — i.e. the user re-sent the
 * identical message after the restart. Used by runAutoResume to skip the replay
 * of an orphan whose answer is already owed to a fresh live turn, preventing a
 * double-answer. Deliberately matches on EXACT content + a strictly-later
 * received_at, so it only dedupes genuine duplicates and never suppresses a
 * different (still-unanswered) input. Best-effort; on error returns false
 * (favours answering over silently dropping).
 */
export declare function hasNewerDuplicate(sessionKey: string, rawContent: string, excludeRowId: number, afterReceivedAt: string): boolean;
/** Close the DB on shutdown. Idempotent. */
export declare function closeInputLog(): void;
/** A row returned by searchInputLog / getLatestInputLog — UI-shaped. */
export interface InputLogSearchResult {
    id: number;
    received_at: string;
    session_key: string;
    chat_id: number | null;
    input_type: string;
    status: string;
    dropped_reason: string | null;
    raw_content_snippet: string;
}
/**
 * Search input_log via FTS5.
 *
 * Privacy contract (FIX 6+ Stage 2b — Codex Pattern-B F-02):
 *  - The previous implementation treated `sessionKey` and `privacy` as an
 *    XOR scope: providing `sessionKey` REPLACED the privacy filter entirely,
 *    so a public-mode MCP search inside an otherwise-private session would
 *    surface that session's `privacy='private'` rows. Codex' privacy-killer
 *    test relied on this and failed-OPEN.
 *  - New contract:
 *      (a) `privacy='public'` is enforced by default ALWAYS, even when a
 *          sessionKey is provided.
 *      (b) A caller MAY opt into private rows by passing
 *          `includePrivate: true` AND a sessionKey — and then only rows of
 *          *that* session are returned regardless of privacy. Public-mode
 *          callers (in particular the MCP tool `nexusgram_input_log_search`)
 *          MUST NOT set `includePrivate=true`.
 *      (c) Without a sessionKey only `privacy='public'` rows are visible —
 *          unchanged from before, kept as fail-CLOSED default.
 *
 * Phrase-match first, falls back to OR-of-tokens when the phrase has 0 hits.
 */
export declare function searchInputLog(opts: {
    query: string;
    sessionKey?: string;
    since?: string;
    limit?: number;
    /**
     * Stage 2b F-02 opt-in: include rows with `privacy='private'`. Only
     * honoured when `sessionKey` is also set — global private-scan is never
     * allowed. Default false. The MCP-exposed tool must leave this unset.
     */
    includePrivate?: boolean;
}): InputLogSearchResult[];
/**
 * Return the N most recent input_log rows for a session (independent of FTS).
 * Used by the Context Availability Prompt-Block to render "last user input"
 * freshness without a query string.
 *
 * FIX 6+ Stage 2b (Codex Pattern-B F-03): the input-log middleware writes the
 * current user message into `input_log` BEFORE `sendToAgent()` runs. Without
 * an exclusion the Context Availability snapshot saw exactly the row of the
 * just-arrived prompt as "prior context", and the "EMPTY → ask for briefing"
 * branch could never fire. `excludeRowId` lets the prompt-builder ask
 * specifically for *prior* turns — the current turn's input_log row id is
 * threaded down from the message handler through AgentOptions.
 */
export declare function getLatestInputLog(sessionKey: string, limit?: number, opts?: {
    excludeRowId?: number | null;
}): InputLogSearchResult[];
/**
 * FIX 6+ Stage 2b (Codex Pattern-B F-04): force eager initialization of the
 * input-log DB at process boot. The lazy `getDb()` defers migration and FTS
 * rebuild until the first caller — and the first caller in the live system
 * turned out to be `getLatestInputLog()` inside `buildContextAvailabilityPrompt`,
 * i.e. the prompt-build path. That meant DB migration could run during a
 * user turn while a parallel session (Family-Bot, Master-Bot worker, /health
 * call) was already holding a connection, which is a lock-risk surface.
 *
 * Calling `ensureInputLogInitialized()` from `index.ts:main()` BEFORE the
 * Grammy runner starts polling guarantees the migration completes once,
 * deterministically, with no concurrent user-input pressure. Idempotent: a
 * second call is a no-op once initialization has completed (or failed and
 * been marked).
 */
export declare function ensureInputLogInitialized(): void;
//# sourceMappingURL=input-log.d.ts.map