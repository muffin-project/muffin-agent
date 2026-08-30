import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbedderUnavailable, makeEmbedder, OllamaEmbedder, OpenAICompatEmbedder } from './embed.js';

describe('makeEmbedder — la scelta che il docstring prometteva da sempre', () => {
  const mai = () => {
    throw new Error('nessun segreto va letto per Ollama');
  };

  it('senza configurazione resta Ollama coi default di sempre', () => {
    // Assenza di configurazione non deve mai voler dire comportamento nuovo:
    // è ciò che rende questa slice priva di migrazione.
    const e = makeEmbedder(undefined, mai);
    expect(e.id).toBe('ollama:qwen3-embedding:0.6b');
    expect(e.dimensions).toBe(1024);
  });

  it('`kind: ollama` con modello e dimensioni propri li rispetta', () => {
    const e = makeEmbedder({ kind: 'ollama', model: 'altro', dimensions: 768 }, mai);
    expect(e.id).toBe('ollama:altro');
    expect(e.dimensions).toBe(768);
  });

  it('`openai-compat` legge la chiave dal riferimento, mai dalla config', () => {
    const letti: string[] = [];
    const e = makeEmbedder(
      { kind: 'openai-compat', model: 'text-embedding-3-small', dimensions: 1536, apiKeyRef: 'secret://emb' },
      (ref) => {
        letti.push(ref);
        return 'chiave-finta';
      },
    );
    expect(letti).toEqual(['secret://emb']);
    expect(e.id).toBe('openai-compat:text-embedding-3-small');
    expect(e.dimensions).toBe(1536);
  });

  it('`openai-compat` senza dimensioni rifiuta invece di inventarle', () => {
    // La dimensione è cotta nel DDL della tabella vettoriale: un default
    // inventato qui significa un indice che si rifà da solo il giorno in cui
    // qualcuno scopre il numero vero. Meglio non partire.
    expect(() =>
      makeEmbedder({ kind: 'openai-compat', model: 'x', apiKeyRef: 'secret://e' }, () => 'k'),
    ).toThrow(/dimensions/);
  });

  it('e nomina tutto ciò che manca, non solo il primo', () => {
    expect(() => makeEmbedder({ kind: 'openai-compat' }, () => 'k')).toThrow(
      /model.*dimensions.*apiKeyRef/s,
    );
  });
});

/**
 * La dimensione è **cotta nella tabella vettoriale**, quindi qui non è un
 * dettaglio del protocollo: è la cosa che il resto del sistema dà per vera.
 */
describe('OpenAICompatEmbedder — la dimensione chiesta è la dimensione ricevuta', () => {
  let server: Server | undefined;
  const corpi: unknown[] = [];

  afterEach(async () => {
    corpi.length = 0;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  /** Un endpoint compatibile che restituisce embedding lunghi `quanto`. */
  async function endpoint(quanto: number): Promise<string> {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += String(c)));
      req.on('end', () => {
        corpi.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: quanto }, () => 0.1) }] }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as { port: number }).port}/v1`;
  }

  it('chiede la dimensione al server, invece di sperarla', async () => {
    // Sull'API di OpenAI `dimensions` è il parametro che accorcia davvero
    // l'embedding. Senza, configurare `text-embedding-3-small` a 512 era
    // garantito sbagliato: il server ne manda 1536 e lo si scopre all'insert
    // in vec0, dopo che il costruttore dell'indice ha già buttato il vecchio.
    const base = await endpoint(512);
    const e = new OpenAICompatEmbedder('sk-never-called', 'text-embedding-3-small', 512, base);
    const [v] = await e.embed(['ciao']);
    expect(v).toHaveLength(512);
    expect(corpi[0]).toMatchObject({ model: 'text-embedding-3-small', dimensions: 512 });
  });

  it('e se il server la ignora, lo dice nominando sé stesso', async () => {
    // Simmetrico a `OllamaEmbedder`, che questo controllo ce l'ha da sempre.
    // Senza, l'errore arriva da vec0 e non nomina né l'embedder né la
    // dimensione attesa.
    const base = await endpoint(1536);
    const e = new OpenAICompatEmbedder('sk-never-called', 'text-embedding-3-small', 512, base);
    await expect(e.embed(['ciao'])).rejects.toThrow(/openai-compat:text-embedding-3-small.*1536.*512/s);
  });
});

/**
 * Il difetto, misurato su questa macchina (Node v22.22.2, 30/08/2026): quando
 * ollama e' giu', `fetch` fallisce con `name = "TypeError"` e
 * `message = "fetch failed"` — la causa vera sta **solo** in `cause.code`:
 *
 * | fallimento | `error.name` | `error.message` | `cause.code` |
 * |---|---|---|---|
 * | ollama giu' (porta chiusa) | TypeError | `fetch failed` | `ECONNREFUSED` |
 * | DNS inesistente | TypeError | `fetch failed` | `ENOTFOUND` |
 * | URL malformato | TypeError | `Failed to parse URL from <url>` | `ERR_INVALID_URL` |
 *
 * `embed.ts` passava `error.message` a `EmbedderUnavailable`, cioe' consegnava
 * `fetch failed` e buttava il codice. E' li' che la causa muore: chi legge
 * — `doctor`, o la lista `strategies` del recall — non puo' piu' distinguere
 * «ollama non e' avviato» da «la rete e' caduta», perche' a valle non c'e'
 * piu' niente da distinguere.
 *
 * La seconda meta' e' la stessa garanzia di `causaDiRete`: `.message` puo'
 * portare l'URL (riga tre della tabella), e `embedder.baseUrl` e' scelto
 * dall'owner — `z.string().url()` accetta anche `https://utente:chiave@host`.
 * La chiave `openai-compat` viaggia nell'header, non nel path, quindi qui non
 * c'e' il segreto strutturale di Telegram; ma stampare `.message` era
 * comunque il campo sbagliato, e smettere di stamparlo chiude anche quello.
 */
