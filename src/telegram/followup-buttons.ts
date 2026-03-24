import { Context } from 'grammy';
import { config } from '../config.js';
import { getSessionKeyFromCtx } from '../utils/session-key.js';
import { queueRequest } from '../claude/request-queue.js';
import { sendToAgent } from '../claude/agent.js';
import { messageSender } from './message-sender.js';
import { maybeSendVoiceReply } from '../tts/voice-reply.js';

// Track active follow-up button messages so we can dismiss them
const activeButtons = new Map<string, { chatId: number; messageId: number }>();

// Keywords that indicate a yes/no decision question (German + English)
const YES_NO_PATTERNS = [
  /soll ich/i,
  /möchtest du/i,
  /willst du/i,
  /kann ich/i,
  /darf ich/i,
  /wollen wir/i,
  /shall i/i,
  /should i/i,
  /want me to/i,
  /do you want/i,
  /would you like/i,
  /can i/i,
  /may i/i,
];

// Phrases to EXCLUDE — rhetorical or open-ended questions
const BLACKLIST_PATTERNS = [
  /was meinst du/i,
  /was denkst du/i,
  /hast du noch fragen/i,
  /what do you think/i,
  /any questions/i,
  /how does that sound/i,
];

/**
 * Detect if the last paragraph of the response is a yes/no decision question.
 * Returns true only for actionable questions like "Soll ich X machen?"
 */
function isYesNoQuestion(responseText: string): boolean {
  // Get the last meaningful paragraph
  const paragraphs = responseText.trim().split(/\n\n+/);
  const lastParagraph = paragraphs[paragraphs.length - 1]?.trim() || '';

  // Must end with a question mark
  if (!lastParagraph.endsWith('?')) return false;

  // Check blacklist first
  for (const pattern of BLACKLIST_PATTERNS) {
    if (pattern.test(lastParagraph)) return false;
  }

  // Check if it matches a yes/no pattern
  for (const pattern of YES_NO_PATTERNS) {
    if (pattern.test(lastParagraph)) return true;
  }

  return false;
}

/**
 * Build contextual inline keyboard based on the response content.
 * Returns undefined if no buttons should be shown.
 */
function buildFollowUpKeyboard(responseText: string) {
  if (!config.FOLLOWUP_BUTTONS_ENABLED) return undefined;

  // Only show buttons for yes/no decision questions
  if (!isYesNoQuestion(responseText)) return undefined;

  return {
    inline_keyboard: [
      [
        { text: '✅ Ja, mach das', callback_data: 'followup:yes' },
        { text: '❌ Nein', callback_data: 'followup:no' },
      ],
    ],
  };
}

/**
 * Send follow-up buttons as a separate message after the response.
 * Only shows buttons when Claude asks a yes/no decision question.
 * Wrapped in try/catch — buttons are non-critical, failures are silent.
 */
export async function sendFollowUpButtons(ctx: Context, sessionKey: string, responseText?: string): Promise<void> {
  try {
    if (!responseText) return;

    const keyboard = buildFollowUpKeyboard(responseText);
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
 */
export async function handleFollowUpCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) {
    await ctx.answerCallbackQuery({ text: 'Session expired' });
    return;
  }
  const { sessionKey } = keyInfo;

  // Remove the buttons message immediately
  try {
    const msg = ctx.callbackQuery?.message;
    if (msg) {
      await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
      activeButtons.delete(sessionKey);
    }
  } catch { /* ignore */ }

  if (data === 'followup:yes') {
    await ctx.answerCallbackQuery({ text: '✅' });

    await queueRequest(sessionKey, 'Ja, bitte machen.', async () => {
      await messageSender.startStreaming(ctx);
      try {
        const response = await sendToAgent(sessionKey, 'Ja, bitte machen.', {
          onProgress: (text) => { messageSender.updateStream(ctx, text); },
          telegramCtx: ctx,
        });
        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
        await sendFollowUpButtons(ctx, sessionKey, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    });

  } else if (data === 'followup:no') {
    await ctx.answerCallbackQuery({ text: '❌' });

    await queueRequest(sessionKey, 'Nein, lass das bitte.', async () => {
      await messageSender.startStreaming(ctx);
      try {
        const response = await sendToAgent(sessionKey, 'Nein, lass das bitte.', {
          onProgress: (text) => { messageSender.updateStream(ctx, text); },
          telegramCtx: ctx,
        });
        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
        await sendFollowUpButtons(ctx, sessionKey, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    });

  } else {
    await ctx.answerCallbackQuery({ text: 'Unknown action' });
  }
}
