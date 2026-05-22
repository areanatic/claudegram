/**
 * Document Handler — Receives files from Telegram and saves to NEXUS INBOX.
 *
 * Handles: PDFs, Word docs, spreadsheets, archives, text files, and any
 * other document type sent via Telegram (non-image documents).
 * Images sent as documents are forwarded to the existing photo handler.
 *
 * Flow:
 *   1. User sends document in Telegram
 *   2. Validate: size, MIME type, not stale/duplicate
 *   3. Download original file from Telegram API
 *   4. Save to NEXUS INBOX with metadata sidecar
 *   5. Notify user with confirmation
 *   6. Optionally feed context to agent for routing suggestions
 */

import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../config.js';
import { sendToAgent, StaleTurnError } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { messageSender } from '../../telegram/message-sender.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage, shouldNotifyStale, getStaleAgeMinutes } from '../middleware/stale-filter.js';
import {
  queueRequest,
  setAbortController,
} from '../../claude/request-queue.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';
import { recordUpload } from '../../memory/recent-uploads.js';
import { getStreamingMode } from './command.handler.js';
import { downloadFileSecure, getTelegramFileUrl } from '../../utils/download.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import {
  createInboxEntry,
  saveMetadata,
  isAllowedMimeType,
  formatFileSize,
  type InboxMetadata,
} from '../../inbox/inbox.js';

// ── Batch Tracking ───────────────────────────────────────────────────

interface BatchState {
  files: InboxMetadata[];
  timer: ReturnType<typeof setTimeout> | null;
  lastReceived: number;
}

// Per-chat batch state for grouping rapid file sends
const batchStates = new Map<string, BatchState>();

// Delay before processing batch (wait for more files)
const BATCH_DELAY_MS = 3000;

// ── Helpers ──────────────────────────────────────────────────────────

async function downloadTelegramDocument(
  ctx: Context,
  fileId: string,
  destPath: string,
  fileSizeMB: number
): Promise<void> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Telegram did not provide file_path for this document.');
  }

  const fileUrl = getTelegramFileUrl(config.TELEGRAM_BOT_TOKEN, file.file_path);
  // Scale timeout with file size: 30s base, +60s per 100MB for large files via local server
  const timeoutSeconds = Math.max(30, Math.ceil(fileSizeMB * 0.6) + 30);
  await downloadFileSecure(fileUrl, destPath, timeoutSeconds);
}

function getDocMaxSizeMB(): number {
  return config.DOCUMENT_MAX_FILE_SIZE_MB ?? 20;
}

// ── Main Handler ─────────────────────────────────────────────────────

/**
 * Handle non-image documents sent to the bot.
 * Downloads to INBOX and creates metadata sidecar.
 */
