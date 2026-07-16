/**
 * Load today's transcript for context recovery after a bot restart.
 * Injected when there is no active Claude session ID (= fresh start).
 * Returns the last ~3000 chars or empty string if none exists.
 */
export declare function loadTodayTranscript(sessionKey: string): string;
/**
 * Load yesterday's transcript for context continuity on day change.
 * Returns the last ~4000 chars or empty string if none exists.
 */
export declare function loadPreviousDayTranscript(sessionKey: string): string;
/**
 * Record a single message (user or assistant) to the daily transcript file.
 * Appends to <DATA_DIR>/transcripts/YYYY-MM-DD/<userId>.md
 */
export declare function recordTranscript(sessionKey: string, role: 'user' | 'assistant', content: string): void;
//# sourceMappingURL=transcript-logger.d.ts.map