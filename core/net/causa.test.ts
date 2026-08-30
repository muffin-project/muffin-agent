import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { causaDiRete } from './causa.js';

const TOKEN = 'bot1234567890:AAsegretissimoQuestoNonDeveApparireMai';

describe('causaDiRete — dice la causa, e non puo dire un segreto', () => {
  it('nomina la classe e il codice quando il codice ha forma di codice', () => {
    const errore = new TypeError('fetch failed');
    (errore as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(causaDiRete(errore)).toBe('TypeError (ECONNRESET)');
  });

  it('senza causa resta la sola classe', () => {
    expect(causaDiRete(new TypeError('fetch failed'))).toBe('TypeError');
  });

  it('quello che non e un Error non inventa una classe', () => {
    expect(causaDiRete('boom')).toBe('errore di rete');
    expect(causaDiRete(undefined)).toBe('errore di rete');
  });

  /**
   * Il difetto che questi tre blocchi uccidono e la ragione per cui il campo
   * si sceglie per **forma** e non per fiducia: su questo Node (v22, misurato
   * il 30/08/2026) `fetch` mette l URL completo dentro `error.message` quando
   * l URL e malformato, e l URL di Telegram porta il bot token nel path. Un
   * diagnostico che si fida di un campo perche oggi e pulito e un segreto che
   * aspetta la prossima versione della dipendenza.
   */
  it('un messaggio che porta il token non esce, nemmeno se e il solo dettaglio disponibile', () => {
    const errore = new TypeError(`Failed to parse URL from https://api.telegram.org/${TOKEN}/getUpdates`);
    expect(causaDiRete(errore)).not.toContain(TOKEN);
    expect(causaDiRete(errore)).toBe('TypeError');
  });

  it('un messaggio della causa che porta il token non esce', () => {
    const errore = new TypeError('fetch failed');
    (errore as { cause?: unknown }).cause = new Error(`connect fallita su https://api.telegram.org/${TOKEN}/getMe`);
    expect(causaDiRete(errore)).not.toContain(TOKEN);
    expect(causaDiRete(errore)).toBe('TypeError');
  });

  it('un codice a forma di URL non e un codice', () => {
    const errore = new TypeError('fetch failed');
    (errore as { cause?: unknown }).cause = { code: `https://api.telegram.org/${TOKEN}/getUpdates` };
    expect(causaDiRete(errore)).not.toContain(TOKEN);
    expect(causaDiRete(errore)).toBe('TypeError');
  });

  it('un nome a forma di URL non e un nome', () => {
    const errore = new Error('boom');
    errore.name = `https://api.telegram.org/${TOKEN}/getUpdates`;
    expect(causaDiRete(errore)).not.toContain(TOKEN);
    expect(causaDiRete(errore)).toBe('errore di rete');
  });

  it('un nome inutilizzabile non fa perdere un codice pulito', () => {
    const errore = new Error('boom');
    errore.name = `https://api.telegram.org/${TOKEN}/x`;
    (errore as { cause?: unknown }).cause = { code: 'ECONNRESET' };
    expect(causaDiRete(errore)).toBe('errore di rete (ECONNRESET)');
  });

  it('un codice lunghissimo non diventa una riga di log', () => {
    const errore = new TypeError('fetch failed');
    (errore as { cause?: unknown }).cause = { code: 'E'.repeat(4000) };
    expect(causaDiRete(errore)).toBe('TypeError');
  });
});

/**
 * La domanda che poteva falsificare la scelta, e che si continua a fare a ogni
 * corsa: **su questo runtime, un fallimento di rete vero porta davvero un
 * `cause.code`?** Se domani `fetch` cambia forma, il valore aggiunto sparisce
 * in silenzio e il log torna a dire soltanto «TypeError». Questi casi girano su
 * loopback: niente DNS, niente rete esterna, nessuna dipendenza da dove gira.
 */
describe('la forma su cui si regge: i fallimenti veri di questo fetch', () => {
  const chiudibili: net.Server[] = [];
  const ascolta = async (server: net.Server): Promise<number> => {
    chiudibili.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return (server.address() as net.AddressInfo).port;
  };
  afterAll(() => {
    for (const s of chiudibili) s.close();
  });

  const causaDi = async (url: string, timeoutMs = 5000): Promise<string> => {
    try {
      await fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
      throw new Error('la fetch non e fallita');
    } catch (error) {
      return causaDiRete(error);
    }
  };

  it('connessione rifiutata: ECONNREFUSED', async () => {
    // Una porta chiusa davvero: il server si apre solo per farsi dare un
    // numero libero, e si chiude subito.
    const effimero = net.createServer();
    const porta = await ascolta(effimero);
    await new Promise<void>((r) => effimero.close(() => r()));
    expect(await causaDi(`http://127.0.0.1:${porta}/${TOKEN}/getUpdates`)).toBe('TypeError (ECONNREFUSED)');
  });

  it('socket chiuso dall altro lato durante la richiesta: ECONNRESET', async () => {
    const porta = await ascolta(net.createServer((s) => s.destroy()));
    expect(await causaDi(`http://127.0.0.1:${porta}/${TOKEN}/getUpdates`)).toBe('TypeError (ECONNRESET)');
  });

  it('nessuna risposta: il timeout si distingue gia dal nome', async () => {
    const porta = await ascolta(net.createServer(() => {}));
    expect(await causaDi(`http://127.0.0.1:${porta}/${TOKEN}/getUpdates`, 300)).toBe('TimeoutError');
  });

  it('nessuno di questi fallimenti veri porta il token', async () => {
    const porta = await ascolta(net.createServer((s) => s.destroy()));
    expect(await causaDi(`http://127.0.0.1:${porta}/${TOKEN}/getUpdates`)).not.toContain('AAsegretissimo');
    expect(await causaDi(`http://[/${TOKEN}`)).not.toContain('AAsegretissimo');
  });
});
