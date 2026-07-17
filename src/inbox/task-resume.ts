import type { Bot, Context } from 'grammy';
import { queueRequest } from '../claude/request-queue.js';
import { sendToAgent } from '../claude/agent.js';
import { claimInterruptedTask, completeTask, failTask, getOpenTask } from './task-ledger.js';
import { parseSessionKey } from '../utils/session-key.js';
import { splitMessage } from '../telegram/markdown.js';

/** Explicit user approval is required; the CAS claim prevents double execution. */
export async function resumeOpenTask(ctx: Context, bot: Bot, taskId: number, options: { callbackAlreadyAnswered?: boolean } = {}): Promise<void> {
  const task = getOpenTask(taskId);
  if (!task) {
    if (!options.callbackAlreadyAnswered) await ctx.answerCallbackQuery({ text: 'Dieser Auftrag ist bereits erledigt oder nicht verfügbar.' });
    return;
  }
  if (!claimInterruptedTask(taskId)) {
    if (!options.callbackAlreadyAnswered) await ctx.answerCallbackQuery({ text: 'Dieser Auftrag wird bereits fortgesetzt.' });
    return;
  }
  if (!options.callbackAlreadyAnswered) await ctx.answerCallbackQuery({ text: 'Auftrag wird fortgesetzt.' });
  const prompt = [
    'The user explicitly approved resuming an interrupted task.',
    `Task kind: ${task.taskKind}`,
    `Original instruction summary: ${task.summary}`,
    'Continue safely. Do not execute any irreversible mutation without a fresh explicit confirmation.',
  ].join('\n');
  const { chatId, threadId } = parseSessionKey(task.sessionKey);
  try {
    const response = await queueRequest(task.sessionKey, prompt, (turnEpoch) =>
      sendToAgent(task.sessionKey, prompt, { turnEpoch }),
    );
    const text = response?.text?.trim();
    if (!text) throw new Error('resume produced no response');
    const sendOpts = threadId === undefined ? {} : { message_thread_id: threadId };
    for (const chunk of splitMessage(`↩️ Fortsetzung des offenen Auftrags:\n\n${text}`)) {
      await bot.api.sendMessage(chatId, chunk, sendOpts);
    }
    completeTask(taskId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failTask(taskId, `resume_failed:${reason}`);
    try { await bot.api.sendMessage(chatId, '⚠️ Die Fortsetzung ist fehlgeschlagen. Der Auftrag bleibt sichtbar im Ledger.', threadId === undefined ? {} : { message_thread_id: threadId }); } catch { /* failure remains durable */ }
  }
}
