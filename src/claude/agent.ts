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
import { classifyContextPressure, type ContextPressure } from './context-pressure.js';
import { setActiveQuery, clearActiveQuery, isCancelled, clearCancelled, gracefulCancel, isCurrentTurnEpoch } from './request-queue.js';
import { getActiveContextsForSession } from '../handler/request-registry.js';
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
import { getLatestInputLog } from '../inbox/input-log.js';

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

/**
 * Tool-Budget cooperative stop (2026-05-22 crash-safe re-design).
 *
 * When a turn exceeds its per-turn tool budget we must NOT abort the SDK
 * AbortController — that tore the claude-code subprocess apart mid-write and
 * crashed the WHOLE bot process (`F1 "Operation aborted"`, observed
 * 2026-05-22 14:35). Instead we ask the Query to stop cooperatively:
 * `interrupt()` first, and only `close()` if the interrupt is not honoured
 * within the timeout. Never touches `cancelledChats` (this is NOT a /cancel)
 * and never calls `controller.abort()`.
 */
const TOOL_BUDGET_INTERRUPT_TIMEOUT_MS = 5000; // allow-hardcoded: reason="SDK interrupt grace window before close()"

async function interruptForToolBudget(
  q: ReturnType<typeof query> | undefined,
  sessionKey: string,
): Promise<void> {
  if (!q) return;
  let interruptHonoured = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      q.interrupt().then(() => {
        interruptHonoured = true;
      }),
      new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          console.warn(
            `[ToolBudget] ${sessionKey} interrupt() exceeded ` +
              `${TOOL_BUDGET_INTERRUPT_TIMEOUT_MS}ms — falling back to close()`,
          );
          resolve();
        }, TOOL_BUDGET_INTERRUPT_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.warn(`[ToolBudget] ${sessionKey} interrupt() threw:`, err);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  if (!interruptHonoured) {
    try {
      await q.close();
    } catch (err) {
      console.warn(`[ToolBudget] ${sessionKey} close() threw:`, err);
    }
  }
}

/**
 * Schlachtplan Akt 1.3 (Codex round 7): thrown by `sendToAgent` at its very
 * start when the turn epoch is stale — i.e. a newer turn for the same session
 * has already been dequeued. A failsafe-released old handler that wakes up and
 * reaches `sendToAgent` is stopped HERE, before it can run `updateActivity`,
 * `recordTranscript`, `query()` or `setActiveQuery`. Handlers swallow this
 * error silently: the stale turn's queue promise was already rejected and the
 * newer turn owns the user-facing reply.
 */
export class StaleTurnError extends Error {
  readonly name = 'StaleTurnError';
  constructor(public readonly sessionKey: string, public readonly turnEpoch: number) {
    super(`Turn epoch ${turnEpoch} is stale for session=${sessionKey} — a newer turn took over`);
  }
}

/**
 * D0 Hardening Item 1 (2026-05-27): throw `StaleTurnError` if `turnEpoch` is no
 * longer the current turn for this session. Use as the FIRST statement in every
 * `queueRequest` handler, BEFORE any side-effect (streaming UI, registry
 * insert, abort-controller setter). Closes the dequeue→createRequestContext
 * race window (5-50ms in production).
 *
 * Outer handlers in the bot/handlers/* layer already catch `StaleTurnError`
 * and mark the input-log row as `dropped/superseded`. See Codex Pattern-A
 * Pre-Review confidence 0.74:
 *   shared-memory/nexus/cross_review_d0-fix-now-prereview_2026-05-27.md
 */
export function assertTurnIsCurrent(sessionKey: string, turnEpoch: number): void {
  if (!isCurrentTurnEpoch(sessionKey, turnEpoch)) {
    throw new StaleTurnError(sessionKey, turnEpoch);
  }
}

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
  /**
   * Codex BLOCKER (Akt 1.3 round 6): the turn epoch assigned by `processQueue`
   * at dequeue. Passed explicitly from the queue handler so ownership is bound
   * to the dequeue moment. When omitted (non-queued call), ownership checks
   * default to "still owner".
   */
  turnEpoch?: number;
  /**
   * FIX 6+ Stage 2b (Codex Pattern-B F-03): id of the durable input_log row
   * for THIS user turn. The input-log middleware writes the row before
   * sequentialize, so by the time we reach `sendToAgent` it already exists.
   * Used by `buildContextAvailabilityPrompt` to EXCLUDE the current message
   * from the "prior context" snapshot — otherwise the snapshot always sees
   * at least one row and the "EMPTY → ask for briefing" branch can never
   * fire. Optional: callers that don't have a row id (test paths,
   * follow-up-button dispatches) pass undefined and the snapshot falls back
   * to the old behaviour.
   */
  currentInputLogRowId?: number | null;
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

