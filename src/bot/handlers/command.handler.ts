import { Context, InputFile } from 'grammy';
import { sessionManager } from '../../claude/session-manager.js';
import {
  clearConversation,
  sendToAgent,
  setModel,
  getModel,
  isDangerousMode,
  getCachedUsage,
  StaleTurnError,
  assertTurnIsCurrent,
  forgetChatSession,
  discardCancelledTurnState,
  setQuiet,
  isQuiet,
  getLastMcpInventory,
} from '../../claude/agent.js';
import { occupancyTokens } from '../../claude/context-pressure.js';
import { config } from '../../config.js';
import { getBotEffectivenessHealth } from '../../health/bot-health.js';
import { messageSender } from '../../telegram/message-sender.js';
import { getUptimeFormatted } from '../middleware/stale-filter.js';
import { getAvailableCommands } from '../../claude/command-parser.js';
import {
  cancelRequest,
  resetRequest,
  clearQueue,
  isProcessing,
  queueRequest,
  setAbortController,
  getActiveSessionKeys,
  invalidateCurrentTurn,
} from '../../claude/request-queue.js';
import { getScannerWatcherStatus } from '../../scanners/scanner-pro-watcher.js';
import { getOmiBridgeWatcherStatus } from '../../scanners/omi-bridge-watcher.js';
import { createTelegraphFromFile, createTelegraphPage } from '../../telegram/telegraph.js';
import { isMediumUrl, fetchMediumArticle, FreediumArticle } from '../../medium/freedium.js';
import {
  escapeMarkdownV2 as esc,
  escapeTelegramMarkdown,
  replyWithMarkdownFallback,
} from '../../telegram/markdown.js';
import { getTTSSettings, setTTSEnabled, setTTSVoice, setTTSAutoplay, isVoiceActive } from '../../tts/tts-settings.js';
import { getTerminalUISettings, setTerminalUIEnabled } from '../../telegram/terminal-settings.js';
import { getTelegraphSettings, setTelegraphEnabled } from '../../telegram/telegraph-settings.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import { sendFollowUpButtons } from '../../telegram/followup-buttons.js';
import { runPostAgentSuccess } from './post-agent.js';
import { getInputLogRowId } from '../middleware/input-log.middleware.js';
import { registerTranscribePrompt, takeFreshTranscribeReply } from './transcribe-pending.js';
import { transcribeFile, downloadTelegramAudio } from '../../audio/transcribe.js';
import { executeVReddit } from '../../reddit/vreddit.js';
import { redditFetch, redditFetchBoth, type RedditFetchOptions } from '../../reddit/redditfetch.js';
import { fmtTokens, getProgressBar, handleAgentReply } from './message.handler.js';
import {
  detectPlatform,
  platformLabel,
  isValidUrl,
  extractMedia,
  cleanupExtractResult,
  type ExtractMode,
  type ExtractResult,
  type SubtitleFormat,
} from '../../media/extract.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import { sanitizeError, sanitizePath } from '../../utils/sanitize.js';
import { getWorkspaceRoot, isPathWithinRoot } from '../../utils/workspace-guard.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { findDefaultNexusRoot } from '../../nexus/bridge.js';
import { isPrivate, setPrivate, setPublic, getStatus } from '../../memory/privacy-state.js';
import {
  getActiveContextsForSession,
  snapshotRegistry,
} from '../../handler/request-registry.js';
import { markCancelled } from '../../handler/request-context.js';
import { countPending as countPendingInputs, countHandlerNoFinalize, markProcessing, markDone, markDropped, markError, markHandledNoAgent } from '../../inbox/input-log.js';
import {
  ENGINE_NAMES,
  checkEngineAvailability,
  getEngineSelection,
  isEngineName,
  isMasterEngineLane,
  isSafeEngineModel,
  runCodex,
  setEngineSelection,
} from '../../engines/engine.js';
import { buildWhereAreWe, sendProactiveRecall } from '../../memory/proactive-recall.js';

// Helper for consistent MarkdownV2 replies
async function replyMd(ctx: Context, text: string): Promise<void> {
  await replyWithMarkdownFallback(ctx, text, { parse_mode: 'MarkdownV2' });
}

function buildFeatureDisabledMessage(feature: string): string {
  return `⚠️ ${feature} feature is disabled in configuration.`;
}

async function replyFeatureDisabled(ctx: Context, feature: string): Promise<void> {
  await ctx.reply(buildFeatureDisabledMessage(feature), { parse_mode: undefined });
}

/** Build status lines appended to project confirmation messages. */
export function projectStatusSuffix(sessionKey: string): string {
  const model = getModel(sessionKey);
  const dangerous = isDangerousMode() ? '⚠️ ENABLED' : 'Disabled';
  const session = sessionManager.getSession(sessionKey);
  const created = session?.createdAt
    ? new Date(session.createdAt).toLocaleString()
    : new Date().toLocaleString();
  const sessionId = session?.claudeSessionId;

  let suffix = `\n• *Model:* ${esc(model)}\n• *Created:* ${esc(created)}\n• *Dangerous Mode:* ${esc(dangerous)}`;
  if (sessionId) {
    suffix += `\n• *Session ID:* \`${esc(sessionId)}\``;
    suffix += `\n\n💡 To continue this session from the terminal, copy the command below\\.`;
  } else {
    suffix += `\n• *Session ID:* _pending — send a message to start_`;
  }
  return suffix;
}

/** The copyable command sent as a separate message. */
export function resumeCommandMessage(sessionId: string): string {
  return `\`claude --resume ${sessionId}\``;
}

const OPENAI_TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral',
  'echo', 'fable', 'nova', 'onyx',
  'sage', 'shimmer', 'verse', 'marin', 'cedar',
] as const;

const GROQ_TTS_VOICES = [
  'autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy',
] as const;

function getActiveTTSVoices(): readonly string[] {
  return config.TTS_PROVIDER === 'groq' ? GROQ_TTS_VOICES : OPENAI_TTS_VOICES;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const BOTCTL_PATH = path.join(PROJECT_ROOT, 'scripts', 'nexusgram-ctl.sh');
const PROJECT_BROWSER_PAGE_SIZE = 8;

type ProjectBrowserState = {
  root: string;
  current: string;
  page: number;
};

const projectBrowserState = new Map<string, ProjectBrowserState>();

function botctlExists(): boolean {
  return fs.existsSync(BOTCTL_PATH);
}

type TTSMenuMode = 'main' | 'voices';

function parseContextOutput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '⚠️ No context output received.';
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let model = '';
  let tokensLine = '';
  const categories: Array<{ name: string; tokens: string; percent: string }> = [];
  let inCategories = false;

  for (const line of lines) {
    if (/^model:/i.test(line)) {
      model = line.replace(/^model:/i, '').trim();
      continue;
    }
    if (/^tokens:/i.test(line)) {
      tokensLine = line.replace(/^tokens:/i, '').trim();
      continue;
    }
    if (/estimated usage by category/i.test(line)) {
      inCategories = true;
      continue;
    }
    if (inCategories) {
      if (/^category/i.test(line)) continue;
      if (/^-+$/.test(line)) continue;

      const match = line.match(/^(.+?)\s{2,}([0-9.,kKmM]+)\s+([0-9.,]+%)$/);
      if (match) {
        categories.push({ name: match[1].trim(), tokens: match[2], percent: match[3] });
        continue;
      }

      const parts = line.split(/\s+/);
      if (parts.length >= 3 && parts[parts.length - 1].endsWith('%')) {
        const percent = parts.pop() as string;
        const tokens = parts.pop() as string;
        const name = parts.join(' ');
        categories.push({ name, tokens, percent });
      }
    }
  }

  if (!model && !tokensLine && categories.length === 0) {
    return `## 🧠 Context Usage\n\n\`\`\`\n${trimmed}\n\`\`\``;
  }

  let output = '## 🧠 Context Usage';
  if (model) output += `\n- **Model:** ${model}`;
  if (tokensLine) output += `\n- **Tokens:** ${tokensLine}`;

  if (categories.length > 0) {
    output += '\n\n### Estimated usage by category';
    for (const category of categories) {
      output += `\n- **${category.name}:** ${category.tokens} (${category.percent})`;
    }
  }

  output += '\n\n_If this looks stale, send a new message then run /context again._';
  return output;
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

async function runClaudeContext(sessionId: string, cwd: string): Promise<string> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid session ID format');
  }
  return new Promise((resolve, reject) => {
    execFile(
      config.CLAUDE_EXECUTABLE_PATH,
      ['-p', '--resume', sessionId, '/context'],
      {
        cwd,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || error.message).trim();
          reject(new Error(message || 'Failed to run /context'));
          return;
        }
        resolve((stdout || stderr || '').trim());
      }
    );
  });
}

function buildTTSMenu(sessionKey: string, mode: TTSMenuMode) {
  const settings = getTTSSettings(sessionKey);
  const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;
  const apiStatus = hasKey ? 'configured' : 'missing';
  const providerLabel = config.TTS_PROVIDER === 'groq' ? 'Groq Orpheus' : 'OpenAI';

  const statusLine = settings.enabled ? 'ON' : 'OFF';
  const autoplayLine = settings.autoplay ? 'ON' : 'OFF';
  const header = `🔊 *Voice Replies*`;
  const baseText =
    `${header}\n\n` +
    `Provider: *${esc(providerLabel)}*\n` +
    `Status: *${statusLine}*\n` +
    `Voice: *${esc(settings.voice)}*\n` +
    `Autoplay: *${autoplayLine}*\n` +
    `API key: *${esc(apiStatus)}*`;

  if (mode === 'voices') {
    const voices = getActiveTTSVoices();
    const voiceRows: { text: string; callback_data: string }[][] = [];
    const chunkSize = 3;
    for (let i = 0; i < voices.length; i += chunkSize) {
      const chunk = voices.slice(i, i + chunkSize);
      voiceRows.push(chunk.map((voice) => ({
        text: voice === settings.voice ? `✓ ${voice}` : voice,
        callback_data: `tts:voice:${voice}`,
      })));
    }

    const recommended = config.TTS_PROVIDER === 'groq'
      ? 'autumn, troy'
      : 'marin, cedar';

    return {
      text:
        `${header}\n\n` +
        `Pick a voice\\.\nRecommended: ${esc(recommended)}\\.`,
      keyboard: [
        ...voiceRows,
        [{ text: 'Back', callback_data: 'tts:back' }],
      ],
    };
  }

  const autoplayLabel = settings.autoplay ? '✓ Autoplay' : 'Autoplay';

  return {
    text: baseText,
    keyboard: [
      [
        { text: settings.enabled ? '✓ On' : 'On', callback_data: 'tts:on' },
        { text: !settings.enabled ? '✓ Off' : 'Off', callback_data: 'tts:off' },
      ],
      [
        { text: `Voice: ${settings.voice}`, callback_data: 'tts:voices' },
        { text: autoplayLabel, callback_data: 'tts:autoplay' },
      ],
    ],
  };
}

function buildTelegraphMenu(sessionKey: string) {
  const settings = getTelegraphSettings(sessionKey);
  const globalEnabled = config.TELEGRAPH_ENABLED;
  const globalStatus = globalEnabled ? 'enabled' : 'disabled';

  const statusLine = settings.enabled ? 'ON' : 'OFF';
  const header = `📄 *Instant View \\(Telegraph\\)*`;

  const baseText =
    `${header}\n\n` +
    `Status: *${statusLine}*\n` +
    `Global config: *${esc(globalStatus)}*\n\n` +
    `_When enabled, long responses and tables are rendered as Telegraph articles with Instant View\\._`;

  // If global config is disabled, show warning and no toggle
  if (!globalEnabled) {
    return {
      text:
        `${header}\n\n` +
        `⚠️ *Disabled globally*\n\n` +
        `Telegraph is disabled in the bot configuration\\.\n` +
        `Set \`TELEGRAPH_ENABLED=true\` in \\.env to enable\\.`,
      keyboard: [],
    };
  }

  return {
    text: baseText,
    keyboard: [
      [
        { text: settings.enabled ? '✓ On' : 'On', callback_data: 'telegraph:on' },
        { text: !settings.enabled ? '✓ Off' : 'Off', callback_data: 'telegraph:off' },
      ],
    ],
  };
}

export async function handleStart(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (keyInfo) await sendProactiveRecall(ctx, keyInfo.sessionKey);
  // Use custom welcome file if configured (Space-Bots)
  if (config.BOT_WELCOME_FILE) {
    try {
      const welcomeText = fs.readFileSync(config.BOT_WELCOME_FILE, 'utf8').trim();
      if (welcomeText) {
        await replyWithMarkdownFallback(ctx, welcomeText, { parse_mode: 'Markdown' });
        return;
      }
    } catch { /* fall through to default */ }
  }

  const dangerousWarning = isDangerousMode()
    ? '\n\n⚠️ *DANGEROUS MODE ENABLED* \\- All tool permissions auto\\-approved'
    : '';

  const welcomeMessage = `👋 *Welcome to Nexusgram\\!*

I bridge your messages to Claude Code running on your local machine\\.

*Getting Started:*
1\\. Set your project directory with \`/project /path/to/project\`
2\\. Start chatting with Claude about your code\\!

*Commands:*
• \`/project <path>\` \\- Open a project
• \`/newproject <name>\` \\- Create a new project
• \`/clear\` \\- Clear session and start fresh
• \`/status\` \\- Show current session info
• \`/commands\` \\- Show all available commands

Current mode: ${config.STREAMING_MODE}${dangerousWarning}`;

  await replyMd(ctx, welcomeMessage);
}

/** Sprint 5: explicit, read-only view of durable captures and the task ledger. */
export async function handleWhereAreWe(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  await ctx.reply(buildWhereAreWe(keyInfo.sessionKey), { parse_mode: undefined });
}

export async function handleClear(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  const projectName = session ? path.basename(session.workingDirectory) : 'current session';

  await replyWithMarkdownFallback(
    ctx,
    `⚠️ *Clear Session?*\n\nThis will clear *${esc(projectName)}* and all conversation history\\.\n\n_This cannot be undone\\._`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✓ Yes, clear it', callback_data: 'clear:confirm' },
            { text: '✗ Cancel', callback_data: 'clear:cancel' },
          ],
        ],
      },
    }
  );
}

export async function handleClearCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('clear:')) return;

  const action = data.replace('clear:', '');

  if (action === 'confirm') {
    sessionManager.clearSession(sessionKey);
    clearConversation(sessionKey);

    await ctx.answerCallbackQuery({ text: 'Session cleared!' });
    await ctx.editMessageText(
      '🔄 Session cleared\\.\n\nUse /project to set a new working directory\\.',
      { parse_mode: 'MarkdownV2' }
    );
  } else {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await ctx.editMessageText('👍 Clear cancelled\\. Your session is intact\\.', { parse_mode: 'MarkdownV2' });
  }
}

export async function handleProjectCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('project:')) return;

  const state = getProjectState(sessionKey);
  const action = data.split(':')[1] || '';

  if (action === 'manual') {
    await ctx.answerCallbackQuery();
    await sendProjectManualPrompt(ctx);
    return;
  }

  if (action === 'use') {
    sessionManager.setWorkingDirectory(sessionKey, state.current);
    clearConversation(sessionKey);

    await ctx.answerCallbackQuery({ text: 'Project set' });
    await ctx.editMessageText(
      `✅ Project: *${esc(path.basename(state.current))}*\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(sessionKey)}`,
      { parse_mode: 'MarkdownV2' }
    );

    const s = sessionManager.getSession(sessionKey);
    if (s?.claudeSessionId) {
      await replyMd(ctx, resumeCommandMessage(s.claudeSessionId));
    }
    return;
  }

  if (action === 'up') {
    const parent = path.dirname(state.current);
    if (isWithinRoot(state.root, parent)) {
      state.current = parent;
      state.page = 0;
    }
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, state, true);
    return;
  }

  if (action === 'page') {
    const direction = data.split(':')[2];
    if (direction === 'next') state.page += 1;
    if (direction === 'prev') state.page = Math.max(0, state.page - 1);
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, state, true);
    return;
  }

  if (action === 'refresh') {
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, state, true);
    return;
  }

  if (action === 'open') {
    const indexPart = data.split(':')[2];
    const index = Number.parseInt(indexPart || '', 10);
    if (Number.isNaN(index)) {
      await ctx.answerCallbackQuery({ text: 'Invalid selection' });
      return;
    }
    const entries = listDirectories(state.current);
    const selected = entries[index];
    if (!selected) {
      await ctx.answerCallbackQuery({ text: 'Selection expired' });
      await sendProjectBrowser(ctx, state, true);
      return;
    }
    const nextPath = path.join(state.current, selected);
    // Resolve symlinks before checking boundaries
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(nextPath);
    } catch {
      await ctx.answerCallbackQuery({ text: 'Path not accessible' });
      return;
    }
    if (!isWithinRoot(state.root, resolvedPath)) {
      await ctx.answerCallbackQuery({ text: 'Outside workspace' });
      return;
    }
    state.current = resolvedPath;
    state.page = 0;
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, state, true);
    return;
  }
}

