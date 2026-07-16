/**
 * Universal Telegram Capture — Router (FIRST middleware)
 *
 * Concept: shared-memory/nexus/concept_universal_telegram_capture_2026-05-04.md (v3 LEAN)
 *
 * Captures every non-command message into the captures table sub-ms.
 * No download, no transcript, no categorisation in Phase 1.
 * Mini-Ack via 📥-Reaction on the original user message.
 */
import { getSessionKeyFromCtx } from '../utils/session-key.js';
import { isPrivate } from '../memory/privacy-state.js';
import { detectPlatform, isValidUrl } from '../media/extract.js';
import { config } from '../config.js';
import { insertCapture } from './captures-db.js';
import { enrichCaptureAsync } from './capture-enrichment.js';
const URL_REGEX = /https?:\/\/[^\s)]+/gi;
function botId() {
    return (config.BOT_NAME || 'Nexusgram').toLowerCase().replace(/\s+/g, '-');
}
function extractFirstUrl(text) {
    if (!text)
        return null;
    const matches = text.match(URL_REGEX);
    if (!matches?.length)
        return null;
    for (const m of matches) {
        if (isValidUrl(m))
            return m;
    }
    return null;
}
function classify(ctx) {
    const msg = ctx.message;
    if (!msg)
        return null;
    const tags = [];
    const meta = {};
    // Forward detection (Telegram >= Bot API 7.0 uses forward_origin, older uses forward_from*)
    const fwd = msg.forward_origin
        ?? msg.forward_from
        ?? msg.forward_from_chat;
    if (fwd) {
        tags.push('forward');
        meta.forward = fwd;
    }
    if (msg.reply_to_message) {
        meta.reply_to_message_id = msg.reply_to_message.message_id;
    }
    // Voice
    if (msg.voice) {
        tags.push('voice');
        return {
            capture_type: 'voice',
            telegram_file_id: msg.voice.file_id,
            telegram_file_unique_id: msg.voice.file_unique_id,
            mime_type: msg.voice.mime_type ?? null,
            file_size: msg.voice.file_size ?? null,
            raw_text: msg.caption ?? null,
            raw_meta_json: Object.keys(meta).length ? JSON.stringify(meta) : null,
            tags,
        };
    }
    // Audio (music files, not voice notes)
    if (msg.audio) {
        tags.push('audio');
        return {
            capture_type: 'audio',
            telegram_file_id: msg.audio.file_id,
            telegram_file_unique_id: msg.audio.file_unique_id,
            mime_type: msg.audio.mime_type ?? null,
            file_size: msg.audio.file_size ?? null,
            original_filename: msg.audio.file_name ?? null,
            raw_text: msg.caption ?? null,
            raw_meta_json: Object.keys(meta).length ? JSON.stringify(meta) : null,
            tags,
        };
    }
    // Video Note (round selfie videos)
    if (msg.video_note) {
        tags.push('video_note');
        return {
            capture_type: 'video_note',
            telegram_file_id: msg.video_note.file_id,
            telegram_file_unique_id: msg.video_note.file_unique_id,
            file_size: msg.video_note.file_size ?? null,
            raw_meta_json: Object.keys(meta).length ? JSON.stringify(meta) : null,
            tags,
        };
    }
    // Video
    if (msg.video) {
        tags.push('video');
        return {
            capture_type: 'video',
            telegram_file_id: msg.video.file_id,
            telegram_file_unique_id: msg.video.file_unique_id,
            mime_type: msg.video.mime_type ?? null,
            file_size: msg.video.file_size ?? null,
            original_filename: msg.video.file_name ?? null,
            raw_text: msg.caption ?? null,
            raw_meta_json: Object.keys(meta).length ? JSON.stringify(meta) : null,
            tags,
        };
    }
    // Photo (highest-res variant)
    if (msg.photo?.length) {
        tags.push('photo');
        const largest = msg.photo[msg.photo.length - 1];
        return {
            capture_type: 'photo',
            telegram_file_id: largest.file_id,
            telegram_file_unique_id: largest.file_unique_id,
            file_size: largest.file_size ?? null,
            raw_text: msg.caption ?? null,
            raw_meta_json: Object.keys(meta).length
                ? JSON.stringify({ ...meta, all_sizes: msg.photo.map((p) => p.file_size) })
                : JSON.stringify({ all_sizes: msg.photo.map((p) => p.file_size) }),
            tags,
        };
    }
    // Document (non-audio/non-image/non-pdf still capture metadata)
    if (msg.document) {
        tags.push('document');
        if (msg.document.mime_type)
            tags.push(msg.document.mime_type.split('/')[0]);
        return {
            capture_type: 'document',
            telegram_file_id: msg.document.file_id,
            telegram_file_unique_id: msg.document.file_unique_id,
            mime_type: msg.document.mime_type ?? null,
            file_size: msg.document.file_size ?? null,
            original_filename: msg.document.file_name ?? null,
            raw_text: msg.caption ?? null,
            raw_meta_json: Object.keys(meta).length ? JSON.stringify(meta) : null,
            tags,
        };
    }
    // Sticker
    if (msg.sticker) {
        tags.push('sticker');
        return {
            capture_type: 'sticker',
            telegram_file_id: msg.sticker.file_id,
            telegram_file_unique_id: msg.sticker.file_unique_id,
            mime_type: 'image/webp',
            file_size: msg.sticker.file_size ?? null,
            raw_text: msg.sticker.emoji ?? null,
            raw_meta_json: JSON.stringify({
                set: msg.sticker.set_name,
                type: msg.sticker.type,
                ...meta,
            }),
            tags,
        };
    }
    // Animation (GIF)
    if (msg.animation) {
        tags.push('animation');
        return {
            capture_type: 'animation',
            telegram_file_id: msg.animation.file_id,
            telegram_file_unique_id: msg.animation.file_unique_id,
            mime_type: msg.animation.mime_type ?? null,
            file_size: msg.animation.file_size ?? null,
            original_filename: msg.animation.file_name ?? null,
            raw_text: msg.caption ?? null,
            raw_meta_json: Object.keys(meta).length ? JSON.stringify(meta) : null,
            tags,
        };
    }
    // Text-based: URL-bearing or pure text
    const text = msg.text ?? msg.caption ?? '';
    if (!text)
        return null;
    // Skip slash-commands — those are not material captures
    if (text.startsWith('/'))
        return null;
    const url = extractFirstUrl(text);
    if (url) {
        const platform = detectPlatform(url);
        tags.push('url');
        if (platform !== 'unknown')
            tags.push(platform);
        return {
            capture_type: 'url',
            platform,
            source_url: url,
            raw_text: text,
            raw_meta_json: Object.keys(meta).length ? JSON.stringify(meta) : null,
            tags,
        };
    }
    // Pure text — capture all non-empty texts.
    // Bug-Fix 2026-05-09: 20-char-Filter war Quelle des "verpasst, schick nochmal"-
    // Bugs (kurze Texts wie "und?" landeten nicht in DB → stale-filter konnte sie
    // nicht recovern). User-Vorgabe 2026-05-08: "Alles soll erfasst werden, 4TB
    // Platz, Super-Brain wächst und wächst." Lieber Spam in DB als Datenverlust.
    if (text.trim().length === 0)
        return null;
    tags.push('text');
    if (text.length < 20)
        tags.push('short'); // markiert kurze Texts für späteres Filtering, falls nötig
    return {
        capture_type: 'text',
        raw_text: text,
        raw_meta_json: Object.keys(meta).length ? JSON.stringify(meta) : null,
        tags,
    };
}
async function ackReaction(ctx, chatId, messageId) {
    try {
        // grammY exposes setMessageReaction via ctx.api
        await ctx.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '📥' }]);
    }
    catch (err) {
        // Telegram returns INVALID_REACTION for non-allowed emojis on certain chat types.
        // Silent fail — capture itself is what matters.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('REACTION_INVALID') && !msg.includes('CHAT_NOT_MODIFIED')) {
            console.warn('[Captures] ack reaction failed:', msg);
        }
    }
}
export async function captureRouter(ctx, next) {
    try {
        const msg = ctx.message;
        const chatId = ctx.chat?.id;
        if (!msg || !chatId) {
            await next();
            return;
        }
        const classified = classify(ctx);
        if (!classified) {
            await next();
            return;
        }
        const keyInfo = getSessionKeyFromCtx(ctx);
        const sessionKey = keyInfo?.sessionKey ?? String(chatId);
        const privacy = isPrivate(sessionKey) ? 'private' : 'public';
        const id = insertCapture({
            chat_id: String(chatId),
            message_id: msg.message_id,
            bot_id: botId(),
            user_id: ctx.from?.id ? String(ctx.from.id) : null,
            message_thread_id: msg.message_thread_id ?? null,
            update_id: ctx.update?.update_id ?? null,
            media_group_id: msg.media_group_id ?? null,
            capture_type: classified.capture_type,
            platform: classified.platform ?? null,
            source_url: classified.source_url ?? null,
            raw_text: classified.raw_text ?? null,
            raw_meta_json: classified.raw_meta_json ?? null,
            telegram_file_id: classified.telegram_file_id ?? null,
            telegram_file_unique_id: classified.telegram_file_unique_id ?? null,
            mime_type: classified.mime_type ?? null,
            file_size: classified.file_size ?? null,
            original_filename: classified.original_filename ?? null,
            tags: classified.tags.join(','),
            privacy,
            status: 'queued',
        });
        if (id !== null) {
            // Fire-and-forget reaction; do not block downstream handlers
            void ackReaction(ctx, chatId, msg.message_id);
            // Phase 1.5: auto-enrich voice/audio/video_note via Whisper, photo via Vision.
            // Async fire-and-forget — landet in captures.transcript wenn fertig.
            // User-Vorgabe 2026-05-07: "Bilder + Audios müssen IMMER eingeschlossen werden."
            enrichCaptureAsync(ctx, id, classified.capture_type, classified.telegram_file_id ?? null, classified.source_url ?? null);
        }
    }
    catch (err) {
        // Capture must never break the bot
        console.error('[Captures] router error:', err);
    }
    await next();
}
//# sourceMappingURL=capture-router.js.map