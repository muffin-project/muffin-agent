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
    expect([...matrix.neverAtRuntime]).toEqual(['rot.write']);
    expect([...matrix.forbiddenForSystem]).toEqual(['outward.send', 'config.ratchet']);
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
