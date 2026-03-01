import { Context, InputFile } from 'grammy';
import { config } from '../config.js';
import { generateSpeech } from './tts.js';
import { getTTSSettings, isVoiceActive, getDetectedLanguage } from './tts-settings.js';
import { getSessionKeyFromCtx } from '../utils/session-key.js';

function stripMarkdown(input: string): string {
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

function looksLikeError(text: string): boolean {
  return /^(❌|⚠️|Error:)/.test(text.trim());
}

function truncateToMax(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);
  const lastPeriod = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?')
  );

  if (lastPeriod > 200) {
    return truncated.slice(0, lastPeriod + 1);
  }

  return truncated;
}

export interface VoiceReplyOptions {
  /** Override detected language for TTS (ISO 639-1 code, e.g. "de") */
  language?: string;
}

export async function maybeSendVoiceReply(ctx: Context, text: string, options?: VoiceReplyOptions): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  // Check voice-first mode OR explicit TTS enabled
  if (!isVoiceActive(sessionKey)) return;
  const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;
  if (!hasKey) return;
  if (looksLikeError(text)) return;

  const cleaned = stripMarkdown(text);
  if (cleaned.length < 5) return;

  const safeText = truncateToMax(cleaned, config.TTS_MAX_CHARS);
  if (!safeText) return;

  // Use provided language, fall back to detected language from last voice input
  const language = options?.language || getDetectedLanguage(sessionKey) || undefined;

  try {
    const settings = getTTSSettings(sessionKey);
    const audioBuffer = await generateSpeech(safeText, settings.voice, { language });
    // Determine format: if non-English fell back to OpenAI, use its format
    const isNonEnglish = language && language !== 'en' && language !== 'english';
    const usedOpenAI = config.TTS_PROVIDER === 'groq' && isNonEnglish && !!config.OPENAI_API_KEY;
    const format = (config.TTS_PROVIDER === 'groq' && !usedOpenAI)
      ? 'ogg'
      : config.TTS_RESPONSE_FORMAT === 'opus' ? 'ogg' : config.TTS_RESPONSE_FORMAT;
    const file = new InputFile(audioBuffer, `response.${format}`);

    if (settings.autoplay) {
      // Voice message: plays inline automatically in Telegram
      await ctx.replyWithVoice(file);
    } else {
      // Audio file: doesn't autoplay, shows as downloadable attachment
      await ctx.replyWithAudio(file);
    }
  } catch (error) {
    console.error('[TTS] Failed to generate or send voice reply:', error);
  }
}
