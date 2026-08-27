/**
 * Embeddings.
 *
 * Local by default. An agent that reads everything you write is the last place
 * to ship every sentence to a third party for indexing, and a 0.6B embedding
 * model runs on anything — this is the one part of the stack where local-first
 * costs almost nothing and buys a real property.
 *
 * The interface exists so that is a configuration choice rather than an
 * architectural one, and so tests never need a model running.
 */

export interface Embedder {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Node's `fetch` has no default timeout, and this call sits on the pre-loop path
 * of every turn: an embedder that hangs — Ollama loading a model, a machine in
 * swap — hangs the turn with no output and no trace. The previous system lost
 * its entire private intake to exactly this, a `fetch` with no timeout on the
 * message path, and the symptom was "it stopped letting me write to it".
 *
 * Generous rather than tight: a cold model load is slow but legitimate, and the
 * failure this guards against is unbounded, not slow.
 */
const EMBED_TIMEOUT_MS = 30_000;

export class EmbedderUnavailable extends Error {
  constructor(
    readonly embedderId: string,
    cause: string,
  ) {
    super(`embedder "${embedderId}" non disponibile: ${cause}`);
    this.name = 'EmbedderUnavailable';
  }
}

/** Ollama, the local default. `ollama pull qwen3-embedding:0.6b` and nothing leaves the machine. */
export class OllamaEmbedder implements Embedder {
  readonly id: string;
  constructor(
    model: string = 'qwen3-embedding:0.6b',
    dimensions: number = 1024,
    baseUrl: string = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434',
  ) {
    this.model = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl;
    this.id = `ollama:${model}`;
  }

  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const text of texts) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: text }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
      } catch (error) {
        throw new EmbedderUnavailable(this.id, error instanceof Error ? error.message : String(error));
      }
      if (!response.ok) throw new EmbedderUnavailable(this.id, `HTTP ${response.status}`);
      const body = (await response.json()) as { embedding?: number[] };
      if (!body.embedding) throw new EmbedderUnavailable(this.id, 'risposta senza embedding');
      // Dimension mismatch is worth failing on: a table built for 1024 floats
      // silently accepting 768 is the kind of wrong that shows up as bad recall
      // months later, never as an error.
      if (body.embedding.length !== this.dimensions) {
        throw new EmbedderUnavailable(
          this.id,
          `dimensione ${body.embedding.length}, attesa ${this.dimensions}`,
        );
      }
      out.push(Float32Array.from(body.embedding));
    }
    return out;
  }
}

/** Cloud fallback through any OpenAI-compatible embeddings endpoint. */
export class OpenAICompatEmbedder implements Embedder {
  readonly id: string;
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    readonly dimensions: number,
    private readonly baseUrl: string,
  ) {
    this.id = `openai-compat:${model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        // `dimensions` nel corpo, non solo nella nostra config: sull'API di
        // OpenAI è il parametro che *accorcia davvero* l'embedding
        // (`text-embedding-3-*`). Senza, chiedere 512 significa ricevere 1536 e
        // scoprirlo all'insert in vec0 — cioè configurare una dimensione non
        // nativa era garantito sbagliato.
        //
        // Mandato **sempre**, e la generalità di questa scelta non è verificata:
        // `dimensions` è posteriore a `text-embedding-ada-002`, e un endpoint
        // che non lo conosce può rifiutare la richiesta invece di ignorare il
        // campo. Se succede è un `HTTP 400` rumoroso — un guasto che si vede al
        // primo giro, non un danno silenzioso — e il controllo qui sotto prende
        // comunque i server che lo ignorano. Resta da decidere se legarlo al
        // modello.
        body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimensions }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
    } catch (error) {
      throw new EmbedderUnavailable(this.id, error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) throw new EmbedderUnavailable(this.id, `HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { embedding: number[] }[] };
    if (!body.data) throw new EmbedderUnavailable(this.id, 'risposta senza data');
    // Lo stesso controllo che fa `OllamaEmbedder`, e per lo stesso motivo:
    // qui la dimensione è **cotta nella tabella vettoriale**, quindi una
    // risposta della lunghezza sbagliata non è un dettaglio da lasciar passare
    // a vec0, che la riporterebbe senza nominare l'embedder.
    for (const d of body.data) {
      if (d.embedding.length !== this.dimensions) {
        throw new EmbedderUnavailable(this.id, `dimensione ${d.embedding.length}, attesa ${this.dimensions}`);
      }
    }
    return body.data.map((d) => Float32Array.from(d.embedding));
  }
}

