/**
 * conversation-logger.ts — Persistent daily conversation log per bot
 *
 * Every NexusGram exchange (user message + bot response) is appended to a
 * plain-text log file. maintenance.sh synthesizes these nightly via Ollama
 * and saves the synthesis to SQLite L2 Memory.
 *
 * File pattern: {LOG_DIR}/YYYY-MM-DD_{botName}.log
 * Bot-space isolation: BOT_NAME per bot → separate files → separate synthesis.
 *
 * Silo isolation (2026-06-13): a bot that owns its own world (e.g. Alina/family)
 * sets CONVERSATION_LOG_DIR so its conversation logs stay inside its silo instead
 * of the shared NEXUS root. Unset → shared default, so master + every existing bot
 * are unchanged and maintenance.sh keeps globbing their logs for nightly synthesis.
 */

import * as fs from 'fs';
import * as path from 'path';

const NEXUS_ROOT = '/Volumes/AstronOne/NEXUS_miniM_13-03-26';

/**
 * Resolve the conversation-log directory.
 *
 * - unset  → shared default in the NEXUS root (master + all existing bots).
 * - set & absolute → the bot's own silo (isolation honoured verbatim).
 * - set & relative → MISCONFIG. A relative path would resolve against the
 *   process cwd (the NEXUS root) and silently re-leak an isolated bot's
 *   conversations into the shared space. We refuse that: anchor it to the
 *   bot's own DATA_DIR instead, and shout about it — never fall back to the
 *   shared root once isolation was requested.
 */
function resolveLogDir(): string {
  const sharedDefault = path.join(NEXUS_ROOT, 'logs', 'conversations');
  const override = process.env.CONVERSATION_LOG_DIR?.trim();
  if (!override) return sharedDefault;
  if (path.isAbsolute(override)) return override;

  const dataDir = process.env.DATA_DIR?.trim();
  const anchored =
    dataDir && path.isAbsolute(dataDir)
      ? path.resolve(dataDir, override)
      : path.resolve(override);
  console.error(
    `[conversation-logger] CONVERSATION_LOG_DIR ("${override}") is not absolute — ` +
      `anchored to "${anchored}" to avoid leaking into the shared NEXUS root.`,
  );
  return anchored;
}

const LOG_DIR = resolveLogDir();

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
export function logConversationTurn(
  botName: string,
  userMessage: string,
  botResponse: string,
  privacy: 'public' | 'private' = 'public',
): void {
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
    } catch (err) {
      // Must never crash the bot — but a swallowed failure means a silo's logs
      // silently vanish (data loss, not a leak). Surface it on stderr so the
      // bot's launchd err-log makes the loss visible instead of invisible.
      console.error(
        `[conversation-logger] failed to write turn to "${LOG_DIR}": ` +
          `${(err as Error)?.message ?? String(err)}`,
      );
    }
  });
}
