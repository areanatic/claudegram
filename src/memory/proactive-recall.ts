/** Proactive recall at the start of a new user turn. */
import type { Context } from 'grammy';
import { listOpenTasksForSession, type OpenTask } from '../inbox/task-ledger.js';
import { searchTasks } from './nexus-memory.js';
import {
  getCaptureLedger,
  mergeProactiveItems,
  normalizeProactiveContent,
  type ProactiveItem,
} from './capture-ledger.js';
import { digestActionKeyboard } from '../telegram/action-buttons.js';

function formatDue(dueAtUtc: string | null): string {
  return dueAtUtc ? ` (fällig: ${dueAtUtc.slice(0, 10)})` : '';
}

function indexedOpenTasks(): ProactiveItem[] {
  // memory_tasks contains operator-private data. searchTasks applies the
  // configured scope gate and returns [] for family/test/public contexts.
  return searchTasks({ status: 'open', limit: 20 }).map((task) => ({
    key: `memory-task:${task.source_kind}:${task.source_id}`,
    text: `Offener Auftrag (Ledger): ${task.description}`,
    dueAtUtc: task.due_at_utc,
    dedupeKey: normalizeProactiveContent(task.description),
  }));
}

function taskLedgerItems(sessionKey: string, includeActive: boolean): ProactiveItem[] {
  return listOpenTasksForSession(sessionKey)
    .filter((task) => includeActive || task.state === 'interrupted' || task.state === 'failed')
    .map((task: OpenTask) => ({
      key: `task-ledger:${task.id}`,
      text: `${task.state === 'failed' ? 'Fehlgeschlagener' : task.state === 'interrupted' ? 'Unterbrochener' : 'Laufender'} Auftrag: ${task.summary}`,
      dueAtUtc: null,
      dedupeKey: normalizeProactiveContent(task.summary),
    }));
}

export function formatProactiveRecall(items: ReadonlyArray<Pick<ProactiveItem, 'text' | 'dueAtUtc'>>): string {
  const lines = items.map((item) => `• ${item.text}${formatDue(item.dueAtUtc)}`);
  return `🔔 Zum Start noch offen oder fällig:\n${lines.join('\n')}\n\nAbruf: /wo_stehen_wir`;
}

export function buildProactiveRecall(sessionKey: string, now = new Date()): {
  items: ProactiveItem[];
  text: string;
} | null {
  const ledger = getCaptureLedger();
  // The middleware has already accepted the current message at this point.
  // Only failed/interrupted task-ledger rows belong in a proactive digest;
  // otherwise every message would announce itself as a new open task.
  const candidates = mergeProactiveItems(
    taskLedgerItems(sessionKey, false),
    ledger.pendingForSession(sessionKey, now),
    indexedOpenTasks(),
  );
  const items = ledger.reserveForDelivery(sessionKey, candidates, now);
  if (items.length === 0) return null;
  return {
    items,
    text: formatProactiveRecall(items),
  };
}

/** Deliver once per item, session and UTC day; release reservations on send failure. */
export async function sendProactiveRecall(ctx: Context, sessionKey: string): Promise<void> {
  const now = new Date();
  const digest = buildProactiveRecall(sessionKey, now);
  if (!digest) return;
  try {
    await ctx.reply(digest.text, {
      parse_mode: undefined,
      reply_markup: digestActionKeyboard(ctx, sessionKey),
    });
  } catch (error) {
    getCaptureLedger().releaseDeliveryReservations(sessionKey, digest.items, now);
    console.warn('[ProactiveRecall] delivery failed; reservation released:', error);
  }
}

export function buildWhereAreWe(sessionKey: string, now = new Date()): string {
  const captures = getCaptureLedger().pendingForSession(sessionKey, now);
  const items = mergeProactiveItems(
    taskLedgerItems(sessionKey, true),
    captures,
    indexedOpenTasks(),
  );
  if (items.length === 0) return '✅ Keine offenen oder fälligen Erinnerungen/Aufträge.';
  return `📌 Offene Punkte:\n${items.map((item) => `• ${item.text}${formatDue(item.dueAtUtc)}`).join('\n')}`;
}
