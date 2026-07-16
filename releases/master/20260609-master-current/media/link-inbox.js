/**
 * Lightweight Link-Inbox
 *
 * When a user sends a solo YouTube / TikTok / Instagram URL the bot
 * automatically:
 *   1. Acknowledges immediately
 *   2. Extracts a text transcript (no video download)
 *   3. Categorises by keyword matching (no extra API call)
 *   4. Saves to L2 SQLite memory for later retrieval
 *   5. Replies with a short summary + category tag
 *
 * "Cortex aus" by default — no deep analysis unless the user explicitly
 * flags a link as important.
 */
import { detectPlatform, platformLabel, extractMedia, cleanupExtractResult, isValidUrl, } from './extract.js';
import { saveMemory } from '../memory/nexus-memory.js';
import { isPrivate } from '../memory/privacy-state.js';
// ── Supported platforms for auto-inbox ────────────────────────────────────────
const AUTO_PLATFORMS = ['youtube', 'tiktok', 'instagram'];
// ── Keyword-based categorisation (fast, free, no LLM call) ───────────────────
const CATEGORY_RULES = [
    {
        category: 'AI/Tech',
        pattern: /\b(ai|llm|model|api|database|sql|nosql|github|code|software|app|machine.?learning|neural|gpt|claude|openai|anthropic|python|javascript|typescript|programming|developer|tech|tool|framework|agent|vector|embedding|rag|wiki)\b/i,
    },
    {
        category: 'Finanzen',
        pattern: /\b(steuer|finanz|kredit|bank|zins|notar|immobili|budget|geld|investment|aktien|dividende|wohnung|kauf|miete|hypothek|steuerbescheid|finanzamt|kaufvertrag|grundschuld)\b/i,
    },
    {
        category: 'Gesundheit',
        pattern: /\b(gesundheit|arzt|medizin|therapie|krankenhaus|diagnose|symptom|behandlung|sport|fitness|ern.?hrung|schlaf|psychiatrie|neurologie|dermatologie)\b/i,
    },
    {
        category: 'Bildung',
        pattern: /\b(erkl.{0,4}rt|tutorial|lernen|wissen|einfach.erkl|how.to|guide|kurs|schule|universit|studium|lektion)\b/i,
    },
    {
        category: 'News',
        pattern: /\b(news|nachrichten|aktuell|politik|wirtschaft|gesellschaft|bericht|journalist|breaking)\b/i,
    },
];
function categorise(text) {
    for (const { category, pattern } of CATEGORY_RULES) {
        if (pattern.test(text))
            return category;
    }
    return 'Sonstiges';
}
// ── Public API ─────────────────────────────────────────────────────────────────
/**
 * Returns the URL if `text` is a single supported media URL, otherwise null.
 * Solo = no extra words around the URL.
 */
export function detectInboxUrl(text) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.includes(' ') || trimmed.startsWith('/'))
        return null;
    if (!isValidUrl(trimmed))
        return null;
    const platform = detectPlatform(trimmed);
    if (!AUTO_PLATFORMS.includes(platform))
        return null;
    return trimmed;
}
/**
 * Main entry point: transcribe → categorise → save → reply with summary.
 * Non-blocking ack sent first; result edits the ack message.
 */
export async function processLinkInbox(ctx, url, sessionKey) {
    const platform = detectPlatform(url);
    const label = platformLabel(platform);
    const chatId = ctx.chat?.id;
    if (!chatId)
        return;
    // Privacy P0 (Codex holistic 0.90): Link-Inbox runs BEFORE the Claude /private gate
    // (message.handler routes solo media URLs here directly). Without this, a URL sent while
    // /private is on saved as source='nexusgram' privacy='public' → readable cross-bot. Mirror
    // the agent's per-turn gate: tag source='link-inbox' (allowlisted) + privacy from the session.
    const linkPrivacy = isPrivate(sessionKey) ? 'private' : 'public';
    // 1. Immediate ack
    let ackMsgId = null;
    try {
        const ack = await ctx.reply(`📎 ${label} — transkribiere...`, { parse_mode: undefined });
        ackMsgId = ack.message_id;
    }
    catch {
        // best-effort ack
    }
    const editAck = async (text) => {
        if (!ackMsgId)
            return;
        try {
            await ctx.api.editMessageText(chatId, ackMsgId, text, { parse_mode: undefined });
        }
        catch {
            // fallback: send new message
            try {
                await ctx.reply(text, { parse_mode: undefined });
            }
            catch { /* ignore */ }
        }
    };
    // 2. Extract transcript (text-only, no video download)
    let result;
    try {
        result = await Promise.race([
            extractMedia({ url, mode: 'text' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Transcript timeout nach 90s')), 90_000)),
        ]);
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        saveMemory(`[${label}] ${url}\n\n(Transkript fehlgeschlagen: ${errMsg})`, 'semantic', sessionKey, `link_inbox,${platform},no_transcript`, 'link-inbox', linkPrivacy);
        await editAck(`📎 [${label}] ${url}\n⚠️ Kein Transkript (${errMsg}) — URL gespeichert`);
        return;
    }
    // 3. Categorise + build summary
    const transcript = result.transcript ?? '';
    const title = result.title || url;
    const category = categorise(`${title} ${transcript}`);
    const excerpt = transcript.slice(0, 180).replace(/\s+/g, ' ').trim();
    const ellipsis = transcript.length > 180 ? '…' : '';
    // 4. Save to L2 SQLite memory
    saveMemory(`[${label}] ${title}\nURL: ${url}\nKategorie: ${category}\n\nTranskript:\n${transcript}`, 'semantic', sessionKey, `link_inbox,${platform},${category.toLowerCase().replace(/[/ ]/g, '_')}`, 'link-inbox', linkPrivacy);
    // 5. Cleanup temp files
    try {
        cleanupExtractResult(result);
    }
    catch { /* ignore */ }
    // 6. Reply with result
    const display = excerpt ? `"${excerpt}${ellipsis}"` : '(kein Text erkannt)';
    await editAck(`📎 [${category}] ${title}\n${display}\n\n💾 Gespeichert`);
}
//# sourceMappingURL=link-inbox.js.map