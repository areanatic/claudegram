#!/usr/bin/env npx tsx
/**
 * Debug utility for testing long-running agent queries with watchdog.
 *
 * Usage:
 *   # Basic test with default project
 *   CLAUDE_SDK_LOG_LEVEL=basic npx tsx src/utils/debug-agent.ts
 *
 *   # Test with specific project directory
 *   CLAUDE_SDK_LOG_LEVEL=basic npx tsx src/utils/debug-agent.ts /path/to/project
 *
 *   # Test with shorter warning threshold
 *   AGENT_WATCHDOG_WARN_SECONDS=10 CLAUDE_SDK_LOG_LEVEL=basic npx tsx src/utils/debug-agent.ts
 *
 *   # Test with hard timeout
 *   AGENT_QUERY_TIMEOUT_MS=60000 CLAUDE_SDK_LOG_LEVEL=basic npx tsx src/utils/debug-agent.ts
 */
export {};
//# sourceMappingURL=debug-agent.d.ts.map