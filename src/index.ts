import { run } from '@grammyjs/runner';
import { GrammyError } from 'grammy';
import { createBot } from './bot/bot.js';
import { config } from './config.js';
import { preventSleep, allowSleep } from './utils/caffeinate.js';
import { stopCleanup } from './telegram/deduplication.js';
import { closeMemoryDb } from './memory/nexus-memory.js';
import { closeInputLog, recoverOrphanedInputs } from './inbox/input-log.js';
import { acquireLock, releaseLock } from './utils/pid-lock.js';
import { cancelAllRequests, getActiveSessionKeys } from './claude/request-queue.js';
import { clearAllBatchTimers } from './bot/handlers/document.handler.js';

async function main() {
  // Clear CLAUDECODE so claude subprocesses can start even when launched
  // from inside a Claude Code session (e.g. VS Code with Claude Code extension).
  delete process.env.CLAUDECODE;

  // PID lock: prevent duplicate instances of the same bot
  if (!acquireLock(config.BOT_NAME)) {
    console.error(`FATAL: Another instance of "${config.BOT_NAME}" is already running. Exiting.`);
    console.error('If this is stale, remove ~/.nexusgram/locks/*.pid');
    process.exit(0); // Exit 0 — exit 1 would trigger immediate LaunchAgent restart loop
  }

  console.log(`🤖 Starting ${config.BOT_NAME}...`);
  console.log(`📋 Allowed users: ${config.ALLOWED_USER_IDS.join(', ')}`);
  console.log(`📝 Mode: ${config.STREAMING_MODE}`);

  // Prevent system sleep on macOS
  preventSleep();

  const bot = await createBot();

  // Initialize bot (fetches bot info from Telegram)
  await bot.init();
  console.log(`✅ Bot started as @${bot.botInfo.username}`);
  console.log('📱 Send /start in Telegram to begin');

  // Akt 1c boot-recovery: any input_log row still 'received'/'processing' is
  // orphaned from a previous process — mark it dropped BEFORE polling starts,
  // so it neither lingers as silent drift nor inflates the /health pending count.
  const recovery = recoverOrphanedInputs();
  if (recovery.recovered > 0) {
    console.log(`[Startup] Boot-recovery: ${recovery.recovered} orphaned input(s) from a previous run marked dropped.`);
  }

  // Start concurrent runner — updates are processed in parallel,
  // with per-chat ordering enforced by the sequentialize middleware in bot.ts.
  // This lets /cancel bypass the per-chat queue and interrupt running queries.
  // Explicitly set allowed_updates so Telegram doesn't use a stale cached list
  // that might exclude callback_query (inline button presses).
  const runner = run(bot, {
    runner: {
      fetch: {
        allowed_updates: [
          'message',
          'edited_message',
          'callback_query',
          'inline_query',
          'chosen_inline_result',
          'channel_post',
          'edited_channel_post',
          'my_chat_member',
          'chat_member',
          'chat_join_request',
          'poll',
          'poll_answer',
          'shipping_query',
          'pre_checkout_query',
        ],
      },
    },
  });
  console.log('[Runner] Grammy runner started, polling for updates...');

  // FIX 4 (2026-05-22): tell users whose in-flight message was lost to a
  // crash/restart. Only RECENT orphans (see RECENT_ORPHAN_WINDOW_MS) — old
  // drift is dropped silently. Grouped per chat, capped at 3 snippets, best-effort.
  if (recovery.recentOrphans.length > 0) {
    const byChat = new Map<number, typeof recovery.recentOrphans>();
    for (const orphan of recovery.recentOrphans) {
      const list = byChat.get(orphan.chatId) ?? [];
      list.push(orphan);
      byChat.set(orphan.chatId, list);
    }
    for (const [chatId, orphans] of byChat) {
      const snippets = orphans.slice(0, 3).map((o) => {
        const preview = (o.rawContent || `(${o.inputType})`)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        return `• ${preview}`;
      });
      const notice =
        '⚠️ Ich wurde gerade neu gestartet — deine letzte(n) Nachricht(en) sind ' +
        'dabei evtl. nicht durchgekommen. Bitte nochmal senden:\n' +
        snippets.join('\n');
      try {
        await bot.api.sendMessage(chatId, notice);
      } catch { /* best-effort — startup continues regardless */ }
    }
  }

  // Graceful shutdown (guarded against duplicate signals)
  let shuttingDown = false;

  const forceShutdown = () => {
    console.error('[Shutdown] Force exit after timeout — some requests may have been lost.');
    process.exit(1);
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[Shutdown] Graceful shutdown initiated...');

    // 1. Stop polling — no new updates accepted
    const stopPromise = runner.stop();

    // 2. Clear document batch timers before cancelling requests
    clearAllBatchTimers();

    // 3. Notify active users and cancel their requests
    const activeKeys = getActiveSessionKeys();
    if (activeKeys.length > 0) {
      console.log(`[Shutdown] Notifying ${activeKeys.length} active session(s)...`);
      for (const sessionKey of activeKeys) {
        try {
          const chatId = Number(sessionKey.split(':')[0]);
          if (!isNaN(chatId)) {
            // 5s send timeout — don't let a slow Telegram API block the shutdown
            await Promise.race([
              bot.api.sendMessage(chatId, '🔄 Bot restarting — your request was cancelled. Please send your message again in a moment.'),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('send timeout')), 5000)),
            ]);
          }
        } catch { /* best-effort — shutdown continues regardless */ }
      }
      await cancelAllRequests();
    }

    // 4. Wait for runner to finish
    try { await stopPromise; } catch { /* ignore */ }

    // 5. Cleanup
    releaseLock(config.BOT_NAME);
    allowSleep();
    stopCleanup();
    closeMemoryDb();
    closeInputLog();

    console.log('[Shutdown] Done. Exiting.');
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown(); setTimeout(forceShutdown, 15_000).unref(); });
  process.on('SIGTERM', () => { shutdown(); setTimeout(forceShutdown, 15_000).unref(); });

  // Keep alive until the runner stops (crash or explicit stop)
  await runner.task();
}

function is409Error(error: unknown): boolean {
  if (error instanceof GrammyError && error.error_code === 409) return true;
  if (error instanceof Error && error.message.includes('409')) return true;
  return false;
}

/**
 * Start the bot exactly once. On a 409 conflict we do NOT retry in-process:
 * an in-process retry calls main() -> run() again while the previous runner
 * is still polling, producing a self-inflicted 409. Instead we exit cleanly
 * and let launchd relaunch after its ThrottleInterval — by which time the
 * competing poller is gone.
 */
async function start() {
  try {
    await main();
    // Clean exit from runner.task()
    releaseLock(config.BOT_NAME);
  } catch (error) {
    releaseLock(config.BOT_NAME);
    allowSleep();

    if (is409Error(error)) {
      console.error('[409] Conflict: another getUpdates poller is active. Exiting cleanly —');
      console.error('      launchd relaunches after ThrottleInterval; the conflict should be gone by then.');
      console.error('      If this persists: launchctl list | grep nexusgram');
      process.exit(0); // exit 0 — relaunch is throttled, no tight loop
    }

    console.error('Fatal error:', error);
    process.exit(1);
  }
}

start();
