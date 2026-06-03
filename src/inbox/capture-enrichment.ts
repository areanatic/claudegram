/**
 * Universal Telegram Capture — Enrichment (Phase 1.5)
 *
 * Beim Capture-Time automatisch:
 *   - Voice/Audio: Whisper-Transcript via Groq → `captures.transcript`
 *   - Photo: Vision-Caption via Groq Llama Vision → `captures.transcript`
 *
 * User-Vorgabe 2026-05-07: "Bilder + Audios müssen IMMER eingeschlossen werden."
 *
 * Defensive: alles try/catch, silent fail, blockt nie den Conversation-Flow.
 * Async fire-and-forget vom captureRouter aufgerufen.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { type Context } from 'grammy';
import OpenAI from 'openai';
import { config } from '../config.js';
import {
  transcribeFile,
  downloadTelegramAudio,
} from '../audio/transcribe.js';
import { updateCaptureProcessed } from './captures-db.js';
import { extractMedia, detectPlatform } from '../media/extract.js';

const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const VISION_MAX_TOKENS = 400;
const VISION_PROMPT = `Beschreibe dieses Bild kurz, faktisch und durchsuchbar. Wenn es ein Screenshot ist (Booking, App, Ticket, Email, Chat, Code etc.) extrahiere KONKRETE Daten: Buchungsnummern, Datums, Adressen, Preise, Namen, Codes, Status. Wenn es ein Foto ist: was ist drauf, Kontext, sichtbarer Text. Max 300 Worte. Auf Deutsch.`;

function getGroqClient(): OpenAI {
  return new OpenAI({
    apiKey: config.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });
}

async function downloadTelegramFile(
  ctx: Context,
  telegramFileId: string,
  destExt: string,
): Promise<string> {
  const file = await ctx.api.getFile(telegramFileId);
  if (!file.file_path) throw new Error('No file_path from Telegram getFile');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-enrich-'));
  const dest = path.join(tmpDir, `media${destExt}`);

  if (destExt === '.ogg' || destExt === '.mp3' || destExt === '.m4a') {
    await downloadTelegramAudio(config.TELEGRAM_BOT_TOKEN, file.file_path, dest);
  } else {
    // Image / other: direct fetch
    const url = `${config.TELEGRAM_API_SERVER_URL || 'https://api.telegram.org'}/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
  }

  return dest;
}

function cleanupTmpFile(filePath: string): void {
  try {
    const dir = path.dirname(filePath);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Run Whisper on a voice/audio capture and write transcript to DB.
 */
export async function enrichVoiceCapture(
  ctx: Context,
  captureId: number,
  telegramFileId: string,
): Promise<void> {
  let dest: string | null = null;
  try {
    dest = await downloadTelegramFile(ctx, telegramFileId, '.ogg');
    const transcript = await transcribeFile(dest);
    if (transcript && transcript.trim()) {
      updateCaptureProcessed(captureId, {
        transcript,
        summary: transcript.slice(0, 200),
        status: 'processed',
      });
      console.log(`[CaptureEnrich] voice #${captureId} ✅ ${transcript.length} chars`);
    } else {
      console.warn(`[CaptureEnrich] voice #${captureId}: empty transcript`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CaptureEnrich] voice #${captureId} ❌ ${msg}`);
    // Best-effort error tag, but don't fail the conversation flow
    updateCaptureProcessed(captureId, { status: 'failed', last_error: msg });
  } finally {
    if (dest) cleanupTmpFile(dest);
  }
}

/**
 * Run Vision on a photo capture and write caption/extracted-data to DB.
 *
 * Uses Groq Llama-4-Scout Vision (free tier, fast, ~1s).
 */
export async function enrichPhotoCapture(
  ctx: Context,
  captureId: number,
  telegramFileId: string,
): Promise<void> {
  if (!config.GROQ_API_KEY) {
    console.warn(`[CaptureEnrich] photo #${captureId}: no GROQ_API_KEY, skip vision`);
    return;
  }
  let dest: string | null = null;
  try {
    dest = await downloadTelegramFile(ctx, telegramFileId, '.jpg');
    const buf = fs.readFileSync(dest);
    const base64 = buf.toString('base64');
    const mimeType = 'image/jpeg';

    const groq = getGroqClient();
    const completion = await groq.chat.completions.create({
      model: VISION_MODEL,
      max_tokens: VISION_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64}` },
            },
          ] as unknown as string,
        },
      ],
    });
    const caption = (completion.choices[0]?.message?.content || '').trim();
    if (caption) {
      updateCaptureProcessed(captureId, {
        transcript: caption,
        summary: caption.slice(0, 200),
        status: 'processed',
      });
      console.log(`[CaptureEnrich] photo #${captureId} ✅ ${caption.length} chars`);
    } else {
      console.warn(`[CaptureEnrich] photo #${captureId}: empty caption`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CaptureEnrich] photo #${captureId} ❌ ${msg}`);
    updateCaptureProcessed(captureId, { status: 'failed', last_error: msg });
  } finally {
    if (dest) cleanupTmpFile(dest);
  }
}

/**
 * Run yt-dlp / Reader extraction on a URL capture and write Title/Description
 * to DB. Bug-Fix 2026-05-09: vorher hatten URL-Captures keinen Worker — sie
 * blieben Tage in `status='queued'` (26 Stk seit 2026-05-02 in Master-Bot).
 *
 * extract.ts bringt yt-dlp + redirect-resolution + platform-detection mit.
 * Wir nehmen mode='text' für minimum-cost (nur metadata, kein audio download).
 */
export async function enrichUrlCapture(captureId: number, sourceUrl: string): Promise<void> {
  try {
    const platform = detectPlatform(sourceUrl);
    const result = await extractMedia({ url: sourceUrl, mode: 'text' });
    const title = (result.title || 'Untitled').trim();
    const transcriptPart = result.transcript ? `\n\n${result.transcript.slice(0, 2000)}` : '';
    const transcript = `[${platform}] ${title}${transcriptPart}`;
    const summary = transcript.slice(0, 200);
    updateCaptureProcessed(captureId, {
      transcript,
      summary,
      status: 'processed',
    });
    console.log(`[CaptureEnrich] url #${captureId} ✅ ${platform} ${transcript.length} chars`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CaptureEnrich] url #${captureId} ❌ ${msg}`);
    updateCaptureProcessed(captureId, { status: 'failed', last_error: msg });
  }
}

/**
 * Entry point — fire-and-forget called by captureRouter after insertCapture.
 * Decides based on capture_type which enrichment to run.
 *
 * Bug-Fix 2026-05-09: url-Branch hinzugefügt (Title/Description-Extract).
 * sourceUrl-Parameter optional dazu — nur für url-type genutzt.
 */
export function enrichCaptureAsync(
  ctx: Context,
  captureId: number,
  captureType: string,
  telegramFileId: string | null,
  sourceUrl?: string | null,
): void {
  if (captureType === 'voice' || captureType === 'audio' || captureType === 'video_note') {
    if (!telegramFileId) return;
    void enrichVoiceCapture(ctx, captureId, telegramFileId);
  } else if (captureType === 'photo') {
    if (!telegramFileId) return;
    void enrichPhotoCapture(ctx, captureId, telegramFileId);
  } else if (captureType === 'url') {
    if (!sourceUrl) return;
    void enrichUrlCapture(captureId, sourceUrl);
  }
}
