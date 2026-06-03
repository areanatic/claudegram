/**
 * privacy-state.ts — Privacy Mode Phase 1 per-chat state store
 *
 * Simple file-backed JSON store that tracks whether a given sessionKey
 * (chatId or chatId:threadId) is currently in "private" mode.
 *
 * Contract (Phase 1):
 *  - Default: every session is public.
 *  - `/private on` sets state[sessionKey] = { mode: 'private', since: <iso> }
 *  - `/private off` clears state[sessionKey].
 *  - `isPrivate(sessionKey)` returns boolean.
 *  - `getStatus(sessionKey)` returns the full record or null.
 *
 * Storage:
 *  - JSON file at `.nexus-memory/privacy-state.json`
 *  - Atomic write via temp file + rename.
 *  - Fire-and-forget persistence; in-memory cache is the source of truth
 *    during bot lifetime.
 *  - Never throws — must not crash the bot.
 *
 * Scope: Phase 1 only — no auto-classification, no modes (clean/no-dhl/…).
 */

import * as fs from 'fs';
import * as path from 'path';

// Env-overridable ONLY for deterministic tests (point at a throwaway dir so a test never
// writes the live privacy-state.json). Prod leaves it unset → identical to the constant.
const NEXUS_ROOT = process.env.NEXUS_ROOT_PATH || '/Volumes/AstronOne/NEXUS_miniM_13-03-26';
const STATE_DIR = path.join(NEXUS_ROOT, '.nexus-memory');
const STATE_FILE = path.join(STATE_DIR, 'privacy-state.json');

export type PrivacyMode = 'public' | 'private';

export interface PrivacyRecord {
  mode: PrivacyMode;
  since: string; // ISO timestamp
}

type PrivacyState = Record<string, PrivacyRecord>;

let cache: PrivacyState | null = null;

function loadFromDisk(): PrivacyState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PrivacyState;
    }
    return {};
  } catch {
    return {};
  }
}

function persist(state: PrivacyState): void {
  setImmediate(() => {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmp, STATE_FILE);
    } catch {
      // Silent fail — never crash the bot on persistence errors.
    }
  });
}

function getState(): PrivacyState {
  if (cache === null) cache = loadFromDisk();
  return cache;
}

/**
 * Returns true when the given sessionKey is currently in private mode.
 * Safe default: false (public).
 */
export function isPrivate(sessionKey: string): boolean {
  const rec = getState()[sessionKey];
  return rec?.mode === 'private';
}

/**
 * Returns the full privacy record for a sessionKey (or null if public/default).
 */
export function getStatus(sessionKey: string): PrivacyRecord | null {
  const rec = getState()[sessionKey];
  return rec ?? null;
}

/**
 * Enable private mode for this sessionKey.
 */
export function setPrivate(sessionKey: string): PrivacyRecord {
  const state = getState();
  const rec: PrivacyRecord = {
    mode: 'private',
    since: new Date().toISOString(),
  };
  state[sessionKey] = rec;
  persist(state);
  return rec;
}

/**
 * Disable private mode (return to public default) for this sessionKey.
 */
export function setPublic(sessionKey: string): void {
  const state = getState();
  if (state[sessionKey]) {
    delete state[sessionKey];
    persist(state);
  }
}

/**
 * Test helper: reset the in-memory cache.
 * Not exported via index; intended for unit-test usage only.
 */
export function _resetCacheForTests(): void {
  cache = null;
}
