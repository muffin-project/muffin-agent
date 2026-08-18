import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMcpRegistry } from './registry.js';

describe('un token letterale in mcp.json scritto a mano (classe 3, ADR-0048)', () => {
  it('viene rifiutato dallo schema, non solo dal parser della CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-mcpreg-'));
    try {
      writeFileSync(
        join(dir, 'mcp.json'),
        JSON.stringify({
          schemaVersion: 1,
          servers: {
            gh: {
              command: 'npx',
              args: ['server'],
              env: { GITHUB_TOKEN: 'ghp_4A2b6C8d0E2f4G6h8I0j2K4l6M8n0O2p4Q6r' },
              approvedAt: new Date().toISOString(),
              tools: {},
            },
          },
        }),
      );
      expect(() => loadMcpRegistry(dir)).toThrow(/credenziale|secret:\/\//);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lascia passare la configurazione che non è un segreto', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-mcpreg-ok-'));
    try {
      writeFileSync(
        join(dir, 'mcp.json'),
        JSON.stringify({
          schemaVersion: 1,
          servers: {
            echo: {
              command: 'node',
              args: ['-e', ''],
              env: { LANG: 'C', MCP_MODE: 'strict' },
              approvedAt: new Date().toISOString(),
              tools: {},
            },
          },
        }),
      );
      expect(Object.keys(loadMcpRegistry(dir).servers)).toEqual(['echo']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
