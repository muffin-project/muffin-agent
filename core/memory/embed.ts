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
export function makeEmbedder(
  scelta: {
    kind: 'ollama' | 'openai-compat';
    model?: string | undefined;
    dimensions?: number | undefined;
    baseUrl?: string | undefined;
    apiKeyRef?: string | undefined;
  } | undefined,
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
