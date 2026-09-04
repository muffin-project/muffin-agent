import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoopDeps } from '../../agent/loop.js';
import type { SessionStore } from '../../core/session/store.js';
import { causaDiRete } from '../../core/net/causa.js';
import { TelegramError, type TelegramApiLike } from './api.js';
import { TelegramConnector, type ConnectorDeps } from './connector.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';

/**
 * I tre difetti misurati il 3-4/09/2026 su `~/.muffin/gateway.err` (4748
 * righe `telegram: polling fallito`, in undici mesi... anzi: in un solo
 * gateway):
 *
 * 1. `connector.ts` dormiva **5 secondi fissi** dopo qualunque guasto di
 *    `getUpdates`, rete compresa — undici minuti di `ENOTFOUND` misurati
 *    producevano decine di tentativi identici, e al ritorno della rete il
 *    messaggio dell'owner aspettava comunque fino a 5 secondi ciechi.
 * 2. 3188 righe su 4748 (67%) restavano `Telegram 0: TypeError` nuda:
 *    `causaDiRete` esisteva ma seguiva un solo livello di `.cause`, e
 *    `fetch` (undici) puo' incapsularne due.
 * 3. Nessuna riga diceva *per quanto* era durato un guasto di rete — il 409
 *    ce l'ha gia' (`conflitto-409.test.ts`), la rete no.
 *
 * Questo file prova le tre cose sul comportamento del poller, non sulla
 * formula isolata: `causa.test.ts` prova `causaDiRete` da sola.
 */

