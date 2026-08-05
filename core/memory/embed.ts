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
    readonly model = 'qwen3-embedding:0.6b',
    readonly dimensions = 1024,
    private readonly baseUrl = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434',
  ) {
    this.id = `ollama:${model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const text of texts) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: text }),
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
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (error) {
      throw new EmbedderUnavailable(this.id, error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) throw new EmbedderUnavailable(this.id, `HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { embedding: number[] }[] };
    if (!body.data) throw new EmbedderUnavailable(this.id, 'risposta senza data');
    return body.data.map((d) => Float32Array.from(d.embedding));
  }
}

/** vec0 stores raw little-endian float32; better-sqlite3 wants a Buffer. */
export function toVectorBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}
