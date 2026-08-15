import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { paths } from '../config/config.js';
import { seal } from './verify.js';
import { ROT_READERS, checkRotReaders, formatRotReaders } from './readers.js';

/**
 * The invariant that exists because nothing failed for months.
 *
 * `rot/policy.json` declared itself binding and no line of production code
 * opened it; `rot/evals/voice.json` is in the same seal and legitimately has no
 * runtime reader. Those two cases look identical from the outside, which is
 * precisely why the second one has to be *declared* rather than inferred.
 */

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-readers-'));
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

const ids = (dir: string) => checkRotReaders(dir).violations.map((v) => v.id);

describe('every file in the seal answers for itself', () => {
  it('a freshly installed root of trust is fully accounted for', () => {
    // The real gate: this is the test a future slice trips by dropping a file
    // into `defaults/rot/` and wiring nothing to it.
    const dir = home();
    const result = checkRotReaders(dir);
    expect(result.violations).toEqual([]);
    expect(result.skipped).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a sealed file nobody declared is an error, named', () => {
    const dir = home();
    writeFileSync(join(paths(dir).rot, 'surprise.json'), '{"binding":"honest"}\n');
    seal(dir, '1', new Date());
    const result = checkRotReaders(dir);
    expect(result.violations.map((v) => v.id)).toEqual(['sealed_file_unread']);
    expect(result.violations[0]?.sample.join(' ')).toContain('surprise.json');
    expect(result.violations[0]?.severity).toBe('error');
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the reader of policy.json, so the entry is checkable and not a claim', () => {
    const entry = ROT_READERS.find((e) => e.file === 'policy.json');
    expect(entry?.readers?.[0]?.module).toBe('core/policy/matrix.ts');
    expect(entry?.readers?.[0]?.fn).toBe('loadPolicyMatrix');
  });

  it('lists the eval suite as unread-by-design instead of leaving it out', () => {
    // Absence and intent are the same shape in a manifest. Only the allowlist
    // can tell them apart, so the unread case is written down, with its reason.
    const entry = ROT_READERS.find((e) => e.file === 'evals/');
    expect(entry?.unreadByDesign).toMatch(/.+/);
    expect(entry?.readers ?? []).toEqual([]);
  });
});

