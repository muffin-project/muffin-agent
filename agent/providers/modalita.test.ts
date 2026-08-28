import { beforeEach, describe, expect, it } from 'vitest';
import { audioAccettato, dimenticaModalita } from './modalita.js';

/**
 * La domanda che decide dove va la voce dell'owner.
 *
 * Il ramo diretto manda i byte di una nota vocale al modello; l'altro la
 * trascrive in casa con whisper.cpp e manda solo testo. Sbagliare la domanda
 * sbaglia la cosa piu' privata che passa da qui, quindi il default e' "no" per
 * ogni forma di incertezza — e ognuno di questi test chiude una di quelle
 * forme.
 *
 * I payload sono quelli veri, ridotti: `architecture.input_modalities` e' il
 * campo misurato su `GET https://openrouter.ai/api/v1/models` il 28/08/2026,
 * dove `qwen/qwen3.8-27b` risponde `["text","image","video"]` — cioe' proprio
 * il caso in cui l'owner oggi ricade sulla trascrizione locale.
 */

const elenco = (modelli: unknown[]): typeof globalThis.fetch =>
  (async () =>
    new Response(JSON.stringify({ data: modelli }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

const CON_AUDIO = { id: 'google/gemini-3.7-flash', architecture: { input_modalities: ['text', 'image', 'audio'] } };
const SENZA_AUDIO = { id: 'qwen/qwen3.8-27b', architecture: { input_modalities: ['text', 'image', 'video'] } };

beforeEach(() => {
  dimenticaModalita();
});

describe('chi accetta audio, e chi no', () => {
  it('dice sì quando il provider elenca audio fra le modalità in ingresso', async () => {
    const f = elenco([SENZA_AUDIO, CON_AUDIO]);
    expect(await audioAccettato('https://openrouter.ai/api/v1', 'google/gemini-3.7-flash', { fetch: f })).toBe(true);
  });

  it('e no per il modello che oggi ha davvero l owner', async () => {
    const f = elenco([SENZA_AUDIO, CON_AUDIO]);
    expect(await audioAccettato('https://openrouter.ai/api/v1', 'qwen/qwen3.8-27b', { fetch: f })).toBe(false);
  });

  /**
   * Anthropic non accetta audio in ingresso in nessuna forma, quindi la
   * domanda non si fa proprio: nessuna richiesta parte, e l'adattatore
   * (`agent/providers/anthropic.ts`) tira se un blocco audio gli arriva
   * comunque, invece di lasciarlo cadere.
   */
  it('non chiede niente a nessuno quando il provider è Anthropic', async () => {
    let chiamate = 0;
    const f = (async () => {
      chiamate += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    expect(await audioAccettato(undefined, 'claude-opus-5', { fetch: f })).toBe(false);
    expect(chiamate).toBe(0);
  });
});

describe("ogni forma di incertezza cade sul ramo che non fa uscire niente", () => {
  it('un modello che non compare nell elenco', async () => {
    const f = elenco([CON_AUDIO]);
    expect(await audioAccettato('https://openrouter.ai/api/v1', 'un/modello-mai-visto', { fetch: f })).toBe(false);
  });

  /**
   * Ollama e vLLM parlano lo stesso protocollo ed elencano i modelli **senza**
   * `architecture`. Non è un guasto da segnalare: è un provider che non sa
   * rispondere a questa domanda, e non sapere vuol dire trascrivere in casa.
   */
  it('un endpoint compatibile che elenca i modelli senza architecture', async () => {
    const f = elenco([{ id: 'llama3', object: 'model', owned_by: 'library' }]);
    expect(await audioAccettato('http://localhost:11434/v1', 'llama3', { fetch: f })).toBe(false);
  });

  it('una risposta non-ok', async () => {
    const f = (async () => new Response('nope', { status: 500 })) as unknown as typeof globalThis.fetch;
    expect(await audioAccettato('https://openrouter.ai/api/v1', 'x', { fetch: f })).toBe(false);
  });

  it('la rete che non c è', async () => {
    const f = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    expect(await audioAccettato('https://openrouter.ai/api/v1', 'x', { fetch: f })).toBe(false);
  });

  it('un corpo che non è nemmeno JSON', async () => {
    const f = (async () => new Response('<html>errore</html>', { status: 200 })) as unknown as typeof globalThis.fetch;
    expect(await audioAccettato('https://openrouter.ai/api/v1', 'x', { fetch: f })).toBe(false);
  });
});

describe('si chiede una volta sola', () => {
  /**
   * Due note vocali che arrivano insieme sono normalissime su Telegram, e si
   * memoizza la **promessa** e non il valore proprio per quello: due domande
   * che si rincorrono farebbero due richieste per una risposta sola.
   */
  it('due domande in volo insieme fanno una richiesta sola', async () => {
    let chiamate = 0;
    const f = (async () => {
      chiamate += 1;
      return new Response(JSON.stringify({ data: [CON_AUDIO] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const url = 'https://openrouter.ai/api/v1';
    const [a, b] = await Promise.all([
      audioAccettato(url, 'google/gemini-3.7-flash', { fetch: f }),
      audioAccettato(url, 'google/gemini-3.7-flash', { fetch: f }),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(chiamate).toBe(1);
  });

  it('e due modelli diversi non si scambiano la risposta', async () => {
    const f = elenco([SENZA_AUDIO, CON_AUDIO]);
    const url = 'https://openrouter.ai/api/v1';
    expect(await audioAccettato(url, 'google/gemini-3.7-flash', { fetch: f })).toBe(true);
    expect(await audioAccettato(url, 'qwen/qwen3.8-27b', { fetch: f })).toBe(false);
  });
});
