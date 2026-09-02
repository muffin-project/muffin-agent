import { describe, expect, it } from 'vitest';
import { denyText } from './loop.js';

/**
 * A refusal the model reads must be true about its own remedy.
 *
 * `taint_exceeded` has no remedy an approval can give: the ceiling is
 * crossed, and the owner cannot lower the turn's taint. Every other deny
 * keeps the old sentence, because for those an owner decision is exactly
 * what is missing.
 */
describe('the deny text says what would change it, and never a permission that does not exist', () => {
  it('taint_exceeded names the cause and refuses to promise an owner decision', () => {
    const text = denyText({ effect: 'deny', code: 'taint_exceeded', detail: 'context taint 2 exceeds 1 for fs.write' });
    expect(text).toContain('(taint_exceeded)');
    expect(text).toContain('context taint 2 exceeds 1 for fs.write');
    expect(text).toMatch(/nessuna approvazione lo sblocca/i);
    expect(text).not.toMatch(/serve una decisione dell'owner/);
  });

  it('taint_exceeded without a detail still explains itself', () => {
    expect(denyText({ effect: 'deny', code: 'taint_exceeded' })).toMatch(/supera il soffitto/);
  });

  it('every other code keeps asking for the owner, because there the owner can decide', () => {
    expect(denyText({ effect: 'deny', code: 'resource_denied', detail: 'x' })).toMatch(/serve una decisione dell'owner/);
  });
});