function getProjectRoot(): string {
  return getWorkspaceRoot();
}

// Use shared isPathWithinRoot from workspace-guard for symlink-safe path validation
const isWithinRoot = isPathWithinRoot;

function listDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function shortenName(name: string, maxLength: number = 24): string {
  if (name.length <= maxLength) return name;
  return `${name.slice(0, maxLength - 1)}…`;
}

function buildProjectBrowserText(state: ProjectBrowserState, totalDirs: number, totalPages: number): string {
  const pageNumber = totalPages === 0 ? 1 : state.page + 1;
  const safePath = esc(state.current);

  return (
    `📁 *Project Browser*\n\n` +
    `*Current:* \`${safePath}\`\n` +
    `*Folders:* ${totalDirs}\n` +
    `*Page:* ${pageNumber}/${Math.max(totalPages, 1)}\n\n` +
    `Select a folder below, or use the current folder\\.`
  );
}

function buildProjectBrowserKeyboard(state: ProjectBrowserState, entries: string[], totalPages: number): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const rows: { text: string; callback_data: string }[][] = [];
  const pageOffset = state.page * PROJECT_BROWSER_PAGE_SIZE;

  for (let i = 0; i < entries.length; i += 2) {
    const row: { text: string; callback_data: string }[] = [];
    const first = entries[i];
    const second = entries[i + 1];

    if (first) {
      const index = pageOffset + i;
      row.push({ text: `📁 ${shortenName(first)}`, callback_data: `project:open:${index}` });
    }
    if (second) {
      const index = pageOffset + i + 1;
      row.push({ text: `📁 ${shortenName(second)}`, callback_data: `project:open:${index}` });
    }
    if (row.length > 0) rows.push(row);
  }

  const navRow: { text: string; callback_data: string }[] = [];
  if (state.current !== state.root) {
    navRow.push({ text: '⬆️ Up', callback_data: 'project:up' });
  }
  navRow.push({ text: '✅ Use this folder', callback_data: 'project:use' });
  navRow.push({ text: '✍️ Enter path', callback_data: 'project:manual' });
  rows.push(navRow);

  const pageRow: { text: string; callback_data: string }[] = [];
  if (state.page > 0) {
    pageRow.push({ text: '◀️ Prev', callback_data: 'project:page:prev' });
  }
  if (state.page < totalPages - 1) {
    pageRow.push({ text: 'Next ▶️', callback_data: 'project:page:next' });
  }
  if (pageRow.length > 0) {
    rows.push(pageRow);
  }

  rows.push([{ text: '🔄 Refresh', callback_data: 'project:refresh' }]);

  return { inline_keyboard: rows };
}

async function sendProjectBrowser(ctx: Context, state: ProjectBrowserState, edit: boolean): Promise<void> {
  const allEntries = listDirectories(state.current);
  const totalPages = Math.max(1, Math.ceil(allEntries.length / PROJECT_BROWSER_PAGE_SIZE));
  const page = Math.min(Math.max(state.page, 0), totalPages - 1);
  state.page = page;

  const pageEntries = allEntries.slice(page * PROJECT_BROWSER_PAGE_SIZE, (page + 1) * PROJECT_BROWSER_PAGE_SIZE);
  const text = buildProjectBrowserText(state, allEntries.length, totalPages);
  const replyMarkup = buildProjectBrowserKeyboard(state, pageEntries, totalPages);

  if (edit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: replyMarkup });
      return;
    } catch {
      // fall through to send new message
    }
  }

  await replyWithMarkdownFallback(ctx, text, { parse_mode: 'MarkdownV2', reply_markup: replyMarkup });
}

async function sendProjectManualPrompt(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  const session = sessionManager.getSession(sessionKey);
  const currentInfo = session
    ? `\n\n_Current: ${esc(path.basename(session.workingDirectory))}_`
    : '';

  await ctx.reply(
    `📁 *Set Project Directory*${currentInfo}\n\n👇 _Enter the path below:_`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: '/home/user/projects/myapp',
        selective: true,
      },
    }
  );
}

function getProjectState(sessionKey: string): ProjectBrowserState {
  const root = getProjectRoot();
  const existing = projectBrowserState.get(sessionKey);
  if (existing && existing.root === root) {
    if (!isWithinRoot(root, existing.current)) {
      existing.current = root;
      existing.page = 0;
    }
    // Refresh timestamp on access to keep active sessions alive
    projectBrowserTimestamps.set(sessionKey, Date.now());
    return existing;
  }

  const session = sessionManager.getSession(sessionKey);
  let initial = root;
  if (session && isWithinRoot(root, session.workingDirectory)) {
    initial = session.workingDirectory;
  }

  const state: ProjectBrowserState = {
    root,
    current: path.resolve(initial),
    page: 0,
  };
  projectBrowserState.set(sessionKey, state);
  projectBrowserTimestamps.set(sessionKey, Date.now());
  return state;
}

export async function handleProject(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  // No args - prompt for input with ForceReply
  if (!args) {
    const state = getProjectState(sessionKey);
    await sendProjectBrowser(ctx, state, false);
    return;
  }

  let projectPath: string;
  const workspaceRoot = getWorkspaceRoot();

  if (args.startsWith('/') || args.startsWith('~')) {
    projectPath = args;
    if (projectPath.startsWith('~')) {
      projectPath = path.join(process.env.HOME || '', projectPath.slice(1));
    }
    projectPath = path.resolve(projectPath);
    if (!isPathWithinRoot(workspaceRoot, projectPath)) {
      await replyMd(ctx, `❌ Path must be within workspace root: \`${esc(workspaceRoot)}\``);
      return;
    }
  } else {
    projectPath = path.join(workspaceRoot, args);
  }

  if (!fs.existsSync(projectPath)) {
    await replyMd(ctx, `📁 Project "${esc(args)}" doesn't exist\\.\n\nCreate it? Use: \`/newproject ${esc(args)}\``);
    return;
  }

  if (!fs.statSync(projectPath).isDirectory()) {
    await replyMd(ctx, `❌ Path is not a directory: \`${esc(projectPath)}\``);
    return;
  }

  sessionManager.setWorkingDirectory(sessionKey, projectPath);
  clearConversation(sessionKey);

  await replyMd(ctx, `✅ Project: *${esc(args)}*\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(sessionKey)}`);

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(s.claudeSessionId));
  }
}

export async function handleNexusProject(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const nexusRoot = findDefaultNexusRoot();
  if (!nexusRoot || !fs.existsSync(nexusRoot) || !fs.statSync(nexusRoot).isDirectory()) {
    await replyMd(ctx, '❌ No NEXUS root found automatically\. Use `/project /absolute/path/to/NEXUS` or set `NEXUS_ROOT` in the environment\.');
    return;
  }

  sessionManager.setWorkingDirectory(sessionKey, nexusRoot);
  clearConversation(sessionKey);

  const label = path.basename(nexusRoot);
  await replyMd(ctx, `🧠 NEXUS bridge active: *${esc(label)}*\n\nClaude will now use the local NEXUS repo plus the NEXUS instruction/agent context automatically\.${projectStatusSuffix(sessionKey)}`);

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(s.claudeSessionId));
  }
}

export async function handleNewProject(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await replyMd(ctx, 'Usage: `/newproject <name>`');
    return;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(args)) {
    await replyMd(ctx, '❌ Project name can only contain letters, numbers, dashes and underscores\\.');
    return;
  }

  const projectPath = path.join(config.WORKSPACE_DIR, args);

  if (fs.existsSync(projectPath)) {
    await replyMd(ctx, `❌ Project "${esc(args)}" already exists\\. Use \`/project ${esc(args)}\` to open it\\.`);
    return;
  }

  fs.mkdirSync(projectPath, { recursive: true, mode: 0o700 });
  sessionManager.setWorkingDirectory(sessionKey, projectPath);
  clearConversation(sessionKey);

  await replyMd(ctx, `✅ Created and opened: *${esc(args)}*\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(sessionKey)}`);

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(s.claudeSessionId));
  }
}

function listProjects(): string[] {
  try {
    const entries = fs.readdirSync(config.WORKSPACE_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

function listProjectFiles(projectPath: string, maxDepth: number = 2): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number, prefix: string = '') {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isFile()) {
          files.push(relativePath);
        } else if (entry.isDirectory() && depth < maxDepth) {
          walk(path.join(dir, entry.name), depth + 1, relativePath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walk(projectPath, 0);
  // Sort by common file types first (README, package.json, src files)
  return files.sort((a, b) => {
    const priority = (f: string) => {
      if (f === 'README.md') return 0;
      if (f === 'package.json') return 1;
      if (f.startsWith('src/')) return 2;
      if (f.endsWith('.md')) return 3;
      return 4;
    };
    return priority(a) - priority(b);
  });
}

function listMarkdownFiles(projectPath: string, maxDepth: number = 3): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number, prefix: string = '') {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.md' || ext === '.markdown') {
            files.push(relativePath);
          }
        } else if (entry.isDirectory() && depth < maxDepth) {
          walk(path.join(dir, entry.name), depth + 1, relativePath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walk(projectPath, 0);
  // Sort README first, then by path
  return files.sort((a, b) => {
    const priority = (f: string) => {
      if (f === 'README.md') return 0;
      if (f === 'CHANGELOG.md') return 1;
      if (f.includes('docs/')) return 2;
      return 3;
    };
    const pa = priority(a), pb = priority(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

export async function handleStatus(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No active session\\.\n\nUse `/project /path/to/project` to get started\\.');
    return;
  }

  const currentModel = getModel(sessionKey);
  const dangerousMode = isDangerousMode() ? '⚠️ ENABLED' : 'Disabled';

  let status = `📊 *Session Status*

• *Working Directory:* \`${esc(session.workingDirectory)}\`
• *Session ID:* \`${esc(session.conversationId)}\`
• *Model:* ${esc(currentModel)}
• *Created:* ${esc(session.createdAt.toLocaleString())}
• *Last Activity:* ${esc(session.lastActivity.toLocaleString())}
• *Mode:* ${esc(config.STREAMING_MODE)}
• *Dangerous Mode:* ${esc(dangerousMode)}
• *Uptime:* ${esc(getUptimeFormatted())}`;

  const cached = getCachedUsage(sessionKey);
  if (cached) {
    // Single-source occupancy (Bug-A metric) — same as footer + guard + /context.
    const usedCtx = occupancyTokens(cached);
    const pct = cached.contextWindow > 0
      ? Math.min(100, Math.round((usedCtx / cached.contextWindow) * 100))
      : 0;
    status += `\n• *Context:* ${esc(String(pct))}% \\(${esc(fmtTokens(usedCtx))}/${esc(fmtTokens(cached.contextWindow))}\\)`;
    status += `\n• *Session Cost:* \\$${esc(cached.totalCostUsd.toFixed(4))}`;
  }

  await replyMd(ctx, status);
}

// Runtime streaming mode (can be toggled, defaults to config)
let runtimeStreamingMode: 'streaming' | 'wait' = config.STREAMING_MODE;

export function getStreamingMode(): 'streaming' | 'wait' {
  return runtimeStreamingMode;
}

export async function handleMode(ctx: Context): Promise<void> {
  const keyboard = [
    [
      {
        text: runtimeStreamingMode === 'streaming' ? '✓ Streaming' : 'Streaming',
        callback_data: 'mode:streaming'
      },
      {
        text: runtimeStreamingMode === 'wait' ? '✓ Wait' : 'Wait',
        callback_data: 'mode:wait'
      },
    ],
  ];

  const description = runtimeStreamingMode === 'streaming'
    ? '_Updates progressively as Claude types_'
    : '_Shows complete response when done_';

  await ctx.reply(
    `⚙️ *Response Mode*\n\nCurrent: *${runtimeStreamingMode}*\n${description}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    }
  );
}

/**
 * /quiet [on|off] — per-chat toggle for the "🐌 brauche länger" progress heartbeat.
 * User feedback 2026-06-05: the status fired "fast immer" and felt like noise / a half-truth
 * (esp. while merely waiting for an MCP permission). No arg = toggle. The agent keeps working
 * either way; this only mutes the non-finalizing nudge. Default (no /quiet) = updates ON.
 */
export async function handleQuiet(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  const arg = (ctx.message?.text || '').split(/\s+/).slice(1).join(' ').trim().toLowerCase();
  const wasQuiet = isQuiet(sessionKey);
  const next = arg === 'on' ? true : arg === 'off' ? false : !wasQuiet;
  setQuiet(sessionKey, next);
  // Plain text (no parse_mode) — avoids MarkdownV2 escaping pitfalls. The earlier MarkdownV2
  // version threw a live GrammyError "Character '-' is reserved" on the unescaped '-' in
  // "Status-Updates" / "/quiet off" (caught only by the E2E test, not the unit test).
  await ctx.reply(
    next
      ? '🔇 Status-Updates aus. Ich melde mich nur noch mit dem Ergebnis (kein „🐌 brauche länger" mehr). Wieder an: /quiet off'
      : '🔔 Status-Updates an. Bei längeren Tasks gebe ich wieder kurz Bescheid. Aus: /quiet on',
    { parse_mode: undefined },
  );
}

export async function handleModeCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('mode:')) return;

  const newMode = data.replace('mode:', '') as 'streaming' | 'wait';
  runtimeStreamingMode = newMode;

  const description = newMode === 'streaming'
    ? '_Updates progressively as Claude types_'
    : '_Shows complete response when done_';

  await ctx.answerCallbackQuery({ text: `Mode set to ${newMode}!` });
  await ctx.editMessageText(
    `✅ Mode set to *${esc(newMode)}*\n\n${description}`,
    { parse_mode: 'MarkdownV2' }
  );
}

export async function handleTerminalUI(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const settings = getTerminalUISettings(sessionKey);
  const currentStatus = settings.enabled ? 'ON' : 'OFF';

  const keyboard = [
    [
      {
        text: settings.enabled ? '✓ On' : 'On',
        callback_data: 'terminalui:on'
      },
      {
        text: !settings.enabled ? '✓ Off' : 'Off',
        callback_data: 'terminalui:off'
      },
    ],
  ];

  const description = settings.enabled
    ? '_Shows spinner animations and tool status during operations_'
    : '_Classic streaming mode with simple cursor_';

  await ctx.reply(
    `🖥️ *Terminal UI Mode*\n\nCurrent: *${currentStatus}*\n${description}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    }
  );
}

export async function handleTerminalUICallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('terminalui:')) return;

  const newState = data.replace('terminalui:', '') === 'on';
  setTerminalUIEnabled(sessionKey, newState);

  const statusText = newState ? 'ON' : 'OFF';
  const description = newState
    ? '_Shows spinner animations and tool status during operations_'
    : '_Classic streaming mode with simple cursor_';

  await ctx.answerCallbackQuery({ text: `Terminal UI ${statusText}!` });
  await ctx.editMessageText(
    `✅ Terminal UI *${statusText}*\n\n${description}`,
    { parse_mode: 'MarkdownV2' }
  );
}

export async function handleTTS(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const menu = buildTTSMenu(sessionKey, 'main');

  await ctx.reply(menu.text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: menu.keyboard },
  });
}

export async function handleTTSCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('tts:')) return;

  if (data === 'tts:on') {
    const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;
    const keyName = config.TTS_PROVIDER === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
    if (!hasKey) {
      await ctx.answerCallbackQuery({ text: `${keyName} missing. Set it in .env and restart.` });
      setTTSEnabled(sessionKey, false);
    } else {
      setTTSEnabled(sessionKey, true);
    }
  } else if (data === 'tts:off') {
    setTTSEnabled(sessionKey, false);
  } else if (data === 'tts:autoplay') {
    const current = getTTSSettings(sessionKey);
    setTTSAutoplay(sessionKey, !current.autoplay);
  } else if (data.startsWith('tts:voice:')) {
    const voice = data.replace('tts:voice:', '');
    const voices = getActiveTTSVoices();
    if (voices.includes(voice)) {
      setTTSVoice(sessionKey, voice);
    }
  }

  const mode: TTSMenuMode = data === 'tts:voices' || data.startsWith('tts:voice:')
    ? 'voices'
    : 'main';
  const menu = buildTTSMenu(sessionKey, mode);

  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(menu.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: menu.keyboard },
    });
  } catch (error) {
    // Ignore "message is not modified" — happens with duplicate callbacks
    if (!(error instanceof Error && error.message.includes('message is not modified'))) {
      throw error;
    }
  }
}

export async function handleTelegraphCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('telegraph:')) return;

  // Don't allow enabling if global config is disabled
  if (data === 'telegraph:on') {
    if (!config.TELEGRAPH_ENABLED) {
      await ctx.answerCallbackQuery({ text: 'Telegraph disabled in config. Set TELEGRAPH_ENABLED=true in .env.' });
      setTelegraphEnabled(sessionKey, false);
    } else {
      setTelegraphEnabled(sessionKey, true);
    }
  } else if (data === 'telegraph:off') {
    setTelegraphEnabled(sessionKey, false);
  }

  const menu = buildTelegraphMenu(sessionKey);

  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(menu.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: menu.keyboard },
    });
  } catch (error) {
    // Ignore "message is not modified" — happens with duplicate callbacks
    if (!(error instanceof Error && error.message.includes('message is not modified'))) {
      throw error;
    }
  }
}

