import assert from 'node:assert/strict';
import {
  evaluateMcpCapabilityHealth,
  MASTER_REQUIRED_MCP_SERVERS,
  mcpToolsSha256,
} from './capability-health.js';

const healthy = evaluateMcpCapabilityHealth({
  isMasterBot: true,
  servers: MASTER_REQUIRED_MCP_SERVERS.map((name) => ({ name, status: 'connected' })),
  tools: [
    'mcp__nexusgram-tools__nexusgram_memory_search',
    'mcp__nexus-mail__mail_search',
    'mcp__nexus-mail__mail_read',
    'mcp__workspace-google-rw__gmail_search',
  ],
  localMailAccountCount: 7,
});

assert.deepEqual(healthy.missingServers, []);
assert.equal(healthy.toolCountByServer['nexus-mail'], 2);
assert.equal(healthy.toolCountByServer['workspace-google-rw'], 1);
assert.equal(healthy.totalMasterMailAccountCount, 8);
assert.equal(
  mcpToolsSha256([
    'mcp__nexusgram-tools__nexusgram_memory_search',
    'Read',
    'mcp__nexus-mail__mail_search',
    'mcp__nexus-mail__mail_read',
    'mcp__nexus-mail__mail_read',
  ]),
  '2d77e255419043f3d5ecb0db938026457005b75e551500dfe947fda38dc7744a',
);

const degraded = evaluateMcpCapabilityHealth({
  isMasterBot: true,
  servers: [
    { name: 'nexusgram-tools', status: 'connected' },
    { name: 'nexus-mail', status: 'failed' },
  ],
  tools: [],
  localMailAccountCount: 7,
});

assert.deepEqual(degraded.missingServers, ['nexus-mail', 'workspace-google-rw']);
assert.equal(degraded.totalMasterMailAccountCount, 7);

const person = evaluateMcpCapabilityHealth({
  isMasterBot: false,
  servers: [{ name: 'nexus-mail', status: 'connected' }],
  tools: ['mcp__nexus-mail__mail_search'],
  localMailAccountCount: 1,
});

assert.deepEqual(person.requiredServers, []);
assert.deepEqual(person.missingServers, []);
