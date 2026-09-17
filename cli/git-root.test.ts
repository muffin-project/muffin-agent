import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findCheckoutRoot } from './git-root.js';

/**
 * La direzione degli import fra i verbi CLI (issue #558).
 *
 * `update.ts` ↔ `adopt.ts` era un ciclo reale: sotto il transform SSR di
 * vitest l'ordine di valutazione dipendeva dall'entry point e un binding
 * letto nel momento sbagliato arrivava `undefined`
 * (`describeBuild is not a function` a intermittenza in capability-gaps).
 * Questi test tengono la direzione — `update` → `adopt` → `git-root` — perché
 * un ciclo reintrodotto non fa rumore finché non diventa flake in CI.
 */
describe('git-root: una direzione sola', () => {
  const src = (f: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), 'utf8');

  it('adopt.ts non importa update.ts', () => {
    expect(src('adopt.ts')).not.toMatch(/from\s+['"]\.\/update\.js['"]/);
  });

  it('update.ts importa ancora adopt.ts (il verso consentito, non il contrario)', () => {
    expect(src('update.ts')).toMatch(/from\s+['"]\.\/adopt\.js['"]/);
  });

  it('trova la radice su un checkout vero, null fuori da git', () => {
    const git = (args: string[], cwd: string) => {
      if (args[0] === 'worktree') return { status: 0, stdout: `worktree ${cwd}\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    };
    expect(findCheckoutRoot('/qualunque', git)).toBe('/qualunque');
    expect(findCheckoutRoot('/qualunque', () => ({ status: 1, stdout: '', stderr: '' }))).toBeNull();
  });
});
