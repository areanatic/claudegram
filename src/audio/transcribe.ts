import * as fs from 'fs';
import * as path from 'path';
import OpenAI, { toFile } from 'openai';
import { config } from '../config.js';
import { downloadFileSecure, getTelegramFileUrl } from '../utils/download.js';

const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';

export interface TranscribeOptions {
  /** Timeout in milliseconds. Defaults to config.VOICE_TIMEOUT_MS */
  timeoutMs?: number;
  /** If true, return empty string instead of throwing on empty result */
  allowEmpty?: boolean;
}

export interface TranscribeResult {
  text: string;
  /** Full language name as returned by Whisper, e.g. "english", "german" */
  language: string;
  /** ISO 639-1 language code, e.g. "en", "de" */
  languageCode: string;
  /** Whisper avg_logprob of the first segment (null if unavailable). */
  avgLogprob: number | null;
  /** Whisper no_speech_prob of the first segment (null if unavailable). */
  noSpeechProb: number | null;
  /**
   * True when Whisper's confidence signals indicate a likely hallucination
   * (avg_logprob < -1.0 or no_speech_prob > 0.6). A2 confidence gate: the voice
   * handler refuses to forward a low-confidence transcript to the agent.
   */
  lowConfidence: boolean;
}

/** Map Whisper's full language names to ISO 639-1 codes */
const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: 'en', german: 'de', spanish: 'es', french: 'fr',
  portuguese: 'pt', italian: 'it', dutch: 'nl', russian: 'ru',
  japanese: 'ja', chinese: 'zh', korean: 'ko', arabic: 'ar',
  turkish: 'tr', polish: 'pl', swedish: 'sv', norwegian: 'no',
  danish: 'da', finnish: 'fi', greek: 'el', czech: 'cs',
  romanian: 'ro', hungarian: 'hu', ukrainian: 'uk', hindi: 'hi',
  thai: 'th', vietnamese: 'vi', indonesian: 'id', malay: 'ms',
  hebrew: 'he', persian: 'fa', catalan: 'ca', croatian: 'hr',
  slovak: 'sk', slovenian: 'sl', serbian: 'sr', bulgarian: 'bg',
  lithuanian: 'lt', latvian: 'lv', estonian: 'et',
};

function getGroqClient(): OpenAI {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured. Set it in .env to enable voice transcription.');
  }
  return new OpenAI({
    apiKey: config.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });
}

/**
 * Transcribe an audio file with auto-detected language using verbose_json format.
 * Returns transcript text, detected language name, and ISO 639-1 code.
 */
export async function transcribeFileWithLanguage(filePath: string, options?: TranscribeOptions): Promise<TranscribeResult> {
  const groq = getGroqClient();
  const fileName = path.basename(filePath);
  const fileStream = fs.createReadStream(filePath);

  console.log(`[transcribeFileWithLanguage] fileName=${fileName} size=${fs.statSync(filePath).size}`);

  const result = await groq.audio.transcriptions.create({
    file: await toFile(fileStream, fileName),
    model: GROQ_WHISPER_MODEL,
    response_format: 'verbose_json',
  }) as { text?: string; language?: string; duration?: number; segments?: Array<{ no_speech_prob?: number; avg_logprob?: number }> };

  const transcript = (result.text || '').trim();

  // Diagnostic log: capture Whisper confidence signals so we can detect
  // hallucinated transcripts (e.g. from corrupt OGG headers) in the future.
  // Low avg_logprob (< -1.0) or high no_speech_prob (> 0.6) strongly suggests
  // the audio had no real speech content and Whisper is hallucinating.
  const firstSeg = result.segments?.[0];
  const avgLogprob = firstSeg?.avg_logprob;
  const noSpeechProb = firstSeg?.no_speech_prob;
  console.log(
    `[transcribeFileWithLanguage] result: lang=${result.language} duration=${result.duration}s ` +
    `len=${transcript.length} avg_logprob=${avgLogprob?.toFixed(3) ?? 'n/a'} ` +
    `no_speech_prob=${noSpeechProb?.toFixed(3) ?? 'n/a'}`
  );
  if (typeof avgLogprob === 'number' && avgLogprob < -1.0) {
    console.warn(`[transcribeFileWithLanguage] LOW CONFIDENCE transcript (avg_logprob=${avgLogprob.toFixed(3)}) — likely hallucination. Preview: "${transcript.slice(0, 80)}"`);
  }
  if (typeof noSpeechProb === 'number' && noSpeechProb > 0.6) {
    console.warn(`[transcribeFileWithLanguage] HIGH NO-SPEECH probability (${noSpeechProb.toFixed(3)}) — audio likely contains no speech. Preview: "${transcript.slice(0, 80)}"`);
  }

  if (!transcript && !options?.allowEmpty) {
    throw new Error('Empty transcription result');
  }

  const detectedLanguage = (result.language || 'english').toLowerCase();
  const languageCode = LANGUAGE_NAME_TO_CODE[detectedLanguage] || config.VOICE_LANGUAGE;

  // A2 confidence gate: surface Whisper's confidence signals so the caller can
  // refuse a hallucinated transcript instead of feeding nonsense to the agent.
  const lowConfidence =
    (typeof avgLogprob === 'number' && avgLogprob < -1.0) ||
    (typeof noSpeechProb === 'number' && noSpeechProb > 0.6);

  return {
    text: transcript,
    language: detectedLanguage,
    languageCode,
    avgLogprob: typeof avgLogprob === 'number' ? avgLogprob : null,
    noSpeechProb: typeof noSpeechProb === 'number' ? noSpeechProb : null,
    lowConfidence,
  };
}

/**
 * Transcribe an audio file using the Groq Whisper API via OpenAI SDK.
 * Uses fixed language from config (backward-compatible).
 */
export async function transcribeFile(filePath: string, options?: TranscribeOptions): Promise<string> {
  const groq = getGroqClient();
  const fileName = path.basename(filePath);
  const fileStream = fs.createReadStream(filePath);

  console.log(`[transcribeFile] fileName=${fileName} size=${fs.statSync(filePath).size}`);

  const result = await groq.audio.transcriptions.create({
    file: await toFile(fileStream, fileName),
    model: GROQ_WHISPER_MODEL,
    language: config.VOICE_LANGUAGE,
    response_format: 'json',
  }) as { text?: string };

  const transcript = (result.text || '').trim();

  if (!transcript && !options?.allowEmpty) {
    throw new Error('Empty transcription result');
  }

  return transcript;
}

/**
 * Download a file from Telegram servers securely.
 * Constructs the URL via getTelegramFileUrl and delegates to downloadFileSecure.
 */
export function downloadTelegramAudio(botToken: string, filePath: string, destPath: string): Promise<void> {
  const fileUrl = getTelegramFileUrl(botToken, filePath);
  return downloadFileSecure(fileUrl, destPath);
}
