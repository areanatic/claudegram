import { run } from '@grammyjs/runner';
import { GrammyError } from 'grammy';
import { createBot, registerBotCommands } from './bot/bot.js';
import { config } from './config.js';
import { preventSleep, allowSleep } from './utils/caffeinate.js';
import { stopCleanup } from './telegram/deduplication.js';
import { closeMemoryDb } from './memory/nexus-memory.js';
import { closeCaptureLedger } from './memory/capture-ledger.js';
import { closeInputLog, ensureInputLogInitialized, claimResumableOrphans } from './inbox/input-log.js';
import { closeTaskLedger, ensureTaskLedgerInitialized, recoverOpenTasks, type OpenTask } from './inbox/task-ledger.js';
import { runAutoResume } from './inbox/auto-resume.js';
import { acquireLock, releaseLock } from './utils/pid-lock.js';
import { cancelAllRequests, getActiveSessionKeys } from './claude/request-queue.js';
import { parseSessionKey } from './utils/session-key.js';
import { clearAllBatchTimers } from './bot/handlers/document.handler.js';
import { startScannerProWatcher, stopScannerProWatcher } from './scanners/scanner-pro-watcher.js';
import { startOmiBridgeWatcher, stopOmiBridgeWatcher } from './scanners/omi-bridge-watcher.js';
import { initializeBotStartup, StartupRetryExhaustedError } from './telegram/startup-retry.js';
import { sendStartupFailureAlert } from './telegram/startup-alert.js';
import {
  recordInitialTelegramRoundtrip,
  startBotHealthHeartbeat,
  stopBotHealthHeartbeat,
} from './health/bot-health.js';

