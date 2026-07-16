/**
 * NEXUS Inbox System — Universal document parking & routing.
 *
 * Files arrive via Telegram and land in the INBOX directory.
 * Each file gets a JSON sidecar with metadata (sender, date, caption, etc.).
 * Files can later be routed to the correct NEXUS project.
 *
 * Flow:
 *   1. User sends document via Telegram
 *   2. Bot downloads original file to INBOX/
 *   3. Sidecar JSON created with metadata
 *   4. If context is clear -> auto-route to project (with confirmation)
 *   5. If context is unclear -> stays in INBOX for later review
 */
export interface InboxMetadata {
    /** UUID for this inbox entry */
    id: string;
    /** Original filename from Telegram */
    originalFilename: string;
    /** Saved filename (sanitized + timestamped) */
    savedFilename: string;
    /** Full path on disk */
    savedPath: string;
    /** MIME type reported by Telegram */
    mimeType: string | null;
    /** File size in bytes */
    fileSize: number;
    /** Telegram message ID */
    telegramMessageId: number;
    /** Telegram file_id (for re-downloading if needed) */
    telegramFileId: string;
    /** Caption the user sent with the file */
    caption: string | null;
    /** ISO timestamp when received */
    receivedAt: string;
    /** Telegram user ID */
    senderId: number;
    /** Where the file was routed (null = still in inbox) */
    routedTo: string | null;
    /** ISO timestamp when routed */
    routedAt: string | null;
    /** Tags for categorization */
    tags: string[];
}
export interface InboxStats {
    totalFiles: number;
    unrouted: number;
    totalSizeMB: number;
}
/**
 * Get the INBOX directory path, creating it if necessary.
 */
export declare function getInboxDir(): string;
/**
 * Sanitize a filename: remove path traversal, special chars, limit length.
 */
export declare function sanitizeFilename(name: string): string;
/**
 * Check if a MIME type is allowed.
 */
export declare function isAllowedMimeType(mimeType: string | null | undefined): boolean;
/**
 * Build a unique filename with timestamp prefix.
 * Format: YYYY-MM-DD_HHMMSS_originalname.ext
 */
export declare function buildInboxFilename(originalName: string): string;
/**
 * Save an inbox metadata sidecar JSON alongside the file.
 */
export declare function saveMetadata(metadata: InboxMetadata): void;
/**
 * Read inbox metadata from sidecar JSON.
 */
export declare function readMetadata(filePath: string): InboxMetadata | null;
/**
 * Create a new inbox entry: generates ID, builds filename, prepares metadata.
 * Does NOT download the file — the caller handles that.
 */
export declare function createInboxEntry(opts: {
    originalFilename: string;
    mimeType: string | null;
    fileSize: number;
    telegramMessageId: number;
    telegramFileId: string;
    caption: string | null;
    senderId: number;
}): {
    metadata: InboxMetadata;
    destPath: string;
};
/**
 * Route a file from INBOX to a target directory.
 * Moves the file + updates metadata.
 * Optionally renames the file.
 */
export declare function routeFile(currentPath: string, targetDir: string, newFilename?: string): {
    newPath: string;
    metadata: InboxMetadata | null;
};
/**
 * List all files currently in the INBOX (unrouted).
 */
export declare function listInbox(): InboxMetadata[];
/**
 * Get inbox statistics.
 */
export declare function getInboxStats(): InboxStats;
/**
 * Format file size for display.
 */
export declare function formatFileSize(bytes: number): string;
//# sourceMappingURL=inbox.d.ts.map