import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeBaselineHarness } from './baseline.js';
import { makeTupleHarness } from './candidate-b.js';
import { ALL_AB_SCENARIOS, TUPLE_EXPECTATIONS } from './flow.js';
import { SECURITY_BASELINE_CAPABILITIES, SECURITY_BASELINE_SCENARIOS } from './scenarios.js';

/**
 * Il seam A/B/B-tupla, sulle **stesse azioni normalizzate**.
 *
 * `baseline.test.ts` stabilisce la proprietà che qui si estende e non si
 * forka: un solo oggetto `action`, tre input di autorità diversi, e nient'altro
 * che cambia. A vede lo scalare di produzione, B-senza-taint vede 0, B-tupla
 * vede `(riga d'effetto × sink × chi ha scelto × reversibilità)`. La tabella
 * che questo file stampa è il layer deterministico dell'eval; il layer che
 * misura se un attacco **riesce** gira sul binario vero
 * (`evals/security/attacks/`).
 */

const runAB = makeBaselineHarness({
  capabilities: SECURITY_BASELINE_CAPABILITIES,
  hardened: true,
  egressAllowed: () => true,
});

const runB = makeTupleHarness({
  capabilities: SECURITY_BASELINE_CAPABILITIES,
  hardened: true,
  egressAllowed: () => true,
});

describe('A/B/B-tupla — stessa azione normalizzata, tre input di autorità', () => {
  it('ogni scena della baseline ha un flusso e un atteso per B, o questa riga cade', () => {
    for (const scenario of SECURITY_BASELINE_SCENARIOS) {
      expect(
        TUPLE_EXPECTATIONS[scenario.id],
        `lo scenario '${scenario.id}' non ha un atteso per candidate B in flow.ts`,
      ).toBeDefined();
    }
  });

  for (const scenario of ALL_AB_SCENARIOS) {
    it(`${scenario.id}: ${scenario.claim}`, () => {
      const [ambient, noAmbient] = runAB(scenario.action);
      const tupla = runB(scenario.action, { chosenBy: scenario.flow });

      expect(ambient.decision.effect, `A · ${scenario.id}`).toBe(scenario.expect.ambient);
      expect(noAmbient.decision.effect, `B-senza-taint · ${scenario.id}`).toBe(scenario.expect.noAmbient);
      expect(tupla.decision.effect, `B-tupla · ${scenario.id} — ${tupla.because}`).toBe(scenario.expectTuple);

      // La spiegabilità non è uno slogan: la frase deve nominare i quattro
      // campi su cui la decisione è stata presa.
      expect(tupla.because).toContain(tupla.tuple.row);
      expect(tupla.because).toContain(tupla.tuple.chosenBy);
    });
  }

  it("l'unica variabile fra le tre corse è l'input di autorità", () => {
    for (const scenario of ALL_AB_SCENARIOS) {
      const [ambient, noAmbient] = runAB(scenario.action);
      expect(ambient.effectiveTaint).toBe(scenario.action.ambientTaint);
      expect(noAmbient.effectiveTaint).toBe(0);
      // B non riscrive i gate che non sono il taint: un `deny` strutturale di A
      // a taint 0 resta un `deny` per B, qualunque cosa dica la tupla.
      if (noAmbient.decision.effect === 'deny') {
        expect(runB(scenario.action, { chosenBy: scenario.flow }).decision.effect).toBe('deny');
      }
    }
  });

  it('la coppia che decide il kill criterion: stessa azione, cambia solo chi ha scelto la destinazione', () => {
    const owner = ALL_AB_SCENARIOS.find((s) => s.id === 'f1-egress-allowlisted-owner-chosen');
    const content = ALL_AB_SCENARIOS.find((s) => s.id === 'f2-egress-allowlisted-content-chosen');
    if (!owner || !content) throw new Error('la coppia f1/f2 è sparita da flow.ts');

    // Stesso host, stesso taint, stessa capability: A **deve** rispondere lo
    // stesso, perché lo scalare non ha un campo in cui la differenza esista.
    expect(owner.action.ambientTaint).toBe(content.action.ambientTaint);
    expect(runAB(owner.action)[0].decision.effect).toBe(runAB(content.action)[0].decision.effect);

    // B risponde diverso, e la coppia è a parità di utility: il membro
    // legittimo passa in entrambe.
    expect(runB(owner.action, { chosenBy: 'owner' }).decision.effect).toBe('allow');
    expect(runB(content.action, { chosenBy: 'content' }).decision.effect).toBe('deny');
  });

  it('stampa la tabella dei verdetti', () => {
    const righe = ALL_AB_SCENARIOS.map((s) => {
      const [a, b0] = runAB(s.action);
      const bt = runB(s.action, { chosenBy: s.flow });
      return `  ${s.id.padEnd(40)} taint=${s.action.ambientTaint} scelta=${s.flow.padEnd(19)} A=${a.decision.effect.padEnd(6)} B0=${b0.decision.effect.padEnd(6)} Btupla=${bt.decision.effect}`;
    });
    process.stderr.write(`\nA/B/B-tupla · ${righe.length} azioni normalizzate\n${righe.join('\n')}\n`);
    expect(righe.length).toBeGreaterThan(0);
  });
});

/**
 * La riga che tiene l'esperimento fuori dalla produzione.
 *
 * `candidate-b.ts` dichiara di essere irraggiungibile dal runtime; questa
 * funzione lo **verifica** leggendo l'albero, perché una dichiarazione in un
 * docstring è esattamente il tipo di promessa che questo repository ha già
 * pagato più volte. La direzione delle dipendenze deve restare a senso unico:
 * `evals/` importa la produzione, la produzione non importa `evals/`.
 */
const QUI = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(QUI, '..', '..');

function fileTs(dir: string, out: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === 'node_modules' || nome.startsWith('.')) continue;
    const pieno = join(dir, nome);
    if (statSync(pieno).isDirectory()) fileTs(pieno, out);
    // I `.test.ts` sono esclusi da `tsconfig.build.json` e non finiscono in
    // `dist/`: un test che importa una eval non è un percorso di produzione.
    // Il file che conta è quello che il runtime carica.
    else if (nome.endsWith('.ts') && !nome.endsWith('.test.ts')) out.push(pieno);
  }
  return out;
}

describe('candidate B non è raggiungibile dal runtime', () => {
  it("nessun file di produzione importa `evals/`", () => {
    const colpevoli: string[] = [];
    for (const cartella of ['core', 'agent', 'cli', 'connectors']) {
      const dir = join(REPO, cartella);
      for (const file of fileTs(dir)) {
        const testo = readFileSync(file, 'utf8');
        // `from '...evals/...'` in un import o in un import() dinamico.
        if (/from\s+['"][^'"]*\bevals\//.test(testo) || /import\(\s*['"][^'"]*\bevals\//.test(testo)) {
          colpevoli.push(file.slice(REPO.length + 1));
        }
      }
    }
    expect(colpevoli, `la produzione importa la eval: ${colpevoli.join(', ')}`).toEqual([]);
  });

  it("`tsconfig.build.json` non compila `evals/`", () => {
    const raw = JSON.parse(readFileSync(join(REPO, 'tsconfig.build.json'), 'utf8')) as {
      include?: string[];
    };
    // Una allowlist, non una denylist: `include` nomina le tre cartelle che
    // finiscono in `dist/`, e `evals/` non è una di quelle. Asserire
    // l'assenza da un `exclude` misurerebbe una lista che nessuno mantiene.
    expect(raw.include).toBeDefined();
    expect(raw.include?.some((p) => p.includes('evals'))).toBe(false);
  });
});