async function notifyOpenTasks(bot: Awaited<ReturnType<typeof createBot>>, tasks: OpenTask[]): Promise<void> {
  if (!tasks.length) return;
  const bySession = new Map<string, OpenTask[]>();
  for (const task of tasks) {
    const list = bySession.get(task.sessionKey) ?? [];
    list.push(task);
    bySession.set(task.sessionKey, list);
  }
  for (const [sessionKey, sessionTasks] of bySession) {
    const { chatId, threadId } = parseSessionKey(sessionKey);
    // Do not echo task text at boot: a recovery message can be visible in a
    // group/topic. Kind and failure reason are sufficient to resume safely.
    const previews = sessionTasks.slice(0, 3).map((task) =>
      `• ${task.taskKind}${task.reason ? ` (${task.reason})` : ''}`,
    );
    const remainder = sessionTasks.length > previews.length ? `\n… und ${sessionTasks.length - previews.length} weitere.` : '';
    const message = `⚠️ Ich habe noch ${sessionTasks.length} offene Aufträge aus der vorherigen Sitzung:\n${previews.join('\n')}${remainder}\n\nSchreib „weiter“, wenn ich einen davon fortsetzen soll.`;
    try {
      await bot.api.sendMessage(chatId, message, {
        ...(threadId === undefined ? {} : { message_thread_id: threadId }),
        reply_markup: { inline_keyboard: sessionTasks.slice(0, 3).map((task) => [{ text: `▶️ ${task.taskKind} fortsetzen`, callback_data: `taskresume:${task.id}` }]) },
      });
    } catch (error) {
      console.error(`[TaskLedger] open-task recovery notice failed for ${sessionKey}:`, error);
    }
  }
}

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

  // Initialize bot (getMe) before starting a poller. Telegram can return a
  // transient 401 during provider/network turbulence; retry it in a bounded,
  // jittered window rather than entering a launchd crash-loop. A 409 is not
  // retried here: another poller must clear before launchd tries again. The
  // command menu is part of the bootstrap transaction and remains strictly
  // post-init on every attempt.
  await initializeBotStartup(
    () => bot.init(),
    () => registerBotCommands(bot),
    {
      maxAttempts: config.BOT_INIT_MAX_ATTEMPTS,
      baseDelayMs: config.BOT_INIT_RETRY_BASE_DELAY_MS,
      maxDelayMs: 60_000,
      onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
        console.warn(
          `[Startup] bot.init attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs}ms:`,
          error instanceof Error ? error.message : error,
        );
      },
    },
  );
  recordInitialTelegramRoundtrip();
  startBotHealthHeartbeat(bot);
  console.log(`✅ Bot started as @${bot.botInfo.username}`);
  console.log('📱 Send /start in Telegram to begin');

  // FIX 6+ Stage 2b (Codex Pattern-B F-04): force eager input-log init at
  // boot, BEFORE any user-input pathway can demand it. Without this the lazy
  // `getDb()` would fire during the first agent prompt-build (via
  // `buildContextAvailabilityPrompt → getLatestInputLog`), running the
  // migration + FTS rebuild while a parallel session held a connection.
  // Deterministic boot-time init removes that lock-risk surface.
  ensureInputLogInitialized();
  // Fail loud before polling: accepting a task without its durable ledger would
  // recreate the exact restart/timeout loss this sprint closes.
  ensureTaskLedgerInitialized();
  const openTasks = recoverOpenTasks();

  // INV-01 Auto-Resume + boot-recovery: any input_log row still
  // 'received'/'processing' is orphaned from a previous process. claimResumableOrphans
  // CLAIMS recent/public/replayable TEXT rows (status→'processing', resume_attempts+1)
  // so the runner can re-process the user's interrupted task, and drops the rest
  // (old drift + non-replayable) exactly like the legacy boot-recovery. Runs
  // synchronously BEFORE polling starts, so the budget is claimed atomically
  // before any freshly-arriving input — and a new input is never seen as orphaned.
  const recovery = claimResumableOrphans();
  if (recovery.recovered > 0) {
    console.log(`[Startup] Boot-recovery: ${recovery.recovered} orphaned input(s) from a previous run dropped (${recovery.resumable.length} claimed for replay).`);
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

  // Phase 7.x (2026-05-27): in-process Scanner-Pro sync scheduler. Triple-gated
  // inside startScannerProWatcher — only runs when BOT_NAME='Nexusgram',
  // NEXUS_MEMORY_SCOPE='self_private' AND SCANNER_PRO_WATCHER_ENABLED=true.
  // No-op on Family/Mom/Dad/Test bots.
  startScannerProWatcher();

  // Phase 7.7 (2026-05-28): in-process OMI-Bridge auto-orchestrator. Mirrors
  // Scanner-Pro's triple-gate (ENABLED + BOT_NAME=Nexusgram + scope=self_private)
  // so Family/Test bots get a no-op. Wraps omi_bridge_pipeline.sh + ocr.sh +
  // phase7_ner_import.py + phase7_tasks_import.py with cross-process locking,
  // persistent failure-state, and a privacy postcondition SQL check.
  // Codex pre-review: 0.82 CONDITIONAL-GO with all 5 P0s addressed.
  startOmiBridgeWatcher();

  // INV-01 Auto-Resume: replay the CLAIMED orphans through the real agent path
  // so an interrupted task is finished, not lost. Fire-and-forget AFTER the
  // runner is polling (the per-session queue + agent need the bot live), exactly
  // like the watchers above — boot latency must never block responsiveness.
  void runAutoResume(bot, recovery);
  void notifyOpenTasks(bot, openTasks);

  // FIX 4 (2026-05-22): tell users whose in-flight message was lost to a
  // crash/restart. With INV-01 these are now only the NON-replayable recent
  // orphans (private / media / side-effect-already-started / attempts-exhausted /
  // over the per-boot cap). Old drift is dropped silently. Grouped per chat,
  // capped at 3 snippets, best-effort.
  if (recovery.recentOrphans.length > 0) {
    // Group by full sessionKey (not just chatId) so a forum-topic notice lands
    // in its originating thread instead of the General topic. parseSessionKey
    // recovers chatId + threadId; threadId undefined in regular chats → unchanged.
    const bySession = new Map<string, typeof recovery.recentOrphans>();
    for (const orphan of recovery.recentOrphans) {
      const list = bySession.get(orphan.sessionKey) ?? [];
      list.push(orphan);
      bySession.set(orphan.sessionKey, list);
    }
    for (const [sessionKey, orphans] of bySession) {
      const { chatId, threadId } = parseSessionKey(sessionKey);
      const snippets = orphans.slice(0, 3).map((o) => {
        // Privacy (review round-2): never echo the CONTENT of a private message
        // in the restart notice — defensive for group chats. The user still
        // learns a private message was interrupted, just not its text.
        const preview =
          o.privacy === 'private'
            ? '(private Nachricht)'
            : (o.rawContent || `(${o.inputType})`).replace(/\s+/g, ' ').trim().slice(0, 120);
        return `• ${preview}`;
      });
      const notice =
        '⚠️ Ich wurde gerade neu gestartet — deine letzte(n) Nachricht(en) sind ' +
        'dabei evtl. nicht durchgekommen. Bitte nochmal senden:\n' +
        snippets.join('\n');
      const sendOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
      try {
        await bot.api.sendMessage(chatId, notice, sendOpts);
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
          // activeKeys are full sessionKeys → recover both chatId AND the forum
          // topic so the restart notice lands in the originating thread, not the
          // General topic. threadId undefined in regular chats → {} (unchanged).
          const { chatId, threadId } = parseSessionKey(sessionKey);
          if (!isNaN(chatId)) {
            const sendOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
            // 5s send timeout — don't let a slow Telegram API block the shutdown
            await Promise.race([
              bot.api.sendMessage(chatId, '🔄 Bot restarting — your request was cancelled. Please send your message again in a moment.', sendOpts),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('send timeout')), 5000)),
            ]);
          }
        } catch { /* best-effort — shutdown continues regardless */ }
      }
      await cancelAllRequests();
    }

    // 4. Wait for runner to finish
    try { await stopPromise; } catch { /* ignore */ }

    // 5. Stop scanner-pro watcher (terminates child + waits up to 8s grace).
    // Phase 7.x (2026-05-27): mirrors startScannerProWatcher gate — no-op on
    // bots where the watcher was never started.
    try { await stopScannerProWatcher(); } catch { /* ignore */ }

    // Phase 7.7 shutdown: SIGTERM the orchestrator's process-group so any
    // running child (ssh/rsync/python/ffmpeg descendants) gets the signal
    // together, with 8s grace before SIGKILL.
    try { await stopOmiBridgeWatcher(); } catch { /* ignore */ }
    stopBotHealthHeartbeat();

    // 6. Cleanup
    releaseLock(config.BOT_NAME);
    allowSleep();
    stopCleanup();
    closeMemoryDb();
    closeCaptureLedger();
    closeInputLog();
    closeTaskLedger();

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

    if (error instanceof StartupRetryExhaustedError) {
      const reason = error.cause instanceof Error ? error.cause.message : String(error.cause);
      const alert = `🚨 NexusGram ${config.BOT_NAME}: Telegram bootstrap failed after ${error.attempts} attempts (${reason.slice(0, 180)}). Process exits fail-loud.`;
      console.error(`[Startup] ${alert}`);
      try {
        await sendStartupFailureAlert(config.TELEGRAM_PING_SCRIPT, alert);
      } catch (alertError) {
        // The alert path itself must be visible in launchd logs; it may be the
        // incident root cause, never a silent best-effort side path.
        console.error('[Startup] FATAL: Telegram alert path also failed:', alertError);
      }
    }

    console.error('Fatal error:', error);
    process.exit(1);
  }
}

start();
