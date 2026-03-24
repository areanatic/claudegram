import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { downloadFileSecure, getTelegramFileUrl } from '../utils/download.js';

const GROQ_WHISPER_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
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

/**
 * Transcribe an audio file with auto-detected language using verbose_json format.
 * Returns transcript text, detected language name, and ISO 639-1 code.
 */
export async function transcribeFileWithLanguage(filePath: string, options?: TranscribeOptions): Promise<TranscribeResult> {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured. Set it in .env to enable voice transcription.');
  }

  const timeoutMs = options?.timeoutMs ?? config.VOICE_TIMEOUT_MS;
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const mimeType = fileName.endsWith('.oga') ? 'audio/ogg' : 'audio/ogg';
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);
  formData.append('model', GROQ_WHISPER_MODEL);
  formData.append('response_format', 'verbose_json');
  // Omit 'language' parameter to enable auto-detection

  const response = await fetch(GROQ_WHISPER_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
    },
    body: formData,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq Whisper API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const result = (await response.json()) as { text?: string; language?: string };
  const transcript = (result.text || '').trim();

  if (!transcript && !options?.allowEmpty) {
    throw new Error('Empty transcription result');
  }

  const detectedLanguage = (result.language || 'english').toLowerCase();
  const languageCode = LANGUAGE_NAME_TO_CODE[detectedLanguage] || config.VOICE_LANGUAGE;

  return { text: transcript, language: detectedLanguage, languageCode };
}

/**
 * Transcribe an audio file using the Groq Whisper API directly via fetch.
 * No Python subprocess - much faster, especially on first call.
 * Uses fixed language from config (backward-compatible).
 */
export async function transcribeFile(filePath: string, options?: TranscribeOptions): Promise<string> {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured. Set it in .env to enable voice transcription.');
  }

  const timeoutMs = options?.timeoutMs ?? config.VOICE_TIMEOUT_MS;
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const mimeType = fileName.endsWith('.oga') ? 'audio/ogg' : 'audio/ogg';
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);
  formData.append('model', GROQ_WHISPER_MODEL);
  formData.append('language', config.VOICE_LANGUAGE);
  formData.append('response_format', 'json');

  const response = await fetch(GROQ_WHISPER_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
    },
    body: formData,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq Whisper API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const result = (await response.json()) as { text?: string };
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
