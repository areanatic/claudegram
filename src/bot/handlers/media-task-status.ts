import type { Context } from 'grammy';
import { taskRetryActionKeyboard } from '../../telegram/action-buttons.js';

/** Visible lifecycle notices for durable caption jobs. The task itself was
 * already written by task-ledger.middleware before this handler starts. */
export async function announceMediaTaskAccepted(ctx: Context, taskId: number | null, kind: string): Promise<void> {
  if (taskId == null) return;
  await ctx.reply(`⏳ ${kind} angenommen (Auftrag #${taskId}). Ich speichere die Datei und führe den Caption-Auftrag aus.`, {
    parse_mode: undefined,
  });
}

export async function announceMediaTaskFailure(
  ctx: Context,
  sessionKey: string,
  taskId: number | null,
  reason: string,
): Promise<void> {
  const suffix = taskId == null ? '' : ` Auftrag #${taskId} bleibt sichtbar.`;
  await ctx.reply(`⚠️ Medienauftrag fehlgeschlagen: ${reason}.${suffix}`, {
    parse_mode: undefined,
    ...(taskId == null ? {} : { reply_markup: taskRetryActionKeyboard(ctx, sessionKey, taskId) }),
  });
}
