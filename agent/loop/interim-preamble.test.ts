import { describe, expect, it } from 'vitest';
import {
  INTERIM_COOLDOWN_MS,
  interimDestination,
  MAX_PREAMBLE_CHARS,
  type QualifyInterimPreambleInput,
  qualifyInterimPreamble,
} from './interim-preamble.js';

const base = (
  overrides: Partial<QualifyInterimPreambleInput> = {},
): QualifyInterimPreambleInput => ({
  text: 'Ok, vado a guardare',
  sensitiveResourceEchoes: [],
  boundary: 'tool-call',
  destination: 'telegram',
  workMessageInBatch: false,
  preamblesAlreadyPromoted: 0,
  lastInterimAtMs: null,
  priorInterimTexts: [],
  nowMs: 1_000,
  ...overrides,
});

describe('interimDestination', () => {
  it('allows Telegram DM, groups and topics when the turn is interactive', () => {
    expect(interimDestination({ surface: 'telegram', hasLiveSink: true })).toBe('telegram');
    expect(interimDestination({ surface: 'telegram', hasLiveSink: false })).toBe('telegram');
  });

  it('allows the interactive REPL and rejects headless CLI, jobs and minimal prompts', () => {
    expect(interimDestination({ surface: 'cli', hasLiveSink: true })).toBe('repl');
    expect(interimDestination({ surface: 'cli', hasLiveSink: false })).toBe('none');
    expect(interimDestination({ surface: 'telegram', jobId: 'job-1', hasLiveSink: true })).toBe(
      'none',
    );
    expect(
      interimDestination({
        surface: 'telegram',
        promptMode: 'minimal',
        hasLiveSink: true,
      }),
    ).toBe('none');
    expect(interimDestination({ surface: 'discord', hasLiveSink: true })).toBe('none');
  });
});

describe('qualifyInterimPreamble', () => {
  it('promotes a short complete acknowledgment on Telegram and on the REPL', () => {
    expect(qualifyInterimPreamble(base())).toEqual({
      ok: true,
      text: 'Ok, vado a guardare',
    });
    expect(
      qualifyInterimPreamble(base({ destination: 'repl', text: 'Prima devo controllare.' })),
    ).toEqual({ ok: true, text: 'Prima devo controllare.' });
  });

  it('trims, redacts and scrubs before judging the text', () => {
    const secret = 'the wifi password is casa2024-super-secret-value';
    expect(
      qualifyInterimPreamble(
        base({
          text: `  Ok, controllo. ${secret}  `,
          sensitiveResourceEchoes: [secret],
        }),
      ),
    ).toEqual({ ok: false, reason: 'secret_trace' });
  });

  it('rejects the partial-answer opener used by the Telegram streaming regression', () => {
    expect(qualifyInterimPreamble(base({ text: 'Ecco cosa ho trovato' }))).toEqual({
      ok: false,
      reason: 'partial_answer',
    });
    expect(qualifyInterimPreamble(base({ text: 'Ecco cosa ho trovato.' }))).toEqual({
      ok: false,
      reason: 'partial_answer',
    });
    expect(qualifyInterimPreamble(base({ text: "Here's what I found" }))).toEqual({
      ok: false,
      reason: 'partial_answer',
    });
  });

  it('rejects superseded attempts, empty text, other destinations and a work_message in the same batch', () => {
    expect(qualifyInterimPreamble(base({ boundary: 'superseded' }))).toEqual({
      ok: false,
      reason: 'superseded',
    });
    expect(qualifyInterimPreamble(base({ text: '   ' }))).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(qualifyInterimPreamble(base({ destination: 'none' }))).toEqual({
      ok: false,
      reason: 'destination',
    });
    expect(qualifyInterimPreamble(base({ workMessageInBatch: true }))).toEqual({
      ok: false,
      reason: 'work_message_in_batch',
    });
  });

  it('enforces max one preamble per turn, the cooldown and textual dedup', () => {
    expect(qualifyInterimPreamble(base({ preamblesAlreadyPromoted: 1 }))).toEqual({
      ok: false,
      reason: 'budget',
    });
    expect(
      qualifyInterimPreamble(
        base({ lastInterimAtMs: 1_000, nowMs: 1_000 + INTERIM_COOLDOWN_MS - 1 }),
      ),
    ).toEqual({ ok: false, reason: 'cooldown' });
    expect(
      qualifyInterimPreamble(
        base({
          lastInterimAtMs: 1_000,
          nowMs: 1_000 + INTERIM_COOLDOWN_MS,
          text: 'Un attimo, guardo.',
        }),
      ),
    ).toEqual({ ok: true, text: 'Un attimo, guardo.' });
    expect(qualifyInterimPreamble(base({ priorInterimTexts: ['Ok, vado a guardare'] }))).toEqual({
      ok: false,
      reason: 'dedup',
    });
  });

  it('rejects long, open-ended, multi-sentence or code-shaped text', () => {
    expect(qualifyInterimPreamble(base({ text: `${'a'.repeat(MAX_PREAMBLE_CHARS + 1)}` }))).toEqual(
      { ok: false, reason: 'too_long' },
    );
    expect(qualifyInterimPreamble(base({ text: 'Ho trovato questo:' }))).toEqual({
      ok: false,
      reason: 'open_ended',
    });
    expect(qualifyInterimPreamble(base({ text: 'Ok, guardo. Poi leggo. Poi ti dico.' }))).toEqual({
      ok: false,
      reason: 'too_many_sentences',
    });
    expect(qualifyInterimPreamble(base({ text: 'Ok, vado a guardare. Un attimo.' }))).toEqual({
      ok: true,
      text: 'Ok, vado a guardare. Un attimo.',
    });
    expect(qualifyInterimPreamble(base({ text: 'Guardo cosi:\n```\nls\n```' }))).toEqual({
      ok: false,
      reason: 'code',
    });
  });

  it('does not look at thinking blocks: only the provided text is judged', () => {
    // The caller must never pass thinking content here. A reasoning-looking
    // sentence that is nevertheless a short complete acknowledgment still
    // qualifies — leakage is prevented by not feeding those blocks in.
    expect(qualifyInterimPreamble(base({ text: 'Ok, controllo il link.' }))).toEqual({
      ok: true,
      text: 'Ok, controllo il link.',
    });
  });
});
