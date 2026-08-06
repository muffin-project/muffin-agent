import { describe, expect, it } from 'vitest';
import { checkCompletion, completionNudge } from './completion.js';

const AVAILABLE = ['fs_read', 'fs_write', 'memory_search'];

describe('completion gate', () => {
  it('catches an answer that narrates a call the turn never made', () => {
    // The case on record: brackets that look like a call, a confident "done",
    // and zero tool iterations.
    const verdict = checkCompletion({
      text: '[Eseguo `fs_write`, path="poesia.md"]\n\nFatto. Ti ho appena salvato il file.',
      available: AVAILABLE,
      toolCallsMade: 0,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.named).toEqual(['fs_write']);
  });

  it('stays out of the way when the turn actually called something', () => {
    // A denied or failed call is still a call, so "non ho potuto usare fs_write"
    // after a real refusal has a tool result in the turn and is not this bug.
    const verdict = checkCompletion({
      text: 'Ho provato con `fs_write` ma il kernel lo ha rifiutato.',
      available: AVAILABLE,
      toolCallsMade: 1,
    });
    expect(verdict.ok).toBe(true);
  });

  it('does not fire on an ordinary answer', () => {
    for (const text of [
      'Il tuo commercialista è Marco Serra.',
      'Non lo so, e non voglio inventarlo.',
      'Posso leggere e scrivere file, se ti serve.',
    ]) {
      expect(checkCompletion({ text, available: AVAILABLE, toolCallsMade: 0 }).ok).toBe(true);
    }
  });

  it('is anchored to the registry, so a new tool is covered the day it exists', () => {
    // The previous generation of this check matched generic words — "tool",
    // "search" — and missed the real failure because the model named the actual
    // tool, which was new.
    const verdict = checkCompletion({
      text: 'Ho usato send_email per mandarglielo.',
      available: [...AVAILABLE, 'send_email'],
      toolCallsMade: 0,
    });
    expect(verdict.named).toEqual(['send_email']);
  });

  it('matches the name as a word, not as a substring', () => {
    // `fs_readme` is not `fs_read`, and a check that cannot tell them apart
    // fires on prose and gets switched off.
    expect(
      checkCompletion({ text: 'ho aggiornato fs_readme.md', available: ['fs_read'], toolCallsMade: 0 }).ok,
    ).toBe(true);
    expect(
      checkCompletion({ text: 'chiamo fs_read.', available: ['fs_read'], toolCallsMade: 0 }).ok,
    ).toBe(false);
  });

  it('names the tools in the nudge', () => {
    // Vague feedback produces a vague retry, and this is the only attempt the
    // model gets.
    const nudge = completionNudge(['fs_write', 'send_email']);
    expect(nudge).toContain('`fs_write`');
    expect(nudge).toContain('`send_email`');
    expect(nudge).toContain('non hai chiamato nessun tool');
  });
});
