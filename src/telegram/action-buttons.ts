import { InlineKeyboard, type Context } from 'grammy';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { getCaptureLedger } from '../memory/capture-ledger.js';
import { completeOpenTask, discardOpenTask, getOpenTask, listOpenTasksForSession } from '../inbox/task-ledger.js';
import { resumeOpenTask } from '../inbox/task-resume.js';
import { cancelCalendarBulk, confirmCalendarBulk, configuredCalendarBulkExecutor, getCalendarBulkJob } from '../calendar/bulk.js';
import { executeFollowUpText } from './followup-buttons.js';
import type { Bot } from 'grammy';

/** Telegram permits at most 64 UTF-8 bytes of callback_data. */
export const CALLBACK_DATA_MAX_BYTES = 64;
const CALLBACK_PREFIX = 'a:';

export type ContextAction =
  | { type: 'capture-view'; captureId: string }
  | { type: 'capture-undo'; captureId: string }
  | { type: 'task-resume'; taskId: number }
  | { type: 'task-complete'; taskId: number }
  | { type: 'task-discard'; taskId: number }
  | { type: 'calendar-bulk-confirm'; jobId: string }
  | { type: 'calendar-bulk-cancel'; jobId: string }
  | { type: 'text'; text: string };

export type RegisteredAction = ContextAction & {
  userId: number;
  chatId: number;
  sessionKey: string;
};

interface StoredAction {
  action: RegisteredAction;
  state: 'ready' | 'running' | 'done';
  createdAt: number;
}

/**
 * Compact callback tokens deliberately carry no task/capture data. The payload
 * stays server-side, is scoped to one user/chat/session, and is claimed before
 * execution so a double click cannot execute a side effect twice.
 */
export class ContextActionRouter {
  private readonly actions = new Map<string, StoredAction>();

