import {
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKCompactBoundaryMessage,
  type SDKStatusMessage,
  type SDKSystemMessage,
  type PermissionMode,
  type SettingSource,
  type HookEvent,
  type HookCallbackMatcher,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import { sessionManager } from './session-manager.js';
import { setActiveQuery, clearActiveQuery, isCancelled, gracefulCancel } from './request-queue.js';
import type { Context } from 'grammy';
import { config } from '../config.js';
import { AgentWatchdog } from './agent-watchdog.js';
import { createNexusgramMcpServer } from './mcp-tools.js';
import {
  createAgentTimer,
  recordMessage,
  formatDuration,
  getElapsedMs,
  getTimingReport,
  type AgentTimer,
} from '../utils/agent-timer.js';
import { recordTranscript, loadPreviousDayTranscript, loadTodayTranscript } from './transcript-logger.js';
import { buildNexusBridgePrompt } from '../nexus/bridge.js';
import { injectContext, saveMemory } from '../memory/nexus-memory.js';
import { logConversationTurn } from '../memory/conversation-logger.js';
import { isPrivate } from '../memory/privacy-state.js';
import { buildRecentUploadsContext } from '../memory/recent-uploads.js';

/**
 * Privacy Mode Phase 1 — neutralizing system-prompt suffix.
 * Appended to the system prompt when the current sessionKey is in private mode.
 * Concept: shared-memory/nexus/concept_privacy_mode_2026-04-19.md
 */
const PRIVACY_MODE_PROMPT = `

PRIVACY MODE ACTIVE (Phase 1):
- Do NOT reference personal memory (no "wie du in Session X sagtest…", no names of family members, no DHL-specific details, no project code-names from stored memory).
- Do NOT use casual/nicknamed address ("Ash"); stay neutral and professional.
- Do NOT surface examples from the user's personal ecosystem unless the user explicitly reintroduces them in THIS turn.
- Do NOT emit follow-up buttons that would trigger personal follow-up actions.
- Treat this conversation as if it were a fresh, unpersonalized session. The user has toggled /private on because this topic should not bleed into persistent memory or public artefacts.
`;

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
  contextWindow: number;
  numTurns: number;
  model: string;
}

interface AgentResponse {
  text: string;
  toolsUsed: string[];
  buttons?: string[];
  usage?: AgentUsage;
  compaction?: { trigger: 'manual' | 'auto'; preTokens: number };
  sessionInit?: { model: string; sessionId: string };
}

/**
 * Stage 2c (Mai-Intervention 2026-05-12): Canonical text the agent returns when
 * it observes `isCancelled(sessionKey) === true` mid-stream. Exported so the
 * Telegram-side streaming handler can detect "agent finished cleanly because
 * /cancel won upstream" and route through the cancel-UI branch instead of
 * `finishStreaming`, preventing the doppel-message pattern observed live on
 * 2026-05-12 22:44 (one "🛑 Cancelled." from handleCancel + one
 * "✅ Successfully cancelled..." edit on the streaming bubble).
 *
 * Single source of truth: any code emitting this sentinel MUST import this
 * constant — do not duplicate the literal string elsewhere.
 *
 * Cross-Refs:
 *  - shared-memory/nexus/phase_c_stage2c_minihotfix_report_2026-05-12.md
 *  - src/bot/handlers/message.handler.ts (consumer)
 */
export const CLAUDE_CANCEL_SENTINEL_TEXT =
  '✅ Successfully cancelled - no tools or agents in process.';

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AgentOptions {
  onProgress?: (text: string) => void;
  onToolStart?: (toolName: string, input?: Record<string, unknown>) => void;
  onToolEnd?: () => void;
  abortController?: AbortController;
  command?: string;
  model?: string;
  telegramCtx?: Context;
  /** When true, appends voice-mode instructions for conversational TTS-friendly responses */
  voiceMode?: boolean;
}

interface LoopOptions extends AgentOptions {
  maxIterations?: number;
  onIterationComplete?: (iteration: number, response: string) => void;
}

const conversationHistory: Map<string, ConversationMessage[]> = new Map();

// Track Claude Code session IDs per session for conversation continuity
const chatSessionIds: Map<string, string> = new Map();

// Track current model per session (default: sonnet)
const chatModels: Map<string, string> = new Map();

// Cache latest usage per session for /context and /status commands
const chatUsageCache: Map<string, AgentUsage> = new Map();

export function getCachedUsage(sessionKey: string): AgentUsage | undefined {
  return chatUsageCache.get(sessionKey);
}

const CORE_GUIDELINES = `You are ${config.BOT_NAME}, an AI assistant helping via Telegram.

Guidelines:
- Show relevant code snippets when helpful, but keep them short
- If a task requires multiple steps, execute them and summarize what you did
- When you can't do something, explain why briefly

Copy-Ready Content Rule:
ONLY use [SPLIT] when the user EXPLICITLY asks for a text to copy — e.g. "write me a WhatsApp message", "give me an email", "what should I text", "gib mir einen Text zum Kopieren".
- Send context/explanation first, then [SPLIT], then the copyable text in a code block (Telegram shows a one-tap Copy button)
- NEVER use [SPLIT] for normal responses, summaries, analyses, lists or structured answers — those stay as ONE message with headings and bullet points

Example (only for explicit copy requests):
Hier ist die WhatsApp-Nachricht an Ben:
[SPLIT]
\`\`\`
Hey Ben, kurze Frage wegen der Besichtigung...
\`\`\``;

