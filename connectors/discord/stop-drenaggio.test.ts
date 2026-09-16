import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { LoopDeps } from '../../agent/loop.js';
import type { SessionStore } from '../../core/session/store.js';
import type { DiscordApi } from './api.js';
import { DiscordConnector, type ConnectorDeps } from './connector.js';
import { DiscordInbox } from './inbox.js';
import { ModelLane } from '../../core/turns/model-lane.js';

/**
 * `TelegramConnector`'s own `stop-drenaggio.test.ts`, over the Discord shape:
 * the same `stop(budgetMs)` contract, the same shared `awaitWithBudget`
 * (`connectors/shared/stop-budget.ts`) — one mechanism, exercised on both
 * connectors rather than trusted by resemblance.
 */
function deps(over: Partial<ConnectorDeps> & Pick<ConnectorDeps, 'api' | 'inbox'>): ConnectorDeps {
  return {
    loop: {} as LoopDeps,
    sessions: {} as SessionStore,
    lane: new ModelLane(),
    config: { token: 't' },
    ...over,
  };
}

const inbox = (): DiscordInbox => new DiscordInbox(new DatabaseCtor(':memory:'));

describe('stop() di Discord non aspetta per sempre', () => {
  it('un `me()` genuinamente incagliato — non risponde mai — scade al budget, con la riga onesta, senza restare appeso', async () => {
    const logs: string[] = [];
    let meCalls = 0;
    const api = {
      me: async () => {
        meCalls++;
        return new Promise<never>(() => {});
      },
    } as unknown as DiscordApi;

    const connector = new DiscordConnector(deps({ api, inbox: inbox(), log: (l) => logs.push(l) }));
    void connector.run();
    await vi.waitFor(() => expect(meCalls).toBeGreaterThan(0));

    const budgetMs = 150;
    const iniziato = Date.now();
    const finita = await connector.stop(budgetMs);
    const trascorsi = Date.now() - iniziato;

    expect(finita).toBe(false);
    expect(trascorsi).toBeLessThan(budgetMs * 5);
    expect(logs.join('\n')).toContain('fermata non confermata entro');
  });
});
