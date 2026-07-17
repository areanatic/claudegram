import { Context, NextFunction } from 'grammy';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { acceptTask, completeAcceptedTask, failTask, type TaskInput } from '../../inbox/task-ledger.js';

const taskIdByMessage = new Map<string, number>();
const key = (chatId: number, messageId: number) => `${chatId}:${messageId}`;
export function getTaskLedgerId(chatId: number | undefined, messageId: number | undefined): number | null {
  return chatId == null || messageId == null ? null : taskIdByMessage.get(key(chatId, messageId)) ?? null;
}
function classify(ctx: Context): Omit<TaskInput, 'messageId' | 'chatId' | 'sessionKey'> | null {
  const msg = ctx.message;
  if (!msg) return null;
  if (msg.voice) return { inputType: 'voice', text: null, fileId: msg.voice.file_id };
  if (msg.audio) return { inputType: 'audio', text: null, fileId: msg.audio.file_id };
  if (msg.photo?.length) return { inputType: 'photo', text: msg.caption ?? null, fileId: msg.photo.at(-1)?.file_id ?? null };
  if (msg.document) return { inputType: 'document', text: msg.caption ?? null, fileId: msg.document.file_id };
  if (typeof msg.text === 'string') return { inputType: 'text', text: msg.text, fileId: null };
  return null;
}
export async function taskLedgerMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const item = classify(ctx); const info = getSessionKeyFromCtx(ctx); const chatId = ctx.chat?.id; const messageId = ctx.message?.message_id;
  const isCommand = item?.inputType === 'text' && item.text?.startsWith('/');
  let taskId: number | null = null;
  if (item && info && chatId != null && messageId != null && !isCommand) {
    try {
      taskId = acceptTask({ ...item, chatId, messageId, sessionKey: info.sessionKey });
      if (taskIdByMessage.size >= 500) taskIdByMessage.delete(taskIdByMessage.keys().next().value!);
      taskIdByMessage.set(key(chatId, messageId), taskId);
    } catch (error) {
      console.error('[TaskLedger] rejecting unpersisted task:', error);
      try { await ctx.reply('⚠️ Ich konnte deinen Auftrag nicht sicher annehmen (Auftragsledger nicht verfügbar). Bitte nicht erneut senden, bis ich das bestätigt habe.', { parse_mode: undefined }); } catch { /* logged above */ }
      return;
    }
  }
  try { await next(); completeAcceptedTask(taskId); }
  catch (error) { failTask(taskId, error instanceof Error ? error.message : String(error)); throw error; }
}
