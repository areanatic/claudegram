/**
 * Convert standard markdown to Telegram MarkdownV2 format
 */
export declare function convertToTelegramMarkdown(text: string): string;
/**
 * Escape special characters for MarkdownV2 (fallback)
 */
export declare function escapeMarkdownV2(text: string): string;
/**
 * Smart message splitter that respects code blocks and markdown formatting
 */
export declare function splitMessage(text: string, maxLength?: number): string[];
/**
 * Process and split a message for Telegram
 * Converts markdown and splits into chunks
 */
export declare function processMessageForTelegram(text: string, maxLength?: number): string[];
export declare function escapeMarkdown(text: string): string;
export declare function formatCodeBlock(code: string, language?: string): string;
//# sourceMappingURL=markdown.d.ts.map