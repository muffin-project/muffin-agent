import DatabaseCtor from 'better-sqlite3';
import type { Update } from '@grammyjs/types';
import { describe, expect, it } from 'vitest';
import type { LoopDeps } from '../../agent/loop.js';
import type { SessionStore } from '../../core/session/store.js';
import type { TelegramApiLike } from './api.js';
import { TelegramConnector, type ConnectorDeps } from './connector.js';
import { UpdateInbox } from './updates.js';

/**
 * A1's second gap (ADR-0035, "continuity belongs to Muffin, not the pid"):
 * `run()` used to call `getMe()` once, with no retry, outside `this.running`.
 * At boot — before the network or DNS is ready — that throw escaped the whole
 * function; `connectSurfaces` only `.catch`es it into a log line, so the
 * surface was dead for the rest of the process while the gateway, lock and
 * scheduler stayed up. This drives `run()` itself with a fake API and a fake
 * `sleep`, so the retry loop's shape is proved rather than re-typed by hand.
 *
 * On the pre-fix code every test below fails: the first two because `run()`
 * rejects on the very first `getMe()` throw instead of retrying, and the
 * third because `inbox.accept`'s throw was outside the loop's `try` and also
 * escaped `run()` whole.
 */

/** `loop` and `sessions` are never touched: every test here keeps the inbox's `pending()` empty. */
function baseDeps(over: Partial<ConnectorDeps> & Pick<ConnectorDeps, 'api' | 'inbox'>): ConnectorDeps {
  return {
    loop: {} as LoopDeps,
    sessions: {} as SessionStore,
    config: { token: 't' },
    ...over,
  };
}

describe('the telegram connector reconnects instead of dying once', () => {
  it('retries getMe() with backoff until it succeeds, then connects and drains', async () => {
    const sleeps: number[] = [];
    const logs: string[] = [];
    let calls = 0;
    let connector!: TelegramConnector;
    const api = {
      getMe: async () => {
        calls++;
        if (calls <= 2) throw new Error('ECONNREFUSED 127.0.0.1:443');
        return { id: 1, username: 'muffin_bot' } as Awaited<ReturnType<TelegramApiLike['getMe']>>;
      },
      // The poll loop's first call: stopping here — rather than letting `run()`
      // poll forever — is what lets a test about the *connection* phase bound
      // itself without a fake clock.
      getUpdates: async () => {
        connector.stop();
        return [];
      },
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(
      baseDeps({
        api,
        inbox: new UpdateInbox(new DatabaseCtor(':memory:')),
        log: (line) => logs.push(line),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );

    await connector.run();

    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2); // one backoff per failed attempt, none after success
    expect(logs.some((l) => l.includes('connesso come @muffin_bot'))).toBe(true);
    expect(logs.filter((l) => l.includes('riprovo fra')).length).toBe(2);
  });

  it('stop() during the backoff makes run() return instead of retrying forever', async () => {
    let getMeCalls = 0;
    let sleepCalls = 0;
    let connector!: TelegramConnector;
    const api = {
      getMe: async () => {
        getMeCalls++;
        throw new Error('rete non pronta');
      },
      getUpdates: async () => {
        throw new Error('non dovrebbe mai arrivare qui — run() doveva già essere tornato');
      },
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(
      baseDeps({
        api,
        inbox: new UpdateInbox(new DatabaseCtor(':memory:')),
        // Fires while "asleep" — the exact window `stop()` has to interrupt.
        sleep: async () => {
          sleepCalls++;
          connector.stop();
        },
      }),
    );

    await connector.run(); // a hang here is exactly the bug this test exists to catch

    expect(sleepCalls).toBe(1);
    expect(getMeCalls).toBe(1); // stop() was honoured before a second attempt
  });

  it('a throw from inbox.accept does not end the poller — logged, and it tries again', async () => {
    let getUpdatesCalls = 0;
    let connector!: TelegramConnector;
    const badInbox = {
      nextOffset: () => 0,
      pending: () => [], // the initial drain() at boot must find nothing pending
      accept: () => {
        throw new Error('disco pieno');
      },
    } as unknown as UpdateInbox;
    const api = {
      getMe: async () => ({ id: 1, username: 'b' }) as Awaited<ReturnType<TelegramApiLike['getMe']>>,
      getUpdates: async () => {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) return [{ update_id: 1 }] as unknown as Update[];
        connector.stop();
        return [];
      },
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(
      baseDeps({
        api,
        inbox: badInbox,
        sleep: async () => {},
      }),
    );

    await connector.run();

    expect(getUpdatesCalls).toBe(2); // survived the throw and polled again
  });
});
