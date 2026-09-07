import type Database from 'better-sqlite3';
import type { EffectRow, Reversibility } from '../policy/types.js';

/**
 * Il registro degli effetti (DAY-1 requirement D15): **cosa è passato senza
 * domanda**, per turno e per giornata.
 *
 * ## Perché non bastava ciò che c'era
 *
 * `core/approvals/store.ts` registra solo ciò che è stato **chiesto**. Dopo
 * ADR-0074 («si chiede solo l'irreversibile, sempre, anche in privato») quella
 * è la parte piccola: sull'installazione dell'owner, nei sette giorni al
 * 07/09/2026, `turn_tool_calls` contava 111 chiamate e `approvals` 81 righe in
 * tutta la sua storia, quasi tutte `sys.shell`. Più autonomia chiede più
 * sorveglianza, e la sorveglianza che serviva non esisteva: `turn_tool_calls`
 * registrava *ogni* chiamata ma non la classe di effetto che l'aveva lasciata
 * passare, quindi «cosa hai fatto oggi» non era una domanda a cui il record
 * potesse rispondere.
 *
 * ## Un solo meccanismo
 *
 * Questo file è la query, e non ce n'è una seconda: `TurnStore.effects`,
 * `muffin effects` e il tool `sys_effects` chiamano tutti e tre `readEffects`.
 * La ragione è la stessa che `sys_inspect` si è data nella sua prima riga —
 * *legge dalle stesse fonti autorevoli, non ricalcola niente* — e la stessa
 * per cui il taint ha una sola origine invece di un registro parallelo
 * (`PermissionSnapshot.taintOrigin`): due letture della stessa cosa sono due
 * risposte, libere di divergere il giorno che una delle due cambia.
 *
 * Legge `turn_tool_calls` e nient'altro: nessuna tabella nuova, nessun event
 * store. Le colonne che rendono la domanda rispondibile
 * (`effect_row`, `reversible`, `resource`, `decision`) stanno sulla riga che
 * ogni chiamata scriveva già — vedi il loro commento in `store.ts#SCHEMA`.
 */

/**
 * Ciò che il kernel ha risposto **prima** che l'handler toccasse il mondo.
 *
 * Tre valori e non quattro: `deny` non compare mai, perché una chiamata negata
 * non arriva a scrivere una riga d'intento (`agent/loop/tool-call.ts`: la riga
 * si scrive dopo il verdetto, «un intento per una chiamata negata sarebbe una
 * bugia su cosa è stato tentato»). Il registro degli effetti è il registro di
 * ciò che è **avvenuto**; le domande stanno in `approvals`, i rifiuti sulla
 * traccia.
 */
export type EffectDecision = 'allow' | 'draft' | 'ask';

/**
 * I metadata d'effetto di una chiamata, come li conosce il loop nel momento in
 * cui il kernel ha deciso e l'handler non è ancora partito.
 *
 * `null` significa **non registrato**, mai «nessuno»: una capability che il
 * runtime non trova (un tool MCP staccato fra la registrazione e la chiamata)
 * non ha una riga da dichiarare, e dire `null` è l'unica risposta vera. Il
 * lettore la stampa a parole invece di far finta.
 */
export type EffectMetadata = {
  /** `CapabilityDecl.effect` — la riga della matrice che ha ammesso la chiamata. */
  row: EffectRow | null;
  reversible: Reversibility | null;
  /**
   * Su cosa. Il percorso, l'URL, il tenant che il kernel ha giudicato — non
   * `args_digest`, che confronta due chiamate e non racconta nessuna delle
   * due. `null` per una capability `resourceKind: 'none'`, dove non c'è una
   * risorsa da nominare e inventarne una dagli argomenti sarebbe un secondo
   * modo di dire cosa è successo.
   */
  resource: string | null;
  decision: EffectDecision | null;
};

/** Una riga del registro, come la legge chi chiede «cosa hai fatto». */
export type EffectRecord = {
  turnId: string;
  callId: string;
  tool: string;
  capability: string;
  startedAt: string;
  /** `null` = intento senza esito: partita, mai chiusa (crash, o ancora in corso). */
  endedAt: string | null;
  isError: boolean | null;
  /** D11: `muffin undo` ha rimesso a posto questa chiamata. */
  undoneAt: string | null;
} & EffectMetadata;

