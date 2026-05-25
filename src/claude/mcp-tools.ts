/**
 * MCP Tools — In-process MCP server factory for Nexusgram.
 *
 * Wraps existing standalone functions (reddit, medium, extract, telegraph,
 * project management) as MCP tools so Claude can invoke them automatically
 * based on conversation context instead of requiring explicit /commands.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { InputFile, type Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { sessionManager } from './session-manager.js';
import { getWorkspaceRoot, isPathWithinRoot } from '../utils/workspace-guard.js';
import { searchMemoryReadOnly } from '../memory/nexus-memory.js';
import { searchInputLog } from '../inbox/input-log.js';

// Lazy imports to avoid circular deps and unnecessary module loading
async function importInbox() {
  return import('../inbox/inbox.js');
}

async function importReddit() {
  return import('../reddit/redditfetch.js');
}

async function importMedium() {
  return import('../medium/freedium.js');
}

async function importExtract() {
  return import('../media/extract.js');
}

async function importTelegraph() {
  return import('../telegram/telegraph.js');
}

// ── Types ────────────────────────────────────────────────────────────

export interface McpToolsContext {
  telegramCtx: Context;
  sessionKey: string;
}

// ── Constants ────────────────────────────────────────────────────────

const REDDIT_MAX_CHARS = 50_000;

// ── Factory ──────────────────────────────────────────────────────────

export function createNexusgramMcpServer(
  toolsCtx: McpToolsContext
): McpSdkServerConfigWithInstance {
  const tools = buildToolList(toolsCtx);

  return createSdkMcpServer({
    name: 'nexusgram-tools',
    version: '1.0.0',
    tools,
  });
}

function buildToolList(toolsCtx: McpToolsContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [
    listProjectsTool(toolsCtx),
    switchProjectTool(toolsCtx),
  ];

  if (config.REDDIT_ENABLED) {
    tools.push(fetchRedditTool(toolsCtx));
  }

  if (config.MEDIUM_ENABLED) {
    tools.push(fetchMediumTool(toolsCtx));
  }

  if (config.EXTRACT_ENABLED) {
    tools.push(extractMediaTool(toolsCtx));
  }

  if (config.TELEGRAPH_ENABLED) {
    tools.push(publishTelegraphTool(toolsCtx));
  }

  if (config.DOCUMENT_INBOX_ENABLED) {
    tools.push(inboxListTool(toolsCtx));
    tools.push(inboxRouteTool(toolsCtx));
  }

  tools.push(sendFileTool(toolsCtx));
  tools.push(nexusMemorySearchTool(toolsCtx));

  // FIX 6+ Step 3 + Step 4 (2026-05-25): retrieval tools that the
  // Codex Pre-Review demanded be kept SEPARATE from nexusgram_memory_search
  // (different privacy model, different ranking, allowlisted reads only).
  tools.push(nexusgramInputLogSearchTool(toolsCtx));
  tools.push(nexusgramReadDailyTool());
  tools.push(nexusgramReadL1Tool());

  return tools;
}

// ── Tool Definitions ─────────────────────────────────────────────────

function listProjectsTool(_toolsCtx: McpToolsContext) {
  return tool(
    'nexusgram_list_projects',
    'List all available projects in the workspace directory. Use this to see what projects the user can switch to.',
    {},
    async () => {
      try {
        const workspaceRoot = getWorkspaceRoot();
        const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
        const projects = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => e.name);

        return {
          content: [{
            type: 'text' as const,
            text: `Projects in ${workspaceRoot}:\n${projects.join('\n')}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing projects: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function switchProjectTool(toolsCtx: McpToolsContext) {
  return tool(
    'nexusgram_switch_project',
    'Switch the working directory to a different project. The change takes effect on the next query. Use nexusgram_list_projects first to see available projects.',
    { project_name: z.string().describe('Name of the project directory to switch to') },
    async ({ project_name }) => {
      try {
        const workspaceRoot = getWorkspaceRoot();
        const targetPath = path.resolve(workspaceRoot, project_name);

        if (!isPathWithinRoot(workspaceRoot, targetPath)) {
          return {
            content: [{ type: 'text' as const, text: `Error: Path must be within workspace root: ${workspaceRoot}` }],
            isError: true,
          };
        }

        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: `Error: Project not found: ${project_name}` }],
            isError: true,
          };
        }

        sessionManager.setWorkingDirectory(toolsCtx.sessionKey, targetPath);

        return {
          content: [{
            type: 'text' as const,
            text: `Switched to project: ${project_name} (${targetPath}). The new working directory will take effect on the next query.`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error switching project: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function fetchRedditTool(_toolsCtx: McpToolsContext) {
  return tool(
    'nexusgram_fetch_reddit',
    'Fetch Reddit content: subreddit listings, post threads with comments, or user profiles. Supports sort/time filters for subreddits. Returns markdown-formatted results.',
    {
      target: z.string().describe('Reddit target: r/<subreddit>, u/<username>, post URL, post ID, or share link'),
      sort: z.enum(['hot', 'new', 'top', 'rising']).optional().describe('Sort order (default: hot). Semantic mappings: "trending"→hot, "latest"→new, "best"→top'),
      limit: z.number().optional().describe('Number of posts to fetch (default: 10)'),
      time_filter: z.enum(['day', 'week', 'month', 'year', 'all']).optional().describe('Time filter for top sort. Semantic: "today"→day, "this week"→week'),
      depth: z.number().optional().describe('Comment depth for post threads (default: 5)'),
    },
    async ({ target, sort, limit, time_filter, depth }) => {
      try {
        const { redditFetch } = await importReddit();
        const result = await redditFetch([target], {
          format: 'markdown',
          sort: sort || 'hot',
          limit: limit || config.REDDITFETCH_DEFAULT_LIMIT,
          depth: depth || config.REDDITFETCH_DEFAULT_DEPTH,
          timeFilter: time_filter,
        });

        const truncated = result.length > REDDIT_MAX_CHARS
          ? result.substring(0, REDDIT_MAX_CHARS) + '\n\n[... truncated — content exceeded 50k chars]'
          : result;

        return {
          content: [{ type: 'text' as const, text: truncated }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Reddit fetch error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function fetchMediumTool(_toolsCtx: McpToolsContext) {
  return tool(
    'nexusgram_fetch_medium',
    'Fetch a Medium article via Freedium (bypasses paywall). Returns the article title, author, and full markdown content.',
    {
      url: z.string().describe('Medium article URL (medium.com, towardsdatascience.com, etc.)'),
    },
    async ({ url }) => {
      try {
        const { fetchMediumArticle, isMediumUrl } = await importMedium();

        if (!isMediumUrl(url)) {
          return {
            content: [{ type: 'text' as const, text: 'Error: URL does not appear to be a Medium article.' }],
            isError: true,
          };
        }

        const article = await fetchMediumArticle(url);

        return {
          content: [{
            type: 'text' as const,
            text: `# ${article.title}\n**By ${article.author}**\n\n${article.markdown}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Medium fetch error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function extractMediaTool(toolsCtx: McpToolsContext) {
  return tool(
    'nexusgram_extract_media',
    'Extract text transcripts, audio, or video from YouTube, Instagram, and TikTok URLs. Audio/video files are sent directly to the user via Telegram. Transcripts are returned as text.',
    {
      url: z.string().describe('URL of the video (YouTube, Instagram, or TikTok)'),
      mode: z.enum(['text', 'audio', 'video', 'all']).describe('What to extract: "text" for transcript, "audio" for MP3, "video" for MP4, "all" for everything'),
    },
    async ({ url, mode }) => {
      const { extractMedia, cleanupExtractResult } = await importExtract();
      let result: Awaited<ReturnType<typeof extractMedia>> | undefined;

      try {
        result = await extractMedia({ url, mode });

        const ctx = toolsCtx.telegramCtx;
        const parts: string[] = [];

        // Send media files to user via Telegram
        if (result.videoPath) {
          try {
            await ctx.replyWithVideo(new InputFile(result.videoPath), {
              caption: `📹 ${result.title}`,
            });
            parts.push('Video sent to user.');
          } catch (err) {
            parts.push(`Video send failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (result.audioPath && (mode === 'audio' || mode === 'all')) {
          try {
            await ctx.replyWithAudio(new InputFile(result.audioPath), {
              caption: `🎵 ${result.title}`,
            });
            parts.push('Audio sent to user.');
          } catch (err) {
            parts.push(`Audio send failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (result.transcript) {
          parts.push(`Transcript:\n\n${result.transcript}`);
        }

        if (result.warnings.length > 0) {
          parts.push(`Warnings: ${result.warnings.join('; ')}`);
        }

        if (parts.length === 0) {
          parts.push('Extraction completed but no content was produced.');
        }

        return {
          content: [{ type: 'text' as const, text: parts.join('\n\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Media extraction error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      } finally {
        if (result) {
          cleanupExtractResult(result);
        }
      }
    }
  );
}

function publishTelegraphTool(_toolsCtx: McpToolsContext) {
  return tool(
    'nexusgram_publish_telegraph',
    'Publish markdown content as a Telegraph (telegra.ph) Instant View page. Returns the URL. Useful for sharing long-form content as a readable link.',
    {
      title: z.string().describe('Page title'),
      markdown: z.string().describe('Markdown content for the page'),
    },
    async ({ title, markdown }) => {
      try {
        const { createTelegraphPage } = await importTelegraph();
        const url = await createTelegraphPage(title, markdown);

        if (!url) {
          return {
            content: [{ type: 'text' as const, text: 'Failed to create Telegraph page.' }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: `Telegraph page created: ${url}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Telegraph error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

// ── Inbox Tools ───────────────────────────────────────────────────────

function inboxListTool(_toolsCtx: McpToolsContext) {
  return tool(
    'nexusgram_inbox_list',
    'List all files currently in the INBOX (unrouted documents received via Telegram). Shows filename, size, MIME type, date, and caption for each file.',
    {},
    async () => {
      try {
        const { listInbox, getInboxStats, formatFileSize } = await importInbox();
        const items = listInbox();
        const stats = getInboxStats();

        if (items.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'INBOX is empty — no unrouted documents.' }],
          };
        }

        const lines = items.map((item, i) => {
          const caption = item.caption ? ` — "${item.caption}"` : '';
          return `${i + 1}. ${item.originalFilename} (${formatFileSize(item.fileSize)}, ${item.mimeType || 'unknown'})${caption}\n   Saved: ${item.savedFilename} | Received: ${item.receivedAt}`;
        });

        const summary = `INBOX: ${stats.totalFiles} file(s), ${stats.totalSizeMB} MB total\n\n${lines.join('\n\n')}`;

        return {
          content: [{ type: 'text' as const, text: summary }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Inbox list error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

function inboxRouteTool(_toolsCtx: McpToolsContext) {
  return tool(
    'nexusgram_inbox_route',
    'Route (move) a file from the INBOX to a target directory within the workspace. Use nexusgram_inbox_list first to see available files.',
    {
      filename: z.string().describe('The saved filename in the INBOX (from nexusgram_inbox_list)'),
      target_dir: z.string().describe('Target directory path (relative to workspace root or absolute)'),
      new_name: z.string().optional().describe('Optional new filename after routing'),
    },
    async ({ filename, target_dir, new_name }) => {
      try {
        const { getInboxDir, routeFile } = await importInbox();
        const inboxDir = getInboxDir();
        const filePath = path.join(inboxDir, filename);

        if (!fs.existsSync(filePath)) {
          return {
            content: [{ type: 'text' as const, text: `File not found in INBOX: ${filename}` }],
            isError: true,
          };
        }

        // Resolve target directory
        const workspaceRoot = getWorkspaceRoot();
        const resolvedTarget = path.isAbsolute(target_dir)
          ? target_dir
          : path.resolve(workspaceRoot, target_dir);

        if (!isPathWithinRoot(workspaceRoot, resolvedTarget)) {
          return {
            content: [{ type: 'text' as const, text: `Error: Target must be within workspace root: ${workspaceRoot}` }],
            isError: true,
          };
        }

        const { newPath } = routeFile(filePath, resolvedTarget, new_name);

        return {
          content: [{ type: 'text' as const, text: `File routed: ${filename} → ${newPath}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Inbox route error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

// ── Send File Tool ────────────────────────────────────────────────────

function sendFileTool(toolsCtx: McpToolsContext) {
  return tool(
    'nexusgram_send_file',
    'Send a file from the workspace to the user via Telegram. The file must be within the workspace root. Use this to share project files, generated reports, or any file the user requests.',
    {
      file_path: z.string().describe('Path to the file (relative to workspace root or absolute)'),
      caption: z.string().optional().describe('Optional caption to send with the file'),
    },
    async ({ file_path, caption }) => {
      try {
        const workspaceRoot = getWorkspaceRoot();
        const resolvedPath = path.isAbsolute(file_path)
          ? file_path
          : path.resolve(workspaceRoot, file_path);

        if (!isPathWithinRoot(workspaceRoot, resolvedPath)) {
          return {
            content: [{ type: 'text' as const, text: `Error: File must be within workspace root: ${workspaceRoot}` }],
            isError: true,
          };
        }

        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
          return {
            content: [{ type: 'text' as const, text: `File not found: ${file_path}` }],
            isError: true,
          };
        }

        const stats = fs.statSync(resolvedPath);
        const sizeMB = stats.size / (1024 * 1024);

        // Standard API: 50MB send limit. Local API server: 2GB.
        const maxSendMB = config.TELEGRAM_API_SERVER_URL ? 2000 : 50;
        if (sizeMB > maxSendMB) {
          return {
            content: [{ type: 'text' as const, text: `File too large (${sizeMB.toFixed(1)} MB). Limit is ${maxSendMB} MB.` }],
            isError: true,
          };
        }

        const ctx = toolsCtx.telegramCtx;
        const filename = path.basename(resolvedPath);

        await ctx.replyWithDocument(new InputFile(resolvedPath, filename), {
          caption: caption || undefined,
        });

        return {
          content: [{ type: 'text' as const, text: `File sent to user: ${filename} (${sizeMB < 1 ? `${(stats.size / 1024).toFixed(1)} KB` : `${sizeMB.toFixed(1)} MB`})` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Send file error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

/**
 * nexus_memory_search — MCP-Tool wrapper around searchMemoryReadOnly.
 * Mai-Intervention 2026-05-11 Phase B.5 (V2.4-5).
 *
 * Use when user asks about past context, identities (bots, people), prior
 * decisions, or any fact that may live in the NEXUS FTS5 memory.
 *
 * V2.4-5 hardening:
 *  - Read-only DB connection per call
 *  - Fail-CLOSED privacy default (public only, never leaks 'private' rows)
 *  - Limit clamped to [1, 20]
 *  - Phrase-search first, falls back to token-search when 0 hits
 *  - Output stripped to {content, tags, project, score} — no file_path/source/privacy
 */
