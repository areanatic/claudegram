import { z } from 'zod';
declare const sessionHistoryEntrySchema: z.ZodObject<{
    conversationId: z.ZodString;
    claudeSessionId: z.ZodOptional<z.ZodString>;
    projectPath: z.ZodString;
    projectName: z.ZodString;
    lastMessagePreview: z.ZodString;
    messageCount: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    createdAt: z.ZodString;
    lastActivity: z.ZodString;
}, z.core.$strip>;
export type SessionHistoryEntry = z.infer<typeof sessionHistoryEntrySchema>;
declare class SessionHistory {
    private data;
    constructor();
    private ensureDirectory;
    private load;
    private save;
    saveSession(sessionKey: string, conversationId: string, projectPath: string, lastMessagePreview?: string, claudeSessionId?: string, incrementMessageCount?: boolean): void;
    getHistory(sessionKey: string, limit?: number): SessionHistoryEntry[];
    getLastSession(sessionKey: string): SessionHistoryEntry | undefined;
    getSessionByConversationId(sessionKey: string, conversationId: string): SessionHistoryEntry | undefined;
    getAllActiveSessions(): Map<string, SessionHistoryEntry>;
    updateLastMessage(sessionKey: string, conversationId: string, preview: string): void;
    updateClaudeSessionId(sessionKey: string, conversationId: string, claudeSessionId: string): void;
    clearHistory(sessionKey: string): void;
}
export declare const sessionHistory: SessionHistory;
export {};
//# sourceMappingURL=session-history.d.ts.map