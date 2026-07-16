/**
 * INV-01 Auto-Resume — replay orphaned inputs after a reboot / deploy-restart.
 *
 * `claimResumableOrphans()` (input-log.ts) selects recent, public, replayable
 * TEXT rows on boot and durably increments their resume_attempts. This module
 * replays each through the REAL agent path so the user's interrupted task is
 * FINISHED instead of dropped with "please send again" — the core of the user's
 * #1 pain ("der Bot muss den unterbrochenen Task selbst wieder aufgreifen —
 * sonst ist es immer ein Break").
 *
 * Design (Tier-2 FINAL, Codex Pattern-A 0.82 GO-WITH-CHANGES):
 *  - Replay goes through `queueRequest` (correction #1), NOT a bare sendToAgent,
 *    so it serializes against any live user resend and inherits the per-session
 *    turn-epoch ownership guard.
 *  - NO telegramCtx is passed: the live grammY context is gone, and withholding
 *    it also disables the non-idempotent file/message-push MCP tools (§4). The
 *    user still gets the answer via bot.api.sendMessage.
 *  - currentInputLogRowId is set so buildContextAvailabilityPrompt does not
 *    mistake the replayed input for prior context (Codex blindspot).
 *  - markDone is stamped ONLY after the user reply was actually sent (Codex
 *    blindspot); an agent error / send failure becomes markError + a re-send
 *    notice. Crash-loop is bounded by resume_attempts (already incremented in
 *    the claim transaction).
 *  - Called fire-and-forget from index.ts AFTER the runner starts polling, so
 *    boot latency never blocks responsiveness.
 *
 * Private / media / side-effect / exhausted rows are NOT in result.resumable
 * (filtered out by claimResumableOrphans) — they surface via result.recentOrphans
 * and the existing boot re-send notice in index.ts.
 */
import type { Bot } from 'grammy';
import { type ClaimResult } from './input-log.js';
/** Prepended to a successful replayed answer so the user knows it is a resume. */
export declare function buildResumePreface(rawContent: string): string;
/** Shown when a row could not be replayed to completion → ask the user to resend. */
export declare function buildResendNotice(rawContent: string): string;
/**
 * Replay all claimed resumable orphans in received-order. Per-session ordering
 * is preserved by awaiting each replay sequentially; the per-session request
 * queue additionally serializes against any live resend. Best-effort — never
 * throws (each row's failure is contained).
 */
export declare function runAutoResume(bot: Bot, result: ClaimResult): Promise<void>;
//# sourceMappingURL=auto-resume.d.ts.map