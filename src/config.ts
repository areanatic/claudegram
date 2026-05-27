import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultEnvPath = path.resolve(__dirname, '..', '.env');
const envPath = process.env.NEXUSGRAM_ENV_PATH || process.env.CLAUDEGRAM_ENV_PATH || defaultEnvPath;
loadEnv({ path: envPath });

const toBool = (val: string) => val.toLowerCase() === 'true';

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'Telegram bot token is required'),
  ALLOWED_USER_IDS: z
    .string()
    .min(1, 'At least one allowed user ID is required')
    .transform((val) => val.split(',').map((id) => parseInt(id.trim(), 10))),
  ALLOWED_GROUP_IDS: z
    .string()
    .default('')
    .transform((val) => val ? val.split(',').map((id) => parseInt(id.trim(), 10)) : []),
  ANTHROPIC_API_KEY: z.string().optional(), // Optional - uses Claude Max subscription if not set
  // OpenAI (TTS)
  OPENAI_API_KEY: z.string().optional(),
  WORKSPACE_DIR: z.string().default(process.env.HOME || '.'),
  DATA_DIR: z.string().default(path.join(process.env.HOME || '.', '.nexusgram')),
  CLAUDE_EXECUTABLE_PATH: z.string().default('claude'),
  CLAUDE_USE_BUNDLED_EXECUTABLE: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  CLAUDE_SDK_LOG_LEVEL: z.enum(['off', 'basic', 'verbose', 'trace']).default('basic'),
  CLAUDE_SDK_INCLUDE_PARTIAL: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  CLAUDE_REASONING_SUMMARY: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  BOT_NAME: z.string().default('Nexusgram'),
  BOT_MODE: z.enum(['dev', 'prod']).default('dev'),
  STREAMING_MODE: z.enum(['streaming', 'wait']).default('streaming'),
  STREAMING_DEBOUNCE_MS: z
    .string()
    .default('500')
    .transform((val) => parseInt(val, 10)),
  MAX_MESSAGE_LENGTH: z
    .string()
    .default('4000')
    .transform((val) => parseInt(val, 10)),
  // TTS Configuration
  TTS_ENABLED: z.string().default('true').transform(toBool),
  TTS_PROVIDER: z.enum(['groq', 'openai']).default('groq'),
  TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  TTS_VOICE: z.string().default('coral'),
  TTS_INSTRUCTIONS: z.string().default('Speak in a friendly, natural conversational tone.'),
  TTS_SPEED: z
    .string()
    .default('1.0')
    .transform((val) => parseFloat(val)),
  TTS_MAX_CHARS: z
    .string()
    .default('4096')
    .transform((val) => parseInt(val, 10)),
  TTS_RESPONSE_FORMAT: z.string().default('opus'),
  IMAGE_MAX_FILE_SIZE_MB: z
    .string()
    .default('20')
    .transform((val) => parseInt(val, 10)),
  // New config options
  DANGEROUS_MODE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  MAX_LOOP_ITERATIONS: z
    .string()
    .default('5')
    .transform((val) => parseInt(val, 10)),
  REDDITFETCH_JSON_THRESHOLD_CHARS: z
    .string()
    .default('8000')
    .transform((val) => parseInt(val, 10)),
  // Reddit API credentials (native TypeScript module)
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USERNAME: z.string().optional(),
  REDDIT_PASSWORD: z.string().optional(),
  // Reddit fetch configuration
  REDDIT_ENABLED: z.string().default('true').transform(toBool),
  // DEPRECATED: REDDITFETCH_PATH — replaced by native TypeScript module; kept for reference only
  REDDITFETCH_PATH: z.string().default(''),
  REDDITFETCH_TIMEOUT_MS: z
    .string()
    .default('30000')
    .transform((val) => parseInt(val, 10)),
  REDDITFETCH_DEFAULT_LIMIT: z
    .string()
    .default('10')
    .transform((val) => parseInt(val, 10)),
  REDDITFETCH_DEFAULT_DEPTH: z
    .string()
    .default('5')
    .transform((val) => parseInt(val, 10)),
  // Reddit video download
  VREDDIT_ENABLED: z.string().default('true').transform(toBool),
  REDDIT_VIDEO_MAX_SIZE_MB: z
    .string()
    .default('50')
    .transform((val) => parseInt(val, 10)),
  // Telegraph (Instant View for long messages)
  TELEGRAPH_ENABLED: z.string().default('true').transform(toBool),
  // Medium / Freedium configuration
  MEDIUM_ENABLED: z.string().default('true').transform(toBool),
  MEDIUM_TIMEOUT_MS: z
    .string()
    .default('15000')
    .transform((val) => parseInt(val, 10)),
  MEDIUM_FILE_THRESHOLD_CHARS: z
    .string()
    .default('8000')
    .transform((val) => parseInt(val, 10)),
  FREEDIUM_HOST: z.string().default('freedium-mirror.cfd'),
  FREEDIUM_RATE_LIMIT_MS: z
    .string()
    .default('2000')
    .transform((val) => parseInt(val, 10)),
  // Voice transcription (Groq Whisper)
  GROQ_API_KEY: z.string().optional(),
  GROQ_TRANSCRIBE_PATH: z.string().default(''),
  TRANSCRIBE_ENABLED: z.string().default('true').transform(toBool),
  VOICE_SHOW_TRANSCRIPT: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  VOICE_MAX_FILE_SIZE_MB: z
    .string()
    .default('19')
    .transform((val) => parseInt(val, 10)),
  VOICE_LANGUAGE: z.string().default('en'),
  // A2 confidence gate: ISO 639-1 codes the user actually speaks. A transcript
  // whose detected language is NOT in this list is treated as a Whisper
  // hallucination (e.g. German audio mis-transcribed as Korean) and the user is
  // asked to resend instead of the nonsense being fed to the agent. Empty = any.
  VOICE_ALLOWED_LANGUAGES: z
    .string()
    .default('de,en')
    .transform((val) => val.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)),
  // Voice-first mode: auto-enable TTS when user sends voice messages
  VOICE_FIRST_MODE_ENABLED: z.string().default('true').transform(toBool),
  VOICE_TIMEOUT_MS: z
    .string()
    .default('60000')
    .transform((val) => parseInt(val, 10)),
  // Transcribe command: send .txt file if transcript exceeds this many chars
  TRANSCRIBE_FILE_THRESHOLD_CHARS: z
    .string()
    .default('4000')
    .transform((val) => parseInt(val, 10)),
  // Media extraction (/extract command)
  EXTRACT_ENABLED: z.string().default('true').transform(toBool),
  YTDLP_COOKIES_PATH: z.string().default(''),
  YTDLP_PROXY_LIST_PATH: z.string().default(''),
  EXTRACT_TRANSCRIBE_TIMEOUT_MS: z
    .string()
    .default('180000')
    .transform((val) => parseInt(val, 10)),
  // Context visibility
  CONTEXT_SHOW_USAGE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  CONTEXT_NOTIFY_COMPACTION: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  // Terminal UI mode
  TERMINAL_UI_DEFAULT: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  ALLOW_PRIVATE_NETWORK_URLS: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Logging: show SDK hook JSON dumps (PreToolUse, PostToolUse, stderr, etc.)
  // When false (default), verbose mode shows clean operational logs without hook noise.
  // When true, verbose mode includes full hook JSON payloads and stderr output.
  LOG_AGENT_HOOKS: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Cancel behaviour: auto-cancel running query when user sends a new message
  CANCEL_ON_NEW_MESSAGE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Agent watchdog: detect stuck/unresponsive agent queries
  AGENT_WATCHDOG_ENABLED: z.string().default('true').transform(toBool),
  AGENT_WATCHDOG_WARN_SECONDS: z
    .string()
    .default('18')
    .transform((val) => parseInt(val, 10)),
  AGENT_WATCHDOG_LOG_SECONDS: z
    .string()
    .default('10')
    .transform((val) => parseInt(val, 10)),
  // Schlachtplan Akt 1.3 Fix D (2026-05-21): default is no longer 0. A 0
  // default silently DISABLES the agent watchdog hard timeout — exactly the
  // gap that let a Voice turn run unbounded. 180000ms (3min) is a real upper
  // bound that still covers Tool-Use research. An explicit env value still
  // wins; set it to 0 only with a deliberate reason.
  AGENT_QUERY_TIMEOUT_MS: z
    .string()
    .default('180000')
    .transform((val) => parseInt(val, 10)),
  // Schlachtplan Akt 1.3 Fix B (2026-05-21): hard cap for a single Voice agent
  // turn. The Voice path has no RequestContext state machine (Phase C only
  // wired the text path); this local cap is its fail-fast guard. On expiry the
  // turn is gracefulCancel-ed and the user gets a clear timeout reply.
  VOICE_AGENT_HARD_CAP_MS: z
    .string()
    .default('180000')
    .transform((val) => parseInt(val, 10)),
  // Schlachtplan Akt 1.3 Fix C (2026-05-21) / crash-safe re-design 2026-05-22:
  // per-turn tool budget. A turn exceeding this many tool_use blocks is stopped
  // COOPERATIVELY (interrupt → close, never controller.abort()) and returns its
  // partial answer — see interruptForToolBudget() in agent.ts. Voice gets the
  // tighter budget; text more headroom for research. Raised 4→10 / 12→15 on
  // 2026-05-22: the old voice cap of 4 aborted "search memory + check INBOX"
  // tasks before they could even produce an answer.
  TOOL_BUDGET_VOICE: z
    .string()
    .default('10')
    .transform((val) => parseInt(val, 10)),
  TOOL_BUDGET_TEXT: z
    .string()
    .default('15')
    .transform((val) => parseInt(val, 10)),
  // Max time message.handler waits for a single Claude response before aborting.
  // Mai-Intervention 2026-05-11 Phase A.1: replaces hardcoded 5min in
  // message.handler.ts (RI-01 root-cause). Default 10min covers Tool-Use research.
  AGENT_RESPONSE_TIMEOUT_MS: z
    .string()
    .default('600000')
    .transform((val) => parseInt(val, 10)),
  // Mai-Intervention Phase C.1: Heartbeat threshold for RequestContext.
  // When a request exceeds this, a one-time "still working" notification is sent
  // and the state transitions WAITING → LONG_RUNNING. Does NOT finalize the request.
  // Default 30s sits below the watchdog-warning so users get UX feedback early.
  HANDLER_LONG_RUNNING_HEARTBEAT_MS: z
    .string()
    .default('30000')
    .transform((val) => parseInt(val, 10)),
  // Optional user-facing heartbeat sent on the LONG_RUNNING transition. Sent at
  // most once per request. Disable by setting empty.
  HANDLER_LONG_RUNNING_MESSAGE: z
    .string()
    .default('🐌 Brauche länger als gewöhnlich, bin aber dran…'),
  // Mai-Intervention Phase C.2: Adaptive Per-Request Timeout (Sprint 5).
  // When the per-session queue length exceeds this threshold, new requests get a
  // proportionally shorter deadline so a back-pressured queue can drain before
  // the user sees stale results.
  ADAPTIVE_TIMEOUT_QUEUE_THRESHOLD: z
    .string()
    .default('5')
    .transform((val) => parseInt(val, 10)),
  // Per-item reduction step applied for every queued item above the threshold.
  // 0.1 = 10% shorter per excess item. Clamped by ADAPTIVE_TIMEOUT_FLOOR_RATIO.
  ADAPTIVE_TIMEOUT_STEP_RATIO: z
    .string()
    .default('0.1')
    .transform((val) => parseFloat(val)),
  // Lower bound for the adaptive multiplier — never shrink below this fraction
  // of AGENT_RESPONSE_TIMEOUT_MS even if the queue is huge.
  ADAPTIVE_TIMEOUT_FLOOR_RATIO: z
    .string()
    .default('0.5')
    .transform((val) => parseFloat(val)),
  // Watchdog user-facing "still working" Telegram ping. OFF by default
  // (Akt 3 A3 status-dedup): the RequestContext long-running heartbeat
  // (HANDLER_LONG_RUNNING_MESSAGE) is the single user-facing progress signal.
  // The watchdog stays a pure log/timeout guard — two independent timers both
  // messaging the user produced overlapping "Bin dran…" + "Brauche länger…" spam.
  AGENT_WATCHDOG_USER_NOTIFY: z.string().default('false').transform(toBool),
  AGENT_WATCHDOG_USER_NOTIFY_MESSAGE: z
    .string()
    .default('🔄 Bin dran, brauche noch einen Moment…'),
  // Document INBOX configuration
  DOCUMENT_INBOX_ENABLED: z.string().default('true').transform(toBool),
  DOCUMENT_MAX_FILE_SIZE_MB: z
    .string()
    .default('20')
    .transform((val) => parseInt(val, 10)),
  // NEXUS Memory: restrict memory queries to a specific project (empty = all)
  BOT_MEMORY_PROJECT: z.string().optional(),
  // Tools available to Claude (comma-separated). Master = all, Space-Bots = restricted.
  BOT_TOOLS: z.string()
    .default('Bash,Read,Write,Edit,Glob,Grep,Task')
    .transform(val => val.split(',').map(s => s.trim())),
  // Product Development Agents
  BOT_PD_ENABLED: z.string().default('false').transform(v => v === 'true'),
  BOT_PD_DEXMASTER_MODE: z.enum(['suggest', 'auto']).default('suggest'),
  BOT_PD_CATEGORIES: z.string().default('').transform(v => v ? v.split(',').map(s => s.trim()).filter(Boolean) : []),
  BOT_PD_AGENTS: z.string().default('').transform(v => v ? v.split(',').map(s => s.trim()).filter(Boolean) : []),
  BOT_PD_CONSOLE_ENABLED: z.string().default('false').transform(v => v === 'true'),
  BOT_PD_SPARRING_ENABLED: z.string().default('true').transform(v => v === 'true'),
  BOT_PD_COUNCIL_MAX: z.coerce.number().int().min(1).max(5).default(3),
  BOT_PD_MAX_PARALLEL: z.coerce.number().int().min(1).max(4).default(2),
  BOT_PD_OUTCOMES_DIR: z.string().default('/Volumes/AstronOne/shared-memory/nexus/pd-outcomes/'),
  BOT_PD_OUTCOME_FORMAT: z.enum(['markdown', 'simple']).default('markdown'),
  // Custom soul file per bot (overrides default NEXUS soul.md detection)
  BOT_SOUL_FILE: z.string().optional(),
  // Path to custom /start welcome message file (plain text/markdown). If set, replaces default welcome.
  BOT_WELCOME_FILE: z.string().optional(),
  // Minimal command menu for Space-Bots (hides developer commands like /project, /explore, /plan)
  BOT_MINIMAL_COMMANDS: z.string().default('false').transform(toBool),
  // Language for minimal command menu descriptions: 'de' | 'ru' | 'en'
  BOT_COMMAND_LANGUAGE: z.string().default('de'),
  // Follow-up inline buttons after each agent response
  FOLLOWUP_BUTTONS_ENABLED: z.string().default('true').transform(toBool),
  // Local Telegram Bot API Server (optional — raises file limit from 20MB to 2GB)
  TELEGRAM_API_SERVER_URL: z.string().optional(),
  // Phase 7.1 (2026-05-27) — NEXUS memory retrieval scope.
  // Validated separately below; kept here so missing-scope on master fails fast.
  NEXUS_MEMORY_SCOPE: z.enum(['public', 'self_private', 'operator_all']).optional(),
  // Phase 7.x Scanner-Pro Master-Bot Watcher (2026-05-27).
  // Codex pre-review: cross_review_scanner-watcher-architecture_2026-05-27.md (0.76)
  // Triple-gated: only effective when ENABLED + BOT_NAME='Nexusgram' + NEXUS_MEMORY_SCOPE='self_private'.
  SCANNER_PRO_WATCHER_ENABLED: z.string().default('false').transform(toBool),
  // Codex P1-2: validated interval — min 60s prevents NaN/0 spawn-loop on env typo.
  SCANNER_PRO_WATCHER_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),
  SCANNER_PRO_SCRIPT_PATH: z.string().default('/Volumes/AstronOne/NEXUS_miniM_13-03-26/scripts/scanner-pro-sync.sh'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.message);
  process.exit(1);
}

export const config = parsed.data;

// Phase 7.1 boot-assertion: master-bot must explicitly declare its scope.
// Family-/test-bot default-fail-closed to 'public' (no assertion needed).
// Identifier: BOT_NAME='Nexusgram' is the master-bot per master .env.
if (config.BOT_NAME === 'Nexusgram' && config.NEXUS_MEMORY_SCOPE !== 'self_private') {
  console.error(
    '❌ Master-bot boot-assertion failed (Phase 7.1):\n' +
    `   BOT_NAME='${config.BOT_NAME}' but NEXUS_MEMORY_SCOPE='${config.NEXUS_MEMORY_SCOPE ?? '(unset)'}'.\n` +
    "   Master must explicitly set NEXUS_MEMORY_SCOPE='self_private' to access\n" +
    '   operator-owned private memories. Set it in the .env file.\n' +
    '   Family-/test-bot can leave it unset (defaults to public).'
  );
  process.exit(1);
}

export type Config = typeof config;
