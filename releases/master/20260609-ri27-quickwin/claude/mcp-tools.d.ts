/**
 * MCP Tools — In-process MCP server factory for Nexusgram.
 *
 * Wraps existing standalone functions (reddit, medium, extract, telegraph,
 * project management) as MCP tools so Claude can invoke them automatically
 * based on conversation context instead of requiring explicit /commands.
 */
import { type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { type Context } from 'grammy';
export interface McpToolsContext {
    telegramCtx: Context;
    sessionKey: string;
}
export declare function createNexusgramMcpServer(toolsCtx: McpToolsContext): McpSdkServerConfigWithInstance;
//# sourceMappingURL=mcp-tools.d.ts.map