/**
 * The single internal shape for talking to a model.
 *
 * One interface, two implementations: `anthropic` native and `openai-compat`
 * (which covers Ollama, llama.cpp, vLLM, OpenRouter, DeepSeek and most of the
 * cloud). No framework — the whole field hand-rolls this, and an abstraction
 * layer would level everything down to the minimum common denominator exactly
 * where the differences matter: prompt caching, thinking budgets, long context.
 *
 * See docs/adr/0008.
 */

type Role = 'user' | 'assistant';

/**
 * `cache: 'stable'` marks the end of a cacheable prefix. Positional, not a
 * flag — and bounded: Anthropic and OpenRouter accept at most FOUR
 * `cache_control` blocks per request, and a fifth is a 400. Both adapters mark
 * every stable block they see, so whoever marks blocks is holding the budget.
 */
/**
 * A reasoning block, carried through untouched.
 *
 * Opaque on purpose — nothing above the adapter reads `signature` or `data`, and
 * nothing may rewrite them. The API rule is not advisory: *"Pass every
 * `thinking` block back to the API complete and unmodified, alongside the
 * `tool_use` block it accompanied"* … *"Required: within a tool-use turn, pass
 * thinking blocks back"* (Anthropic, "Thinking with tool use", read 2026-08-13).
 *
 * The asymmetry is why this is a type and not a comment. A **modified** block is
 * a loud 400. A **dropped** one is silent: the server *"may strip thinking blocks
 * that would create an invalid turn structure, or disable thinking when the
 * conversation history is incompatible with thinking being enabled"* — so the
 * only symptom of losing them is a slightly worse agent and a colder cache.
 *
 * `redacted_thinking` is the same rule with a different payload, and it is the
 * one a type filter loses first: the docs call out `block.type == "thinking"`
 * by name as the filter that "silently drops `redacted_thinking` blocks and
 * breaks the multi-turn protocol". Both live in one union so a `switch` has to
 * answer for both.
 */
export type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

/**
 * I formati che entrambi i provider accettano.
 *
 * Anthropic li elenca per nome — JPEG, PNG, GIF, WebP — e dice che le
 * animazioni non sono supportate: di una GIF si guarda il primo fotogramma
 * (docs Vision, letta il 28/08/2026). Il lato openai-compat li accetta dentro
 * un data URL, quindi l'insieme comune e' questo.
 *
 * Un'unione chiusa e non `string`: il media type finisce **sul filo**, e un
 * valore inventato diventa un 400 dal provider invece di un errore qui.
 */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/**
 * Un'immagine dentro un messaggio.
 *
 * **Solo base64, mai un URL**, ed e' una scelta di sicurezza prima che di
 * formato. Entrambe le API accettano anche una sorgente `url`, ma quella fa
 * scaricare l'immagine **al provider**: sarebbe un'uscita di rete che il
 * kernel non vede e non puo' negare (`core/policy/decide.ts` gira su cio' che
 * fa Muffin, non su cio' che fa qualcun altro per conto suo), e un'immagine
 * privata dovrebbe essere pubblicamente raggiungibile per poter essere letta.
 * I byte di un'immagine arrivata su Telegram stanno gia' sul disco: mandarli
 * e' l'unica forma che non chiede a nessun altro di andarseli a prendere.
 *
 * `data` e' base64 **nudo**, senza il prefisso `data:`: e' cio' che vuole
 * Anthropic, mentre il lato openai-compat lo avvolge. Tenere la forma nuda e
 * avvolgere in un adattatore solo e' meglio del contrario — spacchettare un
 * data URL vuol dire parsarlo, e un parser in piu' e' un modo in piu' di
 * sbagliare.
 */
export type ImageBlock = { type: 'image'; mediaType: ImageMediaType; data: string };

