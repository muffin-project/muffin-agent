import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';
import { connectSurfaces } from './surface.js';
import { ModelLane } from '../core/turns/model-lane.js';
import { surfaceStandDown } from './repl.js';
import { buildRuntime } from '../agent/runtime.js';
import { GatewayLock } from '../core/gateway/lock.js';
import { loadConfig, saveConfig, writeSecret } from '../core/config/config.js';
import { startFakeProvider } from '../evals/acceptance/provider.js';

/**
 * Una bocca sola su Telegram — il difetto del 03/09/2026.
 *
 * Con un gateway sotto supervisore, aprire il REPL riempiva il terminale di
 * `telegram: 409, un altro getUpdates è attivo — attendo` ogni pochi secondi,
 * per sempre: `connectSurfaces` veniva chiamata da entrambi i processi, Telegram
 * serve un solo `getUpdates` per token e risponde 409 al perdente. ADR-0022 dice
 * un processo; ADR-0035 aveva gia' fatto cedere allo stesso REPL lo *scheduler*,
 * e non la bocca.
 *
 * Si prova sul cablaggio vero — `buildRuntime`, `connectSurfaces`,
 * `surfaceStandDown`, il lucchetto vero — contro un Bot API finto che **conta le
 * chiamate**: e' il numero di `getUpdates` a distinguere «cede» da «non cede»,
 * non una riga di log che potrebbe cambiare parola domani.
 */

type FintoBot = {
  baseUrl: string;
  close: () => Promise<void>;
  /** Quante volte questo processo ha chiesto update. Zero = non sta ricevendo. */
  getUpdates: number;
  /** I testi passati a `sendMessage`: la prova che mandare continua a funzionare. */
  inviati: string[];
};

function fintoBotApi(): Promise<FintoBot> {
  const stato: { getUpdates: number; inviati: string[] } = { getUpdates: 0, inviati: [] };
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const url = req.url ?? '';
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (url.endsWith('/getMe')) {
          res.end(JSON.stringify({ ok: true, result: { id: 42, is_bot: true, username: 'MuffinUnaBocca' } }));
          return;
        }
        if (url.includes('/getUpdates')) {
          stato.getUpdates++;
          res.end(JSON.stringify({ ok: true, result: [] }));
          return;
        }
        if (url.includes('/sendMessage')) {
          try {
            stato.inviati.push(String((JSON.parse(body) as { text?: unknown }).text ?? ''));
          } catch {
            stato.inviati.push(body);
          }
          res.end(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 7 }, date: 0 } }));
          return;
        }
        res.end(JSON.stringify({ ok: true, result: [] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
        get getUpdates() {
          return stato.getUpdates;
        },
        get inviati() {
          return stato.inviati;
        },
      });
    });
  });
}

/** Una home vera con Telegram abilitata e puntata al Bot API finto. */
function casa(baseUrl: string, providerUrl: string): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-una-bocca-'));
  runInit({ home, provider: 'openai-compat', baseUrl: providerUrl, apiKey: 'sk-una-bocca' });
  writeSecret('telegram_token', '000:finto', home, 'home');
  const config = loadConfig(home);
  saveConfig(
    {
      ...config,
      surfaces: {
        ...config.surfaces,
        enabled: [...config.surfaces.enabled.filter((s) => s !== 'telegram'), 'telegram'],
        telegram: { ownerUserId: 7, ownerChatId: 7, apiBase: baseUrl },
      },
    },
    home,
  );
  return home;
}

const attendi = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('con un gateway vivo, il REPL non apre una seconda bocca su Telegram', () => {
  afterEach(() => vi.restoreAllMocks());

  it('non chiama mai getUpdates, e lo dice una volta nominando il pid che serve', async () => {
    const provider = await startFakeProvider({ main: [{ text: 'irrilevante' }] });
    const bot = await fintoBotApi();
    const home = casa(bot.baseUrl, provider.baseUrl);
    try {
      const runtime = buildRuntime(home, home);
      // Il lucchetto vero, preso da un pid vivo: e' esattamente cio' che vede
      // un REPL aperto mentre `muffin gateway run` gira.
      new GatewayLock(runtime.db).claim(new Date(), 'test', process.pid);

      const righe: string[] = [];
      const passaggi: string[] = [];
      const surfaces = connectSurfaces(
        runtime,
        home,
        new ModelLane(),
        () => {},
        undefined,
        (l) => righe.push(l),
        surfaceStandDown(runtime.db, (l) => passaggi.push(l), true),
      );
      try {
        // Largo: sul codice pre-fix il primo `getUpdates` arriva subito dopo il
        // `getMe`, cioe' entro qualche decina di millisecondi.
        await attendi(600);
      } finally {
        surfaces.stop();
      }

      expect(bot.getUpdates).toBe(0);
      expect(righe.filter((l) => l.includes('409'))).toEqual([]);
      // Una riga d'avvio, che nomina chi ha la bocca — non un battito.
      expect(surfaces.lines).toContain(`telegram: la riceve il gateway (pid ${String(process.pid)}) — questa finestra manda soltanto`);
      // Niente da annunciare: lo stato all'avvio e' gia' quello della riga.
      expect(passaggi).toEqual([]);
    } finally {
      await bot.close();
      await provider.close();
    }
  }, 30_000);

  it('è un cancello e non un muro: senza gateway la stessa chiamata riceve', async () => {
    const provider = await startFakeProvider({ main: [{ text: 'irrilevante' }] });
    const bot = await fintoBotApi();
    const home = casa(bot.baseUrl, provider.baseUrl);
    try {
      const runtime = buildRuntime(home, home);
      // Nessuna claim: il lucchetto non e' mai stato preso su questa home.
      const surfaces = connectSurfaces(
        runtime,
        home,
        new ModelLane(),
        () => {},
        undefined,
        () => {},
        surfaceStandDown(runtime.db, () => {}, false),
      );
      try {
        for (let i = 0; i < 300 && bot.getUpdates === 0; i++) await attendi(10);
      } finally {
        surfaces.stop();
      }
      expect(bot.getUpdates).toBeGreaterThan(0);
      expect(surfaces.lines).toContain('telegram: connessa (owner 7)');
    } finally {
      await bot.close();
      await provider.close();
    }
  }, 30_000);

  it('mentre il gateway riceve, questa finestra manda ancora: consegna e approvazione', async () => {
    const provider = await startFakeProvider({ main: [{ text: 'irrilevante' }] });
    const bot = await fintoBotApi();
    const home = casa(bot.baseUrl, provider.baseUrl);
    try {
      const runtime = buildRuntime(home, home);
      new GatewayLock(runtime.db).claim(new Date(), 'test', process.pid);
      const surfaces = connectSurfaces(
        runtime,
        home,
        new ModelLane(),
        () => {},
        undefined,
        () => {},
        surfaceStandDown(runtime.db, () => {}, true),
      );
      try {
        // La stessa `deliver` che usano lo scheduler e `send_file`.
        const esito = await surfaces.registry.deliver('telegram', 'consegna con il gateway vivo');
        expect(esito.delivered).toBe(true);
        expect(bot.inviati).toContain('consegna con il gateway vivo');
        // E i pulsanti di approvazione: l'instradatore resta registrato anche
        // per chi non riceve, o un turno del REPL non potrebbe chiedere niente.
        expect(runtime.approvers.has('telegram')).toBe(true);
        // Mandare non contende: nessun 409 e nessun update chiesto.
        expect(bot.getUpdates).toBe(0);
      } finally {
        surfaces.stop();
      }
    } finally {
      await bot.close();
      await provider.close();
    }
  }, 30_000);
});