const TELEGRAPH_FORMATTING = `

Response Formatting — Telegraph-Aware Writing:
Your responses are displayed via Telegram. Short responses render inline as MarkdownV2.
Longer responses (2500+ chars) are published as Telegraph (telegra.ph) Instant View pages.
You MUST write with Telegraph's rendering constraints in mind at all times.

Telegraph supports ONLY these elements:
- Headings: h3 (from # and ##) and h4 (from ### and ####). No h1, h2, h5, h6.
- Text formatting: **bold**, *italic*, ~~strikethrough~~, \`inline code\`
- Links: [text](url)
- Lists: unordered (- item) and ordered (1. item). Nested lists are supported (indent sub-items).
- Code blocks: \`\`\`code\`\`\` — rendered as monospace preformatted text. No syntax highlighting.
- Blockquotes: > text
- Horizontal rules: ---

Telegraph does NOT support:
- TABLES — pipe-delimited markdown tables (|col|col|) will NOT render as tables. They break into ugly labeled text. NEVER use markdown tables.
- No checkboxes, footnotes, or task lists
- No custom colors, fonts, or inline styles
- Only two heading levels (h3, h4)

Instead of tables, use these alternatives (in order of preference):
1. Bullet lists with bold labels — best for key-value data or comparisons:
   - **Name**: Alice
   - **Age**: 30
   - **City**: NYC

2. Nested lists — best for grouped/categorized data:
   - **Frontend**
     - React 18
     - TypeScript
   - **Backend**
     - Node.js
     - Express

3. Bold headers with list items — best for feature/comparison matrices:
   **Telegram bot** — Grammy v1.31
   **AI agent** — Claude Code SDK v1.0
   **TTS** — OpenAI gpt-4o-mini-tts

4. Preformatted code blocks — ONLY for data where alignment matters (ASCII tables):
   \`\`\`
   Name      Age   City
   Alice     30    NYC
   Bob       25    London
   \`\`\`
   Note: code blocks lose all formatting (no bold, links, etc.) so only use when alignment is critical.

Structure guidelines for long responses:
- Use ## or ### headings to create clear sections (renders as h3/h4)
- Use --- horizontal rules to separate major sections
- Use bullet lists liberally — they render cleanly
- Use > blockquotes for callouts, warnings, or important notes
- Keep paragraphs concise; Telegraph renders best with short blocks of text
- Nest sub-items under list items for tree-like structures instead of indented text`;

const INLINE_FORMATTING = `

Response Formatting:
Your responses are displayed via Telegram using MarkdownV2 formatting.
Long responses are automatically chunked into multiple messages.

Supported formatting:
- **bold**, *italic*, ~~strikethrough~~, \`inline code\`
- Links: [text](url)
- Lists: unordered (- item) and ordered (1. item)
- Code blocks: \`\`\`code\`\`\`
- Blockquotes: > text

Instead of tables (which don't render well in Telegram), use bullet lists with bold labels:
- **Name**: Alice
- **Age**: 30
- **City**: NYC`;

const FOLLOWUP_BUTTONS_INSTRUCTION = config.FOLLOWUP_BUTTONS_ENABLED ? `

Telegram Quick-Reply Buttons:
Du läufst in Telegram. Du kannst dem User interaktive Quick-Reply Buttons anbieten.

Format — am ENDE deiner Antwort (nach dem letzten Absatz):
[BUTTONS: Label 1 | Label 2 | Label 3]

Regeln:
- Nutze Buttons wenn du eine Frage stellst oder klare nächste Schritte anbietest
- Max 4 Buttons, Labels kurz halten (max 25 Zeichen pro Button)
- Emojis in Labels sind erlaubt und empfohlen (z.B. "✅ Ja, mach das" oder "📋 Plan zeigen")
- NICHT bei jeder Antwort — nur wenn es dem User wirklich hilft, schneller zu antworten
- Gute Beispiele: Ja/Nein-Entscheidungen, Optionsauswahl (A/B/C), nächste Schritte
- Schlechte Beispiele: offene kreative Fragen, Konversation die freie Antwort braucht
- Der [BUTTONS: ...] Block wird automatisch entfernt und als Telegram-Buttons angezeigt
- Schreibe den Block IMMER in eine eigene Zeile am Ende

WICHTIG für [BUTTONS: ...] Reihenfolge (Mai-Intervention 2026-05-11 RI-08):
- Falls du eine Reasoning Summary oder anderen Meta-Text hast: KOMMT VOR den Buttons
- [BUTTONS: ...] muss ABSOLUTE LETZTE ZEILE deiner Antwort sein
- KEIN Text NACH dem [BUTTONS: ...] Block — sonst rendert Telegram die Buttons nicht` : '';

const TASK_OWNERSHIP_INSTRUCTION = `

Multi-Task Ownership & Topic-Carryover:
The user runs Multi-Topic-Sessions (CV + roadmap + bugs + research at once). You are responsible for keeping the thread alive — the user should NOT have to re-remind you of open items.

Behavior rules (apply on EVERY response, not just long ones):

1. Topic-Switch detection:
   When the user switches topic without explicitly closing the previous one (e.g. they were asking about Topic A, now they ask about Topic B), START your response with one short meta-line:
   "Offen aus vorherigem Topic: [kurze Liste]. Neues Topic: [B]. Soll ich altes parken oder parallel halten?"
   Skip the meta-line ONLY when (a) the previous topic was clearly closed, (b) this is the first message of the session, or (c) the user explicitly said "vergiss das" / "neues Thema".

2. Open-Items footer:
   When the current session has unresolved items (questions you asked the user, decisions pending, background agents running), END your response with a compact footer:
   "Noch offen: 1) [item] 2) [item] 3) [item]"
   Max 5 items, max one line per item. If nothing is open, omit the footer entirely (no "nichts offen" filler).

3. Background-Agent transparency:
   When you dispatch a sub-agent or background task, ANNOUNCE it explicitly:
   "Ich starte X im Hintergrund — pinge dich wenn fertig."
   When it returns, surface the result with the original task referenced.

4. Closure-check before topic-switch by YOU:
   If you (the assistant) are about to switch the conversation focus, first ask:
   "Bevor wir weitergehen — soll ich zuerst [open item] erledigen, oder darf das warten?"

These rules exist because the user previously experienced topic-loss + forgotten questions across multi-topic sessions and lost trust in your task-tracking. Your job is to be the one keeping the thread, not the user.`;