export async function handlePing(ctx: Context): Promise<void> {
  const uptime = getUptimeFormatted();
  await replyMd(ctx, `🏓 Pong\\!\n\nUptime: ${esc(uptime)}`);
}

/**
 * FIX 6+ Step 5 (2026-05-25): /brief — explicit topic briefing entry-point.
 *
 * Problem this solves (Codex Pre-Review §5 + 2026-05-25 daily):
 *   - The input-log middleware SKIPS slash-commands (control vs durable input).
 *   - Voice notes can be dropped (voice_hard_timeout) before they reach the
 *     agent — the user thinks they briefed the bot, the bot saw nothing.
 *   - In a fresh session the agent has no honest signal whether context is
 *     thin or rich; it just guesses based on the message text.
 *
 * /brief <text> bypasses both gotchas:
 *   1. Calls recordInput() EXPLICITLY so the briefing lands in input_log
 *      and the FTS index immediately, prefixed [BRIEF] for quick filtering.
 *   2. Replies with a Context-Availability snapshot so the user (and any
 *      next agent turn) sees exactly what is and is not visible right now.
 *   3. Does NOT trigger an agent turn — the user follows up with a normal
 *      message and the agent picks up the briefing via input_log_search.
 */
export async function handleBrief(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;

  // grammY puts the arg-text after `/brief ` into ctx.match for command handlers.
  const rawArg = typeof ctx.match === 'string' ? ctx.match : '';
  const text = rawArg.trim();
  if (!text) {
    await replyWithMarkdownFallback(
      ctx,
      'Nutze: `/brief <Topic + Stand>` — z.B.\n' +
        '`/brief Apple Watch 4 Setup für Alina, kann nicht anrufen, ChatGPT-Verlauf von 17h gestern auf MacBook`\n\n' +
        'Der Brief landet sofort durchsuchbar im input_log und der Bot kann ihn als Kontext für die nächste Frage ziehen.',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // Explicit recordInput — the middleware skipped this command, so we own the
  // durability invariant for this row. Prefix [BRIEF] so input_log_search
  // hits sort it to the top for any related question.
  const briefedText = `[BRIEF] ${text}`;
  let rowId: number | null = null;
  // FIX 6+ Stage 2d: /brief is now privacy-mode-aware. When the session is in
  // `/private on`, the brief inherits 'private' so it never leaks via the
  // public MCP search path. The user must explicitly `/private off` (or never
  // turn it on) to get the public-search-findable brief that Stage 2c shipped.
  // Rationale: consistent with `recordInput()`-Resolution and the `/private`
  // UX promise ("new turns will be tagged private"). Public-mode users (the
  // overwhelming default) still get the same Stage 2c behaviour.
  const briefIsPrivate = isPrivate(sessionKey);
  try {
    const { recordInput } = await import('../../inbox/input-log.js');
    rowId = recordInput({
      messageId,
      chatId: chatId ?? 0,
      sessionKey,
      inputType: 'text',
      rawContent: briefedText,
      fileId: null,
      privacy: briefIsPrivate ? 'private' : 'public',
    });
    if (rowId != null) markDone(rowId); // markDone now top-level imported (Z.74)
  } catch (err) {
    console.error('[Brief] recordInput failed:', err);
  }

  // Context-Availability snapshot — same signal the agent gets in its prompt
  // (Step 6), surfaced to the user so they can decide whether to add more.
  let recentCount = 0;
  let droppedCount = 0;
  try {
    const { getLatestInputLog } = await import('../../inbox/input-log.js');
    const recent = getLatestInputLog(sessionKey, 10);
    recentCount = recent.length;
    droppedCount = recent.filter((r) => r.status === 'dropped').length;
  } catch (err) {
    console.error('[Brief] getLatestInputLog failed:', err);
  }

  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = `/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/daily/${today}.md`;
  const dailyPresent = fs.existsSync(dailyPath);

  const briefScopeLabel = briefIsPrivate
    ? 'private (session ist in `/private on` — Brief NICHT via public MCP-Search findbar; nutze ihn direkt in der Folgefrage oder `/private off` vor `/brief`)'
    : 'public (Brief ist via input_log_search für den nächsten Agent-Turn findbar)';

  // This answers the capability question from the SDK's last observed init
  // event. Configuration alone is not evidence that an MCP process connected.
  const mcpInventory = getLastMcpInventory(sessionKey);
  const capabilityHealth = mcpInventory?.capabilityHealth;
  const md = escapeTelegramMarkdown;
  const formatCapabilityNames = (names: readonly string[]) => names.map(md).join(', ');
  const capabilityLines = mcpInventory
    ? [
        `- Letzter Agent-Start (${md(mcpInventory.observedAt.slice(0, 16).replace('T', ' '))} UTC): ${capabilityHealth?.connectedServers.length ? `verbundene MCP-Server: ${formatCapabilityNames(capabilityHealth.connectedServers)}` : 'keine verbundenen MCP-Server gemeldet'}`,
        `- MCP-Werkzeuge live: ${capabilityHealth?.totalMcpTools ?? 0}; pro Server: ${Object.entries(capabilityHealth?.toolCountByServer ?? {}).map(([server, count]) => `${md(server)}=${count}`).join(', ') || 'keine gemeldet'}`,
        `- Mail-Konten: lokal ${capabilityHealth?.localMailAccountCount ?? 'unbekannt'}; Master gesamt ${capabilityHealth?.totalMasterMailAccountCount ?? 'unbekannt'} (inkl. ${md('mastor.prime')} nur bei ${md('workspace-google-rw')}-Verbindung)`,
        ...(capabilityHealth?.missingServers.length
          ? [`- ⚠️ WARNUNG: Soll-MCP fehlt oder ist nicht verbunden: ${formatCapabilityNames(capabilityHealth.missingServers)}`]
          : []),
      ]
    : ['- Noch kein SDK-MCP-Inventar für diese Sitzung. Sende zuerst einen normalen Text-Turn; erst dessen Init ist ein Verfügbarkeitsbeweis.'];

  const lines: string[] = [
    `✅ Brief gespeichert${rowId != null ? ` (input_log id=${rowId})` : ''}`,
    `   Scope: ${briefScopeLabel}`,
    '',
    '*Was ich sehe:*',
    `- input_log letzte 10 Inputs: ${recentCount}${droppedCount > 0 ? ` (davon ${droppedCount} dropped — über input_log_search abrufbar)` : ''}`,
    `- Daily ${today}: ${dailyPresent ? 'vorhanden' : 'noch nicht angelegt'}`,
    '',
    '*Tatsächlich verbundene Fähigkeiten:*',
    ...capabilityLines,
    '',
    '*Nicht automatisch eingebunden:*',
    '- ChatGPT-Sessions auf MacBook (keine Capture-Pipeline)',
    '- Andere Apps ohne im letzten Agent-Start bestätigtes MCP',
    '',
    'Stelle deine Frage jetzt — ich nehme den Brief als Kontext.',
  ];

  await replyWithMarkdownFallback(ctx, lines.join('\n'), { parse_mode: 'Markdown' });
}

export async function handleContext(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Try cached SDK usage first (instant, no CLI shell-out)
  const cached = getCachedUsage(sessionKey);
  if (cached) {
    // Single-source occupancy (Bug-A metric) — same as footer + guard + /status.
    const usedCtx = occupancyTokens(cached);
    const pct = cached.contextWindow > 0
      ? Math.min(100, Math.round((usedCtx / cached.contextWindow) * 100))
      : 0;
    const bar = getProgressBar(pct);

    const output = `## 🧠 Context Usage\n\n`
      + `${bar} **${pct}%** of context window\n\n`
      + `- **Model:** ${cached.model}\n`
      + `- **Input tokens:** ${fmtTokens(cached.inputTokens)}\n`
      + `- **Output tokens:** ${fmtTokens(cached.outputTokens)}\n`
      + `- **Cache read:** ${fmtTokens(cached.cacheReadTokens)}\n`
      + `- **Cache write:** ${fmtTokens(cached.cacheWriteTokens)}\n`
      + `- **Context window:** ${fmtTokens(cached.contextWindow)}\n`
      + `- **Turns this session:** ${cached.numTurns}\n`
      + `- **Cost this query:** $${cached.totalCostUsd.toFixed(4)}\n\n`
      + `_Data from last query. Send a message then run /context for fresh data._`;

    await messageSender.sendMessage(ctx, output);
    return;
  }

  // Fallback: CLI shell-out approach
  if (!session.claudeSessionId) {
    await replyMd(
      ctx,
      '⚠️ No Claude session ID found\\.\n\nSend a message to Claude after resuming, then run `/context` again\\.'
    );
    return;
  }

  const ack = await ctx.reply('🧠 Checking context...', { parse_mode: undefined });

  try {
    const raw = await runClaudeContext(session.claudeSessionId, session.workingDirectory);
    const formatted = parseContextOutput(raw);
    await messageSender.sendMessage(ctx, formatted);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const hint = message.toLowerCase().includes('unknown') || message.toLowerCase().includes('command')
      ? '\n\nThis CLI may not support `/context` yet.'
      : '';
    await messageSender.sendMessage(ctx, `❌ Failed to fetch context: ${message}${hint}`);
  } finally {
    try {
      await ctx.api.deleteMessage(chatId, ack.message_id);
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function handleBotStatus(ctx: Context): Promise<void> {
  const uptimeSec = process.uptime();
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const seconds = Math.floor(uptimeSec % 60);
  const uptimeStr = hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;

  const mode = config.BOT_MODE === 'prod' ? 'Production' : 'Development';
  const keyInfo = getSessionKeyFromCtx(ctx);
  const model = keyInfo ? getModel(keyInfo.sessionKey) : 'opus';
  const streaming = config.STREAMING_MODE || 'streaming';
  const pid = process.pid;
  const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(1);

  const msg =
    `🟢 *${esc(config.BOT_NAME)} is running*\n\n` +
    `*Mode:* ${esc(mode)}\n` +
    `*Uptime:* ${esc(uptimeStr)}\n` +
    `*PID:* ${pid}\n` +
    `*Memory:* ${esc(memMB)} MB\n` +
    `*Model:* ${esc(model)}\n` +
    `*Streaming:* ${esc(streaming)}`;

  await replyMd(ctx, msg);
}

export async function handleRestartBot(ctx: Context): Promise<void> {
  if (!botctlExists()) {
    await replyMd(ctx, '❌ Bot control script not found\\.\n\nExpected at `scripts/nexusgram-ctl.sh`\\.');
    return;
  }

  await replyMd(
    ctx,
    '🔁 Restarting bot\\.\n\n⏳ Please wait at least *10\\-15 seconds* before checking status or resuming\\.'
  );

  // Send restore buttons immediately — the process gets killed too fast for a delayed send
  const restartChatId = ctx.chat?.id;
  // Forum-topic awareness (2026-06-04): keep the restore buttons in the
  // originating topic (undefined in regular chats → unchanged).
  const restartThreadId = getSessionKeyFromCtx(ctx)?.threadId;
  if (restartChatId) {
    try {
      await ctx.api.sendMessage(restartChatId, '👇 Restore your session after restart:', {
        ...(restartThreadId !== undefined ? { message_thread_id: restartThreadId } : {}),
        reply_markup: {
          inline_keyboard: [
            [
              { text: '▶️ Continue', callback_data: 'restart:continue' },
              { text: '📜 Resume', callback_data: 'restart:resume' },
            ],
          ],
        },
      });
    } catch (e) {
      console.debug('[RestartBot] Failed to send restore buttons:', e instanceof Error ? e.message : e);
    }
  }

  try {
    const child = spawn(
      BOTCTL_PATH,
      ['recover'],
      { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', env: { ...process.env, MODE: config.BOT_MODE } }
    );
    child.unref();
  } catch (error) {
    console.error('[BotCtl] Failed to restart:', sanitizeError(error));
  }
}

export async function handleRestartCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data === 'restart:continue') {
    await ctx.answerCallbackQuery();
    await handleContinue(ctx);
  } else if (data === 'restart:resume') {
    await ctx.answerCallbackQuery();
    await handleResume(ctx);
  } else {
    await ctx.answerCallbackQuery();
  }
}

export async function handleCancel(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const wasProcessing = isProcessing(sessionKey);

  // Stage 2b Action 5: finalise active RequestContexts BEFORE the SDK
  // cancellation reaches the handler. Marking them CANCELLED via
  // `markCancelled()` (which calls finalizeOnce) makes the handler's
  // `markSuccess()` return false on any late "Successfully cancelled"
  // response from the agent — so the user sees exactly ONE cancel reply
  // (this command's reply below), no duplicate from the agent stream.
  const activeContexts = getActiveContextsForSession(sessionKey);
  for (const reqCtx of activeContexts) {
    const won = markCancelled(reqCtx, 'user-cancel');
    if (won) {
      console.log(
        `[handleCancel] finalised RequestContext requestId=${reqCtx.requestId} ` +
          `session=${sessionKey} origin=${reqCtx.origin}`,
      );
    }
  }

  // Stage 2 M-024 Cancel-HARD-Rollback (2026-05-28, Codex Iterate-Patch B):
  // Bump the turn epoch BEFORE cancelRequest so a late `success` message from
  // the cancelled turn cannot pass `isStillOwnerTurn()` in agent.ts and
  // re-store the stale Claude-session-ID we are about to forget below. This is
  // the missing piece the original handler lacked: markCancelled finalises the
  // RequestContext but the turn-epoch ownership-guards in agent.ts were still
  // satisfied for the cancelled turn until the next dequeue.
  invalidateCurrentTurn(sessionKey, 'user-cancel');

  const cancelled = await cancelRequest(sessionKey);
  const clearedCount = clearQueue(sessionKey);

  // Stage 2 M-024 Cancel-HARD-Rollback (2026-05-28): destroy the resumable
  // Claude-Code session-ID. The torn SDK transcript must NOT be reused — even
  // a clean `query.interrupt()` leaves it in an unpredictable state. Combined
  // with `forceFreshSession` (resets `session.claudeSessionId` + history entry)
  // the next user message starts a brand-new Claude-Code session, so a /cancel
  // mid-Phase-D-explanation cannot leak into a follow-up `ping`.
  // discardCancelledTurnState prunes the cancelled user turn from local
  // conversationHistory so the new session does not echo it back.
  //
  // Codex Pattern-B Review Residual #1 (2026-05-28, Conf 0.74→0.80): only
  // hard-rollback when something was actually cancelled. A no-op /cancel
  // (user pressed cancel while nothing was active) must NOT rotate the
  // Claude-Code session — that would silently destroy continuity.
  const hardRollback = cancelled || clearedCount > 0 || activeContexts.length > 0 || wasProcessing;
  if (hardRollback) {
    forgetChatSession(sessionKey);
    sessionManager.forceFreshSession(sessionKey);
    discardCancelledTurnState(sessionKey);
  }

  if (cancelled || clearedCount > 0 || activeContexts.length > 0) {
    let message = '🛑 Cancelled\\.';
    if (clearedCount > 0) {
      message += ` \\(${clearedCount} queued request${clearedCount > 1 ? 's' : ''} cleared\\)`;
    }
    await replyMd(ctx, message);
  } else if (!wasProcessing) {
    await replyMd(ctx, 'ℹ️ Nothing to cancel\\.');
  } else {
    // Schlachtplan Akt 1.3 Cancel-Fix 2 (2026-05-21): previously this branch
    // (wasProcessing && nothing concrete to cancel) sent NO reply at all — the
    // user pressed /cancel and got silence (RI-22). Always answer. The turn
    // was already finishing on its own; tell the user so honestly.
    await replyMd(ctx, '🛑 Stop angefordert — die laufende Anfrage war bereits am Abschließen\\.');
  }
}

export async function handleReset(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey, threadId } = keyInfo;

  const wasProcessing = isProcessing(sessionKey);
  const reset = await resetRequest(sessionKey);
  clearQueue(sessionKey);

  // Clear the session so user starts fresh.
  // Schlachtplan Akt 1.3 Cancel-Fix 3 (2026-05-21): clearConversation +
  // clearSession alone did NOT start fresh — the next message resumed the old
  // claudeSessionId from history. forceFreshSession installs a clean in-memory
  // session (claudeSessionId undefined) so the next turn genuinely starts new.
  clearConversation(sessionKey);
  sessionManager.forceFreshSession(sessionKey);

  if (wasProcessing || reset) {
    await replyMd(ctx, '🔄 Session reset\\. Current request cancelled and session cleared\\.');
  } else {
    await replyMd(ctx, '🔄 Session reset\\.');
  }

  // Show restore buttons (same UX as /restartbot). Keep them in the originating
  // forum topic (threadId undefined in regular chats → unchanged).
  try {
    await ctx.api.sendMessage(chatId, '👇 Restore or start a new session:', {
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      reply_markup: {
        inline_keyboard: [
          [
            { text: '▶️ Continue', callback_data: 'reset:continue' },
            { text: '📜 Resume', callback_data: 'reset:resume' },
          ],
        ],
      },
    });
  } catch (e) {
    console.debug('[Reset] Failed to send restore buttons:', e instanceof Error ? e.message : e);
  }
}

export async function handleResetCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data === 'reset:continue') {
    await ctx.answerCallbackQuery();
    await handleContinue(ctx);
  } else if (data === 'reset:resume') {
    await ctx.answerCallbackQuery();
    await handleResume(ctx);
  } else {
    await ctx.answerCallbackQuery();
  }
}

export async function handleCommands(ctx: Context): Promise<void> {
  const isMasterLane = isMasterEngineLane(config.BOT_NAME, config.ALLOWED_USER_IDS, ctx.from?.id, config.BOT_ROLE);
  const engineSection = isMasterLane
    ? '\n\n*Engine Commands:*\n\n• `/engine` \\- Show or switch the active engine\n• `/codex <task>` \\- Run a read\\-only Codex task'
    : '';
  await replyMd(ctx, `${getAvailableCommands()}${engineSection}`);
}

/** Master-lane only. The registration gate in bot.ts hides this completely from person-bots. */
export async function handleEngine(ctx: Context): Promise<void> {
  if (!isMasterEngineLane(config.BOT_NAME, config.ALLOWED_USER_IDS, ctx.from?.id, config.BOT_ROLE)) return;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  const args = (ctx.message?.text ?? '').trim().split(/\s+/).slice(1);

  if (args.length === 0 || !args[0]) {
    const current = getEngineSelection(sessionKey);
    const statuses = await Promise.all(ENGINE_NAMES.map((engine) => checkEngineAvailability(engine)));
    const availability = statuses
      .map((status) => `• ${status.available ? '✅' : '❌'} ${status.engine}: ${status.detail}`)
      .join('\n');
    await ctx.reply(
      `⚙️ Engine: ${current.engine}\n🤖 Model: ${current.model}\n\nAvailable:\n${availability}\n\nSwitch: /engine <anthropic|ollama|codex> [model]`,
      { parse_mode: undefined },
    );
    return;
  }

  const requested = args[0].toLowerCase();
  if (!isEngineName(requested)) {
    await ctx.reply(`Unknown engine "${requested}". Available: ${ENGINE_NAMES.join(', ')}`, { parse_mode: undefined });
    return;
  }
  const requestedModel = args.slice(1).join(' ');
  if (requestedModel && !isSafeEngineModel(requestedModel)) {
    await ctx.reply('Invalid model identifier. Use only letters, numbers, dots, colons, underscores, and hyphens.', { parse_mode: undefined });
    return;
  }

  // Availability is checked BEFORE mutating the session. Failure leaves the
  // active engine exactly as it was; there is deliberately no fallback.
  const status = await checkEngineAvailability(requested);
  if (!status.available) {
    await ctx.reply(`Cannot switch to ${requested}: ${status.detail}. Active engine unchanged.`, { parse_mode: undefined });
    return;
  }
  const selection = setEngineSelection(sessionKey, requested, requestedModel);
  await ctx.reply(`✅ Active engine: ${selection.engine}\n🤖 Model: ${selection.model}`, { parse_mode: undefined });
}

/** Direct Codex escape hatch. Its fixed, read-only process invocation lives in engines/engine.ts. */
export async function handleCodex(ctx: Context): Promise<void> {
  if (!isMasterEngineLane(config.BOT_NAME, config.ALLOWED_USER_IDS, ctx.from?.id, config.BOT_ROLE)) return;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const task = (ctx.message?.text ?? '').replace(/^\/codex(?:@\w+)?\s*/i, '').trim();
  if (!task) {
    await ctx.reply('Usage: /codex <task>', { parse_mode: undefined });
    return;
  }
  const session = sessionManager.getOrResumeSession(keyInfo.sessionKey);
  if (!session) {
    await ctx.reply('Set a project first with /project, then run /codex.', { parse_mode: undefined });
    return;
  }
  const activeEngine = getEngineSelection(keyInfo.sessionKey);
  const model = activeEngine.engine === 'codex'
    ? activeEngine.model
    : 'gpt-5.6-terra';
  try {
    await ctx.reply(`⏳ Codex is working (${model}, read-only)…`, { parse_mode: undefined });
    const response = await runCodex(model, task, session.workingDirectory);
    await ctx.reply(response.text, { parse_mode: undefined });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    await ctx.reply(`Codex failed: ${detail}`, { parse_mode: undefined });
  }
}

export async function handleModelCommand(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim().toLowerCase();

  const validModels = ['sonnet', 'opus', 'haiku'];

  if (!args) {
    const currentModel = getModel(sessionKey);

    // Show inline keyboard for model selection
    const keyboard = validModels.map((model) => {
      const isCurrent = model === currentModel;
      const label = isCurrent ? `✓ ${model}` : model;
      return [{ text: label, callback_data: `model:${model}` }];
    });

    await replyWithMarkdownFallback(
      ctx,
      `🤖 *Select Model*\n\n_Current: ${esc(currentModel)}_\n\n• *opus* \\- Most capable \\(default\\)\n• *sonnet* \\- Balanced\n• *haiku* \\- Fast & light`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: keyboard,
        },
      }
    );
    return;
  }

  if (!validModels.includes(args)) {
    await replyMd(ctx, `❌ Unknown model "${esc(args)}"\\.\n\nAvailable: ${validModels.join(', ')}`);
    return;
  }

  setModel(sessionKey, args);
  await replyMd(ctx, `✅ Model set to *${esc(args)}*`);
}