/** vec0 stores raw little-endian float32; better-sqlite3 wants a Buffer. */
export function toVectorBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Il primario, e dove si va quando non risponde.
 *
 * Nasce da una condizione osservata sulla macchina dell'owner e rimasta per
 * giorni: ollama non gira, `EmbedderUnavailable` a ogni giro, **niente viene
 * indicizzato** e il recall resta solo testuale. Da #149 `doctor` lo dice, il
 * che ha reso il guasto visibile senza renderlo recuperabile: se il locale è
 * giù e c'è una chiave API, non c'è ragione per cui la memoria smetta di
 * indicizzarsi.
 *
 * Tre proprietà, e ognuna è un guasto che questo oggetto rifiuta di avere.
 *
 * **1. Stessa dimensione, imposta alla costruzione.** La dimensione è cotta nel
 * DDL della tabella vec0 (`core/memory/vectors.ts`): due embedder di dimensione
 * diversa farebbero ricostruire l'indice **a ogni scambio**. Rifiutare qui, con
 * i due numeri nel messaggio, è l'unica versione di questo che non produce una
 * macchina che si rifà l'indice per sempre.
 *
 * **2. `id` è quello di chi ha davvero prodotto il vettore, non un id composto.**
 * Questa è la proprietà che conta, ed è controintuitiva: sarebbe comodo che
 * l'insieme si presentasse con un nome solo e stabile. Sarebbe anche sbagliato.
 * Due modelli diversi sono due **spazi vettoriali diversi**, e mescolarne le
 * righe in un indice solo dà distanze calcolate contro il vettore di query di
 * un altro modello — misurato in `vectors.ts` §"Stessa dimensione, altro
 * modello", che proprio su quella firma dell'id sa quali righe buttare.
 * Restituendo l'id attivo, uno scambio fa rifare l'indice una volta, che è il
 * prezzo giusto e non un difetto.
 *
 * **3. Lo scambio è appiccicoso, e in una direzione sola.** Conseguenza diretta
 * della 2: alternare fra i due riembedderebbe il corpus a ogni oscillazione.
 * Quindi non è un bilanciatore, è una **modalità degradata in cui si entra e ci
 * si resta** per la vita del processo. Si torna al locale riavviando — che è
 * esplicito, costa niente, e lascia al local-first l'ultima parola invece di
 * togliergliela in silenzio.
 *
 * E si passa al secondo **solo** per `EmbedderUnavailable`. Un 400 su un nome
 * di modello sbagliato non è "non disponibile": è un errore di configurazione,
 * e nasconderlo dietro un fallback che funziona è come non averlo mai avuto.
 */
export class FallbackEmbedder implements Embedder {
  readonly dimensions: number;
  private attivo: Embedder;
  private scambiato = false;

  constructor(
    private readonly primario: Embedder,
    private readonly secondario: Embedder,
    /** Chiamata una volta sola, quando si entra in modalità degradata. Il chiamante decide se stamparla. */
    private readonly onFallback?: (motivo: EmbedderUnavailable) => void,
  ) {
    if (primario.dimensions !== secondario.dimensions) {
      throw new Error(
        `fallback embedder: le dimensioni non coincidono — ${primario.id} ne ha ${primario.dimensions}, ` +
          `${secondario.id} ne ha ${secondario.dimensions}. La dimensione è cotta nella tabella vettoriale, ` +
          `quindi due valori diversi farebbero rifare l'indice a ogni scambio. Allineale in config.json.`,
      );
    }
    this.dimensions = primario.dimensions;
    this.attivo = primario;
  }

