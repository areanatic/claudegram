/**
 * Runtime capability truth for the Master bot.
 *
 * Configuration is only intent.  This module evaluates the SDK's observed
 * MCP init event, so a missing server is surfaced instead of silently making
 * the model guess that a capability exists.
 */

import { createHash } from 'node:crypto';

export const MASTER_REQUIRED_MCP_SERVERS = [
  'nexusgram-tools',
  'nexus-mail',
  'workspace-google-rw',
] as const;

export interface ObservedMcpServer {
  name: string;
  status: string;
}

export interface McpCapabilityHealth {
  requiredServers: readonly string[];
  connectedServers: string[];
  missingServers: string[];
  toolCountByServer: Record<string, number>;
  totalMcpTools: number;
  localMailAccountCount: number | null;
  totalMasterMailAccountCount: number | null;
}

export function countMcpToolsByServer(
  servers: readonly ObservedMcpServer[],
  tools: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const server of servers) {
    counts[server.name] = tools.filter((tool) => tool.startsWith(`mcp__${server.name}__`)).length;
  }
  return counts;
}

/**
 * Stable proof for the complete observed MCP tool set.  The trailing newline
 * intentionally matches the Welle-0 contract generator's canonical format.
 */
export function mcpToolsSha256(tools: readonly string[]): string {
  const sortedMcpTools = [...new Set(tools.filter((tool) => tool.startsWith('mcp__')))].sort();
  return createHash('sha256')
    .update(`${sortedMcpTools.join('\n')}\n`, 'utf8')
    .digest('hex');
}

export function evaluateMcpCapabilityHealth(input: {
  isMasterBot: boolean;
  servers: readonly ObservedMcpServer[];
  tools: readonly string[];
  localMailAccountCount: number | null;
}): McpCapabilityHealth {
  const connectedServers = input.servers
    .filter((server) => server.status === 'connected')
    .map((server) => server.name);
  const requiredServers = input.isMasterBot ? MASTER_REQUIRED_MCP_SERVERS : [];
  const missingServers = requiredServers.filter((server) => !connectedServers.includes(server));
  const workspaceConnected = connectedServers.includes('workspace-google-rw');

  return {
    requiredServers,
    connectedServers,
    missingServers,
    toolCountByServer: countMcpToolsByServer(input.servers, input.tools),
    totalMcpTools: input.tools.filter((tool) => tool.startsWith('mcp__')).length,
    localMailAccountCount: input.localMailAccountCount,
    // mastor.prime is intentionally a separate OAuth account, not an IMAP
    // registry entry. Count it only after its server actually connected.
    totalMasterMailAccountCount: input.localMailAccountCount == null
      ? null
      : input.localMailAccountCount + (workspaceConnected ? 1 : 0),
  };
}
