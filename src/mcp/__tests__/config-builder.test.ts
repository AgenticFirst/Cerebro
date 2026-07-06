import { describe, it, expect } from 'vitest';
import { buildMcpRunConfig } from '../config-builder';

describe('buildMcpRunConfig', () => {
  it('builds stdio entries with ${VAR} env placeholders, values only in the overlay', () => {
    const { mcpServers, env } = buildMcpRunConfig([
      {
        slug: 'my-tool',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'some-server'],
        env: { API_KEY: 'sk-secret' },
      },
    ]);
    expect(mcpServers['my-tool']).toEqual({
      command: 'npx',
      args: ['-y', 'some-server'],
      env: { API_KEY: '${CEREBRO_MCP_MY_TOOL_API_KEY}' },
    });
    expect(env.CEREBRO_MCP_MY_TOOL_API_KEY).toBe('sk-secret');
    // The literal secret must never appear in the config JSON itself.
    expect(JSON.stringify(mcpServers)).not.toContain('sk-secret');
  });

  it('builds http entries with a Bearer placeholder for managed tokens', () => {
    const { mcpServers, env } = buildMcpRunConfig([
      {
        slug: 'gdrive',
        transport: 'http',
        url: 'https://drivemcp.googleapis.com/mcp/v1',
        bearerToken: 'ya29.token',
      },
    ]);
    expect(mcpServers.gdrive).toEqual({
      type: 'http',
      url: 'https://drivemcp.googleapis.com/mcp/v1',
      headers: { Authorization: 'Bearer ${CEREBRO_MCP_GDRIVE_TOKEN}' },
    });
    expect(env.CEREBRO_MCP_GDRIVE_TOKEN).toBe('ya29.token');
    expect(JSON.stringify(mcpServers)).not.toContain('ya29.token');
  });

  it('routes custom http headers through placeholders too', () => {
    const { mcpServers, env } = buildMcpRunConfig([
      {
        slug: 'internal',
        transport: 'http',
        url: 'https://mcp.example.com',
        headers: { 'X-Api-Key': 'k-123' },
      },
    ]);
    const entry = mcpServers.internal as { headers?: Record<string, string> };
    expect(entry.headers?.['X-Api-Key']).toBe('${CEREBRO_MCP_INTERNAL_X_API_KEY}');
    expect(env.CEREBRO_MCP_INTERNAL_X_API_KEY).toBe('k-123');
  });

  it('skips malformed entries instead of emitting broken config', () => {
    const { mcpServers } = buildMcpRunConfig([
      { slug: 'no-cmd', transport: 'stdio' },
      { slug: 'no-url', transport: 'http' },
    ]);
    expect(Object.keys(mcpServers)).toEqual([]);
  });
});