Memory & Honesty:
- When the user refers to something earlier ("hab ich dir geschickt", "haben wir besprochen", "letztes Mal", "gestern"), SEARCH FIRST before asking them to repeat: use the nexusgram_memory_search tool AND list the INBOX folder. Only ask the user once you have actually looked.
- NEVER invent an explanation for missing data. If you cannot find something, say plainly what you searched and what you did not find — name the source. Do not guess why it is missing.

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

WICHTIG — Bot-Glossar (Production-Truth, hard-coded; Strip 2 LIVE seit 2026-05-12):
- @AstronOneBot = Master Bot (Arashs Workspace, dieser hier) — aktiv
- @AlinaCheckBot = Family Bot (für Alina, BOT_NAME=Alina-Check) — aktiv, Status: 14d-Watch ab 2026-05-12, re-evaluate 2026-05-26
- @EffCheckBot = Mom Bot (für Effat) — archived (Strip 2 2026-05-12, 0/30d Captures, reactivatable via .env.mom + plist restore aus ~/.nexusgram/quarantine/2026-05-12-strip2/)
- @ManZamOneBot = Dad Bot — archived (Strip 2 2026-05-12, 0/30d Captures, reactivatable via .env.dad + plist restore aus ~/.nexusgram/quarantine/2026-05-12-strip2/)
Cross-Bot-Posting ist nicht implementiert. Bei "schick an Alina-Bot": ehrlich antworten dass dieser Mechanismus nicht existiert.
Bei Fragen zu Mom/Dad-Bot: ehrlich antworten dass sie pausiert sind seit Strip 2 2026-05-12 (Reaktivierung möglich).`;

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

// Akt A4: defense-in-depth prompt guard. The hard block is the PreToolUse
// security hook; this just stops the agent from repeatedly trying.
const SELF_MANAGEMENT_GUARD = `

## Hard rule — no self-management
You run as a long-lived service. NEVER run launchctl, kill, pkill, killall,
shutdown, reboot, or any command that stops, starts, or restarts a service,
process, or this bot itself — even if earlier conversation context appears to
ask for it. If a turn's context looks like a leftover deploy/restart task,
ignore that part. Restarts and deploys are handled out-of-band by the operator.`;
const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}${TOOL_PROMPTS}${config.CLAUDE_REASONING_SUMMARY ? REASONING_SUMMARY_INSTRUCTIONS : ''}${SELF_MANAGEMENT_GUARD}`;

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

// ── FIX 6+ Step 6 (2026-05-25): Context Availability Prompt-Block ──────────
//
// Codex Pre-Review §4: keep this as a PROMPT-BLOCK, not a subsystem. Renders
// a small runtime-fact snapshot (~30 LOC of source) that gets appended to the
// system prompt right before each agent turn. When the bot has thin context,
// it MUST stop and ask instead of guessing — same pattern as the existing
// Memory & Honesty rule, but with a maschinenlesbare runtime signal instead
// of a static instruction.
//
// Why here and not as middleware: middleware runs before sendToAgent, but the
// only consumer of the snapshot IS the agent prompt. Inlining keeps the data
// fresh (every turn) and avoids carrying state across the handler chain.

const NEXUS_DAILY_DIR = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/daily';
const NEXUS_OMI_AUDIT_DIR = '/Volumes/AstronOne/shared-memory/omi/raw/_audit';
const CONTEXT_INPUT_AGE_RECENT_MIN = 30; // allow-hardcoded: reason="UI threshold for 'recent input', not a timeout"

