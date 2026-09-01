import { describe, expect, it } from 'vitest';
import { entry, promoteMarker } from './manifest.js';
import { annunciaSalto } from './non-provabile.js';
import { chiaviEsito, verdictFor, type InventoryRow, type TestOutcome } from './report.js';
import { guardAttesoRosso, titoloDelSalto } from './scenario.js';

/**
 * `guardAttesoRosso` is the mechanism that replaced plain `it.fails` (mandato
 * readiness-criteria.md#day-1-ready / P39): an `atteso-rosso` scenario is only "correctly red" if it
 * throws for the reason the manifest declares, not for any reason at all.
 * These tests drive it directly with a fake `fn`, so they run in milliseconds
 * and do not need a live vitest suite underneath them — the same reason
 * `report.test.ts` drives `summarize`/`verdictFor` directly instead of
 * spawning the real acceptance suite.
 */
describe('guardAttesoRosso — the atteso-rosso failure signature', () => {
  it('resolves when fn throws an error matching the declared expectFailure regex', async () => {
    await expect(
      guardAttesoRosso(
        'X1',
        async () => {
          throw new Error('il registro non esiste ancora');
        },
        { kind: 'atteso-rosso', reason: 'nessun registro', closedBy: 'slice/fake', expectFailure: /registro non esiste/ },
      ),
    ).resolves.toBeUndefined();
  });

  it('resolves when fn throws and the declared expectFailure is a predicate that matches', async () => {
    await expect(
      guardAttesoRosso(
        'X1',
        async () => {
          throw new Error('boom');
        },
        {
          kind: 'atteso-rosso',
          reason: 'r',
          closedBy: 'c',
          expectFailure: (error) => error instanceof Error && error.message === 'boom',
        },
      ),
    ).resolves.toBeUndefined();
  });

  // The gap this closes: `it.fails` alone marked this "passed" too, which is
  // exactly how D10's stale reason (PR #28) went unnoticed — the scenario kept
  // throwing, just not for the reason requirements-status.md still named.
  it('rejects, naming the declared reason, when fn throws for a DIFFERENT reason than declared', async () => {
    await expect(
      guardAttesoRosso(
        'X2',
        async () => {
          throw new Error('un crash del tutto scollegato');
        },
        { kind: 'atteso-rosso', reason: 'la ragione dichiarata nel manifest', closedBy: 'slice/fake', expectFailure: /registro non esiste/ },
      ),
    ).rejects.toThrow(/la ragione dichiarata nel manifest.*un crash del tutto scollegato/s);
  });

  it('rejects with the promote marker when fn does not throw at all', async () => {
    await expect(
      guardAttesoRosso(
        'X3',
        async () => {
          // no-op: the gap the manifest describes is gone
        },
        { kind: 'atteso-rosso', reason: 'r', closedBy: 'c', expectFailure: /never matches this branch/ },
      ),
    ).rejects.toThrow(new RegExp(promoteMarker('X3').replace(/[()]/g, '\\$&')));
  });
});

/**
 * Il giro completo fra chi scrive l'etichetta di un salto (`scenario.ts`) e chi
 * la legge (`report.ts`), su una voce **vera** del manifest.
 *
 * Il ramo del salto dichiarato era irraggiungibile dalla produzione: il test si
 * intitolava con la riga (`"A1 [non provabile qui: …]"`) e `report.ts` cercava
 * l'esito per suffisso del titolo di manifest — che non contiene nemmeno la
 * riga (A1 si intitola «continuity: …»). Risultato misurato dal giudice di
 * questa slice: `verdictFor -> {"kind":"nessuno-scenario"}`, la riga contata
 * come scoperta, e lo stesso test contato una seconda volta come «fuori
 * inventario». Nessun test moriva.
 *
 * Questo test non confronta due costanti: parte dall'etichetta vera e chiede a
 * `chiaviEsito` — la ricerca vera — di ritrovarla.
 */
describe('titoloDelSalto — l\'etichetta che report.ts deve ritrovare', () => {
  const meta = entry('A1');
  const motivo = 'bwrap grezzo non contiene su questo host: bwrap: execvp argv[0]: No such file';
  const titolo = titoloDelSalto(meta, motivo, () => {});

  it('intitola col titolo di manifest, non con la riga', () => {
    // Il titolo di manifest inizia già con la riga (`"A1 continuity: …"`),
    // quindi il segno che le due etichette si sono separate non è il prefisso:
    // è tutto il resto del titolo, che la forma vecchia buttava via.
    expect(titolo).toBe(annunciaSalto(meta.title, motivo, () => {}));
    expect(titolo).not.toBe(annunciaSalto(meta.row, motivo, () => {}));
  });

  it('resta trovabile da chiaviEsito anche dopo che vitest ci ha messo davanti il describe', () => {
    const fullName = `acceptance · il giro dell'owner ${titolo}`;
    const results = new Map<string, TestOutcome>([[fullName, { status: 'skipped', failureMessages: [] }]]);

    expect(chiaviEsito(meta.title, results)).toEqual([fullName]);
  });

  it('porta il motivo intero fino al verdetto, parentesi quadre comprese', () => {
    const results = new Map<string, TestOutcome>([[titolo, { status: 'skipped', failureMessages: [] }]]);
    const riga: InventoryRow = { id: 'A1', area: 'Test', question: 'domanda?', stato: 'READY', rawStato: 'READY' };

    expect(verdictFor(riga, [meta], results)).toEqual({ kind: 'non-provabile-qui', reason: motivo });
  });
});
