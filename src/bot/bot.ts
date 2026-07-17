import { Bot, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { sequentialize } from '@grammyjs/runner';
import { config } from '../config.js';
import { buildSessionKey } from '../utils/session-key.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import { inputLogMiddleware } from './middleware/input-log.middleware.js';
import { taskLedgerMiddleware } from './middleware/task-ledger.middleware.js';
import {
  handleStart,
  handleClear,
  handleClearCallback,
  handleProject,
  handleNexusProject,
  handleNewProject,
  handleProjectCallback,
  handleStatus,
  handleMode,
  handleQuiet,
  handleModeCallback,
  handleTTS,
  handleTTSCallback,
  handleTelegraph,
  handleTelegraphCallback,
  handleBotStatus,
  handleRestartBot,
  handleRestartCallback,
  handleContext,
  handlePing,
  handleCancel,
  handleCommands,
  handleModelCommand,
  handleModelCallback,
  handlePlan,
  handleExplore,
  handleResume,
  handleResumeCallback,
  handleContinue,
  handleLoop,
  handleSessions,
  handleTeleport,
  handleFile,
  handleReddit,
  handleVReddit,
  handleMedium,
  handleMediumCallback,
  handleTerminalUI,
  handleTerminalUICallback,
  handleTranscribe,
  handleTranscribeAudio,
  handleTranscribeDocument,
  handleExtract,
  handleExtractCallback,
  handleRedditActionCallback,
  handleReset,
  handleResetCallback,
  handleInbox,
  handleInboxCallback,
  handleWiki,
  handlePrivate,
  handleHealth,
  handleBrief,
  handleWith,
  handleEngine,
  handleCodex,
  handleWhereAreWe,
} from './handlers/command.handler.js';
import { handleMessage } from './handlers/message.handler.js';
import { handleVoice } from './handlers/voice.handler.js';
import { handlePhoto, handleImageDocument } from './handlers/photo.handler.js';
import { handleDocument } from './handlers/document.handler.js';
import { handleFollowUpCallback } from '../telegram/followup-buttons.js';
import { startRegistrySweep } from '../handler/request-registry.js';
import { resumeOpenTask } from '../inbox/task-resume.js';

// Resolve sequentialize constraint: same-chat updates are ordered,
// but /cancel is registered BEFORE this middleware so it bypasses it.
function getSequentializeKey(ctx: Context): string | undefined {
  const chatId = ctx.chat?.id;
  if (!chatId) return undefined;
  const msg = (ctx.message ?? ctx.callbackQuery?.message) as
    | { is_topic_message?: boolean; message_thread_id?: number }
    | undefined;
  const threadId = msg?.is_topic_message ? msg.message_thread_id : undefined;
  return buildSessionKey(chatId, threadId);
}

export async function createBot(): Promise<Bot> {
  // Registered only for the Master bot. The handlers additionally check the
  // allowed user ID, which keeps the restriction a code gate rather than UI.
  const masterEngineCommandsEnabled = config.BOT_NAME === 'Nexusgram';
  // Stage 2b Action 9: defensive RequestContext registry sweep. Eager-remove
  // happens in `disposeRequestContext()`; this periodic safety-net catches
  // contexts whose handler crashed outside the try/finally guard. 60s cadence.
  startRegistrySweep();

  const botOptions: ConstructorParameters<typeof Bot>[1] = {
    client: {
      // Default is 500s which causes long hangs on network interruptions.
      // 60s is enough for long polling (30s) + file uploads while recovering
      // from stuck connections much faster.
      timeoutSeconds: 60,
      // Local Telegram Bot API Server support (raises 20MB → 2GB file limit)
      ...(config.TELEGRAM_API_SERVER_URL ? { apiRoot: config.TELEGRAM_API_SERVER_URL } : {}),
    },
  };
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN, botOptions);

  if (config.TELEGRAM_API_SERVER_URL) {
    console.log(`📡 Using local Telegram API server: ${config.TELEGRAM_API_SERVER_URL}`);
  }

  // Auto-retry on transient network errors (ECONNRESET, socket hang up, etc.)
  // Also handles 429 rate limits by respecting Telegram's retry_after
  bot.api.config.use(autoRetry({
    maxRetryAttempts: 5,
    maxDelaySeconds: 60, // Cap retry delay at 60 seconds (will retry sooner rather than wait 900s)
    rethrowInternalServerErrors: false, // Retry on 5xx errors
  }));

  // Register command menu for autocomplete (non-blocking)
  // Minimal mode: Space-Bots only show user-relevant commands
  const minimalCommands: Record<string, { start: string; clear: string; cancel: string; tts: string; inbox: string; transcribe: string; status: string }> = {
    de: { start: '👋 Hilfe und Übersicht', clear: '🗑️ Neues Gespräch starten', cancel: '⏹️ Aktuelle Anfrage abbrechen', tts: '🔊 Sprachantworten an/aus', inbox: '📬 Empfangene Dokumente anzeigen', transcribe: '🎤 Audio in Text umwandeln', status: '📊 Session-Status' },
    ru: { start: '👋 Помощь и обзор', clear: '🗑️ Начать новый разговор', cancel: '⏹️ Отменить текущий запрос', tts: '🔊 Голосовые ответы вкл/выкл', inbox: '📬 Входящие документы', transcribe: '🎤 Преобразовать аудио в текст', status: '📊 Статус сессии' },
    fa: { start: '👋 راهنما و خلاصه', clear: '🗑️ شروع مکالمه جدید', cancel: '⏹️ لغو درخواست فعلی', tts: '🔊 پاسخ صوتی روشن/خاموش', inbox: '📬 مشاهده اسناد دریافتی', transcribe: '🎤 تبدیل صدا به متن', status: '📊 وضعیت جلسه' },
    en: { start: '👋 Help and overview', clear: '🗑️ Start new conversation', cancel: '⏹️ Cancel current request', tts: '🔊 Toggle voice replies', inbox: '📬 View incoming documents', transcribe: '🎤 Transcribe audio to text', status: '📊 Session status' },
  };
  const lang = minimalCommands[config.BOT_COMMAND_LANGUAGE] ? config.BOT_COMMAND_LANGUAGE : 'de';
  const t = minimalCommands[lang];
  const commandList = config.BOT_MINIMAL_COMMANDS ? [
    { command: 'start', description: t.start },
    { command: 'brief', description: '📝 Topic-Brief speichern (durchsuchbar)' },
    { command: 'clear', description: t.clear },
    { command: 'cancel', description: t.cancel },
    { command: 'tts', description: t.tts },
    ...(config.DOCUMENT_INBOX_ENABLED ? [{ command: 'inbox', description: t.inbox }] : []),
    ...(config.TRANSCRIBE_ENABLED ? [{ command: 'transcribe', description: t.transcribe }] : []),
    ...(masterEngineCommandsEnabled ? [
      { command: 'engine', description: '⚙️ Show or switch AI engine' },
      { command: 'codex', description: '🤖 Run a read-only Codex task' },
    ] : []),
    { command: 'wo-stehen-wir', description: '📌 Erinnerungen und Aufträge' },
    { command: 'status', description: t.status },
  ] : [
    { command: 'start', description: '🚀 Show help and getting started' },
    { command: 'brief', description: '📝 Save topic brief (searchable input_log)' },
    { command: 'project', description: '📁 Set working directory' },
    { command: 'nexus', description: '🧠 Open the NEXUS repo in bridge mode' },
    { command: 'status', description: '📊 Show current session status' },
    { command: 'clear', description: '🗑️ Clear conversation history' },
    { command: 'cancel', description: '⏹️ Cancel current request' },
    { command: 'softreset', description: '🔄 Soft reset (cancel + clear session)' },
    { command: 'resume', description: '▶️ Resume a session' },
    { command: 'botstatus', description: '🩺 Show bot process status' },
    { command: 'restartbot', description: '🔁 Restart the bot' },
    { command: 'context', description: '🧠 Show Claude context usage' },
    { command: 'plan', description: '📋 Start planning mode' },
    { command: 'explore', description: '🔍 Explore codebase' },
    { command: 'loop', description: '🔄 Run in loop mode' },
    { command: 'sessions', description: '📚 View saved sessions' },
    { command: 'teleport', description: '🚀 Move session to terminal' },
    ...(config.REDDIT_ENABLED ? [{ command: 'reddit', description: '📡 Fetch Reddit posts & subreddits' }] : []),
    ...(config.VREDDIT_ENABLED ? [{ command: 'vreddit', description: '🎬 Download Reddit video from post URL' }] : []),
    ...(config.MEDIUM_ENABLED ? [{ command: 'medium', description: '📰 Fetch Medium articles' }] : []),
    ...(config.TRANSCRIBE_ENABLED ? [{ command: 'transcribe', description: '🎤 Transcribe audio to text' }] : []),
    ...(config.EXTRACT_ENABLED ? [{ command: 'extract', description: '📥 Extract text/audio/video from URL' }] : []),
    ...(config.DOCUMENT_INBOX_ENABLED ? [{ command: 'inbox', description: '📬 View and manage document inbox' }] : []),
    { command: 'file', description: '📎 Download a file from project' },
    { command: 'telegraph', description: '📄 View markdown with Instant View' },
    { command: 'model', description: '🤖 Switch AI model' },
    { command: 'mode', description: '⚙️ Toggle streaming mode' },
    { command: 'terminalui', description: '🖥️ Toggle terminal-style display' },
    { command: 'tts', description: '🔊 Toggle voice replies' },
    { command: 'health', description: '🩺 Compliance + observability dashboard' },
    { command: 'wo-stehen-wir', description: '📌 Fällige Erinnerungen und offene Aufträge' },
    { command: 'with', description: '🧠 Show recent OMI/memory mentions for a person' },
    ...(masterEngineCommandsEnabled ? [
      { command: 'engine', description: '⚙️ Show or switch AI engine' },
      { command: 'codex', description: '🤖 Run a read-only Codex task' },
    ] : []),
    { command: 'commands', description: '📜 List all commands' },
  ];

  // Stage 2c (Mai-Intervention 2026-05-12): force-refresh the Telegram
  // command menu. Live smoke-test 22:21 verified that newly added commands
  // (e.g. /health) failed to match `bot.command('health', …)` because the
  // Telegram backend kept serving a stale bot_command list — the user's
  // typed "/health" arrived as plain text, fell through Grammy's command
  // matcher and hit Claude as "Unknown skill: health". Deleting first
  // forces Telegram to drop the cached list before we register the new one.
  bot.api.deleteMyCommands().catch((err) => {
    console.warn('⚠️ deleteMyCommands failed (non-fatal):', err?.message ?? err);
  });
  bot.api.setMyCommands(commandList).then(async () => {
    console.log(`📋 Command menu registered (${commandList.length} commands)`);
    // Confirm the Telegram backend now sees the new list. If a registered
    // bot.command(...) is missing here it usually means a stale cache or a
    // mismatch between this commandList and what the user is typing.
    try {
      const live = await bot.api.getMyCommands();
      console.log(
        `📋 Telegram backend reports ${live.length} commands: ` +
          `[${live.map((c) => '/' + c.command).join(', ')}]`,
      );
    } catch (err) {
      console.debug('[bot] getMyCommands confirmation failed:', err);
    }
  }).catch((err) => {
    console.warn('⚠️ Failed to register commands:', err.message);
  });

  // Apply auth middleware to all updates
  bot.use(authMiddleware);

  // Sprint 3: this is a hard write-ahead gate. A content update does not reach
  // a handler until its per-bot task record is safely on disk.
  bot.use(taskLedgerMiddleware);

  // Schlachtplan Akt 1.2: durable Input-Log. Registered AFTER auth, BEFORE
  // sequentialize — every content update is persisted to SQLite + ACKed the
  // moment it arrives, so nothing is lost when a later agent turn hangs or
  // gets watchdog-cancelled (RI-19). Bot commands are skipped inside the
  // middleware. This is the single hard input-durability invariant.
  bot.use(inputLogMiddleware);

  // /cancel, /reset, /softreset, and /ping fire BEFORE sequentialize so they bypass per-chat ordering.
  // This lets them interrupt a running query without waiting for it to finish.
  bot.command('cancel', handleCancel);
  bot.command('softreset', handleReset);
  bot.command('reset', handleReset); // alias for /softreset
  bot.command('ping', handlePing);
  // /health is read-only and must respond even when sequentialize is backed up,
  // so register before the sequentialize middleware (same tier as /ping).
  bot.command('health', handleHealth);
  bot.command('wo-stehen-wir', handleWhereAreWe);

  // Sequentialize: same-chat updates are processed in order.
  // This runs AFTER /cancel so cancel bypasses it.
  bot.use(sequentialize(getSequentializeKey));

  // Bot command handlers (sequentialized per chat)
  bot.command('start', handleStart);
  bot.command('clear', handleClear);
  bot.command('project', handleProject);
  bot.command('nexus', handleNexusProject);
  bot.command('newproject', handleNewProject);
  bot.command('status', handleStatus);
  bot.command('mode', handleMode);
  bot.command('quiet', handleQuiet);
  bot.command('terminalui', handleTerminalUI);
  bot.command('tts', handleTTS);
  bot.command('botstatus', handleBotStatus);
  bot.command('restartbot', handleRestartBot);
  bot.command('context', handleContext);
  if (masterEngineCommandsEnabled) {
    bot.command('engine', handleEngine);
    bot.command('codex', handleCodex);
  }

  bot.command('commands', handleCommands);
  bot.command('model', handleModelCommand);
  bot.command('plan', handlePlan);
  bot.command('explore', handleExplore);

  // Session resume commands
  bot.command('resume', handleResume);
  bot.command('continue', handleContinue);
  bot.command('sessions', handleSessions);

  // Loop mode
  bot.command('loop', handleLoop);

  // Teleport to terminal
  bot.command('teleport', handleTeleport);

  // File commands
  bot.command('file', handleFile);
  bot.command('telegraph', handleTelegraph);

  // Document inbox
  if (config.DOCUMENT_INBOX_ENABLED) {
    bot.command('inbox', handleInbox);
  }

  // Reddit
  if (config.REDDIT_ENABLED) {
    bot.command('reddit', handleReddit);
  }
  if (config.VREDDIT_ENABLED) {
    bot.command('vreddit', handleVReddit);
  }
  if (config.MEDIUM_ENABLED) {
    bot.command('medium', handleMedium);
  }

  // Transcribe
  if (config.TRANSCRIBE_ENABLED) {
    bot.command('transcribe', handleTranscribe);
  }

  // Media extraction
  if (config.EXTRACT_ENABLED) {
    bot.command('extract', handleExtract);
  }
  bot.command('wiki', handleWiki);
  bot.command('private', handlePrivate);

  // FIX 6+ Step 5 (2026-05-25): /brief — explicit topic briefing entry-point
  // that bypasses the input-log middleware's "skip slash-commands" rule by
  // calling recordInput() directly in the handler. See handleBrief docstring.
  bot.command('brief', handleBrief);

  // Callback query handler for inline keyboards
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith('taskresume:')) {
      const taskId = Number(data.slice('taskresume:'.length));
      if (!Number.isSafeInteger(taskId) || taskId <= 0) {
        await ctx.answerCallbackQuery({ text: 'Ungültiger Auftrag.' });
      } else {
        await resumeOpenTask(ctx, bot, taskId);
      }
    } else if (data.startsWith('resume:')) {
      await handleResumeCallback(ctx);
    } else if (data.startsWith('model:')) {
      await handleModelCallback(ctx);
    } else if (data.startsWith('mode:')) {
      await handleModeCallback(ctx);
    } else if (data.startsWith('terminalui:')) {
      await handleTerminalUICallback(ctx);
    } else if (data.startsWith('tts:')) {
      await handleTTSCallback(ctx);
    } else if (data.startsWith('telegraph:')) {
      await handleTelegraphCallback(ctx);
    } else if (data.startsWith('clear:')) {
      await handleClearCallback(ctx);
    } else if (data.startsWith('project:')) {
      await handleProjectCallback(ctx);
    } else if (data.startsWith('medium:')) {
      await handleMediumCallback(ctx);
    } else if (data.startsWith('extract:')) {
      await handleExtractCallback(ctx);
    } else if (data.startsWith('reddit_action:')) {
      await handleRedditActionCallback(ctx);
    } else if (data.startsWith('restart:')) {
      await handleRestartCallback(ctx);
    } else if (data.startsWith('reset:')) {
      await handleResetCallback(ctx);
    } else if (data.startsWith('inbox:')) {
      await handleInboxCallback(ctx);
    } else if (data.startsWith('followup:')) {
      await handleFollowUpCallback(ctx);
    } else if (data.startsWith('etime:')) {
      await ctx.answerCallbackQuery();
      try { await ctx.deleteMessage(); } catch { /* ignore */ }
      if (data === 'etime:done') {
        await ctx.reply('✅ Super, eingetragen! Bis nächste Woche.');
      } else {
        await ctx.reply('⏰ Ok, vergiss es nicht — Buchungsschluss kommt schnell!');
      }
    }
  });

  // Handle voice messages
  bot.on('message:voice', handleVoice);

  // Handle audio messages (music/audio files - separate from voice notes)
  bot.on('message:audio', handleTranscribeAudio);

  // Handle images
  bot.on('message:photo', handlePhoto);

  // Handle documents: audio transcribe → image documents → general documents (INBOX)
  bot.on('message:document', async (ctx) => {
    const replyTo = ctx.message?.reply_to_message;
    const doc = ctx.message?.document;

    // 1. Audio documents → auto-transcribe (no ForceReply required)
    if (doc?.mime_type?.startsWith('audio/')) {
      await handleTranscribeDocument(ctx);
      return;
    }

    // 2. Image documents → existing photo handler (SVG excluded → goes to INBOX)
    if (doc?.mime_type?.startsWith('image/') && doc.mime_type !== 'image/svg+xml') {
      await handleImageDocument(ctx);
      return;
    }

    // 3. All other documents → INBOX handler
    if (config.DOCUMENT_INBOX_ENABLED) {
      await handleDocument(ctx);
    }
  });

  // Handle regular text messages
  bot.on('message:text', handleMessage);

  // Error handler
  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  return bot;
}
