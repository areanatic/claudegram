import OpenAI from 'openai';
import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

// ── OpenAI provider ────────────────────────────────────────────────

let openai: OpenAI | null = null;

function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.0;
  return Math.min(4.0, Math.max(0.25, speed));
}

async function generateSpeechOpenAI(text: string, voice?: string): Promise<Buffer> {
  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured.');
  }
  if (!openai) {
    openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }

  const model = config.TTS_MODEL;
  const client = openai as OpenAI;
  const payload: Parameters<typeof client.audio.speech.create>[0] = {
    model,
    voice: (voice || config.TTS_VOICE) as Parameters<typeof client.audio.speech.create>[0]['voice'],
    input: text,
    response_format: config.TTS_RESPONSE_FORMAT as Parameters<typeof client.audio.speech.create>[0]['response_format'],
    speed: clampSpeed(config.TTS_SPEED),
  };

  if (model.startsWith('gpt-4o-mini-tts')) {
    payload.instructions = config.TTS_INSTRUCTIONS;
  }

  const response = await client.audio.speech.create(payload);
  return Buffer.from(await response.arrayBuffer());
}

// ── Groq TTS provider ─────────────────────────────────────────────

const GROQ_TTS_ENDPOINT = 'https://api.groq.com/openai/v1/audio/speech';
const GROQ_TTS_MODEL = 'canopylabs/orpheus-v1-english';
const GROQ_MAX_CHARS = 200;

/**
 * Split text into chunks of at most maxLen characters, breaking at sentence
 * boundaries (.!?) first, then word boundaries, then hard-cutting.
 */
export function chunkText(text: string, maxLen: number = GROQ_MAX_CHARS): string[] {
  if (text.length <= maxLen) return [text];

  // Split into sentences: split on .!? followed by whitespace or end-of-string
  const sentences: string[] = [];
  const sentenceRe = /[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g;
  let match;
  while ((match = sentenceRe.exec(text)) !== null) {
    const s = match[0].trim();
    if (s) sentences.push(s);
  }

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > maxLen) {
      // Flush current buffer
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      // Split long sentence at word boundaries
      const words = sentence.split(/\s+/);
      let wordBuf = '';
      for (const word of words) {
        if (word.length > maxLen) {
          // Hard-cut oversized word
          if (wordBuf) {
            chunks.push(wordBuf.trim());
            wordBuf = '';
          }
          for (let i = 0; i < word.length; i += maxLen) {
            chunks.push(word.slice(i, i + maxLen));
          }
        } else if (wordBuf.length + 1 + word.length > maxLen) {
          chunks.push(wordBuf.trim());
          wordBuf = word;
        } else {
          wordBuf = wordBuf ? `${wordBuf} ${word}` : word;
        }
      }
      if (wordBuf) {
        current = wordBuf;
      }
    } else if (current.length + 1 + sentence.length > maxLen) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter(Boolean);
}

/**
 * Call the Groq Orpheus TTS API for a single chunk (≤200 chars).
 * Returns a WAV Buffer.
 */
