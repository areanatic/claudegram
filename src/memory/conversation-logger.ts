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

/** True iff `child` is `parent` itself or lexically nested under it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve the conversation-log directory — hardened (Codex review 2026-06-14).
 *
 * - unset  → shared default in the NEXUS root (master + all existing bots).
 * - set, when the bot owns a silo (DATA_DIR absolute): the log dir MUST stay
 *   inside that silo. We anchor relative paths to DATA_DIR (never the process
 *   cwd — under launchd that is the shared repo root = re-leak) and REFUSE any
 *   resolved path that escapes DATA_DIR (typo/stale config), falling back to the
 *   canonical in-silo `DATA_DIR/logs/conversations`. So a misconfigured override
 *   can never write into another bot's world or back into the shared NEXUS root.
 * - set but no absolute DATA_DIR to anchor against → cannot place safely; refuse
 *   the override and use the shared default (loudly), rather than guess via cwd.
 *
 * Residual (accepted): containment is lexical, not symlink-resolved — a symlink
 * planted INSIDE the silo that points out would not be caught. That requires
 * write access to the silo itself (a bigger compromise) and is out of scope here.
 */
function resolveLogDir(): string {
  const sharedDefault = path.join(NEXUS_ROOT, 'logs', 'conversations');
  const override = process.env.CONVERSATION_LOG_DIR?.trim();
  if (!override) return sharedDefault;

  const dataDir = process.env.DATA_DIR?.trim();
  const dataDirAbs =
    dataDir && path.isAbsolute(dataDir) ? path.resolve(dataDir) : null;

  let dir: string;
  if (path.isAbsolute(override)) {
    dir = path.resolve(override);
  } else if (dataDirAbs) {
    dir = path.resolve(dataDirAbs, override);
  } else {
    console.error(
      `[conversation-logger] CONVERSATION_LOG_DIR ("${override}") is relative and ` +
        `DATA_DIR is unset/relative — cannot anchor safely; using shared default.`,
    );
    return sharedDefault;
  }

  if (dataDirAbs && !isWithin(dataDirAbs, dir)) {
    const safe = path.join(dataDirAbs, 'logs', 'conversations');
    console.error(
      `[conversation-logger] CONVERSATION_LOG_DIR ("${dir}") escapes DATA_DIR ` +
        `("${dataDirAbs}") — refusing and using in-silo "${safe}".`,
    );
    return safe;
  }
  return dir;
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
