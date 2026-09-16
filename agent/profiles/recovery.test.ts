import { describe, expect, it } from 'vitest';
import type { RecoveryStrategy } from './profile.js';
import { recoveryStep } from './recovery.js';

/**
 * The wiring — that production walks this list in the declared order — is
 * pinned through `runTurn` in `agent/loop.test.ts`, which is the test that
 * matters (PRACTICES.md#model-judgement-and-deterministic-contracts-stay-separate). This file holds the cheaper property the wiring test
 * cannot state without becoming unreadable: that the four steps are four
 * different interventions rather than one nudge with four names, which is
 * exactly what the loop used to execute.
 */
describe('the recovery steps', () => {
  const ALL: RecoveryStrategy[] = ['nudge', 'reinjectTools', 'retryOnce', 'strictJson', 'requireTool'];
  const ctx = { failure: 'empty' as const, tools: ['fs_read', 'fs_write'] };

  it('gives a different intervention for every declared strategy', () => {
    const messages = ALL.map((s) => recoveryStep(s, ctx).message);
    expect(new Set(messages).size).toBe(ALL.length);
  });

  it('re-asks with nothing added for retryOnce, which is the whole point of it', () => {
    // Not an unimplemented step: the absence of a message IS the intervention.
    // Every other rung costs the small model attention it could spend on the
    // task, and this is the one that costs none.
    expect(recoveryStep('retryOnce', ctx).message).toBeUndefined();
  });

  it('restates exactly the tools it was given, and never invents a menu', () => {
    const said = recoveryStep('reinjectTools', ctx).message ?? '';
    expect(said).toContain('fs_read');
    expect(said).toContain('fs_write');
    expect(said).not.toContain('fs_delete');
  });

  it('says there is no menu rather than listing an empty one', () => {
    // A turn can legitimately expose zero tools; "puoi usare solo questi tool:"
    // followed by nothing is worse than saying the true thing.
    const said = recoveryStep('reinjectTools', { failure: 'empty', tools: [] }).message ?? '';
    expect(said).not.toMatch(/:\s*\./);
    expect(said).toMatch(/nessun tool/);
  });

  it('keeps the nudge that already shipped, byte for byte, on an empty turn', () => {
    // This slice moved the nudge; it did not get to change what it says.
    expect(recoveryStep('nudge', ctx).message).toBe(
      'Non ho ricevuto risposta. Continua, oppure dimmi che hai finito.',
    );
  });

  it('lets the failure class rewrite the nudge, and only the nudge', () => {
    // The nudge's whole content is the description of what went wrong, so it
    // has to know. The other three prescribe a shape, and the shape does not
    // depend on which way the turn came back unusable.
    const empty = (s: RecoveryStrategy) => recoveryStep(s, { ...ctx, failure: 'empty' }).message;
    const malformed = (s: RecoveryStrategy) => recoveryStep(s, { ...ctx, failure: 'malformed' }).message;

    expect(malformed('nudge')).not.toBe(empty('nudge'));
    expect(malformed('nudge')).toMatch(/JSON/);
    for (const s of ['reinjectTools', 'retryOnce', 'strictJson', 'requireTool'] as RecoveryStrategy[]) {
      expect(malformed(s)).toBe(empty(s));
    }
  });

  it('demands a call on requireTool, with no third shape', () => {
    // The wire flag (`tool_choice: required`) is armed by the loop, not by
    // this message — but the transcript must still say a call is due, or the
    // forced request arrives unexplained.
    const said = recoveryStep('requireTool', ctx).message ?? '';
    expect(said).toMatch(/tool call/);
    expect(said).toMatch(/non puoi/);
  });
});
