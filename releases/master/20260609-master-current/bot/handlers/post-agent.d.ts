/**
 * Shared post-agent-success hook (Tier-1, Codex Pattern-A 2026-05-31).
 *
 * Every successful agent reply — text, voice, photo, document, command-audio —
 * must run the SAME after-reply work: the context-usage footer, the Bug-A
 * rotation guard, and the compaction / new-session notifications. Before Tier-1
 * these lived only in message.handler, so the Bug-A guard never fired on
 * voice/photo/document/command replies (it could fill the window and hit the
 * wall). This module is the single home for that work.
 *
 * STATIC GATE: nothing outside this module may call sendUsageFooter /
 * applyContextGuard directly — handlers call runPostAgentSuccess() instead.
 *
 * Each step is wrapped in its own try/catch (safeStep) so a failing footer can
 * never prevent the rotation guard from running, and a notification error can
 * never bubble into the reply path.
 */
import { Context } from 'grammy';
import { type AgentUsage } from '../../claude/agent.js';
export declare function fmtTokens(n: number): string;
export declare function getProgressBar(pct: number): string;
/** Minimal shape of an agent reply needed for the post-agent work. AgentResponse
 *  (agent.ts) is structurally assignable. */
export interface PostAgentResult {
    usage?: AgentUsage;
    compaction?: {
        trigger: 'manual' | 'auto';
        preTokens: number;
    };
    sessionInit?: {
        model: string;
        sessionId: string;
    };
    /** RF-6 Latenz-Marker: Agent-Turn-Dauer in ms (für die "⏱"-Bubble). */
    durationMs?: number;
}
/**
 * The single after-reply hook for ALL successful agent paths. Order: usage footer
 * → Bug-A rotation guard → compaction notice → new-session notice. Call AFTER the
 * user-facing reply (and follow-up buttons) so the footer is the trailing bubble.
 */
export declare function runPostAgentSuccess(ctx: Context, sessionKey: string, response: PostAgentResult | undefined): Promise<void>;
//# sourceMappingURL=post-agent.d.ts.map