import { type ContextPressure } from './context-pressure.js';
import type { Context } from 'grammy';
export interface AgentUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalCostUsd: number;
    contextWindow: number;
    numTurns: number;
    model: string;
    /** TRUE per-step max window occupancy (input+cache_read+cache_creation+output),
     *  captured live from assistant messages. NON-cumulative — the metric the Bug-A
     *  rotation guard + footer + /status read via occupancyTokens(). 0 = not captured
     *  (callers fall back to the cumulative counters). Tier-1 / Codex Pattern-A. */
    windowTokens: number;
}
interface AgentResponse {
    text: string;
    toolsUsed: string[];
    buttons?: string[];
    usage?: AgentUsage;
    compaction?: {
        trigger: 'manual' | 'auto';
        preTokens: number;
    };
    sessionInit?: {
        model: string;
        sessionId: string;
    };
    /** RF-6 Latenz-Marker (Wave 1 / Stream 1): wall-clock-Dauer dieses Agent-Turns
     *  in ms, vom post-agent-Hook für die "⏱"-Bubble genutzt. Gemessen ab
     *  Queue-Dequeue / Timer-Start (inkl. Prompt-/Memory-Kontextbau), aber OHNE
     *  Queue-Wartezeit, Telegram-Send, TTS und Follow-up-Buttons (Codex P2-3 —
     *  also NICHT exakt "query()-Start"). Optional → bestehende Returns ohne
     *  durationMs bleiben gültig und zeigen keinen Marker. */
    durationMs?: number;
}
/**
 * Stage 2c (Mai-Intervention 2026-05-12): Canonical text the agent returns when
 * it observes `isCancelled(sessionKey) === true` mid-stream. Exported so the
 * Telegram-side streaming handler can detect "agent finished cleanly because
 * /cancel won upstream" and route through the cancel-UI branch instead of
 * `finishStreaming`, preventing the doppel-message pattern observed live on
 * 2026-05-12 22:44 (one "🛑 Cancelled." from handleCancel + one
 * "✅ Successfully cancelled..." edit on the streaming bubble).
 *
 * Single source of truth: any code emitting this sentinel MUST import this
 * constant — do not duplicate the literal string elsewhere.
 *
 * Cross-Refs:
 *  - shared-memory/nexus/phase_c_stage2c_minihotfix_report_2026-05-12.md
 *  - src/bot/handlers/message.handler.ts (consumer)
 */
export declare const CLAUDE_CANCEL_SENTINEL_TEXT = "\u2705 Successfully cancelled - no tools or agents in process.";
/**
 * Schlachtplan Akt 1.3 (Codex round 7): thrown by `sendToAgent` at its very
 * start when the turn epoch is stale — i.e. a newer turn for the same session
 * has already been dequeued. A failsafe-released old handler that wakes up and
 * reaches `sendToAgent` is stopped HERE, before it can run `updateActivity`,
 * `recordTranscript`, `query()` or `setActiveQuery`. Handlers swallow this
 * error silently: the stale turn's queue promise was already rejected and the
 * newer turn owns the user-facing reply.
 */
export declare class StaleTurnError extends Error {
    readonly sessionKey: string;
    readonly turnEpoch: number;
    readonly name = "StaleTurnError";
    constructor(sessionKey: string, turnEpoch: number);
}
/**
 * D0 Hardening Item 1 (2026-05-27): throw `StaleTurnError` if `turnEpoch` is no
 * longer the current turn for this session. Use as the FIRST statement in every
 * `queueRequest` handler, BEFORE any side-effect (streaming UI, registry
 * insert, abort-controller setter). Closes the dequeue→createRequestContext
 * race window (5-50ms in production).
 *
 * Outer handlers in the bot/handlers/* layer already catch `StaleTurnError`
 * and mark the input-log row as `dropped/superseded`. See Codex Pattern-A
 * Pre-Review confidence 0.74:
 *   shared-memory/nexus/cross_review_d0-fix-now-prereview_2026-05-27.md
 */
