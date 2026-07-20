import { Context, Api, InputFile, GrammyError } from 'grammy';
import { config } from '../config.js';
import { processMessageForTelegram, escapeMarkdownV2, splitMessage } from './markdown.js';
import { shouldUseTelegraph, createTelegraphPage, createTelegraphFromFile } from './telegraph.js';
import { isTerminalUIEnabled } from './terminal-settings.js';
import {
  getSpinnerFrame,
  getToolIcon,
  renderStatusLine,
  extractToolDetail,
  TOOL_ICONS,
  getAnimationEmoji,
  getAnimationText,
} from './terminal-renderer.js';
import { getSessionKeyFromCtx } from '../utils/session-key.js';
import * as fs from 'fs';
import * as path from 'path';

export interface ToolOperation {
  name: string;
  detail?: string;
}

/** A Telegram API delivery was not confirmed by Telegram after all safe fallbacks. */
export class TelegramDeliveryError extends Error {
  readonly name = 'TelegramDeliveryError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

interface StreamState {
  chatId: number;
  threadId?: number;
  sessionKey: string;
  messageId: number | null;
  content: string;
  lastUpdate: number;
  updateScheduled: boolean;
  typingInterval: NodeJS.Timeout | null;
  // Terminal UI mode additions
  terminalMode: boolean;
  spinnerIndex: number;
  spinnerInterval: NodeJS.Timeout | null;
  currentOperation: ToolOperation | null;
  backgroundTasks: Array<{ name: string; status: 'running' | 'complete' | 'error' }>;
  rateLimitedUntil: number;
}

/**
 * Split text on [SPLIT] markers, but only outside of code blocks (``` ... ```).
 * Returns the original single-element array if no valid split points found.
 */
function splitOnSplitMarker(text: string): string[] {
  const lines = text.split('\n');
  const parts: string[] = [];
  let current = '';
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      current += line + '\n';
    } else if (!inCodeBlock && line.trim() === '[SPLIT]') {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += line + '\n';
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(p => p.length > 0);
}

const TYPING_INTERVAL_MS = 4000; // Send typing every 4 seconds
const MIN_EDIT_INTERVAL_MS = 10000; // Minimum time between message edits (~5 edits/min safe zone)

export class MessageSender {
  private streamStates: Map<string, StreamState> = new Map();

