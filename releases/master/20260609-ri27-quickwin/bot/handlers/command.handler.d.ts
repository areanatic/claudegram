import { Context } from 'grammy';
import { type ExtractMode, type SubtitleFormat } from '../../media/extract.js';
import { isPrivate } from '../../memory/privacy-state.js';
/** Build status lines appended to project confirmation messages. */
export declare function projectStatusSuffix(sessionKey: string): string;
/** The copyable command sent as a separate message. */
export declare function resumeCommandMessage(sessionId: string): string;
export declare function handleStart(ctx: Context): Promise<void>;
export declare function handleClear(ctx: Context): Promise<void>;
export declare function handleClearCallback(ctx: Context): Promise<void>;
export declare function handleProjectCallback(ctx: Context): Promise<void>;
export declare function handleProject(ctx: Context): Promise<void>;
export declare function handleNexusProject(ctx: Context): Promise<void>;
export declare function handleNewProject(ctx: Context): Promise<void>;
export declare function handleStatus(ctx: Context): Promise<void>;
export declare function getStreamingMode(): 'streaming' | 'wait';
export declare function handleMode(ctx: Context): Promise<void>;
/**
 * /quiet [on|off] — per-chat toggle for the "🐌 brauche länger" progress heartbeat.
 * User feedback 2026-06-05: the status fired "fast immer" and felt like noise / a half-truth
 * (esp. while merely waiting for an MCP permission). No arg = toggle. The agent keeps working
 * either way; this only mutes the non-finalizing nudge. Default (no /quiet) = updates ON.
 */
export declare function handleQuiet(ctx: Context): Promise<void>;
export declare function handleModeCallback(ctx: Context): Promise<void>;
export declare function handleTerminalUI(ctx: Context): Promise<void>;
export declare function handleTerminalUICallback(ctx: Context): Promise<void>;
export declare function handleTTS(ctx: Context): Promise<void>;
export declare function handleTTSCallback(ctx: Context): Promise<void>;
export declare function handleTelegraphCallback(ctx: Context): Promise<void>;
export declare function handlePing(ctx: Context): Promise<void>;
/**
 * FIX 6+ Step 5 (2026-05-25): /brief — explicit topic briefing entry-point.
 *
 * Problem this solves (Codex Pre-Review §5 + 2026-05-25 daily):
 *   - The input-log middleware SKIPS slash-commands (control vs durable input).
 *   - Voice notes can be dropped (voice_hard_timeout) before they reach the
 *     agent — the user thinks they briefed the bot, the bot saw nothing.
 *   - In a fresh session the agent has no honest signal whether context is
 *     thin or rich; it just guesses based on the message text.
 *
 * /brief <text> bypasses both gotchas:
 *   1. Calls recordInput() EXPLICITLY so the briefing lands in input_log
 *      and the FTS index immediately, prefixed [BRIEF] for quick filtering.
 *   2. Replies with a Context-Availability snapshot so the user (and any
 *      next agent turn) sees exactly what is and is not visible right now.
 *   3. Does NOT trigger an agent turn — the user follows up with a normal
 *      message and the agent picks up the briefing via input_log_search.
 */
export declare function handleBrief(ctx: Context): Promise<void>;
export declare function handleContext(ctx: Context): Promise<void>;
export declare function handleBotStatus(ctx: Context): Promise<void>;
export declare function handleRestartBot(ctx: Context): Promise<void>;
export declare function handleRestartCallback(ctx: Context): Promise<void>;
export declare function handleCancel(ctx: Context): Promise<void>;
export declare function handleReset(ctx: Context): Promise<void>;
export declare function handleResetCallback(ctx: Context): Promise<void>;
export declare function handleCommands(ctx: Context): Promise<void>;
export declare function handleModelCommand(ctx: Context): Promise<void>;
export declare function handleModelCallback(ctx: Context): Promise<void>;
export declare function handlePlan(ctx: Context): Promise<void>;
export declare function handleExplore(ctx: Context): Promise<void>;
export declare function handleResume(ctx: Context): Promise<void>;
export declare function handleResumeCallback(ctx: Context): Promise<void>;
export declare function handleContinue(ctx: Context): Promise<void>;
export declare function handleLoop(ctx: Context): Promise<void>;
export declare function handleSessions(ctx: Context): Promise<void>;
export declare function handleTeleport(ctx: Context): Promise<void>;
export declare function handleFile(ctx: Context): Promise<void>;
export declare function handleTelegraph(ctx: Context): Promise<void>;
/**
 * Execute native Reddit fetch, cache the result, and show an inline picker
 * so the user can choose File / Chat / Both.
 * Exported so message.handler.ts can reuse it for ForceReply flow.
 */
