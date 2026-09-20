import { describe } from 'vitest';
import { install } from '../harness.js';
import { HEADLESS_TURN_TIMEOUT_SECONDS, headlessTestTimeoutMs } from '../turn-budget.js';
import { scenario } from '../scenario.js';

/**
 * D15 · Il registro degli effetti, sul binario vero.
 *
 * La riga chiede: *dopo ADR-0074 l'owner vede **cosa è passato senza domanda**
 * — per turno e per giornata — e non solo cosa gli è stato chiesto?* Tre cose
 * devono valere insieme, e questo scenario le esercita in un giro solo perché
 * una qualsiasi delle tre da sola non chiude la riga:
 *
 *  1. la scrittura reversibile passa **senza `ask`** e lascia sulla propria
 *     riga la classe di reversibilità, la riga della matrice che l'ha ammessa
 *     e su cosa ha agito;
 *  2. quella riga si legge dal **meccanismo canonico** — la stessa
 *     `readEffects` per ogni porta — qui attraverso `muffin effects`, che è
 *     l'interfaccia da operatore;
 *  3. l'owner ci arriva **parlando**: un secondo turno in cui il modello chiama
 *     `sys_effects` e il registro entra nel contesto della risposta, senza che
 *     nessuna approvazione venga chiesta e senza che l'owner debba conoscere
 *     una parola di comando (decisione owner 07/09, `docs/product/VISION.md`).
 *
 * **La mutazione che deve arrossare questo file** è togliere la scrittura dei
 * metadata d'effetto in `agent/loop/tool-call.ts` (l'oggetto `effect` passato a
 * `recordIntent`, o le quattro colonne in `TurnStore.startToolCall`): il
 * registro tornerebbe a dire «riga non registrata», e sia il punto 2 sia il
 * punto 3 qui sotto falliscono per nome. Un'asserzione sulla sola *esistenza*
 * della riga non l'avrebbe vista: quella riga c'era già prima di D15.
 */

