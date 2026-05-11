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
  AGENT_QUERY_TIMEOUT_MS: z
    .string()
    .default('0')
    .transform((val) => parseInt(val, 10)), // 0 = disabled
  // Max time message.handler waits for a single Claude response before aborting.
  // Mai-Intervention 2026-05-11 Phase A.1: replaces hardcoded 5min in
  // message.handler.ts (RI-01 root-cause). Default 10min covers Tool-Use research.
  AGENT_RESPONSE_TIMEOUT_MS: z
    .string()
    .default('600000')
    .transform((val) => parseInt(val, 10)),
  // Send a single user-facing "still working" message via Telegram when the
  // watchdog warning fires. One ping per query, configurable so deployments
  // can opt out or change the wording.
  AGENT_WATCHDOG_USER_NOTIFY: z.string().default('true').transform(toBool),
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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.message);
  process.exit(1);
}

export const config = parsed.data;

export type Config = typeof config;