/**
 * Il tipo di un audio dentro un messaggio.
 *
 * Chiuso e corto come `ImageMediaType`, e per la stessa ragione: il formato
 * finisce **sul filo** (`input_audio.format`), e un valore inventato deve
 * diventare un errore qui invece di un 400 dal provider.
 *
 * Sono i quattro che Muffin puo' davvero produrre, non quelli che OpenRouter
 * elenca: una nota vocale di Telegram e' `audio/ogg` (Opus), un file musicale
 * inoltrato e' mp3 o m4a, e `audio/wav` e' cio' in cui ffmpeg converte quando
 * la trascrizione locale deve passare a `whisper-cli`.
 */
export type AudioMediaType = 'audio/ogg' | 'audio/mpeg' | 'audio/mp4' | 'audio/wav';

/**
 * Un audio dentro un messaggio — una nota vocale, quasi sempre.
 *
 * **Solo base64, mai un URL**, identico a `ImageBlock` e per la stessa ragione
 * di sicurezza: una sorgente `url` farebbe scaricare l'audio **al provider**,
 * cioe' un'uscita di rete che il kernel non vede e non puo' negare. Qui non e'
 * nemmeno una scelta nostra e basta — la documentazione OpenRouter (letta il
 * 28/08/2026) dice che per l'audio gli URL non sono proprio supportati.
 *
 * `data` e' base64 **nudo**: stessa forma di `ImageBlock`, avvolta da un
 * adattatore solo.
 *
 * Un blocco di questi esiste unicamente quando il modello a cui stiamo
 * parlando accetta audio in ingresso — la domanda la fa
 * `agent/providers/modalita.ts`, misurandola sul provider invece di indovinarla
 * da una lista scritta a mano. Se non lo accetta, l'audio non diventa mai un
 * blocco: diventa testo, trascritto in casa.
 */
export type AudioBlock = { type: 'audio'; mediaType: AudioMediaType; data: string };

export type ContentBlock =
  | { type: 'text'; text: string; cache?: 'stable' }
  | ImageBlock
  | AudioBlock
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | ThinkingBlock;

export type Message = { role: Role; content: ContentBlock[] };

export type ToolSpec = {
  name: string;
  description: string;
  /**
   * JSON Schema — **what the model is told**, and nothing more.
   *
   * The sentence here used to read "validated before the kernel ever sees the
   * arguments". Both halves were false. Nothing in this repo validates against
   * this object: it is serialized into the request (`openai-compat.ts`,
   * `anthropic.ts`) and never read back. And the kernel *does* see the raw
   * arguments — `resourceFor` in `agent/loop.ts` reads
   * `args[decl.policyArgs[i]]` to build the decision's resource, before any
   * handler runs.
   *
   * What actually holds is two separate things:
   *
   *  - the kernel is defensive about what it reads. `resourceFor` accepts a
   *    value only when `typeof value === 'string'`, and a declared-but-absent
   *    resource becomes `{kind:'none'}` — which for a url capability is a
   *    refusal. Garbage from the model produces a no, never a yes;
   *  - each handler validates its own arguments with its own zod schema
   *    (`httpArgs`, `shellArgs`, `todoArgs`, …). That is the real gate.
   *
   * So this field is advertising and the zod schema is enforcement, they are
   * two copies of one intent, and nothing keeps them in agreement. A tool can
   * declare `required: ['url']` here and validate nothing there —
   * `agent/tools/schema-conformance.test.ts` is what makes that fail.
   *
   * The old sentence was worse than absent: it told the next reader that
   * validation was already handled somewhere, which is exactly how a handler
   * ships without any.
   */
  inputSchema: Record<string, unknown>;
};