function baseDeps(over: Partial<ConnectorDeps> & Pick<ConnectorDeps, 'api' | 'inbox'>): ConnectorDeps {
  return {
    loop: {} as LoopDeps,
    sessions: {} as SessionStore,
    delivery: new TelegramDeliveryStore(new DatabaseCtor(':memory:')),
    config: { token: 't' },
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('un guasto di rete su getUpdates non costa un attesa fissa', () => {
  it('attesa crescente con tetto, e resettata di scatto al primo successo — tenendo il tempo aperto, non un solo istante', async () => {
    // Jitter azzerato: la crescita e il tetto si vedono senza rumore. Un
    // secondo test, sotto, prova che il jitter c'e' davvero quando non e'
    // azzerato.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const logs: string[] = [];
    const attese: number[] = [];
    let orologio = Date.parse('2026-09-04T02:16:00.000Z');
    let chiamate = 0;
    let connector!: TelegramConnector;

    const api = {
      getMe: async () => ({ id: 1, username: 'muffin_bot' }) as Awaited<ReturnType<TelegramApiLike['getMe']>>,
      getUpdates: async () => {
        chiamate++;
        // Otto guasti di rete di fila (la prima serie), poi un successo che
        // deve azzerare tutto, poi un altro guasto solo (la seconda serie,
        // che deve ripartire corta, non da dove la prima aveva finito), poi
        // un secondo successo che ferma il test.
        if (chiamate <= 8) throw new TelegramError(0, 'TypeError (ECONNRESET)');
        if (chiamate === 10) throw new TelegramError(0, 'TypeError (ENOTFOUND)');
        if (chiamate === 11) {
          connector.stop();
          return [];
        }
        return [];
      },
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(
      baseDeps({
        api,
        inbox: new UpdateInbox(new DatabaseCtor(':memory:')),
        log: (line) => logs.push(line),
        now: () => new Date(orologio),
        // Il tempo resta aperto nel finto: ogni `sleep` avanza l'orologio di
        // esattamente quanto e' stato chiesto, invece di far scattare il test
        // a un istante deciso in anticipo — cosi' la somma delle attese e' la
        // prova, non un numero riscritto a mano.
        sleep: async (ms: number) => {
          attese.push(ms);
          orologio += ms;
        },
      }),
    );

    await connector.run();

    // Otto guasti di rete: 1s, 2s, 4s, 8s, 16s, poi il tetto a 30s tre volte.
    expect(attese.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    // Il successo alla nona chiamata azzera lo streak: il guasto solo alla
    // decima riparte dall'attesa piu' corta, non da 30s.
    expect(attese[8]).toBe(1000);

    // Una riga per **stato**, non per tentativo: due serie di guasti, due
    // righe di apertura — non dieci.
    const aperture = logs.filter((l) => l.includes('polling fallito') && l.includes('riprovo con attesa crescente'));
    expect(aperture).toHaveLength(2);

    // E la riga che chiude porta la durata vera, sul modello del 409: la
    // prima serie e' durata 1+2+4+8+16+30+30+30 = 121s.
    expect(logs).toContain('telegram: rete tornata dopo 121s — ricevo di nuovo');
    // La seconda serie e' un solo guasto da 1s.
    expect(logs).toContain('telegram: rete tornata dopo 1s — ricevo di nuovo');
  });

  it('il jitter esiste davvero: la prima attesa non e mai esattamente il tetto', async () => {
    const attese: number[] = [];
    let connector!: TelegramConnector;
    let chiamate = 0;
    const api = {
      getMe: async () => ({ id: 1, username: 'muffin_bot' }) as Awaited<ReturnType<TelegramApiLike['getMe']>>,
      getUpdates: async () => {
        chiamate++;
        if (chiamate === 1) throw new TelegramError(0, 'TypeError (ECONNRESET)');
        connector.stop();
        return [];
      },
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(
      baseDeps({
        api,
        inbox: new UpdateInbox(new DatabaseCtor(':memory:')),
        sleep: async (ms: number) => {
          attese.push(ms);
        },
      }),
    );

    await connector.run();

    // backoffMs(0) = min(1000*2**0, 30000) + jitter[0,1000): sempre in
    // [1000, 2000), mai fisso a 1000 come lo era il vecchio `sleep(5000)`.
    expect(attese).toHaveLength(1);
    expect(attese[0]).toBeGreaterThanOrEqual(1000);
    expect(attese[0]).toBeLessThan(2000);
  });
});

describe('un guasto di rete dice sempre perche (integrazione col poller, non solo la funzione)', () => {
  it('una TypeError con causa a due livelli, esattamente come la produce undici, nomina il codice nella riga di log', async () => {
    // La stessa forma misurata/riprodotta per `causaDiRete`: `fetch` incapsula
    // il fallimento come `TypeError('fetch failed', { cause })`, e quella
    // `cause` a sua volta ha la propria `.cause` col codice vero — due
    // livelli, non uno. `api.ts` e' quello che chiama davvero `causaDiRete`
    // su un errore cosi'; qui lo si costruisce a mano per provare che il
    // poller stampa cio' che `causaDiRete` ora sa trovare.
    const codiceDiSistema = { code: 'ECONNRESET' };
    const causaIntermedia = Object.assign(new Error('other side closed'), { cause: codiceDiSistema });
    const fetchFailed = new TypeError('fetch failed');
    (fetchFailed as { cause?: unknown }).cause = causaIntermedia;

    const logs: string[] = [];
    let connector!: TelegramConnector;
    let chiamate = 0;
    const api = {
      getMe: async () => ({ id: 1, username: 'muffin_bot' }) as Awaited<ReturnType<TelegramApiLike['getMe']>>,
      getUpdates: async () => {
        chiamate++;
        // Cio' che `api.ts#request` fa davvero nel suo catch: impacchetta il
        // fallimento di trasporto con `causaDiRete`.
        if (chiamate === 1) throw new TelegramError(0, causaDiRete(fetchFailed));
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

    const riga = logs.find((l) => l.includes('polling fallito'));
    expect(riga).toBeDefined();
    expect(riga).toContain('ECONNRESET');
    expect(riga).not.toBe('telegram: polling fallito (Telegram 0: TypeError) — riprovo con attesa crescente');
  });
});

describe('un database chiuso non e un guasto di rete', () => {
  it('ferma il giro invece di dormire e ripetere — non si ripara aspettando', async () => {
    const logs: string[] = [];
    const attese: number[] = [];
    const api = {
      getMe: async () => ({ id: 1, username: 'muffin_bot' }) as Awaited<ReturnType<TelegramApiLike['getMe']>>,
      getUpdates: async () => {
        throw new Error('The database connection is not open');
      },
    } as unknown as TelegramApiLike;

    const connector = new TelegramConnector(
      baseDeps({
        api,
        inbox: new UpdateInbox(new DatabaseCtor(':memory:')),
        log: (line) => logs.push(line),
        sleep: async (ms: number) => {
          attese.push(ms);
        },
      }),
    );

    // Nessuno stop esplicito: il giro deve fermarsi da solo, per questo
    // guasto — se non lo facesse, questo `await` non tornerebbe mai (il mock
    // rilancia lo stesso errore per sempre) e il test andrebbe in timeout,
    // che e' esso stesso il rosso.
    await connector.run();

    expect(attese).toHaveLength(0);
    expect(logs.some((l) => l.includes('ricezione fermata') && l.includes('database connection is not open'))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes('polling fallito'))).toBe(false);
  });

  it('un altro guasto che non e la rete e non e questa firma esatta resta trattato come da riprovare', async () => {
    const logs: string[] = [];
    const attese: number[] = [];
    let connector!: TelegramConnector;
    let chiamate = 0;
    const api = {
      getMe: async () => ({ id: 1, username: 'muffin_bot' }) as Awaited<ReturnType<TelegramApiLike['getMe']>>,
      getUpdates: async () => {
        chiamate++;
        if (chiamate === 1) throw new Error('inbox: scrittura fallita per un motivo qualsiasi');
        connector.stop();
        return [];
      },
    } as unknown as TelegramApiLike;

    connector = new TelegramConnector(
      baseDeps({
        api,
        inbox: new UpdateInbox(new DatabaseCtor(':memory:')),
        log: (line) => logs.push(line),
        sleep: async (ms: number) => {
          attese.push(ms);
        },
      }),
    );

    await connector.run();

    expect(attese).toHaveLength(1);
    expect(logs.some((l) => l.includes('ricezione fermata'))).toBe(false);
    expect(logs.some((l) => l.includes('polling fallito'))).toBe(true);
  });
});
