import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { LoopDeps } from '../../agent/loop.js';
import type { SessionStore } from '../../core/session/store.js';
import { TelegramError, type TelegramApiLike } from './api.js';
import { TelegramConnector, type ConnectorDeps } from './connector.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';
import { ModelLane } from '../../core/turns/model-lane.js';

/**
 * Il 409 si dice una volta per stato, mai a timer.
 *
 * Il 03/09/2026 il terminale dell'owner riceveva la stessa riga ogni cinque
 * secondi, per sempre: un fatto solo, ripetuto. La causa (due poller) e' chiusa
 * dal cancello in `cli/surface.ts`; questa e' l'altra meta', perche' un 409
 * capita comunque — il processo di prima che se ne va, un secondo Muffin
 * altrove — e allora la riga che conta e' la prima, piu' quella che dice **per
 * quanto** e' durato. Un diario di soli fallimenti dice quanti, mai per quanto.
 */

function baseDeps(over: Partial<ConnectorDeps> & Pick<ConnectorDeps, 'api' | 'inbox'>): ConnectorDeps {
  return {
    loop: {} as LoopDeps,
    sessions: {} as SessionStore,
    lane: new ModelLane(),
    delivery: new TelegramDeliveryStore(new DatabaseCtor(':memory:')),
    config: { token: 't' },
    ...over,
  };
}

describe('un 409 che dura è una riga sola', () => {
  it('venti tentativi conflittuali producono una riga, e il rientro ne porta la durata', async () => {
    const logs: string[] = [];
    let chiamate = 0;
    // Orologio finto: il 409 dura un minuto di tempo dichiarato, senza che il
    // test aspetti un minuto vero.
    let orologio = Date.parse('2026-09-03T11:15:00.000Z');
    let connector!: TelegramConnector;
    const api = {
      getMe: async () => ({ id: 1, username: 'muffin_bot' }) as Awaited<ReturnType<TelegramApiLike['getMe']>>,
      getUpdates: async () => {
        chiamate++;
        if (chiamate <= 20) throw new TelegramError(409, 'Conflict: terminated by other getUpdates request');
        connector.stop();
        return [];
      },
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(
      baseDeps({
        api,
        inbox: new UpdateInbox(new DatabaseCtor(':memory:')),
        log: (line) => logs.push(line),
        now: () => new Date(orologio),
        // L'attesa fra un tentativo e l'altro esiste, ma qui non costa tempo:
        // avanza solo l'orologio, di tre secondi per giro.
        sleep: async () => {
          orologio += 3000;
        },
      }),
    );

    await connector.run();

    expect(chiamate).toBe(21);
    const conflitti = logs.filter((l) => l.includes('409, un altro getUpdates'));
    expect(conflitti).toHaveLength(1);
    // E il fatto nuovo, quando c'e': quanto e' durato.
    expect(logs).toContain('telegram: 409 rientrato dopo 60s — ricevo di nuovo');
  });

  it('un guasto diverso chiude lo stato: il 409 successivo è un 409 nuovo e si dice', async () => {
    const logs: string[] = [];
    let chiamate = 0;
    let connector!: TelegramConnector;
    const api = {
      getMe: async () => ({ id: 1, username: 'muffin_bot' }) as Awaited<ReturnType<TelegramApiLike['getMe']>>,
      getUpdates: async () => {
        chiamate++;
        if (chiamate === 1 || chiamate === 2) throw new TelegramError(409, 'Conflict');
        if (chiamate === 3) throw new Error('ECONNRESET');
        if (chiamate === 4) throw new TelegramError(409, 'Conflict');
        connector.stop();
        return [];
      },
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(
      baseDeps({
        api,
        inbox: new UpdateInbox(new DatabaseCtor(':memory:')),
        log: (line) => logs.push(line),
        sleep: async () => {},
      }),
    );

    await connector.run();

    expect(logs.filter((l) => l.includes('409, un altro getUpdates'))).toHaveLength(2);
    expect(logs.filter((l) => l.includes('polling fallito'))).toHaveLength(1);
  });
});
