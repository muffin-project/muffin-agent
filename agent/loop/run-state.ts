import type { TurnCounters, TurnRecord } from '../../core/turns/store.js';
import type { WaitSpec } from '../../core/turns/wait.js';
import type { Message } from '../providers/types.js';
import { rehydrateSensitiveEchoes } from './echo-rehydrate.js';
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
  /** Giri di modello già fatti. Il `cap` del profilo li limita, non li possiede. */
  iterations: number;
  /**
   * How far down the profile's declared cascade this turn has walked. An index,
   * not a budget: attempt N runs strategy N.
   */
  recoveriesUsed: number;
  /** The transport retry budget owned by the loop, not by an SDK. */
  transportRetriesLeft: number;
  /**
   * Accepted `max_tokens` partials in this lease (#615): the spent side of
   * `MAX_TRUNCATION_CONTINUATIONS`. Durable (in `counters()`), unlike
   * `providerEmptyStreak` — what must survive a crash is the attempt budget,
   * and a reset here would let a crash loop continue for ever.
   */
  truncationsUsed: number;
  toolCallsMade: number;
  nudgedForCompletion: boolean;
  spentUsd: number;
  contextBuilt: boolean;
  activeModelMs: number;

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

  /**
   * One-shot wire escalation, armed by the `requireTool` recovery rung and
   * consumed by the next model call (`tool_choice: required`, then back to
   * `auto`).
   *
   * Deliberately **not** in `counters()`: a resume that loses it degrades to
   * one more `auto` attempt, which is safe; persisting it would let a
   * crash-loop force calls on transcripts that never saw the message
   * explaining why a call is due.
   */
  requireToolOnce = false;

  /**
   * Consecutive provider-empty responses in this lease (P0-A).
   *
   * Deliberately **not** in `counters()`: it bounds one stall cluster, and a
   * crash resetting it is safe because the persisted `transportRetriesLeft`
   * still bounds the total. What must survive a crash is the money/attempt
   * budget, not the shape of the last three failures.
   */
  providerEmptyStreak = 0;

  /**
   * Provider request ids behind the current stall cluster (P0-B).
   *
   * Run-only, like the streak: evidence for the release reason and the
   * owner diagnostic (resolvable on the provider dashboard), not budget.
   * Capped in practice by the streak bound; a crash loses them, which only
   * costs dashboard links, never correctness.
   */
  readonly providerFailureRequestIds: string[] = [];

  /**
   * Upstream providers that returned an empty response in this lease.
   *
   * Fed to the next attempt as `ChatCall.providerIgnore` so a re-drive does not
   * land on the machine that just answered nothing (OpenRouter routes the same
   * model to a dozen upstreams; one flaky one pinned the whole turn into
   * `continuable` on 2026-09-25). Run-only like the streak: losing it on a
   * crash only costs the diversity hint for the next attempt.
   */
  readonly providerEmptyUpstreams = new Set<string>();

  readonly #resumes: number;

  /**
   * Whether this drive is an owner-granted continuation to a new execution
   * lease (P0-B) rather than a crash/wait resume of the current one.
   *
   * A continuation needs the same transcript repair as a resume (`reconcile`)
   * but must NOT spend the crash-recovery budget (`MAX_RESUMES` guards a
   * process that keeps dying, not an owner who keeps asking). The flag
   * travels beside `resumed`/`wokenFromWait` for exactly that one distinction.
   */
  readonly continued: boolean;

  constructor(
    record: TurnRecord,
    ripresa: { resumed: boolean; wokenFromWait: boolean; continued?: boolean },
  ) {
    this.iterations = record.counters.iterations;
    this.recoveriesUsed = record.counters.recoveriesUsed;
    this.transportRetriesLeft = record.counters.transportRetriesLeft;
    this.truncationsUsed = Number.isFinite(record.counters.truncationsUsed)
      ? (record.counters.truncationsUsed as number)
      : 0;
    this.toolCallsMade = record.counters.toolCallsMade;
    this.nudgedForCompletion = record.counters.nudgedForCompletion;
    this.spentUsd = record.counters.spentUsd;
    this.contextBuilt = record.counters.contextBuilt;
    this.activeModelMs = Math.max(0, record.counters.activeModelMs ?? 0);
    this.usage = { ...record.counters.usage };
    this.messages = [...record.messages];
    // Deterministic replay of the live echo collector over durable pairs —
    // without this, any resume (crash or continuation) silently drops the
    // scrub protection for secrets this turn already read. No second copy is
    // persisted; the transcript is the source.
    this.sensitiveResourceEchoes.push(...rehydrateSensitiveEchoes(this.messages));
    this.continued = ripresa.continued === true;
    this.#resumes =
      record.counters.resumes + (this.continued || !spendeIlBudget(ripresa.resumed, ripresa.wokenFromWait) ? 0 : 1);
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
      truncationsUsed: this.truncationsUsed,
      toolCallsMade: this.toolCallsMade,
      nudgedForCompletion: this.nudgedForCompletion,
      usage: { ...this.usage },
      spentUsd: this.spentUsd,
      resumes: this.resumes,
      contextBuilt: this.contextBuilt,
      activeModelMs: this.activeModelMs,
    };
  }
}
