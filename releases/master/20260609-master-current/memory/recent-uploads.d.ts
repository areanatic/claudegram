/**
 * recent-uploads.ts — Ring-buffer of the last N image uploads per project.
 *
 * Why: After context compaction the bot forgets the path of recently-uploaded
 * images. A small JSON sidecar in each project workingDirectory persists the
 * last MAX_ENTRIES uploads so we can re-inject a hint into the system prompt
 * and the bot can `Read` the actual file again.
 *
 * Storage: ${workingDirectory}/.nexusgram/recent_uploads.json
 * Atomic write via tmp + rename. Never throws — safe to call in hot paths.
 */
export interface UploadEntry {
    path: string;
    caption: string;
    ts: string;
}
/**
 * Append a new upload entry. Newest first, FIFO ring buffer of MAX_ENTRIES.
 */
export declare function recordUpload(workingDir: string, entry: {
    path: string;
    caption?: string;
    ts?: string;
}): void;
/**
 * Build a small system-prompt context block listing the most recent uploads.
 * Returns empty string when no uploads recorded.
 *
 * Default `limit` is 3 — enough to recover from a recent compaction without
 * polluting every prompt with stale upload history.
 */
export declare function buildRecentUploadsContext(workingDir: string, limit?: number): string;
//# sourceMappingURL=recent-uploads.d.ts.map