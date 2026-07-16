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
export declare function logConversationTurn(botName: string, userMessage: string, botResponse: string, privacy?: 'public' | 'private'): void;
//# sourceMappingURL=conversation-logger.d.ts.map