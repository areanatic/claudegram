export type QuarantineReason = 'watchdog-timeout' | 'execution-error' | 'jsonl-oversized' | 'context-threshold' | 'compaction-threshold';
export interface QuarantineRequest {
    sessionId: string;
    sessionKey: string;
    conversationId?: string;
    projectPath?: string;
    reason: QuarantineReason;
    detail?: string;
    preTokens?: number;
    inputTokens?: number;
}
export interface QuarantineResult {
    quarantined: boolean;
    sourcePath?: string;
    backupPath?: string;
    quarantinedPath?: string;
    manifestPath: string;
    sizeBytes?: number;
    reason: QuarantineReason;
}
export declare function findClaudeSessionJsonl(sessionId: string): string | null;
export declare function getClaudeSessionJsonlSize(sessionId: string): number | null;
export declare function quarantineClaudeSession(request: QuarantineRequest): QuarantineResult;
//# sourceMappingURL=session-quarantine.d.ts.map