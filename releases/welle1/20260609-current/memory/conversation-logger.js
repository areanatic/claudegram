/**
 * conversation-logger.ts — Persistent daily conversation log per bot
 *
 * Every NexusGram exchange (user message + bot response) is appended to a
 * plain-text log file. maintenance.sh synthesizes these nightly via Ollama
 * and saves the synthesis to SQLite L2 Memory.
 *
 * File pattern: {NEXUS_ROOT}/logs/conversations/YYYY-MM-DD_{botName}.log
 * Bot-space isolation: BOT_NAME per bot → separate files → separate synthesis.
 */
import * as fs from 'fs';
import * as path from 'path';
const NEXUS_ROOT = '/Volumes/AstronOne/NEXUS_miniM_13-03-26';
const LOG_DIR = path.join(NEXUS_ROOT, 'logs', 'conversations');
// Max chars per turn to keep logs manageable (enough for synthesis)
const MAX_USER_CHARS = 500;
const MAX_BOT_CHARS = 800;
/**
 * Append one conversation turn (user + bot) to the daily log file.
 * Never throws — must not crash the bot.
 *
 * When `privacy === 'private'`:
 *   - a split file `{date}_{bot}.private.log` is used (never consumed by the
 *     nightly synthesizer) so private content is never fed to Ollama,
 *   - each entry is prefixed with `[PRIVACY=PRIVATE]` for easy grep/audit.
 *
 * maintenance.sh only globs `${YESTERDAY}_*.log`, so `*.private.log` files
 * are skipped automatically. The marker line provides defense-in-depth if
 * the globbing pattern ever changes.
 */
export function logConversationTurn(botName, userMessage, botResponse, privacy = 'public') {
    // Fire-and-forget async write — never blocks event loop, never crashes bot
    setImmediate(() => {
        try {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            const now = new Date();
            const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; // YYYY-MM-DD local time
            const safeName = botName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            const suffix = privacy === 'private' ? '.private.log' : '.log';
            const logPath = path.join(LOG_DIR, `${today}_${safeName}${suffix}`);
            const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
            const userPreview = userMessage.slice(0, MAX_USER_CHARS).replace(/\n/g, ' ').trim();
            const botPreview = botResponse.slice(0, MAX_BOT_CHARS).replace(/\n/g, ' ').trim();
            const marker = privacy === 'private' ? '[PRIVACY=PRIVATE] ' : '';
            const entry = [
                `[${timestamp}] ${marker}User: ${userPreview}`,
                `[${timestamp}] ${marker}Bot: ${botPreview}`,
                '---',
                '',
            ].join('\n');
            fs.appendFileSync(logPath, entry, 'utf-8');
        }
        catch {
            // Must never crash the bot — silent fail
        }
    });
}
//# sourceMappingURL=conversation-logger.js.map