export async function handleModelCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('model:')) return;

  const model = data.replace('model:', '');
  const validModels = ['sonnet', 'opus', 'haiku'];

  if (!validModels.includes(model)) {
    await ctx.answerCallbackQuery({ text: 'Invalid model' });
    return;
  }

  setModel(sessionKey, model);

  await ctx.answerCallbackQuery({ text: `Model set to ${model}!` });
  await ctx.editMessageText(
    `✅ Model set to *${esc(model)}*`,
    { parse_mode: 'MarkdownV2' }
  );
}

export async function handlePlan(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const task = text.split(' ').slice(1).join(' ').trim();

  if (!task) {
    await replyWithMarkdownFallback(
      ctx,
      `📋 *Plan Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will analyze your task and create a detailed implementation plan before coding\\.\n\n👇 _Describe your task:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Add user authentication with JWT...',
          selective: true,
        },
      }
    );
    return;
  }

  // Stage 2b Action 4: delegate to message.handler's `handleAgentReply` so the
  // direct-command path (`/plan <task>`) gets the same RequestContext-driven
  // hard-cap as the ForceReply path. DRY-er than maintaining two near-identical
  // bodies; closes the Day-1 Doppel-Message gap on direct commands.
  await handleAgentReply(ctx, sessionKey, task, 'plan');
}

export async function handleExplore(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const question = text.split(' ').slice(1).join(' ').trim();

  if (!question) {
    await replyWithMarkdownFallback(
      ctx,
      `🔍 *Explore Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will search and analyze the codebase to answer your question\\.\n\n👇 _What would you like to know?_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'How does the auth system work?',
          selective: true,
        },
      }
    );
    return;
  }

  // Stage 2b Action 4: delegate to message.handler's `handleAgentReply` so the
  // direct-command path (`/explore <question>`) gets the same RequestContext-driven
  // hard-cap as the ForceReply path.
  await handleAgentReply(ctx, sessionKey, question, 'explore');
}

export async function handleResume(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const history = sessionManager.getSessionHistory(sessionKey, 10);
  // Only show sessions that actually have a Claude session (were chatted in)
  const resumable = history.filter((entry) => entry.claudeSessionId);

  if (resumable.length === 0) {
    await replyMd(ctx, 'ℹ️ No resumable sessions found\\.\n\nSessions need at least one Claude response to be resumable\\.\nUse `/project <name>` to start a new session\\.');
    return;
  }

  const keyboard = resumable.map((entry) => {
    const date = new Date(entry.lastActivity);
    const timeAgo = formatTimeAgo(date);

    return [
      {
        text: `${entry.projectName} (${timeAgo})`,
        callback_data: `resume:${entry.conversationId}`,
      },
    ];
  });

  await ctx.reply('📜 *Recent Sessions*\n\nSelect a session to resume:', {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

export async function handleResumeCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('resume:')) return;

  const conversationId = data.replace('resume:', '');
  const session = sessionManager.resumeSession(sessionKey, conversationId);

  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Session not found' });
    return;
  }

  clearConversation(sessionKey);

  await ctx.answerCallbackQuery({ text: 'Session resumed!' });
  await ctx.editMessageText(
    `✅ Resumed session for *${esc(path.basename(session.workingDirectory))}*\n\n` +
    `Working directory: \`${esc(session.workingDirectory)}\`${projectStatusSuffix(sessionKey)}`,
    { parse_mode: 'MarkdownV2' }
  );

  // Send session ID as separate message for easy copying
  if (session.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(session.claudeSessionId));
  }
}

export async function handleContinue(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.resumeLastSession(sessionKey);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No previous session to continue\\.\n\nUse `/project <name>` to start a new session\\.');
    return;
  }

  clearConversation(sessionKey);

  await replyMd(ctx,
    `✅ Continuing *${esc(path.basename(session.workingDirectory))}*\n\n` +
    `Working directory: \`${esc(session.workingDirectory)}\`${projectStatusSuffix(sessionKey)}`
  );

  // Send session ID as separate message for easy copying
  if (session.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(session.claudeSessionId));
  }
}

export async function handleLoop(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const task = text.split(' ').slice(1).join(' ').trim();

  if (!task) {
    await ctx.reply(
      `🔄 *Loop Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will work iteratively until done \\(max ${config.MAX_LOOP_ITERATIONS} iterations\\)\\.\n\n👇 _Describe the task:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Fix all TypeScript errors in src/',
          selective: true,
        },
      }
    );
    return;
  }

  // Stage 2b Action 4: delegate to message.handler's `handleAgentReply` so the
  // direct-command path (`/loop <task>`) gets the same RequestContext-driven
  // hard-cap as the ForceReply path.
  await handleAgentReply(ctx, sessionKey, task, 'loop');
}

export async function handleSessions(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const history = sessionManager.getSessionHistory(sessionKey, 10);
  const currentSession = sessionManager.getSession(sessionKey);

  if (history.length === 0 && !currentSession) {
    await replyMd(ctx, 'ℹ️ No sessions found\\.\n\nUse `/project <name>` to start a new session\\.');
    return;
  }

  // Count total sessions with Claude session IDs
  const totalSessions = history.filter(e => e.claudeSessionId).length;
  let message = `📋 *Sessions*${totalSessions > 0 ? ` \\(${totalSessions} total\\)` : ''}\n\n`;

  if (currentSession) {
    const activeEntry = history.find(e => e.conversationId === currentSession.conversationId);
    const msgCount = activeEntry?.messageCount || 0;
    const timeStr = formatTimeAgo(currentSession.lastActivity);
    const preview = activeEntry?.lastMessagePreview ? `\n💬 "${esc(activeEntry.lastMessagePreview.substring(0, 50))}${activeEntry.lastMessagePreview.length > 50 ? '...' : ''}"` : '';

    message += `🟢 *Active Session*\n`;
    message += `\`${esc(path.basename(currentSession.workingDirectory))}\` · ${esc(timeStr)} · ${msgCount} msgs${preview}\n\n`;
  }

  if (history.length > 0) {
    message += '📚 *Recent Sessions*\n';
    for (const entry of history) {
      const isActive = currentSession && currentSession.conversationId === entry.conversationId;
      if (isActive) continue; // Skip active session (already shown above)

      const date = new Date(entry.lastActivity);
      const msgCount = entry.messageCount || 0;
      const preview = entry.lastMessagePreview ? `\n💬 "${esc(entry.lastMessagePreview.substring(0, 50))}${entry.lastMessagePreview.length > 50 ? '...' : ''}"` : '';

      message += `\`${esc(entry.projectName)}\` · ${esc(formatTimeAgo(date))} · ${msgCount} msgs${preview}\n`;
    }
  }

  message += '\n_Use `/resume` to switch sessions or `/continue` to resume the last one\\._';

  await replyMd(ctx, message);
}

export async function handleTeleport(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No active session to teleport\\.\n\nStart a conversation first with `/project <name>`\\.');
    return;
  }

  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ No Claude session available yet\\.\n\nSend a message first to start a session, then use `/teleport`\\.');
    return;
  }

  const projectName = path.basename(session.workingDirectory);
  const claudeBin = config.CLAUDE_EXECUTABLE_PATH ?? 'claude';
  const command = `cd "${session.workingDirectory}" && ${claudeBin} --resume ${session.claudeSessionId}`;

  const message = `🚀 *Teleport to Terminal*

*Project:* \`${esc(projectName)}\`
*Session:* \`${esc(session.claudeSessionId.substring(0, 8))}\\.\\.\\.\`

Copy and run in your terminal:

\`\`\`
${esc(command)}
\`\`\`

_Both Telegram and terminal can continue independently \\(forked session\\)\\._`;

  await replyMd(ctx, message);
}

function formatTimeAgo(date: Date | string): string {
  // Handle both Date objects and ISO strings
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();

  // Calculate time units
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  // Less than 1 minute: "just now"
  if (diffSecs < 60) {
    return 'just now';
  }

  // Less than 10 minutes: show minutes AND seconds
  // Example: "5m 23s ago"
  if (diffMins < 10) {
    const secs = diffSecs % 60;
    return `${diffMins}m ${secs}s ago`;
  }

  // 10-59 minutes: show minutes only
  // Example: "45m ago"
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }

  // 1-23 hours: show hours and minutes
  // Example: "3h 15m ago" or "3h ago"
  if (diffHours < 24) {
    const mins = diffMins % 60;
    return mins === 0 ? `${diffHours}h ago` : `${diffHours}h ${mins}m ago`;
  }

  // Calculate day boundaries for Today/Yesterday
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dateDay = new Date(d);
  dateDay.setHours(0, 0, 0, 0);
  const daysDiff = Math.floor((today.getTime() - dateDay.getTime()) / 86400000);

  // Format time as HH:MM
  const timeStr = d.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit'
  });

  // Today: "Today at 14:32"
  if (daysDiff === 0) {
    return `Today at ${timeStr}`;
  }

  // Yesterday: "Yesterday at 14:32"
  if (daysDiff === 1) {
    return `Yesterday at ${timeStr}`;
  }

  // 2-6 days: "3d ago"
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  // 7+ days: full date
  // Example: "28. Feb" or "28. Feb 25" if > 1 year
  return d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: 'short',
    year: diffDays > 365 ? '2-digit' : undefined
  });
}

export async function handleFile(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const filePath = text.split(' ').slice(1).join(' ').trim();

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project <path>` to open a project first\\.');
    return;
  }

  if (!filePath) {
    // List some files in the project to help user
    const projectFiles = listProjectFiles(session.workingDirectory);
    const fileList = projectFiles.length > 0
      ? `\n\n*Recent files:*\n${projectFiles.slice(0, 8).map(f => `• \`${esc(f)}\``).join('\n')}`
      : '';

    await replyWithMarkdownFallback(
      ctx,
      `📎 *Download File*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_${fileList}\n\n👇 _Enter the file path:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'src/index.ts',
          selective: true,
        },
      }
    );
    return;
  }

  const fullPath = filePath.startsWith('/')
    ? filePath
    : path.join(session.workingDirectory, filePath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await replyMd(ctx, `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``);
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await replyMd(ctx, `❌ File not found: \`${esc(filePath)}\``);
    return;
  }

  if (fs.statSync(fullPath).isDirectory()) {
    await replyMd(ctx, `❌ Path is a directory, not a file: \`${esc(filePath)}\``);
    return;
  }

  const success = await messageSender.sendDocument(ctx, fullPath, `📎 ${path.basename(fullPath)}`);

  if (!success) {
    await replyMd(ctx, '❌ Failed to send file\\. It may be too large \\(\\>50MB\\) or inaccessible\\.');
  }
}

export async function handleTelegraph(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const filePath = text.split(' ').slice(1).join(' ').trim();

  // If no argument provided, show the settings menu
  if (!filePath) {
    const menu = buildTelegraphMenu(sessionKey);
    await ctx.reply(menu.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: menu.keyboard.length > 0 ? { inline_keyboard: menu.keyboard } : undefined,
    });
    return;
  }

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project <path>` to open a project first\\.');
    return;
  }

  const fullPath = filePath.startsWith('/')
    ? filePath
    : path.join(session.workingDirectory, filePath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await replyMd(ctx, `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``);
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await replyMd(ctx, `❌ File not found: \`${esc(filePath)}\``);
    return;
  }

  const ext = path.extname(fullPath).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    await replyMd(ctx, '⚠️ Telegraph works best with Markdown files \\(\\.md\\)');
  }

  await replyMd(ctx, '📤 Creating Telegraph page\\.\\.\\.');

  const pageUrl = await createTelegraphFromFile(fullPath);

  if (pageUrl) {
    const fileName = path.basename(fullPath);
    await replyMd(ctx, `📄 *${esc(fileName)}*\n\n[Open in Instant View](${esc(pageUrl)})`);
  } else {
    await replyMd(ctx, '❌ Failed to create Telegraph page\\.');
  }
}

