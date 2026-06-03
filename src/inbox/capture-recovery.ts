/**
 * Universal Telegram Capture — Recovery
 *
 * "Chronik ist heilig" (User, 2026-05-06).
 *
 * On bot start:
 *   1. Find all `captures` rows that are still `status='queued'` and were
 *      created since the last bot restart (or last 24h, whichever is shorter).
 *   2. For voice/audio types: run Whisper on the telegram_file_id, store
 *      transcript in DB, mark `status='processed' + tags+=',recovered'`.
 *   3. Send a "📥 Nachgeholt" message back to the chat so the user sees what
 *      was missed during the downtime.
 *
 * Runs in the background after `bot.start()` so it never blocks startup.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { type Bot } from 'grammy';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import {
  transcribeFile,
  downloadTelegramAudio,
} from '../audio/transcribe.js';
import { extractMedia, detectPlatform } from '../media/extract.js';

const DB_PATH = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db';

interface QueuedRow {
  id: number;
  chat_id: string;
  message_id: number;
  capture_type: string;
  telegram_file_id: string | null;
  raw_text: string | null;
  source_url: string | null;
  created_at: string;
  privacy: string;
}

function getDb(): Database.Database {
  return new Database(DB_PATH);
}

function botId(): string {
  return (config.BOT_NAME || 'Nexusgram').toLowerCase().replace(/\s+/g, '-');
}

/**
 * Find captures that the bot OWES the user a response for.
 *
 * Bug-Fix Historie:
 *   - v1: nur watchdog_timeout-Tag + voice/audio
 *   - v2 (2026-05-09 früh): erweitert auf url, 24h Window
 *   - v3 (2026-05-09 22h, dieser Fix): User-Vorgabe "ALLES capturen, alles
 *     recovern, smart deduped". Window 24h → 7 Tage. LIFO (jüngste zuerst).
 *     Per-chat-cap 8 → 15. capture_types: voice/audio/video_note/url + text/photo/document.
 *     Idempotent via 'recovered_on_boot'-Tag (kein Doppel-Replay).
 */
const RECOVERY_WINDOW_HOURS = 24 * 7; // 7 Tage — allow-hardcoded: reason="capture-recovery lookback window (live P0 source)"
const RECOVERY_PER_CHAT = 15;
const RECOVERABLE_TYPES = [
  'voice','audio','video_note','url','text','photo','document',
];

function findQueuedRecoverable(): QueuedRow[] {
  const conn = getDb();
  try {
    const placeholders = RECOVERABLE_TYPES.map(() => '?').join(',');
    return conn
      .prepare(
        `SELECT id, chat_id, message_id, capture_type, telegram_file_id,
                raw_text, source_url, created_at, privacy
         FROM captures
         WHERE bot_id = ?
           AND status = 'queued'
           AND (tags IS NULL OR tags NOT LIKE '%recovered_on_boot%')
           AND capture_type IN (${placeholders})
           AND datetime(created_at) > datetime('now', ?)
         ORDER BY created_at DESC`,
      )
      .all(botId(), ...RECOVERABLE_TYPES, `-${RECOVERY_WINDOW_HOURS} hours`) as QueuedRow[];
  } finally {
    conn.close();
  }
}

function markProcessed(id: number, transcript: string, tagSuffix: string): void {
  const conn = getDb();
  try {
    conn
      .prepare(
        `UPDATE captures
         SET transcript = @transcript,
             summary = @summary,
             status = 'processed',
             processed_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime'),
             tags = COALESCE(tags, '') || @tagSuffix
         WHERE id = @id`,
      )
      .run({
        id,
        transcript,
        summary: transcript.slice(0, 200),
        tagSuffix: ',' + tagSuffix,
      });
  } finally {
    conn.close();
  }
}

