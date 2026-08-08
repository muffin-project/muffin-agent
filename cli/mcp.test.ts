import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadMcpRegistry } from '../core/mcp/registry.js';
import { cmdMcpAdd, cmdMcpList, cmdMcpRemove } from './mcp.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'core',
  'mcp',
  'fixtures',
  'echo-server.mjs',
);

/**
 * The whole owner flow against the real fixture server: approve, audit,
 * detect drift, remove. Return codes are the contract — a clean audit exits
 * 0 so `muffin mcp list --verify` can gate a script.
 */
describe('muffin mcp verbs', () => {
  it('add pins, list --verify audits clean, drift flips the exit code, remove forgets', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-mcpcli-'));

    // approve
    expect(await cmdMcpAdd(home, 'echo', process.execPath, [FIXTURE], {})).toBe(0);
    const registry = loadMcpRegistry(home);
    expect(Object.keys(registry.servers.echo!.tools)).toEqual(['echo']);

    // clean audit
    expect(await cmdMcpList(home, true)).toBe(0);

    // the server drifts: same command, description now different (env-driven)
    registry.servers.echo!.env = { DESC_OVERRIDE: 'Something else entirely.' };
    const { saveMcpRegistry } = await import('../core/mcp/registry.js');
    saveMcpRegistry(registry, home);
    expect(await cmdMcpList(home, true)).toBe(1);

    // re-approval with no command reuses the stored entry and repins
    expect(await cmdMcpAdd(home, 'echo', undefined, [], {})).toBe(0);
    expect(await cmdMcpList(home, true)).toBe(0);

    // remove forgets
    expect(cmdMcpRemove(home, 'echo')).toBe(0);
    expect(loadMcpRegistry(home).servers).toEqual({});
    expect(cmdMcpRemove(home, 'echo')).toBe(1);
  }, 40_000);

  it('a malformed name never reaches a connection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-mcpcli-'));
    expect(await cmdMcpAdd(home, 'Bad Name!', '/bin/true', [], {})).toBe(78);
    expect(loadMcpRegistry(home).servers).toEqual({});
  });
});
