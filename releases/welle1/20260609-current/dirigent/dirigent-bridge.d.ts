import { z } from 'zod';
import type { McpToolsContext } from '../claude/mcp-tools.js';
export declare function dirigentDispatchTool(toolsCtx: McpToolsContext): import("@anthropic-ai/claude-agent-sdk").SdkMcpToolDefinition<{
    prompt: z.ZodString;
    task_type: z.ZodOptional<z.ZodEnum<{
        adhoc: "adhoc";
        "code-audit": "code-audit";
        "morning-brief": "morning-brief";
        "ask-chat": "ask-chat";
    }>>;
    priority: z.ZodOptional<z.ZodNumber>;
}>;
export declare function dirigentStatusTool(_toolsCtx: McpToolsContext): import("@anthropic-ai/claude-agent-sdk").SdkMcpToolDefinition<{
    task_id: z.ZodString;
}>;
//# sourceMappingURL=dirigent-bridge.d.ts.map