import type { TurnCounters, TurnRecord } from '../../core/turns/store.js';
import type { WaitSpec } from '../../core/turns/wait.js';
import type { Message } from '../providers/types.js';
import { spendeIlBudget } from './permissions.js';

/**
 * Ciò che cambia dentro un turno, in un posto solo.
 *
 * `guidaIlTurno` teneva questo stato in una dozzina di locali (`let iterations`,
 * `let contextBuilt`, `const messages`, …) e ogni funzione annidata lo leggeva
 * per chiusura. Finché tutto stava in una funzione da 1400 righe la chiusura era
 * il collante; appena `checkpoint`/`suspendHere`/`reconcile` (fetta 7) e il
 * corpo di giro (fetta 8) escono dal file, quel collante diventa una firma a
 * dieci parametri, e una firma a dieci parametri è il posto dove si scambia
 * `toolCallsMade` con `iterations` senza che niente diventi rosso.
 *
 * Perciò: un oggetto, passato per riferimento, che *è* lo stato del turno. Non
 * contiene il contesto immutabile (deps, record, input) né lo snapshot dei
 * permessi — quelli hanno già una identità propria e un solo parametro a testa.
 *
 * Le tre proprietà che questo file esiste per garantire, e che il suo test
 * gemello misura:
 *
 *  1. **`resumes` non è scrivibile.** È calcolato una volta dal record e letto
 *     da un getter senza setter, quindi un `run.resumes += 1` scritto per
 *     distrazione non compila e lancia `TypeError` a runtime (i moduli ES sono
 *     in strict mode). Il conto va nel record una volta sola: un turno che lo
 *     incrementasse anche qui conterebbe due volte contro `MAX_RESUMES` e
 *     rifiuterebbe di riprendere a metà del budget dichiarato.
 *  2. **`counters()` non consegna mai l'oggetto vivo**, nemmeno annidato:
 *     `usage` è copiato insieme al resto. Chi riceve i contatori li serializza
 *     su una riga durevole, e una riga durevole non deve poter cambiare sotto
 *     chi l'ha già scritta — né lo stato del turno deve poter cambiare perché
 *     un consumatore ha toccato ciò che gli era stato passato.
 *  3. **`contextBuilt` viene dai contatori del record, non dal suo `status`.**
 *     Sono due fatti diversi che coincidono solo sulle righe fortunate: una
 *     riga `runnable` ripresa dopo un crash *dentro* il preambolo ha
 *     `contextBuilt: false` ed è esattamente il caso che il flag esiste per
 *     coprire (vedi `TurnCounters.contextBuilt`). Derivarlo dallo status
 *     rieseguirebbe il preambolo — episodio dell'owner duplicato, transcript
 *     ricostruito dal file di sessione — oppure lo salterebbe su una riga che
 *     non l'ha mai eseguito.
 *
 * L'ordine dei campi in `counters()` è quello che il blob JSON aveva prima di
 * questa estrazione, e resta tale: la riga durevole è byte-identica.
 */
export class TurnRun {
  /**
   * Giri di modello già fatti. È telemetria/stato di resume, non il normale
   * criterio di fine: il round cap arbitrario è stato rimosso. Eventuali fuse
   * catastrofici futuri restano una policy separata (ADR-0076 / EXECUTION.md).
   */
  iterations: number;
  /**
   * How far down the profile's declared cascade this turn has walked. An index,
   * not a budget: attempt N runs strategy N.
   */
  recoveriesUsed: number;
  /** The other budget. See MAX_TRANSPORT_RETRIES for why it is not the same one. */
  transportRetriesLeft: number;
  toolCallsMade: number;
  nudgedForCompletion: boolean;
  spentUsd: number;
  contextBuilt: boolean;

  /**
   * I token accumulati, mutati sul posto giro dopo giro.
   *
   * `readonly` sul riferimento, non sul contenuto: il turno somma dentro questo
   * oggetto, e `counters()` ne consegna una copia.
   */
  readonly usage: TurnCounters['usage'];

  /**
   * Il transcript vivo del turno, che parte da quello del record.
   *
   * `readonly` sul riferimento e non sull'array: il preambolo lo *ricostruisce*
   * (`length = 0` seguito da `push`) invece di riassegnarlo, proprio perché
   * ogni funzione annidata ne tiene lo stesso riferimento.
   */
  readonly messages: Message[];

  /**
   * The full content of every resource this turn read whose own name says
   * "secret" (`isSensitiveResourceName` — a file path or URL, not what it
   * contains: `segreto.txt`, `credenziali.json`, `.../id_rsa`). Accumulates
   * for the whole turn, across every round of tool calls, the same way
   * `snapshot`'s taint does — an echo in the answering round three calls
   * after the read is still the same shape of leak.
   *
   * The sink, `scrubResourceEchoes` at the one place `text` is finalised,
   * strips any verbatim reproduction of these out of both the reply and the
   * memory episode: see that call site for why it is one choke point and not
   * one call per connector.
   */
  readonly sensitiveResourceEchoes: string[] = [];

  /**
   * The barrier `wait` arms, honoured between iterations and never inside one.
   *
   * `null` until a handler asks. See `ToolContext.suspend` for why it is armed
   * rather than thrown.
   */
  barrier: WaitSpec | null = null;

  readonly #resumes: number;

  constructor(record: TurnRecord, ripresa: { resumed: boolean; wokenFromWait: boolean }) {
    this.iterations = record.counters.iterations;
    this.recoveriesUsed = record.counters.recoveriesUsed;
    this.transportRetriesLeft = record.counters.transportRetriesLeft;
    this.toolCallsMade = record.counters.toolCallsMade;
    this.nudgedForCompletion = record.counters.nudgedForCompletion;
    this.spentUsd = record.counters.spentUsd;
    this.contextBuilt = record.counters.contextBuilt;
    this.usage = { ...record.counters.usage };
    this.messages = [...record.messages];
    this.#resumes = record.counters.resumes + (spendeIlBudget(ripresa.resumed, ripresa.wokenFromWait) ? 1 : 0);
  }

  /**
   * Quante volte questa riga è stata ripresa, incluso il presente giro se
   * questo è un resume che spende budget. Sola lettura: vedi il §1 sopra.
   */
  get resumes(): number {
    return this.#resumes;
  }

  /** Una copia, sempre. Vedi il §2 sopra. */
  counters(): TurnCounters {
    return {
      iterations: this.iterations,
      recoveriesUsed: this.recoveriesUsed,
      transportRetriesLeft: this.transportRetriesLeft,
      toolCallsMade: this.toolCallsMade,
      nudgedForCompletion: this.nudgedForCompletion,
      usage: { ...this.usage },
      spentUsd: this.spentUsd,
      resumes: this.resumes,
      contextBuilt: this.contextBuilt,
    };
  }
}
