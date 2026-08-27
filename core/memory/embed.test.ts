import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { makeEmbedder, OpenAICompatEmbedder } from './embed.js';

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
