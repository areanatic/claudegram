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
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';
// ── Constants ────────────────────────────────────────────────────────
const INBOX_DIR_NAME = 'INBOX';
const METADATA_EXTENSION = '.meta.json';
// Allowed MIME types for security — covers common document/media types.
// Files not matching are rejected.
const ALLOWED_MIME_PREFIXES = [
    'image/',
    'audio/',
    'video/',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.oasis.opendocument',
    'application/zip',
    'application/x-rar',
    'application/x-7z-compressed',
    'application/gzip',
    'application/json',
    'application/xml',
    'text/',
    'application/rtf',
    'application/epub+zip',
    'application/x-tar',
    'application/octet-stream', // Telegram fallback for .html, .ts, .js, custom formats
];
// Max filename length (filesystem safety)
const MAX_FILENAME_LENGTH = 200;
// ── Core Functions ───────────────────────────────────────────────────
/**
 * Get the INBOX directory path, creating it if necessary.
 */
export function getInboxDir() {
    const nexusRoot = config.WORKSPACE_DIR || process.env.HOME || '.';
    const inboxDir = path.join(nexusRoot, INBOX_DIR_NAME);
    fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
    return inboxDir;
}
/**
 * Sanitize a filename: remove path traversal, special chars, limit length.
 */
export function sanitizeFilename(name) {
    // Take only the basename (strip any directory components)
    let safe = path.basename(name);
    // Replace dangerous characters
    safe = safe.replace(/[^a-zA-Z0-9._\-\s()[\]]/g, '_');
    // Collapse multiple underscores/spaces
    safe = safe.replace(/[_\s]+/g, '_');
    // Trim underscores from edges
    safe = safe.replace(/^_+|_+$/g, '');
    // Limit length (preserve extension)
    if (safe.length > MAX_FILENAME_LENGTH) {
        const ext = path.extname(safe);
        const base = safe.slice(0, MAX_FILENAME_LENGTH - ext.length);
        safe = base + ext;
    }
    return safe || 'unnamed_file';
}
/**
 * Check if a MIME type is allowed.
 */
export function isAllowedMimeType(mimeType) {
    if (!mimeType)
        return false;
    const lower = mimeType.toLowerCase();
    return ALLOWED_MIME_PREFIXES.some(prefix => lower.startsWith(prefix));
}
/**
 * Build a unique filename with timestamp prefix.
 * Format: YYYY-MM-DD_HHMMSS_originalname.ext
 */
export function buildInboxFilename(originalName) {
    const sanitized = sanitizeFilename(originalName);
    const now = new Date();
    const timestamp = now.toISOString()
        .replace(/T/, '_')
        .replace(/:/g, '')
        .replace(/\.\d{3}Z$/, '');
    return `${timestamp}_${sanitized}`;
}
/**
 * Save an inbox metadata sidecar JSON alongside the file.
 */
export function saveMetadata(metadata) {
    const metaPath = metadata.savedPath + METADATA_EXTENSION;
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');
}
/**
 * Read inbox metadata from sidecar JSON.
 */
export function readMetadata(filePath) {
    const metaPath = filePath + METADATA_EXTENSION;
    if (!fs.existsSync(metaPath))
        return null;
    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    }
    catch {
        return null;
    }
}
/**
 * Create a new inbox entry: generates ID, builds filename, prepares metadata.
 * Does NOT download the file — the caller handles that.
 */
export function createInboxEntry(opts) {
    const inboxDir = getInboxDir();
    const id = crypto.randomUUID();
    const savedFilename = buildInboxFilename(opts.originalFilename);
    const destPath = path.join(inboxDir, savedFilename);
    const metadata = {
        id,
        originalFilename: opts.originalFilename,
        savedFilename,
        savedPath: destPath,
        mimeType: opts.mimeType,
        fileSize: opts.fileSize,
        telegramMessageId: opts.telegramMessageId,
        telegramFileId: opts.telegramFileId,
        caption: opts.caption,
        receivedAt: new Date().toISOString(),
        senderId: opts.senderId,
        routedTo: null,
        routedAt: null,
        tags: [],
    };
    return { metadata, destPath };
}
/**
 * Route a file from INBOX to a target directory.
 * Moves the file + updates metadata.
 * Optionally renames the file.
 */
export function routeFile(currentPath, targetDir, newFilename) {
    const metadata = readMetadata(currentPath);
    // Ensure target directory exists
    fs.mkdirSync(targetDir, { recursive: true });
    const filename = newFilename
        ? sanitizeFilename(newFilename)
        : path.basename(currentPath);
    const newPath = path.join(targetDir, filename);
    // Move file
    fs.renameSync(currentPath, newPath);
    // Move metadata sidecar
    const oldMetaPath = currentPath + METADATA_EXTENSION;
    const newMetaPath = newPath + METADATA_EXTENSION;
    if (fs.existsSync(oldMetaPath)) {
        fs.renameSync(oldMetaPath, newMetaPath);
    }
    // Update metadata
    if (metadata) {
        metadata.savedPath = newPath;
        metadata.savedFilename = filename;
        metadata.routedTo = targetDir;
        metadata.routedAt = new Date().toISOString();
        fs.writeFileSync(newMetaPath, JSON.stringify(metadata, null, 2), 'utf-8');
    }
    return { newPath, metadata };
}
/**
 * List all files currently in the INBOX (unrouted).
 */
export function listInbox() {
    const inboxDir = getInboxDir();
    if (!fs.existsSync(inboxDir))
        return [];
    const entries = fs.readdirSync(inboxDir, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
        // Skip metadata sidecars and directories
        if (entry.name.endsWith(METADATA_EXTENSION) || !entry.isFile())
            continue;
        const filePath = path.join(inboxDir, entry.name);
        const metadata = readMetadata(filePath);
        if (metadata && !metadata.routedTo) {
            results.push(metadata);
        }
    }
    // Sort by receivedAt descending (newest first)
    results.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return results;
}
/**
 * Get inbox statistics.
 */
export function getInboxStats() {
    const items = listInbox();
    const totalSizeBytes = items.reduce((sum, item) => sum + item.fileSize, 0);
    return {
        totalFiles: items.length,
        unrouted: items.filter(i => !i.routedTo).length,
        totalSizeMB: Math.round((totalSizeBytes / (1024 * 1024)) * 10) / 10,
    };
}
/**
 * Format file size for display.
 */
export function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
//# sourceMappingURL=inbox.js.map