  /**
   * Send a message with hybrid approach:
   * - Short content: MarkdownV2 inline
   * - Long content or tables: Telegraph page link
   */
  async sendMessage(ctx: Context, text: string): Promise<void> {
    // Handle [SPLIT] marker — send each part as a separate Telegram message bubble
    // Code-block-aware: [SPLIT] inside ``` blocks is ignored
    if (text.includes('[SPLIT]')) {
      const parts = splitOnSplitMarker(text);
      if (parts.length > 1) {
        for (const part of parts) {
          await this.sendMessage(ctx, part);
        }
        return;
      }
    }

    const keyInfo = getSessionKeyFromCtx(ctx);
    // Check if we should use Telegraph for this content
    if (shouldUseTelegraph(text, keyInfo?.sessionKey)) {
      const pageUrl = await createTelegraphPage('Claude Response', text);

      if (pageUrl) {
        // Send Telegraph link with a brief summary
        const summary = text.substring(0, 200).replace(/[#*_`\[\]]/g, '') + '...';
        const message = `📄 *Full response available:*\n\n${escapeMarkdownV2(summary)}\n\n[Open in Instant View](${escapeMarkdownV2(pageUrl)})`;

        try {
          await ctx.reply(message, { parse_mode: 'MarkdownV2' });
          return;
        } catch (error) {
          console.error('[Telegraph] Failed to send link, falling back to chunks:', error);
        }
      }
    }

    // Default: MarkdownV2 with chunking
    const parts = processMessageForTelegram(text, config.MAX_MESSAGE_LENGTH);

    let sentCount = 0; // T4: track successfully sent MarkdownV2 parts
    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: 'MarkdownV2' });
        sentCount++;
      } catch (error) {
        // MarkdownV2 failed — re-split original text and send REMAINING chunks as plain.
        // Use sentCount to skip already-delivered content and avoid duplicate messages.
        console.error('MarkdownV2 send failed, falling back to plain text:', error);
        const plainChunks = splitMessage(text);
        for (let i = sentCount; i < plainChunks.length; i++) {
          try {
            await ctx.reply(plainChunks[i], { parse_mode: undefined });
          } catch (plainErr) {
            console.error('[sendMessage] Plain text fallback failed:', plainErr);
            throw new TelegramDeliveryError(`Telegram did not confirm response chunk ${i + 1}/${plainChunks.length}.`, plainErr);
          }
        }
        // Already sent remaining content as plain — skip remaining MarkdownV2 parts
        return;
      }
    }
  }

  /**
   * Send a file as a document attachment
   */
  async sendDocument(ctx: Context, filePath: string, caption?: string): Promise<boolean> {
    try {
      if (!fs.existsSync(filePath)) {
        console.error('[Document] File not found:', filePath);
        return false;
      }

      const fileName = path.basename(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const inputFile = new InputFile(fileBuffer, fileName);

      await ctx.replyWithDocument(inputFile, {
        caption: caption ? escapeMarkdownV2(caption) : undefined,
        parse_mode: caption ? 'MarkdownV2' : undefined
      });

      return true;
    } catch (error) {
      console.error('[Document] Failed to send:', error);
      return false;
    }
  }

  /**
   * Send a markdown file with Telegraph preview option
   */
  async sendMarkdownFile(
    ctx: Context,
    filePath: string,
    options: { useTelegraph?: boolean; sendAsDocument?: boolean } = {}
  ): Promise<boolean> {
    const { useTelegraph = true, sendAsDocument = false } = options;

    try {
      if (!fs.existsSync(filePath)) {
        console.error('[Markdown] File not found:', filePath);
        return false;
      }

      const fileName = path.basename(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');

      // Option 1: Telegraph (Instant View)
      if (useTelegraph) {
        const pageUrl = await createTelegraphFromFile(filePath);

        if (pageUrl) {
          const message = `📄 *${escapeMarkdownV2(fileName)}*\n\n[Open in Instant View](${escapeMarkdownV2(pageUrl)})`;

          await ctx.reply(message, { parse_mode: 'MarkdownV2' });

          // Also send as document if requested
          if (sendAsDocument) {
            await this.sendDocument(ctx, filePath, 'Download file');
          }

          return true;
        }
      }

      // Option 2: Send as document
      if (sendAsDocument) {
        return await this.sendDocument(ctx, filePath, `📎 ${fileName}`);
      }

      // Option 3: Send content inline
      await this.sendMessage(ctx, content);
      return true;
    } catch (error) {
      console.error('[Markdown] Failed to send:', error);
      return false;
    }
  }

  async startStreaming(ctx: Context): Promise<void> {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) {
      console.error('[Stream] startStreaming: no keyInfo from ctx');
      return;
    }
    const { chatId, threadId, sessionKey } = keyInfo;

    const terminalMode = isTerminalUIEnabled(sessionKey);
    const initialText = `${getSpinnerFrame(0)} ${getAnimationEmoji()} ${getAnimationText()}`;
    console.log(`[Stream] startStreaming: sending initial message to chat ${chatId}`);
    const message = await ctx.reply(initialText, { parse_mode: undefined });
    console.log(`[Stream] startStreaming: got message_id ${message.message_id}`);

    // Start continuous typing indicator
    const typingInterval = this.startTypingIndicator(ctx.api, chatId, threadId);

    const state: StreamState = {
      chatId,
      threadId,
      sessionKey,
      messageId: message.message_id,
      content: '',
      lastUpdate: Date.now(),
      updateScheduled: false,
      typingInterval,
      // Terminal UI mode
      terminalMode,
      spinnerIndex: 0,
      spinnerInterval: null,
      currentOperation: null,
      backgroundTasks: [],
      rateLimitedUntil: 0,
    };

    this.streamStates.set(sessionKey, state);
  }

  private stopSpinnerAnimation(state: StreamState): void {
    if (state.spinnerInterval) {
      clearInterval(state.spinnerInterval);
      state.spinnerInterval = null;
    }
  }

  startTypingIndicator(api: Api, chatId: number, threadId?: number): NodeJS.Timeout {
    const opts = threadId !== undefined ? { message_thread_id: threadId } : {};
    // Send typing immediately
    api.sendChatAction(chatId, 'typing', opts).catch(() => {});

    // Then send every TYPING_INTERVAL_MS
    return setInterval(() => {
      api.sendChatAction(chatId, 'typing', opts).catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  private stopTypingIndicator(state: StreamState): void {
    if (state.typingInterval) {
      clearInterval(state.typingInterval);
      state.typingInterval = null;
    }
  }

  stopTypingInterval(interval: NodeJS.Timeout): void {
    clearInterval(interval);
  }

  /**
   * Update the current tool operation (terminal UI mode).
   * Event-driven: triggers a status message edit on each tool change.
   */
  updateToolOperation(sessionKey: string, toolName: string, input?: Record<string, unknown>, ctx?: Context): void {
    const state = this.streamStates.get(sessionKey);
    if (!state || !state.terminalMode) return;

    const detail = input ? extractToolDetail(toolName, input) : undefined;
    state.currentOperation = { name: toolName, detail };
    state.spinnerIndex += 1;

    if (ctx) {
      this.flushTerminalUpdate(ctx, state).catch(() => {});
    }
  }

  /**
   * Clear the current tool operation (terminal UI mode)
   */
  clearToolOperation(sessionKey: string): void {
    const state = this.streamStates.get(sessionKey);
    if (!state) return;
    state.currentOperation = null;
  }

  /**
   * Add or update a background task status (terminal UI mode)
   */
  updateBackgroundTask(sessionKey: string, taskName: string, status: 'running' | 'complete' | 'error'): void {
    const state = this.streamStates.get(sessionKey);
    if (!state || !state.terminalMode) return;

    const existing = state.backgroundTasks.find(t => t.name === taskName);
    if (existing) {
      existing.status = status;
    } else {
      state.backgroundTasks.push({ name: taskName, status });
    }
  }

  private async flushTerminalUpdate(ctx: Context, state: StreamState): Promise<void> {
    // Verify state is still active
    const currentState = this.streamStates.get(state.sessionKey);
    if (!currentState || currentState !== state || !state.messageId || !state.terminalMode) {
      return;
    }

    // Respect Telegram's retry_after backoff on 429
    const now = Date.now();
    if (now < state.rateLimitedUntil) {
      return;
    }

    // Throttle edits to avoid rate limits
    const timeSinceLastUpdate = now - state.lastUpdate;
    if (timeSinceLastUpdate < MIN_EDIT_INTERVAL_MS) {
      return;
    }

    const parts: string[] = [];

    // Add status line if there's a current operation
    if (state.currentOperation) {
      const icon = getToolIcon(state.currentOperation.name);
      const action = this.getToolAction(state.currentOperation.name);
      const detail = state.currentOperation.detail ? ` ${state.currentOperation.detail}` : '';
      parts.push(renderStatusLine(state.spinnerIndex, icon, action, detail ? detail.trim() : undefined));
    }

    // Add background tasks (cap display to prevent exceeding Telegram's 4096-char limit)
    const activeTasks = state.backgroundTasks.filter(t => t.status !== 'complete' && t.status !== 'error');
    const finishedTasks = state.backgroundTasks.filter(t => t.status === 'complete' || t.status === 'error');
    const displayTasks = [...activeTasks, ...finishedTasks.slice(-3)].slice(0, 8);
    if (displayTasks.length > 0) {
      if (state.currentOperation) parts.push('');
      for (const task of displayTasks) {
        const statusIcon = task.status === 'complete' ? TOOL_ICONS.complete
          : task.status === 'error' ? TOOL_ICONS.error
          : getSpinnerFrame(state.spinnerIndex);
        parts.push(`${TOOL_ICONS.Task} ${task.name} ${statusIcon}`);
      }
    }

    // If nothing to show, show thinking indicator
    if (parts.length === 0) {
      parts.push(`${getSpinnerFrame(state.spinnerIndex)} ${getAnimationEmoji()} ${getAnimationText()}`);
    }

    const displayContent = parts.join('\n');

    try {
      await ctx.api.editMessageText(
        state.chatId,
        state.messageId,
        displayContent,
        { parse_mode: undefined }
      );
      state.lastUpdate = Date.now();
    } catch (error: unknown) {
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = error.parameters.retry_after ?? 60;
        state.rateLimitedUntil = Date.now() + retryAfter * 1000;
        console.warn(`[Terminal] Rate limited, backing off for ${retryAfter}s (session:${state.sessionKey})`);
        return;
      }
      // Ignore "message not modified" and "message ID invalid" errors
      // The latter happens when streaming ends and message is replaced
      if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        if (!msg.includes('message is not modified') && !msg.includes('message_id_invalid')) {
          console.error('Error updating terminal stream:', error);
        }
      }
    }
  }

  private getToolAction(toolName: string): string {
    const actions: Record<string, string> = {
      Read: 'Reading',
      Write: 'Writing',
      Edit: 'Editing',
      Bash: 'Running',
      Grep: 'Searching',
      Glob: 'Finding files',
      Task: 'Running task',
      WebFetch: 'Fetching',
      WebSearch: 'Searching web',
      NotebookEdit: 'Editing notebook',
    };
    return actions[toolName] || toolName;
  }

  /**
   * Accumulate streamed text content internally without triggering Telegram edits.
   * The full content is only displayed when finishStreaming() is called.
   */
  updateStream(_ctx: Context, content: string): void {
    const keyInfo = getSessionKeyFromCtx(_ctx);
    if (!keyInfo) return;

    const state = this.streamStates.get(keyInfo.sessionKey);
    if (!state || !state.messageId) return;

    state.content = content;
  }

  async finishStreaming(ctx: Context, finalContent: string): Promise<void> {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) {
      throw new TelegramDeliveryError('Cannot confirm streamed delivery without a Telegram session key.');
    }
    const { chatId, sessionKey, threadId } = keyInfo;
    // Forum-topic awareness (2026-06-04): the raw error-fallback notices below
    // use ctx.api.sendMessage (no ctx auto-attach) → thread them explicitly so a
    // failure notice lands in the originating topic. undefined → byte-identical.
    const sendOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
    console.log(`[Stream] finishStreaming: chat=${chatId}, content length=${finalContent.length}`);

    const state = this.streamStates.get(sessionKey);

    // Handle [SPLIT] — delete streaming placeholder, send each part as a separate bubble
    // Code-block-aware: [SPLIT] inside ``` blocks is ignored
    if (finalContent.includes('[SPLIT]')) {
      const splitParts = splitOnSplitMarker(finalContent);
      if (splitParts.length > 1) {
        if (state) {
          this.stopTypingIndicator(state);
          this.stopSpinnerAnimation(state);
          if (state.messageId) {
            try { await ctx.api.deleteMessage(chatId, state.messageId); } catch { /* ignore */ }
          }
          this.streamStates.delete(sessionKey);
        }
        for (const part of splitParts) {
          await this.sendMessage(ctx, part);
        }
        return;
      }
    }

    if (state) {
      // Stop typing indicator and spinner
      this.stopTypingIndicator(state);
      this.stopSpinnerAnimation(state);
      state.currentOperation = null;

      if (state.messageId) {
        // Check if we should use Telegraph for final content
        if (shouldUseTelegraph(finalContent, sessionKey)) {
          const pageUrl = await createTelegraphPage('Claude Response', finalContent);

          if (pageUrl) {
            try {
              const summary = finalContent.substring(0, 200).replace(/[#*_`\[\]]/g, '') + '...';
              const message = `📄 *Response ready:*\n\n${escapeMarkdownV2(summary)}\n\n[Open in Instant View](${escapeMarkdownV2(pageUrl)})`;

              await ctx.api.editMessageText(
                chatId,
                state.messageId,
                message,
                { parse_mode: 'MarkdownV2' }
              );

              this.streamStates.delete(sessionKey);
              return;
            } catch (error) {
              console.error('[Telegraph] Failed, falling back to chunks:', error);
            }
          }
        }

        // Default: MarkdownV2 with chunking
        const parts = processMessageForTelegram(finalContent, config.MAX_MESSAGE_LENGTH);

        try {
          // Update the first message with first part (use MarkdownV2)
          const firstPart = parts[0] || 'Done\\.';

          try {
            await ctx.api.editMessageText(
              chatId,
              state.messageId,
              firstPart,
              { parse_mode: 'MarkdownV2' }
            );

            // Send additional messages for remaining parts
            for (let i = 1; i < parts.length; i++) {
              try {
                await ctx.reply(parts[i], { parse_mode: 'MarkdownV2' });
              } catch (partError) {
                console.error(`MarkdownV2 failed for part ${i + 1}:`, partError);
                try {
                  await ctx.reply(parts[i], { parse_mode: undefined });
                } catch (plainErr) {
                  console.error(`Plain text fallback also failed for part ${i + 1}:`, plainErr);
                  throw new TelegramDeliveryError(`Telegram did not confirm streamed response chunk ${i + 1}/${parts.length}.`, plainErr);
                }
              }
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          } catch (mdError) {
            // "message is not modified" means the content already matches — treat as success
            const errMsg = mdError instanceof Error ? mdError.message : '';
            if (errMsg.includes('message is not modified')) {
              console.debug('[Stream] Edit skipped — content unchanged');
            } else {
              // MarkdownV2 failed — delete streaming placeholder and
              // re-send via sendMessage which handles Telegraph + chunking
              console.error('MarkdownV2 edit failed, falling back to sendMessage:', mdError);
              try {
                await ctx.api.deleteMessage(chatId, state.messageId);
              } catch { /* ignore */ }

              this.streamStates.delete(sessionKey);
              try {
                await this.sendMessage(ctx, finalContent);
                return;
              } catch (sendErr) {
                console.error('[Stream] sendMessage fallback failed:', sendErr);
                throw new TelegramDeliveryError('Telegram did not confirm the streamed response.', sendErr);
              }
            }
          }
        } catch (error) {
          console.error('Error finishing stream:', error);
          throw error instanceof TelegramDeliveryError
            ? error
            : new TelegramDeliveryError('Telegram did not confirm the streamed response.', error);
        }
      }
    }

    this.streamStates.delete(sessionKey);
    if (!state?.messageId) {
      throw new TelegramDeliveryError('Telegram stream placeholder was unavailable; response delivery is unconfirmed.');
    }
  }

  async cancelStreaming(ctx: Context): Promise<void> {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;
    const { chatId, sessionKey } = keyInfo;

    const state = this.streamStates.get(sessionKey);
    if (state) {
      // Stop typing indicator and spinner
      this.stopTypingIndicator(state);
      this.stopSpinnerAnimation(state);

      if (state.messageId) {
        try {
          await ctx.api.editMessageText(
            chatId,
            state.messageId,
            '⚠️ Request cancelled',
            { parse_mode: undefined }
          );
        } catch (error) {
          console.error('Error cancelling stream:', error);
        }
      }
    }

    this.streamStates.delete(sessionKey);
  }

  // Send typing indicator for a specific chat (useful for long operations)
  async sendTyping(ctx: Context): Promise<void> {
    try {
      await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
    } catch (error) {
      console.error('Error sending typing:', error);
    }
  }
}

export const messageSender = new MessageSender();
