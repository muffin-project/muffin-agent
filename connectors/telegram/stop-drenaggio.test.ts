import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { LoopDeps } from '../../agent/loop.js';
import type { SessionStore } from '../../core/session/store.js';
import type { TelegramApiLike } from './api.js';
import { TelegramConnector, type ConnectorDeps } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';

/**
 * `stop()`'s own budget — the half `cli/drenaggio-attende.test.ts` cannot
 * exercise, because a real `fetch` genuinely responds to `AbortController`
 * regardless of what the remote server does. This drives `TelegramConnector`
 * directly against a `getUpdates` that never settles and never even looks at
 * the signal — the pathological "network truly wedged" case (a hung proxy, a
 * kernel-level stall) — to prove `stop()` itself has a real ceiling rather
 * than trusting the network to always cooperate.
 */
function deps(over: Partial<ConnectorDeps> & Pick<ConnectorDeps, 'api' | 'inbox'>): ConnectorDeps {
  return {
    loop: {} as LoopDeps,
    sessions: {} as SessionStore,
    lane: new ModelLane(),
    delivery: new TelegramDeliveryStore(new DatabaseCtor(':memory:')),
    config: { token: 't' },
    sleep: async () => {},
    ...over,
  };
}

const inbox = (): UpdateInbox => new UpdateInbox(new DatabaseCtor(':memory:'));
const me = { id: 1, username: 'muffin_bot' } as Awaited<ReturnType<TelegramApiLike['getMe']>>;

describe('stop() non aspetta per sempre', () => {
  it('un getUpdates genuinamente incagliato — ignora il segnale, non risponde mai — scade al budget, con la riga onesta', async () => {
    const logs: string[] = [];
    let getUpdatesCalls = 0;
    const api = {
      getMe: async () => me,
      getUpdates: async () => {
        getUpdatesCalls++;
        // Non risponde mai, e non guarda nemmeno il segnale — il caso che
        // l'abort non può risolvere da solo: qui è `stop()`'s stesso budget a
        // dover garantire che il processo non resti appeso per sempre.
        return new Promise<never>(() => {});
      },
      setMyCommands: async () => true,
    } as unknown as TelegramApiLike;

    const connector = new TelegramConnector(deps({ api, inbox: inbox(), log: (l) => logs.push(l) }));
    void connector.run();
    await vi.waitFor(() => expect(getUpdatesCalls).toBeGreaterThan(0));

    const budgetMs = 200;
    const iniziato = Date.now();
    const finita = await connector.stop(budgetMs);
    const trascorsi = Date.now() - iniziato;

    // Non ha finito in tempo — onestamente riportato, non finto un successo.
    expect(finita).toBe(false);
    // E soprattutto: non è rimasto appeso. Un margine largo (5×) assorbe la
    // varianza del runner senza nascondere una regressione verso "per sempre".
    expect(trascorsi).toBeLessThan(budgetMs * 5);

    const testo = logs.join('\n');
    expect(testo).toContain('fermata non confermata entro');
    // La frase che l'owner deve leggere — cosa significa per il suo messaggio,
    // non un dettaglio interno.
    expect(testo).toMatch(/potrebbe essere rimast[oa] a metà|riprende al prossimo avvio/);
  });

  it('con un budget molto più corto, lo stesso getUpdates incagliato non impedisce comunque una fermata onesta', async () => {
    // Lo stesso scenario, un budget più stretto: la garanzia è "il budget
    // vince sempre", non "di solito è abbastanza lungo".
    let getUpdatesCalls = 0;
    const api = {
      getMe: async () => me,
      getUpdates: async () => {
        getUpdatesCalls++;
        return new Promise<never>(() => {});
      },
      setMyCommands: async () => true,
    } as unknown as TelegramApiLike;

    const connector = new TelegramConnector(deps({ api, inbox: inbox() }));
    void connector.run();
    await vi.waitFor(() => expect(getUpdatesCalls).toBeGreaterThan(0));

    const finita = await connector.stop(30);
    expect(finita).toBe(false);
  });
});
