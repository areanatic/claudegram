import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { config } from '../config.js';
import type { BotEffectivenessHealth } from '../health/effectiveness.js';

export const BOT_IDS = ['master', 'alina', 'mom', 'dad'] as const;
export type BotId = (typeof BOT_IDS)[number];
export type RelayKind = 'note' | 'ask';

export interface BotFamilyMember {
  id: BotId;
  label: string;
  handle: string;
  dataDir: string;
}

export interface RelayEnvelope {
  id: string;
  createdAt: string;
  from: 'master';
  to: Exclude<BotId, 'master'>;
  kind: RelayKind;
  payload: string;
  sourceUserId: number;
}

export interface BotLiveStatus {
  member: BotFamilyMember;
  status: 'online' | 'stale' | 'offline';
  updatedAt: string | null;
  lastActivityAt: string | null;
}

export function isBotId(value: string): value is BotId {
  return (BOT_IDS as readonly string[]).includes(value);
}

/**
 * The registry is code-owned. No Telegram input can influence a data path or
 * cause a bot to inspect an arbitrary health/inbox file.
 */
export function botFamily(masterDataDir: string): readonly BotFamilyMember[] {
  const home = os.homedir();
  return [
    { id: 'master', label: 'Master', handle: '@AstronOneBot', dataDir: masterDataDir },
    { id: 'alina', label: 'Alina', handle: '@AlinaCheckBot', dataDir: '/Volumes/AstronOne/shared-memory/bot-worlds/alina/data' },
    { id: 'mom', label: 'Mom', handle: '@EffCheckBot', dataDir: path.join(home, '.nexusgram-mom') },
    { id: 'dad', label: 'Dad', handle: '@ManZamOneBot', dataDir: path.join(home, '.nexusgram-dad') },
  ];
}

export function resolveCurrentBotId(input: { isMaster: boolean; configuredId?: string; botName: string }): BotId | null {
  if (input.isMaster) return 'master';
  if (input.configuredId && isBotId(input.configuredId) && input.configuredId !== 'master') return input.configuredId;
  const legacyNames: Record<string, Exclude<BotId, 'master'>> = {
    'Alinas Assistentin': 'alina',
    'Effats Assistentin': 'mom',
    'MansZam Assistant': 'dad',
  };
  return legacyNames[input.botName] ?? null;
}

function inboxPath(relayDir: string, target: Exclude<BotId, 'master'>): string {
  return path.join(relayDir, 'inbox', `${target}.jsonl`);
}

function ensureRelayDirectory(relayDir: string): void {
  fs.mkdirSync(path.join(relayDir, 'inbox'), { recursive: true, mode: 0o700 });
}

function appendJsonLine(filePath: string, value: unknown): void {
  const line = `${JSON.stringify(value)}\n`;
  const fd = fs.openSync(filePath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, line, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseRelayLines(filePath: string): RelayEnvelope[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const candidate = JSON.parse(line) as Partial<RelayEnvelope>;
        if (
          typeof candidate.id !== 'string' ||
          typeof candidate.createdAt !== 'string' ||
          candidate.from !== 'master' ||
          !isBotId(String(candidate.to)) ||
          (candidate.kind !== 'note' && candidate.kind !== 'ask') ||
          typeof candidate.payload !== 'string' ||
          typeof candidate.sourceUserId !== 'number'
        ) return [];
        return [candidate as RelayEnvelope];
      } catch {
        // A partial/corrupt line must not stop delivery of later valid handoffs.
        return [];
      }
    });
}

/** Master is the only writer of target inboxes. */
export function enqueueRelay(input: {
  relayDir: string;
  target: Exclude<BotId, 'master'>;
  kind: RelayKind;
  payload: string;
  sourceUserId: number;
  now?: Date;
}): RelayEnvelope {
  const payload = input.payload.trim();
  if (!payload || payload.length > 4_000) throw new Error('Relay payload must be between 1 and 4000 characters.');
  ensureRelayDirectory(input.relayDir);
  const envelope: RelayEnvelope = {
    id: crypto.randomUUID(),
    createdAt: (input.now ?? new Date()).toISOString(),
    from: 'master',
    to: input.target,
    kind: input.kind,
    payload,
    sourceUserId: input.sourceUserId,
  };
  appendJsonLine(inboxPath(input.relayDir, input.target), envelope);
  return envelope;
}

/**
 * Recipient receipts live in its own data directory. They never mutate the
 * master-written inbox, preserving one writer per target inbox file.
 */
export function pendingRelays(input: {
  relayDir: string;
  recipient: Exclude<BotId, 'master'>;
  recipientDataDir: string;
}): RelayEnvelope[] {
  const receiptPath = path.join(input.recipientDataDir, 'crossbot-received.jsonl');
  const seen = new Set(
    fs.existsSync(receiptPath)
      ? fs.readFileSync(receiptPath, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try {
          const id = JSON.parse(line);
          return typeof id === 'string' ? [id] : [];
        } catch {
          return [];
        }
      })
      : [],
  );
  return parseRelayLines(inboxPath(input.relayDir, input.recipient))
    .filter((relay) => relay.to === input.recipient && !seen.has(relay.id));
}

export function markRelayDelivered(recipientDataDir: string, relayId: string): void {
  fs.mkdirSync(recipientDataDir, { recursive: true, mode: 0o700 });
  appendJsonLine(path.join(recipientDataDir, 'crossbot-received.jsonl'), relayId);
}

export function parseMasterRelay(text: string): { target: Exclude<BotId, 'master'>; kind: RelayKind; payload: string } | null {
  const match = text.match(/^\s*(sag|schreib|frag(?:e)?)\s+(?:den|dem|die|der)?\s*(alina|mom|dad)(?:[\s-]*bot)?\s*(?:,|:)?\s*(?:dass\s+)?(.+?)\s*$/i);
  if (!match) return null;
  const target = match[2]!.toLowerCase() as Exclude<BotId, 'master'>;
  const payload = match[3]!.trim();
  if (!payload || !isBotId(target)) return null;
  return { target, kind: /^frag/i.test(match[1]!) ? 'ask' : 'note', payload };
}

export function isRestrictedCrossBotCommand(text: string): boolean {
  return /^\/bots(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

function readHealth(member: BotFamilyMember): BotEffectivenessHealth | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(member.dataDir, 'health.json'), 'utf8')) as BotEffectivenessHealth;
    return parsed.schema_version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function readBotFamilyHealth(members: readonly BotFamilyMember[], now = new Date()): BotLiveStatus[] {
  return members.map((member) => {
    const health = readHealth(member);
    const updatedAt = health?.updated_at ?? null;
    const updatedMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    const status = !health || !Number.isFinite(updatedMs)
      ? 'offline'
      : now.getTime() - updatedMs <= config.BOT_FAMILY_HEALTH_FRESHNESS_MS ? 'online' : 'stale';
    return {
      member,
      status,
      updatedAt,
      lastActivityAt: health?.turns.last_success_at ?? health?.telegram_get_me.last_success_at ?? null,
    };
  });
}

export function formatBotFamilyHealth(statuses: readonly BotLiveStatus[]): string {
  const icon = { online: '🟢', stale: '🟡', offline: '⚫' } as const;
  const activity = (value: string | null) => value ? value.replace('T', ' ').replace('.000Z', 'Z') : 'keine Aktivität';
  return [
    '🤖 Bot-Familie',
    ...statuses.map((entry) => `${icon[entry.status]} ${entry.member.label} (${entry.member.handle}) — ${entry.status}; letzte Aktivität: ${activity(entry.lastActivityAt)}`),
  ].join('\n');
}
