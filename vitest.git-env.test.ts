import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { clearGitEnv } from './vitest.git-env.js';

describe('test workers start without GIT_* (pre-push hook in a worktree)', () => {
  it('removes every GIT_ variable and nothing else', () => {
    const env: NodeJS.ProcessEnv = {
      GIT_DIR: '/repo/.git/worktrees/x',
      GIT_INDEX_FILE: '/repo/.git/index',
      GIT_CONFIG_COUNT: '1',
      HOME: '/h',
      PATH: '/bin',
    };
    expect(clearGitEnv(env).sort()).toEqual(['GIT_CONFIG_COUNT', 'GIT_DIR', 'GIT_INDEX_FILE']);
    expect(env).toEqual({ HOME: '/h', PATH: '/bin' });
  });

  it('is already in effect in this worker, so a spawned git cannot see a caller repository', () => {
    expect(Object.keys(process.env).filter((k) => k.startsWith('GIT_'))).toEqual([]);
    const child = spawnSync('sh', ['-c', 'env'], { encoding: 'utf8' });
    expect(child.stdout).not.toMatch(/^GIT_DIR=/m);
  });
});
