import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  type Question,
  type Questions,
  type SystemOneResult,
  TypeSafeClient,
} from '@typesafe-ai/sdk';
import {
  type EnvelopeState,
  type JudgmentAnswer,
  JudgmentError,
  type JudgmentQuestion,
  type SystemOnePort,
  type SystemOneVerdict,
} from './port.js';

/**
 * L'adattatore TypeSafe: **l'unico posto del runtime che importi l'SDK**
 * (la stessa regola che #607 chiede al piano sviluppo — un confine, non una
 * diffusione). Il porto in `port.ts` è di Muffin; questo file traduce.
 *
 * Le scelte incapsulate, con la loro ragione:
 *
 * - **timeout e retry espliciti** al costruttore: l'SDK ha i suoi default
 *   (10 s per tentativo, 2 retry) e i suoi edge noti su request-shape e
 *   cancellazione (#607 li nomina); qui si dichiarano una volta, dal
 *   config, e nessun chiamante può scoprirli per caso.
 * - **`fetch` iniettabile**: i test e l'accettazione passano la propria
 *   funzione e non toccano la rete — il fake del giudice è un server di
 *   loopback come quello del provider dei modelli.
 * - **niente ambiente**: la chiave arriva dal segreto (`secret://`),
 *   mai da `TYPESAFE_API_KEY` — in produzione la verità è la config
 *   dell'installazione, non la shell di chi ha avviato il processo.
 * - **il verdetto porta il modello vero** (`result.model`, es. la versione
 *   pinnata) oltre a quello richiesto: la calibrazione mescola modelli
 *   diversi solo se qualcuno lo decide, e la riga lo mostra.
 */

export type TypeSafePortOptions = {
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  fetch?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
};

/** Il default richiesto quando il config non dice: l'alias ufficiale, non una versione. */
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';

const domandaSdk = (q: JudgmentQuestion): Question => {
  if (q.kind === 'noul') {
    const criteria =
      q.yes === undefined && q.no === undefined
        ? undefined
        : {
            ...(q.yes === undefined ? {} : { true: q.yes }),
            ...(q.no === undefined ? {} : { false: q.no }),
          };
    return {
      type: 'noul',
      instructions: q.question,
      ...(criteria === undefined ? {} : { criteria }),
    };
  }
  return { type: 'choice', instructions: q.question, criteria: { ...q.options } };
};

const rispostaDi = (answer: {
  type: string;
  noul?: number;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}): JudgmentAnswer => {
  if (answer.type === 'noul' && typeof answer.noul === 'number') {
    return { kind: 'noul', probability: answer.noul };
  }
  if (
    answer.type === 'choice' &&
    typeof answer.choice === 'string' &&
    typeof answer.confidence === 'number' &&
    answer.probabilities !== undefined
  ) {
    return {
      kind: 'choice',
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    };
  }
  throw new JudgmentError({
    kind: 'api',
    detail: `risposta non tipizzata: ${JSON.stringify(answer)}`,
  });
};

export class TypeSafePort implements SystemOnePort {
  readonly provider = 'typesafe';
  readonly model: string;
  private readonly client: TypeSafeClient;

  constructor(opts: TypeSafePortOptions) {
    this.model = opts.model ?? TYPESAFE_DEFAULT_MODEL;
    this.client = new TypeSafeClient({
      apiKey: opts.apiKey,
      ...(opts.baseUrl === undefined ? {} : { baseURL: opts.baseUrl }),
      defaultModel: this.model,
      ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
      ...(opts.maxRetries === undefined ? {} : { retry: { maxRetries: opts.maxRetries } }),
      ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
      // Mai log a body: l'SDK scrive i corpi a debug, e il corpo porta l'envelope.
      logLevel: 'warn',
    });
  }

  async judge(input: {
    state: EnvelopeState;
    questions: readonly JudgmentQuestion[];
    signal?: AbortSignal;
  }): Promise<SystemOneVerdict> {
    const questions: Questions = {};
    for (const q of input.questions) (questions as Record<string, unknown>)[q.id] = domandaSdk(q);
    const started = Date.now();
    let result: SystemOneResult<Questions>;
    try {
      result = await this.client.systemOne(
        { state: input.state, questions, model: this.model },
        ...(input.signal === undefined ? [{}] : [{ signal: input.signal }]),
      );
    } catch (error) {
      throw fallimento(error);
    }
    const answers: Record<string, JudgmentAnswer> = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      answers[id] = rispostaDi(
        answer as {
          type: string;
          noul?: number;
          choice?: string;
          confidence?: number;
          probabilities?: Record<string, number>;
        },
      );
    }
    return {
      provider: this.provider,
      model: result.model,
      answers,
      usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
      latencyMs: Date.now() - started,
    };
  }
}

function fallimento(error: unknown): JudgmentError {
  if (error instanceof APIUserAbortError) {
    return new JudgmentError({ kind: 'abort', detail: 'richiesta annullata' });
  }
  if (error instanceof APITimeoutError) {
    return new JudgmentError({ kind: 'timeout', detail: `timeout dopo ${String(error.message)}` });
  }
  if (error instanceof APIConnectionError) {
    return new JudgmentError({ kind: 'connection', detail: String(error.message) });
  }
  if (error instanceof APIError) {
    return new JudgmentError({
      kind: 'api',
      detail: `HTTP ${String(error.status)}: ${String(error.message)}`,
    });
  }
  return new JudgmentError({
    kind: 'unknown',
    detail: error instanceof Error ? error.message : String(error),
  });
}
