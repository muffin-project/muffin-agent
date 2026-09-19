import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider, routingBody, speaksStickySession } from './openai-compat.js';
import type { ChatCall } from './types.js';

/**
 * Cosa finisce davvero sul filo quando fra noi e il modello c'è uno smistatore.
 *
 * Nasce da una diagnosi sbagliata due volte, il 28/08/2026, e ogni test qui
 * chiude uno dei due errori.
 *
 * La misura di partenza: dentro un turno la cache prendeva il 54%, fra due
 * turni consecutivi a trenta secondi di distanza lo **0%**. `qwen/qwen3.8-27b`
 * su OpenRouter ha dodici provider a monte e undici sanno cachare — dodici
 * cache, tutte fredde a turno.
 *
 * **Primo errore.** Stavo per inchiodare il provider con `provider.order`. La
 * documentazione dice che `order` **disattiva** lo sticky routing: sarebbe
 * stato il rimedio che rompe la cosa che voleva riparare. Il campo giusto è
 * `session_id`, e la ragione del guasto era scritta: la chiave sticky la
 * derivano «dall'hash del primo messaggio di sistema e del primo non-di-sistema»,
 * e il nostro primo non-di-sistema è il recall, che cambia a ogni turno.
 *
 * **Secondo errore.** Con `session_id` l'instradamento è diventato stabile —
 * sei turni di fila sullo stesso provider — e la cache è rimasta a **0%**. Non
 * l'avrei mai capito senza registrare *chi* rispondeva: eravamo incollati a
 * Chutes, il più economico, che i nostri breakpoint non li onora. Con
 * `only: ['alibaba']` — l'unico dei dodici con un prezzo di *scrittura* cache —
 * la cache passa a **95% dal secondo turno**.
 *
 * Da lì la regola che questi test tengono: un modello su uno smistatore non è
 * una macchina, e la traccia deve dire quale macchina ha risposto.
 */

/** Cattura il corpo della richiesta invece di mandarla. */
function spia(): { body: () => Record<string, unknown>; fetch: typeof globalThis.fetch } {
  let corpo: Record<string, unknown> = {};
  return {
    body: () => corpo,
    fetch: async (_u, init) => {
      corpo = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'x',
          provider: 'Alibaba',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 8 } },
          model: 'qwen/qwen3.8-27b',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  };
}

