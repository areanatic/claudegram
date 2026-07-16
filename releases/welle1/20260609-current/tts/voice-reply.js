import { InputFile } from 'grammy';
import { config } from '../config.js';
import { generateSpeech, TtsUnavailableError } from './tts.js';
import { getTTSSettings, isVoiceActive, getDetectedLanguage } from './tts-settings.js';
import { getSessionKeyFromCtx } from '../utils/session-key.js';
function stripMarkdown(input) {
    let text = input;
    // Remove code blocks
    text = text.replace(/```[\s\S]*?```/g, '');
    // Inline code
    text = text.replace(/`([^`]*)`/g, '$1');
    // Links [text](url)
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    // Bold/italic/strikethrough markers
    text = text.replace(/[\*_~]/g, '');
    // Headers
    text = text.replace(/^#+\s+/gm, '');
    // Blockquotes
    text = text.replace(/^>\s?/gm, '');
    // List markers
    text = text.replace(/^\s*[-*+]\s+/gm, '');
    text = text.replace(/^\s*\d+\.\s+/gm, '');
    // Collapse extra whitespace
    text = text.replace(/\n{2,}/g, '\n');
    return text.trim();
}
function looksLikeError(text) {
    return /^(❌|⚠️|Error:)/.test(text.trim());
}
function truncateToMax(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const truncated = text.slice(0, maxChars);
    const lastPeriod = Math.max(truncated.lastIndexOf('.'), truncated.lastIndexOf('!'), truncated.lastIndexOf('?'));
    if (lastPeriod > 200) {
        return truncated.slice(0, lastPeriod + 1);
    }
    return truncated;
}
export async function maybeSendVoiceReply(ctx, text, options) {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo)
        return;
    const { sessionKey } = keyInfo;
    // Check voice-first mode OR explicit TTS enabled
    if (!isVoiceActive(sessionKey))
        return;
    const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;
    if (!hasKey)
        return;
    if (looksLikeError(text))
        return;
    const cleaned = stripMarkdown(text);
    const minChars = options?.voiceMode ? 10 : 200;
    if (cleaned.length < minChars)
        return;
    const safeText = truncateToMax(cleaned, config.TTS_MAX_CHARS);
    if (!safeText)
        return;
    // Use provided language, fall back to detected language from last voice input
    const language = options?.language || getDetectedLanguage(sessionKey) || undefined;
    try {
        const settings = getTTSSettings(sessionKey);
        const audioBuffer = await generateSpeech(safeText, settings.voice, { language });
        const format = config.TTS_PROVIDER === 'groq'
            ? 'ogg'
            : config.TTS_RESPONSE_FORMAT === 'opus' ? 'ogg' : config.TTS_RESPONSE_FORMAT;
        const file = new InputFile(audioBuffer, `response.${format}`);
        if (settings.autoplay) {
            // Voice message: plays inline automatically in Telegram
            await ctx.replyWithVoice(file);
        }
        else {
            // Audio file: doesn't autoplay, shows as downloadable attachment
            await ctx.replyWithAudio(file);
        }
    }
    catch (error) {
        if (error instanceof TtsUnavailableError) {
            // Non-English voice synthesis is disabled (OpenAI quota exhausted). The text
            // answer was already sent, so degrade to text-only quietly — no error spam.
            console.log(`[TTS] voice-reply skipped, text-only (${error.message})`);
            return;
        }
        console.error('[TTS] Failed to generate or send voice reply:', error);
    }
}
//# sourceMappingURL=voice-reply.js.map