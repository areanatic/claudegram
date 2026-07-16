export interface ParsedCommand {
    command: string | null;
    args: string;
    model: string | null;
}
export declare function parseClaudeCommand(message: string): ParsedCommand;
export declare function isClaudeCommand(message: string): boolean;
export declare function getAvailableCommands(): string;
//# sourceMappingURL=command-parser.d.ts.map