import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { LoopDeps } from '../../agent/loop.js';
import type { SessionStore } from '../../core/session/store.js';
import { SaluteSuperfici } from '../../core/surface/salute.js';
import { TelegramError, type TelegramApiLike } from './api.js';
import { TelegramConnector, type ConnectorDeps } from './connector.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';

/**
 * La cucitura fra il connettore e cio' che `doctor` legge.
 *
 * Il guasto del 29-30/08 non e' stato che il polling fallisse: e' stato che
 * nessuno lo sapesse. Il registro puo' essere perfetto e la riga di `doctor`
 * puo' essere scritta bene, e se il battito non li aggiorna il risultato e'
 * identico a prima — verde sopra un guasto. Questi test guidano `run()` vero
 * con una api finta e guardano cosa finisce nel registro.
 */
function deps(over: Partial<ConnectorDeps> & Pick<ConnectorDeps, 'api' | 'inbox'>): ConnectorDeps {
  return {
    loop: {} as LoopDeps,
    sessions: {} as SessionStore,
    delivery: new TelegramDeliveryStore(new DatabaseCtor(':memory:')),
    config: { token: 't' },
    sleep: async () => {},
    ...over,
  };
}

const inbox = (): UpdateInbox => new UpdateInbox(new DatabaseCtor(':memory:'));
const me = { id: 1, username: 'muffin_bot' } as Awaited<ReturnType<TelegramApiLike['getMe']>>;

describe('il battito di Telegram dice se sta rispondendo', () => {
  it('un battito riuscito registra la superficie come connessa', async () => {
    const salute = new SaluteSuperfici();
    let connector!: TelegramConnector;
    const api = {
      getMe: async () => me,
      getUpdates: async () => {
        connector.stop();
        return [];
      },
      setMyCommands: async () => {},
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(deps({ api, inbox: inbox(), salute }));
    await connector.run();

    expect(salute.stato()).toEqual([
      expect.objectContaining({ id: 'telegram', connessa: true, fallimentiDiFila: 0 }),
    ]);
  });

  /**
   * Il caso vero, quello misurato: connessa, poi il polling smette. La causa
   * che arriva qui e' quella che `causaDiRete` ha costruito — con il codice, e
   * mai con il token.
   */
  it('un polling che fallisce registra la caduta, con la causa', async () => {
    const salute = new SaluteSuperfici();
    let connector!: TelegramConnector;
    let giri = 0;
    const api = {
      getMe: async () => me,
      getUpdates: async () => {
        giri++;
        if (giri > 2) connector.stop();
        throw new TelegramError(0, 'TypeError (ECONNRESET)');
      },
      setMyCommands: async () => {},
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(deps({ api, inbox: inbox(), salute }));
    await connector.run();

    const riga = salute.stato()[0];
    expect(riga?.connessa).toBe(false);
    expect(riga?.causa).toContain('ECONNRESET');
    expect(riga?.fallimentiDiFila).toBe(3);
  });

  /**
   * Un 409 e' due gateway sullo stesso token, e nessuno dei due riceve niente:
   * un guasto quanto una rete muta. Registrarlo come tale e' cio' che permette
   * alla **durata** di distinguerlo dal 409 di mezzo secondo mentre il processo
   * di prima se ne va.
   */
  it('anche un 409 che dura e una superficie che non riceve', async () => {
    const salute = new SaluteSuperfici();
    let connector!: TelegramConnector;
    const api = {
      getMe: async () => me,
      getUpdates: async () => {
        connector.stop();
        throw new TelegramError(409, 'Conflict');
      },
      setMyCommands: async () => {},
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(deps({ api, inbox: inbox(), salute }));
    await connector.run();

    expect(salute.stato()[0]).toEqual(expect.objectContaining({ connessa: false, fallimentiDiFila: 1 }));
  });

  it('e una riconnessione dopo una caduta torna verde', async () => {
    const salute = new SaluteSuperfici();
    let connector!: TelegramConnector;
    let giri = 0;
    const api = {
      getMe: async () => me,
      getUpdates: async () => {
        giri++;
        if (giri === 1) throw new TelegramError(0, 'TypeError (ECONNRESET)');
        connector.stop();
        return [];
      },
      setMyCommands: async () => {},
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(deps({ api, inbox: inbox(), salute }));
    await connector.run();

    expect(salute.stato()[0]).toEqual(expect.objectContaining({ connessa: true, fallimentiDiFila: 0 }));
  });

  it('un getMe che non risponde e gia una caduta, prima ancora del primo battito', async () => {
    const salute = new SaluteSuperfici();
    let connector!: TelegramConnector;
    let tentativi = 0;
    const api = {
      getMe: async () => {
        tentativi++;
        if (tentativi <= 2) throw new Error('ECONNREFUSED 127.0.0.1:443');
        return me;
      },
      getUpdates: async () => {
        connector.stop();
        return [];
      },
      setMyCommands: async () => {},
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(deps({ api, inbox: inbox(), salute }));
    // Durante i due fallimenti il registro deve gia' dire «non connessa»: e' la
    // finestra in cui l'installazione sembra su e non lo e'.
    const durante: boolean[] = [];
    const spia = {
      connessa: (id: string, ora: Date) => {
        durante.push(true);
        salute.connessa(id, ora);
      },
      caduta: (id: string, causa: string, ora: Date) => {
        durante.push(false);
        salute.caduta(id, causa, ora);
      },
    };
    connector = new TelegramConnector(deps({ api, inbox: inbox(), salute: spia }));
    await connector.run();

    expect(durante.slice(0, 3)).toEqual([false, false, true]);
    expect(salute.stato()[0]?.connessa).toBe(true);
  });
});
