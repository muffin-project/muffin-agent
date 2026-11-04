import { describe, expect, it } from 'vitest';
import { SHADOW_PACK } from './pack.js';
import { JudgmentError, type JudgmentQuestion } from './port.js';
import { TypeSafePort } from './typesafe.js';

/**
 * L'adattatore TypeSafe, con il `fetch` iniettato: **nessuna rete in questi
 * test** — la stessa politica che il resto del runtime ha verso i provider.
 * Il fake riceve l'url e il body che l'SDK manda davvero, quindi qui si
 * prova la traduzione (domande a posto, envelope intatto) e la mappatura
 * degli errori (timeout / HTTP / risposta non tipizzata).
 */

type Chiamata = { url: string; body: Record<string, unknown>; init: RequestInit | undefined };

const fakeFetch =
  (chiamate: Chiamata[], risposta: (body: Record<string, unknown>) => unknown) =>
  async (input: string, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    chiamate.push({ url: input, body: JSON.parse(raw) as Record<string, unknown>, init });
    return new Response(JSON.stringify(risposta(JSON.parse(raw) as Record<string, unknown>)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

const nuovAnswers = (body: Record<string, unknown>): Record<string, unknown> => {
  const questions = body.questions as Record<string, unknown>;
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: 0.83 };
  return answers;
};

const domandine: readonly JudgmentQuestion[] = SHADOW_PACK;

describe('TypeSafePort', () => {
  it('traduce le domande per id, manda l envelope e riporta il modello vero', async () => {
    const chiamate: Chiamata[] = [];
    const port = new TypeSafePort({
      apiKey: 'k-finta',
      baseUrl: 'http://[::1]:1',
      model: 'jev-test',
      maxRetries: 0,
      fetch: fakeFetch(chiamate, (body) => ({
        model: 'jev-1.13.0-test',
        answers: nuovAnswers(body),
        usage: { input_tokens: 321, output_tokens: 30 },
      })),
    });

    const verdetto = await port.judge({ state: { owner_request: 'fai' }, questions: domandine });

    expect(chiamate).toHaveLength(1);
    expect(chiamate[0]?.url).toBe('http://[::1]:1/v1/systemone');
    // L'id non viaggia: sul filo ci sono testo e criteri, la chiave è per il codice.
    const questions = chiamate[0]?.body.questions as Record<string, Record<string, unknown>>;
    expect(Object.keys(questions)).toContain('description_matches_command');
    expect(questions.description_matches_command?.type).toBe('noul');
    expect(String(questions.description_matches_command?.instructions)).toContain('description');
    expect(chiamate[0]?.body.state).toEqual({ owner_request: 'fai' });
    // La chiave sta nell header, mai nel body.
    expect(JSON.stringify(chiamate[0]?.body)).not.toContain('k-finta');

    expect(verdetto.provider).toBe('typesafe');
    expect(verdetto.model).toBe('jev-1.13.0-test');
    expect(verdetto.answers.description_matches_command).toEqual({
      kind: 'noul',
      probability: 0.83,
    });
    expect(verdetto.usage).toEqual({ inputTokens: 321, outputTokens: 30 });
    expect(verdetto.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('timeout: un fetch che non risponde diventa JudgmentError tipizzato', async () => {
    // Il fake onora il segnale come un fetch vero: senza, il timeout
    // dell'SDK non ha niente da interrompere e il test appende per sempre.
    const appesa = (_input: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const port = new TypeSafePort({
      apiKey: 'k',
      timeoutMs: 40,
      maxRetries: 0,
      fetch: appesa,
    });
    await expect(
      port.judge({ state: { a: 1 }, questions: domandine.slice(0, 1) }),
    ).rejects.toBeInstanceOf(JudgmentError);
    await port
      .judge({ state: { a: 1 }, questions: domandine.slice(0, 1) })
      .catch((e: JudgmentError) => {
        expect(e.failure.kind).toBe('timeout');
      });
  });

  it('un HTTP 500 dopo zero retry diventa api, con lo status nel dettaglio', async () => {
    const port = new TypeSafePort({
      apiKey: 'k',
      maxRetries: 0,
      fetch: async () =>
        new Response('{"error":{"message":"boom"}}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const esito = await port.judge({ state: { a: 1 }, questions: domandine.slice(0, 1) }).then(
      () => null,
      (e: JudgmentError) => e.failure,
    );
    expect(esito?.kind).toBe('api');
    expect(esito?.detail).toContain('500');
  });

  it('una risposta non tipizzata è un api error, non un verdetto inventato', async () => {
    const port = new TypeSafePort({
      apiKey: 'k',
      maxRetries: 0,
      fetch: fakeFetch([], () => ({
        model: 'm',
        answers: { q: { type: 'scelta', chissa: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    });
    const esito = await port
      .judge({ state: { a: 1 }, questions: [{ id: 'q', kind: 'noul', question: 'Q?' }] })
      .then(
        () => null,
        (e: JudgmentError) => e.failure,
      );
    expect(esito?.kind).toBe('api');
    expect(esito?.detail).toContain('non tipizzata');
  });
});