async function groqTTSSingle(text: string, voice: string): Promise<Buffer> {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured.');
  }

  const response = await fetch(GROQ_TTS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_TTS_MODEL,
      input: text,
      voice,
      response_format: 'wav',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq TTS API error ${response.status}: ${body.slice(0, 300)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Concatenate multiple WAV buffers and convert to OGG/Opus using ffmpeg.
 */
async function concatAndConvertAudio(wavBuffers: Buffer[]): Promise<Buffer> {
  if (wavBuffers.length === 0) {
    throw new Error('No audio buffers to concatenate.');
  }

  // Single buffer — just convert to ogg
  if (wavBuffers.length === 1) {
    return convertWavToOgg(wavBuffers[0]);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-tts-'));

  try {
    // Write each WAV chunk
    const chunkPaths: string[] = [];
    for (let i = 0; i < wavBuffers.length; i++) {
      const chunkPath = path.join(tmpDir, `chunk_${String(i).padStart(3, '0')}.wav`);
      fs.writeFileSync(chunkPath, wavBuffers[i], { mode: 0o600 });
      chunkPaths.push(chunkPath);
    }

    // Write concat list
    const concatListPath = path.join(tmpDir, 'concat.txt');
    const concatContent = chunkPaths.map((p) => `file '${p}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent, { mode: 0o600 });

    // Run ffmpeg
    const outputPath = path.join(tmpDir, 'output.ogg');
    await runFfmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c:a', 'libopus',
      '-b:a', '64k',
      outputPath,
    ]);

    return fs.readFileSync(outputPath);
  } finally {
    // Cleanup temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Convert a single WAV buffer to OGG/Opus.
 */
async function convertWavToOgg(wavBuffer: Buffer): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgram-tts-'));

  try {
    const inputPath = path.join(tmpDir, 'input.wav');
    const outputPath = path.join(tmpDir, 'output.ogg');
    fs.writeFileSync(inputPath, wavBuffer, { mode: 0o600 });

    await runFfmpeg([
      '-y',
      '-i', inputPath,
      '-c:a', 'libopus',
      '-b:a', '64k',
      outputPath,
    ]);

    return fs.readFileSync(outputPath);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 60_000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`ffmpeg failed: ${(stderr || error.message).slice(0, 500)}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Generate speech using Groq Orpheus TTS.
 * Handles chunking for long text and converts WAV→OGG/Opus.
 */
async function generateSpeechGroq(text: string, voice?: string): Promise<Buffer> {
  const selectedVoice = voice || config.TTS_VOICE;
  const chunks = chunkText(text, GROQ_MAX_CHARS);

  console.log(`[TTS/Groq] Generating speech: ${chunks.length} chunk(s), voice=${selectedVoice}`);

  const wavBuffers: Buffer[] = [];
  for (const chunk of chunks) {
    const wav = await groqTTSSingle(chunk, selectedVoice);
    wavBuffers.push(wav);
  }

  return concatAndConvertAudio(wavBuffers);
}

// ── Public API ─────────────────────────────────────────────────────

export interface GenerateSpeechOptions {
  /** ISO 639-1 language code (e.g. "de", "en"). When non-English + Groq provider, auto-falls back to OpenAI */
  language?: string;
}

/**
 * Thrown when no TTS provider can synthesize the requested language
 * (e.g. non-English while the OpenAI fallback is disabled). Callers should
 * catch this and degrade to text-only — it is NOT an error condition.
 */
export class TtsUnavailableError extends Error {}

/**
 * Generate speech using the configured TTS provider.
 * Returns an audio Buffer (format depends on provider:
 *   - groq: OGG/Opus
 *   - openai: format from TTS_RESPONSE_FORMAT config)
 *
 * When language is non-English and provider is Groq (English-only),
 * automatically falls back to OpenAI TTS if OPENAI_API_KEY is available.
 */
export async function generateSpeech(text: string, voice?: string, options?: GenerateSpeechOptions): Promise<Buffer> {
  const language = options?.language;

  // Detect non-English text even when no language was explicitly provided (e.g. typed messages).
  // Groq Orpheus is English-only and produces garbage for other languages.
  const looksNonEnglish = language
    ? language !== 'en'
    : /[äöüßÄÖÜ]/.test(text) || /[а-яёА-ЯЁ]/.test(text) || /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text) || /\b(ich|und|der|die|das|ist|ein|nicht|für|auf|mit|den|dem|wir|von|als|aber|oder|wie|kann|wird|sind|auch|noch|was|habe|hier|dein|mein|kein|nach|nur|über|sehr|wenn|alle|mehr)\b/i.test(text);

  // Groq Orpheus is English-only — fall back to OpenAI for other languages.
  // Map Groq voices to compatible OpenAI voices (Groq voices don't exist in OpenAI).
  const GROQ_TO_OPENAI_VOICE: Record<string, string> = {
    troy: 'onyx', austin: 'echo', daniel: 'ash',
    autumn: 'nova', diana: 'shimmer', hannah: 'coral',
  };

  if (config.TTS_PROVIDER === 'groq' && looksNonEnglish) {
    // Groq Orpheus is English-only. Non-English needs OpenAI — but only when the
    // fallback is explicitly enabled (T0.1 2026-05-31: OFF by default, OpenAI quota
    // exhausted). Otherwise skip cleanly so the caller degrades to text-only:
    // no garbage Groq audio for German, no insufficient_quota spam.
    if (config.TTS_NONENGLISH_OPENAI_FALLBACK && config.OPENAI_API_KEY) {
      const detectedBy = language ? `language=${language}` : 'text heuristic';
      const mappedVoice = voice ? (GROQ_TO_OPENAI_VOICE[voice] || 'onyx') : undefined;
      console.log(`[TTS] Non-English detected (${detectedBy}), using OpenAI TTS (voice: ${voice} → ${mappedVoice})`);
      return generateSpeechOpenAI(text, mappedVoice);
    }
    throw new TtsUnavailableError(`non-english TTS disabled (lang=${language ?? 'heuristic'})`);
  }

  if (config.TTS_PROVIDER === 'groq') {
    try {
      return await generateSpeechGroq(text, voice);
    } catch (err) {
      const msg = String(err);
      // RI-27 (2026-06-09): the Groq-429 → OpenAI fallback must ALSO respect
      // TTS_NONENGLISH_OPENAI_FALLBACK. Otherwise, with the OpenAI quota dead, a
      // transient Groq 429 made us hammer a known-dead OpenAI key → repeated 429
      // spam in every voice turn (the log noise behind the Pixi incident). When the
      // fallback is off, degrade cleanly to text-only instead of calling dead OpenAI.
      if (msg.includes('429') && config.OPENAI_API_KEY && config.TTS_NONENGLISH_OPENAI_FALLBACK) {
        const mappedVoice = voice ? (GROQ_TO_OPENAI_VOICE[voice] || 'onyx') : undefined;
        console.log(`[TTS] Groq rate limit (429) — falling back to OpenAI TTS (voice: ${voice} → ${mappedVoice})`);
        return generateSpeechOpenAI(text, mappedVoice);
      }
      throw err;
    }
  }
  return generateSpeechOpenAI(text, voice);
}
