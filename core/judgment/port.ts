/**
 * Il porto di System One, di proprietà di Muffin (issue #740, fase shadow;
 * ADR-0096).
 *
 * **Non è l'SDK e non è Jev.** Questi tipi sono il vocabolario con cui il
 * runtime chiede giudizi semantici limitati; `typesafe.ts` è *un* adattatore
 * fra questo porto e l'SDK ufficiale, e altri provider possono arrivare come
 * adattatori nuovi. La dottrina è quella di #607/ADR-0095:
 *
 * - il giudizio **non può** consumare un ask, né allargare una busta, né
 *   toccare il kernel: finché la fase è shadow, chi consuma è solo l'owner;
 * - le probabilità sono **segnali di calibrazione**, mai verità: un verdetto
 *   sbagliato deve poter costare al massimo una riga sbagliata in
 *   `ask_judgments`, non un'azione eseguita;
 * - un fallimento del provider è un dato (latenza, errore), non un evento
 *   che modifica il percorso del turno.
 *
 * La forma delle domande ricalca le primitive TypeSafe (noul = probabilità
 * di sì; choice = una di N opzioni con distribuzione) perché sono la
 * semantica più povera che copre il bisogno — ma il porto non espone tipi
 * dell'SDK: domande e risposte qui sono di Muffin.
 */

/** Un valore JSON di stato: oggetto, array, stringa, numero, booleano o null. */
export type JudgmentState =
  | string
  | number
  | boolean
  | null
  | JudgmentState[]
  | { [key: string]: JudgmentState };

/** Lo stato come lo accetta il filo: mai uno scalare in cima. */
export type EnvelopeState = { [key: string]: JudgmentState };

/** Una domanda sì/no: la risposta è la probabilità che il sì sia vero. */
export type NoulQuestion = {
  /** L'id: per il codice e per le righe — il modello non lo vede mai. */
  id: string;
  kind: 'noul';
  /** Il testo della domanda, in inglese: parte verso un modello esterno. */
  question: string;
  /** Descrive cosa conta come sì e come no quando il confine è sottile. */
  yes?: string;
  no?: string;
};

/** Una domanda a opzioni chiuse: la risposta è un'opzione e la distribuzione. */
export type ChoiceQuestion = {
  id: string;
  kind: 'choice';
  question: string;
  /** Nome opzione → descrizione. L'elenco dev'essere esaustivo o prevedere `other`. */
  options: Record<string, string>;
};

export type JudgmentQuestion = NoulQuestion | ChoiceQuestion;

/** La risposta a un noul: la probabilità del sì, 0–1. */
export type NoulAnswer = { kind: 'noul'; probability: number };

/** La risposta a una choice: l'opzione scelta, la sua confidenza, la distribuzione. */
export type ChoiceAnswer = {
  kind: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type JudgmentAnswer = NoulAnswer | ChoiceAnswer;

/**
 * Un verdetto di System One: risposte per id, il modello che ha **davvero**
 * risposto (la riga registra la versione reale, non quella richiesta), l'uso
 * se il provider lo espone, la latenza misurata a mano — il costo e la
 * velocità sono dati di calibrazione, non dettagli.
 */
export type SystemOneVerdict = {
  provider: string;
  model: string;
  answers: Record<string, JudgmentAnswer>;
  usage: { inputTokens: number; outputTokens: number } | null;
  latencyMs: number;
};

/** Perché un giudizio non è arrivato. La riga lo registra, il turno non lo sente. */
export type JudgmentFailure = {
  kind: 'timeout' | 'connection' | 'api' | 'abort' | 'unknown';
  detail: string;
};

export class JudgmentError extends Error {
  constructor(readonly failure: JudgmentFailure) {
    super(`System One non ha giudicato (${failure.kind}): ${failure.detail}`);
    this.name = 'JudgmentError';
  }
}

/**
 * L'unico confine verso un provider. Chi lo implementa possiede timeout,
 * retry e traduzione delle domande — chi lo usa non sa nemmeno che esista
 * una rete. `model` è il modello **richiesto** (per la diagnostica); la
 * verità su chi ha risposto sta nel verdetto.
 */
export type SystemOnePort = {
  readonly provider: string;
  readonly model: string;
  judge(input: {
    state: EnvelopeState;
    questions: readonly JudgmentQuestion[];
    signal?: AbortSignal;
  }): Promise<SystemOneVerdict>;
};