/**
 * Cosa si sta guardando: un turno, o una giornata.
 *
 * Le due domande di D15, e nient'altro. `day` è una data locale `YYYY-MM-DD`
 * confrontata su `started_at`, che è UTC — vedi `dayBounds` per come i due si
 * incontrano senza che «oggi» significhi due cose diverse a seconda del fuso.
 */
export type EffectsFilter = { turnId: string } | { day: string; tzOffsetMinutes?: number };

export type EffectsReport = {
  /** Come è stato chiesto, per il lettore che stampa l'intestazione. */
  scope: { kind: 'turn'; turnId: string } | { kind: 'day'; day: string };
  /** Tutte le chiamate nello scope, dalla più vecchia alla più recente. */
  calls: readonly EffectRecord[];
  /**
   * Quante sono passate **senza domanda** — `allow` e `draft`.
   *
   * `draft` sta qui e non fra le domande, e non è una svista: un `draft`
   * esegue, senza chiedere niente a nessuno; ciò che lo distingue da `allow` è
   * che prima si è presa una copia del file (`agent/loop/tool-call.ts`, ramo
   * `draft`). È esattamente il caso che D15 esiste per rendere visibile — un
   * effetto avvenuto in silenzio, reversibile per costruzione.
   */
  senzaDomanda: number;
  /** Quante hanno attraversato un `ask` a cui l'owner ha detto sì. */
  conDomanda: number;
  /**
   * Righe scritte prima che questa versione esistesse, e quindi senza
   * metadata. Contate e dichiarate invece di essere presentate come effetti di
   * classe ignota: un database popolato prima di D15 ha una storia che il
   * registro non può raccontare, e dirlo è più utile che tacerlo.
   */
  nonRegistrate: number;
};

const SELECT = `SELECT turn_id AS turnId, call_id AS callId, tool, capability, started_at AS startedAt,
                       ended_at AS endedAt, is_error AS isError, undone_at AS undoneAt,
                       effect_row AS effectRow, reversible, resource, decision
                FROM turn_tool_calls`;

type Raw = {
  turnId: string;
  callId: string;
  tool: string;
  capability: string;
  startedAt: string;
  endedAt: string | null;
  isError: number | null;
  undoneAt: string | null;
  effectRow: string | null;
  reversible: string | null;
  resource: string | null;
  decision: string | null;
};

/**
 * L'intervallo UTC di una giornata **locale**.
 *
 * `started_at` è ISO in UTC; «oggi» per l'owner è la sua mezzanotte, non
 * quella di Greenwich. Senza questa conversione una domanda fatta la sera in
 * Italia perderebbe le prime due ore del giorno e ne includerebbe due del
 * precedente — il genere di errore che si scopre solo quando qualcuno cerca
 * una scrittura che «di sicuro» ha fatto.
 *
 * `tzOffsetMinutes` è l'offset del chiamante (`Date#getTimezoneOffset`, cioè
 * minuti da sottrarre per arrivare a UTC), passato invece che letto: il
 * gateway gira sotto launchd/systemd, dove `TZ` non è per forza quello
 * dell'owner, e una funzione che legge l'ambiente darebbe una risposta diversa
 * a seconda di chi la chiama.
 */
