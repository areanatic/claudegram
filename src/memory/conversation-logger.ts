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
 */
export function logConversationTurn(
  botName: string,
  userMessage: string,
  botResponse: string
): void {
  // Fire-and-forget async write — never blocks event loop, never crashes bot
  setImmediate(() => {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });

      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; // YYYY-MM-DD local time
      const safeName = botName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const logPath = path.join(LOG_DIR, `${today}_${safeName}.log`);

      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const userPreview = userMessage.slice(0, MAX_USER_CHARS).replace(/\n/g, ' ').trim();
      const botPreview = botResponse.slice(0, MAX_BOT_CHARS).replace(/\n/g, ' ').trim();

      const entry = [
        `[${timestamp}] User: ${userPreview}`,
        `[${timestamp}] Bot: ${botPreview}`,
        '---',
        '',
      ].join('\n');

      fs.appendFileSync(logPath, entry, 'utf-8');
    } catch {
      // Must never crash the bot — silent fail
    }
  });
}