/**
 * Tokenize a user-provided argument string, preserving quoted substrings.
 * Returns an array of individual arguments safe for execFile.
 */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"| '([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

type RedditFormat = 'markdown' | 'json';

function parseRedditArgs(tokens: string[]): {
  cleanTokens: string[];
  format: RedditFormat | null;
  hadOutputFlag: boolean;
} {
  const cleanTokens: string[] = [];
  let format: RedditFormat | null = null;
  let hadOutputFlag = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-o' || token === '--output') {
      hadOutputFlag = true;
      i++; // skip value
      continue;
    }

    if ((token === '-f' || token === '--format') && tokens[i + 1]) {
      const next = tokens[i + 1] as RedditFormat;
      if (next === 'json' || next === 'markdown') {
        format = next;
      }
      i++; // skip value, don't push to cleanTokens (handled here)
      continue;
    }

    cleanTokens.push(token);
  }

  return { cleanTokens, format, hadOutputFlag };
}

function ensureRedditOutputDir(ctx: Context): string {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const session = keyInfo ? sessionManager.getSession(keyInfo.sessionKey) : null;
  const baseDir = session ? session.workingDirectory : process.cwd();
  const dir = path.join(baseDir, '.nexusgram', 'reddit');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function buildRedditOutputPath(ctx: Context, tokens: string[]): string {
  const dir = ensureRedditOutputDir(ctx);
  const raw = tokens[0] || 'reddit';
  const slug = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'reddit';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `reddit_${slug}_${stamp}.json`);
}

function slugFromUrl(input: string): string {
  const cleaned = input.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return cleaned.slice(0, 60) || 'medium';
}

function ensureMediumOutputDir(ctx: Context, url: string): string {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const session = keyInfo ? sessionManager.getSession(keyInfo.sessionKey) : null;
  const baseDir = session ? session.workingDirectory : process.cwd();
  const slug = slugFromUrl(url);
  const dir = path.join(baseDir, '.nexusgram', 'medium', slug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}


// Pending Reddit fetch results keyed by messageId, with 5-min TTL.
// Keyed by messageId (not chatId) so concurrent fetches don't overwrite each other.
const pendingRedditResults = new Map<number, {
  chatId: number;
  output: string;
  jsonOutput: string;
  targets: string[];
  options: RedditFetchOptions;
  format: RedditFormat | null;
  hadOutputFlag: boolean;
  expiresAt: number;
}>();
const REDDIT_RESULT_TTL_MS = 5 * 60 * 1000;

/**
 * Execute native Reddit fetch, cache the result, and show an inline picker
 * so the user can choose File / Chat / Both.
 * Exported so message.handler.ts can reuse it for ForceReply flow.
 */
export async function executeRedditFetch(
  ctx: Context,
  args: string
): Promise<void> {
  if (!config.REDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit');
    return;
  }

  await ctx.replyWithChatAction('typing');

  const tokens = tokenizeArgs(args);
  const { cleanTokens, format, hadOutputFlag } = parseRedditArgs(tokens);

  // Extract targets and options from cleanTokens
  const targets: string[] = [];
  const options: RedditFetchOptions = {
    format: format || 'markdown',
    limit: config.REDDITFETCH_DEFAULT_LIMIT,
    depth: config.REDDITFETCH_DEFAULT_DEPTH,
  };

  const VALID_SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial', 'best']);
  const VALID_TIMES = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);

  for (let i = 0; i < cleanTokens.length; i++) {
    const token = cleanTokens[i];
    if (token === '--sort' && cleanTokens[i + 1]) {
      const val = cleanTokens[++i];
      if (VALID_SORTS.has(val)) options.sort = val;
    } else if (token === '--limit' && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.limit = parsed;
    } else if ((token === '-l') && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.limit = parsed;
    } else if (token === '--depth' && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.depth = parsed;
    } else if (token === '--time' && cleanTokens[i + 1]) {
      const val = cleanTokens[++i];
      if (VALID_TIMES.has(val)) options.timeFilter = val;
    } else {
      targets.push(token);
    }
  }

  if (targets.length === 0) {
    await replyMd(ctx, '❌ No target specified\\. Example: `/reddit r/ClaudeAI` or `/reddit <post\\-url>`');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    // Fetch both formats in a single API call to avoid double-dipping
    const { markdown: output, json: jsonOutput } = await redditFetchBoth(targets, options);

    if (!output.trim()) {
      await replyMd(ctx, '❌ No results returned\\.');
      return;
    }

    // Build a short preview for the picker message
    const charCount = output.length;
    const targetLabel = targets.join(', ');
    const previewSnippet = output.length > 200
      ? output.slice(0, 200).trimEnd() + '...'
      : output;

    const previewText =
      `📡 *Reddit Fetch*\n` +
      `Target: \`${esc(targetLabel)}\`\n` +
      `Size: _${charCount} chars_\n\n` +
      `${esc(previewSnippet)}\n\n` +
      `_Choose how to consume this content:_`;

    const msg = await replyWithMarkdownFallback(ctx, previewText, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📄 File', callback_data: 'reddit_action:file' },
            { text: '💬 Chat', callback_data: 'reddit_action:chat' },
            { text: '📄💬 Both', callback_data: 'reddit_action:both' },
          ],
        ],
      },
    });

    // Cache both formats for callback handling (keyed by messageId)
    pendingRedditResults.set(msg.message_id, {
      chatId,
      output,
      jsonOutput,
      targets,
      options,
      format,
      hadOutputFlag,
      expiresAt: Date.now() + REDDIT_RESULT_TTL_MS,
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    let userMessage: string;

    if (errorMessage.includes('Missing Reddit credentials') || errorMessage.includes('REDDIT_CLIENT_ID')) {
      userMessage = "❌ Reddit credentials not configured\\.\n\nSet `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` in nexusgram's `\\.env` file\\.";
    } else if (errorMessage.includes('timed out') || errorMessage.includes('AbortError')) {
      userMessage = '❌ Reddit fetch timed out\\.';
    } else {
      userMessage = `❌ Reddit fetch failed: ${esc(sanitizeError(errorMessage).substring(0, 300))}`;
    }

    await replyMd(ctx, userMessage);
  }
}

/**
 * Handle inline keyboard callbacks for Reddit action picker (File / Chat / Both).
 */
export async function handleRedditActionCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('reddit_action:')) return;

  const action = data.replace('reddit_action:', '');

  // Look up pending result by messageId (keyed by picker message ID)
  const callbackMsgId = ctx.callbackQuery?.message?.message_id;
  if (!callbackMsgId) return;
  const pending = pendingRedditResults.get(callbackMsgId);
  if (!pending || Date.now() > pending.expiresAt) {
    if (callbackMsgId) pendingRedditResults.delete(callbackMsgId);
    await ctx.answerCallbackQuery({ text: 'Result expired. Please fetch again.' });
    return;
  }

  await ctx.answerCallbackQuery();

  const { output, jsonOutput, targets, format, hadOutputFlag } = pending;
  const doFile = action === 'file' || action === 'both';
  const doChat = action === 'chat' || action === 'both';

  try {
    // ── File mode ──────────────────────────────────────────────────
    if (doFile) {
      // Large thread JSON fallback (uses cached JSON, no second API call)
      if (!format && output.length > config.REDDITFETCH_JSON_THRESHOLD_CHARS) {
        try {
          const outputPath = buildRedditOutputPath(ctx, targets);
          fs.writeFileSync(outputPath, jsonOutput, { encoding: 'utf-8', mode: 0o600 });

          const sent = await messageSender.sendDocument(
            ctx,
            outputPath,
            `📎 Reddit JSON saved: ${path.basename(outputPath)}`
          );

          const displayPath = `.nexusgram/reddit/${path.basename(outputPath)}`;
          const notice = sent
            ? `Large thread detected \\(${output.length} chars\\) — sent JSON file for structured review\\.`
            : `Large thread detected \\(${output.length} chars\\) — JSON saved at \`${esc(displayPath)}\`\\.`;

          await replyMd(ctx, notice);
        } catch (jsonError) {
          console.error('[Reddit] JSON fallback failed:', jsonError);
          await messageSender.sendMessage(ctx, output);
        }
      } else {
        await messageSender.sendMessage(ctx, output);
      }

      if (hadOutputFlag) {
        await replyMd(ctx, 'ℹ️ Note: `-o/--output` is ignored in this picker flow\\. JSON is saved automatically for large threads\\.');
      }
    }

    // ── Chat mode ──────────────────────────────────────────────────
    if (doChat) {
      const session = sessionManager.getSession(sessionKey);
      if (!session) {
        await replyMd(ctx, '⚠️ No project set\\. Use `/project` first to enable Chat mode\\.');
      } else {
        // 1. Save content to disk
        const dir = ensureRedditOutputDir(ctx);
        const slug = (targets[0] || 'reddit').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const mdPath = path.join(dir, `reddit_${slug}_${stamp}.md`);
        fs.writeFileSync(mdPath, output, { encoding: 'utf-8', mode: 0o600 });

        // 2. Build prompt with inline content (truncated for large results)
        const CHAT_INLINE_LIMIT = 3000;
        const truncated = output.length > CHAT_INLINE_LIMIT;
        const inlineContent = truncated
          ? output.slice(0, CHAT_INLINE_LIMIT).trimEnd()
          : output;

        // Use relative display path to avoid leaking absolute server paths in conversation
        const displayPath = `.nexusgram/reddit/${path.basename(mdPath)}`;

        let prompt = `I just fetched Reddit content and saved it to ${displayPath}. Here's the content:\n\n${inlineContent}`;
        if (truncated) {
          prompt += `\n\n[Content truncated — full content (${output.length} chars) is saved at ${displayPath}.]`;
        }
        prompt += '\n\nPlease summarize the key points and let me know if you have any questions.';

        // 3. Queue a streaming response
        try {
          await queueRequest(sessionKey, prompt, async (turnEpoch) => {
            // D0 Hardening Item 1 / Amendment A (2026-05-27): Reddit pre-side-effect guard.
            assertTurnIsCurrent(sessionKey, turnEpoch);
            if (getStreamingMode() === 'streaming') {
              await messageSender.startStreaming(ctx);
              const abortController = new AbortController();
              setAbortController(sessionKey, abortController, turnEpoch);
              try {
                const response = await sendToAgent(sessionKey, prompt, {
                  onProgress: (progressText) => {
                    messageSender.updateStream(ctx, progressText);
                  },
                  abortController,
                  turnEpoch,
                });
                await messageSender.finishStreaming(ctx, response.text);
                await maybeSendVoiceReply(ctx, response.text);
              } catch (error) {
                await messageSender.cancelStreaming(ctx);
                throw error;
              }
            } else {
              await ctx.replyWithChatAction('typing');
              const abortController = new AbortController();
              setAbortController(sessionKey, abortController, turnEpoch);
              const response = await sendToAgent(sessionKey, prompt, { abortController, turnEpoch });
              await messageSender.sendMessage(ctx, response.text);
              await maybeSendVoiceReply(ctx, response.text);
            }
          });
        } catch (error) {
          if (error instanceof StaleTurnError) {
            console.log(`[RedditChat] stale turn discarded for ${sessionKey} (epoch ${error.turnEpoch})`);
          } else if ((error as Error).message !== 'Queue cleared') {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await replyMd(ctx, `❌ Chat failed: ${esc(errorMessage)}`);
          }
        }
      }
    }

    // Edit the original picker message to show what was selected
    const actionLabel = action === 'file' ? '📄 File' : action === 'chat' ? '💬 Chat' : '📄💬 Both';
    try {
      const targetLabel = targets.join(', ');
      await ctx.editMessageText(
        `📡 *Reddit Fetch* — ${esc(actionLabel)}\n` +
        `Target: \`${esc(targetLabel)}\` · ${output.length} chars`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch { /* ignore edit failure */ }

    // Clean up
    pendingRedditResults.delete(callbackMsgId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Action failed: ${esc(message.substring(0, 300))}`);
    pendingRedditResults.delete(callbackMsgId);
  }
}

// Pending Freedium results keyed by sessionKey, with 5-min TTL
const pendingMediumResults = new Map<string, { article: FreediumArticle; messageId: number; expiresAt: number }>();
const MEDIUM_RESULT_TTL_MS = 5 * 60 * 1000;

// Periodic cleanup of expired pending results to prevent memory leaks.
// .unref() so this timer doesn't prevent graceful process shutdown.
const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [msgId, entry] of pendingRedditResults) {
    if (now > entry.expiresAt) pendingRedditResults.delete(msgId);
  }
  for (const [key, entry] of pendingMediumResults) {
    if (now > entry.expiresAt) pendingMediumResults.delete(key);
  }
}, REDDIT_RESULT_TTL_MS);
_cleanupInterval.unref();

/**
 * Fetch a Medium article via Freedium and present inline action buttons.
 */
export async function executeMediumFetch(
  ctx: Context,
  args: string
): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  await ctx.replyWithChatAction('typing');

  const url = args.trim().split(/\s+/)[0];

  if (!url) {
    await replyMd(ctx, '❌ Missing URL\\. Example: `/medium https://medium.com/...`');
    return;
  }

  if (!isMediumUrl(url)) {
    await replyMd(ctx, '❌ Not a recognized Medium URL\\.\n\nSupported: medium\\.com, towardsdatascience\\.com, and other known Medium publication domains\\.');
    return;
  }

  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  try {
    const article = await fetchMediumArticle(url);

    // Build preview: title + author + first ~200 chars of markdown
    const preview = article.markdown.length > 200
      ? article.markdown.slice(0, 200).trimEnd() + '...'
      : article.markdown;

    const previewText =
      `📰 *${esc(article.title)}*\n` +
      `_by ${esc(article.author)}_\n\n` +
      `${esc(preview)}\n\n` +
      `_${article.markdown.length} chars — choose an action:_`;

    // Build inline keyboard based on Telegraph availability
    const inlineKeyboard = config.TELEGRAPH_ENABLED
      ? [
          [
            { text: '📄 Telegraph', callback_data: 'medium:telegraph' },
            { text: '💾 Save .md', callback_data: 'medium:save' },
            { text: '📄💾 Both', callback_data: 'medium:both' },
          ],
        ]
      : [
          [
            { text: '💬 Send to Chat', callback_data: 'medium:chat' },
            { text: '💾 Save .md', callback_data: 'medium:save' },
            { text: '💬💾 Both', callback_data: 'medium:chatboth' },
          ],
        ];

    const msg = await replyWithMarkdownFallback(ctx, previewText, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: inlineKeyboard },
    });

    // Store result for callback handling
    pendingMediumResults.set(sessionKey, {
      article,
      messageId: msg.message_id,
      expiresAt: Date.now() + MEDIUM_RESULT_TTL_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Medium fetch failed: ${esc(message.substring(0, 300))}`);
  }
}

/**
 * Handle inline keyboard callbacks for Medium article actions.
 */
export async function handleMediumCallback(ctx: Context): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await ctx.answerCallbackQuery({ text: 'Feature disabled' });
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('medium:')) return;

  const action = data.replace('medium:', '');

  // Look up pending result
  const pending = pendingMediumResults.get(sessionKey);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingMediumResults.delete(sessionKey);
    await ctx.answerCallbackQuery({ text: 'Result expired. Please fetch again.' });
    return;
  }

  const { article } = pending;
  await ctx.answerCallbackQuery();

  const doTelegraph = action === 'telegraph' || action === 'both';
  const doChat = action === 'chat' || action === 'chatboth';
  const doSave = action === 'save' || action === 'both' || action === 'chatboth';

  let telegraphUrl: string | null = null;
  let mdPath: string | null = null;

  try {
    if (doTelegraph) {
      telegraphUrl = await createTelegraphPage(article.title, article.markdown);
    }

    if (doSave) {
      const outputDir = ensureMediumOutputDir(ctx, article.url);
      const slug = slugFromUrl(article.url);
      mdPath = path.join(outputDir, `${slug}.md`);
      fs.writeFileSync(mdPath, article.markdown, { encoding: 'utf-8', mode: 0o600 });
    }

    // Build result message
    let resultText = `📰 *${esc(article.title)}*\n_by ${esc(article.author)}_\n\n`;

    if (telegraphUrl) {
      resultText += `📄 [Open in Instant View](${esc(telegraphUrl)})\n`;
    }
    if (doChat) {
      resultText += `💬 Sending to chat\\.\\.\\.\n`;
    }
    if (mdPath) {
      resultText += `💾 Markdown saved \\(${article.markdown.length} chars\\)`;
    }

    // Edit the original message to show results
    try {
      await ctx.editMessageText(resultText, { parse_mode: 'MarkdownV2' });
    } catch {
      // If edit fails (e.g. message too old), send new message
      await replyMd(ctx, resultText);
    }

    // Send content to chat if requested (inline messages)
    if (doChat) {
      await messageSender.sendMessage(ctx, article.markdown);
    }

    // Send .md file as document
    if (mdPath) {
      await messageSender.sendDocument(ctx, mdPath, `📎 ${path.basename(mdPath)}`);
    }

    // Clean up pending result
    pendingMediumResults.delete(sessionKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Action failed: ${esc(message.substring(0, 300))}`);
  }
}

export async function handleMedium(ctx: Context): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `📰 *Medium Fetch*\n\n` +
      `Fetch a Medium article via Freedium and convert to Markdown\\.\n\n` +
      `*Examples:*\n` +
      `• \`https://medium.com/@user/post\\-id\`\n` +
      `• \`https://towardsdatascience.com/some\\-article\`\n\n` +
      `👇 _Paste a Medium article URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://medium.com/@user/post-id',
          selective: true,
        },
      }
    );
    return;
  }

  await executeMediumFetch(ctx, args);
}

export async function handleReddit(ctx: Context): Promise<void> {
  if (!config.REDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `📡 *Reddit Fetch*\n\n` +
      `Fetch posts, subreddits, or user profiles from Reddit\\.\n\n` +
      `*Examples:*\n` +
      `• \`r/ClaudeAI \\-\\-sort new \\-\\-limit 5\`\n` +
      `• \`1lmkfhf\` \\(post ID\\)\n` +
      `• \`u/username \\-\\-limit 5\`\n` +
      `• \`r/LocalLLaMA \\-\\-sort top \\-\\-time week\`\n\n` +
      `👇 _Enter your Reddit target:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'r/ClaudeAI --sort new --limit 10',
          selective: true,
        },
      }
    );
    return;
  }

  await executeRedditFetch(ctx, args);
}

export async function handleVReddit(ctx: Context): Promise<void> {
  if (!config.VREDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit video');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `🎬 *Reddit Video*\n\n` +
      `Download a Reddit\\-hosted video from a post URL\\.\n\n` +
      `*Examples:*\n` +
      `• \`https://www.reddit.com/r/sub/comments/abc123/title/\`\n` +
      `• \`https://www.reddit.com/r/sub/s/shareCode\`\n` +
      `• \`https://redd.it/abc123\`\n\n` +
      `👇 _Paste a Reddit post URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://www.reddit.com/r/sub/comments/abc123/',
          selective: true,
        },
      }
    );
    return;
  }

  await executeVReddit(ctx, args);
}

// ── /transcribe command ────────────────────────────────────────────

/**
 * Send a transcript as text (short) or .txt document (long).
 * Exported so voice.handler.ts can reuse it for the ForceReply path.
 */
export async function sendTranscriptResult(ctx: Context, transcript: string): Promise<void> {
  if (transcript.length <= config.TRANSCRIBE_FILE_THRESHOLD_CHARS) {
    await messageSender.sendMessage(ctx, transcript);
  } else {
    const tmpPath = path.join(os.tmpdir(), `nexusgram_transcript_${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmpPath, transcript, { encoding: 'utf-8', mode: 0o600 });
      const inputFile = new InputFile(fs.readFileSync(tmpPath), 'transcript.txt');
      await ctx.replyWithDocument(inputFile, {
        caption: `🎤 Transcript (${transcript.length} chars)`,
      });
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (e) {
        console.warn(`[transcribe] Cleanup failed for ${sanitizePath(tmpPath)}:`, sanitizeError(e));
      }
    }
  }
}