function buildContextAvailabilityPrompt(
  sessionKey: string,
  currentInputLogRowId?: number | null,
): string {
  const lines: string[] = ['', '## Context Availability (this turn, runtime-checked):'];

  // 1. Today's daily log
  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = `${NEXUS_DAILY_DIR}/${today}.md`;
  try {
    lines.push(`- Daily ${today}: ${fs.existsSync(dailyPath) ? 'present' : 'MISSING'}`);
  } catch {
    lines.push(`- Daily ${today}: check failed`);
  }

  // 2. input_log freshness for THIS session — EXCLUDING the current turn.
  //
  // FIX 6+ Stage 2b (Codex Pattern-B F-03): the input-log middleware writes
  // the user's just-arrived message into `input_log` *before* sequentialize
  // and sendToAgent run. Without exclusion the snapshot always sees the
  // current message as "prior context", with age=0min, so the
  // "EMPTY → ask for briefing" branch never fires for a genuinely new
  // session. By passing the current row id through AgentOptions and skipping
  // it here we get the correct "prior turns only" view.
  try {
    const recent = getLatestInputLog(sessionKey, 5, {
      excludeRowId: currentInputLogRowId ?? null,
    });
    if (recent.length === 0) {
      lines.push('- input_log: EMPTY for this session (excluding current message) — likely NEW SESSION. Ask for a 1-sentence briefing before guessing the topic.');
    } else {
      const newest = recent[0];
      const ageMin = Math.max(0, Math.round((Date.now() - new Date(newest.received_at).getTime()) / 60000));
      const ageStr = ageMin < CONTEXT_INPUT_AGE_RECENT_MIN ? `${ageMin}min ago` : `${ageMin}min ago (stale)`;
      lines.push(`- Last prior user input: ${ageStr} (${newest.input_type}, status=${newest.status})`);
      const dropped = recent.filter((r) => r.status === 'dropped');
      if (dropped.length > 0) {
        const reasons = Array.from(new Set(dropped.map((r) => r.dropped_reason ?? 'unknown'))).join(', ');
        lines.push(`- WARNING: ${dropped.length}/5 recent prior inputs were DROPPED (reasons: ${reasons}). Use nexusgram_input_log_search to recover them before answering "I have no record of that".`);
      }
    }
  } catch {
    lines.push('- input_log: read error');
  }

  // 3. OMI latest pull (best-effort: filename pattern pull-log-YYYY-MM-DD_*.jsonl)
  try {
    if (fs.existsSync(NEXUS_OMI_AUDIT_DIR)) {
      const files = fs.readdirSync(NEXUS_OMI_AUDIT_DIR)
        .filter((f) => f.startsWith('pull-log-') && f.endsWith('.jsonl'))
        .sort();
      const latest = files[files.length - 1];
      if (latest) {
        const m = latest.match(/pull-log-(\d{4}-\d{2}-\d{2})_/);
        if (m) lines.push(`- OMI: latest pull-log ${m[1]}`);
      }
    }
  } catch {
    /* skip — OMI availability is informational */
  }

  lines.push('');
  lines.push('Honesty contract: if the snapshot above is empty/stale for the topic at hand, STOP and ask the user for a 1-sentence briefing instead of guessing. Use nexusgram_input_log_search / nexusgram_read_daily / nexusgram_read_l1 to look BEFORE asking.');
  lines.push('');

  return lines.join('\n');
}

