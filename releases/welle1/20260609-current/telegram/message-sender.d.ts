import { Context, Api } from 'grammy';
export interface ToolOperation {
    name: string;
    detail?: string;
}
export declare class MessageSender {
    private streamStates;
    /**
     * Send a message with hybrid approach:
     * - Short content: MarkdownV2 inline
     * - Long content or tables: Telegraph page link
     */
    sendMessage(ctx: Context, text: string): Promise<void>;
    /**
     * Send a file as a document attachment
     */
    sendDocument(ctx: Context, filePath: string, caption?: string): Promise<boolean>;
    /**
     * Send a markdown file with Telegraph preview option
     */
    sendMarkdownFile(ctx: Context, filePath: string, options?: {
        useTelegraph?: boolean;
        sendAsDocument?: boolean;
    }): Promise<boolean>;
    startStreaming(ctx: Context): Promise<void>;
    private stopSpinnerAnimation;
    startTypingIndicator(api: Api, chatId: number, threadId?: number): NodeJS.Timeout;
    private stopTypingIndicator;
    stopTypingInterval(interval: NodeJS.Timeout): void;
    /**
     * Update the current tool operation (terminal UI mode).
     * Event-driven: triggers a status message edit on each tool change.
     */
    updateToolOperation(sessionKey: string, toolName: string, input?: Record<string, unknown>, ctx?: Context): void;
    /**
     * Clear the current tool operation (terminal UI mode)
     */
    clearToolOperation(sessionKey: string): void;
    /**
     * Add or update a background task status (terminal UI mode)
     */
    updateBackgroundTask(sessionKey: string, taskName: string, status: 'running' | 'complete' | 'error'): void;
    private flushTerminalUpdate;
    private getToolAction;
    /**
     * Accumulate streamed text content internally without triggering Telegram edits.
     * The full content is only displayed when finishStreaming() is called.
     */
    updateStream(_ctx: Context, content: string): void;
    finishStreaming(ctx: Context, finalContent: string): Promise<void>;
    cancelStreaming(ctx: Context): Promise<void>;
    sendTyping(ctx: Context): Promise<void>;
}
export declare const messageSender: MessageSender;
//# sourceMappingURL=message-sender.d.ts.map