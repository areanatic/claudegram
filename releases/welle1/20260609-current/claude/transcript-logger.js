import * as fs from 'fs';
import * as path from 'path';
import { sessionManager } from './session-manager.js';
import { config } from '../config.js';
const TRANSCRIPT_DIR = path.join(config.DATA_DIR, 'transcripts');
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}
function todayStr() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }); // YYYY-MM-DD German time
}
function yesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}
function timestampStr() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function transcriptPath(userId) {
    const dir = path.join(TRANSCRIPT_DIR, todayStr());
    ensureDir(dir);
    return path.join(dir, `${userId}.md`);
}
/**
 * Load today's transcript for context recovery after a bot restart.
 * Injected when there is no active Claude session ID (= fresh start).
 * Returns the last ~3000 chars or empty string if none exists.
 */
export function loadTodayTranscript(sessionKey) {
    try {
        const filePath = path.join(TRANSCRIPT_DIR, todayStr(), `${sessionKey}.md`);
        if (!fs.existsSync(filePath))
            return '';
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim())
            return '';
        const maxChars = 3000;
        const trimmed = content.length > maxChars ? '…\n' + content.slice(-maxChars) : content;
        return `\n\n<today-context>\nDies ist der bisherige Verlauf dieser Telegram-Session (Kontext-Recovery nach Neustart):\n${trimmed}\n</today-context>`;
    }
    catch {
        return '';
    }
}
/**
 * Load yesterday's transcript for context continuity on day change.
 * Returns the last ~4000 chars or empty string if none exists.
 */
export function loadPreviousDayTranscript(sessionKey) {
    try {
        const filePath = path.join(TRANSCRIPT_DIR, yesterdayStr(), `${sessionKey}.md`);
        if (!fs.existsSync(filePath))
            return '';
        const content = fs.readFileSync(filePath, 'utf-8');
        const maxChars = 4000;
        const trimmed = content.length > maxChars ? content.slice(-maxChars) : content;
        return `\n\n<previous-day-context>\nDies ist ein Auszug aus dem gestrigen Gespräch zur Kontextwahrung:\n${trimmed}\n</previous-day-context>`;
    }
    catch {
        return '';
    }
}
/**
 * Record a single message (user or assistant) to the daily transcript file.
 * Appends to <DATA_DIR>/transcripts/YYYY-MM-DD/<userId>.md
 */
export function recordTranscript(sessionKey, role, content) {
    try {
        const session = sessionManager.getSession(sessionKey);
        const convId = session?.conversationId ?? 'unknown';
        const project = session?.workingDirectory ? path.basename(session.workingDirectory) : '';
        const filePath = transcriptPath(sessionKey);
        let line;
        if (role === 'user') {
            // Session header only on first user message per conversation block
            const header = `\n## ${timestampStr()} | ${convId} | ${project}\n`;
            line = `${header}**User:** ${content}\n`;
        }
        else {
            line = `**Claude:** ${content}\n\n---\n`;
        }
        fs.appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
    }
    catch {
        // Transcript logging must never crash the bot
    }
}
//# sourceMappingURL=transcript-logger.js.map