/**
 * Initialize Telegraph account (creates one if needed)
 * Uses native fetch instead of telegra.ph library
 */
export declare function initTelegraph(): Promise<void>;
/**
 * Check if content should use Telegraph (long content or has tables)
 * Returns false if Telegraph is disabled globally or for this chat
 */
export declare function shouldUseTelegraph(content: string, sessionKey?: string): boolean;
/**
 * Create a Telegraph page from markdown content
 * Uses a UUID-based title to prevent URL guessing
 */
export declare function createTelegraphPage(title: string, markdown: string): Promise<string | null>;
/**
 * Create Telegraph page from an existing markdown file
 */
export declare function createTelegraphFromFile(filePath: string): Promise<string | null>;
//# sourceMappingURL=telegraph.d.ts.map