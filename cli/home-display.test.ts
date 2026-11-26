import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { displayInHome } from './home-display.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('displayInHome', () => {
  it('uses ~/.muffin for the default home', () => {
    expect(displayInHome(join(homedir(), '.muffin'), 'user.md')).toBe('~/.muffin/user.md');
    expect(displayInHome(join(homedir(), '.muffin'), 'rot/identity.md')).toBe(
      '~/.muffin/rot/identity.md',
    );
  });

  it('shows the real path when MUFFIN_HOME is customized', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-home-display-'));
    dirs.push(home);
    expect(displayInHome(home, 'user.md')).toBe(join(home, 'user.md'));
    expect(displayInHome(home, 'user.md')).not.toContain('~/.muffin');
  });
});