describe('EmbedderUnavailable — la causa arriva a chi legge, e l URL no', () => {
  const CHIAVE = 'sk-segretissima-che-non-deve-apparire-mai';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const errorePorta = (codice: string): TypeError => {
    const e = new TypeError('fetch failed');
    (e as { cause?: unknown }).cause = Object.assign(new Error(`connect ${codice}`), { code: codice });
    return e;
  };

  it('ollama giu: il codice arriva, invece di «fetch failed»', async () => {
    vi.stubGlobal('fetch', async () => {
      throw errorePorta('ECONNREFUSED');
    });
    const e = new OllamaEmbedder('qwen3-embedding:0.6b', 1024, 'http://127.0.0.1:11434');
    await expect(e.embed(['x'])).rejects.toMatchObject({
      name: 'EmbedderUnavailable',
      causa: 'TypeError (ECONNREFUSED)',
    });
  });

  it('la rete caduta non si confonde con ollama giu', async () => {
    vi.stubGlobal('fetch', async () => {
      throw errorePorta('ENOTFOUND');
    });
    const e = new OllamaEmbedder('qwen3-embedding:0.6b', 1024, 'http://127.0.0.1:11434');
    await expect(e.embed(['x'])).rejects.toMatchObject({ causa: 'TypeError (ENOTFOUND)' });
  });

  it('openai-compat porta il codice come ollama', async () => {
    vi.stubGlobal('fetch', async () => {
      throw errorePorta('ECONNRESET');
    });
    const e = new OpenAICompatEmbedder(CHIAVE, 'text-embedding-3-small', 1536, 'https://api.esempio.test/v1');
    await expect(e.embed(['x'])).rejects.toMatchObject({ causa: 'TypeError (ECONNRESET)' });
  });

  it('un URL malformato non esce dal messaggio, nemmeno con una chiave dentro', async () => {
    // Il caso della riga tre: e' l unico in cui `fetch` mette l URL intero in
    // `.message`. `baseUrl` lo scrive l owner, e lo schema accetta lo userinfo.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError(`Failed to parse URL from https://utente:${CHIAVE}@host/embeddings`);
    });
    const e = new OpenAICompatEmbedder('k', 'm', 4, `https://utente:${CHIAVE}@host`);
    await expect(e.embed(['x'])).rejects.toSatisfy(
      (err: unknown) => err instanceof EmbedderUnavailable && !err.message.includes(CHIAVE) && !err.causa.includes(CHIAVE),
    );
  });

  it('l id dell embedder resta nel messaggio: e cio che dice quale config e rotta', async () => {
    vi.stubGlobal('fetch', async () => {
      throw errorePorta('ECONNREFUSED');
    });
    const e = new OllamaEmbedder('un-modello-inventato', 7, 'http://127.0.0.1:11434');
    await expect(e.embed(['x'])).rejects.toThrow(/un-modello-inventato/);
  });

  it('i fallimenti che non sono di rete tengono la loro causa parlante', async () => {
    // `HTTP 404` e la dimensione sbagliata sono gia' cause precise: il campo
    // `causa` le porta identiche, e non le riscrive in «errore di rete».
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    const e = new OllamaEmbedder('m', 1024, 'http://127.0.0.1:11434');
    await expect(e.embed(['x'])).rejects.toMatchObject({ causa: 'HTTP 404' });
  });
});
