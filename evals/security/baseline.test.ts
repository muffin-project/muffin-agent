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

    // Ambient taint is not merely "stricter everywhere": the bare-host
    // read-only case stays identical by decision (no model-chosen bytes, no
    // gate). What changed on 22/09 (lane #624 + #641) is exactly one cell: a
    // read with a composed PATH at ambient taint now asks, so s5 is the
    // visible price of closing the exfiltration channel — measured here
    // rather than scored.
    expect(results.find((r) => r.id === 's5-external-value-read-more')).toMatchObject({
      ambient: 'ask',
      noAmbient: 'allow',
    });

    // **E il risultato che questa baseline riporta dal 06/09 (ADR-0075): su
    // ogni scena, per l'owner, A e B danno la stessa risposta.**
    //
    // Non è un allentamento delle fixture, è la misura ripetuta dopo un
    // cambiamento di produzione, ed è il seguito della frase che stava qui:
    // «rimuovere il taint ambientale non è una vittoria gratuita di utilità».
    // Lo era diventata, un pezzo alla volta. ADR-0074 aveva già portato le due
    // scene S1 a coincidere (`ask` da entrambe le parti, perché ciò che chiede
    // è l'irreversibilità e non il livello). Restavano due celle: un `deny` su
    // una scrittura con `muffin undo` dietro, e un `deny` su un messaggio
    // verso l'esterno che l'owner poteva approvare. ADR-0075 le ha misurate
    // dove finiscono — nove turni su quattordici a taint 3 il 06/09, con la
    // shell irraggiungibile — e le ha portate a `draft` e ad `ask`.
    //
    // Ciò che resta dello scalare, e che questa baseline **non** misura perché
    // interroga solo l'owner: sopra il soffitto di `external`/`outward` un
    // principal che non è l'owner riceve ancora `deny`
    // (`core/policy/solo-irreversibile.test.ts`), e il livello continua a
    // marchiare gli episodi e a comparire in ogni domanda. Il taint non è
    // sparito: ha smesso di essere l'autorità in carica sull'host.
    //
    // Rimisurata il 22/09 (lane #624 + #641): A e B coincidono su ogni scena
    // TRANNE la lettura con percorso composto (s5) — ambient chiede,
    // noAmbient lascia passare. Quella singola divergenza è l'impronta della
    // decisione: byte scelti dal modello in uscita a taint >= 2 chiedono
    // all'owner. Se un giorno diverge altro, è una regressione o una nuova
    // decisione, e questa riga è il posto dove si vede.
    const differenti = results.filter((r) => r.ambient !== r.noAmbient);
    expect(differenti.map((r) => r.id)).toEqual(['s5-external-value-read-more']);

    // La stessa cosa detta per nome sulle due celle che ADR-0075 ha spostato,
    // perché un `filter` vuoto sarebbe verde anche se l'elenco delle scene si
    // svuotasse.
    expect(results.find((r) => r.id === 's5-external-destination-outward')).toMatchObject({
      ambient: 'ask',
      noAmbient: 'ask',
    });
    expect(results.find((r) => r.id === 's2-web-docs-owner-write')).toMatchObject({
      ambient: 'draft',
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

  it('lo scalino che questa baseline misura non esiste piu: sulla riga host il taint non nega', () => {
    // Questa riga si chiamava «sys.shell.write accetta taint 2 e non 3» e
    // asseriva `denyAbove: 2`, perché ogni scenario S1/S3 misurava quel
    // gradino (decisione owner del 16/08, ADR-0044 §revisione). Il gradino è
    // stato tolto da ADR-0075, dopo averlo misurato dove finisce, e questa
    // riga cambia con lui invece di lasciare gli scenari verdi a raccontare
    // ieri — che è esattamente la ragione per cui esiste.
    //
    // Ciò che ancora decide qui non è il livello ma la reversibilità: la
    // capability è `high` e `reversible: 'no'`, quindi chiede a ogni taint.
    expect(shellWriteCapability.effect).toBe('host');
    expect(shellWriteCapability.maxTaint).toBeUndefined();
    expect(POLICY_FLOOR.rows.host.denyAbove).toBe(3);
    expect(POLICY_FLOOR.rows.host.asksForIrreversible).toBe(true);
    expect(shellWriteCapability.risk).toBe('high');
    expect(shellWriteCapability.reversible).toBe('no');
  });

  /**
   * E la corsia che questa baseline **non** misura, nominata perché il
   * silenzio si legge come «non esiste».
   *
   * Dal 06/09 (ADR-0074 punto 4) `sys.shell` è la shell in sola lettura. Il
   * 2026-09-22 la misura Linux (#645, ADR-0091) ha mostrato che le letture
   * coprono l'intera macchina: la disclosure è irreversibile e Linux AF_UNIX
   * può raggiungere servizi locali, quindi la corsia è `risk: 'high'`,
   * `reversible: 'no'` e chiede quanto la sorella. Non ha una riga in
   * `SECURITY_BASELINE_CAPABILITIES` perché non c'è un gradino da misurare —
   * ma se qualcuno la ridichiarasse `yes` per «costruzione», o le rimettesse
   * un tool che scrive, il rosso deve arrivare qui e non in un documento.
   */
  it('la corsia in sola lettura è irreversibile quanto la sorella (ADR-0091)', () => {
    expect(shellCapability.id).toBe('sys.shell');
    expect(shellCapability.risk).toBe('high');
    expect(shellCapability.reversible).toBe('no');
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