  register(action: RegisteredAction): string {
    this.prune();
    let token: string;
    do token = randomBytes(9).toString('base64url'); while (this.actions.has(token));
    const callbackData = `${CALLBACK_PREFIX}${token}`;
    if (Buffer.byteLength(callbackData, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
      throw new Error('context action callback_data exceeds Telegram 64-byte limit');
    }
    this.actions.set(token, { action, state: 'ready', createdAt: Date.now() });
    return callbackData;
  }

  async handle(
    ctx: Pick<Context, 'callbackQuery' | 'from' | 'chat' | 'answerCallbackQuery' | 'reply'>,
    execute: (action: RegisteredAction) => Promise<void>,
    callbackData?: string,
  ): Promise<boolean> {
    const data = callbackData ?? ctx.callbackQuery?.data;
    if (!data?.startsWith(CALLBACK_PREFIX)) return false;

    // Every branch answers: invalid/expired/foreign callbacks must never spin.
    const token = data.slice(CALLBACK_PREFIX.length);
    const stored = this.actions.get(token);
    if (!stored) {
      await ctx.answerCallbackQuery({ text: 'Diese Aktion ist abgelaufen.' });
      return true;
    }
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
    if (!userId || !config.ALLOWED_USER_IDS.includes(userId) || userId !== stored.action.userId || chatId !== stored.action.chatId) {
      await ctx.answerCallbackQuery({ text: 'Nicht berechtigt.' });
      return true;
    }
    if (stored.state !== 'ready') {
      await ctx.answerCallbackQuery({ text: 'Aktion wurde bereits verarbeitet.' });
      return true;
    }

    stored.state = 'running';
    await ctx.answerCallbackQuery({ text: 'Aktion wird ausgeführt.' });
    try {
      await execute(stored.action);
      stored.state = 'done';
    } catch (error) {
      // Keep the action consumed: retries of a partially executed operation are
      // unsafe. Durable task/capture state remains the source of truth.
      stored.state = 'done';
      console.error('[ContextAction] action failed:', error instanceof Error ? error.message : error);
      await ctx.reply('⚠️ Aktion konnte nicht vollständig ausgeführt werden. Der gespeicherte Status bleibt unverändert sichtbar.', { parse_mode: undefined });
    }
    return true;
  }

  /** Test-only inspection without exposing payloads to Telegram. */
  size(): number { return this.actions.size; }

  private prune(now = Date.now()): void {
    const ttlMs = 24 * 60 * 60 * 1000; // allow-hardcoded: reason="ephemeral in-memory callback token retention"
    for (const [token, item] of this.actions) {
      if (now - item.createdAt > ttlMs) this.actions.delete(token);
    }
  }
}

export const contextActionRouter = new ContextActionRouter();

function owner(ctx: Context, sessionKey: string): Pick<RegisteredAction, 'userId' | 'chatId' | 'sessionKey'> | null {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  return userId && chatId ? { userId, chatId, sessionKey } : null;
}

export function captureActionKeyboard(ctx: Context, sessionKey: string, captureId: string): InlineKeyboard | undefined {
  const scope = owner(ctx, sessionKey);
  if (!scope) return undefined;
  return new InlineKeyboard()
    .text('Anzeigen', contextActionRouter.register({ ...scope, type: 'capture-view', captureId }))
    .text('Rückgängig', contextActionRouter.register({ ...scope, type: 'capture-undo', captureId }));
}

export function openTaskActionKeyboard(ctx: Context, sessionKey: string): InlineKeyboard | undefined {
  const scope = owner(ctx, sessionKey);
  if (!scope) return undefined;
  const tasks = getOpenTaskButtons(sessionKey);
  if (!tasks.length) return undefined;
  const keyboard = new InlineKeyboard();
  for (const task of tasks) {
    keyboard.text('Fortsetzen', contextActionRouter.register({ ...scope, type: 'task-resume', taskId: task.id }))
      .text('Erledigt', contextActionRouter.register({ ...scope, type: 'task-complete', taskId: task.id }))
      .text('Verwerfen', contextActionRouter.register({ ...scope, type: 'task-discard', taskId: task.id }))
      .row();
  }
  return keyboard;
}

/** Single-task failure card used by media handlers; the retry payload remains server-side. */
export function taskRetryActionKeyboard(ctx: Context, sessionKey: string, taskId: number): InlineKeyboard | undefined {
  const scope = owner(ctx, sessionKey);
  if (!scope) return undefined;
  return new InlineKeyboard()
    .text('🔁 Erneut versuchen', contextActionRouter.register({ ...scope, type: 'task-resume', taskId }))
    .text('🗑️ Verwerfen', contextActionRouter.register({ ...scope, type: 'task-discard', taskId }));
}

export function calendarBulkActionKeyboard(ctx: Context, sessionKey: string, jobId: string): InlineKeyboard | undefined {
  const scope = owner(ctx, sessionKey);
  if (!scope) return undefined;
  return new InlineKeyboard()
    .text('Bestätigen', contextActionRouter.register({ ...scope, type: 'calendar-bulk-confirm', jobId }))
    .text('Abbrechen', contextActionRouter.register({ ...scope, type: 'calendar-bulk-cancel', jobId }));
}

/** Digest actions map to ordinary user text, never to a privileged shortcut. */
export function digestActionKeyboard(ctx: Context, sessionKey: string): InlineKeyboard | undefined {
  const scope = owner(ctx, sessionKey);
  if (!scope) return undefined;
  return new InlineKeyboard()
    .text('Vertiefen', contextActionRouter.register({ ...scope, type: 'text', text: 'Bitte vertiefe die offenen Punkte aus dem gerade gezeigten Digest.' }))
    .text('Ablegen', contextActionRouter.register({ ...scope, type: 'text', text: 'Bitte lege die offenen Punkte aus dem gerade gezeigten Digest als Überblick ab.' }));
}

/** Error/decision cards only replay text the user may also send manually. */
export function decisionActionKeyboard(ctx: Context, sessionKey: string): InlineKeyboard | undefined {
  const scope = owner(ctx, sessionKey);
  if (!scope) return undefined;
  return new InlineKeyboard()
    .text('GO', contextActionRouter.register({ ...scope, type: 'text', text: 'GO: Bitte setze den offenen Auftrag fort.' }))
    .text('Später', contextActionRouter.register({ ...scope, type: 'text', text: 'Später: Bitte behalte den offenen Auftrag im Überblick.' }))
    .text('Ignorieren', contextActionRouter.register({ ...scope, type: 'text', text: 'Ignorieren: Bitte führe den offenen Auftrag jetzt nicht fort.' }));
}

function getOpenTaskButtons(sessionKey: string) {
  // Keep the button registry aligned with the exact read surface of
  // /wo_stehen_wir: never create controls for another session's work.
  return listOpenTasksForSession(sessionKey).slice(0, 6);
}

async function executeContextAction(ctx: Context, bot: Bot, action: RegisteredAction): Promise<void> {
    switch (action.type) {
      case 'capture-view': {
        const record = getCaptureLedger().getForSession(action.captureId, action.sessionKey);
        if (!record) throw new Error('capture is unavailable');
        await ctx.reply(`💾 ${record.content}`, { parse_mode: undefined });
        return;
      }
      case 'capture-undo': {
        if (!getCaptureLedger().dismissForSession(action.captureId, action.sessionKey)) throw new Error('capture is unavailable');
        await ctx.reply('↩️ Capture wurde zurückgenommen.', { parse_mode: undefined });
        return;
      }
      case 'task-resume': {
        const task = getOpenTask(action.taskId);
        if (!task || task.sessionKey !== action.sessionKey) throw new Error('task is unavailable');
        await resumeOpenTask(ctx, bot, action.taskId, { callbackAlreadyAnswered: true });
        return;
      }
      case 'task-complete': {
        const task = getOpenTask(action.taskId);
        if (!task || task.sessionKey !== action.sessionKey || !completeOpenTask(action.taskId)) throw new Error('task is unavailable');
        await ctx.reply('✅ Auftrag als erledigt markiert.', { parse_mode: undefined });
        return;
      }
      case 'task-discard': {
        const task = getOpenTask(action.taskId);
        if (!task || task.sessionKey !== action.sessionKey || !discardOpenTask(action.taskId)) throw new Error('task is unavailable');
        await ctx.reply('🗑️ Auftrag verworfen.', { parse_mode: undefined });
        return;
      }
      case 'calendar-bulk-confirm': {
        const job = getCalendarBulkJob(action.jobId);
        if (!job || job.sessionKey !== action.sessionKey || job.chatId !== action.chatId || job.userId !== action.userId) throw new Error('calendar preview is unavailable');
        const result = await confirmCalendarBulk(job.id, configuredCalendarBulkExecutor);
        const eventResults = result.items.map((item, index) => {
          const event = result.results?.[index];
          return `• ${item.title}: ${event?.ok ? `angelegt${event.eventId ? ` (${event.eventId})` : ''}` : `fehlgeschlagen${event?.detail ? ` (${event.detail})` : ''}`}`;
        }).join('\n');
        const headline = result.state === 'completed' ? '✅ Kalender-Bulk abgeschlossen:' : `⚠️ Kalender-Bulk fehlgeschlagen: ${result.failure ?? 'unbekannter Fehler'}`;
        await ctx.reply(`${headline}\n${eventResults}`, { parse_mode: undefined });
        return;
      }
      case 'calendar-bulk-cancel': {
        const job = getCalendarBulkJob(action.jobId);
        if (!job || job.sessionKey !== action.sessionKey || job.chatId !== action.chatId || job.userId !== action.userId || cancelCalendarBulk(job.id)?.state !== 'cancelled') throw new Error('calendar preview is unavailable');
        await ctx.reply('Abgebrochen. Es wurden keine Termine verändert.', { parse_mode: undefined });
        return;
      }
      case 'text':
        await executeFollowUpText(ctx, action.sessionKey, action.text);
    }
}

/** Central typed callback router for all newly added contextual action buttons. */
export async function handleContextActionCallback(ctx: Context, bot: Bot): Promise<boolean> {
  return contextActionRouter.handle(ctx, (action) => executeContextAction(ctx, bot, action));
}

/**
 * Compatibility bridge for pre-router taskresume:<id> buttons. The legacy
 * payload is never executed directly: it is converted into a scoped router
 * action, which applies ACL and in-memory idempotency before the ledger's
 * durable CAS claim executes the retry.
 */
export async function handleLegacyTaskResumeCallback(ctx: Context, bot: Bot): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith('taskresume:')) return false;
  const taskId = Number(data.slice('taskresume:'.length));
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  const userId = ctx.from?.id;
  const task = Number.isSafeInteger(taskId) && taskId > 0 ? getOpenTask(taskId) : null;
  if (!task || !userId || !chatId || task.chatId !== chatId) {
    await ctx.answerCallbackQuery({ text: 'Ungültiger oder nicht verfügbarer Auftrag.' });
    return true;
  }
  const routed = contextActionRouter.register({
    type: 'task-resume', taskId, userId, chatId, sessionKey: task.sessionKey,
  });
  return contextActionRouter.handle(ctx, (action) => executeContextAction(ctx, bot, action), routed);
}