export async function handleDocument(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  const document = ctx.message?.document;

  if (!keyInfo || !messageId || !messageDate || !document) return;
  const { sessionKey } = keyInfo;

  // Skip stale and duplicate messages
  if (isStaleMessage(messageDate)) {
    console.log(`[Document] Ignoring stale document ${messageId}`);
    if (shouldNotifyStale(sessionKey)) {
      const mins = getStaleAgeMinutes(messageDate);
      try {
        await ctx.reply(`⚡ Ich war kurz offline. Deine Nachricht von vor ~${mins} Minute${mins === 1 ? '' : 'n'} habe ich leider verpasst — bitte schick sie nochmal!`);
      } catch { /* ignore — notification is best-effort */ }
    }
    return;
  }
  if (isDuplicate(messageId)) {
    console.log(`[Document] Ignoring duplicate document ${messageId}`);
    return;
  }
  markProcessed(messageId);

  // ── Validate MIME type ──
  const mimeType = document.mime_type || null;
  if (!isAllowedMimeType(mimeType)) {
    console.log(`[Document] Rejected MIME type: ${mimeType}`);
    await ctx.reply(
      `File type not supported: \`${esc(mimeType || 'unknown')}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // ── Validate file size ──
  const fileSizeBytes = document.file_size || 0;
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  const maxSizeMB = getDocMaxSizeMB();

  if (fileSizeMB > maxSizeMB) {
    await ctx.reply(
      `File too large \\(${esc(fileSizeMB.toFixed(1))}MB\\)\\.\nMax: ${esc(String(maxSizeMB))}MB\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // ── Prepare inbox entry ──
  const originalFilename = document.file_name || `document_${Date.now()}`;
  const senderId = ctx.from?.id || 0;
  const caption = ctx.message?.caption || null;

  const { metadata, destPath } = createInboxEntry({
    originalFilename,
    mimeType,
    fileSize: fileSizeBytes,
    telegramMessageId: messageId,
    telegramFileId: document.file_id,
    caption,
    senderId,
  });

  // ── Download ──
  try {
    await downloadTelegramDocument(ctx, document.file_id, destPath, fileSizeMB);

    // Verify file was written
    if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
      throw new Error('Downloaded file is empty or missing.');
    }

    // Save metadata sidecar
    saveMetadata(metadata);

    console.log(`[Document] Saved: ${metadata.savedFilename} (${formatFileSize(fileSizeBytes)})`);

    // FIX 3 (2026-05-22): make the uploaded document visible to the agent.
    // Without this the bot has no idea a document arrived — it would tell the
    // user "nothing in INBOX" while the file sits right there. recent-uploads
    // is read per agent cwd, so record it against the active session's
    // workingDirectory (same pattern as photo.handler).
    const docSession = sessionManager.getOrResumeSession(sessionKey);
    if (docSession) {
      recordUpload(docSession.workingDirectory, {
        path: metadata.savedPath,
        caption: metadata.caption || metadata.originalFilename,
        ts: metadata.receivedAt,
      });
    }

    // ── Batch or immediate response ──
    await handleBatchOrImmediate(ctx, sessionKey, metadata);

  } catch (error) {
    // Clean up partial download
    if (fs.existsSync(destPath)) {
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    }

    const errorMessage = sanitizeError(error);
    console.error('[Document] Error:', errorMessage);
    await ctx.reply(
      `Failed to save document: ${esc(errorMessage)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}

// ── Batch Logic ──────────────────────────────────────────────────────

/**
 * Handle batching: if multiple files arrive quickly, group them.
 * Otherwise respond immediately.
 */
async function handleBatchOrImmediate(
  ctx: Context,
  sessionKey: string,
  metadata: InboxMetadata
): Promise<void> {
  let batch = batchStates.get(sessionKey);

  if (!batch) {
    batch = { files: [], timer: null, lastReceived: Date.now() };
    batchStates.set(sessionKey, batch);
  }

  batch.files.push(metadata);
  batch.lastReceived = Date.now();

  // Clear existing timer
  if (batch.timer) {
    clearTimeout(batch.timer);
  }

  // Set new timer — wait for more files or process after delay
  batch.timer = setTimeout(() => {
    const currentBatch = batchStates.get(sessionKey);
    if (!currentBatch || currentBatch.files.length === 0) return;

    const files = [...currentBatch.files];
    batchStates.delete(sessionKey);

    const task = files.length === 1
      ? sendSingleFileConfirmation(ctx, sessionKey, files[0])
      : sendBatchConfirmation(ctx, sessionKey, files);

    task.catch((error) => {
      console.error('[Document] Batch confirmation error:', sanitizeError(error));
    });
  }, BATCH_DELAY_MS);
}

/**
 * Confirm a single file was saved.
 * If a session is active, optionally ask the agent to suggest routing.
 */
async function sendSingleFileConfirmation(
  ctx: Context,
  sessionKey: string,
  metadata: InboxMetadata
): Promise<void> {
  const sizeStr = formatFileSize(metadata.fileSize);
  const captionInfo = metadata.caption ? `\nCaption: "${metadata.caption}"` : '';

  const confirmMsg = [
    `Document saved to INBOX`,
    ``,
    `**${metadata.originalFilename}** (${sizeStr})${captionInfo}`,
    ``,
    `Saved as: \`${metadata.savedFilename}\``,
  ].join('\n');

  // Check if we have an active session to ask for routing (auto-resumes after restart)
  const session = sessionManager.getOrResumeSession(sessionKey);
  if (session && metadata.caption) {
    // Feed to agent for intelligent routing suggestion
    const agentPrompt = [
      'User sent a document to the INBOX.',
      `Filename: ${metadata.originalFilename}`,
      `MIME type: ${metadata.mimeType}`,
      `Size: ${sizeStr}`,
      `Caption: "${metadata.caption}"`,
      `Saved at: ${metadata.savedPath}`,
      '',
      'Based on the filename and caption, suggest where in the NEXUS project structure this file should be routed.',
      'If you can clearly determine the right location, suggest it. If unclear, just acknowledge the file was saved to INBOX.',
      'Keep your response short (1-3 sentences).',
    ].join('\n');

    try {
      await queueRequest(sessionKey, agentPrompt, async (turnEpoch) => {
        if (getStreamingMode() === 'streaming') {
          await messageSender.startStreaming(ctx);
          const abortController = new AbortController();
          setAbortController(sessionKey, abortController, turnEpoch);

          try {
            const response = await sendToAgent(sessionKey, agentPrompt, {
              onProgress: (progressText) => {
                messageSender.updateStream(ctx, progressText);
              },
              abortController,
              turnEpoch,
            });
            await messageSender.finishStreaming(ctx, response.text);
          } catch (error) {
            await messageSender.cancelStreaming(ctx);
            if (error instanceof StaleTurnError) throw error; // bubble to outer
            // Fallback to simple confirmation
            await messageSender.sendMessage(ctx, confirmMsg);
          }
        } else {
          await ctx.replyWithChatAction('typing');
          const abortController = new AbortController();
          setAbortController(sessionKey, abortController, turnEpoch);
          const response = await sendToAgent(sessionKey, agentPrompt, { abortController, turnEpoch });
          await messageSender.sendMessage(ctx, response.text);
        }
      });
    } catch (error) {
      // Codex round 7: stale turn superseded — swallow silently.
      if (error instanceof StaleTurnError) {
        console.log(`[Document] stale turn discarded for ${sessionKey} (epoch ${error.turnEpoch})`);
      } else if ((error as Error).message !== 'Queue cleared') {
        console.error('[Document] Agent error:', error instanceof Error ? error.message : error);
      }
    }
  } else {
    // No session or no caption — just confirm
    await messageSender.sendMessage(ctx, confirmMsg);
  }
}

/**
 * Confirm a batch of files was saved.
 */
async function sendBatchConfirmation(
  ctx: Context,
  sessionKey: string,
  files: InboxMetadata[]
): Promise<void> {
  const totalSize = files.reduce((sum, f) => sum + f.fileSize, 0);
  const sizeStr = formatFileSize(totalSize);

  const fileList = files
    .map((f, i) => `${i + 1}. **${f.originalFilename}** (${formatFileSize(f.fileSize)})`)
    .join('\n');

  const confirmMsg = [
    `${files.length} documents saved to INBOX (${sizeStr} total)`,
    ``,
    fileList,
    ``,
    `All files are in the INBOX. Send me a message when you want to review and route them.`,
  ].join('\n');

  await messageSender.sendMessage(ctx, confirmMsg);
}

/** Clear all pending batch timers — called during graceful shutdown. */
export function clearAllBatchTimers(): void {
  for (const [, batch] of batchStates) {
    if (batch.timer) clearTimeout(batch.timer);
  }
  batchStates.clear();
}