export declare function executeRedditFetch(ctx: Context, args: string): Promise<void>;
/**
 * Handle inline keyboard callbacks for Reddit action picker (File / Chat / Both).
 */
export declare function handleRedditActionCallback(ctx: Context): Promise<void>;
/**
 * Fetch a Medium article via Freedium and present inline action buttons.
 */
export declare function executeMediumFetch(ctx: Context, args: string): Promise<void>;
/**
 * Handle inline keyboard callbacks for Medium article actions.
 */
export declare function handleMediumCallback(ctx: Context): Promise<void>;
export declare function handleMedium(ctx: Context): Promise<void>;
export declare function handleReddit(ctx: Context): Promise<void>;
export declare function handleVReddit(ctx: Context): Promise<void>;
/**
 * Send a transcript as text (short) or .txt document (long).
 * Exported so voice.handler.ts can reuse it for the ForceReply path.
 */
export declare function sendTranscriptResult(ctx: Context, transcript: string): Promise<void>;
export declare function handleTranscribe(ctx: Context): Promise<void>;
/**
 * Handle audio messages (message:audio) sent as reply to the Transcribe ForceReply.
 */
export declare function handleTranscribeAudio(ctx: Context): Promise<void>;
/**
 * Handle document messages with audio MIME sent as reply to the Transcribe ForceReply.
 */
export declare function handleTranscribeDocument(ctx: Context): Promise<void>;
export declare function handleExtract(ctx: Context): Promise<void>;
export declare function showExtractMenu(ctx: Context, url: string): Promise<void>;
export declare function handleExtractCallback(ctx: Context): Promise<void>;
export declare function handleInbox(ctx: Context): Promise<void>;
export declare function handleInboxCallback(ctx: Context): Promise<void>;
export declare function handlePd(ctx: Context): Promise<void>;
export declare function handleWiki(ctx: Context): Promise<void>;
export declare function executeExtract(ctx: Context, url: string, mode: ExtractMode, subtitleFormat?: SubtitleFormat): Promise<void>;
/**
 * /with <person> — Phase 7.5 person-timeline slash alias.
 *
 * Wraps `searchPersonTimeline` (the same service function the MCP tool
 * `omi_person_timeline` uses) so the user gets deterministic, token-cheap
 * timeline lines without an LLM round-trip. Operator-only and /private-aware
 * (delegated to the helper).
 *
 * Codex pre-review: cross_review_phase-7-5-context-mcp-tools-architecture_2026-05-27.md
 */
export declare function handleWith(ctx: Context): Promise<void>;
/**
 * /private on | off | status — Privacy Mode Phase 1
 *
 * Per-chat (and per-forum-topic) toggle. When `on`:
 *   - new memories saved via this session are tagged privacy='private',
 *   - retrieval / memory-context skips private rows unless the session itself
 *     is currently private,
 *   - the conversation log is written to a *.private.log file that the
 *     nightly Ollama synthesizer does NOT consume,
 *   - the system prompt gets a neutralizing suffix that tells the model to
 *     avoid personal references.
 *
 * Concept doc: shared-memory/nexus/concept_privacy_mode_2026-04-19.md
 */
export declare function handlePrivate(ctx: Context): Promise<void>;
/**
 * /health — read-only compliance + observability dashboard.
 * Mai-Intervention Phase C.3 / Sprint 8.
 *
 * Aggregates state from process metrics, the per-session active queue,
 * the RequestContext registry, and the NEXUS memory FTS5 row count. Output
 * is constrained to <1500 chars MarkdownV2 so it fits a single Telegram bubble.
 *
 * Cross-Refs:
 *  - shared-memory/nexus/v25_phase_c_handoff_2026-05-12.md (C.3)
 *  - shared-memory/nexus/codex_phase_c_pre_review_2026-05-12.md §5
 */
export declare function handleHealth(ctx: Context): Promise<void>;
export { isPrivate };
//# sourceMappingURL=command.handler.d.ts.map