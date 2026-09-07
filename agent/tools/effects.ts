import type { CapabilityDecl } from '../../core/policy/types.js';
import { formatEffects, localDay } from '../../core/turns/effects.js';
import type { TurnStore } from '../../core/turns/store.js';
import type { RegisteredTool } from '../loop.js';
import type { ToolSpec } from '../providers/types.js';

/**
 * `sys_effects` — la porta **conversazionale** sul registro degli effetti
 * (DAY-1 requirement D15).
 *
 * ## Perché è un tool e non un comando
 *
 * Decisione owner del 07/09/2026, ora in `docs/VISION.md`: *il normale owner
 * opera Muffin parlandogli, non imparando un vocabolario di comandi*. La
 * formulazione originale di D15 chiedeva `muffin effetti` «e lo stesso comando
 * in REPL e Telegram» — cioè esattamente il vocabolario che quella decisione
 * ha tolto dal tavolo. Chi chiede «cosa hai fatto oggi?» deve ricevere una
 * risposta, non imparare una parola.
 *
 * Un comando CLI esiste comunque (`muffin effects`) e resta dove la VISION lo
 * mette: interfaccia da sviluppatore e da operatore, per il recovery e per
 * leggere un database che non è quello vivo. Non è la via dell'owner, e non è
 * l'unica via: legge la **stessa** `readEffects` che legge questo handler.
 *
 * ## Perché un tool nuovo e non una sezione di `sys_inspect`
 *
 * `sys_inspect` risponde a «com'è fatta questa istanza **adesso**» — la
 * configurazione viva, senza argomenti. Il registro degli effetti risponde a
 * «cosa ho fatto», ha uno scope (questo turno / oggi) e quindi degli
 * argomenti, e cresce con la storia invece di descrivere lo stato. Infilarlo
 * là avrebbe fatto due tool in uno e avrebbe caricato ogni ispezione della
 * configurazione con una lista di chiamate che nessuno aveva chiesto.
 *
 * Il costo è reale e va detto: un tool in più è un posto in più sotto il tetto
 * `profile.maxToolsExposed`, e `agent/runtime-exposure.test.ts` diventa rosso
 * appena il tetto ricomincia a tagliare — di proposito, perché il difetto
 * misurato il 27/08/2026 è proprio un tool che sparisce in silenzio. Il tetto
 * sale con lo stesso criterio contato di sempre: **quanti tool registra
 * davvero l'installazione**, non una stima.
 */
export const effectsCapability: CapabilityDecl = {
  id: 'sys.effects',
  /**
   * `context`: byte che entrano nel turno, niente che esce, niente che cambia
   * sull'host. È la stessa riga di `sys.inspect`, e le tre condizioni sono
   * letteralmente vere qui — la query è `SELECT`, su un database che è già
   * nostro.
   *
   * Conseguenza voluta, ed è il punto 3 di D15: la riga `context` ammette a
   * ogni taint, quindi chiedere «cosa hai fatto oggi» **non chiede conferma**,
   * nemmeno in un turno che ha appena letto il web.
   */
  effect: 'context',
  /** Una lettura del nostro stesso record: non impegna niente, non spende niente. */
  risk: 'low',
  reversible: 'yes',
  /** Due letture identiche danno la stessa risposta, o una più fresca. */
  rerunnable: true,
  resourceKind: 'none',
  policyArgs: [],
  /**
   * `hostOnly: true`, come `sys.inspect` e per la stessa ragione, qui più
   * stretta ancora: il contenuto è **cosa Muffin ha fatto per il suo owner** —
   * percorsi sul suo disco, URL che ha raggiunto, comandi che ha eseguito. Un
   * membro di un gruppo che lo chiedesse otterrebbe la giornata di qualcun
   * altro, e nessuna di quelle righe gli serve per la conversazione che sta
   * avendo. Il registro di una stanza è una domanda diversa, e D15 non la fa.
   */
  hostOnly: true,
};

/**
 * Il tetto di righe rese al modello.
 *
 * Una giornata piena sull'installazione dell'owner sta ampiamente sotto (il
 * massimo osservato il 07/09/2026 su `turn_tool_calls` è 42 chiamate in
 * sette giorni), ma «ampiamente sotto oggi» è come si arriva a un turno che
 * spende metà del contesto in un elenco. Le più recenti, perché la domanda è
 * «cosa hai fatto» e la risposta utile parte da poco fa; il taglio si
 * dichiara nel testo invece di sparire.
 */