// ── FIX 6+ Step 3 (2026-05-25): Telegram input-log retrieval ────────────────
//
// SEPARATE tool from nexusgram_memory_search (Codex Pre-Review §2):
//   - memory_search returns L2 long-term memories (FTS5 over `memories` table,
//     public-only, no source path, neutral wording).
//   - input_log_search returns RAW Telegram inputs (text + voice transcripts +
//     photo captions), INCLUDING dropped / failed turns. Session-scoped by
//     default (privacy-safe). The killer-use-case: "ich hab dir gestern was
//     gesagt, aber du hast nicht geantwortet" — was the briefing received or
//     not, and what did it say?

function nexusgramInputLogSearchTool(toolsCtx: McpToolsContext) {
  return tool(
    'nexusgram_input_log_search',
    'Search past Telegram inputs (text, voice transcripts, photo captions) ' +
      'INCLUDING dropped or failed inputs. Use when the user refers to ' +
      'something they sent earlier ("hab ich dir gesagt", "letzte ' +
      'Sprachnachricht", "vorher hab ich…"). Returns matching input-log rows ' +
      'with snippet, status (received/processing/done/dropped/error), ' +
      'drop reason, timestamp. Scope: this Telegram session only.',
    {
      query: z.string().min(1).describe('FTS5 search query, e.g. "ChatGPT briefing" or "Apple Watch"'),
      since: z.string().optional().describe('ISO date floor (e.g. "2026-05-20T00:00:00Z"). Omit for all-time.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (1-50, default 10).'),
    },
    async ({ query, since, limit }) => {
      try {
        const sessionKey = toolsCtx.sessionKey;
        const rows = searchInputLog({ query, sessionKey, since, limit });
        if (rows.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No input-log rows matched "${query}"${since ? ` since ${since}` : ''} for this session.`,
            }],
          };
        }
        const lines = rows.map((r, i) => {
          const statusTag = r.status === 'dropped'
            ? `dropped:${r.dropped_reason ?? 'unknown'}`
            : r.status;
          return `[${i + 1}] ${r.received_at} · ${r.input_type} · ${statusTag}\n    ${r.raw_content_snippet || '(no content)'}`;
        });
        return {
          content: [{
            type: 'text' as const,
            text: `Found ${rows.length} input-log row${rows.length === 1 ? '' : 's'} for "${query}":\n\n${lines.join('\n\n')}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Input-log search error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

// ── FIX 6+ Step 4 (2026-05-25): allowlisted L1 reads ─────────────────────────
//
// Codex Pre-Review §2: no arbitrary read_file(path). The bot gets two narrow,
// allowlisted entry points so it can answer "what does soul.md say about X"
// or "what was in the daily log on 2026-05-22" WITHOUT a full filesystem tool.

const DAILY_LOG_DIR = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/daily';
const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_L1_CHARS = 8000; // allow-hardcoded: reason="Telegram-bubble safety cap for L1 reads, not a timeout"

function truncateForReply(content: string): string {
  if (content.length <= MAX_L1_CHARS) return content;
  return content.slice(0, MAX_L1_CHARS) + '\n\n…[truncated — file longer than allowed]';
}

function nexusgramReadDailyTool() {
  return tool(
    'nexusgram_read_daily',
    'Read a NEXUS daily log by date (YYYY-MM-DD). Use when the user asks ' +
      'about a specific day ("wann haben wir X gemacht", "was war am ' +
      'Sonntag", "schau in den Daily von gestern"). Returns the markdown ' +
      'content, optionally a single ## section. Truncated at 8000 chars.',
    {
      date: z.string().describe('Date in YYYY-MM-DD format (e.g. "2026-05-25").'),
      section: z.string().optional().describe('Optional ## or ### section header to extract (e.g. "Apple Watch 4 Setup").'),
    },
    async ({ date, section }) => {
      try {
        if (!DAILY_DATE_REGEX.test(date)) {
          return {
            content: [{ type: 'text' as const, text: `Invalid date "${date}" — expected YYYY-MM-DD.` }],
            isError: true,
          };
        }
        const filename = `${date}.md`;
        const filepath = path.join(DAILY_LOG_DIR, filename);
        // Defense-in-depth: ensure resolved path stays inside DAILY_LOG_DIR.
        const resolved = path.resolve(filepath);
        if (!resolved.startsWith(path.resolve(DAILY_LOG_DIR) + path.sep)) {
          return {
            content: [{ type: 'text' as const, text: `Path traversal blocked for "${date}".` }],
            isError: true,
          };
        }
        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: 'text' as const, text: `No daily log found for ${date}.` }],
          };
        }
        let content = fs.readFileSync(resolved, 'utf-8');
        if (section) {
          // Match a section header (## or ###) whose text contains `section`
          // (case-insensitive, whitespace-tolerant). Capture up to the next
          // sibling/higher header.
          //
          // FIX 6+ Stage 2b (Codex Pattern-B F-06): the original `\Z`
          // end-of-string anchor is Perl/Python syntax — JavaScript regex does
          // NOT treat `\Z` as EOF, it matches the literal letter Z. The last
          // section in a file therefore failed to match. Replaced with
          // `$(?![\s\S])` — `$` with a negative lookahead asserting "no
          // character follows", which is the JS-native way to spell true EOF
          // (independent of the `m` flag's per-line `$` semantics).
          const escSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
          const sectionRegex = new RegExp(
            `^(##+\\s+[^\\n]*${escSection}[^\\n]*\\n[\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`,
            'im',
          );
          const match = content.match(sectionRegex);
          if (match) content = match[1];
          else content = `Section "${section}" not found in daily ${date}.\n\n--- Full file ---\n\n${content}`;
        }
        return {
          content: [{ type: 'text' as const, text: truncateForReply(content) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `read_daily error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

// Layer-1 reference files. Allowlist only — Codex Pre-Review explicitly
// forbade arbitrary read_file(path). Each entry must point to a stable,
// agent-readable truth file. Missing files surface as "L1 file not available".
const L1_ALLOWLIST: Record<string, string> = {
  'soul.md': '/Volumes/AstronOne/NEXUS_miniM_13-03-26/soul.md',
  'memory.md': '/Volumes/AstronOne/shared-memory/nexus/MEMORY.md',
  // FIX 6+ Stage 2b (Codex Pattern-B F-05): added CLAUDE.md + AGENTS.md as
  // explicit canonical Layer-1 truth files. Both exist at project root and
  // contain agent-routing rules / file-placement contracts the bot should be
  // able to quote verbatim when asked "was steht in CLAUDE.md zu X".
  'claude.md': '/Volumes/AstronOne/NEXUS_miniM_13-03-26/CLAUDE.md',
  'agents.md': '/Volumes/AstronOne/NEXUS_miniM_13-03-26/AGENTS.md',
  'bot-glossary': '/Volumes/AstronOne/shared-memory/nexus/wiki/00-bot-glossary-truth.md',
  'arash-profile': '/Volumes/AstronOne/shared-memory/nexus/wiki/arash-profile-truth.md',
  'projects': '/Volumes/AstronOne/shared-memory/nexus/wiki/projects-truth.md',
  'decisions': '/Volumes/AstronOne/shared-memory/nexus/wiki/decisions-truth.md',
  'nexus-system': '/Volumes/AstronOne/shared-memory/nexus/wiki/nexus-system-truth.md',
};

function nexusgramReadL1Tool() {
  const allowedNames = Object.keys(L1_ALLOWLIST) as [string, ...string[]];
  return tool(
    'nexusgram_read_l1',
    'Read a NEXUS Layer-1 reference file (truth files: soul.md, memory.md, ' +
      'claude.md, agents.md, bot-glossary, arash-profile, projects, decisions, ' +
      'nexus-system). Use when the user asks about identity ("wer bin ich", ' +
      '"was steht in soul.md"), agent routing rules ("was sagt CLAUDE.md zu X"), ' +
      'bot inventory, or canonical project / decision state. Allowlisted — no ' +
      'arbitrary filesystem reads. Truncated at 8000 chars.',
    {
      name: z.enum(allowedNames).describe('Allowlisted L1 file alias.'),
    },
    async ({ name }) => {
      try {
        const filepath = L1_ALLOWLIST[name];
        if (!filepath) {
          return {
            content: [{ type: 'text' as const, text: `L1 alias "${name}" not in allowlist.` }],
            isError: true,
          };
        }
        if (!fs.existsSync(filepath)) {
          return {
            content: [{ type: 'text' as const, text: `L1 file "${name}" not available on disk (${filepath}).` }],
          };
        }
        const content = fs.readFileSync(filepath, 'utf-8');
        return {
          content: [{ type: 'text' as const, text: truncateForReply(content) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `read_l1 error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );
}

function nexusMemorySearchTool(_toolsCtx: McpToolsContext) {
  return tool(
    'nexusgram_memory_search',
    'Search NEXUS FTS5 memory database for past memories. Use when the user asks about identities (e.g. "wer ist Alina-Bot?"), prior decisions, project history, or any fact likely persisted earlier. Returns up to 5 (default) ranked matches, each with content snippet + tags + project + score. Privacy: only public memories are returned.',
    {
      query: z.string().min(1).describe('FTS5 search query, e.g. "alina bot family" or "nexusgram recovery plan"'),
      project: z.string().optional().describe('Filter by project tag (e.g. "nexus", "family"). Omit for cross-project search.'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (1–20, default 5).'),
    },
    async ({ query, project, limit }) => {
      try {
        const hits = searchMemoryReadOnly(query, limit ?? 5, project);
        if (hits.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No memories found for query "${query}"${project ? ` in project "${project}"` : ''}.` }],
          };
        }
        const formatted = hits.map((h, i) =>
          `[${i + 1}] (project=${h.project ?? '-'}, score=${h.score.toFixed(2)}, tags=${h.tags ?? '-'})\n${h.content}`
        ).join('\n\n---\n\n');
        return {
          content: [{ type: 'text' as const, text: `Found ${hits.length} memory hit${hits.length === 1 ? '' : 's'} for "${query}":\n\n${formatted}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Memory search error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );
}