/**
 * How much reasoning to ask for — in the only vocabulary the API still has.
 *
 * There is no budget any more. `thinking: {type:'enabled', budget_tokens: N}` is
 * deprecated on the 4.6 models and **returns a 400 on 4.7 and later**, which is
 * every model `agent/profiles/frontier.json` matches (Sonnet 5, Opus 5, Fable 5)
 * — verified on the extended-thinking page, 2026-08-13. What replaced it is a
 * mode plus `output_config.effort`, and `effort` has no per-request meaning for
 * us: `"high"` is the API default, so sending it is identical to omitting it.
 * Hence two values and no number. A knob the API does not have is a knob that
 * lies about what it controls.
 *
 * `'off'` is `{type:'disabled'}` at the wire, not "send nothing": on a 5-series
 * model sending nothing means thinking is **on**, so the old `'off'` was a
 * declaration the request contradicted. Not universal, though: Claude Fable 5
 * and Claude Mythos 5 have no disable switch at all — thinking is always on
 * and both `{type:'enabled'}` and `{type:'disabled'}` are a 400 (per-model
 * table, read 2026-08-13). `Profile.thinking`'s third value, `'unset'`, is for
 * exactly that model shape: the field omitted, never sent as `'off'`.
 *
 * N3 (judge, 2026-08-13): Claude Haiku 4.5 has no honest value in this type at
 * all — it supports only manual extended thinking (the `budget_tokens` shape
 * this vocabulary deliberately has no number for) and returns a 400 on
 * `{type:'adaptive'}`. Do not add it to a profile's `match` list that declares
 * `thinking: 'adaptive'`. Harmless today only because the light lane — the one
 * place Haiku 4.5 runs — never consults a profile at all.
 */
type ThinkingMode = 'adaptive' | 'off';

/**
 * Spazio per il reasoning che chiediamo spento e non riusciamo a spegnere.
 *
 * `agent/profiles/consumer-local.json` dichiara `"thinking": "off"` proprio per
 * `*qwen3*`, e le sue stesse note dicono che l'adapter openai-compat non porta
 * quel comando: è un no-op **dichiarato** (ADR-0008), non nascosto. Quello che
 * non era stato tracciato è il prezzo, due livelli più in là.
 *
 * Misurato sull'installazione dell'owner il 27/08 con `qwen/qwen3.8-27b`:
 * l'estrazione con tetto 1500 tornava `stop=max_tokens` dopo **1502 token in
 * uscita** e `content` vuoto — il modello spendeva l'intero budget a ragionare
 * e non arrivava a scrivere un carattere di JSON. Stesso episodio, stesso
 * modello, tetto 8000: **un fatto estratto**. La risposta grezza del giudice
 * nel registro è `[vuota]` per la stessa ragione, con un tetto di 500.
 *
 * Alzare un tetto non è chiedere più token: `max_tokens` è un limite, non una
 * richiesta, quindi per un modello che non ragiona questo non costa niente. Per
 * uno che ragiona sostituisce «paghi 1502 token per NIENTE, a ogni giro, per
 * sempre» con «paghi e ottieni un fatto, e l'episodio smette di tornare».
 *
 * **Non va più via, e ora si sa per chi resta.** Da 27/08 l'adapter chiede
 * davvero di non ragionare (`reasoning: {effort:'none'}`) e le tre corsie
 * glielo chiedono — misurato sull'installazione viva, 204 token in uscita
 * contro 85 sullo stesso prompt. Ma lo chiede **solo dove l'endpoint capisce
 * il campo**: su Ollama, llama.cpp e vLLM — cioè proprio i server del profilo
 * `consumer-local` — un campo ignoto è un 400, quindi lì `off` è ancora un
 * no-op dichiarato e questo margine è l'unica cosa che tiene viva la corsia.
 *
 * Il prezzo di tenerlo è zero: `max_tokens` è un limite, non una richiesta.
 * Il prezzo di toglierlo sarebbe il 25/08 di nuovo, sulla prima macchina che
 * gira un modello che ragiona dietro un server che non sa spegnerlo.
 */
export const REASONING_HEADROOM = 6_000;

