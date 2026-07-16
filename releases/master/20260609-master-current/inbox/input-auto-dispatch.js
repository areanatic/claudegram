import { config } from '../config.js';
import { queueRequest } from '../claude/request-queue.js';
import { sendToAgent, forgetChatSession } from '../claude/agent.js';
import { sessionManager } from '../claude/session-manager.js';
import { splitMessage } from '../telegram/markdown.js';
import { parseSessionKey } from '../utils/session-key.js';
import { markDoneRecovered, markDropped, hasNewerDuplicate, hasLaterOpenVoiceRow, getRowExecutionState, incrementResumeAttempt, } from './input-log.js';
const LONG_VOICE_DECOMPOSE_INSTRUCTION = 'Dies ist ein langer transkribierter Sprach-Auftrag, der vorher in einen Timeout lief. ' +
    'Zerlege ihn ZUERST in einzelne, atomare Tasks. Führe sie der Reihe nach aus. ' +
    'Wenn nicht alles in einem Durchgang fertig wird, liefere die fertigen Teilergebnisse, ' +
    'nenne die nächste offene Aufgabe und mach soweit möglich selbstständig weiter. ' +
    'Frage NICHT, ob der User die Nachricht nochmal schicken soll.';
/**
 * Attempt to re-dispatch a stored-but-unexecuted input through the agent and
 * deliver the answer. See the tri-state return contract in the module docstring.
 * Never throws. IMPORTANT: the caller must have awaited the original turn's
 * hard-cancel/SDK drain before calling, so the side-effect guard re-read is fresh.
 */