describe('acceptance · D15 · registro degli effetti', () => {
  scenario(
    'D15',
    async () => {
      const inst = await install({
        main: [
          // Turno 1: una scrittura reversibile. `fs.write` è `undoable` sulla
          // riga `host`, che dopo ADR-0074 non chiede — è esattamente «una
          // scrittura ammessa senza ask» che la riga nomina.
          {
            tool: {
              name: 'fs_write',
              args: { path: 'diario.md', content: 'oggi ho fatto qualcosa' },
            },
          },
          // Una capability **senza risorsa** per il kernel (`memory.read` è
          // `resourceKind: 'tenant'`, quindi `resourceFor` risponde `none`).
          // Sull'installazione dell'owner questa è la forma dominante —
          // `sys.shell` da solo è 42 delle 111 chiamate degli ultimi sette
          // giorni — e senza il ramo che riassume gli argomenti il «su cosa»
          // del registro sarebbe vuoto proprio dove serve di più.
          { tool: { name: 'memory_search', args: { query: 'diario di settembre' } } },
          { text: 'fatto, ho scritto diario.md' },
          // Turno 2: l'owner chiede a parole. Il modello sceglie il tool; qui
          // la scelta è copionata, perché ciò che questo scenario prova è che
          // la **strada esista e arrivi in fondo**, non che un modello finto
          // sappia scegliere. Che il tool sia offerto e descritto per questa
          // domanda è asserito sotto, sulla lista `tools` della chiamata vera.
          { tool: { name: 'sys_effects', args: { scope: 'today' } } },
          { text: 'oggi ho scritto diario.md, senza chiedertelo.' },
        ],
      });
      try {
        const scrittura = await inst.muffin(['run', '--timeout', String(HEADLESS_TURN_TIMEOUT_SECONDS), 'scrivi il diario di oggi']);
        if (scrittura.code !== 0) {
          throw new Error(
            `il turno di scrittura non completa: exit ${scrittura.code}\n${scrittura.err}`,
          );
        }

        // ── 1. la riga porta i metadata d'effetto ───────────────────────────
        //
        // Letta dal database con SQL esplicito e non dalla stampa: se il
        // formattatore cambiasse parole questo controllo deve restare quello
        // che è, cioè «le colonne sono piene».
        const riga = inst.db(
          (db) =>
            db
              .prepare(
                `SELECT turn_id AS turnId, tool, capability, effect_row AS effectRow, reversible, resource, decision
                 FROM turn_tool_calls WHERE tool = 'fs_write' ORDER BY started_at DESC LIMIT 1`,
              )
              .get() as
              | {
                  turnId: string;
                  tool: string;
                  capability: string;
                  effectRow: string | null;
                  reversible: string | null;
                  resource: string | null;
                  decision: string | null;
                }
              | undefined,
        );
        if (!riga)
          throw new Error(
            'nessuna riga fs_write in turn_tool_calls: la scrittura non è stata registrata',
          );
        if (riga.effectRow !== 'host') {
          throw new Error(
            `la riga della matrice non è registrata (attesa 'host', trovata ${JSON.stringify(riga.effectRow)}): ` +
              `il registro degli effetti non sa dire cosa ha ammesso questa chiamata`,
          );
        }
        if (riga.reversible !== 'undoable') {
          throw new Error(
            `la classe di reversibilità non è registrata (attesa 'undoable', trovata ${JSON.stringify(riga.reversible)})`,
          );
        }
        if (riga.decision !== 'allow' && riga.decision !== 'draft') {
          throw new Error(
            `la scrittura non risulta passata senza domanda (decision=${JSON.stringify(riga.decision)}): ` +
              `D15 esiste per distinguere questo caso, e senza il campo non è distinguibile`,
          );
        }
        if (riga.resource === null || !riga.resource.includes('diario.md')) {
          throw new Error(
            `il registro non dice su cosa ha agito (resource=${JSON.stringify(riga.resource)}): ` +
              `args_digest confronta due chiamate, non racconta nessuna delle due`,
          );
        }

        // ── 2. il meccanismo canonico, per turno e per giornata ─────────────
        const perTurno = await inst.muffin(['effects', '--turn', riga.turnId]);
        if (perTurno.code !== 0)
          throw new Error(`muffin effects --turn esce ${perTurno.code}: ${perTurno.err}`);
        for (const atteso of [
          'fs_write',
          'fs.write',
          'diario.md',
          'riga host',
          'reversibile: undoable',
          'senza chiedere',
          // La capability senza risorsa: gli argomenti riassunti dalla stessa
          // funzione che il ramo `ask` mostra all'owner, non un campo vuoto.
          'su query: diario di settembre',
        ]) {
          if (!perTurno.out.includes(atteso)) {
            throw new Error(
              `il registro per turno non contiene ${JSON.stringify(atteso)}: ${JSON.stringify(perTurno.out)}`,
            );
          }
        }
        const perGiornata = await inst.muffin(['effects']);
        if (perGiornata.code !== 0)
          throw new Error(`muffin effects esce ${perGiornata.code}: ${perGiornata.err}`);
        if (!perGiornata.out.includes('diario.md')) {
          throw new Error(
            `la lettura per giornata non trova la scrittura di oggi: ${JSON.stringify(perGiornata.out)}`,
          );
        }
        // La stessa riga, non una lista qualunque: la giornata deve contare
        // almeno una chiamata passata senza domanda, o «senza domanda» è una
        // parola nel formattatore invece che un fatto sulla riga.
        if (!/[1-9]\d* senza domanda/.test(perGiornata.out)) {
          throw new Error(
            `la giornata non conta nessuna chiamata senza domanda: ${JSON.stringify(perGiornata.out)}`,
          );
        }

        // ── 3. la strada dell'owner: chiedendolo, senza sapere un comando ───
        const domanda = await inst.muffin(['run', '--timeout', String(HEADLESS_TURN_TIMEOUT_SECONDS), 'cosa hai fatto oggi?']);
        if (domanda.code !== 0) {
          throw new Error(
            `il turno della domanda non completa: exit ${domanda.code}\n${domanda.err}`,
          );
        }
        // Nessuna approvazione: la riga `context` ammette a ogni taint, e
        // chiedere il rendiconto non deve mai essere una cosa da autorizzare.
        if (/approvazione|approva|\[ASK\]/i.test(domanda.out)) {
          throw new Error(
            `chiedere il rendiconto ha chiesto conferma: ${JSON.stringify(domanda.out)}`,
          );
        }

        const chiamate = inst.provider.main();
        // Il tool è **offerto**: se il tetto del profilo lo tagliasse, un owner
        // vero non potrebbe arrivarci nemmeno chiedendo, e lo scenario sarebbe
        // verde su una strada che in produzione non esiste.
        const offerto = chiamate.some((c) => c.tools.includes('sys_effects'));
        if (!offerto) {
          throw new Error(
            `sys_effects non è mai stato offerto al modello (tool visti: ${JSON.stringify(chiamate.at(-1)?.tools)}): ` +
              `la strada conversazionale non esiste per un'installazione reale`,
          );
        }
        // E il registro è **arrivato nel contesto** della risposta: l'ultima
        // chiamata al modello è quella dopo il tool, quindi la sua trascrizione
        // porta il risultato. È qui che la mutazione si vede — senza i
        // metadata, il testo direbbe «riga non registrata».
        const ultima = chiamate.at(-1);
        if (!ultima) throw new Error('il modello non è mai stato chiamato nel secondo turno');
        for (const atteso of ['diario.md', 'riga host', 'senza chiedere']) {
          if (!ultima.transcript.includes(atteso)) {
            throw new Error(
              `il registro non è arrivato al modello che deve rispondere all'owner: manca ${JSON.stringify(atteso)}`,
            );
          }
        }
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(2),
  );
});