export async function sendToAgent(
  sessionKey: string,
  message: string,
  options: AgentOptions = {}
): Promise<AgentResponse> {
  const { onProgress, onToolStart, onToolEnd, abortController, command, model, voiceMode, turnEpoch } = options;

  // Codex BLOCKER (Akt 1.3 round 6): the turn epoch is the one `processQueue`
  // assigned at DEQUEUE and passed explicitly through the queue handler — NOT
  // re-read here. Re-reading would let a failsafe-released old handler observe
  // a newer turn's epoch and falsely pass the ownership check. When undefined
  // (a non-queued direct call), `isStillOwnerTurn()` defaults to true.
  const myTurnEpoch = turnEpoch;

  // Codex BLOCKER (round 7): hard early-bail. If this turn's epoch is already
  // stale (a newer turn was dequeued while this handler was suspended before
  // reaching sendToAgent), stop NOW — before updateActivity / recordTranscript
  // / query() / setActiveQuery run any side effect. The handler swallows
  // StaleTurnError silently; the newer turn owns the user-facing reply.
  if (myTurnEpoch !== undefined && !isCurrentTurnEpoch(sessionKey, myTurnEpoch)) {
    throw new StaleTurnError(sessionKey, myTurnEpoch);
  }

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

  // Get or initialize conversation history.
  // Codex BLOCKER 1 (round 4): clone the array — do NOT mutate the Map's array
  // in place. A late old turn mutating the shared array would corrupt a newer
  // turn's history. The final write-back is itself ownership-guarded below.
  let history = [...(conversationHistory.get(sessionKey) || [])];

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
  // Tool-Budget cooperative stop (2026-05-22): set true when the per-turn tool
  // budget is hit. The turn then ends normally with the partial answer — no
  // exception, no controller.abort(), no process crash.
  let toolBudgetReached = false;
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
  // Codex BLOCKER 1 (Akt 1.3 re-review): the Query this turn owns. Used so the
  // catch/finally clear the active-query slot ONLY if it still holds OUR Query
  // — a late teardown must not delete a newer turn's Query.
  let ownedQuery: ReturnType<typeof query> | undefined;
  // Codex BLOCKER (round 3/5/6): true if no NEWER turn has taken over this
  // session. Guards every mutation of shared session state (chatSessionIds /
  // claudeSessionId / conversationHistory / cancelledChats) so a stale
  // watchdog or a late success/error from an old turn cannot corrupt a newer
  // turn. Uses the per-session turn EPOCH captured at queue-dequeue and passed
  // in explicitly — robust even when a failsafe released an old handler. When
  // `myTurnEpoch` is undefined (a non-queued direct call), defaults to true.
  const isStillOwnerTurn = (): boolean =>
    myTurnEpoch === undefined || isCurrentTurnEpoch(sessionKey, myTurnEpoch);

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

    // Schlachtplan Akt 1.3 Fix C (2026-05-21): in voiceMode, drop `Task` from
    // the allowed tools. A Voice turn must never spawn subagent cascades — that
    // is the exact escalation behind the 30-tool / 6-minute incident.
    const effectiveBotTools = voiceMode
      ? config.BOT_TOOLS.filter((t) => t !== 'Task')
      : config.BOT_TOOLS;

    const toolsOption = config.DANGEROUS_MODE
      ? { type: 'preset' as const, preset: 'claude_code' as const }
      : effectiveBotTools;

    const allowedToolsOption = config.DANGEROUS_MODE
      ? undefined
      : effectiveBotTools;

    // Schlachtplan Akt 1.3 Fix C: per-turn tool budget. When the agent issues
    // more tool_use blocks than this, the turn is aborted as a controlled
    // error instead of running away unbounded. Voice gets the tighter budget.
    const maxToolsThisTurn = voiceMode ? config.TOOL_BUDGET_VOICE : config.TOOL_BUDGET_TEXT;

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
            // Codex round 5 MEDIUM: use this turn's local `history` clone — it
            // includes the current user message, which is only written back to
            // the shared Map at turn end. Reading the Map here would miss it.
            const recentHistory = history;
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

    // Akt A4 (2026-05-22): always-on security PreToolUse hook. The bot's agent
    // runs Claude Code with the Bash tool; a session contaminated with stale
    // deploy context was observed emitting `launchctl kickstart -k
    // com.nexus.nexusgram`, restarting the bot itself in a loop
    // (cross_review_restart-sigterm-mystery_2026-05-22.md). This hard runtime
    // gate denies service-/process-management commands regardless of session
    // content, loaded settings, or permissionMode.
    const SELF_MANAGEMENT_CMD =
      /\b(launchctl|kickstart|bootout|killall|pkill|kill|shutdown|reboot|halt)\b/i;
    const securityPreToolUse: HookCallbackMatcher = {
      hooks: [async (input) => {
        const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
        if (i.tool_name === 'Bash') {
          const cmd = String(i.tool_input?.command ?? '');
          if (SELF_MANAGEMENT_CMD.test(cmd)) {
            console.warn(`[Security] BLOCKED self-management command: ${cmd.slice(0, 160)}`);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason:
                  'Denied by the Akt-A4 security guard: this bot must never run ' +
                  'service- or process-management commands (launchctl, kill, pkill, ' +
                  'shutdown, reboot). It prevents the bot from restarting or killing itself.',
              },
            };
          }
        }
        return { continue: true };
      }],
    };

    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> =
      LOG_LEVELS[getLogLevel()] >= LOG_LEVELS.verbose
        ? {
          ...preCompactHook,
          ...verboseHooks,
          // security hook runs first, verbose-logging hook (if any) after
          PreToolUse: [securityPreToolUse, ...(verboseHooks.PreToolUse ?? [])],
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
        : { ...preCompactHook, PreToolUse: [securityPreToolUse] };

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
    // Phase 7.1 (2026-05-27): turn-start memory injection stays PUBLIC-ONLY,
    // regardless of /private on. Codex pre-review confirmed the old behaviour
    // (sessionIsPrivate→includePrivate=true) was a global private-retrieval leak,
    // not a session-scoped one. Operator-owned private OMI memories are reachable
    // exclusively via the scope-aware MCP tool nexusgram_memory_search, where the
    // master-bot's NEXUS_MEMORY_SCOPE=self_private gates them.
    const memoryContext = injectContext(prompt, config.BOT_MEMORY_PROJECT, false);
    // Load previous day's transcript for context continuity (only on fresh sessions)
    const previousDayContext = existingSessionId ? '' : loadPreviousDayTranscript(sessionKey);
    // Load today's transcript for context recovery after a bot restart.
    // Gives the bot visibility into what was already discussed today in this Telegram chat.
    const todayContext = existingSessionId ? '' : loadTodayTranscript(sessionKey);
    // Recent image uploads — survives compaction so the bot can recover paths.
    const recentUploadsContext = buildRecentUploadsContext(cwd);
    // FIX 6+ Step 6 (2026-05-25): runtime snapshot of what the bot actually
    // sees this turn (daily, input_log freshness, OMI latest). Honesty-Gate
    // against the 2026-05-25 Apple-Watch failure pattern (raten statt fragen).
    //
    // Stage 2b F-03: pass the current input_log row id so the snapshot can
    // exclude THIS turn's prompt from the "prior context" view — otherwise
    // a genuinely new session never sees `EMPTY` and the briefing-clarify
    // branch can't trigger. Optional; undefined falls back to old behaviour.
    const contextAvailabilityContext = buildContextAvailabilityPrompt(
      sessionKey,
      options.currentInputLogRowId ?? null,
    );

    const queryOptions: Parameters<typeof query>[0]['options'] = {
      cwd,
      tools: toolsOption,
      ...(allowedToolsOption ? { allowedTools: allowedToolsOption } : {}),
      permissionMode,
      abortController: controller,
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: `${voiceMode ? `${SYSTEM_PROMPT}${VOICE_MODE_PROMPT}` : SYSTEM_PROMPT}${memoryContext}${nexusBridgePrompt}${todayContext}${previousDayContext}${recentUploadsContext}${contextAvailabilityContext}${sessionIsPrivate ? PRIVACY_MODE_PROMPT : ''}`,
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
    ownedQuery = response;

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
            // D0 Hardening Item 3 (2026-05-27, Codex Conf 0.74): RequestContext-
            // Observability-Sync. The watchdog is a defense-in-depth SDK-stuck
            // detector. The primary user-facing timeout is RequestContext.onHardCap.
            // If RequestContext already terminated (state ∈ {TIMED_OUT, CANCELLED,
            // RESPONDED}), gracefulCancel is still safe (idempotent SDK-teardown)
            // and chatSessionIds.delete() is still needed (disposeRequestContext
            // does NOT clear chatSessionIds — verified 2026-05-27 grep audit).
            // Pure observability log here so /health and post-mortem can correlate
            // watchdog firings with RequestContext terminal-state.
            const liveContexts = getActiveContextsForSession(sessionKey);
            if (liveContexts.length === 0) {
              logAt('basic',
                `[Claude] WATCHDOG: RequestContext already terminal for ${sessionKey} — ` +
                `proceeding with idempotent teardown (no user-reply emitted by watchdog).`
              );
            }
            // Codex BLOCKER 1 (Akt 1.3 round 3): turn-ownership guard for the
            // session-state cleanup. A stale watchdog from an old turn must not
            // wipe a NEWER turn's claudeSessionId. Only clear if the active
            // query slot still holds OUR query (= no newer turn took over).
            if (isStillOwnerTurn()) {
              chatSessionIds.delete(sessionKey);
              const staleSession = sessionManager.getSession(sessionKey);
              if (staleSession) {
                staleSession.claudeSessionId = undefined;
              }
            } else {
              logAt('basic', `[Claude] WATCHDOG: skipping session-state clear — a newer turn owns ${sessionKey}`);
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
    responseLoop: for await (const responseMessage of response) {
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
            // Tool-Budget (Akt 1.3 Fix C / 2026-05-22 crash-safe re-design):
            // exceeding the per-turn budget stops the turn COOPERATIVELY. We do
            // NOT call controller.abort() — that tore the SDK subprocess apart
            // mid-write and crashed the whole bot process (F1 "Operation
            // aborted", 2026-05-22 14:35). Instead: interruptForToolBudget()
            // (interrupt → close), set a flag, leave the loop cleanly and
            // return the partial answer normally. No /cancel, no cancelledChats,
            // no exception — the turn ends as a normal `done`.
            if (toolsUsed.length > maxToolsThisTurn) {
              watchdog?.stop();
              console.warn(
                `[Claude] TOOL BUDGET EXCEEDED: ${toolsUsed.length}/${maxToolsThisTurn} ` +
                  `(voiceMode=${!!voiceMode}) session:${sessionKey} — stopping turn cooperatively`,
              );
              toolBudgetReached = true;
              await interruptForToolBudget(ownedQuery, sessionKey);
              break responseLoop;
            }
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
            // Codex BLOCKER 1 (round 4): turn-ownership guard. A late `success`
            // from an old (hard-capped) turn must not overwrite the session-id
            // a NEWER turn already owns.
            if (isStillOwnerTurn()) {
              chatSessionIds.set(sessionKey, responseMessage.session_id);
              sessionManager.setClaudeSessionId(sessionKey, responseMessage.session_id);
              logAt('basic', `[Claude] Stored session ${responseMessage.session_id} for session ${sessionKey}`);
            } else {
              logAt('basic', `[Claude] Skipping session-id store for ${sessionKey} — a newer turn owns the session`);
            }
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
          // Schlachtplan Akt 1.3 Cancel-Fix 1 (2026-05-21): the cancel flag has
          // now done its job (sentinel emitted). Clear it immediately so it can
          // never leak onto the next turn and make a real answer look cancelled
          // (RI-22). processQueue's finally also clears it, but a follow-up
          // message that does not start a fresh processQueue cycle would
          // otherwise see a stale `true`.
          // Codex round 4: only if still owner — a late old turn must not
          // consume a NEWER turn's cancel flag.
          if (isStillOwnerTurn()) clearCancelled(sessionKey);
        } else {
          // error_max_turns or unexpected error_during_execution
          // Clear stale session ID so next attempt starts fresh.
          // Codex BLOCKER 1 (round 3): turn-ownership guard. A late error from
          // an old (hard-capped) turn must not wipe a NEWER turn's session.
          if (isStillOwnerTurn()) {
            chatSessionIds.delete(sessionKey);
            const session = sessionManager.getSession(sessionKey);
            if (session) {
              session.claudeSessionId = undefined;
            }
            logAt('basic', `[Claude] Cleared stale session for session ${sessionKey} due to ${responseMessage.subtype}`);
          } else {
            logAt('basic', `[Claude] Skipping stale-session clear for ${sessionKey} — a newer turn owns the session`);
          }

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
      // Schlachtplan Akt 1.3 Cancel-Fix 1 (2026-05-21): clear the cancel flag
      // before returning the sentinel — otherwise it leaks onto the next turn
      // and a real answer gets misrouted as a cancel reply (RI-22).
      // Codex round 4: only if still owner — a late old turn must not consume
      // a NEWER turn's cancel flag.
      if (isStillOwnerTurn()) clearCancelled(sessionKey);
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
    // Codex BLOCKER 1: ownership-guarded — only clear the slot if it still
    // holds OUR Query. A late teardown must not delete a newer turn's Query.
    clearActiveQuery(sessionKey, ownedQuery);
  }

  // Tool-Budget cooperative stop (2026-05-22): the turn produced a partial
  // answer (or none). Apply the note/fallback HERE — BEFORE history, transcript
  // and logConversationTurn — so the budget turn is recorded in memory exactly
  // as the user sees it, including the empty-output fallback case (Codex
  // Pattern-B finding, cross_review_nexusgram-kernfix-diff_2026-05-22).
  if (toolBudgetReached) {
    fullText = fullText.trim()
      ? `⚠️ Ich habe das Tool-Limit für diese Anfrage erreicht — hier mein Zwischenstand:\n\n${fullText}`
      : 'Diese Anfrage hat mein Tool-Limit gesprengt, bevor ich antworten konnte. Bitte stell sie etwas enger — am besten eine Sache nach der anderen.';
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
  // Codex BLOCKER 1 (round 4): turn-ownership guard. A late old turn must not
  // write its (stale) history back over a newer turn's conversation.
  if (isStillOwnerTurn()) {
    conversationHistory.set(sessionKey, history);
  } else {
    logAt('basic', `[Claude] Skipping conversationHistory write for ${sessionKey} — a newer turn owns the session`);
  }

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
        turnEpoch: options.turnEpoch,
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

/**
 * Stage 2 M-024 Cancel-HARD-Rollback (2026-05-28, Codex Iterate-Patch B):
 *
 * Drop the cached Claude-Code session id for this chat without touching
 * conversationHistory. Combined with `sessionManager.forceFreshSession`, this
 * guarantees the NEXT `sendToAgent` call cannot pass `resume:` and lands in a
 * brand-new Claude-Code transcript — required to escape a torn SDK session
 * after `/cancel`. Cheaper than `clearConversation` because the local user/
 * assistant history (used for PreCompact and memory) survives the reset.
 */
export function forgetChatSession(sessionKey: string): void {
  chatSessionIds.delete(sessionKey);
}

/**
 * Bug-A (death-spiral) prevention — usage-based rotation AFTER a successful turn.
 *
 * Called from the message handler right after sendUsageFooter on every reply
 * path. When the context window is filling up we rotate to a fresh Claude-Code
 * session for the NEXT turn (forgetChatSession drops the resume id;
 * forceFreshSession installs a clean in-memory session). No data loss: the old
 * JSONL stays on disk and the next turn rebuilds todayContext/daily/memory
 * fresh. This is the PRIMARY fix (Codex order b); isOversized 7 MB is the
 * boot-airbag (order c). See audit_nexusgram_bug_audit_2026-05-27-28.md.
 */
export function maybeRotateAfterContextPressure(
  sessionKey: string,
  usage: AgentUsage | undefined,
): ContextPressure {
  if (!usage) return 'none';
  // Same "used" definition as the usage footer (input + output + cacheRead) so
  // that what fires == what the user sees in the % footer.
  const used = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens;
  const pressure = classifyContextPressure(used, usage.contextWindow);
  const pct = usage.contextWindow > 0 ? Math.round((used / usage.contextWindow) * 100) : 0;
  if (pressure === 'rotated') {
    forgetChatSession(sessionKey);
    sessionManager.forceFreshSession(sessionKey);
    chatUsageCache.delete(sessionKey);
    logAt('basic', `[ContextRotation] HARD rotate ${sessionKey} at ${pct}% — next turn starts fresh (Bug-A guard)`);
  } else if (pressure === 'warned') {
    logAt('basic', `[ContextRotation] WARN ${sessionKey} at ${pct}% — approaching context limit (Bug-A guard)`);
  }
  return pressure;
}

/**
 * Stage 2 M-024 Cancel-HARD-Rollback (2026-05-28, Codex Iterate-Patch B):
 *
 * After /cancel, prune the cancelled user turn from the local conversation
 * history so the next prompt does not echo the dropped message back to Claude
 * when history is reconstructed for a brand-new session (post-`/cancel` resume).
 *
 * Rules:
 *  - history ends with role:user → pop it (the user message we just cancelled)
 *  - history ends with role:assistant === CLAUDE_CANCEL_SENTINEL_TEXT and the
 *    prior is role:user → pop both (sentinel + the user turn that produced it)
 *  - otherwise no-op (don't blast away older completed assistant answers)
 */
export function discardCancelledTurnState(sessionKey: string): void {
  const history = conversationHistory.get(sessionKey);
  if (!history || history.length === 0) return;

  const last = history[history.length - 1];
  if (last.role === 'user') {
    history.pop();
    conversationHistory.set(sessionKey, history);
    logAt('basic', `[discardCancelledTurnState] dropped trailing user turn for ${sessionKey}`);
    return;
  }
  if (
    last.role === 'assistant' &&
    typeof last.content === 'string' &&
    last.content === CLAUDE_CANCEL_SENTINEL_TEXT &&
    history.length >= 2 &&
    history[history.length - 2].role === 'user'
  ) {
    history.pop(); // assistant sentinel
    history.pop(); // user turn
    conversationHistory.set(sessionKey, history);
    logAt('basic', `[discardCancelledTurnState] dropped cancel-sentinel + user turn for ${sessionKey}`);
  }
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
