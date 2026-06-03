/**
 * Universal Telegram Capture — "wichtig"-Trigger (deep-pass)
 *
 * Concept: shared-memory/nexus/concept_universal_telegram_capture_2026-05-04.md (v3 LEAN)
 *
 * User replies to a captured message with text starting with "wichtig" /
 * "important" / "deep" → look up the original capture, run the type-specific
 * deep handler (Whisper for voice, transcript-extract for URLs, …), append the
 * user-supplied free-text as additional tag/context.
 *
 * "wichtig" is interpreted on the message that the user is REPLYING to, not on
 * the reply itself.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { type Context } from 'grammy';
import { config } from '../config.js';
import {
  getCaptureByMessage,
  appendTags,
  updateCaptureProcessed,
} from './captures-db.js';
import {
  extractMedia,
  cleanupExtractResult,
} from '../media/extract.js';
import {
  transcribeFile,
  downloadTelegramAudio,
} from '../audio/transcribe.js';

const TRIGGER_REGEX =
  /^\s*(wichtig|important|deep|tief|interessant|merken|merk\s*dir|save\s*deep|kuck\s*genauer|schau\s*genauer|h[öo]r\s*dir\s*das\s*an|schau\s*dir\s*das\s*an)\b/i;

function botId(): string {
  return (config.BOT_NAME || 'Nexusgram').toLowerCase().replace(/\s+/g, '-');
}

function userExtraText(reply: string): string {
  return reply.replace(TRIGGER_REGEX, '').replace(/^[\s,:.\-—!?]+/, '').trim();
}

/**
 * Returns true if `text` looks like a "wichtig"-style trigger.
 */
export function isWichtigTrigger(text: string | undefined | null): boolean {
  return !!text && TRIGGER_REGEX.test(text);
}

/**
 * Handle a wichtig-reply. Returns true if a deep-pass was started.
 * Returns false if there was nothing to deep-process (e.g. no original capture
 * found, or already processed) — caller should fall through to normal flow.
 */
export async function handleWichtigReply(ctx: Context): Promise<boolean> {
  const reply = ctx.message?.text;
  const replyTo = ctx.message?.reply_to_message;
  const chatId = ctx.chat?.id;
  if (!reply || !replyTo || !chatId) return false;
  if (!isWichtigTrigger(reply)) return false;

  const cap = getCaptureByMessage(String(chatId), replyTo.message_id, botId());
  if (!cap) {
    await ctx.reply('🤔 Diese Message ist nicht in meiner Capture-Inbox — vielleicht von vor Phase-1?');
    return true;
  }

  const extra = userExtraText(reply);
  const extraTags = extra ? `wichtig,user:${extra.slice(0, 60)}` : 'wichtig';
  appendTags(cap.id, extraTags);

  await ctx.reply(`🎯 Capture #${cap.id} (${cap.capture_type}) wird tiefer angeschaut...`);

  try {
    if (cap.capture_type === 'voice' || cap.capture_type === 'audio' || cap.capture_type === 'video_note') {
      const transcript = await deepVoice(ctx, cap.id);
      updateCaptureProcessed(cap.id, {
        transcript,
        status: 'processed',
        summary: transcript.slice(0, 200),
      });
      const display = transcript.length > 1500 ? transcript.slice(0, 1500) + '…' : transcript;
      await ctx.reply(`📝 Transkript Capture #${cap.id}:\n\n${display}`);
      return true;
    }

    if (cap.capture_type === 'url' && cap.source_url) {
      const result = await extractMedia({ url: cap.source_url, mode: 'text' });
      const transcript = (result.transcript || '').trim();
      const title = result.title || cap.source_url;
      updateCaptureProcessed(cap.id, {
        transcript,
        summary: title.slice(0, 200),
        status: 'processed',
      });
      try { cleanupExtractResult(result); } catch { /* ignore */ }
      const display = transcript
        ? (transcript.length > 1500 ? transcript.slice(0, 1500) + '…' : transcript)
        : '(kein Text)';
      await ctx.reply(`📝 Capture #${cap.id} — ${title}\n\n${display}`);
      return true;
    }

    // Photo / document / sticker / video / animation / text
    await ctx.reply(
      `ℹ️ Capture #${cap.id} (${cap.capture_type}) — Deep-Pass für diesen Typ kommt in Phase 2 (Vision/PDF). Tag "wichtig" ist gespeichert.`,
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateCaptureProcessed(cap.id, { status: 'failed', last_error: msg });
    await ctx.reply(`⚠️ Deep-Pass für #${cap.id} fehlgeschlagen: ${msg}`);
    return true;
  }
}

async function deepVoice(ctx: Context, captureId: number): Promise<string> {
  const cap = getCaptureByMessage(
    String(ctx.chat?.id ?? ''),
    ctx.message?.reply_to_message?.message_id ?? 0,
    botId(),
  );
  if (!cap?.id || cap.id !== captureId) {
    throw new Error('Capture lookup mismatch');
  }
  const fileId = await getFileIdFromCapture(captureId);
  if (!fileId) throw new Error('Kein telegram_file_id gespeichert');

  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram getFile lieferte kein file_path');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-deep-'));
  // Telegram voice → .oga, but Groq Whisper rejects that extension. Force .ogg.
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

import Database from 'better-sqlite3';
let _db: Database.Database | null = null;
function dbConn(): Database.Database | null {
  if (_db) return _db;
  try {
    _db = new Database(
      '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db',
      { readonly: true },
    );
    return _db;
  } catch (err) {
    console.error('[Wichtig] db open failed:', err);
    return null;
  }
}
async function getFileIdFromCapture(id: number): Promise<string | null> {
  const conn = dbConn();
  if (!conn) return null;
  const row = conn
    .prepare('SELECT telegram_file_id FROM captures WHERE id = ?')
    .get(id) as { telegram_file_id: string | null } | undefined;
  return row?.telegram_file_id ?? null;
}
