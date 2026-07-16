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
export type PrivacyMode = 'public' | 'private';
export interface PrivacyRecord {
    mode: PrivacyMode;
    since: string;
}
/**
 * Returns true when the given sessionKey is currently in private mode.
 * Safe default: false (public).
 */
export declare function isPrivate(sessionKey: string): boolean;
/**
 * Returns the full privacy record for a sessionKey (or null if public/default).
 */
export declare function getStatus(sessionKey: string): PrivacyRecord | null;
/**
 * Enable private mode for this sessionKey.
 */
export declare function setPrivate(sessionKey: string): PrivacyRecord;
/**
 * Disable private mode (return to public default) for this sessionKey.
 */
export declare function setPublic(sessionKey: string): void;
/**
 * Test helper: reset the in-memory cache.
 * Not exported via index; intended for unit-test usage only.
 */
export declare function _resetCacheForTests(): void;
//# sourceMappingURL=privacy-state.d.ts.map