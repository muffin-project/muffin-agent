import type Database from 'better-sqlite3';
import type { EffectRow, Reversibility, TrustTier } from '../policy/types.js';

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
 * Le due domande di D15, e nient'altro. `day` è una data `YYYY-MM-DD` nel fuso
 * `timeZone`, confrontata su `started_at`, che è UTC.
 *
 * **`timeZone` è un nome IANA, non un offset in minuti, e il cambio è una
 * riparazione.** La prima versione prendeva `tzOffsetMinutes` e dichiarava di
 * evitare così il fuso del processo — ma entrambe le porte lo riempivano con
 * `new Date().getTimezoneOffset()`, cioè con il fuso del processo, spostando
 * la lettura di un frame invece di toglierla. Il fuso autorevole dell'owner
 * esiste già ed è sigillato nel root of trust
 * (`budgets.quietHours.timezone`): lo leggono `cli/jobs.ts`,
 * `core/scheduler/commitments.ts` e `LoopDeps.timeZone`, tutti con la stessa
 * frase — «mai quello dell'host». Un nome IANA porta anche il cambio d'ora,
 * che un offset unico applicato a una finestra di 24 ore sbaglia due volte
 * l'anno.
 *
 * Assente = `UTC`: la stessa caduta che `cli/jobs.ts` sceglie quando il root
 * of trust non si legge — esplicita, non il fuso di chi esegue.
 */
export type EffectsFilter = { turnId: string } | { day: string; timeZone?: string };

export type EffectsReport = {
  /** Come è stato chiesto, per il lettore che stampa l'intestazione. */
  scope: { kind: 'turn'; turnId: string } | { kind: 'day'; day: string };
  /**
   * Le chiamate nello scope, dalla più vecchia alla più recente.
   *
   * Può essere **più corta di `totale`**: una porta che rende al modello ne
   * taglia le più vecchie. I conteggi qui sotto restano quelli interi, e
   * `formatEffects` dichiara il taglio invece di lasciar credere che la lista
   * sia tutto.
   */
  calls: readonly EffectRecord[];
  /** Quante ce n'erano davvero nello scope, taglio o non taglio. */
  totale: number;
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
  /**
   * La provenienza dei byte che questo report porta — il massimo fra il `tier`
   * di ogni chiamata resa e il taint del turno che l'ha fatta.
   *
   * **Non è cautela generica: senza, questa lettura lava il taint.** Il campo
   * `resource` è preso verbatim dagli argomenti del modello
   * (`agent/loop/permissions.ts#resourceFor` legge `args[name]`), quindi per
   * `sys.search` è prosa che il modello ha scelto — in un turno a taint 3,
   * prosa scelta sotto l'influenza di una pagina. Un tool che rendesse quelle
   * stringhe dichiarando `tier: 0` permetterebbe a un turno avvelenato di
   * scrivere nel registro e a un turno pulito del giorno dopo di rileggerle
   * come byte fidati: il fetch-then-act che il kernel esiste per chiudere,
   * riaperto da una porta nuova.
   *
   * `agent/tools/memory.ts` risolve la stessa domanda allo stesso modo — rende
   * il massimo di ciò che rende — e il numero viene dalle **stesse righe**
   * (`turn_tool_calls.tier`, `turns.taint`), non da una seconda contabilità.
   * `0` su un report vuoto: non c'è niente da cui ereditare.
   */
  maxTier: TrustTier;
};

/**
 * `LEFT JOIN turns`, e il `LEFT` è la parte che conta: una riga di chiamata il
 * cui turno è stato cancellato resta leggibile, con `turnTaint` a `NULL`. Un
 * `JOIN` semplice la farebbe sparire dal registro — cioè nasconderebbe un
 * effetto avvenuto, che è il contrario di ciò che questa tabella serve a fare.
 */
const SELECT = `SELECT c.turn_id AS turnId, c.call_id AS callId, c.tool, c.capability,
                       c.started_at AS startedAt, c.ended_at AS endedAt, c.is_error AS isError,
                       c.undone_at AS undoneAt, c.effect_row AS effectRow, c.reversible,
                       c.resource, c.decision, c.tier AS callTier, t.taint AS turnTaint
                FROM turn_tool_calls c LEFT JOIN turns t ON t.id = c.turn_id`;

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
  callTier: number | null;
  turnTaint: number | null;
};

/**
 * L'offset di un fuso IANA **a un istante preciso**, in minuti a est di UTC.
 *
 * Un istante e non «il fuso», perché un fuso non ha un offset solo: Roma è
 * +60 a gennaio e +120 a luglio. `Intl.DateTimeFormat` è l'unica cosa in
 * piattaforma che conosca il database dei fusi; formattare l'istante nel fuso
 * e rileggerlo come se fosse UTC dà, per differenza, l'offset che valeva
 * allora.
 */