/**
 * Download a Telegram file by file_id → transcribe → send result.
 * Shared helper for reply-to and ForceReply paths.
 */
async function transcribeAndSend(
  ctx: Context,
  fileId: string,
  mimeHint?: string
): Promise<string | null> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return null;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    console.warn('[transcribeAndSend] No chatId — aborting');
    return null;
  }

  let ackMsg: Awaited<ReturnType<typeof ctx.reply>>;
  try {
    ackMsg = await ctx.reply('🎤 Transcribing...', { parse_mode: undefined });
  } catch (ackErr) {
    console.error('[transcribeAndSend] Failed to send ack:', ackErr);
    return null;
  }
  let tempFilePath: string | null = null;
  let transcriptResult: string | null = null;

  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram did not return file_path.');

    // Prefer actual extension from Telegram's file_path (most reliable),
    // fall back to MIME hint detection.
    const KNOWN_AUDIO_EXTS = ['.ogg', '.oga', '.mp3', '.mp4', '.m4a', '.wav', '.webm', '.opus', '.flac'];
    const telegramExt = path.extname(file.file_path).toLowerCase();
    console.log(`[transcribeAndSend] file_path=${file.file_path} telegramExt=${telegramExt} mimeHint=${mimeHint}`);
    const ext = KNOWN_AUDIO_EXTS.includes(telegramExt) ? telegramExt
      : mimeHint?.includes('ogg') ? '.ogg'
      : mimeHint?.includes('mp3') ? '.mp3'
      : mimeHint?.includes('wav') ? '.wav'
      : mimeHint?.includes('mp4') || mimeHint?.includes('m4a') ? '.m4a'
      : mimeHint?.includes('opus') ? '.opus'
      : mimeHint?.includes('flac') ? '.flac'
      : '.oga';
    tempFilePath = path.join(os.tmpdir(), `nexusgram_transcribe_${Date.now()}${ext}`);

    await downloadTelegramAudio(config.TELEGRAM_BOT_TOKEN, file.file_path, tempFilePath);

    const buf = fs.readFileSync(tempFilePath);
    if (!buf.length) throw new Error('Downloaded empty audio file.');

    const transcript = await transcribeFile(tempFilePath);

    // Remove ack
    try {
      await ctx.api.deleteMessage(chatId, ackMsg.message_id);
    } catch (e) {
      console.debug('[Transcribe] Failed to delete ack message:', e instanceof Error ? e.message : e);
    }

    await sendTranscriptResult(ctx, transcript);
    transcriptResult = transcript;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Transcribe] Error:', sanitizeError(error));
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `❌ ${errorMessage}`, { parse_mode: undefined });
    } catch {
      await replyWithMarkdownFallback(ctx, `❌ Transcription error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        console.warn(`[Transcribe] Cleanup failed for ${sanitizePath(tempFilePath)}:`, sanitizeError(e));
      }
    }
  }
  return transcriptResult;
}

export async function handleTranscribe(ctx: Context): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  // Path A: reply to a voice/audio/audio-document message
  const reply = ctx.message?.reply_to_message;
  if (reply) {
    const voice = (reply as { voice?: { file_id: string; mime_type?: string } }).voice;
    const audio = (reply as { audio?: { file_id: string; mime_type?: string } }).audio;
    const doc = (reply as { document?: { file_id: string; mime_type?: string } }).document;

    const fileId = voice?.file_id
      || audio?.file_id
      || (doc?.mime_type?.startsWith('audio/') ? doc.file_id : null);
    const mime = voice?.mime_type || audio?.mime_type || doc?.mime_type;

    if (fileId) {
      await transcribeAndSend(ctx, fileId, mime);
      return;
    }
  }

  // Path B: no audio attached — send ForceReply prompt + register it (RI-23) so
  // only a reply to THIS specific, fresh, one-shot prompt routes transcribe-only.
  const promptMsg = await ctx.reply(
    '🎤 *Transcribe Audio*\n\n_Send a voice note or audio file:_',
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Send a voice note or audio file',
        selective: true,
      },
    }
  );
  registerTranscribePrompt(ctx.chat?.id ?? 0, ctx.from?.id ?? 0, promptMsg.message_id);
}

/**
 * Handle audio messages (message:audio) sent as reply to the Transcribe ForceReply.
 */
export async function handleTranscribeAudio(ctx: Context): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  const audio = ctx.message?.audio;
  if (!audio) {
    console.warn('[TranscribeAudio] Handler fired but ctx.message.audio is undefined');
    return;
  }

  // RI-23 (Tier-1): transcribe-only ONLY for a reply to a FRESH /transcribe prompt
  // (precise prompt msg-id + same user + TTL + one-shot). A stale prompt no longer
  // hijacks a real audio question — it falls through to the agent path below.
  const replyTo = ctx.message?.reply_to_message;
  const isTranscribeOnly = takeFreshTranscribeReply(ctx.chat?.id ?? 0, ctx.from?.id ?? 0, replyTo?.message_id);

  console.log(`[TranscribeAudio] file_id=${audio.file_id} mime=${audio.mime_type} size=${audio.file_size} transcribeOnly=${isTranscribeOnly}`);
  const transcript = await transcribeAndSend(ctx, audio.file_id, audio.mime_type);

  // RI-23 (2026-06-06, Codex M-11 R2): transcribe-only — tag honestly ONLY when transcription
  // actually succeeded; a null transcript means transcribeAndSend failed → mark error, not success.
  if (isTranscribeOnly) {
    const rid = getInputLogRowId(ctx.chat?.id ?? 0, ctx.message?.message_id ?? 0);
    if (transcript) markHandledNoAgent(rid, 'transcribe_only');
    else markError(rid, 'transcribe_failed');
    return;
  }

  // For plain forwarded audio (not /transcribe ForceReply), also feed transcript to Claude
  if (transcript) {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;
    const { sessionKey } = keyInfo;

    const session = sessionManager.getOrResumeSession(sessionKey);
    if (!session) return;

    // Tier-1: thread the input-log row + run the shared post-agent hook on the
    // command-audio agent path (Bug-A guard was audio-blind, like voice).
    const inputLogRowId = getInputLogRowId(ctx.chat?.id ?? 0, ctx.message?.message_id ?? 0);

    try {
    await queueRequest(sessionKey, transcript, async (turnEpoch) => {
      // D0 Hardening Item 1 / Amendment A (2026-05-27): Audio pre-side-effect guard.
      assertTurnIsCurrent(sessionKey, turnEpoch);
      markProcessing(inputLogRowId); // RI-23: forwarded-audio agent path was input-log-blind
      if (isVoiceActive(sessionKey)) {
        await ctx.replyWithChatAction('typing');
        const abortController = new AbortController();
        setAbortController(sessionKey, abortController, turnEpoch);
        const response = await sendToAgent(sessionKey, transcript, {
          abortController,
          voiceMode: true,
          telegramCtx: ctx,
          currentInputLogRowId: inputLogRowId,
          turnEpoch,
        });
        await maybeSendVoiceReply(ctx, response.text, { voiceMode: true });
        await messageSender.sendMessage(ctx, response.text);
        await sendFollowUpButtons(ctx, sessionKey, response.text, response.buttons);
        await runPostAgentSuccess(ctx, sessionKey, response);
        markDone(inputLogRowId);
      } else if (getStreamingMode() === 'streaming') {
        await messageSender.startStreaming(ctx);
        const abortController = new AbortController();
        setAbortController(sessionKey, abortController, turnEpoch);
        try {
          const response = await sendToAgent(sessionKey, transcript, {
            onProgress: (progressText) => { messageSender.updateStream(ctx, progressText); },
            abortController,
            telegramCtx: ctx,
            currentInputLogRowId: inputLogRowId,
            turnEpoch,
          });
          await messageSender.finishStreaming(ctx, response.text);
          await maybeSendVoiceReply(ctx, response.text, {});
          await sendFollowUpButtons(ctx, sessionKey, response.text, response.buttons);
          await runPostAgentSuccess(ctx, sessionKey, response);
          markDone(inputLogRowId);
        } catch (error) {
          await messageSender.cancelStreaming(ctx);
          throw error;
        }
      } else {
        await ctx.replyWithChatAction('typing');
        const abortController = new AbortController();
        setAbortController(sessionKey, abortController, turnEpoch);
        const response = await sendToAgent(sessionKey, transcript, {
          abortController,
          telegramCtx: ctx,
          currentInputLogRowId: inputLogRowId,
          turnEpoch,
        });
        await messageSender.sendMessage(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text, {});
        await sendFollowUpButtons(ctx, sessionKey, response.text, response.buttons);
        await runPostAgentSuccess(ctx, sessionKey, response);
        markDone(inputLogRowId);
      }
    });
    } catch (error) {
      if (error instanceof StaleTurnError) {
        console.log(`[TranscribeAudio] stale turn discarded for ${sessionKey} (epoch ${error.turnEpoch})`);
        markDropped(inputLogRowId, 'superseded');
        return;
      }
      if ((error as Error).message === 'Queue cleared') { markDropped(inputLogRowId, 'queue_cleared'); return; }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[TranscribeAudio] Agent error:', errorMessage);
      markError(inputLogRowId, errorMessage.slice(0, 200));
    }
  }
}

/**
 * Handle document messages with audio MIME sent as reply to the Transcribe ForceReply.
 */
export async function handleTranscribeDocument(ctx: Context): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  const doc = ctx.message?.document;
  if (!doc || !doc.mime_type?.startsWith('audio/')) return;

  const transcript = await transcribeAndSend(ctx, doc.file_id, doc.mime_type);
  // RI-23 (2026-06-06, Codex M-11 R2): tag success honestly ONLY when transcription succeeded;
  // null transcript = failure → markError, not a fake 'transcribe_only' success.
  const rid = getInputLogRowId(ctx.chat?.id ?? 0, ctx.message?.message_id ?? 0);
  if (transcript) markHandledNoAgent(rid, 'transcribe_only');
  else markError(rid, 'transcribe_failed');
}

// ── /extract command ───────────────────────────────────────────────

// Store pending extract URLs keyed by sessionKey so the callback knows what to process
const pendingExtractUrls = new Map<string, string>();

// TTLs for cleanup (in ms)
const EXTRACT_URL_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROJECT_BROWSER_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Track timestamps for extract URLs and project browser
const pendingExtractTimestamps = new Map<string, number>();
const projectBrowserTimestamps = new Map<string, number>();

/**
 * Cleanup interval to prevent memory leaks from unbounded Maps.
 * Runs every 60 seconds and removes stale entries.
 */
// Interval assigned to call .unref() for graceful shutdown
const cleanupInterval = setInterval(() => {
  const now = Date.now();

  // Clean pendingMediumResults (already has expiresAt field)
  for (const [key, entry] of pendingMediumResults.entries()) {
    if (now > entry.expiresAt) {
      pendingMediumResults.delete(key);
      console.log(`[cleanup] Removed stale pendingMediumResults for ${key}`);
    }
  }

  // Clean pendingExtractUrls
  for (const [key, timestamp] of pendingExtractTimestamps.entries()) {
    if (now - timestamp > EXTRACT_URL_TTL_MS) {
      pendingExtractUrls.delete(key);
      pendingExtractTimestamps.delete(key);
      console.log(`[cleanup] Removed stale pendingExtractUrls for ${key}`);
    }
  }

  // Clean projectBrowserState
  for (const [key, timestamp] of projectBrowserTimestamps.entries()) {
    if (now - timestamp > PROJECT_BROWSER_TTL_MS) {
      projectBrowserState.delete(key);
      projectBrowserTimestamps.delete(key);
      console.log(`[cleanup] Removed stale projectBrowserState for ${key}`);
    }
  }
}, 60_000);
cleanupInterval.unref();

export async function handleExtract(ctx: Context): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `\u{1F4E5} *Extract Media*\n\n` +
      `Extract text, audio, or video from a URL\\.\n\n` +
      `*Supported platforms:*\n` +
      `\u{25B6}\u{FE0F} YouTube\n` +
      `\u{1F4F7} Instagram\n` +
      `\u{1F3B5} TikTok\n\n` +
      `\u{1F447} _Paste a URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://youtube.com/watch?v=...',
          selective: true,
        },
      }
    );
    return;
  }

  await showExtractMenu(ctx, args);
}

export async function showExtractMenu(ctx: Context, url: string): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  if (!isValidUrl(url)) {
    await ctx.reply('\u{274C} Invalid URL\\. Please provide a valid link\\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  const platform = detectPlatform(url);
  if (platform === 'unknown') {
    await ctx.reply(
      '\u{26A0}\u{FE0F} Unsupported platform\\. Supported: YouTube, Instagram, TikTok\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const label = platformLabel(platform);

  // Store URL for callback (with timestamp for cleanup)
  pendingExtractUrls.set(sessionKey, url);
  pendingExtractTimestamps.set(sessionKey, Date.now());

  await replyWithMarkdownFallback(
    ctx,
    `\u{1F4E5} *Extract from ${esc(label)}*\n\n` +
    `\`${esc(url.length > 60 ? url.slice(0, 57) + '...' : url)}\`\n\n` +
    `What do you want?`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '\u{1F4DD} Text', callback_data: 'extract:text' },
            { text: '\u{1F3A7} Audio', callback_data: 'extract:audio' },
          ],
          [
            { text: '\u{1F3AC} Video', callback_data: 'extract:video' },
            { text: '\u{2728} All', callback_data: 'extract:all' },
          ],
        ],
      },
    }
  );
}