function markFailed(id: number, error: string): void {
  const conn = getDb();
  try {
    conn
      .prepare(
        `UPDATE captures
         SET status = 'failed', last_error = ?, processing_attempts = processing_attempts + 1
         WHERE id = ?`,
      )
      .run(error.slice(0, 500), id);
  } finally {
    conn.close();
  }
}

async function transcribeVoice(
  bot: Bot,
  telegramFileId: string,
): Promise<string> {
  const file = await bot.api.getFile(telegramFileId);
  if (!file.file_path) throw new Error('Telegram getFile lieferte kein file_path');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-recover-'));
  const remoteExt = path.extname(file.file_path).toLowerCase();
  const ext = remoteExt === '.oga' || !remoteExt ? '.ogg' : remoteExt;
  const dest = path.join(tmpDir, `voice${ext}`);
  try {
    await downloadTelegramAudio(config.TELEGRAM_BOT_TOKEN, file.file_path, dest);
    return await transcribeFile(dest);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Recover a queued PHOTO capture via Groq Vision. Standalone-Funktion (analog
 * zu enrichPhotoCapture in capture-enrichment.ts, aber mit Bot statt ctx).
 * Bug-Fix 2026-05-09 v3: Photo-Recovery jetzt aktiv für queued photos.
 */
async function visionPhoto(bot: Bot, telegramFileId: string): Promise<string> {
  if (!config.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY missing — photo recovery disabled');
  }
  const file = await bot.api.getFile(telegramFileId);
  if (!file.file_path) throw new Error('Telegram getFile lieferte kein file_path');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-recover-photo-'));
  const dest = path.join(tmpDir, 'photo.jpg');
  try {
    const url = `${config.TELEGRAM_API_SERVER_URL || 'https://api.telegram.org'}/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Photo download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);

    const base64 = buf.toString('base64');
    const groq = new (await import('openai')).default({
      apiKey: config.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });
    const completion = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Beschreibe dieses Bild kurz, faktisch und durchsuchbar. Wenn Screenshot: extrahiere KONKRETE Daten (Buchungsnummern, Datums, Adressen, Codes). Auf Deutsch, max 300 Worte.' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ] as unknown as string,
      }],
    });
    return (completion.choices[0]?.message?.content || '').trim() || '(empty vision result)';
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Recover a queued URL capture by extracting Title + Description via yt-dlp.
 * Bug-Fix 2026-05-09: vorher hatten URL-Captures keinen Worker — sie blieben
 * für Tage in `status='queued'`. Jetzt wird beim Recovery der Title geholt
 * (Best-Effort, kein Crash bei Fail) und in transcript gespeichert.
 */
async function extractUrlSummary(url: string): Promise<string> {
  try {
    const platform = detectPlatform(url);
    const result = await extractMedia({ url, mode: 'text' });
    const title = result.title || 'Untitled';
    const transcript = result.transcript ? `\n\n${result.transcript.slice(0, 1500)}` : '';
    return `${platform.toUpperCase()}: ${title}${transcript}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `URL-Recovery (${url}) — extract fehlgeschlagen: ${msg.slice(0, 200)}`;
  }
}

async function deliverToChat(
  bot: Bot,
  chatId: string,
  cap: QueuedRow,
  transcript: string,
): Promise<void> {
  const ts = cap.created_at.replace('T', ' ').slice(0, 16);
  const header = `📥 Nachgeholt aus Capture #${cap.id} — ${cap.capture_type} vom ${ts}\n(während Bot-Down/Hang verpasst — Capture-Layer hat es trotzdem gehabt.)\n\n`;
  const body = transcript;
  const fullText = header + body;

  // Telegram limit is 4096 chars per message
  const MAX = 3900;
  if (fullText.length <= MAX) {
    await bot.api.sendMessage(Number(chatId), fullText);
    return;
  }
  // Split by chars; first chunk has header
  let remaining = body;
  let part = 1;
  const totalParts = Math.ceil(body.length / MAX);
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX);
    remaining = remaining.slice(MAX);
    const prefix = part === 1
      ? `${header}[${part}/${totalParts}]\n`
      : `[${part}/${totalParts}] (Capture #${cap.id})\n`;
    await bot.api.sendMessage(Number(chatId), prefix + chunk);
    part++;
  }
}