  /** Chi ha prodotto i vettori **adesso** — vedi §2 nell'intestazione: non è un nome composto. */
  get id(): string {
    return this.attivo.id;
  }

  /** Se stiamo girando sul secondo. Letto da `doctor` e da `sys_inspect`: una modalità degradata silenziosa è il guasto di partenza. */
  get degradato(): boolean {
    return this.scambiato;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.scambiato) return this.secondario.embed(texts);
    try {
      return await this.primario.embed(texts);
    } catch (error) {
      if (!(error instanceof EmbedderUnavailable)) throw error;
      this.scambiato = true;
      this.attivo = this.secondario;
      this.onFallback?.(error);
      return this.secondario.embed(texts);
    }
  }
}

/**
 * L'embedder che questa installazione ha scelto.
 *
 * Una sola funzione, e non un `new OllamaEmbedder()` sparso: `buildRuntime` e
 * `doctor` devono parlare dello **stesso** embedder, o il check di salute
 * misura una cosa e il runtime ne usa un'altra — che è precisamente il modo in
 * cui `doctor` diventa verde su una macchina dove la memoria non si indicizza.
 *
 * `openai-compat` pretende chiave, modello e dimensioni: la dimensione è cotta
 * nel DDL della tabella vettoriale, quindi un default inventato qui
 * significherebbe un indice che si rifà da solo al primo boot in cui qualcuno
 * scopre il numero vero.
 */
export type SceltaEmbedder = {
  kind: 'ollama' | 'openai-compat';
  model?: string | undefined;
  dimensions?: number | undefined;
  baseUrl?: string | undefined;
  apiKeyRef?: string | undefined;
};

export function makeEmbedder(
  scelta: (SceltaEmbedder & { fallback?: SceltaEmbedder | undefined }) | undefined,
  leggiSegreto: (ref: string) => string,
  onFallback?: (motivo: EmbedderUnavailable) => void,
): Embedder {
  const primario = unEmbedder(scelta, leggiSegreto);
  if (scelta?.fallback === undefined) return primario;
  // Il secondo si costruisce **subito**, non al primo guasto: una chiave che
  // manca o un `dimensions` assente devono fallire all'avvio, dove l'owner sta
  // guardando, non fra due giorni durante il primo consolidamento in cui il
  // locale non risponde — cioè esattamente quando il fallback serviva.
  return new FallbackEmbedder(primario, unEmbedder(scelta.fallback, leggiSegreto), onFallback);
}

function unEmbedder(
  scelta: SceltaEmbedder | undefined,
  leggiSegreto: (ref: string) => string,
): Embedder {
  if (scelta === undefined || scelta.kind === 'ollama') {
    // Il default di sempre, e i suoi default: assenza di configurazione non
    // deve mai voler dire un comportamento nuovo.
    return new OllamaEmbedder(
      scelta?.model ?? undefined,
      scelta?.dimensions ?? undefined,
      scelta?.baseUrl ?? undefined,
    );
  }
  const mancanti = (['model', 'dimensions', 'apiKeyRef'] as const).filter((k) => scelta[k] === undefined);
  if (mancanti.length > 0) {
    throw new Error(
      `embedder openai-compat: mancano ${mancanti.join(', ')} in config.json. ` +
        `La dimensione in particolare non ha un default sensato: è cotta nella tabella vettoriale.`,
    );
  }
  return new OpenAICompatEmbedder(
    leggiSegreto(scelta.apiKeyRef!),
    scelta.model!,
    scelta.dimensions!,
    scelta.baseUrl ?? 'https://api.openai.com/v1',
  );
}