const chiamata = (extra: Partial<ChatCall> = {}): ChatCall => ({
  model: 'qwen/qwen3.8-27b',
  system: [{ type: 'text', text: 'sistema', cache: 'stable' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
  maxOutputTokens: 10,
  stream: false,
  ...extra,
});

describe('la conversazione resta sullo stesso provider a monte', () => {
  it("manda l'impronta della conversazione, non l'identificatore", async () => {
    const s = spia();
    const p = new OpenAICompatProvider('k', 'https://openrouter.ai/api/v1', {}, { fetch: s.fetch });
    await p.chat(chiamata({ conversation: '2026-08-28-1a856e68' }));
    const id = s.body()['session_id'];
    expect(typeof id).toBe('string');
    // Stabile — è ciò che rende sticky la stickiness — e opaco: l'id di
    // sessione porta scritta la data, e non c'è ragione di regalarla.
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toContain('2026-08-28');
  });

  it('e la stessa conversazione dà la stessa impronta, due conversazioni no', async () => {
    const uno = spia();
    const due = spia();
    const tre = spia();
    const fai = async (s: ReturnType<typeof spia>, c: string): Promise<unknown> => {
      await new OpenAICompatProvider('k', 'https://openrouter.ai/api/v1', {}, { fetch: s.fetch }).chat(
        chiamata({ conversation: c }),
      );
      return s.body()['session_id'];
    };
    expect(await fai(uno, 'sessione-a')).toBe(await fai(due, 'sessione-a'));
    expect(await fai(uno, 'sessione-a')).not.toBe(await fai(tre, 'sessione-b'));
  });

  it('/new cambia session_id, un turno nuovo senza /new no', async () => {
    // La generation della conversazione (`owner#g0` -> `owner#g1`) è l'unica
    // cosa che muove lo stickiness: due turni della stessa conversazione
    // restano incollati allo stesso upstream, senza spendere un token.
    const fai = async (c: string): Promise<Record<string, unknown>> => {
      const s = spia();
      await new OpenAICompatProvider('k', 'https://openrouter.ai/api/v1', {}, { fetch: s.fetch }).chat(
        chiamata({ conversation: c }),
      );
      return s.body();
    };
    const turno1 = await fai('owner#g0');
    const turno2 = await fai('owner#g0');
    const dopoNew = await fai('owner#g1');
    expect(turno2['session_id']).toBe(turno1['session_id']);
    expect(dopoNew['session_id']).not.toBe(turno1['session_id']);
  });

  it("l'id di sessione/conversazione non viaggia mai in chiaro: solo l'hash opaco", async () => {
    const s = spia();
    const p = new OpenAICompatProvider('k', 'https://openrouter.ai/api/v1', {}, { fetch: s.fetch });
    await p.chat(chiamata({ conversation: 'owner#g0' }));
    const raw = JSON.stringify(s.body());
    expect(raw).not.toContain('owner#g0');
    expect(raw).not.toContain('owner');
    expect(s.body()['session_id']).toMatch(/^[0-9a-f]{32}$/);
  });

  /**
   * Un Ollama locale non smista niente, e un campo che non conosce è un campo
   * su cui può inciampare. Stesso argomento di `cache_control` e `reasoning`,
   * e stesso confronto per hostname esatto.
   */
  it('ma non lo manda a un endpoint che non smista niente', async () => {
    const s = spia();
    const p = new OpenAICompatProvider('k', 'http://localhost:11434/v1', {}, { fetch: s.fetch });
    await p.chat(chiamata({ conversation: 'sessione-a' }));
    expect(s.body()['session_id']).toBeUndefined();
  });

  it('né quando non c è una conversazione da nominare', async () => {
    const s = spia();
    const p = new OpenAICompatProvider('k', 'https://openrouter.ai/api/v1', {}, { fetch: s.fetch });
    await p.chat(chiamata());
    expect(s.body()['session_id']).toBeUndefined();
  });

  it('e riconosce lo smistatore per hostname, non per sottostringa', () => {
    expect(speaksStickySession('https://openrouter.ai/api/v1')).toBe(true);
    expect(speaksStickySession('https://openrouter.ai./api/v1')).toBe(true);
    expect(speaksStickySession('https://openrouter.ai.evil.tld/v1')).toBe(false);
    expect(speaksStickySession('http://localhost:11434/v1')).toBe(false);
    expect(speaksStickySession(undefined)).toBe(false);
  });
});

describe('le preferenze di instradamento', () => {
  /** I nomi del fornitore si traducono in un posto solo. */
  it('traducono i nostri nomi nei loro, e solo i campi presenti', () => {
    expect(routingBody({ only: ['alibaba'], dataCollection: 'deny' })).toEqual({
      only: ['alibaba'],
      data_collection: 'deny',
    });
    expect(routingBody({ requireParameters: true })).toEqual({ require_parameters: true });
    expect(routingBody({ only: ['Alibaba'], allowFallbacks: false })).toEqual({ only: ['Alibaba'], allow_fallbacks: false });
  });

  /**
   * `undefined` e non `{}`: un `provider: {}` vuoto è un campo in più che non
   * chiede niente, e su un endpoint che non lo conosce è un campo in più su cui
   * inciampare.
   */
  it('e senza niente da dire non dicono niente', () => {
    expect(routingBody(undefined)).toBeUndefined();
    expect(routingBody({})).toBeUndefined();
  });

  it('finiscono nel corpo sotto `provider`', async () => {
    const s = spia();
    const p = new OpenAICompatProvider(
      'k',
      'https://openrouter.ai/api/v1',
      {},
      { fetch: s.fetch, routing: { only: ['alibaba'] } },
    );
    await p.chat(chiamata());
    expect(s.body()['provider']).toEqual({ only: ['alibaba'] });
  });

  it('ma non verso un endpoint che non ha niente da instradare', async () => {
    const s = spia();
    const p = new OpenAICompatProvider(
      'k',
      'http://localhost:11434/v1',
      {},
      { fetch: s.fetch, routing: { only: ['alibaba'] } },
    );
    await p.chat(chiamata());
    expect(s.body()['provider']).toBeUndefined();
  });
});

describe('chi ha risposto davvero', () => {
  /**
   * Senza questo, «perché la cache non prende» non è una domanda a cui si possa
   * rispondere: si vede lo zero e non si vede che la richiesta è finita su una
   * macchina diversa, con una cache diversa. È stato il campo che ha chiuso la
   * diagnosi, dopo che l'ipotesi giusta sul meccanismo aveva prodotto il rimedio
   * sbagliato.
   */
  it('la risposta porta il provider a monte, quando lo dice', async () => {
    const s = spia();
    const p = new OpenAICompatProvider('k', 'https://openrouter.ai/api/v1', {}, { fetch: s.fetch });
    const r = await p.chat(chiamata());
    expect(r.upstream).toBe('Alibaba');
  });
});