/**
 * Run recovery for all chats. Each capture is attempted in sequence to keep
 * Whisper/Telegram rate-limit pressure low.
 *
 * Public entry point — call once after bot.start() in a fire-and-forget manner.
 */
export async function runCaptureRecovery(bot: Bot): Promise<void> {
  const queued = findQueuedRecoverable();
  if (!queued.length) {
    console.log(`[CaptureRecovery] Nothing to recover (0 queued in last ${RECOVERY_WINDOW_HOURS}h, types=${RECOVERABLE_TYPES.join('/')})`);
    return;
  }

  // Per-chat-cap (Spam-Guard). Älteste zuerst (FIFO).
  const perChatCount = new Map<string, number>();
  const work: QueuedRow[] = [];
  let skipped = 0;
  for (const cap of queued) {
    const n = perChatCount.get(cap.chat_id) ?? 0;
    if (n >= RECOVERY_PER_CHAT) { skipped++; continue; }
    perChatCount.set(cap.chat_id, n + 1);
    work.push(cap);
  }

  console.log(
    `[CaptureRecovery] Found ${queued.length} queued (recovering ${work.length}, skipping ${skipped} due to per-chat-cap=${RECOVERY_PER_CHAT})`,
  );

  for (const cap of work) {
    try {
      console.log(`[CaptureRecovery] #${cap.id} (${cap.capture_type}) → recovering…`);
      let transcript: string;

      if (cap.capture_type === 'voice' || cap.capture_type === 'audio' || cap.capture_type === 'video_note') {
        if (!cap.telegram_file_id) {
          throw new Error(`Capture ${cap.id} has no telegram_file_id`);
        }
        transcript = await transcribeVoice(bot, cap.telegram_file_id);
      } else if (cap.capture_type === 'url') {
        if (!cap.source_url) {
          throw new Error(`Capture ${cap.id} has no source_url`);
        }
        transcript = await extractUrlSummary(cap.source_url);
      } else if (cap.capture_type === 'text') {
        // Text-Recovery: kein LLM-Call, einfach den raw_text als transcript markieren.
        // User sieht "📥 Hab deinen Text von vor X min" und entscheidet selbst was tun.
        // User-Vorgabe 2026-05-09: "alles capturen, alles recovern, smart" — no auto-LLM-call to limit cost.
        transcript = cap.raw_text || '(empty text capture)';
      } else if (cap.capture_type === 'photo') {
        if (!cap.telegram_file_id) {
          throw new Error(`Photo capture ${cap.id} has no telegram_file_id`);
        }
        transcript = await visionPhoto(bot, cap.telegram_file_id);
      } else {
        // document/video etc. — skip (Recovery-Handler kommt im nächsten Sprint)
        markProcessed(cap.id, `(no recovery handler for ${cap.capture_type})`, 'recovered_on_boot,skipped');
        console.log(`[CaptureRecovery] #${cap.id} skipped — type ${cap.capture_type} not yet supported`);
        continue;
      }

      markProcessed(cap.id, transcript, 'recovered_on_boot');
      await deliverToChat(bot, cap.chat_id, cap, transcript);
      console.log(`[CaptureRecovery] #${cap.id} ✅ delivered (${transcript.length} chars)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[CaptureRecovery] #${cap.id} ❌ ${msg}`);
      markFailed(cap.id, msg);
      // Best-effort: tell user we tried but failed
      try {
        await bot.api.sendMessage(
          Number(cap.chat_id),
          `⚠️ Capture #${cap.id} (${cap.capture_type} vom ${cap.created_at.slice(0, 16)}) konnte nicht recovered werden: ${msg}`,
        );
      } catch { /* best-effort only */ }
    }
  }
}