export type ChatCall = {
  model: string;
  system: ContentBlock[];
  messages: Message[];
  tools?: ToolSpec[];
  /** Never 'required' by default: forcing a tool breaks legitimate short answers. */
  toolChoice?: 'auto' | 'none';
  maxOutputTokens: number;
  /**
   * Optional because "do not send it" is a value the caller must be able to say.
   * On Opus 4.7 and later — Opus 5, Sonnet 5, Fable 5 — `temperature`, `top_p`
   * and `top_k` were removed, and any non-default value is a 400 (migration
   * guide, read 2026-08-13). Absent means the model's own default, and it is
   * the only shape those models accept.
   */
  temperature?: number;
  thinking?: ThinkingMode;
  /**
   * Quale conversazione è questa — un'identità opaca, non un'istruzione.
   *
   * Esiste perché una cache di prompt vive **dal lato del provider**, e un
   * gateway che smista fra provider diversi la manca per costruzione. Misurato
   * il 28/08/2026 sulle tracce: dentro un turno la cache prendeva il 54%, fra
   * due turni consecutivi a trenta secondi di distanza lo **0%**, due volte di
   * fila, con 8907 e 8964 token in ingresso. `qwen/qwen3.8-27b` su OpenRouter
   * ha **dodici** provider a monte e undici sanno cachare: dodici cache, tutte
   * fredde a turno.
   *
   * OpenRouter instrada già in modo *sticky* per far prendere la cache, ma la
   * chiave la deriva «dall'hash del primo messaggio di sistema e del primo
   * messaggio non-di-sistema» (loro documentazione, letta il 28/08/2026). Il
   * primo non-di-sistema di Muffin è il recall, che **cambia a ogni turno**:
   * chiave nuova, provider nuovo, cache fredda. È la terza delle quattro cause
   * di miss che quella pagina elenca — «un blocco iniziale che continua a
   * cambiare» — e ci cadiamo per come è costruito `buildContext`.
   *
   * Dichiarato qui in termini di dominio e non come `session_id`: il campo del
   * fornitore lo sceglie l'adapter, che è l'unico posto che sa con chi sta
   * parlando. Un adapter che non ha un concetto di conversazione lo ignora, e
   * non deve fingere di averlo.
   */
  conversation?: string;
  stream: boolean;
  signal?: AbortSignal;
};

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'error';

type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ChatResult = {
  text: string | null;
  /** Arguments already parsed: a tool call that will not parse is an error here, not downstream. */
  toolCalls: { id: string; name: string; args: unknown }[];
  /**
   * The reasoning blocks this response opened with, in the order received.
   *
   * Separate from `text` and `toolCalls` because those are *normalised* — text
   * joined and trimmed, arguments parsed — and these must survive the trip
   * byte-identical. The loop's only job is to put them back at the head of the
   * assistant turn it echoes; it must not read, merge or reformat them.
   *
   * Optional, and an adapter that has nothing to carry says so with `[]` rather
   * than by omission — see the openai-compat adapter, where the gap is real and
   * currently inert.
   */
  thinking?: ThinkingBlock[];
  stopReason: StopReason;
  usage: Usage;
  model: string;
  /**
   * Chi ha risposto davvero, quando fra noi e il modello c'è uno smistatore.
   *
   * `model` dice *quale modello*; questo dice *su quale macchina*, ed è una
   * differenza che si vede solo in bolletta e nella cache. `qwen/qwen3.8-27b`
   * su OpenRouter ha dodici provider a monte, con prezzi diversi, quantizzazioni
   * diverse (fp8, bf16) e **cache separate**. Senza questo campo, «perché la
   * cache non prende» non è una domanda a cui si possa rispondere: si vede lo
   * zero e non si vede che la richiesta è finita altrove.
   *
   * Assente quando non c'è nessuno smistatore — un Ollama locale è la macchina,
   * e dirlo due volte non aggiunge niente.
   */
  upstream?: string;
};

