import type { Context } from 'grammy';
import * as fs from 'node:fs';
import { config } from '../../config.js';
import { getTaskLedgerId } from '../middleware/task-ledger.middleware.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage, shouldNotifyStale, getStaleAgeMinutes } from '../middleware/stale-filter.js';
import { createInboxEntry, isAllowedMimeType, saveMetadata } from '../../inbox/inbox.js';
import { downloadFileSecure, getTelegramFileUrl } from '../../utils/download.js';
import { attachTaskMediaPath, completeTask, failTask, startTask } from '../../inbox/task-ledger.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { announceMediaTaskAccepted, announceMediaTaskFailure } from './media-task-status.js';
import { executeMediaCaptionTask } from './document.handler.js';

/** Videos follow the same write-ahead media contract as photos and documents. */
export async function handleVideo(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const message = ctx.message;
  const video = message?.video;
  if (!keyInfo || !message || !video) return;
  const { sessionKey } = keyInfo;
  const taskLedgerId = getTaskLedgerId(ctx.chat?.id, message.message_id);

  if (isStaleMessage(message.date)) {
    if (shouldNotifyStale(sessionKey)) {
      const mins = getStaleAgeMinutes(message.date);
      await ctx.reply(`⚡ Ich war kurz offline. Dein Video von vor ~${mins} Minuten habe ich leider verpasst — bitte schick es nochmal.`).catch(() => undefined);
    }
    return;
  }
  if (isDuplicate(message.message_id)) return;
  markProcessed(message.message_id);

  const sizeBytes = video.file_size ?? 0;
  const maxBytes = config.DOCUMENT_MAX_FILE_SIZE_MB * 1024 * 1024;
  const mimeType = video.mime_type ?? 'video/mp4';
  if (!isAllowedMimeType(mimeType) || sizeBytes > maxBytes) {
    const reason = sizeBytes > maxBytes ? `Video ist größer als ${config.DOCUMENT_MAX_FILE_SIZE_MB}MB` : 'Videoformat wird nicht unterstützt';
    failTask(taskLedgerId, reason);
    await announceMediaTaskFailure(ctx, sessionKey, taskLedgerId, reason);
    return;
  }

  const caption = message.caption?.trim() ?? '';
  if (caption) await announceMediaTaskAccepted(ctx, taskLedgerId, 'Videoauftrag');
  const { metadata, destPath } = createInboxEntry({
    originalFilename: video.file_name ?? `video_${message.message_id}.mp4`,
    mimeType,
    fileSize: sizeBytes,
    telegramMessageId: message.message_id,
    telegramFileId: video.file_id,
    caption: caption || null,
    senderId: ctx.from?.id ?? 0,
  });
  try {
    startTask(taskLedgerId);
    const file = await ctx.api.getFile(video.file_id);
    if (!file.file_path) throw new Error('Telegram did not provide file_path for this video.');
    await downloadFileSecure(getTelegramFileUrl(config.TELEGRAM_BOT_TOKEN, file.file_path), destPath);
    if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) throw new Error('Downloaded video is empty or missing.');
    saveMetadata(metadata);
    attachTaskMediaPath(taskLedgerId, metadata.savedPath);
    if (caption) await executeMediaCaptionTask(ctx, sessionKey, metadata, taskLedgerId);
    else {
      completeTask(taskLedgerId);
      await ctx.reply(`✅ Video gespeichert: ${metadata.originalFilename}`, { parse_mode: undefined });
    }
  } catch (error) {
    const reason = sanitizeError(error);
    failTask(taskLedgerId, reason);
    await announceMediaTaskFailure(ctx, sessionKey, taskLedgerId, reason);
  }
}
