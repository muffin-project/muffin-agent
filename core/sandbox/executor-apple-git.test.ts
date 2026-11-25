import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SandboxExecutor } from './executor.js';

it.skipIf(process.platform !== 'darwin')(
  'runs a contained command from a cold Home using the system Git shim on PATH',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'muffin-apple-git-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    mkdirSync(home);
    mkdirSync(workspace);
    const executor = new SandboxExecutor({ denyRead: [], denyWrite: [] });
    vi.stubEnv('HOME', home);
    vi.stubEnv('TMPDIR', root);
    vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin');
    try {
      const availability = await executor.verify();
      expect(availability).toEqual({ available: true, mechanism: 'seatbelt' });
      const outcome = await executor.run({
        command: 'printf "42\\n" > resultado.txt',
        cwd: workspace,
        writeScope: [workspace],
      });
      expect(outcome.code, outcome.stderr).toBe(0);
      expect(readFileSync(join(workspace, 'resultado.txt'), 'utf8')).toBe('42\n');
    } finally {
      await executor.close();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
