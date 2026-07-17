/** Proactive recall at the start of a new user turn. */
import type { Context } from 'grammy';
import { config } from '../config.js';
import { searchTasks } from './nexus-memory.js';
import { getCaptureLedger, type ProactiveItem } from './capture-ledger.js';

function formatDue(dueAtUtc: string | null): string {
  return dueAtUtc ? ` (fällig: ${dueAtUtc.slice(0, 10)})` : '';
}

function sprint3OpenTasks(): ProactiveItem[] {
  // memory_tasks contains operator-private data. searchTasks applies the
  // configured scope gate and returns [] for family/test/public contexts.
  return searchTasks({ status: 'open', limit: 20 }).map((task) => ({
    key: `memory-task:${task.source_kind}:${task.source_id}`,
    text: `Offener Auftrag (Ledger): ${task.description}`,
    dueAtUtc: task.due_at_utc,
  }));
}

export function buildProactiveRecall(sessionKey: string, now = new Date()): {
  items: ProactiveItem[];
  text: string;
} | null {
  const ledger = getCaptureLedger();
  const candidates = [...ledger.pendingForSession(sessionKey, now), ...sprint3OpenTasks()];
  const items = ledger.reserveForDelivery(sessionKey, candidates, now);
  if (items.length === 0) return null;
  const lines = items.map((item) => `• ${item.text}${formatDue(item.dueAtUtc)}`);
  return {
    items,
    text: `🔔 Zum Start noch offen oder fällig:\n${lines.join('\n')}\n\nAbruf: /wo-stehen-wir`,
  };
}

/** Deliver once per item, session and UTC day; release reservations on send failure. */
export async function sendProactiveRecall(ctx: Context, sessionKey: string): Promise<void> {
  const now = new Date();
  const digest = buildProactiveRecall(sessionKey, now);
  if (!digest) return;
  try {
    await ctx.reply(digest.text, { parse_mode: undefined });
  } catch (error) {
    getCaptureLedger().releaseDeliveryReservations(sessionKey, digest.items, now);
    console.warn('[ProactiveRecall] delivery failed; reservation released:', error);
  }
}

export function buildWhereAreWe(sessionKey: string, now = new Date()): string {
  const captures = getCaptureLedger().pendingForSession(sessionKey, now);
  const tasks = sprint3OpenTasks();
  const items = [...captures, ...tasks];
  if (items.length === 0) return '✅ Keine offenen oder fälligen Erinnerungen/Aufträge.';
  return `📌 Offene Punkte:\n${items.map((item) => `• ${item.text}${formatDue(item.dueAtUtc)}`).join('\n')}`;
}