/**
 * Hard-coded Bot-Glossar (Mai-Intervention 2026-05-11 Phase A.1, RI-11 fix).
 * Bridge-Cap-immune — wird in jeden System-Prompt prepended, kann nicht durch
 * NEXUS_BRIDGE_MAX_CHARS truncated werden. soul.md + wiki/00-bot-glossary werden
 * von Phase B als komplementäre Layer hinzukommen.
 */
const BOT_GLOSSARY_CONSTANT = `

WICHTIG — Bot-Glossar (Production-Truth, hard-coded):
- @AstronOneBot = Master Bot (Arashs Workspace, dieser hier)
- @AlinaCheckBot = Family Bot (für Alina, BOT_NAME=Alina-Check)
- @EffCheckBot = Mom Bot (für Effat, BOT_NAME=Mom-Check, FA+DE, weekly push)
- @ManZamOneBot = Dad Bot (BOT_NAME=Dad-Check)
Cross-Bot-Posting ist nicht implementiert. Bei "schick an Alina-Bot": ehrlich antworten dass dieser Mechanismus nicht existiert.`;

const BASE_SYSTEM_PROMPT = CORE_GUIDELINES + BOT_GLOSSARY_CONSTANT + (config.TELEGRAPH_ENABLED ? TELEGRAPH_FORMATTING : INLINE_FORMATTING) + FOLLOWUP_BUTTONS_INSTRUCTION + TASK_OWNERSHIP_INSTRUCTION;

const REDDIT_TOOL_PROMPT = `

Reddit Tool:
You have a nexusgram_fetch_reddit MCP tool that fetches Reddit content directly (subreddits, posts with comments, user profiles).
Use it when the user asks about Reddit content — no need to tell them to use a command.
The tool accepts a target (r/<subreddit>, u/<username>, post URL, post ID) and optional sort/time/limit/depth parameters.

Semantic mappings for natural language Reddit queries:
- "today" / "today's top" → sort: top, time_filter: day
- "newest" / "latest" / "recent" → sort: new
- "hottest" / "trending" / "what's hot" → sort: hot
- "top" / "best" → sort: top
- "this week" → sort: top, time_filter: week
- "this month" → sort: top, time_filter: month
- "rising" → sort: rising

The user also has a /reddit Telegram command for direct use.`;

const REDDIT_VIDEO_TOOL_PROMPT = `

Reddit Video Tool:
The user can download Reddit-hosted videos via the /vreddit Telegram command.
If the user wants a video file, tell them to use /vreddit with the post URL.
The nexusgram_fetch_reddit tool is for text/comments only, not media downloads.`;

const MEDIUM_TOOL_PROMPT = `

Medium Tool:
You have a nexusgram_fetch_medium MCP tool that fetches Medium articles (bypasses paywall via Freedium).
Use it when the user shares a Medium URL or asks to read an article — no need to tell them to use a command.
The user also has a /medium Telegram command for direct use.`;

const EXTRACT_TOOL_PROMPT = `

Media Extract Tool:
You have a nexusgram_extract_media MCP tool that extracts content from YouTube, Instagram, and TikTok URLs.
Use mode "text" to transcribe videos, "audio" for MP3, "video" for MP4, "all" for everything.
Audio/video files are sent directly to the user via Telegram as a side effect.
Use it when the user asks to transcribe, download, or extract media from a URL — no need to tell them to use a command.
For voice notes sent directly in chat, the user should use /transcribe instead.
The user also has an /extract Telegram command for direct use.`;

const REASONING_SUMMARY_INSTRUCTIONS = `

Reasoning Summary (required when enabled):
- At the end of each response, add a short section titled "Reasoning Summary".
- Provide 2–5 bullet points describing high-level actions/decisions taken.
- Do NOT reveal chain-of-thought, hidden reasoning, or sensitive tool outputs.
- Skip the summary for very short acknowledgements or pure error messages.`;

const TOOL_PROMPTS = [
  config.REDDIT_ENABLED ? REDDIT_TOOL_PROMPT : '',
  config.VREDDIT_ENABLED ? REDDIT_VIDEO_TOOL_PROMPT : '',
  config.MEDIUM_ENABLED ? MEDIUM_TOOL_PROMPT : '',
  config.EXTRACT_ENABLED ? EXTRACT_TOOL_PROMPT : '',
].join('');

const VOICE_MODE_PROMPT = `

Voice Mode Active — the user is speaking to you via voice message.
You are a digital employee on a phone call with your employer. Respond accordingly.

Rules for voice responses:
- Keep responses SHORT: 2-4 sentences for simple questions, max 1 short paragraph for complex ones
- Use natural, conversational language — as if speaking on a phone call
- NEVER use markdown formatting (no **, ##, \`code\`, lists, etc.) — your response will be read aloud via TTS
- NEVER include code blocks, tables, or bullet lists — describe things verbally instead
- Be direct and get to the point immediately
- Use natural transition words ("Also,", "Gut,", "Verstanden,", "So,", "Right,")
- If asked about code or files, summarize verbally. Offer to send details as a follow-up text message if needed
- Say numbers naturally: "about two hundred" not "~200", "three files" not "3 files"
- Match the user's language — if they speak German, respond in German. If English, respond in English
- Do NOT include a Reasoning Summary section
- Do NOT use emoji`;

