import { describe, expect, it } from 'vitest';
import { classifyDocsOnly, evaluateChecks, isExemptPath, latestPerName } from './gate-evidence.mjs';

/** Il contratto condiviso delle due porte, pinnato direttamente. */
describe('gate-evidence', () => {
  it('latestPerName: il rerun non resuscita il rosso, i prefissi workflow si spogliano', () => {
    const m = latestPerName([
      { name: 'verifica', status: 'completed', conclusion: 'success', completed_at: '2026-09-18T09:00:00Z' },
      { name: 'ci / verifica', status: 'completed', conclusion: 'failure', completed_at: '2026-09-18T10:00:00Z' },
    ]);
    expect(m.get('verifica')?.run?.conclusion).toBe('failure');
  });

  it('evaluateChecks: ordine fisso vuoto → pendenti → rossi → mancanti → pass', () => {
    expect(evaluateChecks([], ['verifica']).kind).toBe('empty');
    expect(
      evaluateChecks([{ name: 'a', status: 'in_progress', conclusion: null }], []).kind,
    ).toBe('pending');
    const red = evaluateChecks(
      [
        { name: 'verifica', status: 'completed', conclusion: 'success' },
        { name: 'x', status: 'completed', conclusion: 'failure' },
      ],
      ['verifica'],
    );
    expect(red.kind).toBe('red');
    expect(
      evaluateChecks([{ name: 'verifica', status: 'completed', conclusion: 'success' }], ['verifica', 'accettazione'])
        .kind,
    ).toBe('missing');
    expect(
      evaluateChecks(
        [
          { name: 'verifica', status: 'completed', conclusion: 'success' },
          { name: 'accettazione', status: 'completed', conclusion: 'success' },
          { name: 'collegamenti', status: 'completed', conclusion: 'skipped' },
        ],
        ['verifica', 'accettazione'],
      ).ok,
    ).toBe(true);
  });

  it('isExemptPath: parita esatta con ci.yml, mai interpretazione', () => {
    expect(isExemptPath('docs/a.md')).toBe(false);
    expect(isExemptPath('.claude/h.mjs')).toBe(false);
    expect(isExemptPath('README.md')).toBe(false);
    expect(isExemptPath('core/x.ts')).toBe(true);
    expect(isExemptPath('docs')).toBe(true);
    expect(isExemptPath('AGENTS.md.bak')).toBe(true);
  });

  it('classifyDocsOnly: conteggio provato, fuori insieme nominato', () => {
    expect(classifyDocsOnly([{ path: 'docs/a.md' }], 1)).toEqual({ ok: true, reason: 'exempt', count: 1 });
    expect(classifyDocsOnly([{ path: 'docs/a.md' }], 2).ok).toBe(false);
    expect(classifyDocsOnly([{ path: 'docs/a.md' }, { path: 'core/x.ts' }], 2)).toEqual({
      ok: false,
      reason: 'outside',
      offending: ['core/x.ts'],
    });
    expect(classifyDocsOnly(null, 0).ok).toBe(false);
  });
});
