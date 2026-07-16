import { z } from 'zod';
import type { McpToolsContext } from '../claude/mcp-tools.js';
export interface MailOverview {
    total: number;
    date_min: string | null;
    date_max: string | null;
    importance: Record<string, number>;
    tier: Record<string, number>;
    top_domains: Array<{
        domain: string;
        count: number;
    }>;
    outbox: Record<string, number>;
    newsletters_active: number;
    recent: Array<{
        date_utc: string;
        from_domain: string;
        importance: string;
        tier: string;
    }>;
}
/**
 * Read-only, column-allowlisted aggregation over the mail DB. Returns a redacted
 * MailOverview, or null on any error (fail-closed — caller shows a generic message,
 * never a schema/path leak). `recent` clamped to [0, 20]; 0 = no per-message list.
 */
export declare function mailOverviewReadOnly(recent?: number): MailOverview | null;
/**
 * The MCP tool wrapper. Operator (self_private) only; degraded for other scopes;
 * /private downgrades to unavailable. Returns ONLY redacted aggregates.
 */
export declare function mailOverviewTool(toolsCtx: McpToolsContext): import("@anthropic-ai/claude-agent-sdk").SdkMcpToolDefinition<{
    recent: z.ZodOptional<z.ZodNumber>;
}>;
//# sourceMappingURL=mail-readonly.d.ts.map