const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}${TOOL_PROMPTS}${config.CLAUDE_REASONING_SUMMARY ? REASONING_SUMMARY_INSTRUCTIONS : ''}`;

/**
 * Extract [BUTTONS: opt1 | opt2 | opt3] from response text.
 * Returns cleaned text + button labels array.
 */
function extractButtons(text: string): { text: string; buttons: string[] } {
  const match = text.match(/\n*\[BUTTONS:\s*([^\]]+)\]\s*$/);
  if (!match) return { text, buttons: [] };

  const buttons = match[1]
    .split('|')
    .map(b => b.trim())
    .filter(Boolean)
    .slice(0, 4)  // max 4 buttons
    .map(b => b.length > 30 ? b.slice(0, 28) + '…' : b);  // truncate for Telegram

  if (buttons.length < 2) return { text, buttons: [] };  // need at least 2 options

  const cleanText = text.replace(/\n*\[BUTTONS:\s*[^\]]+\]\s*$/, '').trimEnd();
  return { text: cleanText, buttons };
}

/**
 * Strip the "Reasoning Summary" section from the end of a response
 * so it doesn't appear in Telegram chat (it's already in logs).
 */
function stripReasoningSummary(text: string): string {
  // Match a trailing reasoning summary block:
  //   ---\n**Reasoning Summary**\n... (to end)
  //   or: **Reasoning Summary**\n... (to end)
  //   or: *Reasoning Summary*\n... (to end)
  return text.replace(/\n*(?:---\n+)?(?:\*{1,2})Reasoning Summary(?:\*{1,2})\n[\s\S]*$/, '').trimEnd();
}

type LogLevel = 'off' | 'basic' | 'verbose' | 'trace';
const LOG_LEVELS: Record<LogLevel, number> = {
  off: 0,
  basic: 1,
  verbose: 2,
  trace: 3,
};

function getLogLevel(): LogLevel {
  return config.CLAUDE_SDK_LOG_LEVEL as LogLevel;
}

function logAt(level: LogLevel, message: string, data?: unknown): void {
  if (LOG_LEVELS[level] <= LOG_LEVELS[getLogLevel()]) {
    if (data !== undefined) {
      console.log(message, data);
    } else {
      console.log(message);
    }
  }
}

function getPermissionMode(command?: string): PermissionMode {
  // If DANGEROUS_MODE is enabled, bypass all permissions
  if (config.DANGEROUS_MODE) {
    return 'bypassPermissions';
  }

  // Otherwise, use command-specific modes
  if (command === 'plan') {
    return 'plan';
  }

  return 'acceptEdits';
}

/**
 * Log operations when DANGEROUS_MODE is enabled for security auditing.
 */
function logDangerousModeOperation(sessionKey: string, operation: string, details?: string): void {
  if (!config.DANGEROUS_MODE) return;
  const timestamp = new Date().toISOString();
  const detailStr = details ? ` — ${details}` : '';
  console.log(`[DANGEROUS_MODE] ${timestamp} session:${sessionKey} ${operation}${detailStr}`);
}

export async function sendToAgent(
  sessionKey: string,
  message: string,
  options: AgentOptions = {}
): Promise<AgentResponse> {
  const { onProgress, onToolStart, onToolEnd, abortController, command, model, voiceMode } = options;

  const session = sessionManager.getOrResumeSession(sessionKey);

  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }

  // If session was rotated (new day), clear stale in-memory Claude session ID
  if (!session.claudeSessionId && chatSessionIds.has(sessionKey)) {
    logAt('basic', `[SessionRotation] Clearing stale chatSessionId for ${sessionKey}`);
    chatSessionIds.delete(sessionKey);
  }

  sessionManager.updateActivity(sessionKey, message);

  // Get or initialize conversation history
  let history = conversationHistory.get(sessionKey) || [];

  // Determine the prompt based on command
  let prompt = message;
  if (command === 'explore') {
    prompt = `Explore the codebase and answer: ${message}`;
  }

  // Add user message to history and persist to transcript
  history.push({
    role: 'user',
    content: prompt,
  });
  recordTranscript(sessionKey, 'user', message);

  let fullText = '';
  const toolsUsed: string[] = [];
  let gotResult = false;
  let resultUsage: AgentUsage | undefined;
  let compactionEvent: { trigger: 'manual' | 'auto'; preTokens: number } | undefined;
  let initEvent: { model: string; sessionId: string } | undefined;

  // Determine permission mode
  const permissionMode = getPermissionMode(command);

  // Log in dangerous mode for security auditing
  logDangerousModeOperation(sessionKey, 'query', `prompt_length:${message.length} cwd:${session.workingDirectory}`);

  // Determine model to use (default to 'sonnet'; use /model opus for heavy tasks)
  const effectiveModel = model || chatModels.get(sessionKey) || 'sonnet';

  // Initialize timer for tracking query duration (watchdog created inside try with controller)
  const timer = createAgentTimer();
  let watchdog: AgentWatchdog | null = null;
  // One Telegram heartbeat per query — set once when watchdog warning first fires.
  let watchdogUserWarningSent = false;

  try {
    const controller = abortController || new AbortController();

    const existingSessionId = chatSessionIds.get(sessionKey) || session.claudeSessionId;

    // Log session resume if applicable
    if (existingSessionId) {
      if (!chatSessionIds.get(sessionKey)) {
        chatSessionIds.set(sessionKey, existingSessionId);
      }
      logAt('basic', `[Claude] Resuming session ${existingSessionId} for session ${sessionKey}`);
    }

    const toolsOption = config.DANGEROUS_MODE
      ? { type: 'preset' as const, preset: 'claude_code' as const }
      : config.BOT_TOOLS;

    const allowedToolsOption = config.DANGEROUS_MODE
      ? undefined
      : config.BOT_TOOLS;

    // PreCompact hook: log + flush conversation context to daily transcript
    const preCompactHook: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      PreCompact: [{
        hooks: [async (input) => {
          const trigger = (input as Record<string, unknown>).trigger;
          logAt('basic', '[Hook] PreCompact — context is about to be compacted', {
            trigger,
            customInstructions: (input as Record<string, unknown>).custom_instructions,
          });

          // Flush recent conversation context to daily transcript before compaction
          // This preserves what was discussed so the bot can recover context post-compaction
          try {
            const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
            const recentHistory = conversationHistory.get(sessionKey) || [];
            const lastMessages = recentHistory.slice(-6); // last 3 exchanges (user+assistant)

            let contextSummary = `**[COMPACTION]** ${timestamp} | trigger: ${trigger}\n`;
            contextSummary += `Kontext wird komprimiert. Letzte ${lastMessages.length} Nachrichten gesichert:\n\n`;

            for (const msg of lastMessages) {
              const preview = msg.content.slice(0, 300);
              const truncated = msg.content.length > 300 ? '…' : '';
              contextSummary += `> **${msg.role}:** ${preview}${truncated}\n`;
            }

            recordTranscript(sessionKey, 'assistant', contextSummary);

            // Semantic synthesis (3-5 sentences, no AI call, decay=0 = stays forever)
            // Replaces 50-char episodic snippets with rich searchable memory
            const userMsgs = lastMessages.filter(m => m.role === 'user');
            const assistantMsgs = lastMessages.filter(m => m.role === 'assistant');

            if (userMsgs.length > 0) {
              const topics = userMsgs
                .map(m => m.content.slice(0, 120).replace(/\n/g, ' ').trim())
                .join(' | ');
              const assistantPreview = assistantMsgs.length > 0
                ? assistantMsgs[assistantMsgs.length - 1].content.slice(0, 200).replace(/\n/g, ' ').trim()
                : '';

              const synthesis = [
                `[NexusGram PreCompact] ${timestamp}`,
                `Topics: ${topics}`,
                assistantPreview ? `Claude antwortete: ${assistantPreview}` : '',
              ].filter(Boolean).join(' — ');

              saveMemory(
                synthesis,
                'semantic',
                config.BOT_MEMORY_PROJECT || 'nexus',
                'precompact,telegram',
                'nexusgram',
                isPrivate(sessionKey) ? 'private' : 'public',
              );
            }
          } catch {
            // Must never crash the bot
          }

          return { continue: true };
        }],
      }],
    };

    // SDK hook logging: only register the noisy hooks (PreToolUse, PostToolUse, etc.)
    // when LOG_AGENT_HOOKS is true. Session lifecycle hooks are always registered.
    const verboseHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = config.LOG_AGENT_HOOKS
      ? {
        PreToolUse: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PreToolUse', input);
            return { continue: true };
          }],
        }],
        PostToolUse: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PostToolUse', input);
            return { continue: true };
          }],
        }],
        PostToolUseFailure: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PostToolUseFailure', input);
            return { continue: true };
          }],
        }],
        PermissionRequest: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PermissionRequest', input);
            return { continue: true };
          }],
        }],
        Notification: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] Notification', input);
            return { continue: true };
          }],
        }],
      }
      : {};

    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined =
      LOG_LEVELS[getLogLevel()] >= LOG_LEVELS.verbose
        ? {
          ...preCompactHook,
          ...verboseHooks,
          SessionStart: [{
            hooks: [async (input) => {
              logAt('basic', '[Hook] SessionStart', input);
              return { continue: true };
            }],
          }],
          SessionEnd: [{
            hooks: [async (input) => {
              logAt('basic', '[Hook] SessionEnd', input);
              return { continue: true };
            }],
          }],
        }
        : preCompactHook;

    // Validate cwd exists — stale sessions may reference paths from another OS
    let cwd = session.workingDirectory;
    try {
      if (!fs.existsSync(cwd)) {
        const fallback = process.env.HOME || process.cwd();
        console.warn(`[Claude] Working directory does not exist: ${cwd}, falling back to ${fallback}`);
        cwd = fallback;
      }
    } catch {
      cwd = process.env.HOME || process.cwd();
    }

    // Create MCP server for Nexusgram tools (if telegramCtx is available)
    const mcpServers: Record<string, McpServerConfig> = {};
    if (options.telegramCtx) {
      const server = createNexusgramMcpServer({
        telegramCtx: options.telegramCtx,
        sessionKey,
      });
      mcpServers['nexusgram-tools'] = server;
    }

    const nexusBridgePrompt = buildNexusBridgePrompt(cwd);
    const sessionIsPrivate = isPrivate(sessionKey);
    // In private mode we still allow the bot to see private memories the user
    // has stored in this same session, but we exclude them from retrieval when
    // the session is public. The tone-neutralizer below further prevents leakage.
    const memoryContext = injectContext(prompt, config.BOT_MEMORY_PROJECT, sessionIsPrivate);
    // Load previous day's transcript for context continuity (only on fresh sessions)
    const previousDayContext = existingSessionId ? '' : loadPreviousDayTranscript(sessionKey);
    // Load today's transcript for context recovery after a bot restart.
    // Gives the bot visibility into what was already discussed today in this Telegram chat.
    const todayContext = existingSessionId ? '' : loadTodayTranscript(sessionKey);
    // Recent image uploads — survives compaction so the bot can recover paths.
    const recentUploadsContext = buildRecentUploadsContext(cwd);

    const queryOptions: Parameters<typeof query>[0]['options'] = {
      cwd,
      tools: toolsOption,
      ...(allowedToolsOption ? { allowedTools: allowedToolsOption } : {}),
      permissionMode,
      abortController: controller,
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: `${voiceMode ? `${SYSTEM_PROMPT}${VOICE_MODE_PROMPT}` : SYSTEM_PROMPT}${memoryContext}${nexusBridgePrompt}${todayContext}${previousDayContext}${recentUploadsContext}${sessionIsPrivate ? PRIVACY_MODE_PROMPT : ''}`,
      },
      settingSources: ['project', 'user'] as SettingSource[],
      model: effectiveModel,
      resume: existingSessionId,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(config.CLAUDE_USE_BUNDLED_EXECUTABLE ? {} : { pathToClaudeCodeExecutable: config.CLAUDE_EXECUTABLE_PATH }),
      includePartialMessages: config.CLAUDE_SDK_INCLUDE_PARTIAL || getLogLevel() === 'trace',
      hooks,
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      stderr: (data: string) => {
        console.error('[Claude stderr]:', data);
      },
    };

    const response = query({
      prompt,
      options: queryOptions,
    });

    // Store the Query object so /cancel can call interrupt()
    setActiveQuery(sessionKey, response);

    // Initialize watchdog for long-running query monitoring.
    //
    // Stage 2b Action 7 (deferred to Phase D): full RequestContext-aware
    // watchdog. The watchdog currently runs as its own state machine and does
    // not read the per-request RequestContext registry. Codex Pattern-B review
    // flagged this as "V2.5-3 not yet enforced in code". Deferred because:
    //   (a) the RequestContext hard-cap timer already enforces the per-request
    //       timeout from the handler side — the watchdog is a defense-in-depth
    //       SDK-stuck detector, NOT the primary user-facing timeout;
    //   (b) coupling watchdog to registry creates a third place that can call
    //       finalize/cancel — risk of triple-finalize in pathological cases;
    //   (c) Phase D will redesign the watchdog as part of worker-process
    //       isolation (Cluster F / Codex 2nd Review V2.4), making this hook
    //       a transitional step that adds complexity for short-term gain.
    //
    // Tracked in: shared-memory/nexus/phase_c_stage2b_hotfix_report_2026-05-12.md (item 7).
    watchdog = config.AGENT_WATCHDOG_ENABLED
      ? new AgentWatchdog({
          chatId: sessionKey,
          warnAfterSeconds: config.AGENT_WATCHDOG_WARN_SECONDS,
          logIntervalSeconds: config.AGENT_WATCHDOG_LOG_SECONDS,
          timeoutMs: config.AGENT_QUERY_TIMEOUT_MS > 0 ? config.AGENT_QUERY_TIMEOUT_MS : undefined,
          onWarning: (sinceMsg, total) => {
            logAt('basic', `[Claude] WATCHDOG: No messages for ${formatDuration(sinceMsg)} (total: ${formatDuration(total)}), session:${sessionKey}`);
            if (
              !watchdogUserWarningSent &&
              config.AGENT_WATCHDOG_USER_NOTIFY &&
              options.telegramCtx
            ) {
              watchdogUserWarningSent = true;
              const ctx = options.telegramCtx;
              const chatId = ctx.chat?.id;
              const threadId = ctx.message?.message_thread_id;
              if (chatId !== undefined) {
                const sendOpts = threadId !== undefined
                  ? { message_thread_id: threadId }
                  : {};
                ctx.api
                  .sendMessage(chatId, config.AGENT_WATCHDOG_USER_NOTIFY_MESSAGE, sendOpts)
                  .catch((err: unknown) => {
                    logAt(
                      'basic',
                      `[Watchdog] Failed to notify user via Telegram: ${err instanceof Error ? err.message : String(err)}`
                    );
                  });
              }
            }
          },
          onTimeout: () => {
            logAt('basic', `[Claude] WATCHDOG: Query timeout reached, clearing stale session and gracefulCancel: ${sessionKey}`);
            chatSessionIds.delete(sessionKey);
            const staleSession = sessionManager.getSession(sessionKey);
            if (staleSession) {
              staleSession.claudeSessionId = undefined;
            }
            // Mai-Intervention 2026-05-11 Phase B.6: route through gracefulCancel
            // (prefers Query.interrupt, falls back to controller.abort with crash-risk marker)
            gracefulCancel(sessionKey, 'watchdog-timeout').catch(err => {
              console.debug('[Watchdog] gracefulCancel threw', err);
            });
          },
        })
      : null;
    watchdog?.start();

    // Process response messages
    for await (const responseMessage of response) {
      // Record activity for watchdog
      recordMessage(timer);
      watchdog?.recordActivity(responseMessage.type);

      // Check for abort
      if (controller.signal.aborted) {
        watchdog?.stop();
        fullText = '🛑 Request cancelled.';
        break;
      }

      logAt('trace', `[Claude] [${formatDuration(getElapsedMs(timer))}] Message: ${responseMessage.type}`);

      if (responseMessage.type === 'assistant') {
        logAt('verbose', '[Claude] Assistant content blocks:', responseMessage.message.content.length);
        for (const block of responseMessage.message.content) {
          logAt('trace', '[Claude] Block type:', block.type);
          if (block.type === 'text') {
            fullText += block.text;
            onProgress?.(fullText);
          } else if (block.type === 'tool_use') {
            const toolInput = 'input' in block ? block.input as Record<string, unknown> : {};
            const inputSummary = toolInput.command
              ? String(toolInput.command).substring(0, 150)
              : toolInput.pattern
                ? String(toolInput.pattern)
                : toolInput.file_path
                  ? String(toolInput.file_path)
                  : '';
            logAt('verbose', `[Claude] [${formatDuration(getElapsedMs(timer))}] Tool: ${block.name}${inputSummary ? ` → ${inputSummary}` : ''}`);
            toolsUsed.push(block.name);
            // Special logging for Task tool (subagents) - always log at basic level
            if (block.name === 'Task') {
              const taskDesc = toolInput.description || toolInput.prompt || 'unnamed task';
              const subagentType = toolInput.subagent_type || 'unknown';
              logAt('basic', `[Claude] SUBAGENT START: ${subagentType} — ${String(taskDesc).substring(0, 100)}`);
            }
            // Notify tool start for terminal UI
            onToolStart?.(block.name, toolInput);
            // Mai-Intervention Phase B.7: register tool with watchdog so it relaxes
            // its warn threshold while the tool runs. block.id is the SDK tool_use_id.
            const toolUseId = 'id' in block && typeof block.id === 'string' ? block.id : '';
            watchdog?.recordToolStart(toolUseId, block.name);
          }
        }
      } else if (responseMessage.type === 'system') {
        if (responseMessage.subtype === 'compact_boundary') {
          const cbMsg = responseMessage as SDKCompactBoundaryMessage;
          compactionEvent = {
            trigger: cbMsg.compact_metadata.trigger,
            preTokens: cbMsg.compact_metadata.pre_tokens,
          };
          logAt('basic', `[Claude] COMPACTION: trigger=${cbMsg.compact_metadata.trigger}, pre_tokens=${cbMsg.compact_metadata.pre_tokens}`);
        } else if (responseMessage.subtype === 'init') {
          const sysMsg = responseMessage as SDKSystemMessage;
          initEvent = {
            model: sysMsg.model,
            sessionId: sysMsg.session_id,
          };
          logAt('basic', `[Claude] SESSION INIT: model=${sysMsg.model}, session=${sysMsg.session_id}`);
        } else if (responseMessage.subtype === 'status') {
          const statusMsg = responseMessage as SDKStatusMessage;
          if (statusMsg.status === 'compacting') {
            logAt('basic', '[Claude] STATUS: compacting in progress');
          }
        } else {
          logAt('verbose', `[Claude] System: ${responseMessage.subtype ?? 'unknown'}`, responseMessage);
        }
      } else if (responseMessage.type === 'tool_progress') {
        logAt('verbose', `[Claude] Tool progress: ${responseMessage.tool_name}`, responseMessage);
        // Mai-Intervention Phase B.7: heartbeat — refresh watchdog activity
        watchdog?.recordToolProgress();
      } else if (responseMessage.type === 'tool_use_summary') {
        logAt('verbose', '[Claude] Tool use summary', responseMessage);
        // Notify tool end for terminal UI (summary may not include matchable name)
        onToolEnd?.();
        // Mai-Intervention Phase B.7: drop tool from watchdog active-map.
        // tool_use_id is best-effort — if missing, watchdog drops oldest entry.
        const summaryId = 'tool_use_id' in responseMessage && typeof (responseMessage as { tool_use_id?: unknown }).tool_use_id === 'string'
          ? (responseMessage as { tool_use_id: string }).tool_use_id
          : undefined;
        watchdog?.recordToolEnd(summaryId);
      } else if (responseMessage.type === 'auth_status') {
        logAt('basic', '[Claude] Auth status', responseMessage);
      } else if (responseMessage.type === 'stream_event') {
        logAt('trace', '[Claude] Stream event', responseMessage.event);
      } else if (responseMessage.type === 'result') {
        // Mai-Intervention Phase B.7: any result (success or error) ends the run.
        // Clear active-tools BEFORE stop() so error_during_execution does not leave
        // ghost entries that would affect later sessions if the watchdog instance
        // were ever reused.
        if (responseMessage.subtype === 'error_during_execution') {
          watchdog?.clearActiveTools('result-error_during_execution');
        } else {
          watchdog?.clearActiveTools('result-' + (responseMessage.subtype ?? 'unknown'));
        }
        watchdog?.stop();
        logAt('basic', `[Claude] Query completed: ${getTimingReport(timer)}`);
        logAt('verbose', '[Claude] Result:', JSON.stringify(responseMessage, null, 2).substring(0, 500));
        gotResult = true;

        // Extract usage data from result
        const resultMsg = responseMessage as SDKResultMessage;
        if (resultMsg.modelUsage) {
          const modelKey = Object.keys(resultMsg.modelUsage)[0];
          if (modelKey && resultMsg.modelUsage[modelKey]) {
            const mu = resultMsg.modelUsage[modelKey];
            resultUsage = {
              inputTokens: mu.inputTokens,
              outputTokens: mu.outputTokens,
              cacheReadTokens: mu.cacheReadInputTokens,
              cacheWriteTokens: mu.cacheCreationInputTokens,
              totalCostUsd: resultMsg.total_cost_usd,
              contextWindow: mu.contextWindow,
              numTurns: resultMsg.num_turns,
              model: modelKey,
            };
          }
        }

        if (responseMessage.subtype === 'success') {
          // Only store session_id on successful results (not on error_during_execution)
          if ('session_id' in responseMessage && responseMessage.session_id) {
            chatSessionIds.set(sessionKey, responseMessage.session_id);
            sessionManager.setClaudeSessionId(sessionKey, responseMessage.session_id);
            logAt('basic', `[Claude] Stored session ${responseMessage.session_id} for session ${sessionKey}`);
          }

          // Append final result text if different from accumulated
          if (responseMessage.result && !fullText.includes(responseMessage.result)) {
            if (fullText.length > 0) {
              fullText += '\n\n';
            }
            fullText += responseMessage.result;
            onProgress?.(fullText);
          }
        } else if (responseMessage.subtype === 'error_during_execution' && isCancelled(sessionKey)) {
          // Interrupted via /cancel - show clean cancellation message.
          // Telegram-side handler detects this exact text (CLAUDE_CANCEL_SENTINEL_TEXT)
          // to route the response through the cancel UI branch instead of finishStreaming.
          fullText = CLAUDE_CANCEL_SENTINEL_TEXT;
          onProgress?.(fullText);
        } else {
          // error_max_turns or unexpected error_during_execution
          // Clear stale session ID so next attempt starts fresh
          chatSessionIds.delete(sessionKey);
          const session = sessionManager.getSession(sessionKey);
          if (session) {
            session.claudeSessionId = undefined;
          }
          logAt('basic', `[Claude] Cleared stale session for session ${sessionKey} due to ${responseMessage.subtype}`);

          fullText = `Error: ${responseMessage.subtype}`;
          onProgress?.(fullText);
        }
      }
    }
  } catch (error) {
    watchdog?.stop();
    // If cancelled via /cancel or /reset, return clean message (Telegram-side
    // handler detects CLAUDE_CANCEL_SENTINEL_TEXT and routes to cancel UI).
    if (isCancelled(sessionKey) || abortController?.signal.aborted) {
      return {
        text: CLAUDE_CANCEL_SENTINEL_TEXT,
        toolsUsed,
      };
    }

    // If we got a result, ignore process exit errors (SDK quirk)
    if (gotResult && error instanceof Error && error.message.includes('exited with code')) {
      console.log('[Claude] Ignoring exit code error after successful result');
    } else {
      console.error('[Claude] Full error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Claude error: ${errorMessage}`);
    }
  } finally {
    watchdog?.stop();
    clearActiveQuery(sessionKey);
  }

  // Add assistant response to history and persist to transcript
  if (fullText && !abortController?.signal.aborted) {
    history.push({
      role: 'assistant',
      content: fullText,
    });
    recordTranscript(sessionKey, 'assistant', fullText);

    // Log conversation turn to daily file for nightly Ollama synthesis → L2 Memory.
    // In private mode the turn is split into a *.private.log file which the
    // synthesizer never consumes (see maintenance.sh glob pattern).
    logConversationTurn(
      config.BOT_NAME,
      prompt,
      fullText,
      isPrivate(sessionKey) ? 'private' : 'public',
    );
  }

  // T5: Trim in-memory conversation history to prevent unbounded RAM growth.
  // PreCompact hook only needs the last few messages; no functional impact.
  const MAX_CONVERSATION_HISTORY = 50; // ~25 user+assistant exchanges
  if (history.length > MAX_CONVERSATION_HISTORY) {
    history = history.slice(-MAX_CONVERSATION_HISTORY);
  }
  conversationHistory.set(sessionKey, history);

  // Cache usage for /context and /status commands
  if (resultUsage) {
    chatUsageCache.set(sessionKey, resultUsage);
  }

  const extracted = extractButtons(fullText);
  return {
    text: stripReasoningSummary(extracted.text) || 'No response from Claude.',
    toolsUsed,
    buttons: extracted.buttons.length > 0 ? extracted.buttons : undefined,
    usage: resultUsage,
    compaction: compactionEvent,
    sessionInit: initEvent,
  };
}

