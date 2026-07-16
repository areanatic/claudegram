/**
 * P0 Seamless-Input — Live Auto-Dispatch (2026-06-02).
 *
 * North-Star: every input must be UNDERSTOOD → EXECUTED → seamlessly continued,
 * never merely "stored". When a stored input was NOT executed at runtime (today's
 * concrete case: a voice note that hit VOICE_AGENT_HARD_CAP_MS and was dropped
 * with "please re-send"), this re-dispatches its raw_content through the REAL
 * agent on a FRESH session and delivers the answer proactively in the same chat.
 *
 * Reuses the proven auto-resume.replayOne pattern (queueRequest + sendToAgent,
 * NO live grammY ctx → push/file tools stay disabled, answer via api.sendMessage).
 * It does NOT introduce a new queue/framework — the existing per-session queue
 * serializes it against any live user resend.
 *
 * Safety (verified against live code + Codex Pattern-B review 2026-06-02):
 *  - Flag-gated INPUT_AUTODISPATCH_ENABLED (default OFF) → byte-identical old behavior.
 *  - Decision D: a row whose turn already started a MUTATING tool
 *    (side_effect_tool_started_at set) is NOT blind-replayed. CALLER MUST await the
 *    hard-cancel/SDK drain BEFORE calling this (so a late-starting tool of the
 *    original turn is reflected in the guard re-read here) — closes P1-1 race.
 *  - Loop bound: INPUT_AUTODISPATCH_MAX_ATTEMPTS (clamped [1,5] in config) + the
 *    shared resume_attempts counter — a re-dispatch that times out AGAIN can't loop.
 *  - hasNewerDuplicate(): identical input already re-sent → defer (no double-reply).
 *  - hasLaterOpenVoiceRow(): a later UNtranscribed voice (raw_content NULL) resend
 *    can't be caught by content-dedup → defer to the newer turn (P1-3).
 *  - forgetChatSession + forceFreshSession: escape the torn/over-full SDK session.
 *
 * Returns a tri-state so the caller knows whether to still send its fallback notice:
 *  - 'answered'  → re-dispatch ran and a reply was delivered (caller stays silent).
 *  - 'handled'   → intentionally skipped with the audit already set (dedup / resend);
 *                  caller stays silent (NO "please re-send" — that was P1-2).
 *  - 'fallback'  → not attempted / declined / failed; caller sends its honest notice.
 *
 * See design_p0_seamless_input_autodispatch_2026-06-02.md (Claude+Codex+Gemini reconciled).
 */
import type { Api } from 'grammy';
export type AutoDispatchOutcome = 'answered' | 'handled' | 'fallback';
export interface AutoDispatchArgs {
    /** ctx.api — deliver via api.sendMessage (no live grammY ctx is passed to the agent). */
    api: Api;
    chatId: number;
    sessionKey: string;
    rowId: number | null;
    /** The stored content to execute (e.g. the voice transcript). */
    rawContent: string;
    inputType: string;
    /** Why we are recovering (e.g. 'voice_hard_timeout') — recorded in the audit trail. */
    reason: string;
    /**
     * Optional ack/placeholder message to REUSE as the working-status → answer surface
     * (RF-2 + RF-4): shows an honest "⏳ working…" then becomes the result, so no stale
     * "🎤 Transcribing…" bubble is left behind and no extra clutter is added. Omit on
     * the boot path (no live ack) → falls back to api.sendMessage.
     */
    statusMessageId?: number;
}
/**
 * Attempt to re-dispatch a stored-but-unexecuted input through the agent and
 * deliver the answer. See the tri-state return contract in the module docstring.
 * Never throws. IMPORTANT: the caller must have awaited the original turn's
 * hard-cancel/SDK drain before calling, so the side-effect guard re-read is fresh.
 */
export declare function tryAutoDispatch(args: AutoDispatchArgs): Promise<AutoDispatchOutcome>;
//# sourceMappingURL=input-auto-dispatch.d.ts.map