function dayBounds(day: string, tzOffsetMinutes: number): { from: string; to: string } {
  const startUtcMs = Date.parse(`${day}T00:00:00.000Z`) + tzOffsetMinutes * 60_000;
  if (Number.isNaN(startUtcMs)) throw new Error(`data non valida (attesa YYYY-MM-DD): ${day}`);
  return {
    from: new Date(startUtcMs).toISOString(),
    to: new Date(startUtcMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * `YYYY-MM-DD` **nel fuso di chi chiama**, mai `toISOString().slice(0, 10)`,
 * che è già UTC e quindi sbaglia giorno per mezza giornata a est di Londra.
 *
 * Esportata da qui e non riscritta a ogni porta: `sys_effects` e
 * `muffin effects` devono intendere la stessa cosa per «oggi», e due copie di
 * tre righe sono due definizioni di oggi.
 */
export function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `'yes' | 'no' | 'undoable'`, o `null` se la riga non lo dice. Mai un valore inventato. */
function reversibilityOf(raw: string | null): Reversibility | null {
  return raw === 'yes' || raw === 'no' || raw === 'undoable' ? raw : null;
}

function decisionOf(raw: string | null): EffectDecision | null {
  return raw === 'allow' || raw === 'draft' || raw === 'ask' ? raw : null;
}

/**
 * La query canonica. Sola lettura, nessuno stato, nessun conteggio tenuto
 * altrove: i numeri del report si derivano dalle righe che tornano, così non
 * possono contraddirle.
 */
export function readEffects(db: Database.Database, filter: EffectsFilter): EffectsReport {
  const rows: Raw[] =
    'turnId' in filter
      ? (db
          .prepare(`${SELECT} WHERE turn_id = ? ORDER BY started_at, call_id`)
          .all(filter.turnId) as Raw[])
      : (() => {
          const { from, to } = dayBounds(filter.day, filter.tzOffsetMinutes ?? 0);
          return db
            .prepare(
              `${SELECT} WHERE started_at >= ? AND started_at < ? ORDER BY started_at, call_id`,
            )
            .all(from, to) as Raw[];
        })();

  const calls: EffectRecord[] = rows.map((r) => ({
    turnId: r.turnId,
    callId: r.callId,
    tool: r.tool,
    capability: r.capability,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    isError: r.isError === null ? null : r.isError === 1,
    undoneAt: r.undoneAt,
    // `effect_row` non è validato contro l'union: la riga è quella che il
    // codice dichiarava **allora**, e riscrivere la storia perché oggi una
    // riga si chiama diversamente sarebbe la bugia opposta a quella che
    // `undone_at` evita. Il cast dice «questo è ciò che c'era scritto».
    row: (r.effectRow as EffectRow | null) ?? null,
    reversible: reversibilityOf(r.reversible),
    resource: r.resource,
    decision: decisionOf(r.decision),
  }));

  return {
    scope:
      'turnId' in filter
        ? { kind: 'turn', turnId: filter.turnId }
        : { kind: 'day', day: filter.day },
    calls,
    senzaDomanda: calls.filter((c) => c.decision === 'allow' || c.decision === 'draft').length,
    conDomanda: calls.filter((c) => c.decision === 'ask').length,
    nonRegistrate: calls.filter((c) => c.decision === null).length,
  };
}

/**
 * Il report umano — la stessa forma di `formatOrientamentoReport`: una riga
 * per chiamata, i totali in fondo, e le parole al posto dei `null`.
 *
 * È **una** resa e non tre: il tool che il modello chiama, la CLI dell'owner e
 * qualunque altra porta stampano questo. Una superficie che si scrivesse la
 * propria descrizione della stessa riga sarebbe la seconda risposta che
 * `readEffects` esiste per non avere.
 */
export function formatEffects(r: EffectsReport): string {
  const intestazione =
    r.scope.kind === 'turn' ? `turno ${r.scope.turnId}` : `giornata ${r.scope.day}`;
  if (r.calls.length === 0) return `${intestazione}: nessuna chiamata registrata.`;

  const righe = r.calls.map((c) => {
    const esito = c.endedAt === null ? 'non conclusa' : c.isError === true ? 'errore' : 'ok';
    const dove = c.resource === null ? '' : ` su ${c.resource}`;
    const riga = c.row ?? 'riga non registrata';
    const rev =
      c.reversible === null ? 'reversibilità non registrata' : `reversibile: ${c.reversible}`;
    const come =
      c.decision === null
        ? 'decisione non registrata'
        : c.decision === 'ask'
          ? 'dopo averlo chiesto'
          : c.decision === 'draft'
            ? 'senza chiedere, con copia revocabile'
            : 'senza chiedere';
    const undo = c.undoneAt === null ? '' : ` · annullata il ${c.undoneAt}`;
    return `  ${c.startedAt} ${c.tool} (${c.capability})${dove} — riga ${riga}, ${rev}, ${come} · ${esito}${undo}`;
  });

  const coda = [
    '',
    `${r.calls.length} chiamate · ${r.senzaDomanda} senza domanda · ${r.conDomanda} dopo una domanda`,
  ];
  if (r.nonRegistrate > 0) {
    coda.push(
      `${r.nonRegistrate} scritte prima che il registro degli effetti esistesse: di quelle non si sa come sono passate.`,
    );
  }
  return [`${intestazione}:`, ...righe, ...coda].join('\n');
}
