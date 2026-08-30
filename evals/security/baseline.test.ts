import { describe, expect, it } from 'vitest';
import { fsCapabilities } from '../../agent/tools/fs.js';
import { httpCapability } from '../../agent/tools/http.js';
import { shellCapability } from '../../agent/tools/shell.js';
import { makeBaselineHarness } from './baseline.js';
import { SECURITY_BASELINE_CAPABILITIES, SECURITY_BASELINE_SCENARIOS } from './scenarios.js';

const run = makeBaselineHarness({
  capabilities: SECURITY_BASELINE_CAPABILITIES,
  hardened: true,
  // This baseline is about ambient taint, not host allowlisting. Scenario S5's
  // URL is considered already allowlisted so the comparison reaches the same
  // capability/risk branch in A and B.
  egressAllowed: () => true,
});

describe('Security v2 A/B baseline — ambient taint only', () => {
  for (const scenario of SECURITY_BASELINE_SCENARIOS) {
    it(`${scenario.id}: ${scenario.claim}`, () => {
      const [ambient, noAmbient] = run(scenario.action);

      expect(ambient.mode).toBe('ambient-taint');
      expect(ambient.effectiveTaint).toBe(scenario.action.ambientTaint);
      expect(ambient.decision.effect).toBe(scenario.expect.ambient);

      expect(noAmbient.mode).toBe('no-ambient-taint');
      expect(noAmbient.effectiveTaint).toBe(0);
      expect(noAmbient.decision.effect).toBe(scenario.expect.noAmbient);

      if (scenario.expect.ambientCode !== undefined) {
        expect(ambient.decision).toMatchObject({
          effect: 'deny',
          code: scenario.expect.ambientCode,
        });
      }
    });
  }

  it('changes only the taint input between A and B', () => {
    for (const scenario of SECURITY_BASELINE_SCENARIOS) {
      const [ambient, noAmbient] = run(scenario.action);
      // The harness is intentionally too small to hide a policy fork: both
      // results come from one createDecide closure and expose only which taint
      // reached it. If future A/B needs another differing field, this assertion
      // is where the experiment has to admit that its question changed.
      expect(ambient.effectiveTaint).toBe(scenario.action.ambientTaint);
      expect(noAmbient.effectiveTaint).toBe(0);
    }
  });

  it('makes the utility/security trade-off visible rather than scoring one winner', () => {
    const results = SECURITY_BASELINE_SCENARIOS.map((scenario) => {
      const [ambient, noAmbient] = run(scenario.action);
      return {
        id: scenario.id,
        ambient: ambient.decision.effect,
        noAmbient: noAmbient.decision.effect,
      };
    });

    // Ambient taint is not merely "stricter everywhere": the allowlisted
    // read-only case is intentionally identical because sys.http declares a
    // higher ceiling. That exception is itself evidence that useful dataflow
    // already forced the scalar policy to become capability-specific.
    expect(results.find((r) => r.id === 's5-external-value-read-more')).toMatchObject({
      ambient: 'allow',
      noAmbient: 'allow',
    });

    // And removing ambient taint is not a free utility win: the same experiment
    // makes a high-risk outward action reachable in the evaluation capability.
    expect(results.find((r) => r.id === 's5-external-destination-outward')).toMatchObject({
      ambient: 'deny',
      noAmbient: 'allow',
    });

    // This pair is the reason candidate C must exist: current A blocks an
    // already-scoped write after docs, while B makes the outward case reachable.
    expect(results.find((r) => r.id === 's2-web-docs-owner-write')).toMatchObject({
      ambient: 'deny',
      noAmbient: 'draft',
    });
  });
});

describe('la baseline misura la produzione, non una copia', () => {
  /**
   * Il difetto che questo blocco uccide: le tre dichiarazioni erano fixture
   * scritte a mano. Il 30/08/2026 coincidevano ancora con la produzione su
   * tutti i campi che decidono — ed e proprio per quello che non si vedeva.
   * Una baseline che ricopia resta verde il giorno in cui la produzione cambia,
   * e continua a misurare un sistema che non esiste piu.
   *
   * Si verifica per **identita** e non per uguaglianza: due oggetti uguali
   * sarebbero di nuovo una copia, e domani uguali non lo sarebbero piu.
   */
  it('usa gli stessi oggetti che registra la produzione', () => {
    const scritta = fsCapabilities.find((c) => c.id === 'fs.write');
    expect(scritta).toBeDefined();
    expect(SECURITY_BASELINE_CAPABILITIES).toContain(scritta);
    expect(SECURITY_BASELINE_CAPABILITIES).toContain(shellCapability);
    expect(SECURITY_BASELINE_CAPABILITIES).toContain(httpCapability);
  });

  it('l unica capability inventata e dichiaratamente da eval', () => {
    // La produzione non spedisce niente verso l esterno, e la distinzione di
    // policy si prova lo stesso. L id lo dice, cosi nessuno la scambia per una
    // capability che Muffin ha davvero.
    const inventate = SECURITY_BASELINE_CAPABILITIES.filter(
      (c) => c !== shellCapability && c !== httpCapability && !fsCapabilities.includes(c),
    );
    expect(inventate.map((c) => c.id)).toEqual(['outward.send.eval']);
  });

  it('lo scalino che misura e quello vero: sys.shell accetta taint 2 e non 3', () => {
    // Ogni scenario S1/S3 misura questo gradino, deciso dall owner il 16/08
    // (ADR-0044 §revisione). Se la produzione lo ripinna, questa riga cade
    // insieme agli scenari, invece di lasciarli verdi a raccontare ieri.
    expect(shellCapability.maxTaint).toBe(2);
    expect(shellCapability.risk).toBe('high');
  });
});
