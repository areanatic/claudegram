/**
 * Terminal UI settings per chat.
 * Persists user preferences for terminal-style display mode.
 */
export interface TerminalUISettings {
    enabled: boolean;
}
export declare function getTerminalUISettings(sessionKey: string): TerminalUISettings;
export declare function setTerminalUIEnabled(sessionKey: string, enabled: boolean): void;
export declare function isTerminalUIEnabled(sessionKey: string): boolean;
//# sourceMappingURL=terminal-settings.d.ts.map