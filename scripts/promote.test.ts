import { describe, expect, it } from 'vitest';
import { decidePromotion, type PromotionCheckRun, type PromotionPr } from './promote.js';

/**
 * La porta dev→main, con query finte: la rete vera non entra negli unit test.
 * Ogni ramo che non e' "prove FAST+DEEP sullo SHA esatto con main antenato"
 * e' un rifiuto che non muove il ref.
 */
describe('decidePromotion', () => {
  const TARGET = 'd27d1fd8c5c9f4a1ef6e266d3db193e3ea3eda8f';
  const MAIN = 'ffeac9ffdcef6fb7d57f4af8e4e461ed6a407491';
  const pr = (over: Partial<PromotionPr> = {}): PromotionPr => ({
    number: 600,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'dev',
    headRefOid: TARGET,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    files: [],
    ...over,
  });
  const run = (name: string, conclusion: string | null = 'success'): PromotionCheckRun => ({
    name,
    status: 'completed',
    conclusion,
  });
  const decidi = (over: object = {}, runs: readonly PromotionCheckRun[] = [run('verifica'), run('accettazione')]) =>
    decidePromotion({ targetSha: TARGET, mainSha: MAIN, mainIsAncestor: true, pr: pr(), prCount: 1, runs, ...over });

  function no(v: ReturnType<typeof decidePromotion>): string {
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('atteso un rifiuto');
    return v.message;
  }

  it('main non antenato: niente fast-forward, niente promozione', () => {
    expect(no(decidi({ mainIsAncestor: false }))).toContain('antenato');
  });

  it("target gia' su main: noop verde che non spinge", () => {
    const v = decidePromotion({ targetSha: MAIN, mainSha: MAIN, mainIsAncestor: true, pr: null, prCount: 0, runs: [] });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.noop).toBe(true);
  });

  it('nessuna PR dev→main: rifiuto con il comando per aprirla', () => {
    expect(no(decidi({ pr: null, prCount: 0 }, []))).toContain('gh pr create --base main --head dev');
  });

  it('due PR dev→main: ambiguo, chiudere a mano', () => {
    expect(no(decidi({ prCount: 2 }, []))).toContain('Chiuderne');
  });

  it('PR in bozza: rifiuto, DEEP non gira sulle bozze', () => {
    expect(no(decidi({ pr: pr({ isDraft: true }) }))).toContain('bozza');
  });

  it('head diversa dal target: le prove sono per un altro SHA', () => {
    const v = no(decidi({ pr: pr({ headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) }));
    expect(v).toContain('un altro SHA');
  });

  it('rossi e in-corso chiudono, con nomi', () => {
    expect(no(decidi({}, [run('verifica'), { ...run('accettazione'), conclusion: 'failure' }]))).toContain(
      'accettazione',
    );
    expect(no(decidi({}, [run('verifica'), { ...run('accettazione'), status: 'in_progress', conclusion: null }]))).toContain(
      'in corso',
    );
  });

  it('accettazione skippata su promozione di codice: rifiuto', () => {
    const v = no(
      decidi({ pr: pr({ files: [{ path: 'core/policy/gate.ts' }] }) }, [
        run('verifica'),
        { ...run('accettazione'), conclusion: 'skipped' },
      ]),
    );
    expect(v).toContain('accettazione');
  });

  it('FAST+DEEP verdi sullo SHA esatto: via libera che nomina entrambi gli SHA', () => {
    const v = decidi();
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.note).toContain(TARGET.slice(0, 12));
      expect(v.note).toContain(MAIN.slice(0, 12));
    }
  });

  it('docs-only senza verifica: via libera solo con allowlist e check leggeri verdi', () => {
    const v = decidi(
      { pr: pr({ files: [{ path: 'docs/piano.md' }, { path: '.claude/x.mjs' }, 'README.md'] }) },
      [run('collegamenti')],
    );
    expect(v.ok).toBe(true);
  });

  it('misto docs+codice senza verifica: rifiuto che nomina il path', () => {
    const v = no(
      decidi({ pr: pr({ files: [{ path: 'docs/piano.md' }, { path: 'core/x.ts' }] }) }, [run('collegamenti')]),
    );
    expect(v).toContain('core/x.ts');
  });

  it('file illeggibili con DEEP mancante: rifiuto fail-closed', () => {
    expect(no(decidi({ pr: pr({ files: null }) }, [run('collegamenti')]))).toContain('non sono leggibili');
  });
});
