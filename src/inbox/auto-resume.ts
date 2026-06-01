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
import { queueRequest } from '../claude/request-queue.js';
import { sendToAgent, StaleTurnError } from '../claude/agent.js';
import { splitMessage } from '../telegram/markdown.js';
import {
  hasNewerDuplicate,
  markDone,
  markDropped,
  markError,
  type ClaimResult,
  type ResumableOrphan,
} from './input-log.js';

const PREFACE_SNIPPET_MAX = 120; // allow-hardcoded: reason="UI snippet length for resume preface, not a timeout"

function snippet(rawContent: string): string {
  return rawContent.replace(/\s+/g, ' ').trim().slice(0, PREFACE_SNIPPET_MAX);
}

/** Prepended to a successful replayed answer so the user knows it is a resume. */
export function buildResumePreface(rawContent: string): string {
  return `↩️ Ich mache da weiter, wo wir unterbrochen wurden:\n„${snippet(rawContent)}"\n\n`;
}

/** Shown when a row could not be replayed to completion → ask the user to resend. */
export function buildResendNotice(rawContent: string): string {
  return (
    '⚠️ Ich konnte deine letzte Nachricht trotz Neustart nicht zu Ende bearbeiten — ' +
    'bitte nochmal senden:\n• ' + snippet(rawContent)
  );
}

/**
 * Send a (possibly long) PLAIN-text reply, chunked to Telegram's limit. Plain
 * text (no parse_mode) avoids MarkdownV2 parse failures on arbitrary agent
 * output — same robustness as the boot re-send notices.
 */
async function sendChunked(bot: Bot, chatId: number, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await bot.api.sendMessage(chatId, chunk);
  }
}

async function replayOne(bot: Bot, row: ResumableOrphan): Promise<void> {
  // Codex Pattern-B P1-2: if the user already re-sent the IDENTICAL message
  // after the restart, a fresh live turn already owes them that answer — skip
  // the replay to avoid a double-answer. Exact-content + strictly-later match,
  // so a different unanswered input is never suppressed.
  if (hasNewerDuplicate(row.sessionKey, row.rawContent, row.id, row.receivedAt)) {
    console.log(`[AutoResume] row ${row.id} superseded by an identical live re-send — skipping replay`);
    markDropped(row.id, 'auto_resume_deduped_newer');
    return;
  }
  try {
    const response = await queueRequest(row.sessionKey, row.rawContent, async (turnEpoch) =>
      sendToAgent(row.sessionKey, row.rawContent, {
        turnEpoch,
        currentInputLogRowId: row.id,
      }),
    );
    const answer = (response?.text ?? '').trim();
    if (!answer) {
      // Agent produced no text (e.g. a turn that only used the withheld
      // push-tools). Notice FIRST, then markError (Codex round-2 P2): a process
      // crash between must leave the row 'processing' (→ re-claimed/retried next
      // boot), never 'error' with the user never told.
      await sendChunked(bot, row.chatId, buildResendNotice(row.rawContent));
      markError(row.id, 'auto_resume_empty_response');
      return;
    }
    // Reply FIRST, then mark done — a send failure must never look "answered".
    await sendChunked(bot, row.chatId, buildResumePreface(row.rawContent) + answer);
    markDone(row.id);
  } catch (err) {
    if (err instanceof StaleTurnError) {
      // Edge case (Codex Pattern-B P1-2): a newer turn for this session advanced
      // the epoch WHILE this replay was suspended in the queue (not the normal
      // FIFO path — the queue serializes, so normally replay and a live resend
      // run sequentially). When it does happen, the newer turn owns the reply;
      // finalize this one without a re-send notice. The common "user re-sent the
      // same message" case is handled earlier by the hasNewerDuplicate dedup.
      console.log(`[AutoResume] row ${row.id} hit a stale-turn epoch advance — skipping replay`);
      markDropped(row.id, 'auto_resume_superseded');
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[AutoResume] replay failed for row ${row.id} (${row.sessionKey}):`, msg);
    // Notice FIRST (best-effort), then markError (Codex round-2 P2): a crash
    // between must leave the row 'processing' (re-claimed next boot), not a
    // silent 'error' the user never heard about.
    try {
      await sendChunked(bot, row.chatId, buildResendNotice(row.rawContent));
    } catch { /* best-effort */ }
    markError(row.id, `auto_resume_error:${msg.slice(0, 80)}`);
  }
}

/**
 * Replay all claimed resumable orphans in received-order. Per-session ordering
 * is preserved by awaiting each replay sequentially; the per-session request
 * queue additionally serializes against any live resend. Best-effort — never
 * throws (each row's failure is contained).
 */
export async function runAutoResume(bot: Bot, result: ClaimResult): Promise<void> {
  if (!result.resumable.length) return;
  console.log(`[AutoResume] replaying ${result.resumable.length} orphaned input(s) after restart`);
  for (const row of result.resumable) {
    await replayOne(bot, row);
  }
}
