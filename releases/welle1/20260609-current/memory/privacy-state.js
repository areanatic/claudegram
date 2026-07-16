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
import { config } from '../config.js';
// P0 FIX 2026-06-04 (bug_private_cross_bot_sessionkey_collision): the privacy
// state MUST be per-bot, not global. Previously this lived at the shared
// NEXUS_ROOT/.nexus-memory/privacy-state.json, while the sessionKey is just the
// chatId — and in private Telegram DMs the chatId is the user-id, IDENTICAL across
// all bots for the same user. Result: `/private on` in ONE Astron-bot toggled
// every bot (memo/dev1/dev2/dev3/family/work + master) for that user.
//
// Fix: anchor the state file in the bot's own DATA_DIR (~/.nexusgram-<slug>),
// exactly like input-log.db / captures.db / sessions.json already do. Each bot
// process has a distinct DATA_DIR → distinct privacy-state.json → true isolation.
//
// Resolution order (Codex P1 2026-06-04: config.DATA_DIR MUST win over the legacy
// NEXUS_ROOT_PATH fallback, otherwise a stray prod NEXUS_ROOT_PATH would silently
// re-share the state across bots and re-open the leak):
//   1. NEXUS_PRIVACY_STATE_DIR — explicit per-test throwaway dir (highest prio).
//   2. config.DATA_DIR — PROD: per-bot DATA_DIR (~/.nexusgram-<slug>) = the
//      load-bearing isolation. Default ~/.nexusgram only if a bot sets no DATA_DIR
//      (deployment asserts a distinct DATA_DIR per bot).
//   3. NEXUS_ROOT_PATH — legacy test fallback ONLY, lowest prio. Pre-existing
//      harnesses (dirigent-bridge.test) set this and no DATA_DIR, so they still work,
//      but it can never override a real bot's DATA_DIR.
function resolveStateDir() {
    const explicit = process.env.NEXUS_PRIVACY_STATE_DIR;
    if (explicit)
        return explicit;
    // config.DATA_DIR is set whenever a bot configures DATA_DIR (all 6 Astron bots do).
    // Only when it falls back to the bare default AND a legacy test set NEXUS_ROOT_PATH
    // do we honor the legacy path — never letting it shadow a configured DATA_DIR.
    const dataDir = config.DATA_DIR;
    const defaultDataDir = path.join(process.env.HOME || '.', '.nexusgram');
    if (dataDir === defaultDataDir && process.env.NEXUS_ROOT_PATH) {
        return path.join(process.env.NEXUS_ROOT_PATH, '.nexus-memory');
    }
    return dataDir;
}
const STATE_DIR = resolveStateDir();
const STATE_FILE = path.join(STATE_DIR, 'privacy-state.json');
let cache = null;
function loadFromDisk() {
    try {
        if (!fs.existsSync(STATE_FILE))
            return {};
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        if (!raw.trim())
            return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        return {};
    }
    catch {
        return {};
    }
}
function persist(state) {
    setImmediate(() => {
        try {
            fs.mkdirSync(STATE_DIR, { recursive: true });
            const tmp = STATE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
            fs.renameSync(tmp, STATE_FILE);
        }
        catch {
            // Silent fail — never crash the bot on persistence errors.
        }
    });
}
function getState() {
    if (cache === null)
        cache = loadFromDisk();
    return cache;
}
/**
 * Returns true when the given sessionKey is currently in private mode.
 * Safe default: false (public).
 */
export function isPrivate(sessionKey) {
    const rec = getState()[sessionKey];
    return rec?.mode === 'private';
}
/**
 * Returns the full privacy record for a sessionKey (or null if public/default).
 */
export function getStatus(sessionKey) {
    const rec = getState()[sessionKey];
    return rec ?? null;
}
/**
 * Enable private mode for this sessionKey.
 */
export function setPrivate(sessionKey) {
    const state = getState();
    const rec = {
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
export function setPublic(sessionKey) {
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
export function _resetCacheForTests() {
    cache = null;
}
//# sourceMappingURL=privacy-state.js.map