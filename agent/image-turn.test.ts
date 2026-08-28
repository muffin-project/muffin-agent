import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';

/**
 * B10, la metà che mancava: **il modello vede davvero l'immagine.**
 *
 * Gli adattatori hanno i loro test — la forma sul filo, per entrambi i
 * provider. Quelli non bastano, e la ragione è che il difetto vero non stava
 * lì. Misurato contro il modello vero il 28/08/2026, con adattatori già
 * corretti e verdi, Muffin rispondeva:
 *
 *   «Non vedo nessuna immagine nel messaggio — non ce n'è una allegata.»
 *
 * L'immagine si perdeva **fra due funzioni**. `runTurn` la metteva nel proprio
 * `TurnInput`, ma non è quel `TurnInput` ad arrivare a `buildContext`: `drive`
 * ne riceve uno ridotto (sessione, signal, callback) e **ricostruisce** il
 * resto dal record del turno — `text: lastUserText(record.messages)`. Tutto ciò
 * che non passa dal record sparisce fra le due, e sparisce in silenzio: nessun
 * errore, nessun 400, solo un modello che risponde su un'immagine che non ha
 * mai ricevuto.
 *
 * Quindi questo test guarda **cosa arriva al provider**, non cosa entra nel
 * loop. È l'unico punto da cui quel difetto era visibile.
 */

class Registratore implements Provider {
  readonly kind = 'openai-compat' as const;
  visto: ChatCall[] = [];
  async chat(call: ChatCall): Promise<ChatResult> {
    this.visto.push(call);
    return {
      text: 'rosso, blu, verde',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test',
    };
  }
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'muffin-image-turn-'));
  const provider = new Registratore();
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test',
    tools: [],
    capabilities: new Map(),
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(),
      budgetExhausted: () => false,
      hardened: true,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return { deps, provider };
}

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const IMG = { type: 'image' as const, mediaType: 'image/png' as const, data: 'QUJD' };
const VOCE = { type: 'audio' as const, mediaType: 'audio/ogg' as const, data: 'T2dnUw==' };

describe("un'immagine arriva fino al provider", () => {
  it('il blocco immagine è nel messaggio che il provider riceve davvero', async () => {
    const h = harness();
    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s1'),
      text: 'che colori vedi?',
      images: [IMG],
    });

    const blocchi = h.provider.visto[0]!.messages.flatMap((m) => m.content);
    const immagini = blocchi.filter((b) => b.type === 'image');
    expect(immagini).toHaveLength(1);
    expect(immagini[0]).toEqual(IMG);
  });

  /**
   * L'immagine **prima** del testo della domanda: entrambe le API lo
   * raccomandano, e la posizione è l'unica cosa che questo può sbagliare senza
   * che nulla si rompa.
   */
  it("e sta prima della domanda, non dopo", async () => {
    const h = harness();
    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s1'),
      text: 'che colori vedi?',
      images: [IMG],
    });

    const ultimo = h.provider.visto[0]!.messages.at(-1)!;
    const tipi = ultimo.content.map((b) => b.type);
    const iImg = tipi.indexOf('image');
    const iTesto = ultimo.content.findIndex((b) => b.type === 'text' && b.text.includes('che colori'));
    expect(iImg).toBeGreaterThanOrEqual(0);
    expect(iImg).toBeLessThan(iTesto);
  });

  /**
   * Passa dal record del turno, ed è ciò che la fa sopravvivere a una ripresa
   * dopo un crash: `drive` ricostruisce il proprio input da lì, non dal
   * chiamante.
   */
  it('e resta nel record del turno, non solo nella chiamata', async () => {
    const h = harness();
    const r = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s1'),
      text: 'che colori vedi?',
      images: [IMG],
    });

    const record = h.deps.turns.get(r.turnId)!;
    const nel = record.messages.flatMap((m) => m.content).filter((b) => b.type === 'image');
    expect(nel).toEqual([IMG]);
  });

  /**
   * La nota vocale prende la stessa strada, e questo test esiste perché quella
   * strada ha già ingoiato una cosa una volta.
   *
   * Il commento in `drive` lo dice per intero: ciò che non passa dal record
   * sparisce fra le due funzioni **in silenzio**, e il modello risponde su
   * qualcosa che non ha mai ricevuto. Con l'audio sarebbe peggio che con
   * un'immagine: una nota vocale è spesso l'intero messaggio, quindi il turno
   * risponderebbe al nulla.
   *
   * Un blocco audio esiste solo quando il modello ascolta davvero — la domanda
   * la fa `agent/providers/modalita.ts` e la risposta arriva qui già presa.
   */
  it('una nota vocale arriva al provider, e passa dal record come le immagini', async () => {
    const h = harness();
    const r = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s1'),
      text: 'che ti ho detto?',
      audios: [VOCE],
    });

    const arrivati = h.provider.visto[0]!.messages.flatMap((m) => m.content).filter((b) => b.type === 'audio');
    expect(arrivati).toEqual([VOCE]);

    const record = h.deps.turns.get(r.turnId)!;
    expect(record.messages.flatMap((m) => m.content).filter((b) => b.type === 'audio')).toEqual([VOCE]);
  });

  it('e sta prima della domanda pure lei', async () => {
    const h = harness();
    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s1'),
      text: 'che ti ho detto?',
      audios: [VOCE],
    });
    const ultimo = h.provider.visto[0]!.messages.at(-1)!;
    const iAudio = ultimo.content.findIndex((b) => b.type === 'audio');
    const iTesto = ultimo.content.findIndex((b) => b.type === 'text' && b.text.includes('che ti ho detto'));
    expect(iAudio).toBeGreaterThanOrEqual(0);
    expect(iAudio).toBeLessThan(iTesto);
  });

  it('e un turno senza immagini non ne inventa nessuna', async () => {
    const h = harness();
    await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('s1'),
      text: 'ciao',
    });
    expect(h.provider.visto[0]!.messages.flatMap((m) => m.content).filter((b) => b.type === 'image')).toHaveLength(0);
  });
});
