import { SessionHistoryEntry } from './session-history.js';
interface Session {
    conversationId: string;
    claudeSessionId?: string;
    workingDirectory: string;
    createdAt: Date;
    lastActivity: Date;
}
declare class SessionManager {
    private sessions;
    getSession(sessionKey: string): Session | undefined;
    /**
     * Boot airbag (INV-01): is the resumed/in-memory Claude session JSONL already
     * near-full for its model's context window?
     *
     * Codex correction #4: this MUST run in BOTH `getOrResumeSession` branches —
     * the in-memory `existing` path AND the post-reboot `resumed` path. Before this
     * fix it only ran on `existing`; after a reboot `sessions` is empty, so
     * `resumeLastSession` returned an oversized session WITHOUT a check and the
     * very next (auto-resumed) turn just reproduced "Prompt is too long".
     *
     * Approach: a file-size proxy on the --resume JSONL, scaled to the model's
     * context window. 7 MB ≈ ~80% of a 200k window for text-dense transcripts
     * (Bug-A: a 9.5 MB JSONL sat at ~196.8k/200k = death-spiral). Scaling by the
     * window (Codex #5) keeps the 200k case rotating while NOT false-rotating a
     * healthy large-window (1M) session. Size-only (`statSync`) — it NEVER reads
     * JSONL content, so there is no privacy tail-read on a resumed session. The
     * primary guard remains the usage-based rotation in agent.ts
     * (maybeRotateAfterContextPressure); this is the second line, at boot.
     */
    private isContextFullAtBoot;
    /**
     * Check if a session belongs to a previous day (German time).
     */
    private isNewDay;
    /**
     * Get session from memory, or auto-resume the last session from disk if none exists.
     * This prevents "No project set" errors after bot restarts.
     * The session data is always persisted in <DATA_DIR>/sessions.json,
     * so this simply restores what was already there.
     *
     * Auto-rotates sessions on day change (German timezone).
     */
    getOrResumeSession(sessionKey: string): Session | undefined;
    createSession(sessionKey: string, workingDirectory: string, conversationId?: string): Session;
    updateActivity(sessionKey: string, messagePreview?: string): void;
    setWorkingDirectory(sessionKey: string, directory: string): Session;
    clearSession(sessionKey: string): void;
    /**
     * Schlachtplan Akt 1.3 Cancel-Fix 3 (2026-05-21): force a genuinely fresh
     * session for `/reset`.
     *
     * The bug: `clearSession` only drops the in-memory session. The very next
     * message calls `getOrResumeSession`, which falls through to
     * `resumeLastSession` and rebuilds the session FROM HISTORY — including the
     * old `claudeSessionId`. So `/reset` did not start fresh; it silently
     * resumed the conversation it was supposed to discard.
     *
     * This method creates a brand-new session (new conversationId,
     * claudeSessionId === undefined) for the same working directory, so the next
     * `getOrResumeSession` finds the fresh in-memory session and never resumes
     * the old Claude session. Returns the working directory used, or undefined
     * if no prior session/working directory could be determined.
     */
    forceFreshSession(sessionKey: string): string | undefined;
    resumeSession(sessionKey: string, conversationId: string): Session | undefined;
    resumeLastSession(sessionKey: string): Session | undefined;
    getSessionHistory(sessionKey: string, limit?: number): SessionHistoryEntry[];
    setClaudeSessionId(sessionKey: string, claudeSessionId: string): void;
    private generateConversationId;
}
export declare const sessionManager: SessionManager;
export {};
//# sourceMappingURL=session-manager.d.ts.map