export declare function assertTurnIsCurrent(sessionKey: string, turnEpoch: number): void;
interface AgentOptions {
    onProgress?: (text: string) => void;
    onToolStart?: (toolName: string, input?: Record<string, unknown>) => void;
    onToolEnd?: () => void;
    abortController?: AbortController;
    command?: string;
    model?: string;
    telegramCtx?: Context;
    /** When true, appends voice-mode instructions for conversational TTS-friendly responses */
    voiceMode?: boolean;
    /**
     * Internal self-heal guard (2026-06-02). Set true when `sendToAgent`
     * re-invokes itself after a context-window overflow that the SDK surfaced as
     * a `success` result with text "Prompt is too long" (NOT a thrown error).
     * Prevents an infinite retry loop if the fresh session is still too large.
     */
    _overflowRetry?: boolean;
    /**
     * Codex BLOCKER (Akt 1.3 round 6): the turn epoch assigned by `processQueue`
     * at dequeue. Passed explicitly from the queue handler so ownership is bound
     * to the dequeue moment. When omitted (non-queued call), ownership checks
     * default to "still owner".
     */
    turnEpoch?: number;
    /**
     * FIX 6+ Stage 2b (Codex Pattern-B F-03): id of the durable input_log row
     * for THIS user turn. The input-log middleware writes the row before
     * sequentialize, so by the time we reach `sendToAgent` it already exists.
     * Used by `buildContextAvailabilityPrompt` to EXCLUDE the current message
     * from the "prior context" snapshot — otherwise the snapshot always sees
     * at least one row and the "EMPTY → ask for briefing" branch can never
     * fire. Optional: callers that don't have a row id (test paths,
     * follow-up-button dispatches) pass undefined and the snapshot falls back
     * to the old behaviour.
     */
    currentInputLogRowId?: number | null;
}
interface LoopOptions extends AgentOptions {
    maxIterations?: number;
    onIterationComplete?: (iteration: number, response: string) => void;
}
export declare function getCachedUsage(sessionKey: string): AgentUsage | undefined;
export declare function sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse>;
export declare function sendLoopToAgent(sessionKey: string, message: string, options?: LoopOptions): Promise<AgentResponse>;
export declare function clearConversation(sessionKey: string): void;
/**
 * Stage 2 M-024 Cancel-HARD-Rollback (2026-05-28, Codex Iterate-Patch B):
 *
 * Drop the cached Claude-Code session id for this chat without touching
 * conversationHistory. Combined with `sessionManager.forceFreshSession`, this
 * guarantees the NEXT `sendToAgent` call cannot pass `resume:` and lands in a
 * brand-new Claude-Code transcript — required to escape a torn SDK session
 * after `/cancel`. Cheaper than `clearConversation` because the local user/
 * assistant history (used for PreCompact and memory) survives the reset.
 */
export declare function forgetChatSession(sessionKey: string): void;
/**
 * Bug-A (death-spiral) prevention — usage-based rotation AFTER a successful turn.
 *
 * Called from runPostAgentSuccess (the shared post-agent hook) right after the
 * usage footer on EVERY reply path (text/voice/photo/document/command-audio).
 * When the context window is filling up we rotate to a fresh Claude-Code
 * session for the NEXT turn (forgetChatSession drops the resume id;
 * forceFreshSession installs a clean in-memory session). No data loss: the old
 * JSONL stays on disk and the next turn rebuilds todayContext/daily/memory
 * fresh. This is the PRIMARY fix (Codex order b); isOversized 7 MB is the
 * boot-airbag (order c). See audit_nexusgram_bug_audit_2026-05-27-28.md.
 */
export declare function maybeRotateAfterContextPressure(sessionKey: string, usage: AgentUsage | undefined): ContextPressure;
/**
 * Stage 2 M-024 Cancel-HARD-Rollback (2026-05-28, Codex Iterate-Patch B):
 *
 * After /cancel, prune the cancelled user turn from the local conversation
 * history so the next prompt does not echo the dropped message back to Claude
 * when history is reconstructed for a brand-new session (post-`/cancel` resume).
 *
 * Rules:
 *  - history ends with role:user → pop it (the user message we just cancelled)
 *  - history ends with role:assistant === CLAUDE_CANCEL_SENTINEL_TEXT and the
 *    prior is role:user → pop both (sentinel + the user turn that produced it)
 *  - otherwise no-op (don't blast away older completed assistant answers)
 */
export declare function discardCancelledTurnState(sessionKey: string): void;
export declare function setModel(sessionKey: string, model: string): void;
export declare function getModel(sessionKey: string): string;
export declare function clearModel(sessionKey: string): void;
export declare function setQuiet(sessionKey: string, quiet: boolean): void;
export declare function isQuiet(sessionKey: string): boolean;
export declare function isDangerousMode(): boolean;
export {};
//# sourceMappingURL=agent.d.ts.map