export async function sendLoopToAgent(
  sessionKey: string,
  message: string,
  options: LoopOptions = {}
): Promise<AgentResponse> {
  const {
    onProgress,
    abortController,
    maxIterations = config.MAX_LOOP_ITERATIONS,
    onIterationComplete,
  } = options;

  const session = sessionManager.getOrResumeSession(sessionKey);

  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }

  // If session was rotated (new day), clear stale in-memory Claude session ID
  if (!session.claudeSessionId && chatSessionIds.has(sessionKey)) {
    logAt('basic', `[SessionRotation] Clearing stale chatSessionId for ${sessionKey}`);
    chatSessionIds.delete(sessionKey);
  }

  // Wrap the prompt with loop instructions
  const loopPrompt = `${message}

IMPORTANT: When you have fully completed this task, respond with the word "DONE" on its own line at the end of your response. If you need to continue working, do not say "DONE".`;

  let iteration = 0;
  let combinedText = '';
  const allToolsUsed: string[] = [];
  let isComplete = false;

  while (iteration < maxIterations && !isComplete) {
    iteration++;

    // Check for abort
    if (abortController?.signal.aborted) {
      return {
        text: '🛑 Loop cancelled.',
        toolsUsed: allToolsUsed,
      };
    }

    const iterationPrefix = `\n\n--- Iteration ${iteration}/${maxIterations} ---\n\n`;
    combinedText += iterationPrefix;
    onProgress?.(combinedText);

    // For subsequent iterations, prompt Claude to continue
    const currentPrompt = iteration === 1 ? loopPrompt : 'Continue the task. Say "DONE" when complete.';

    try {
      const response = await sendToAgent(sessionKey, currentPrompt, {
        onProgress: (text) => {
          onProgress?.(combinedText + text);
        },
        abortController,
        model: options.model,
        telegramCtx: options.telegramCtx,
      });

      combinedText += response.text;
      allToolsUsed.push(...response.toolsUsed);

      onIterationComplete?.(iteration, response.text);

      // Check if Claude said DONE
      if (response.text.includes('DONE')) {
        isComplete = true;
        combinedText += '\n\n✅ Loop completed.';
      } else if (iteration >= maxIterations) {
        combinedText += `\n\n⚠️ Max iterations (${maxIterations}) reached.`;
      }

      onProgress?.(combinedText);
    } catch (error) {
      if (abortController?.signal.aborted) {
        return {
          text: combinedText + '\n\n🛑 Loop cancelled.',
          toolsUsed: allToolsUsed,
        };
      }
      throw error;
    }
  }

  const loopExtracted = extractButtons(combinedText);
  return {
    text: stripReasoningSummary(loopExtracted.text),
    toolsUsed: allToolsUsed,
    buttons: loopExtracted.buttons.length > 0 ? loopExtracted.buttons : undefined,
  };
}

export function clearConversation(sessionKey: string): void {
  conversationHistory.delete(sessionKey);
  chatSessionIds.delete(sessionKey);
  chatUsageCache.delete(sessionKey);
}

export function setModel(sessionKey: string, model: string): void {
  chatModels.set(sessionKey, model);
}

export function getModel(sessionKey: string): string {
  return chatModels.get(sessionKey) || 'opus';
}

export function clearModel(sessionKey: string): void {
  chatModels.delete(sessionKey);
}

export function isDangerousMode(): boolean {
  return config.DANGEROUS_MODE;
}
