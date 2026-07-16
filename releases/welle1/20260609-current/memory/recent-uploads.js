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
import * as fs from 'fs';
import * as path from 'path';
const SIDECAR_DIR = '.nexusgram';
const SIDECAR_FILE = 'recent_uploads.json';
const MAX_ENTRIES = 10;
function sidecarPath(workingDir) {
    return path.join(workingDir, SIDECAR_DIR, SIDECAR_FILE);
}
function readSidecar(workingDir) {
    try {
        const file = sidecarPath(workingDir);
        if (!fs.existsSync(file))
            return { uploads: [] };
        const raw = fs.readFileSync(file, 'utf-8');
        if (!raw.trim())
            return { uploads: [] };
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.uploads)) {
            return { uploads: parsed.uploads.slice(0, MAX_ENTRIES) };
        }
        return { uploads: [] };
    }
    catch {
        return { uploads: [] };
    }
}
function writeSidecar(workingDir, data) {
    try {
        const dir = path.join(workingDir, SIDECAR_DIR);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = sidecarPath(workingDir);
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, file);
    }
    catch {
        // Never crash the bot on sidecar persistence errors.
    }
}
/**
 * Append a new upload entry. Newest first, FIFO ring buffer of MAX_ENTRIES.
 */
export function recordUpload(workingDir, entry) {
    const data = readSidecar(workingDir);
    const fullEntry = {
        path: entry.path,
        caption: entry.caption || '',
        ts: entry.ts || new Date().toISOString(),
    };
    data.uploads.unshift(fullEntry);
    data.uploads = data.uploads.slice(0, MAX_ENTRIES);
    writeSidecar(workingDir, data);
}
/**
 * Build a small system-prompt context block listing the most recent uploads.
 * Returns empty string when no uploads recorded.
 *
 * Default `limit` is 3 — enough to recover from a recent compaction without
 * polluting every prompt with stale upload history.
 */
export function buildRecentUploadsContext(workingDir, limit = 10) {
    const { uploads } = readSidecar(workingDir);
    if (uploads.length === 0)
        return '';
    const slice = uploads
        .filter((u) => fs.existsSync(u.path)) // skip deleted files
        .slice(0, limit);
    if (slice.length === 0)
        return '';
    const lines = slice.map((u) => {
        const captionFragment = u.caption ? ` — caption: "${u.caption.slice(0, 80)}"` : '';
        return `- ${u.ts} ${u.path}${captionFragment}`;
    });
    return (`\n\nRecent uploads in this project (newest first, last ${slice.length} of max ${MAX_ENTRIES}) — images AND documents (PDF etc.):\n` +
        lines.join('\n') +
        `\nIf the user references one of these (e.g. "das Bild von vorhin", "the screenshot", "das PDF", "der Brief den ich geschickt hab"), use the Read tool with the absolute path.`);
}
//# sourceMappingURL=recent-uploads.js.map