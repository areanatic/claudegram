import { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../../config.js';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { messageSender } from '../../telegram/message-sender.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage, shouldNotifyStale, getStaleAgeMinutes } from '../middleware/stale-filter.js';
import {
  queueRequest,
  isProcessing,
  getQueuePosition,
  setAbortController,
} from '../../claude/request-queue.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';
import { getStreamingMode } from './command.handler.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import { transcribeFile, transcribeFileWithLanguage } from '../../audio/transcribe.js';
import { setVoiceFirstMode, setDetectedLanguage, isVoiceActive } from '../../tts/tts-settings.js';
import { sendTranscriptResult } from './command.handler.js';
import { downloadFileSecure, getTelegramFileUrl } from '../../utils/download.js';
import { sanitizeError, sanitizePath } from '../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { sendFollowUpButtons, dismissFollowUpButtons } from '../../telegram/followup-buttons.js';

export async function handleVoice(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  const voice = ctx.message?.voice;

  if (!keyInfo || !messageId || !messageDate || !voice) return;
  const { chatId, sessionKey } = keyInfo;

  // Stale/duplicate filters
  if (isStaleMessage(messageDate)) {
    console.log(`[Voice] Ignoring stale voice message ${messageId}`);
    if (shouldNotifyStale(sessionKey)) {
      const mins = getStaleAgeMinutes(messageDate);
      try {
        await ctx.reply(`⚡ Ich war kurz offline. Deine Nachricht von vor ~${mins} Minute${mins === 1 ? '' : 'n'} habe ich leider verpasst — bitte schick sie nochmal!`);
      } catch { /* ignore — notification is best-effort */ }
    }
    return;
  }
  if (isDuplicate(messageId)) {
    console.log(`[Voice] Ignoring duplicate voice message ${messageId}`);
    return;
  }
  markProcessed(messageId);

  // Dismiss previous follow-up buttons
  await dismissFollowUpButtons(ctx, sessionKey);

  // If this is a reply to the bot's "Transcribe Audio" ForceReply, route to transcribe-only flow
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from?.is_bot) {
    const replyText = (replyTo as { text?: string }).text || '';
    if (replyText.includes('Transcribe Audio')) {
      await handleTranscribeOnly(ctx, chatId, messageId, voice);
      return;
    }
  }

  // Check session — auto-resume from disk if bot restarted
  const session = sessionManager.getOrResumeSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nUse `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Check file size
  const fileSizeBytes = voice.file_size || 0;
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  if (fileSizeMB > config.VOICE_MAX_FILE_SIZE_MB) {
    await ctx.reply(
      `❌ Voice note too large \\(${esc(fileSizeMB.toFixed(1))}MB\\)\\.\n\nPlease send shorter notes \\(max ${config.VOICE_MAX_FILE_SIZE_MB}MB\\)\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Acknowledge receipt
  const ackMsg = await ctx.reply('🎤 Transcribing...', { parse_mode: undefined });

  let tempFilePath: string | null = null;

  try {
    // Download voice file from Telegram (with retry for transient network errors)
    console.log(`[Voice] Voice object: file_id=${voice.file_id}, duration=${voice.duration}s, mime=${voice.mime_type}, file_size=${voice.file_size}`);
    const file = await ctx.api.getFile(voice.file_id);
    console.log(`[Voice] getFile response: file_path=${file.file_path}, file_size=${file.file_size}`);
    if (!file.file_path) {
      throw new Error('Telegram did not provide a file path.');
    }
    const fileUrl = getTelegramFileUrl(config.TELEGRAM_BOT_TOKEN, file.file_path);

    // Download using curl with secure stdin config (prevents token exposure in ps)
    const ext = voice.mime_type?.includes('ogg') ? '.ogg' : '.oga';
    tempFilePath = path.join(os.tmpdir(), `nexusgram_voice_${messageId}${ext}`);

    console.log(`[Voice] Downloading voice: expected=${fileSizeBytes} bytes, url=${sanitizePath(fileUrl.replace(/bot[^/]+/, 'bot***'))}`);
    await downloadFileSecure(fileUrl, tempFilePath);

    const audioBuffer = fs.readFileSync(tempFilePath);
    if (!audioBuffer.length) {
      throw new Error('Downloaded empty voice file.');
    }

    // Debug: log actual file size and first bytes to diagnose Groq errors
    const actualSizeMB = audioBuffer.length / (1024 * 1024);
    const headerHex = audioBuffer.subarray(0, 8).toString('hex');
    console.log(`[Voice] Downloaded ${actualSizeMB.toFixed(3)}MB (${audioBuffer.length} bytes, expected ${fileSizeBytes}), header: ${headerHex}`);

    if (audioBuffer.length < 500) {
      console.error(`[Voice] WARNING: Downloaded file suspiciously small (${audioBuffer.length} bytes, expected ${fileSizeBytes}). Possible Telegram client upload bug.`);
      throw new Error('Voice note has no audio data (only OGG headers) — known Telegram Web/Desktop bug. Try sending from the native iOS/Android app, or just send again.');
    }

    // Transcribe using Groq Whisper API with auto language detection
    const transcribeResult = await transcribeFileWithLanguage(tempFilePath);
    const transcript = transcribeResult.text;
    const detectedLanguage = transcribeResult.languageCode;

    console.log(`[Voice] Transcript received (${transcript.length} chars, lang=${detectedLanguage})`);

    // Activate voice-first mode (if enabled in config) and store detected language
    if (config.VOICE_FIRST_MODE_ENABLED) {
      setVoiceFirstMode(sessionKey, true);
    }
    setDetectedLanguage(sessionKey, detectedLanguage);

    const voiceActive = isVoiceActive(sessionKey);

    // In voice-first mode: minimal transcript display to reduce noise
    // In normal mode: show full transcript if configured
    if (voiceActive) {
      // Show a brief inline transcript (first ~80 chars) so user knows what was heard
      const preview = transcript.length > 80 ? transcript.slice(0, 80) + '...' : transcript;
      try {
        await ctx.api.editMessageText(chatId, ackMsg.message_id, `🎤 "${preview}"`, { parse_mode: undefined });
      } catch {
        try { await ctx.api.deleteMessage(chatId, ackMsg.message_id); } catch { /* ignore */ }
      }
    } else if (config.VOICE_SHOW_TRANSCRIPT) {
      try {
        await ctx.api.editMessageText(
          chatId,
          ackMsg.message_id,
          '🎤 Transcript received\\.',
          { parse_mode: 'MarkdownV2' }
        );
      } catch {
        try { await ctx.api.deleteMessage(chatId, ackMsg.message_id); } catch { /* ignore */ }
      }

      await messageSender.sendMessage(ctx, `👤 ${transcript}`);
    } else {
      try { await ctx.api.deleteMessage(chatId, ackMsg.message_id); } catch { /* ignore */ }
    }

    // Check if already processing - show queue position
    if (isProcessing(sessionKey)) {
      const position = getQueuePosition(sessionKey) + 1;
      await ctx.reply(`⏳ Queued \\(position ${position}\\)`, { parse_mode: 'MarkdownV2' });
    }

    // Feed transcript into agent
    await queueRequest(sessionKey, transcript, async () => {
      if (voiceActive) {
        // Voice-first mode: skip streaming display, just show typing indicator
        // This reduces latency by avoiding message creation/editing overhead
        await ctx.replyWithChatAction('typing');

        const abortController = new AbortController();
        setAbortController(sessionKey, abortController);

        const response = await sendToAgent(sessionKey, transcript, {
          abortController,
          voiceMode: true,
          telegramCtx: ctx,
        });

        // Send voice reply FIRST (primary output in voice mode)
        await maybeSendVoiceReply(ctx, response.text, { language: detectedLanguage });

        // Send text as secondary reference (shorter in voice mode)
        await messageSender.sendMessage(ctx, response.text);
        await sendFollowUpButtons(ctx, sessionKey, response.text, response.buttons);
      } else if (getStreamingMode() === 'streaming') {
        await messageSender.startStreaming(ctx);

        const abortController = new AbortController();
        setAbortController(sessionKey, abortController);

        try {
          const response = await sendToAgent(sessionKey, transcript, {
            onProgress: (progressText) => {
              messageSender.updateStream(ctx, progressText);
            },
            abortController,
            telegramCtx: ctx,
          });

          await messageSender.finishStreaming(ctx, response.text);
          await maybeSendVoiceReply(ctx, response.text, { language: detectedLanguage });
          await sendFollowUpButtons(ctx, sessionKey, response.text, response.buttons);
        } catch (error) {
          await messageSender.cancelStreaming(ctx);
          throw error;
        }
      } else {
        await ctx.replyWithChatAction('typing');

        const abortController = new AbortController();
        setAbortController(sessionKey, abortController);

        const response = await sendToAgent(sessionKey, transcript, {
          abortController,
          telegramCtx: ctx,
        });
        await messageSender.sendMessage(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text, { language: detectedLanguage });
        await sendFollowUpButtons(ctx, sessionKey, response.text, response.buttons);
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;

    const errorMessage = sanitizeError(error);
    console.error('[Voice] Error:', errorMessage);

    // Try to update ack message with error
    try {
      await ctx.api.editMessageText(
        chatId,
        ackMsg.message_id,
        `❌ ${errorMessage}`,
        { parse_mode: undefined }
      );
    } catch {
      await ctx.reply(`❌ Voice error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    // Clean up temp file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        console.log(`[Voice] Cleaned up ${sanitizePath(tempFilePath)}`);
      } catch (e) {
        console.warn(`[Voice] Cleanup failed for ${sanitizePath(tempFilePath)}:`, sanitizeError(e));
      }
    }
  }
}

/**
 * Transcribe-only flow: voice note sent as reply to "Transcribe Audio" ForceReply.
 * Does NOT send transcript to the Claude agent.
 */
async function handleTranscribeOnly(
  ctx: Context,
  chatId: number,
  messageId: number,
  voice: { file_id: string; file_size?: number; mime_type?: string }
): Promise<void> {
  const ackMsg = await ctx.reply('🎤 Transcribing...', { parse_mode: undefined });

  let tempFilePath: string | null = null;

  try {
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) {
      throw new Error('Telegram did not provide a file path.');
    }
    const fileUrl = getTelegramFileUrl(config.TELEGRAM_BOT_TOKEN, file.file_path);

    const ext = voice.mime_type?.includes('ogg') ? '.ogg' : '.oga';
    tempFilePath = path.join(os.tmpdir(), `nexusgram_transcribe_${messageId}${ext}`);

    await downloadFileSecure(fileUrl, tempFilePath);

    const audioBuffer = fs.readFileSync(tempFilePath);
    if (!audioBuffer.length) {
      throw new Error('Downloaded empty voice file.');
    }

    const transcript = await transcribeFile(tempFilePath);

    // Remove ack
    try {
      await ctx.api.deleteMessage(chatId, ackMsg.message_id);
    } catch (e) {
      console.debug('[Transcribe] Failed to delete ack message:', e instanceof Error ? e.message : e);
    }

    await sendTranscriptResult(ctx, transcript);
  } catch (error) {
    const errorMessage = sanitizeError(error);
    console.error('[Transcribe] Voice ForceReply error:', errorMessage);
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `❌ ${errorMessage}`, { parse_mode: undefined });
    } catch {
      await ctx.reply(`❌ Transcription error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        console.warn(`[Transcribe] Cleanup failed for ${sanitizePath(tempFilePath)}:`, sanitizeError(e));
      }
    }
  }
}