export async function tryAutoDispatch(args) {
    const { api, chatId, sessionKey, rowId, rawContent, inputType, reason, statusMessageId } = args;
    if (!config.INPUT_AUTODISPATCH_ENABLED)
        return 'fallback';
    if (rowId == null || !rawContent.trim())
        return 'fallback';
    // Re-read AFTER the caller's cancel-drain: a mutating tool that started late in
    // the original (zombie) turn is now visible here → Decision D skip (P1-1).
    const state = getRowExecutionState(rowId);
    if (!state)
        return 'fallback';
    if (state.sideEffectStarted) {
        console.log(`[AutoDispatch] row ${rowId} skipped — mutating tool already started (Decision D)`);
        return 'fallback';
    }
    // Loop bound: at most INPUT_AUTODISPATCH_MAX_ATTEMPTS auto-runs per row.
    if (state.resumeAttempts >= config.INPUT_AUTODISPATCH_MAX_ATTEMPTS) {
        console.log(`[AutoDispatch] row ${rowId} skipped — resume_attempts ${state.resumeAttempts} >= max`);
        return 'fallback';
    }
    // User already re-sent the identical input → a live turn owes the answer.
    if (hasNewerDuplicate(sessionKey, rawContent, rowId, state.receivedAt)) {
        console.log(`[AutoDispatch] row ${rowId} superseded by an identical live re-send — skipping`);
        markDropped(rowId, 'auto_dispatch_deduped_newer');
        return 'handled';
    }
    // P1-3: a later voice row may be a manual resend not yet transcribed (raw_content
    // NULL) → content-dedup can't see it. Defer to the newer turn to avoid a double answer.
    if (inputType === 'voice' && hasLaterOpenVoiceRow(sessionKey, rowId, state.receivedAt)) {
        console.log(`[AutoDispatch] row ${rowId} — a later open voice row exists (likely resend), deferring`);
        markDropped(rowId, 'auto_dispatch_superseded_by_resend');
        return 'handled';
    }
    // Durably record the attempt BEFORE re-dispatching (crash-loop terminates at max).
    incrementResumeAttempt(rowId);
    // Escape the torn / over-full SDK session left by gracefulCancel so the fresh
    // turn starts clean instead of re-hanging in the same session.
    forgetChatSession(sessionKey);
    sessionManager.forceFreshSession(sessionKey);
    // Decompose only genuinely long transcripts. A voice that hit the REAL 180s cap
    // is long by definition; the test's 5s cap makes short clips "time out" too, so
    // gate on length (not input type) to avoid framing "17+25" as a long task (P2-2).
    const isLong = rawContent.length >= config.INPUT_AUTODISPATCH_LONG_VOICE_CHARS;
    const prompt = isLong ? `${LONG_VOICE_DECOMPOSE_INSTRUCTION}\n\n${rawContent}` : rawContent;
    // Forum-topic awareness (2026-06-04): sessionKey losslessly encodes the
    // originating thread (`${chatId}:${threadId}`) → recover it so the recovered
    // answer lands in the right topic, not the General thread. The edits below
    // target statusMessageId (already in-thread); only the fresh api.sendMessage
    // fallbacks need it. undefined in regular chats → byte-identical behavior.
    // Mirrors agent.ts:1136-1140.
    const threadId = parseSessionKey(sessionKey).threadId;
    const sendOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
    // RF-4 (User-Kernwunsch 2026-06-02): honest, slim working-status so the user sees
    // the bot is ON it (not hung) during the recovery window. Reuse the ack bubble if
    // provided → no stale "🎤 Transcribing…" bubble left behind (RF-2), no extra clutter.
    // Best-effort: a failed edit never blocks the recovery.
    if (statusMessageId != null) {
        try {
            await api.editMessageText(chatId, statusMessageId, '⏳ Das dauert etwas länger — ich mach das automatisch für dich fertig…');
        }
        catch { /* best-effort status */ }
    }
    try {
        // Mirror auto-resume.replayOne: bare sendToAgent (its own internal
        // AGENT_QUERY_TIMEOUT_MS + watchdog bound it). Deliberately NOT the voice
        // hard-cap that just fired — re-using the cap that caused the timeout would
        // be self-defeating; a decomposed recovery legitimately needs more headroom.
        const response = await queueRequest(sessionKey, prompt, (turnEpoch) => sendToAgent(sessionKey, prompt, {
            turnEpoch,
            currentInputLogRowId: rowId,
        }));
        const answer = (response?.text ?? '').trim();
        if (!answer) {
            console.log(`[AutoDispatch] row ${rowId} produced no answer — falling back to notice`);
            return 'fallback';
        }
        // Conditional transparency (User-Entscheidung 2026-06-02): only a genuinely
        // LONG recovery gets a transparency line. A short/trivial recovery stays
        // INVISIBLE so a "gib mir nur X"-instruction is honored verbatim (the agent's
        // answer already obeys it; we must not clutter it). Clean, human wording —
        // no internal jargon ("Durchgang gesprengt"). In production (cap 180s) a
        // recovery only fires on a genuinely long turn, so the line shows where it fits.
        const preface = isLong
            ? '↩️ Das war ein längerer Auftrag — ich hab ihn automatisch für dich zu Ende gebracht:\n\n'
            : '';
        // Deliver. chunk[0] is the COMMIT point (Codex P2): once it's out — as the
        // ack→answer edit (RF-2: the "Transcribing…/⏳" bubble BECOMES the result), or a
        // fresh send — the answer counts as delivered. A later follow-up send failure is
        // best-effort and must NOT downgrade to 'fallback' (which would overwrite the
        // already-shown answer with the "please re-send" notice). Only a failed chunk[0]
        // → 'fallback'. No ack id → plain sends.
        const chunks = splitMessage(preface + answer);
        if (chunks.length === 0)
            return 'fallback';
        let firstDelivered = false;
        if (statusMessageId != null) {
            try {
                await api.editMessageText(chatId, statusMessageId, chunks[0]);
                firstDelivered = true;
            }
            catch {
                try {
                    await api.sendMessage(chatId, chunks[0], sendOpts);
                    firstDelivered = true;
                }
                catch { /* handled below */ }
            }
        }
        else {
            try {
                await api.sendMessage(chatId, chunks[0], sendOpts);
                firstDelivered = true;
            }
            catch { /* handled below */ }
        }
        if (!firstDelivered) {
            console.error(`[AutoDispatch] row ${rowId} could not deliver the answer — falling back`);
            return 'fallback';
        }
        for (const c of chunks.slice(1)) {
            try {
                await api.sendMessage(chatId, c, sendOpts);
            }
            catch { /* best-effort follow-up chunk */ }
        }
        // Answer delivered → finalize as recovered (not a silent 'done', not 'dropped').
        markDoneRecovered(rowId, reason);
        console.log(`[AutoDispatch] row ${rowId} auto-continued and answered (reason=${reason})`);
        return 'answered';
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[AutoDispatch] row ${rowId} re-dispatch failed (${msg}) — falling back to notice`);
        return 'fallback';
    }
}
//# sourceMappingURL=input-auto-dispatch.js.map