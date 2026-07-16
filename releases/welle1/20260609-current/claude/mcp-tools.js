/**
 * MCP Tools — In-process MCP server factory for Nexusgram.
 *
 * Wraps existing standalone functions (reddit, medium, extract, telegraph,
 * project management) as MCP tools so Claude can invoke them automatically
 * based on conversation context instead of requiring explicit /commands.
 */
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { InputFile } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { sessionManager } from './session-manager.js';
import { getWorkspaceRoot, isPathWithinRoot } from '../utils/workspace-guard.js';
import { searchMemoryReadOnly, recentMemoriesReadOnly, readMemoryPolicyFromEnv, searchTasks, searchPersonTimeline, searchEntities, } from '../memory/nexus-memory.js';
import { isPrivate } from '../memory/privacy-state.js';
import { mailOverviewTool } from '../memory/mail-readonly.js';
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
// ── Constants ────────────────────────────────────────────────────────
const REDDIT_MAX_CHARS = 50_000;
// ── Factory ──────────────────────────────────────────────────────────
export function createNexusgramMcpServer(toolsCtx) {
    const tools = buildToolList(toolsCtx);
    return createSdkMcpServer({
        name: 'nexusgram-tools',
        version: '1.0.0',
        tools,
    });
}
function buildToolList(toolsCtx) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = [
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
    // WAVE-1 Cross-Bot T1 (2026-06-03): recency listing (created_at DESC), no keyword.
    // Scope-gated like search; strictly honors /private (Codex P0-1).
    tools.push(nexusMemoryRecentTool(toolsCtx));
    // Phase 7.2 (2026-05-27): operator-private task index from omi-bridge-task.
    // Gated by NEXUS_MEMORY_SCOPE — Master ('self_private') gets full description,
    // Family/Test ('public') gets degraded "not available" description so the LLM
    // does not try to call it.
    tools.push(omiTaskSearchTool(toolsCtx));
    // Phase 7.5 (2026-05-27): operator-private person timeline + entity search
    // backed by NER mentions (Phase 7.3). Both gated same way as omi_task_search.
    // Codex pre-review: cross_review_phase-7-5-context-mcp-tools-architecture_2026-05-27.md (0.78)
    tools.push(omiPersonTimelineTool(toolsCtx));
    tools.push(omiEntitySearchTool(toolsCtx));
    // FIX 6+ Step 3 + Step 4 (2026-05-25): retrieval tools that the
    // Codex Pre-Review demanded be kept SEPARATE from nexusgram_memory_search
    // (different privacy model, different ranking, allowlisted reads only).
    tools.push(nexusgramInputLogSearchTool(toolsCtx));
    tools.push(nexusgramReadDailyTool(toolsCtx));
    tools.push(nexusgramReadL1Tool(toolsCtx));
    tools.push(mailOverviewTool(toolsCtx)); // P6: read-only mail overview (operator-gated, counts only)
    return tools;
}
// ── Tool Definitions ─────────────────────────────────────────────────
function listProjectsTool(_toolsCtx) {
    return tool('nexusgram_list_projects', 'List all available projects in the workspace directory. Use this to see what projects the user can switch to.', {}, async () => {
        try {
            const workspaceRoot = getWorkspaceRoot();
            const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
            const projects = entries
                .filter(e => e.isDirectory() && !e.name.startsWith('.'))
                .map(e => e.name);
            return {
                content: [{
                        type: 'text',
                        text: `Projects in ${workspaceRoot}:\n${projects.join('\n')}`,
                    }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Error listing projects: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
function switchProjectTool(toolsCtx) {
    return tool('nexusgram_switch_project', 'Switch the working directory to a different project. The change takes effect on the next query. Use nexusgram_list_projects first to see available projects.', { project_name: z.string().describe('Name of the project directory to switch to') }, async ({ project_name }) => {
        try {
            const workspaceRoot = getWorkspaceRoot();
            const targetPath = path.resolve(workspaceRoot, project_name);
            if (!isPathWithinRoot(workspaceRoot, targetPath)) {
                return {
                    content: [{ type: 'text', text: `Error: Path must be within workspace root: ${workspaceRoot}` }],
                    isError: true,
                };
            }
            if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
                return {
                    content: [{ type: 'text', text: `Error: Project not found: ${project_name}` }],
                    isError: true,
                };
            }
            sessionManager.setWorkingDirectory(toolsCtx.sessionKey, targetPath);
            return {
                content: [{
                        type: 'text',
                        text: `Switched to project: ${project_name} (${targetPath}). The new working directory will take effect on the next query.`,
                    }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Error switching project: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
function fetchRedditTool(_toolsCtx) {
    return tool('nexusgram_fetch_reddit', 'Fetch Reddit content: subreddit listings, post threads with comments, or user profiles. Supports sort/time filters for subreddits. Returns markdown-formatted results.', {
        target: z.string().describe('Reddit target: r/<subreddit>, u/<username>, post URL, post ID, or share link'),
        sort: z.enum(['hot', 'new', 'top', 'rising']).optional().describe('Sort order (default: hot). Semantic mappings: "trending"→hot, "latest"→new, "best"→top'),
        limit: z.number().optional().describe('Number of posts to fetch (default: 10)'),
        time_filter: z.enum(['day', 'week', 'month', 'year', 'all']).optional().describe('Time filter for top sort. Semantic: "today"→day, "this week"→week'),
        depth: z.number().optional().describe('Comment depth for post threads (default: 5)'),
    }, async ({ target, sort, limit, time_filter, depth }) => {
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
                content: [{ type: 'text', text: truncated }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Reddit fetch error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
function fetchMediumTool(_toolsCtx) {
    return tool('nexusgram_fetch_medium', 'Fetch a Medium article via Freedium (bypasses paywall). Returns the article title, author, and full markdown content.', {
        url: z.string().describe('Medium article URL (medium.com, towardsdatascience.com, etc.)'),
    }, async ({ url }) => {
        try {
            const { fetchMediumArticle, isMediumUrl } = await importMedium();
            if (!isMediumUrl(url)) {
                return {
                    content: [{ type: 'text', text: 'Error: URL does not appear to be a Medium article.' }],
                    isError: true,
                };
            }
            const article = await fetchMediumArticle(url);
            return {
                content: [{
                        type: 'text',
                        text: `# ${article.title}\n**By ${article.author}**\n\n${article.markdown}`,
                    }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Medium fetch error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
function extractMediaTool(toolsCtx) {
    return tool('nexusgram_extract_media', 'Extract text transcripts, audio, or video from YouTube, Instagram, and TikTok URLs. Audio/video files are sent directly to the user via Telegram. Transcripts are returned as text.', {
        url: z.string().describe('URL of the video (YouTube, Instagram, or TikTok)'),
        mode: z.enum(['text', 'audio', 'video', 'all']).describe('What to extract: "text" for transcript, "audio" for MP3, "video" for MP4, "all" for everything'),
    }, async ({ url, mode }) => {
        const { extractMedia, cleanupExtractResult } = await importExtract();
        let result;
        try {
            result = await extractMedia({ url, mode });
            const ctx = toolsCtx.telegramCtx;
            const parts = [];
            // Send media files to user via Telegram
            if (result.videoPath) {
                try {
                    await ctx.replyWithVideo(new InputFile(result.videoPath), {
                        caption: `📹 ${result.title}`,
                    });
                    parts.push('Video sent to user.');
                }
                catch (err) {
                    parts.push(`Video send failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (result.audioPath && (mode === 'audio' || mode === 'all')) {
                try {
                    await ctx.replyWithAudio(new InputFile(result.audioPath), {
                        caption: `🎵 ${result.title}`,
                    });
                    parts.push('Audio sent to user.');
                }
                catch (err) {
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
                content: [{ type: 'text', text: parts.join('\n\n') }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Media extraction error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
        finally {
            if (result) {
                cleanupExtractResult(result);
            }
        }
    });
}
function publishTelegraphTool(_toolsCtx) {
    return tool('nexusgram_publish_telegraph', 'Publish markdown content as a Telegraph (telegra.ph) Instant View page. Returns the URL. Useful for sharing long-form content as a readable link.', {
        title: z.string().describe('Page title'),
        markdown: z.string().describe('Markdown content for the page'),
    }, async ({ title, markdown }) => {
        try {
            const { createTelegraphPage } = await importTelegraph();
            const url = await createTelegraphPage(title, markdown);
            if (!url) {
                return {
                    content: [{ type: 'text', text: 'Failed to create Telegraph page.' }],
                    isError: true,
                };
            }
            return {
                content: [{ type: 'text', text: `Telegraph page created: ${url}` }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Telegraph error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
// ── Inbox Tools ───────────────────────────────────────────────────────
function inboxListTool(_toolsCtx) {
    return tool('nexusgram_inbox_list', 'List all files currently in the INBOX (unrouted documents received via Telegram). Shows filename, size, MIME type, date, and caption for each file.', {}, async () => {
        try {
            const { listInbox, getInboxStats, formatFileSize } = await importInbox();
            const items = listInbox();
            const stats = getInboxStats();
            if (items.length === 0) {
                return {
                    content: [{ type: 'text', text: 'INBOX is empty — no unrouted documents.' }],
                };
            }
            const lines = items.map((item, i) => {
                const caption = item.caption ? ` — "${item.caption}"` : '';
                return `${i + 1}. ${item.originalFilename} (${formatFileSize(item.fileSize)}, ${item.mimeType || 'unknown'})${caption}\n   Saved: ${item.savedFilename} | Received: ${item.receivedAt}`;
            });
            const summary = `INBOX: ${stats.totalFiles} file(s), ${stats.totalSizeMB} MB total\n\n${lines.join('\n\n')}`;
            return {
                content: [{ type: 'text', text: summary }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Inbox list error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
function inboxRouteTool(_toolsCtx) {
    return tool('nexusgram_inbox_route', 'Route (move) a file from the INBOX to a target directory within the workspace. Use nexusgram_inbox_list first to see available files.', {
        filename: z.string().describe('The saved filename in the INBOX (from nexusgram_inbox_list)'),
        target_dir: z.string().describe('Target directory path (relative to workspace root or absolute)'),
        new_name: z.string().optional().describe('Optional new filename after routing'),
    }, async ({ filename, target_dir, new_name }) => {
        try {
            const { getInboxDir, routeFile } = await importInbox();
            const inboxDir = getInboxDir();
            const filePath = path.join(inboxDir, filename);
            if (!fs.existsSync(filePath)) {
                return {
                    content: [{ type: 'text', text: `File not found in INBOX: ${filename}` }],
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
                    content: [{ type: 'text', text: `Error: Target must be within workspace root: ${workspaceRoot}` }],
                    isError: true,
                };
            }
            const { newPath } = routeFile(filePath, resolvedTarget, new_name);
            return {
                content: [{ type: 'text', text: `File routed: ${filename} → ${newPath}` }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Inbox route error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
// ── Send File Tool ────────────────────────────────────────────────────
function sendFileTool(toolsCtx) {
    return tool('nexusgram_send_file', 'Send a file from the workspace to the user via Telegram. The file must be within the workspace root. Use this to share project files, generated reports, or any file the user requests.', {
        file_path: z.string().describe('Path to the file (relative to workspace root or absolute)'),
        caption: z.string().optional().describe('Optional caption to send with the file'),
    }, async ({ file_path, caption }) => {
        try {
            const workspaceRoot = getWorkspaceRoot();
            const resolvedPath = path.isAbsolute(file_path)
                ? file_path
                : path.resolve(workspaceRoot, file_path);
            if (!isPathWithinRoot(workspaceRoot, resolvedPath)) {
                return {
                    content: [{ type: 'text', text: `Error: File must be within workspace root: ${workspaceRoot}` }],
                    isError: true,
                };
            }
            if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
                return {
                    content: [{ type: 'text', text: `File not found: ${file_path}` }],
                    isError: true,
                };
            }
            const stats = fs.statSync(resolvedPath);
            const sizeMB = stats.size / (1024 * 1024);
            // Standard API: 50MB send limit. Local API server: 2GB.
            const maxSendMB = config.TELEGRAM_API_SERVER_URL ? 2000 : 50;
            if (sizeMB > maxSendMB) {
                return {
                    content: [{ type: 'text', text: `File too large (${sizeMB.toFixed(1)} MB). Limit is ${maxSendMB} MB.` }],
                    isError: true,
                };
            }
            const ctx = toolsCtx.telegramCtx;
            const filename = path.basename(resolvedPath);
            await ctx.replyWithDocument(new InputFile(resolvedPath, filename), {
                caption: caption || undefined,
            });
            return {
                content: [{ type: 'text', text: `File sent to user: ${filename} (${sizeMB < 1 ? `${(stats.size / 1024).toFixed(1)} KB` : `${sizeMB.toFixed(1)} MB`})` }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Send file error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
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
function nexusgramInputLogSearchTool(toolsCtx) {
    return tool('nexusgram_input_log_search', 'Search past Telegram inputs (text, voice transcripts, photo captions) ' +
        'INCLUDING dropped or failed inputs. Use when the user refers to ' +
        'something they sent earlier ("hab ich dir gesagt", "letzte ' +
        'Sprachnachricht", "vorher hab ich…"). Returns matching input-log rows ' +
        'with snippet, status (received/processing/done/dropped/error), ' +
        'drop reason, timestamp. Scope: this Telegram session only.', {
        query: z.string().min(1).describe('FTS5 search query, e.g. "ChatGPT briefing" or "Apple Watch"'),
        since: z.string().optional().describe('ISO date floor (e.g. "2026-05-20T00:00:00Z"). Omit for all-time.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (1-50, default 10).'),
    }, async ({ query, since, limit }) => {
        try {
            const sessionKey = toolsCtx.sessionKey;
            const rows = searchInputLog({ query, sessionKey, since, limit });
            if (rows.length === 0) {
                return {
                    content: [{
                            type: 'text',
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
                        type: 'text',
                        text: `Found ${rows.length} input-log row${rows.length === 1 ? '' : 's'} for "${query}":\n\n${lines.join('\n\n')}`,
                    }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Input-log search error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
// ── FIX 6+ Step 4 (2026-05-25): allowlisted L1 reads ─────────────────────────
//
// Codex Pre-Review §2: no arbitrary read_file(path). The bot gets two narrow,
// allowlisted entry points so it can answer "what does soul.md say about X"
// or "what was in the daily log on 2026-05-22" WITHOUT a full filesystem tool.
const DAILY_LOG_DIR = '/Volumes/AstronOne/NEXUS_miniM_13-03-26/.nexus-memory/daily';
const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_L1_CHARS = 8000; // allow-hardcoded: reason="Telegram-bubble safety cap for L1 reads, not a timeout"
function truncateForReply(content) {
    if (content.length <= MAX_L1_CHARS)
        return content;
    return content.slice(0, MAX_L1_CHARS) + '\n\n…[truncated — file longer than allowed]';
}
function nexusgramReadDailyTool(toolsCtx) {
    // Phase 7.5 Privacy fix (2026-05-27): NEXUS daily-logs are operator-private
    // journal entries (mention Simone/Yeva/Alina/colleagues/health/finances).
    // Family/Test/public bots must NOT read them. /private on must also gate
    // them. Boot-time gate + per-turn /private check mirror omi_task_search.
    const bootPolicy = readMemoryPolicyFromEnv();
    const safePolicy = bootPolicy.scope === 'operator_all'
        ? { ...bootPolicy, scope: 'public' }
        : bootPolicy;
    const isOperator = safePolicy.scope === 'self_private' &&
        safePolicy.trustedPrivateSources.includes('omi-bridge');
    const description = isOperator
        ? 'Read a NEXUS daily log by date (YYYY-MM-DD). Use when the user asks ' +
            'about a specific day ("wann haben wir X gemacht", "was war am ' +
            'Sonntag", "schau in den Daily von gestern"). Returns the markdown ' +
            'content, optionally a single ## section. Truncated at 8000 chars. ' +
            'Not available in family/test/public scope or while /private is on.'
        : 'NEXUS daily log access. Not available in this bot context.';
    return tool('nexusgram_read_daily', description, {
        date: z.string().describe('Date in YYYY-MM-DD format (e.g. "2026-05-25").'),
        section: z.string().optional().describe('Optional ## or ### section header to extract (e.g. "Apple Watch 4 Setup").'),
    }, async ({ date, section }) => {
        try {
            // Per-turn scope-gate: fail-closed for non-operator + /private on
            const sessionIsPrivate = toolsCtx ? isPrivate(toolsCtx.sessionKey) : false;
            if (!isOperator || sessionIsPrivate) {
                const reason = !isOperator
                    ? 'daily-log access not exposed in this bot scope'
                    : 'daily-log access is intentionally unavailable while /private is on — turn /private off to query';
                return { content: [{ type: 'text', text: `Daily log unavailable (${reason}).` }] };
            }
            if (!DAILY_DATE_REGEX.test(date)) {
                return {
                    content: [{ type: 'text', text: `Invalid date "${date}" — expected YYYY-MM-DD.` }],
                    isError: true,
                };
            }
            const filename = `${date}.md`;
            const filepath = path.join(DAILY_LOG_DIR, filename);
            // Defense-in-depth: ensure resolved path stays inside DAILY_LOG_DIR.
            const resolved = path.resolve(filepath);
            if (!resolved.startsWith(path.resolve(DAILY_LOG_DIR) + path.sep)) {
                return {
                    content: [{ type: 'text', text: `Path traversal blocked for "${date}".` }],
                    isError: true,
                };
            }
            if (!fs.existsSync(resolved)) {
                return {
                    content: [{ type: 'text', text: `No daily log found for ${date}.` }],
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
                const sectionRegex = new RegExp(`^(##+\\s+[^\\n]*${escSection}[^\\n]*\\n[\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'im');
                const match = content.match(sectionRegex);
                if (match)
                    content = match[1];
                else
                    content = `Section "${section}" not found in daily ${date}.\n\n--- Full file ---\n\n${content}`;
            }
            return {
                content: [{ type: 'text', text: truncateForReply(content) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `read_daily error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
// Layer-1 reference files. Allowlist only — Codex Pre-Review explicitly
// forbade arbitrary read_file(path). Each entry must point to a stable,
// agent-readable truth file. Missing files surface as "L1 file not available".
const L1_ALLOWLIST = {
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
function nexusgramReadL1Tool(toolsCtx) {
    // Phase 7.5 Privacy fix (2026-05-27): L1 truth-files include arash-profile,
    // MEMORY.md, decisions/projects/bot-glossary — all operator-private context.
    // Same scope-gate as nexusgram_read_daily.
    const bootPolicy = readMemoryPolicyFromEnv();
    const safePolicy = bootPolicy.scope === 'operator_all'
        ? { ...bootPolicy, scope: 'public' }
        : bootPolicy;
    const isOperator = safePolicy.scope === 'self_private' &&
        safePolicy.trustedPrivateSources.includes('omi-bridge');
    const allowedNames = Object.keys(L1_ALLOWLIST);
    const description = isOperator
        ? 'Read a NEXUS Layer-1 reference file (truth files: soul.md, memory.md, ' +
            'claude.md, agents.md, bot-glossary, arash-profile, projects, decisions, ' +
            'nexus-system). Use when the user asks about identity ("wer bin ich", ' +
            '"was steht in soul.md"), agent routing rules ("was sagt CLAUDE.md zu X"), ' +
            'bot inventory, or canonical project / decision state. Allowlisted — no ' +
            'arbitrary filesystem reads. Truncated at 8000 chars. ' +
            'Not available in family/test/public scope or while /private is on.'
        : 'NEXUS Layer-1 reference files. Not available in this bot context.';
    return tool('nexusgram_read_l1', description, {
        name: z.enum(allowedNames).describe('Allowlisted L1 file alias.'),
    }, async ({ name }) => {
        try {
            // Per-turn scope-gate: fail-closed for non-operator + /private on
            const sessionIsPrivate = toolsCtx ? isPrivate(toolsCtx.sessionKey) : false;
            if (!isOperator || sessionIsPrivate) {
                const reason = !isOperator
                    ? 'L1 reference access not exposed in this bot scope'
                    : 'L1 reference access is intentionally unavailable while /private is on — turn /private off to query';
                return { content: [{ type: 'text', text: `L1 file unavailable (${reason}).` }] };
            }
            const filepath = L1_ALLOWLIST[name];
            if (!filepath) {
                return {
                    content: [{ type: 'text', text: `L1 alias "${name}" not in allowlist.` }],
                    isError: true,
                };
            }
            if (!fs.existsSync(filepath)) {
                return {
                    content: [{ type: 'text', text: `L1 file "${name}" not available on disk (${filepath}).` }],
                };
            }
            const content = fs.readFileSync(filepath, 'utf-8');
            return {
                content: [{ type: 'text', text: truncateForReply(content) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `read_l1 error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
function nexusMemorySearchTool(toolsCtx) {
    const bootPolicy = readMemoryPolicyFromEnv();
    // operator_all downgrades to public for MCP (consistent with nexus_memory_recent / omi_task_search)
    const safePolicy = bootPolicy.scope === 'operator_all'
        ? { ...bootPolicy, scope: 'public' }
        : bootPolicy;
    return tool('nexusgram_memory_search', 'Keyword-search the SHARED NEXUS memory (FTS5) BEFORE asking the user to repeat themselves. ' +
        'USE THIS FIRST whenever the user implies you should already know something: ' +
        '"hab ich dir doch gesagt", "hab ich dir doch geschickt", "did I already tell you", ' +
        '"wie ich erwähnt habe", "wie ich dir gesagt habe", "haben wir besprochen", "we discussed this", ' +
        '"der Link / die Nummer / die Adresse die ich dir gegeben habe", "the link/number I gave you", ' +
        '"letztes Mal", "weißt du noch", "wie ich dir geschickt habe", identities ("wer ist Alina-Bot?"), ' +
        'prior decisions, project history, or ANY fact likely saved in an earlier session. ' +
        'Do NOT re-ask the user before you have searched here. If you have a keyword, use this; ' +
        'for the latest items without a keyword use nexus_memory_recent; for raw Telegram inputs ' +
        '(incl. dropped) use nexusgram_input_log_search. Returns up to 5 (default, max 20) ranked ' +
        'matches: content snippet + tags + project + score. ' +
        'Privacy is scope-gated server-side: public scope returns public memories only; ' +
        'Master self_private scope may also return trusted operator-private memories; ' +
        '/private mode downgrades this tool to public-only.', {
        query: z.string().min(1).describe('FTS5 search query, e.g. "alina bot family" or "nexusgram recovery plan"'),
        project: z.string().optional().describe('Filter by project tag (e.g. "nexus", "family"). Omit for cross-project search.'),
        limit: z.number().int().min(1).max(20).optional().describe('Max results (1–20, default 5).'),
    }, async ({ query, project, limit }) => {
        try {
            // P0-1 / fast-follow: per-turn /private on → public-only; never lean on the helper's env default
            const sessionIsPrivate = isPrivate(toolsCtx.sessionKey);
            const effectivePolicy = sessionIsPrivate
                ? { ...safePolicy, scope: 'public' }
                : safePolicy;
            const hits = searchMemoryReadOnly(query, limit ?? 5, project, { policy: effectivePolicy });
            if (hits.length === 0) {
                return {
                    content: [{ type: 'text', text: `No memories found for query "${query}"${project ? ` in project "${project}"` : ''}.` }],
                };
            }
            const formatted = hits.map((h, i) => `[${i + 1}] (project=${h.project ?? '-'}, score=${h.score.toFixed(2)}, tags=${h.tags ?? '-'})\n${h.content}`).join('\n\n---\n\n');
            return {
                content: [{ type: 'text', text: `Found ${hits.length} memory hit${hits.length === 1 ? '' : 's'} for "${query}":\n\n${formatted}` }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Memory search error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
// WAVE-1 Cross-Bot T1 (2026-06-03): keyword-less recency listing. Mirrors the strict
// OMI privacy pattern (omi_task_search :997) — operator_all → public for MCP, and a
// per-turn /private on → public downgrade (Codex P0-1). Unlike nexusgram_memory_search,
// this handler DOES use toolsCtx and honors /private, because keyword-less enumeration
// of private rows is the higher-risk path.
function nexusMemoryRecentTool(toolsCtx) {
    const bootPolicy = readMemoryPolicyFromEnv();
    // operator_all downgrades to public for MCP (consistent with omi_task_search / nexus_memory_search)
    const safePolicy = bootPolicy.scope === 'operator_all'
        ? { ...bootPolicy, scope: 'public' }
        : bootPolicy;
    return tool('nexus_memory_recent', 'List the most RECENT NEXUS shared-memory entries (newest first, by created_at) — ' +
        'no keyword needed. USE THIS when the user asks "was haben wir zuletzt besprochen", ' +
        '"what did we save recently", "letzte Notizen", "neueste Memories", "zeig mir die letzten ' +
        'Einträge", or when you need fresh cross-session context but have NO specific search term — ' +
        'recall BEFORE asking the user to repeat. For a keyword/topic lookup use ' +
        'nexusgram_memory_search instead; for raw Telegram inputs use nexusgram_input_log_search. ' +
        'Returns up to 5 (default, max 20) entries: content snippet + tags + project + score + created_at. ' +
        'Privacy is scope-gated server-side: public scope returns public memories only; ' +
        'Master self_private scope may also return trusted operator-private memories; ' +
        '/private mode downgrades this tool to public-only.', {
        limit: z.number().int().min(1).max(20).optional().describe('Max entries (1–20, default 5).'),
        project: z.string().optional().describe('Filter by project tag (e.g. "nexus", "family"). Omit for cross-project.'),
    }, async ({ limit, project }) => {
        try {
            // P0-1: per-turn /private on → public-only; never lean on the helper's env default
            const sessionIsPrivate = isPrivate(toolsCtx.sessionKey);
            const effectivePolicy = sessionIsPrivate
                ? { ...safePolicy, scope: 'public' }
                : safePolicy;
            const hits = recentMemoriesReadOnly(limit ?? 5, project, { policy: effectivePolicy });
            if (hits.length === 0) {
                return {
                    content: [{ type: 'text', text: `No recent memories found${project ? ` in project "${project}"` : ''}.` }],
                };
            }
            const formatted = hits.map((h, i) => `[${i + 1}] ${h.created_at} (project=${h.project ?? '-'}, score=${h.score.toFixed(2)}, tags=${h.tags ?? '-'})\n${h.content}`).join('\n\n---\n\n');
            return {
                content: [{ type: 'text', text: `${hits.length} most recent memor${hits.length === 1 ? 'y' : 'ies'}:\n\n${formatted}` }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Recent memory error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
// ── Phase 7.5 — Context MCP-Tools (Person Timeline + Entity Search) ─────────
// Codex pre-review: cross_review_phase-7-5-context-mcp-tools-architecture_2026-05-27.md (0.78)
//
// Both tools share the omi_task_search pattern:
//   1. read boot policy + downgrade operator_all → public for MCP
//   2. compute isOperator at boot for gated description (so the LLM does not try
//      to call when unavailable)
//   3. per-turn override: if /private on → effectivePolicy.scope='public' → 0 hits
//   4. service function (searchPersonTimeline / searchEntities) enforces
//      privacy gate again — fail-closed in the helper, NOT in the tool wrapper
function formatTimelineLine(hit, i) {
    const date = hit.source_created_at_utc ? hit.source_created_at_utc.slice(0, 16).replace('T', ' ') : 'unknown';
    const kindLabel = hit.source_kind === 'omi_memories' ? 'OMI memory'
        : hit.source_kind === 'omi_transcription_segments' ? 'OMI segment'
            : 'memory.db';
    return `[${i + 1}] ${date} ${kindLabel} (${hit.field_name}): ${hit.snippet}`;
}
function omiPersonTimelineTool(toolsCtx) {
    const bootPolicy = readMemoryPolicyFromEnv();
    const safePolicy = bootPolicy.scope === 'operator_all'
        ? { ...bootPolicy, scope: 'public' }
        : bootPolicy;
    const isOperator = safePolicy.scope === 'self_private' &&
        safePolicy.trustedPrivateSources.includes('omi-bridge');
    const description = isOperator
        ? 'Search Arash\'s local operator-private person timeline (OMI memories + segments + memory.db, joined via Apple-NL NER mentions). Use when the user asks "wann letztes Mal mit Y", "welche Meetings mit Simone", "was gab es mit Kira diese Woche", or asks for chronological mentions of a SPECIFIC person. Returns dated source snippets. Default: last 30 days, 10 results, max 20. Not available in family/test/public scope or while /private is on. For "mit wem habe ich am 17.04. gesprochen?" use omi_entity_search instead (it accepts an empty query + date window).'
        : 'Operator-private person timeline. Not available in this bot context (returns 0 results).';
    return tool('omi_person_timeline', description, {
        person: z.string().describe('Person name (canonical or alias). Examples: "Simone", "Kira", "Tim Zähres".'),
        from: z.string().optional().describe('ISO date floor, e.g. "2026-04-17T00:00:00Z". Omit to default to last 30 days.'),
        to: z.string().optional().describe('ISO date ceiling.'),
        limit: z.number().int().min(1).max(20).optional().describe('Max results (1-20, default 10).'),
    }, async ({ person, from, to, limit }) => {
        try {
            const sessionIsPrivate = isPrivate(toolsCtx.sessionKey);
            const effectivePolicy = sessionIsPrivate
                ? { ...safePolicy, scope: 'public' }
                : safePolicy;
            const result = searchPersonTimeline({ person, from, to, limit, policy: effectivePolicy });
            if (result.scope_denied) {
                const reason = !isOperator
                    ? 'person timeline not exposed in this bot scope'
                    : sessionIsPrivate
                        ? 'person timeline is intentionally unavailable while /private is on — turn /private off to query stored context'
                        : 'scope denied';
                return { content: [{ type: 'text', text: `No timeline results (${reason}).` }] };
            }
            if (result.resolution.status === 'ignored') {
                return { content: [{ type: 'text', text: `"${person}" is marked as an ignored Apple-NL false-positive (not a real person in our index).` }] };
            }
            if (!result.resolution.personId) {
                if (result.resolution.suggestions.length > 0) {
                    const sugg = result.resolution.suggestions.map(s => `${s.label} (${s.mention_count}×${s.source === 'unresolved' ? ' unresolved' : ''})`).join(', ');
                    return { content: [{ type: 'text', text: `No exact match for "${person}". Did you mean: ${sugg}?` }] };
                }
                return { content: [{ type: 'text', text: `No person matches "${person}" in the index. Try omi_entity_search for free-text lookup.` }] };
            }
            if (result.hits.length === 0) {
                return { content: [{ type: 'text', text: `0 timeline hits for "${result.resolution.canonicalName}" in the requested window.` }] };
            }
            const header = `Found ${result.hits.length} timeline hit${result.hits.length === 1 ? '' : 's'} for ${result.resolution.canonicalName}${result.more_available ? ' (more_available=true)' : ''}:`;
            const body = result.hits.map(formatTimelineLine).join('\n');
            return { content: [{ type: 'text', text: `${header}\n\n${body}` }] };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Person timeline error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
function formatEntityLine(hit, i) {
    const date = hit.source_created_at_utc ? hit.source_created_at_utc.slice(0, 16).replace('T', ' ') : 'unknown';
    const kindLabel = hit.source_kind === 'omi_memories' ? 'OMI memory'
        : hit.source_kind === 'omi_transcription_segments' ? 'OMI segment'
            : 'memory.db';
    const resolvedTag = hit.resolved_canonical_name ? `→${hit.resolved_canonical_name}` : '(unresolved)';
    return `[${i + 1}] ${date} ${kindLabel} ${hit.entity_kind} "${hit.canonical_text}"${resolvedTag}: ${hit.snippet}`;
}
function omiEntitySearchTool(toolsCtx) {
    const bootPolicy = readMemoryPolicyFromEnv();
    const safePolicy = bootPolicy.scope === 'operator_all'
        ? { ...bootPolicy, scope: 'public' }
        : bootPolicy;
    const isOperator = safePolicy.scope === 'self_private' &&
        safePolicy.trustedPrivateSources.includes('omi-bridge');
    const description = isOperator
        ? 'Search Arash\'s local operator-private entity mentions (persons + organizations + places) extracted from OMI + memory.db via Apple-NL NER. Use when the user asks "was hat sich diese Woche bei DexHub getan", "mit wem habe ich am 17.04. gesprochen" (query empty + date), "alle Erwähnungen von Aura". Returns dated source snippets. When `query` is omitted AND a date window is given, the tool returns the TOP entities in that window grouped by canonical/resolved entity. Resolved seed-persons collapse aliases; unresolved canonicals are also surfaced (Codex P0-5). Not available in family/test/public scope or while /private is on.'
        : 'Operator-private entity index. Not available in this bot context (returns 0 results).';
    return tool('omi_entity_search', description, {
        query: z.string().optional().describe('Free-text query against alias/canonical/unresolved-text. OPTIONAL when from/to is provided (returns top entities in window).'),
        entity_kind: z.enum(['person', 'organization', 'place', 'any']).optional().describe('Filter by entity kind (default: any).'),
        from: z.string().optional().describe('ISO date floor, e.g. "2026-04-17T00:00:00Z".'),
        to: z.string().optional().describe('ISO date ceiling.'),
        limit: z.number().int().min(1).max(20).optional().describe('Max results (1-20, default 10).'),
    }, async ({ query, entity_kind, from, to, limit }) => {
        try {
            const sessionIsPrivate = isPrivate(toolsCtx.sessionKey);
            const effectivePolicy = sessionIsPrivate
                ? { ...safePolicy, scope: 'public' }
                : safePolicy;
            const result = searchEntities({ query, entity_kind, from, to, limit, policy: effectivePolicy });
            if (result.scope_denied) {
                const reason = !isOperator
                    ? 'entity search not exposed in this bot scope'
                    : sessionIsPrivate
                        ? 'entity search is intentionally unavailable while /private is on — turn /private off to query stored context'
                        : 'scope denied';
                return { content: [{ type: 'text', text: `No entity results (${reason}).` }] };
            }
            // Aggregation branch: empty query + window
            if (!query && (from || to) && result.top_entities_in_window.length > 0) {
                const winLabel = `${from ?? '*'}..${to ?? '*'}`;
                const kindLabel = entity_kind && entity_kind !== 'any' ? ` ${entity_kind}s` : ' entities';
                const lines = result.top_entities_in_window.map((e, i) => {
                    const label = e.resolved_canonical_name ?? e.canonical_text;
                    const tag = e.resolved_canonical_name ? '' : ' (unresolved)';
                    return `[${i + 1}] ${label} (${e.entity_kind}) — ${e.mention_count} mention${e.mention_count === 1 ? '' : 's'}${tag}`;
                });
                return { content: [{ type: 'text', text: `Top${kindLabel} in window ${winLabel}:\n\n${lines.join('\n')}` }] };
            }
            if (result.hits.length === 0) {
                const qLabel = query ?? '(empty)';
                return { content: [{ type: 'text', text: `0 entity hits for query="${qLabel}" kind=${entity_kind ?? 'any'} from=${from ?? '*'} to=${to ?? '*'}.` }] };
            }
            const header = `Found ${result.hits.length} entity hit${result.hits.length === 1 ? '' : 's'} for query="${query ?? '(empty)'}"${result.more_available ? ' (more_available=true)' : ''}:`;
            const body = result.hits.map(formatEntityLine).join('\n');
            return { content: [{ type: 'text', text: `${header}\n\n${body}` }] };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Entity search error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
function omiTaskSearchTool(toolsCtx) {
    const bootPolicy = readMemoryPolicyFromEnv();
    // operator_all downgrades to public for MCP (consistent with nexus_memory_search)
    const safePolicy = bootPolicy.scope === 'operator_all'
        ? { ...bootPolicy, scope: 'public' }
        : bootPolicy;
    const isOperator = safePolicy.scope === 'self_private' &&
        safePolicy.trustedPrivateSources.includes('omi-bridge-task');
    const description = isOperator
        ? 'Search Arash\'s operator-private task index (OMI action_items + staged_tasks). Use when the user asks "what are my todos this week", "open tasks", "what did I have to do for X", or any deadline/priority/category query. Returns structured rows with description + due_at_utc + priority + category + completed flag + age_days. Default: open tasks only, sorted by due date asc then priority. Do NOT use for general memory search — use nexusgram_memory_search for that.'
        : 'Operator-private task index. Not available in this bot context (returns 0 results).';
    return tool('omi_task_search', description, {
        status: z.enum(['open', 'completed', 'all']).optional().describe('Filter by task status (default: open).'),
        from: z.string().optional().describe('ISO date floor for due_at_utc, e.g. "2026-05-27T00:00:00Z".'),
        to: z.string().optional().describe('ISO date ceiling for due_at_utc, e.g. "2026-06-03T23:59:59Z".'),
        priority: z.enum(['high', 'medium', 'low']).optional().describe('Filter by priority.'),
        category: z.string().optional().describe('Filter by category tag (e.g. "work", "personal").'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (1-50, default 20).'),
    }, async ({ status, from, to, priority, category, limit }) => {
        try {
            const sessionIsPrivate = isPrivate(toolsCtx.sessionKey);
            const effectivePolicy = sessionIsPrivate
                ? { ...safePolicy, scope: 'public' }
                : safePolicy;
            const hits = searchTasks({
                status, from, to, priority, category, limit,
                policy: effectivePolicy,
            });
            if (hits.length === 0) {
                const reason = !isOperator
                    ? 'task index not exposed in this bot scope'
                    : sessionIsPrivate
                        ? 'persisted task search is intentionally unavailable while /private is on — turn /private off to query stored tasks'
                        : 'no matching tasks';
                return {
                    content: [{ type: 'text', text: `No tasks found (${reason}).` }],
                };
            }
            const lines = hits.map((t, i) => {
                const due = t.due_at_utc ? t.due_at_utc.slice(0, 16).replace('T', ' ') : 'no due';
                const prio = t.priority ?? '-';
                const cat = t.category ?? '-';
                const completed = t.completed ? '✓ ' : '  ';
                const age = t.age_days != null ? ` ${t.age_days}d` : '';
                return `[${i + 1}] ${completed}due=${due} prio=${prio} cat=${cat}${age}\n    ${t.description}`;
            });
            const statusLabel = status ?? 'open';
            return {
                content: [{
                        type: 'text',
                        text: `Found ${hits.length} task${hits.length === 1 ? '' : 's'} (status=${statusLabel}):\n\n${lines.join('\n\n')}`,
                    }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `Task search error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=mcp-tools.js.map