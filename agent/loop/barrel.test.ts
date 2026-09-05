import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as loopBarrel from '../loop.js';

/**
 * Slice 1 of the loop decomposition (Fase A, §3) moves every type and
 * constant out of `agent/loop.ts` into `agent/loop/types.ts`. The two things
 * that must survive the move, mechanically:
 *
 *  1. `agent/loop.js` still exports the five names of value — nothing that
 *     imports `runTurn`/`resumeTurn`/`enqueueTurn`/`denyText`/`MAX_RESUMES`
 *     from the barrel today should ever notice this refactor happened.
 *  2. No file under `agent/loop/` imports back from `../loop.js`. A file in
 *     this directory that reached into the barrel would be exactly the cycle
 *     the decomposition exists to avoid — types.ts (and every module after
 *     it) reads from `./types.js`, never from the barrel it feeds.
 */
describe('agent/loop.js barrel', () => {
  it('exports the five values of the public surface', () => {
    expect(typeof loopBarrel.MAX_RESUMES).toBe('number');
    expect(typeof loopBarrel.enqueueTurn).toBe('function');
    expect(typeof loopBarrel.denyText).toBe('function');
    expect(typeof loopBarrel.runTurn).toBe('function');
    expect(typeof loopBarrel.resumeTurn).toBe('function');
  });

  it('no file under agent/loop/ imports from the barrel (../loop.js)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // Test files are exempt: this very file has to import the barrel to
    // check what it exports (the assertion just above). The invariant is
    // about the production wiring — no module under `agent/loop/` may feed
    // back into the file it was extracted from.
    const files = readdirSync(here).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    const offenders: string[] = [];
    for (const name of files) {
      const text = readFileSync(join(here, name), 'utf8');
      // Matches `from '../loop.js'` or `from "../loop.js"`, the only way a
      // sibling module could reach back into the barrel.
      if (/from\s+['"]\.\.\/loop\.js['"]/.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