describe('the allowlist is checked against the code, not believed', () => {
  it('an entry whose module stopped mentioning the file is an error', () => {
    // Bookkeeping that nobody verifies is how the last five instances survived.
    // Rewriting the claimed reader to a module that exists but reads nothing
    // must go red — the entry is a statement about the code, so the code
    // decides whether it is true.
    const dir = home();
    const claimed = ROT_READERS.find((e) => e.file === 'policy.json');
    const result = checkRotReaders(dir, [
      ...ROT_READERS.filter((e) => e.file !== 'policy.json'),
      { ...claimed!, readers: [{ module: 'core/rot/verify.ts', fn: 'seal', why: 'a lie' }] },
    ]);
    expect(result.violations.map((v) => v.id)).toEqual(['reader_gone']);
    expect(result.violations[0]?.sample.join(' ')).toContain('core/rot/verify.ts');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a module that only mentions the file in a comment does not count as a reader', () => {
    // Found by mutating the first version of this check: rewriting `matrix.ts`
    // to build the filename out of an array left no code naming `policy.json`,
    // and the check stayed green off the docstring alone. `verify.ts` is the
    // fixture: its header block comment says "identity.md by hand" and no line
    // of its code opens that file. `seal` is a real function in it, so the only
    // thing that can turn this red is the filename half of the check.
    const dir = home();
    const result = checkRotReaders(dir, [
      { file: 'identity.md', readers: [{ module: 'core/rot/verify.ts', fn: 'seal', why: 'prose only' }] },
      ...ROT_READERS.filter((e) => e.file !== 'identity.md'),
    ]);
    expect(result.violations.map((v) => v.id)).toEqual(['reader_gone']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a module that only imports the symbol is not a caller of it', () => {
    // Found by mutating this slice, and it is the same hole as the docstring
    // one above, one layer down. `cli/observe.ts` was rewritten to stop calling
    // `loadSealedBudgets` — replaced by a hardcoded object, which is exactly the
    // defect being guarded against — and the check stayed green, because
    // `import { loadSealedBudgets } from …` still contained the name. An import
    // says a module *may* use a symbol; only a call says it does.
    //
    // The fixture is an aliased import, which is the honest shape of a name that
    // is imported and never written again: `core/skills/skills.ts` does
    // `import { load as yamlLoad }`, so after comments and imports are stripped
    // the bare word `load` is nowhere in it. (If someone adds a `loadFoo` there
    // this goes red for the wrong reason — a false red, which is loud, and the
    // side this file is deliberately wrong on.)
    const dir = home();
    const result = checkRotReaders(dir, [
      { file: 'policy.json', readers: [{ module: 'core/skills/skills.ts', fn: 'load', indirect: true, why: 'imported, never called' }] },
      ...ROT_READERS.filter((e) => e.file !== 'policy.json'),
    ]);
    expect(result.violations.map((v) => v.id)).toEqual(['reader_gone']);
    expect(result.violations[0]?.sample.join(' ')).toContain('non chiama più load()');
    rmSync(dir, { recursive: true, force: true });
  });

  it('an indirect reader still has to name its function, it just need not name the file', () => {
    // The other half: `indirect` relaxes exactly one of the two claims. Without
    // this, `indirect: true` would be a way to declare a reader that is never
    // checked at all — a flag that turns the invariant off from inside the
    // allowlist it is supposed to police.
    const dir = home();
    const clean = checkRotReaders(dir, [
      { file: 'policy.json', readers: [{ module: 'agent/runtime.ts', fn: 'loadPolicyMatrix', indirect: true, why: 'really calls it' }] },
      ...ROT_READERS.filter((e) => e.file !== 'policy.json'),
    ]);
    expect(clean.violations).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an entry naming a module that is not there is not silently skipped', () => {
    const dir = home();
    const result = checkRotReaders(dir, [
      { file: 'policy.json', readers: [{ module: 'core/policy/gone.ts', fn: 'x', why: 'moved' }] },
      ...ROT_READERS.filter((e) => e.file !== 'policy.json'),
    ]);
    expect(result.violations.map((v) => v.id)).toContain('reader_gone');
    rmSync(dir, { recursive: true, force: true });
  });

  it('an allowlist entry for a file no longer sealed is a warning, not silence', () => {
    const dir = home();
    rmSync(join(paths(dir).rot, 'egress.json'));
    seal(dir, '1', new Date());
    const result = checkRotReaders(dir);
    expect(result.violations.map((v) => v.id)).toEqual(['allowlist_stale']);
    expect(result.violations[0]?.severity).toBe('warning');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('reporting', () => {
  it('a home with no manifest is skipped loudly, never reported as clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-readers-bare-'));
    const result = checkRotReaders(dir);
    expect(result.violations).toEqual([]);
    expect(result.skipped.map((s) => s.id)).toEqual(['rot_readers']);
    expect(formatRotReaders(result)).toContain('NON verificato');
    rmSync(dir, { recursive: true, force: true });
  });

  it('says how many files were accounted for when nothing is wrong', () => {
    const dir = home();
    expect(formatRotReaders(checkRotReaders(dir))).toMatch(/\d+ file/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an unread file is visible in the formatted report', () => {
    const dir = home();
    writeFileSync(join(paths(dir).rot, 'surprise.json'), 'x\n');
    seal(dir, '1', new Date());
    expect(ids(dir)).toEqual(['sealed_file_unread']);
    expect(formatRotReaders(checkRotReaders(dir))).toContain('surprise.json');
    rmSync(dir, { recursive: true, force: true });
  });
});
