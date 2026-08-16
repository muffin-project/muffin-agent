import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntime } from '../agent/runtime.js';
import { paths } from '../core/config/config.js';
import { runInit } from './init.js';
import { cmdVaultAdd } from './vault.js';

afterEach(() => vi.restoreAllMocks());

describe('muffin vault add', () => {
  it('indexes only the copied owner file, not another tenant file already in the shared vault', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-vault-cli-'));
    const sourceDir = mkdtempSync(join(tmpdir(), 'muffin-vault-source-'));
    const groupTenant = 'group:telegram:77';
    runInit({ home, apiKey: 'sk-vault-cli-never-called' });

    const seedRuntime = buildRuntime(home);
    try {
      const root = paths(home).vault;
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'group.md'), '# Gruppo\n\nGROUPPRIVATE\n');
      await seedRuntime.vault.reindexPath(groupTenant, 'group.md');
    } finally {
      seedRuntime.close();
    }

    const source = join(sourceDir, 'owner.md');
    writeFileSync(source, '# Owner\n\nOWNERPRIVATE\n');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    let checkRuntime: ReturnType<typeof buildRuntime> | null = null;
    try {
      expect(await cmdVaultAdd(home, source, 0)).toBe(0);
      checkRuntime = buildRuntime(home);
      expect(checkRuntime.memory.store.searchEpisodes('host', 'OWNERPRIVATE')).toHaveLength(1);
      expect(checkRuntime.memory.store.searchEpisodes('host', 'GROUPPRIVATE')).toHaveLength(0);
      expect(checkRuntime.memory.store.searchEpisodes(groupTenant, 'GROUPPRIVATE')).toHaveLength(1);
    } finally {
      checkRuntime?.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});