export async function handleExtractCallback(ctx: Context): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await ctx.answerCallbackQuery({ text: 'Feature disabled' });
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const data = ctx.callbackQuery?.data;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!data || !keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  // Handle subtitle format selection (extract:subfmt:<format>)
  if (data.startsWith('extract:subfmt:')) {
    const subtitleFormat = data.replace('extract:subfmt:', '') as SubtitleFormat;
    if (!['text', 'srt', 'vtt'].includes(subtitleFormat)) return;

    await ctx.answerCallbackQuery();

    const url = pendingExtractUrls.get(sessionKey);
    if (!url) {
      await ctx.reply('\u{26A0}\u{FE0F} Session expired\\. Please send the URL again with `/extract`\\.', {
        parse_mode: 'MarkdownV2',
      });
      return;
    }
    pendingExtractUrls.delete(sessionKey);
    pendingExtractTimestamps.delete(sessionKey);

    // Remove the subtitle format menu
    try {
      const menuMsgId = ctx.callbackQuery?.message?.message_id;
      if (menuMsgId) await ctx.api.deleteMessage(chatId, menuMsgId);
    } catch (e) {
      console.debug('[extract] Failed to delete menu message:', e instanceof Error ? e.message : e);
    }

    await executeExtract(ctx, url, 'text', subtitleFormat);
    return;
  }

  const mode = data.replace('extract:', '') as ExtractMode;
  if (!['text', 'audio', 'video', 'all'].includes(mode)) return;

  await ctx.answerCallbackQuery();

  const url = pendingExtractUrls.get(sessionKey);
  if (!url) {
    await ctx.reply('\u{26A0}\u{FE0F} Session expired\\. Please send the URL again with `/extract`\\.', {
      parse_mode: 'MarkdownV2',
    });
    return;
  }

  // YouTube + Text → show subtitle format submenu (keep URL pending)
  const platform = detectPlatform(url);
  if (mode === 'text' && platform === 'youtube') {
    try {
      await ctx.editMessageText(
        `\u{1F4DD} *Subtitle Format*\n\n` +
        `How would you like the transcript?`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '\u{1F4DD} Plain Text', callback_data: 'extract:subfmt:text' },
              ],
              [
                { text: '\u{1F4CB} SRT', callback_data: 'extract:subfmt:srt' },
                { text: '\u{1F4C4} VTT', callback_data: 'extract:subfmt:vtt' },
              ],
            ],
          },
        }
      );
    } catch {
      // If edit fails, send new message
      await ctx.reply(
        `\u{1F4DD} *Subtitle Format*\n\nHow would you like the transcript?`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '\u{1F4DD} Plain Text', callback_data: 'extract:subfmt:text' },
              ],
              [
                { text: '\u{1F4CB} SRT', callback_data: 'extract:subfmt:srt' },
                { text: '\u{1F4C4} VTT', callback_data: 'extract:subfmt:vtt' },
              ],
            ],
          },
        }
      );
    }
    return;
  }

  pendingExtractUrls.delete(sessionKey);
  pendingExtractTimestamps.delete(sessionKey);

  // Remove the menu message
  try {
    const menuMsgId = ctx.callbackQuery?.message?.message_id;
    if (menuMsgId) {
      await ctx.api.deleteMessage(chatId, menuMsgId);
    }
  } catch (e) {
    console.debug('[extract] Failed to delete menu message:', e instanceof Error ? e.message : e);
  }

  await executeExtract(ctx, url, mode);
}

// ── /inbox Command ────────────────────────────────────────────────────

export async function handleInbox(ctx: Context): Promise<void> {
  if (!config.DOCUMENT_INBOX_ENABLED) {
    await replyFeatureDisabled(ctx, 'Document Inbox');
    return;
  }

  const { listInbox, getInboxStats, formatFileSize, routeFile, getInboxDir } = await import('../../inbox/inbox.js');

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1);
  const subcommand = args[0]?.toLowerCase();

  // /inbox route <index> <target_dir> — route a file
  if (subcommand === 'route' && args.length >= 3) {
    const index = parseInt(args[1], 10) - 1; // 1-based to 0-based
    const targetDir = args.slice(2).join(' ');
    const items = listInbox();

    if (isNaN(index) || index < 0 || index >= items.length) {
      await ctx.reply(`Invalid file number. Use /inbox to see the list (1-${items.length}).`, { parse_mode: undefined });
      return;
    }

    const item = items[index];
    const workspaceRoot = getWorkspaceRoot();
    const resolvedTarget = path.isAbsolute(targetDir)
      ? targetDir
      : path.resolve(workspaceRoot, targetDir);

    if (!isPathWithinRoot(workspaceRoot, resolvedTarget)) {
      await ctx.reply(`Target must be within workspace: ${workspaceRoot}`, { parse_mode: undefined });
      return;
    }

    try {
      const { newPath } = routeFile(item.savedPath, resolvedTarget);
      await messageSender.sendMessage(ctx, `Routed **${item.originalFilename}** to:\n\`${newPath}\``);
    } catch (error) {
      await ctx.reply(`Route failed: ${error instanceof Error ? error.message : String(error)}`, { parse_mode: undefined });
    }
    return;
  }

  // /inbox clear — clear all files from inbox
  if (subcommand === 'clear') {
    const items = listInbox();
    if (items.length === 0) {
      await ctx.reply('INBOX is already empty.', { parse_mode: undefined });
      return;
    }

    await ctx.reply(
      `Delete ${items.length} file(s) from INBOX?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Yes, clear all', callback_data: 'inbox:clear:confirm' },
              { text: 'Cancel', callback_data: 'inbox:clear:cancel' },
            ],
          ],
        },
      }
    );
    return;
  }

  // /inbox (no args) — list files
  const items = listInbox();
  const stats = getInboxStats();

  if (items.length === 0) {
    await ctx.reply('INBOX is empty. Send me a document to get started.', { parse_mode: undefined });
    return;
  }

  const lines = items.map((item, i) => {
    const caption = item.caption ? ` — "${item.caption}"` : '';
    const age = getRelativeTime(item.receivedAt);
    return `${i + 1}. **${item.originalFilename}** (${formatFileSize(item.fileSize)})${caption}\n   ${item.mimeType || 'unknown'} | ${age}`;
  });

  const msg = [
    `**INBOX** — ${stats.totalFiles} file(s), ${stats.totalSizeMB} MB`,
    '',
    ...lines,
    '',
    '**Commands:**',
    '`/inbox route <#> <dir>` — move file to directory',
    '`/inbox clear` — clear all files',
  ].join('\n');

  await messageSender.sendMessage(ctx, msg);
}

export async function handleInboxCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data === 'inbox:clear:confirm') {
    const { listInbox, getInboxDir } = await import('../../inbox/inbox.js');
    const items = listInbox();
    const inboxDir = getInboxDir();

    let deleted = 0;
    for (const item of items) {
      try {
        if (fs.existsSync(item.savedPath)) fs.unlinkSync(item.savedPath);
        const metaPath = item.savedPath + '.meta.json';
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        deleted++;
      } catch { /* skip */ }
    }

    await ctx.answerCallbackQuery({ text: `Cleared ${deleted} file(s)` });
    try {
      await ctx.editMessageText(`INBOX cleared. ${deleted} file(s) removed.`);
    } catch {
      await ctx.reply(`INBOX cleared. ${deleted} file(s) removed.`, { parse_mode: undefined });
    }
  } else if (data === 'inbox:clear:cancel') {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    try {
      await ctx.deleteMessage();
    } catch { /* ignore */ }
  }
}

function getRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function handlePd(ctx: Context): Promise<void> {
  if (!config.BOT_PD_ENABLED) {
    await ctx.reply('pd-Workspace ist für diesen Bot nicht aktiviert.', { parse_mode: undefined });
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1);
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === 'help') {
    await ctx.reply(
      'pd-Workspace — Product Development Agents\n\n' +
      '/pd session — Aktive pd-Sessions anzeigen\n' +
      '/pd council — Council Mode starten (mehrere Agent-Perspektiven)\n' +
      '/pd outcome — Letztes gespeichertes Outcome anzeigen\n' +
      '/pd help — Diese Hilfe\n\n' +
      'Oder schreibe einfach deine Frage — pd-dexmaster erkennt den Intent automatisch.',
      { parse_mode: undefined }
    );
    return;
  }

  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  if (subcommand === 'session') {
    await sendToAgent(sessionKey, '/pd session — zeige aktive pd-Sessions', {
      onProgress: (progressText) => {
        messageSender.updateStream(ctx, progressText);
      },
      command: 'pd',
    }).then(async (response) => {
      await messageSender.sendMessage(ctx, response.text);
    }).catch(async (error) => {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Fehler: ${errorMessage}`, { parse_mode: undefined });
    });
    return;
  }

  if (subcommand === 'council') {
    await sendToAgent(sessionKey, '/pd council — starte Council Mode', {
      onProgress: (progressText) => {
        messageSender.updateStream(ctx, progressText);
      },
      command: 'pd',
    }).then(async (response) => {
      await messageSender.sendMessage(ctx, response.text);
    }).catch(async (error) => {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Fehler: ${errorMessage}`, { parse_mode: undefined });
    });
    return;
  }

  if (subcommand === 'outcome') {
    await sendToAgent(sessionKey, '/pd outcome — zeige letztes gespeichertes Outcome', {
      onProgress: (progressText) => {
        messageSender.updateStream(ctx, progressText);
      },
      command: 'pd',
    }).then(async (response) => {
      await messageSender.sendMessage(ctx, response.text);
    }).catch(async (error) => {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await ctx.reply(`Fehler: ${errorMessage}`, { parse_mode: undefined });
    });
    return;
  }

  // Unknown subcommand — forward to agent as-is
  const userInput = args.join(' ');
  await sendToAgent(sessionKey, `/pd ${userInput}`, {
    onProgress: (progressText) => {
      messageSender.updateStream(ctx, progressText);
    },
    command: 'pd',
  }).then(async (response) => {
    await messageSender.sendMessage(ctx, response.text);
  }).catch(async (error) => {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`Fehler: ${errorMessage}`, { parse_mode: undefined });
  });
}

export async function handleWiki(ctx: Context): Promise<void> {
  const text = ctx.message?.text || '';
  const subcommand = text.split(' ')[1]?.toLowerCase();
  const nexusRoot = findDefaultNexusRoot();
  const SYNTHESIZER = nexusRoot ? path.join(nexusRoot, '.nexus-memory', 'nexus-wiki-synthesizer.sh') : null;
  const OMI_DIR = '/Volumes/AstronOne/shared-memory/omi/projects';
  const WIKI_DRAFTS = '/Volumes/AstronOne/shared-memory/nexus/wiki/drafts';
  const STATE_FILE = nexusRoot ? path.join(nexusRoot, '.nexus-memory', 'wiki-synthesizer-state.txt') : null;
  const WHITELIST = ['nexus', 'dexhub', 'ai-gilde'];

  if (!subcommand || subcommand === 'status') {
    // Count unprocessed transcripts
    let totalTranscripts = 0;
    let processedCount = 0;
    const processedFiles = new Set<string>();
    if (STATE_FILE && fs.existsSync(STATE_FILE)) {
      fs.readFileSync(STATE_FILE, 'utf8').split('\n').filter(Boolean).forEach(f => processedFiles.add(f));
    }
    for (const project of WHITELIST) {
      const dir = path.join(OMI_DIR, project);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      totalTranscripts += files.length;
      files.forEach(f => { if (processedFiles.has(path.join(dir, f))) processedCount++; });
    }
    const unprocessed = totalTranscripts - processedCount;

    // Count drafts
    let draftCount = 0;
    let oldestDraft = '';
    if (fs.existsSync(WIKI_DRAFTS)) {
      const drafts = fs.readdirSync(WIKI_DRAFTS).filter(f => f.endsWith('.md')).sort();
      draftCount = drafts.length;
      if (drafts.length > 0) oldestDraft = drafts[0];
    }

    const lines = [
      '📚 Wiki Synthesizer Status',
      '',
      `📝 OMI Transkripte (Whitelist): ${totalTranscripts} total, ${unprocessed} unverarbeitet`,
      `📋 Drafts pending Review: ${draftCount}`,
      oldestDraft ? `   Ältester: ${oldestDraft.replace('.md', '')}` : '',
      '',
      '/wiki update — jetzt synthetisieren',
    ].filter(l => l !== '');

    await ctx.reply(lines.join('\n'), { parse_mode: undefined });
    return;
  }

  if (subcommand === 'update') {
    if (!SYNTHESIZER || !fs.existsSync(SYNTHESIZER)) {
      await ctx.reply('❌ Synthesizer nicht gefunden: ' + (SYNTHESIZER || 'unknown path'), { parse_mode: undefined });
      return;
    }

    await ctx.reply('🔄 Wiki Synthesizer gestartet... (läuft im Hintergrund)', { parse_mode: undefined });

    // Run synthesizer asynchronously, cap output
    const child = spawn(SYNTHESIZER, [], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });

    child.on('close', async (code) => {
      const preview = output.slice(-1000);
      const status = code === 0 ? '✅ Fertig' : `⚠️ Exit ${code}`;
      await ctx.reply(`${status}\n\n${preview || '(kein Output)'}`, { parse_mode: undefined }).catch(() => {});
    });
    return;
  }

  await ctx.reply('/wiki status — Übersicht\n/wiki update — Synthesizer jetzt starten', { parse_mode: undefined });
}