/**
 * One increment of a streamed response, on the wire between an adapter and the
 * loop. Five kinds, matching what the two adapters can actually produce:
 *
 * - `text_delta` / `thinking_delta` — a fragment of prose. The loop buffers
 *   these; see `agent/loop.ts` for why they never reach a surface directly.
 * - `tool_call_delta` — a fragment of one tool call's JSON arguments, keyed by
 *   `index` because both wire formats interleave several calls by position,
 *   not by id (the id itself only arrives on the first fragment for that
 *   index — see each adapter's `chatStream`).
 * - `usage` — partial token counts, when the wire reports them before `done`.
 *   `Partial<Usage>` because neither adapter's mid-stream usage is complete
 *   (Anthropic's `message_delta` has only `output_tokens`; OpenAI's mid-stream
 *   chunks have none at all — see `stream_options.include_usage`).
 * - `done` — always last, always exactly once, and it carries the *same*
 *   `ChatResult` `chat()` would have returned for an identical, non-streamed
 *   call. This is the whole contract: streaming is a side-channel of deltas
 *   riding alongside the ordinary computation, not a second way of arriving
 *   at an answer. A consumer that ignores every event but `done` gets exactly
 *   today's behaviour.
 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'done'; result: ChatResult };

/**
 * The stream itself broke — a reset connection, a chunk that failed its zod
 * schema, a stream that ended without the wire's own terminal event
 * (`message_stop` / `[DONE]`).
 *
 * Deliberately **not** a `ProviderError`: that type's `retryable` answers "is
 * this worth another attempt at the same request", and retrying the same
 * streamed request is exactly the wrong remedy for a broken *transport* — the
 * caller's answer is a single, one-time fallback to `chat()` (non-streaming),
 * per docs/blueprint/M5-BIS.md B11. A distinct class is what lets the loop
 * tell "the SSE framing failed" apart from "the server said 429" without
 * inspecting a string.
 */
export class ProviderStreamError extends Error {
  constructor(
    message: string,
    /**
     * Did anything at all arrive before this broke? Distinguishes "the
     * request itself never became a stream" (treat like any other
     * transport failure — a 401 does not become fixable by trying without
     * `stream: true`) from "we were mid-stream and it died" (the one case
     * this type exists for). Adapters set it from their own first-event
     * bookkeeping; see `chatStream` in each.
     */
    readonly partial: boolean,
    // Native `Error.cause` (ES2022) rather than a parameter property of the
    // same name: `Error` already declares `cause`, and a parameter property
    // shadowing it needs `override` — reusing the built-in chain is simpler
    // than opting into that just to hold one field.
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'ProviderStreamError';
  }
}

export interface Provider {
  readonly kind: 'anthropic' | 'openai-compat';
  chat(call: ChatCall): Promise<ChatResult>;
  /**
   * Optional: a provider that can stream implements this. Absent means "this
   * provider cannot stream" and the loop falls back to `chat()` unconditionally
   * — never a runtime error, because a provider that never implements this is
   * exactly as valid as one that does (ADR-0008: degrade declaredly).
   *
   * The final yielded event is always `{type:'done', result}`, and `result` is
   * byte-for-byte what `chat()` would have returned for the same `call` — see
   * `StreamEvent`. A caller that only wants the boundary the two share (the
   * loop, on a turn with no `onDelta` sink) can therefore keep calling `chat()`
   * and never construct this at all, which is why `chat()` stays the required
   * member and this the optional one.
   */
  chatStream?(call: ChatCall): AsyncIterable<StreamEvent>;
}

/**
 * Which side of the call produced the failure.
 *
 * Two families were travelling under one type and the loop could not tell them
 * apart: a 429 and "the model emitted arguments that will not parse" both
 * arrive as `retryable: true`, so unparseable JSON was answered with
 * exponential backoff. Waiting cannot improve output the model has already
 * produced — that one belongs to the profile's recovery cascade, where
 * `strictJson` is the step written for it.
 *
 * Defaults to `transport`, so every construction site that does not say
 * otherwise keeps the behaviour it had.
 */
export type ProviderErrorSource = 'transport' | 'output';
// Producibility is asymmetric on purpose: only the openai-compat adapter can
// emit 'output' today, because it is the only one that parses tool arguments
// from a string (the Anthropic SDK returns them structured — there is no
// JSON.parse to fail). Do not hunt for the missing Anthropic branch; it has
// nothing to mislabel.

/** Carries what the recovery cascade needs to decide, instead of a bare string. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly source: ProviderErrorSource = 'transport',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