function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour: '2-digit'` con `hour12: false` rende 24 per la mezzanotte in alcuni
  // ICU: `Date.UTC` lo assorbe come il giorno dopo alle 0, che e' lo stesso
  // istante, quindi la differenza resta giusta.
  const asIfUtc = Date.UTC(
    n('year'),
    n('month') - 1,
    n('day'),
    n('hour'),
    n('minute'),
    n('second'),
  );
  return (asIfUtc - utcMs) / 60_000;
}

/** La mezzanotte di `day` in `timeZone`, come istante UTC. */
function zonedMidnightMs(day: string, timeZone: string): number {
  const nominale = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(nominale)) throw new Error(`data non valida (attesa YYYY-MM-DD): ${day}`);
  // Due passate, e la seconda serve davvero: il primo offset e' quello che
  // vale a mezzanotte UTC, che nella notte del cambio d'ora non e' quello che
  // vale a mezzanotte locale. Ricalcolarlo sull'istante appena stimato
  // converge — la stessa forma che usa qualunque libreria di fusi.
  const primo = offsetMinutesAt(nominale, timeZone);
  const stima = nominale - primo * 60_000;
  const secondo = offsetMinutesAt(stima, timeZone);
  return secondo === primo ? stima : nominale - secondo * 60_000;
}

/**
 * L'intervallo UTC di una giornata **nel fuso dell'owner**.
 *
 * `started_at` è ISO in UTC; «oggi» per l'owner è la sua mezzanotte, non
 * quella di Greenwich. Senza questa conversione una domanda fatta la sera in
 * Italia perderebbe le prime due ore del giorno e ne includerebbe due del
 * precedente — il genere di errore che si scopre solo quando qualcuno cerca
 * una scrittura che «di sicuro» ha fatto.
 *
 * Il fondo è la mezzanotte del **giorno dopo**, non «l'inizio più 24 ore»: nei
 * due giorni del cambio d'ora una giornata locale dura 23 o 25 ore, e sommare
 * 24 ore fisse sposta fino a un'ora di chiamate nel giorno sbagliato.
 */
function dayBounds(day: string, timeZone: string): { from: string; to: string } {
  const from = zonedMidnightMs(day, timeZone);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dopo = new Date(Date.UTC(y, m - 1, d + 1));
  const giornoDopo = dopo.toISOString().slice(0, 10);
  return {
    from: new Date(from).toISOString(),
    to: new Date(zonedMidnightMs(giornoDopo, timeZone)).toISOString(),
  };
}

/**
 * `YYYY-MM-DD` **nel fuso dell'owner**, mai `toISOString().slice(0, 10)`, che è
 * già UTC e quindi sbaglia giorno per mezza giornata a est di Londra, e mai
 * `getFullYear()`, che è il fuso del processo — cioè quello del supervisore.
 *
 * Esportata da qui e non riscritta a ogni porta: `sys_effects` e
 * `muffin effects` devono intendere la stessa cosa per «oggi», e due copie di
 * tre righe sono due definizioni di oggi.
 */
export function localDay(d: Date, timeZone = 'UTC'): string {
  // `en-CA` rende esattamente `YYYY-MM-DD`, che e' il formato che il resto di
  // questo file confronta: costruirlo a mano dai `parts` sarebbe la stessa
  // cosa con tre righe in piu' e un padStart da sbagliare.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
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
          const { from, to } = dayBounds(filter.day, filter.timeZone ?? 'UTC');
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
    totale: calls.length,
    senzaDomanda: calls.filter((c) => c.decision === 'allow' || c.decision === 'draft').length,
    conDomanda: calls.filter((c) => c.decision === 'ask').length,
    nonRegistrate: calls.filter((c) => c.decision === null).length,
    // Il massimo fra le due colonne, riga per riga: il `tier` del risultato di
    // quella chiamata e il taint del turno che l'ha fatta. Servono tutte e due
    // — una `fs_read` a `tier: 0` dentro un turno salito a 3 dopo una ricerca
    // porta comunque un percorso che il modello ha scelto avendo la pagina
    // davanti, e il taint del turno e' l'unica colonna che lo dice.
    maxTier: rows.reduce<TrustTier>(
      (max, r) => Math.max(max, tierOf(r.callTier), tierOf(r.turnTaint)) as TrustTier,
      0,
    ),
  };
}

/** Un intero fuori scala o assente vale `0` — mai un `NaN` che si propaga come tier. */
function tierOf(raw: number | null): TrustTier {
  return raw === 1 || raw === 2 || raw === 3 ? raw : 0;
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
    const riga = c.row ?? 'non registrata';
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

  // `r.totale` e non `r.calls.length`: chi rende solo le ultime N righe
  // (`agent/tools/effects.ts`) affetta `calls` e lascia i totali interi, e una
  // coda che contasse la lista affettata direbbe «60 chiamate · 95 senza
  // domanda» — due numeri che non possono stare nella stessa frase.
  const coda = [
    '',
    `${r.totale} chiamate · ${r.senzaDomanda} senza domanda · ${r.conDomanda} dopo una domanda`,
  ];
  if (r.calls.length < r.totale) {
    coda.push(`(mostrate le ultime ${r.calls.length}; i totali sopra contano tutte.)`);
  }
  if (r.nonRegistrate > 0) {
    coda.push(
      `${r.nonRegistrate} scritte prima che il registro degli effetti esistesse: di quelle non si sa come sono passate.`,
    );
  }
  return [`${intestazione}:`, ...righe, ...coda].join('\n');
}