export async function executeExtract(ctx: Context, url: string, mode: ExtractMode, subtitleFormat?: SubtitleFormat): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const ackMsg = await ctx.reply('\u{1F4E5} Processing...', { parse_mode: undefined });

  const updateAck = async (text: string) => {
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, text, { parse_mode: undefined });
    } catch (e) {
      // Update can fail if message was deleted or content unchanged
      console.debug('[extract] Failed to update ack message:', e instanceof Error ? e.message : e);
    }
  };

  let result: ExtractResult | null = null;

  try {
    result = await extractMedia({
      url,
      mode,
      subtitleFormat,
      onProgress: (msg) => updateAck(msg),
    });

    // Delete ack message
    try {
      await ctx.api.deleteMessage(chatId, ackMsg.message_id);
    } catch (e) {
      console.debug('[extract] Failed to delete ack message:', e instanceof Error ? e.message : e);
    }

    // Send results
    const platform = platformLabel(result.platform);
    const title = result.title || 'Untitled';
    const durationStr = result.duration
      ? ` (${Math.floor(result.duration / 60)}:${String(Math.floor(result.duration % 60)).padStart(2, '0')})`
      : '';

    // Header
    const header = `\u{1F4E5} *${esc(platform)}*: ${esc(title)}${esc(durationStr)}`;

    // Send video if available
    if (result.videoPath && fs.existsSync(result.videoPath)) {
      try {
        await ctx.replyWithChatAction('upload_video');
        await ctx.replyWithVideo(new InputFile(result.videoPath), {
          caption: `\u{1F3AC} ${title}${durationStr}`,
          supports_streaming: true,
        });
      } catch (videoSendErr) {
        console.warn('[extract] Failed to send video:', videoSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Video file could not be sent (may be too large).', { parse_mode: undefined });
      }
    }

    // Send audio if requested (and not already handled by video)
    if (result.audioPath && fs.existsSync(result.audioPath) && (mode === 'audio' || mode === 'all')) {
      try {
        await ctx.replyWithChatAction('upload_voice');
        await ctx.replyWithAudio(new InputFile(result.audioPath), {
          title: title,
          caption: `\u{1F3A7} ${title}${durationStr}`,
        });
      } catch (audioSendErr) {
        console.warn('[extract] Failed to send audio:', audioSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Audio file could not be sent.', { parse_mode: undefined });
      }
    }

    // Send subtitle file (SRT/VTT) if available
    if (result.subtitlePath && result.subtitleFormat && fs.existsSync(result.subtitlePath)) {
      const ext = result.subtitleFormat; // 'srt' or 'vtt'
      const safeTitle = title.replace(/[^a-zA-Z0-9]/g, '_');
      const fileName = `${safeTitle}.${ext}`;
      try {
        const inputFile = new InputFile(fs.readFileSync(result.subtitlePath), fileName);
        await ctx.replyWithDocument(inputFile, {
          caption: `\u{1F4DD} ${ext.toUpperCase()} subtitles for: ${title}${durationStr}`,
        });
      } catch (subSendErr) {
        console.warn('[extract] Failed to send subtitle file:', subSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Subtitle file could not be sent.', { parse_mode: undefined });
      }
    }

    // Send transcript (plain text from Whisper or YouTube VTT→text)
    if (result.transcript) {
      if (result.transcript.length <= config.TRANSCRIBE_FILE_THRESHOLD_CHARS) {
        await replyWithMarkdownFallback(ctx, `${header}\n\n${esc(result.transcript)}`, {
          parse_mode: 'MarkdownV2',
        });
      } else {
        // Send as .txt file
        const tmpPath = path.join(os.tmpdir(), `extract_transcript_${Date.now()}.txt`);
        try {
          fs.writeFileSync(tmpPath, result.transcript, { encoding: 'utf-8', mode: 0o600 });
          const inputFile = new InputFile(fs.readFileSync(tmpPath), `${title.replace(/[^a-zA-Z0-9]/g, '_')}_transcript.txt`);
          await ctx.replyWithDocument(inputFile, {
            caption: `\u{1F4DD} Transcript (${result.transcript.length} chars)`,
          });
        } finally {
          try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          } catch (e) {
            console.warn(`[extract] Cleanup failed for ${sanitizePath(tmpPath)}:`, sanitizeError(e));
          }
        }
      }
    } else if ((mode === 'text' || mode === 'all') && !result.subtitlePath) {
      // Transcript was expected but empty and no subtitle file was sent either
      await ctx.reply('\u{26A0}\u{FE0F} No speech detected in the audio.', { parse_mode: undefined });
    }

    // Show any warnings
    for (const warning of result.warnings) {
      await ctx.reply(`\u{26A0}\u{FE0F} ${warning}`, { parse_mode: undefined });
    }

    // Success summary for non-text modes when no transcript was sent
    if (mode !== 'text' && !result.transcript) {
      await replyWithMarkdownFallback(ctx, header, { parse_mode: 'MarkdownV2' });
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[extract] Error:', sanitizeError(error));
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `\u{274C} ${errorMessage}`, { parse_mode: undefined });
    } catch {
      await replyWithMarkdownFallback(ctx, `\u{274C} Extraction failed: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    if (result) {
      cleanupExtractResult(result);
    }
  }
}

/**
 * /with <person> — Phase 7.5 person-timeline slash alias.
 *
 * Wraps `searchPersonTimeline` (the same service function the MCP tool
 * `omi_person_timeline` uses) so the user gets deterministic, token-cheap
 * timeline lines without an LLM round-trip. Operator-only and /private-aware
 * (delegated to the helper).
 *
 * Codex pre-review: cross_review_phase-7-5-context-mcp-tools-architecture_2026-05-27.md
 */
export async function handleWith(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const rawArg = typeof ctx.match === 'string' ? ctx.match : '';
  const person = rawArg.trim();
  if (!person) {
    await replyWithMarkdownFallback(
      ctx,
      'Nutze: `/with <Person>` — z.B.\n' +
        '`/with Simone`  oder  `/with Tim Zähres`\n\n' +
        'Liefert eine chronologische Liste der jüngsten Mentions aus OMI + Memory mit Datum + Quelle. ' +
        'Nicht verfügbar in /private-on oder in Family/Test-Bot-Kontext.',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  try {
    const { searchPersonTimeline, readMemoryPolicyFromEnv } = await import('../../memory/nexus-memory.js');
    const bootPolicy = readMemoryPolicyFromEnv();
    const sessionIsPrivate = isPrivate(sessionKey);
    const effectivePolicy = sessionIsPrivate
      ? { ...bootPolicy, scope: 'public' as const }
      : bootPolicy.scope === 'operator_all'
        ? { ...bootPolicy, scope: 'public' as const }
        : bootPolicy;

    const result = searchPersonTimeline({ person, limit: 10, policy: effectivePolicy });

    if (result.scope_denied) {
      const reason = sessionIsPrivate
        ? '/private is on — turn /private off and retry'
        : 'this bot scope does not expose the person timeline';
      await ctx.reply(`No timeline available (${reason}).`);
      return;
    }
    if (result.resolution.status === 'ignored') {
      await ctx.reply(`"${person}" is marked as an ignored Apple-NL false-positive (not a real person in the index).`);
      return;
    }
    if (!result.resolution.personId) {
      if (result.resolution.suggestions.length > 0) {
        const sugg = result.resolution.suggestions
          .map((s) => `${s.label} (${s.mention_count}×${s.source === 'unresolved' ? ' unresolved' : ''})`)
          .join(', ');
        await ctx.reply(`No exact match for "${person}". Did you mean: ${sugg}?`);
      } else {
        await ctx.reply(`No person matches "${person}". Try a different spelling, or ask the bot to use omi_entity_search.`);
      }
      return;
    }
    if (result.hits.length === 0) {
      await ctx.reply(`0 timeline hits for "${result.resolution.canonicalName}".`);
      return;
    }

    const lines = result.hits.map((h, i) => {
      const date = h.source_created_at_utc ? h.source_created_at_utc.slice(0, 16).replace('T', ' ') : 'unknown';
      const kindLabel =
        h.source_kind === 'omi_memories' ? 'OMI memory'
        : h.source_kind === 'omi_transcription_segments' ? 'OMI segment'
        : 'memory.db';
      return `${i + 1}. ${date} ${kindLabel}\n   ${h.snippet}`;
    });
    const header = `Timeline for ${result.resolution.canonicalName} (${result.hits.length} hit${result.hits.length === 1 ? '' : 's'}${result.more_available ? ', more_available' : ''}):\n\n`;
    await ctx.reply(header + lines.join('\n\n'));
  } catch (err) {
    console.error('[/with] handler error:', err);
    await ctx.reply(`/with error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * /private on | off | status — Privacy Mode Phase 1
 *
 * Per-chat (and per-forum-topic) toggle. When `on`:
 *   - new memories saved via this session are tagged privacy='private',
 *   - retrieval / memory-context skips private rows unless the session itself
 *     is currently private,
 *   - the conversation log is written to a *.private.log file that the
 *     nightly Ollama synthesizer does NOT consume,
 *   - the system prompt gets a neutralizing suffix that tells the model to
 *     avoid personal references.
 *
 * Concept doc: shared-memory/nexus/concept_privacy_mode_2026-04-19.md
 */
export async function handlePrivate(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const raw = (ctx.message?.text || '').trim();
  // Strip leading "/private" (and optional @botname suffix) + args
  const afterCmd = raw.replace(/^\/private(@\S+)?\s*/i, '').trim().toLowerCase();
  const rawArg = afterCmd.split(/\s+/)[0] || '';
  // UX 2026-05-27: `/private` alone now toggles. Explicit on/off/status still work.
  let arg = rawArg;
  if (!rawArg) {
    arg = getStatus(sessionKey)?.mode === 'private' ? 'off' : 'on';
  }

  if (arg === 'on') {
    const wasPrivate = isPrivate(sessionKey);
    const rec = setPrivate(sessionKey);

    // Privacy Bug-Fix 2026-05-27 (Pfad-B Bug-2): toggling `/private on` must
    // also forget the resumable Claude-Code session and roll the turn epoch.
    // Without this the next user message resumes the prior session whose
    // in-memory context still contains the private rows the operator just
    // asked us to scrub — i.e. /private on would leak past the next prompt.
    // Mirrors Stage 2 cancel-HARD-rollback semantics, scoped to a fresh
    // toggle (avoid wiping continuity if user re-toggles an already-on chat).
    if (!wasPrivate) {
      invalidateCurrentTurn(sessionKey, 'private-toggle-on');
      forgetChatSession(sessionKey);
      sessionManager.forceFreshSession(sessionKey);
      discardCancelledTurnState(sessionKey);
    }

    await replyMd(
      ctx,
      `🔒 *Privacy Mode: ON*\n\n` +
      `This chat is now private since ${esc(rec.since)}\\.\n\n` +
      `• new memories will be tagged \`private\` and stay out of the wiki\n` +
      `• conversation log goes to a \\.private\\.log file \\(skipped by synthesizer\\)\n` +
      `• the bot will avoid personal references in replies\n` +
      (wasPrivate ? '' : `• prior session context cleared — next message starts fresh\n`) +
      `\nSend /private off to return to public mode\\.`,
    );
    return;
  }

  if (arg === 'off') {
    const was = getStatus(sessionKey);
    setPublic(sessionKey);
    const sinceNote = was ? ` \\(was private since ${esc(was.since)}\\)` : '';
    await replyMd(
      ctx,
      `🔓 *Privacy Mode: OFF*${sinceNote}\n\n` +
      `This chat is public again\\. New turns are logged normally and eligible for wiki synthesis\\.\n\n` +
      `⚠️ Turns captured during private mode stay tagged private — they are NOT retroactively published\\.`,
    );
    return;
  }

  // status (default)
  const rec = getStatus(sessionKey);
  if (rec?.mode === 'private') {
    await replyMd(
      ctx,
      `🔒 *Privacy Mode: ON*\n\n` +
      `Active since ${esc(rec.since)}\\.\n\n` +
      `Use /private off to return to public mode\\.`,
    );
  } else {
    await replyMd(
      ctx,
      `🔓 *Privacy Mode: OFF* \\(default\\)\n\n` +
      `Use /private on to temporarily isolate this chat from memory / wiki / personal tone\\.`,
    );
  }
}

/**
 * /health — read-only compliance + observability dashboard.
 * Mai-Intervention Phase C.3 / Sprint 8.
 *
 * Aggregates state from process metrics, the per-session active queue,
 * the RequestContext registry, and the NEXUS memory FTS5 row count. Output
 * is constrained to <1500 chars MarkdownV2 so it fits a single Telegram bubble.
 *
 * Cross-Refs:
 *  - shared-memory/nexus/v25_phase_c_handoff_2026-05-12.md (C.3)
 *  - shared-memory/nexus/codex_phase_c_pre_review_2026-05-12.md §5
 */
export async function handleHealth(ctx: Context): Promise<void> {
  // Process metrics
  const uptimeSec = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSec / 3600); // allow-hardcoded: reason="sec→h display conversion, not a timeout"
  const minutes = Math.floor((uptimeSec % 3600) / 60); // allow-hardcoded: reason="sec→min display conversion"
  const seconds = uptimeSec % 60; // allow-hardcoded: reason="display conversion"
  const uptimeStr = hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;

  const pid = process.pid;
  const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(1); // allow-hardcoded: reason="bytes→MB display conversion"
  const effectiveness = getBotEffectivenessHealth();

  // Active queue + RequestContext registry
  const activeKeys = getActiveSessionKeys();
  const snapshot = snapshotRegistry();
  const byStateLines = Object.entries(snapshot.byState)
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `  • ${state}: ${n}`)
    .join('\n');
  const byOriginLines = Object.entries(snapshot.byOrigin)
    .filter(([, n]) => n > 0)
    .map(([origin, n]) => `  • ${origin}: ${n}`)
    .join('\n');

  // NEXUS Memory DB FTS5 row count (read-only). Lazy import so /health works
  // even if memory subsystem fails to initialize.
  let memoryRowCount = -1;
  let memoryError: string | null = null;
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(
      '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/memory.db',
      { readonly: true },
    );
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
      memoryRowCount = row.n;
    } finally {
      db.close();
    }
  } catch (err) {
    memoryError = err instanceof Error ? err.message : String(err);
  }

  // Stage 2b Action 10: build-time static counter labelled as such so
  // operators can verify against `grep -rnE 'await Promise\.race' src/`
  // without thinking the number is runtime-instrumented. Updated on every
  // build/commit; the label below contains the call-site list for transparency.
  //
  // Current call-sites (verify with: `grep -rnE 'await Promise\\.race' src/`):
  //   - src/index.ts:98 (shutdown-notify race)
  //   - src/claude/request-queue.ts (gracefulCancel interrupt-fallback)
  //   - src/claude/request-queue.ts (processQueue failsafe — emits
  //     QueueFailsafeTimeoutError, NOT user-facing)
  //   - src/media/link-inbox.ts:119 (capture pipeline)
  //
  // Agent-call paths (message.handler.ts + handleAgentReply): 0 live races.
  const PROMISE_RACE_BUILD_TIME_COUNT = 4; // allow-hardcoded: reason="build-time static counter, not a timeout"

  // Capability ledger pointer (file lives outside the repo — operator-readable)
  const ledgerPath = '/Volumes/AstronOne/shared-memory/nexus/capability_ledger.json';

  const lines = [
    `🩺 *Health* \\(${esc(config.BOT_NAME)}\\)`,
    `*Uptime:* ${esc(uptimeStr)} · *PID:* ${pid} · *Mem:* ${esc(memMB)} MB`,
    ``,
    `*Active sessions:* ${activeKeys.length}`,
    `*Active requests:* ${snapshot.totalActive} \\(${snapshot.sessionsActive} sessions\\)`,
  ];
  if (byStateLines) {
    lines.push(`*By state:*\n${esc(byStateLines)}`);
  }
  if (byOriginLines) {
    lines.push(`*By origin:*\n${esc(byOriginLines)}`);
  }
  // Schlachtplan Akt 1.2: durable Input-Log pending count. >0 for a sustained
  // period means inputs are being received but not finalized — the early
  // warning signal RI-19 lacked.
  const pendingInputs = countPendingInputs();
  // Tier-1: rows the catch-all finalizer closed without an agent answer (early
  // returns / RI-23 transcribe hijack). A rising number = inputs silently unanswered.
  const handlerNoFinalize = countHandlerNoFinalize();

  lines.push(
    ``,
    `*Input\\-Log pending:* ${pendingInputs >= 0 ? pendingInputs : esc('n/a')}`,
    `*Input\\-Log no\\-finalize:* ${handlerNoFinalize >= 0 ? handlerNoFinalize : esc('n/a')}`,
    `*Memory FTS5 rows:* ${memoryRowCount >= 0 ? memoryRowCount : esc(`error: ${memoryError ?? 'unknown'}`)}`,
    `*Promise\\.race outside agent path:* ${PROMISE_RACE_BUILD_TIME_COUNT} \\(build\\-time counter; verify: grep \\-rnE 'await Promise\\.race' src/\\)`,
    `*Agent\\-path Promise\\.race:* 0 \\(Sprint 3 RequestContext\\)`,
    `*Adaptive timeout threshold:* ${config.ADAPTIVE_TIMEOUT_QUEUE_THRESHOLD} queued`,
    `*Hard\\-cap base:* ${Math.round(config.AGENT_RESPONSE_TIMEOUT_MS / 60000)} min`, // allow-hardcoded: reason="ms→min display conversion"
    `*Capability ledger:* \`${esc(ledgerPath)}\``,
    `*Last delivered turn:* ${esc(effectiveness.turns.last_success_at ?? 'none since boot')}`,
    `*Telegram getMe:* ${esc(effectiveness.telegram_get_me.last_success_at ?? `failed: ${effectiveness.telegram_get_me.last_error ?? 'never'}`)}`,
  );

  // Phase 7.x — Scanner-Pro watcher status (one compact line per Codex P1-3).
  // Codex P0-1 fix: the entire payload after the label is run through esc() so
  // reserved chars (=, (), ., -, etc.) cannot break MarkdownV2 parsing.
  const sw = getScannerWatcherStatus();
  if (sw.enabled) {
    const last = sw.lastRunAt
      ? `${sw.lastExitCode === 0 ? '✓' : '✗'}exit=${sw.lastExitCode ?? 'n/a'} ${sw.lastDurationMs ?? '?'}ms`
      : 'no-run-yet';
    const status = `runs=${sw.totalRuns}(ok=${sw.totalSuccessRuns}) ${last} fails=${sw.consecutiveFailures}${sw.running ? ' (running)' : ''}`;
    lines.push(`*Scanner\\-Pro Watcher:* ${esc(status)}`);
  } else if (sw.reason) {
    lines.push(`*Scanner\\-Pro Watcher:* ${esc(`disabled (${sw.reason})`)}`);
  }

  // Phase 7.7 — OMI-Bridge auto-orchestrator status line. Same compact pattern
  // as Scanner-Pro, escaped for MarkdownV2. Codex P2-2 (keep /health under 1500).
  const ow = getOmiBridgeWatcherStatus();
  if (ow.enabled) {
    const lastPhase = ow.last_pipeline_at || ow.last_ner_at || ow.last_tasks_at || ow.last_ocr_at;
    const last = ow.last_run_started_at
      ? `${ow.last_run_duration_ms ?? '?'}ms last=${lastPhase ? lastPhase.slice(0, 16).replace('T', ' ') : 'never'}`
      : 'no-run-yet';
    const phaseLabel = ow.current_phase ? ` (running:${ow.current_phase})` : '';
    const status = `runs=${ow.total_runs}(ok=${ow.total_success_runs}) ${last} fails=${ow.consecutive_failures}${phaseLabel}`;
    lines.push(`*OMI\\-Bridge Watcher:* ${esc(status)}`);
  } else if (ow.reason) {
    lines.push(`*OMI\\-Bridge Watcher:* ${esc(`disabled (${ow.reason})`)}`);
  }

  const body = lines.join('\n');
  // Telegram MarkdownV2 single-bubble cap (4096); we self-cap at 1500 per Codex spec.
  const HEALTH_MAX_CHARS = 1500;
  const truncated = body.length > HEALTH_MAX_CHARS
    ? body.slice(0, HEALTH_MAX_CHARS - 32) + '\n\\.\\.\\. \\(truncated\\)'
    : body;

  await replyMd(ctx, truncated);
}

// Re-export the state helpers so other modules (message handler, agent, etc.)
// can import a single symbol via the barrel if they prefer. isPrivate is the
// stable public contract.
export { isPrivate };