const MAX_RIGHE = 60;

const effectsSpec: ToolSpec = {
  name: 'sys_effects',
  description:
    'Read-only: cosa hai effettivamente FATTO — le chiamate a tool registrate, con la riga della matrice che ' +
    'le ha ammesse, su cosa hanno agito, se erano reversibili e se sono passate senza chiedere conferma o dopo ' +
    'averla chiesta. Usalo quando ti si chiede cosa hai fatto oggi, cosa hai fatto in questo turno, cosa hai ' +
    "toccato o scritto, o cosa è passato senza che l'owner venisse interpellato: la risposta è letta dal record " +
    'durevole, non ricordata. `scope: "turn"` per il turno corrente, `scope: "today"` (default) per la ' +
    "giornata. Non per sapere come sei configurato (per quello c'è sys_inspect) e non per cosa hai *detto*: la conversazione la hai davanti, questo elenca solo cosa hai fatto.",
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['turn', 'today'],
        description:
          "'turn' = solo questo turno. 'today' = tutta la giornata locale. Default: 'today'.",
      },
    },
    required: [],
  },
};

/**
 * Il tool, sopra l'unico meccanismo che sa leggere il registro.
 *
 * `TurnStore.effects` e non una query propria: è la stessa regola che
 * `sys_inspect` si è data — *legge dalle stesse fonti autorevoli, non
 * ricalcola niente* — e senza di essa `muffin effects` e questo handler
 * sarebbero due risposte alla stessa domanda.
 */
export function makeEffectsTool(
  turns: Pick<TurnStore, 'effects'>,
  now: () => Date = () => new Date(),
): RegisteredTool {
  return {
    capability: effectsCapability.id,
    spec: effectsSpec,
    /**
     * `throwTier: 0`: ogni lancio raggiungibile da qui è un errore SQLite di
     * `readEffects`, cioè testo nostro. Nessun byte di terzi passa da questo
     * handler — la `resource` che stampa è già passata da `redactText` quando
     * è stata scritta.
     */
    throwTier: 0,
    /**
     * `keepResult`: la risposta a «cosa hai fatto oggi» **è** il fondamento
     * della frase che il modello sta per dire. Se la compattazione del contesto
     * la buttasse, resterebbe un modello che ha appena letto il registro e
     * risponde a memoria — che è precisamente il guasto misurato il 06/09 sul
     * dogfood («ha misurato una volta e ragionato su un ricordo vecchio»).
     */
    keepResult: true,
    handler: (args, ctx) => {
      const a = (args ?? {}) as { scope?: unknown };
      const scope = a.scope === 'turn' ? 'turn' : 'today';
      /**
       * `tier: 0`, dichiarato invece che lasciato al default.
       *
       * Il contenuto è il nostro stesso record: `tool`, `capability`, la riga
       * della matrice, un percorso già redatto. Nessuno di questi campi è mai
       * stato scritto dal modello o da una pagina — l'unico campo di
       * `turn_tool_calls` che porta byte di terzi è `content`, cioè il
       * risultato del tool, e questo report non lo legge affatto. Se un giorno
       * lo leggesse, questo numero dovrebbe salire con lui.
       */
      const CLEAN: 0 = 0;
      const adesso = now();
      const report =
        scope === 'turn'
          ? turns.effects({ turnId: ctx.turnId })
          : turns.effects({
              // La giornata **locale** di chi sta usando Muffin, non quella di
              // Greenwich: `started_at` è UTC, e senza l'offset «oggi» perde le
              // prime ore del giorno per chi vive a est di Londra.
              day: localDay(adesso),
              tzOffsetMinutes: adesso.getTimezoneOffset(),
            });

      const tagliato = report.calls.length > MAX_RIGHE;
      const reso = tagliato ? { ...report, calls: report.calls.slice(-MAX_RIGHE) } : report;
      const nota = tagliato
        ? `\n(mostrate le ultime ${MAX_RIGHE} di ${report.calls.length}: i totali sopra contano tutte.)`
        : '';
      return { content: `${formatEffects(reso)}${nota}`, tier: CLEAN };
    },
  };
}
