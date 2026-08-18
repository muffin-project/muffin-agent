import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { paths } from '../config/config.js';
import { POLICY_FLOOR, loadPolicyMatrix } from './matrix.js';

/**
 * `rot/policy.json` was sealed, hashed and read by nobody: the matrix it
 * declares lived as three `const`s in `decide.ts`. These tests pin both halves
 * of the fix — that the file now speaks, and that it cannot speak *louder* than
 * the compiled floor.
 */

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-matrix-'));
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

const policyOf = (dir: string) => join(paths(dir).rot, 'policy.json');

describe('the sealed permission matrix', () => {
  it('lets the file tighten a ceiling and refuses to let it raise one', () => {
    // The judge measured what an unclamped default bought: `{"medium":3}` in a
    // resealed policy.json turned `mcp.*` from "a tainted turn cannot reach a
    // third-party server at all" into a silent allow at taint 3, because that
    // capability — like fs.write and sys.shell — inherits the class default
    // instead of pinning its own. A declaration is a reviewed commit; this file
    // is a write plus a reseal. So it may only lower, exactly like the deny
    // lists may only grow.
    const dir = home();

    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, defaultMaxTaint: { low: 3, medium: 3, high: 3 } }));
    expect(loadPolicyMatrix(dir).defaultMaxTaint).toEqual(POLICY_FLOOR.defaultMaxTaint);

    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, defaultMaxTaint: { low: 1, medium: 0, high: 0 } }));
    expect(loadPolicyMatrix(dir).defaultMaxTaint).toEqual({ low: 1, medium: 0, high: 0 });

    // And a mixed file: the tightening half lands, the widening half does not.
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, defaultMaxTaint: { low: 0, medium: 3 } }));
    const mixed = loadPolicyMatrix(dir).defaultMaxTaint;
    expect(mixed.low).toBe(0);
    expect(mixed.medium).toBe(POLICY_FLOOR.defaultMaxTaint.medium);

    rmSync(dir, { recursive: true, force: true });
  });

  it('reproduces the values the kernel used to hardcode, exactly', () => {
    // P2. The JSON and the three `const`s were byte-compatible duplicates on the
    // day this slice started; a default install must not shift behaviour by a
    // single tier because the source of the numbers moved. If this ever goes
    // red, either the file or the floor changed alone — which is the drift the
    // duplication was always going to produce.
    const dir = home();
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('sealed');
    expect(matrix.defaultMaxTaint).toEqual({ low: 3, medium: 1, high: 1 });
    expect(matrix.defaultMaxTaint).toEqual(POLICY_FLOOR.defaultMaxTaint);
    expect([...matrix.neverAtRuntime]).toEqual([...POLICY_FLOOR.neverAtRuntime]);
    expect([...matrix.forbiddenForSystem]).toEqual([...POLICY_FLOOR.forbiddenForSystem]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an owner edit instead of the compiled number', () => {
    const dir = home();
    writeFileSync(
      policyOf(dir),
      JSON.stringify({ schemaVersion: 1, defaultMaxTaint: { low: 0, medium: 0, high: 0 } }),
    );
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('sealed');
    expect(matrix.defaultMaxTaint).toEqual({ low: 0, medium: 0, high: 0 });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a policy file that cannot be trusted never widens anything', () => {
  /**
   * The fallback values are asserted literally, not compared to `POLICY_FLOOR`,
   * so that widening the floor turns these red instead of dragging them along.
   */
  const expectFloor = (dir: string, why: RegExp) => {
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('fallback');
    expect(matrix.note).toMatch(why);
    expect(matrix.defaultMaxTaint).toEqual({ low: 3, medium: 1, high: 1 });
    expect(matrix.paramsMaxTaint).toBe(2);
    // The namespace entries joined the bare ids when the lookup learned to
    // read them (`denyListCovers`): 03 §3 says `outward.*`, and the Root of
    // Trust row says the RoT, not one verb of it. Both are tightenings — the
    // literal list only ever grows in the deny direction, which is why this
    // assertion stays literal.
    expect([...matrix.neverAtRuntime]).toEqual(['rot.write', 'rot.*']);
    expect([...matrix.forbiddenForSystem]).toEqual(['outward.send', 'outward.*', 'config.ratchet']);
  };

  it('an absent file degrades to the floor and says so', () => {
    const dir = home();
    rmSync(policyOf(dir));
    expectFloor(dir, /assente/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('unparseable JSON degrades to the floor rather than throwing at boot', () => {
    const dir = home();
    writeFileSync(policyOf(dir), '{ "schemaVersion": 1,');
    expectFloor(dir, /JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a taint tier outside 0..3 invalidates the file, it does not round', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, defaultMaxTaint: { low: 9 } }));
    expectFloor(dir, /defaultMaxTaint/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a future schemaVersion is not guessed at', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 2, defaultMaxTaint: { low: 0 } }));
    expectFloor(dir, /schemaVersion/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the deny lists are a floor, not a setting', () => {
  it('an emptied neverAtRuntime still denies rot.write', () => {
    // Monotone confinement (ADR-0013): the file may add prohibitions, never
    // remove the shipped ones. Without the union, editing one line of a sealed
    // JSON would hand the runtime a write path into its own root of trust.
    const dir = home();
    writeFileSync(
      policyOf(dir),
      JSON.stringify({ schemaVersion: 1, neverAtRuntime: [], forbiddenForSystem: [] }),
    );
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('sealed');
    expect(matrix.neverAtRuntime.has('rot.write')).toBe(true);
    expect(matrix.forbiddenForSystem.has('outward.send')).toBe(true);
    expect(matrix.forbiddenForSystem.has('config.ratchet')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an owner may add to them', () => {
    const dir = home();
    writeFileSync(
      policyOf(dir),
      JSON.stringify({ schemaVersion: 1, neverAtRuntime: ['sys.shell'] }),
    );
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.neverAtRuntime.has('sys.shell')).toBe(true);
    expect(matrix.neverAtRuntime.has('rot.write')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('paramsMaxTaint — the one ceiling the file may also raise (mandato inv. 7)', () => {
  /**
   * Deliberately not `it('lets the file tighten a ceiling and refuses to let
   * it raise one', ...)`'s shape: that test (above) pins `defaultMaxTaint`'s
   * tighten-only clamp, and `paramsMaxTaint` is NOT under that clamp — see the
   * field's own doc comment on `PolicyMatrix` (matrix.ts) for why. These three
   * tests exist so that clamping it later — making it match `defaultMaxTaint`
   * by accident — goes red instead of silently taking away the owner's dial.
   */
  it('defaults to 2 when the file is genuinely silent — tier 2 is the owner\'s own disk (owner, 17/08)', () => {
    const dir = home();
    // `home()` installa `defaults/rot/policy.json`, che la chiave la CONTIENE:
    // asserire sul file installato non prova il default, prova il default del
    // file. Qui si riscrive il file **senza** la chiave — la forma che ha
    // davvero la `~/.muffin` dell'owner, sigillata prima di questa slice —
    // così togliere il `?? POLICY_FLOOR.paramsMaxTaint` in `merge()` va rosso.
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, neverAtRuntime: ['rot.write'] }));
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('sealed');
    expect(matrix.paramsMaxTaint).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an owner edit can lower it', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, paramsMaxTaint: 0 }));
    expect(loadPolicyMatrix(dir).paramsMaxTaint).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an owner edit can also RAISE it, unlike defaultMaxTaint', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, paramsMaxTaint: 3 }));
    expect(loadPolicyMatrix(dir).paramsMaxTaint).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an out-of-range value invalidates the whole file, same as defaultMaxTaint', () => {
    const dir = home();
    writeFileSync(policyOf(dir), JSON.stringify({ schemaVersion: 1, paramsMaxTaint: 9 }));
    const matrix = loadPolicyMatrix(dir);
    expect(matrix.source).toBe('fallback');
    expect(matrix.note).toMatch(/paramsMaxTaint/);
    expect(matrix.paramsMaxTaint).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
