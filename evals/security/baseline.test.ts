import { describe, expect, it } from 'vitest';
import { sendFileCapability } from '../../agent/tools/deliver.js';
import { fsCapabilities } from '../../agent/tools/fs.js';
import { httpCapability } from '../../agent/tools/http.js';
import { shellCapability, shellWriteCapability } from '../../agent/tools/shell.js';
import { memoryWriteCapability, replyCapability } from '../../core/policy/doors.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
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
    expect(SECURITY_BASELINE_CAPABILITIES).toContain(shellWriteCapability);
    expect(SECURITY_BASELINE_CAPABILITIES).toContain(httpCapability);
    // Le tre porte di sink. Le due di ADR-0055 non sono registrate da nessun
    // runtime: le dichiara il kernel (`core/policy/doors.ts`), ed e quello
    // l oggetto che deve arrivare qui — una copia misurerebbe una porta che
    // nessuna risposta attraversa.
    expect(SECURITY_BASELINE_CAPABILITIES).toContain(sendFileCapability);
    expect(SECURITY_BASELINE_CAPABILITIES).toContain(replyCapability);
    expect(SECURITY_BASELINE_CAPABILITIES).toContain(memoryWriteCapability);
  });

  it('l unica capability inventata e dichiaratamente da eval', () => {
    // La produzione non spedisce niente verso l esterno, e la distinzione di
    // policy si prova lo stesso. L id lo dice, cosi nessuno la scambia per una
    // capability che Muffin ha davvero.
    const diProduzione = [
      shellWriteCapability,
      httpCapability,
      sendFileCapability,
      replyCapability,
      memoryWriteCapability,
      ...fsCapabilities,
    ];
    const inventate = SECURITY_BASELINE_CAPABILITIES.filter((c) => !diProduzione.includes(c));
    expect(inventate.map((c) => c.id)).toEqual(['outward.send.eval']);
  });

  it('lo scalino che misura e quello vero: sys.shell.write accetta taint 2 e non 3', () => {
    // Ogni scenario S1/S3 misura questo gradino, deciso dall owner il 16/08
    // (ADR-0044 §revisione). Se la produzione lo sposta, questa riga cade
    // insieme agli scenari, invece di lasciarli verdi a raccontare ieri.
    //
    // Dal 02/09 il gradino non è più un numero appuntato su questa capability:
    // è la riga `host` della matrice normativa (ADR-0053), che lo dà a
    // `sys.shell` e a `fs.write` insieme — le due porte allo stesso disco, che
    // prima avevano due regole opposte.
    expect(shellWriteCapability.effect).toBe('host');
    expect(shellWriteCapability.maxTaint).toBeUndefined();
    expect(POLICY_FLOOR.rows.host.denyAbove).toBe(2);
    expect(shellWriteCapability.risk).toBe('high');
  });

  /**
   * E la corsia che questa baseline **non** misura, nominata perché il
   * silenzio si legge come «non esiste».
   *
   * Dal 06/09 (ADR-0074 §4) `sys.shell` è la shell in sola lettura: sandbox
   * senza scrittura fuori dallo scratch e senza rete, quindi `reversible:
   * 'yes'` e nessun `ask`. Non ha una riga in `SECURITY_BASELINE_CAPABILITIES`
   * perché non c'è un gradino da misurare — ma se qualcuno la ridichiarasse
   * `high`/`no` per «coerenza» con la sorella, o le rimettesse un tool che
   * scrive, il rosso deve arrivare qui e non in un documento.
   */
  it('la corsia in sola lettura resta reversibile per costruzione', () => {
    expect(shellCapability.id).toBe('sys.shell');
    expect(shellCapability.risk).toBe('low');
    expect(shellCapability.reversible).toBe('yes');
    expect(shellCapability.effect).toBe('host');
  });

  /**
   * L asimmetria che il memo del 02/09 §1.3 ha misurato, tenuta aperta come
   * asserzione invece che come tabella in un documento.
   *
   * Le tre porte che finiscono nella stessa chat dell owner — allegare il file,
   * rispondere col suo testo, ricordarsene — stanno sulla stessa riga della
   * matrice normativa e devono rispondere lo stesso numero. Fino ad ADR-0053
   * la prima diceva `deny` a taint 2 e la seconda non passava dal kernel
   * affatto; se tornano a divergere, questa riga cade prima degli scenari.
   */
  it('le porte di sink stanno sulle righe che il threat model gli assegna', () => {
    expect(sendFileCapability.effect).toBe('reply');
    expect(replyCapability.effect).toBe('reply');
    expect(memoryWriteCapability.effect).toBe('memory');
    expect(POLICY_FLOOR.rows.reply.denyAbove).toBe(3);
    expect(POLICY_FLOOR.rows.memory.denyAbove).toBe(3);
  });
});
