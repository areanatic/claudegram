import { Context } from 'grammy';
import { config } from '../config.js';
import { getSessionKeyFromCtx } from '../utils/session-key.js';
import { queueRequest, setAbortController } from '../claude/request-queue.js';
import { sendToAgent } from '../claude/agent.js';
import { messageSender } from './message-sender.js';
import { maybeSendVoiceReply } from '../tts/voice-reply.js';
import { sanitizeError } from '../utils/sanitize.js';
import { escapeMarkdownV2 as esc } from './markdown.js';

// Track active follow-up button messages so we can dismiss them
const activeButtons = new Map<string, { chatId: number; messageId: number }>();

/**
 * Build inline keyboard from Claude-provided button labels.
 * Buttons are laid out in rows of 2 (2x2 for 4 buttons, etc.).
 */
function buildFollowUpKeyboard(buttons: string[]) {
  if (!config.FOLLOWUP_BUTTONS_ENABLED) return undefined;
  if (!buttons || buttons.length < 2) return undefined;

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(
      buttons.slice(i, i + 2).map((label, j) => ({
        text: label,
        callback_data: `followup:${i + j}:${label.slice(0, 30)}`,
      }))
    );
  }

  return { inline_keyboard: rows };
}

/**
 * Send follow-up buttons as a separate message after the response.
 * Only shows buttons when Claude provides them via [BUTTONS: ...] markup.
 */
export async function sendFollowUpButtons(
  ctx: Context,
  sessionKey: string,
  responseText?: string,
  buttons?: string[],
): Promise<void> {
  try {
    if (!buttons || buttons.length < 2) return;

    const keyboard = buildFollowUpKeyboard(buttons);
    if (!keyboard) return;

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // Dismiss any previous buttons first
    await dismissFollowUpButtons(ctx, sessionKey);

    const msg = await ctx.reply('👆', {
      parse_mode: undefined,
      reply_markup: keyboard,
    });

    activeButtons.set(sessionKey, { chatId, messageId: msg.message_id });
  } catch (error) {
    console.debug('[FollowUp] Failed to send buttons:', error instanceof Error ? error.message : error);
  }
}

/**
 * Dismiss (delete) stale follow-up buttons when user sends a new message.
 */
export async function dismissFollowUpButtons(ctx: Context, sessionKey: string): Promise<void> {
  const entry = activeButtons.get(sessionKey);
  if (!entry) return;

  activeButtons.delete(sessionKey);

  try {
    await ctx.api.deleteMessage(entry.chatId, entry.messageId);
  } catch {
    // Message may already be deleted — ignore
  }
}

/**
 * Handle follow-up button presses. Registered in bot.ts callback router.
 * callback_data format: "followup:{index}:{label}"
 */
export async function handleFollowUpCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('followup:')) return;

  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) {
    await ctx.answerCallbackQuery({ text: 'Session expired' });
    return;
  }
  const { sessionKey } = keyInfo;

  // Extract the label from callback_data
  // Format: "followup:{index}:{label}"
  const parts = data.split(':');
  const label = parts.slice(2).join(':') || 'OK';

  // Answer callback IMMEDIATELY to stop the pulsing indicator (Telegram 10s timeout)
  await ctx.answerCallbackQuery({ text: label.slice(0, 30) });

  // Remove the buttons message
  try {
    const msg = ctx.callbackQuery?.message;
    if (msg) {
      await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
      activeButtons.delete(sessionKey);
    }
  } catch { /* ignore */ }

  // Send the button label as user message to Claude
  try {
    await queueRequest(sessionKey, label, async () => {
      await messageSender.startStreaming(ctx);
      const abortController = new AbortController();
      setAbortController(sessionKey, abortController);
      try {
        const response = await sendToAgent(sessionKey, label, {
          onProgress: (text) => { messageSender.updateStream(ctx, text); },
          abortController,
          telegramCtx: ctx,
        });
        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
        await sendFollowUpButtons(ctx, sessionKey, response.text, response.buttons);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = sanitizeError(error);
    console.error('[FollowUp] Callback error:', errorMessage);
    try {
      await ctx.reply(`⚠️ ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    } catch { /* best-effort */ }
  }
}
