import { describe, expect, it, vi } from 'vitest';
import { EmbedderUnavailable, FallbackEmbedder, makeEmbedder, type Embedder } from './embed.js';

/** Un embedder che risponde, o che si rifiuta nel modo che il fallback deve riconoscere. */
class Finto implements Embedder {
  chiamate = 0;
  constructor(
    readonly id: string,
    readonly dimensions: number,
    private readonly esito: 'ok' | 'giu' | 'rotto' = 'ok',
  ) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.chiamate += 1;
    if (this.esito === 'giu') throw new EmbedderUnavailable(this.id, 'fetch failed');
    if (this.esito === 'rotto') throw new Error('400 model not found');
    return texts.map(() => new Float32Array(this.dimensions));
  }
}

describe('FallbackEmbedder', () => {
  it('finché il primario risponde, il secondo non viene mai toccato', async () => {
    const a = new Finto('ollama:x', 4);
    const b = new Finto('openai:y', 4);
    const e = new FallbackEmbedder(a, b);
    await e.embed(['uno']);
    await e.embed(['due']);
    expect(a.chiamate).toBe(2);
    expect(b.chiamate).toBe(0);
    expect(e.id).toBe('ollama:x');
    expect(e.degradato).toBe(false);
  });

  it('quando il primario è giù passa al secondo e la richiesta va comunque a buon fine', async () => {
    const e = new FallbackEmbedder(new Finto('ollama:x', 4, 'giu'), new Finto('openai:y', 4));
    const out = await e.embed(['uno']);
    expect(out).toHaveLength(1);
    expect(e.degradato).toBe(true);
  });

  /**
   * La proprietà che conta, e la meno ovvia. Due modelli sono due spazi
   * vettoriali: se l'insieme si presentasse con un id composto e stabile,
   * `vectors.ts` crederebbe che le righe vecchie e le nuove siano confrontabili,
   * e le distanze verrebbero calcolate contro il vettore di query di un altro
   * modello. Restituendo l'id attivo, l'indice si rifà una volta — che è il
   * prezzo giusto, non un difetto.
   */
  it("l'id diventa quello di chi ha davvero prodotto il vettore, non un nome composto", async () => {
    const e = new FallbackEmbedder(new Finto('ollama:x', 4, 'giu'), new Finto('openai:y', 4));
    expect(e.id).toBe('ollama:x');
    await e.embed(['uno']);
    expect(e.id).toBe('openai:y');
  });

  /** Conseguenza diretta: alternare riembedderebbe il corpus a ogni oscillazione. */
  it('lo scambio è appiccicoso: una volta degradato non ritenta il primario', async () => {
    const a = new Finto('ollama:x', 4, 'giu');
    const b = new Finto('openai:y', 4);
    const e = new FallbackEmbedder(a, b);
    await e.embed(['uno']);
    await e.embed(['due']);
    await e.embed(['tre']);
    expect(a.chiamate).toBe(1);
    expect(b.chiamate).toBe(3);
  });

  it('avvisa una volta sola, non a ogni chiamata', async () => {
    const avviso = vi.fn();
    const e = new FallbackEmbedder(new Finto('ollama:x', 4, 'giu'), new Finto('openai:y', 4), avviso);
    await e.embed(['uno']);
    await e.embed(['due']);
    expect(avviso).toHaveBeenCalledTimes(1);
    expect(avviso.mock.calls[0]![0]).toBeInstanceOf(EmbedderUnavailable);
  });

  /**
   * Un 400 su un nome di modello sbagliato non è «non disponibile»: è un errore
   * di configurazione, e nasconderlo dietro un fallback che funziona è come non
   * averlo mai avuto.
   */
  it('un guasto che non è indisponibilità risale, e non consuma il fallback', async () => {
    const b = new Finto('openai:y', 4);
    const e = new FallbackEmbedder(new Finto('ollama:x', 4, 'rotto'), b);
    await expect(e.embed(['uno'])).rejects.toThrow('400 model not found');
    expect(b.chiamate).toBe(0);
    expect(e.degradato).toBe(false);
  });

  /**
   * La dimensione è cotta nel DDL della tabella vec0: due valori diversi
   * farebbero ricostruire l'indice a ogni scambio. Si rifiuta alla costruzione,
   * con i due numeri nel messaggio, perché è l'unica versione che non produce
   * una macchina che si rifà l'indice per sempre.
   */
  it('due dimensioni diverse non si costruiscono affatto, e il messaggio le nomina entrambe', () => {
    expect(() => new FallbackEmbedder(new Finto('ollama:x', 1024), new Finto('openai:y', 1536))).toThrow(
      /1024.*1536|1536.*1024/s,
    );
  });
});

describe('makeEmbedder con fallback', () => {
  it('senza `fallback` in config resta esattamente quello di prima', () => {
    const e = makeEmbedder({ kind: 'ollama' }, () => 'k');
    expect(e).not.toBeInstanceOf(FallbackEmbedder);
    expect(e.id).toBe('ollama:qwen3-embedding:0.6b');
  });

  /**
   * Il secondo si costruisce all'avvio, non al primo guasto: una chiave che
   * manca deve fallire dove l'owner sta guardando, non fra due giorni durante
   * il primo consolidamento in cui il locale non risponde — cioè esattamente
   * quando il fallback serviva.
   */
  it('un fallback mal configurato fallisce subito, non al primo guasto del primario', () => {
    expect(() =>
      makeEmbedder({ kind: 'ollama', fallback: { kind: 'openai-compat', model: 'text-embedding-3-small' } }, () => 'k'),
    ).toThrow(/dimensions|apiKeyRef/);
  });

  it('un fallback completo si costruisce, e porta la dimensione di entrambi', () => {
    const e = makeEmbedder(
      {
        kind: 'ollama',
        dimensions: 1536,
        fallback: {
          kind: 'openai-compat',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          apiKeyRef: 'secret://k',
        },
      },
      () => 'sk-test',
    );
    expect(e).toBeInstanceOf(FallbackEmbedder);
    expect(e.dimensions).toBe(1536);
  });
});
