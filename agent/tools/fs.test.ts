import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathDenied, fsList, fsRead, fsWrite, resolveInScope, type FsScope } from './fs.js';

function scoped(): { scope: FsScope; root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'muffin-fs-'));
  const root = join(base, 'work');
  const outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(root, 'rot'), { recursive: true });
  writeFileSync(join(root, 'nota.md'), 'ciao\n');
  writeFileSync(join(root, 'rot', 'identity.md'), '# identità\n');
  writeFileSync(join(outside, 'segreto.txt'), 'non mi devi leggere\n');
  return { scope: { root, denyWrite: [join(root, 'rot')] }, root, outside };
}

describe('filesystem primitives', () => {
  it('reads and writes inside the working directory', () => {
    const { scope } = scoped();
    expect(fsRead(scope, 'nota.md')).toBe('ciao\n');
    fsWrite(scope, 'sotto/nuovo.md', 'contenuto');
    expect(fsRead(scope, 'sotto/nuovo.md')).toBe('contenuto');
    expect(fsList(scope, '.')).toContain('sotto/');
  });

  it('refuses to climb out with ..', () => {
    const { scope } = scoped();
    expect(() => fsRead(scope, '../outside/segreto.txt')).toThrow(PathDenied);
    expect(() => fsWrite(scope, '../outside/nuovo.txt', 'x')).toThrow(PathDenied);
  });

  it('refuses an absolute path pointing elsewhere', () => {
    const { scope, outside } = scoped();
    expect(() => fsRead(scope, join(outside, 'segreto.txt'))).toThrow(PathDenied);
  });

  it('is not fooled by a symlink that leaves the scope', () => {
    // The string looks contained; the real path is not. This is why the check
    // runs on the resolved path and not on what the model wrote.
    const { scope, root, outside } = scoped();
    symlinkSync(outside, join(root, 'scorciatoia'));
    expect(() => fsRead(scope, 'scorciatoia/segreto.txt')).toThrow(PathDenied);
  });

  it('never writes into the root of trust, even from inside the scope', () => {
    const { scope } = scoped();
    expect(fsRead(scope, 'rot/identity.md')).toContain('identità'); // reading is fine
    expect(() => fsWrite(scope, 'rot/identity.md', 'riscritta')).toThrow(/root of trust/);
  });

  it('tells you which tool you wanted instead of failing obscurely', () => {
    const { scope } = scoped();
    expect(() => fsRead(scope, '.')).toThrow(/use fs_list/);
    expect(() => fsList(scope, 'nota.md')).toThrow(/use fs_read/);
  });

  it('resolves a plain relative path to the real scope root', () => {
    // realpath, not the string we passed in: on macOS the temp dir itself lives
    // behind a symlink, which is exactly the case the containment check has to
    // survive.
    const { scope, root } = scoped();
    expect(resolveInScope(scope, 'nota.md', false)).toBe(join(realpathSync(root), 'nota.md'));
  });
});
