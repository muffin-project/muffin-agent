import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { connectSurfaces, INGRESS_PORT_IDS } from './surface.js';
import { buildRuntime } from '../agent/runtime.js';
import { loadConfig, saveConfig, writeSecret } from '../core/config/config.js';

/**
 * §4 invariant 1, the **reading** half: a turn suspended on Telegram still
 * finds its port after a restart.
 *
 * The falsifier the design names is precise: "un turno sospeso
 * sull'installazione viva non trova più la sua porta dopo la fetta 14:
 * `doors.get(turn.surface)` fallisce in silenzio (`NO_SURFACE` lancia solo
 * dentro la corsia) e `approve` risponde `unavailable`". So this is not a test
 * of a string; it drives the real assembly — `buildRuntime`, `connectSurfaces`,
 * a real `TelegramConnector` pointed at a fake Bot API — hands it a row that
 * says `surface: 'telegram'` and nothing else, and asserts the **bytes reach
 * the fake Telegram**. A key that drifted would leave `inviati` empty.
 *
 * The second describe is the §5 falsifier for the port table: `INGRESS_PORT_IDS`
 * must not be a hand-written list living beside a pile of `if (id === '…')`.
 * It is asserted by reading this module's own source and requiring every
 * surface id it compares against to be a registered port.
 */

type FintoBot = { baseUrl: string; close: () => Promise<void>; readonly inviati: string[] };

function fintoBotApi(): Promise<FintoBot> {
  const inviati: string[] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const url = req.url ?? '';
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (url.endsWith('/getMe')) {
          res.end(JSON.stringify({ ok: true, result: { id: 42, is_bot: true, username: 'MuffinPorta' } }));
          return;
        }
        if (url.includes('/sendMessage')) {
          try {
            inviati.push(String((JSON.parse(body) as { text?: unknown }).text ?? ''));
          } catch {
            inviati.push(body);
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
        get inviati() {
          return inviati;
        },
      });
    });
  });
}

function casa(baseUrl: string): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-porta-'));
  runInit({ home, apiKey: 'sk-porta-mai-usata' });
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

describe('un turno sospeso ritrova la sua porta attraverso l assemblaggio', () => {
  it("la riga dice solo `surface: 'telegram'`, e la risposta esce davvero su Telegram", async () => {
    const bot = await fintoBotApi();
    const home = casa(bot.baseUrl);
    try {
      const runtime = buildRuntime(home, home);
      const surfaces = connectSurfaces(
        runtime,
        home,
        () => {},
        undefined,
        () => {},
        // Il gateway serve già le superfici: nessun poller parte, e questa
        // scena prova la **bocca**, non l'orecchio — che è esattamente la metà
        // di `connectSurfaces` che l'invariante 1 riguarda.
        () => ({ pid: 4242 }),
      );
      try {
        // La riga che la corsia trova dopo un riavvio. Il solo campo che dice
        // dove va la risposta è `surface`, e il solo indirizzo è `replyTo` —
        // esattamente ciò che è sul disco dell'owner adesso.
        await surfaces.deliver(
          {
            id: 'turno-sospeso',
            surface: 'telegram',
            replyTo: { chatId: 7, messageId: 10, channel: 'telegram:7' },
          } as never,
          'la risposta arrivata dopo',
        );
        expect(bot.inviati).toEqual(['la risposta arrivata dopo']);
      } finally {
        await surfaces.stop();
      }
    } finally {
      await bot.close();
    }
  });

  it('una superficie che non è venuta su è `undeliverable`, non un invio a nessuno', async () => {
    const bot = await fintoBotApi();
    const home = casa(bot.baseUrl);
    try {
      const runtime = buildRuntime(home, home);
      const surfaces = connectSurfaces(runtime, home, () => {}, undefined, () => {}, () => ({ pid: 4242 }));
      try {
        await expect(
          surfaces.deliver({ id: 'x', surface: 'una-porta-che-non-esiste', replyTo: {} } as never, 'testo'),
        ).rejects.toThrow();
        expect(bot.inviati).toEqual([]);
      } finally {
        await surfaces.stop();
      }
    } finally {
      await bot.close();
    }
  });
});

describe('nessuna lista di id scritta a mano accanto agli `if` (§5)', () => {
  it('gli id registrati sono derivati dalla tabella, non enumerati', () => {
    expect([...INGRESS_PORT_IDS].sort()).toEqual(['discord', 'telegram']);
  });

  it('ogni id di superficie confrontato dentro `cli/surface.ts` è una porta registrata', () => {
    const src = readFileSync(new URL('./surface.ts', import.meta.url), 'utf8')
      // I commenti raccontano la storia e nominano le porte: si tolgono, o il
      // controllo diventerebbe una lettura della prosa invece che del codice.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // Le tre forme con cui una superficie viene nominata a mano qui dentro —
    // esattamente quelle che i due `if` cancellati da questa fetta usavano.
    const nominati = [
      ...src.matchAll(/\bid\s*[!=]==\s*'([a-z][a-z0-9-]*)'/g),
      ...src.matchAll(/\.surface\s*[!=]==\s*'([a-z][a-z0-9-]*)'/g),
      ...src.matchAll(/enabled\.includes\('([a-z][a-z0-9-]*)'\)/g),
    ].map((m) => m[1] as string);
    // `cli` è l'eccezione dichiarata: è sempre abilitata e non è una porta
    // d'ingresso (L0-1, la superficie di ultima istanza).
    const sconosciute = [...new Set(nominati)].filter((id) => id !== 'cli' && !INGRESS_PORT_IDS.includes(id));
    // Il difetto che questo chiude (§5): una terza porta aggiunta con un terzo
    // `if` e mai registrata — `doors`/`streams`/`approvers` non la avrebbero, e
    // niente sarebbe diventato rosso.
    expect(sconosciute).toEqual([]);
  });

  it('e le superfici note sono `cli` più le porte registrate, in quell ordine', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-porta-list-'));
    runInit({ home, apiKey: 'sk-porta-list' });
    const scritte: string[] = [];
    const originale = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      scritte.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const { cmdSurfaceList } = await import('./surface.js');
      cmdSurfaceList(home);
    } finally {
      process.stdout.write = originale;
    }
    const righe = scritte.join('').split('\n').filter((l) => l.startsWith('●') || l.startsWith('○'));
    expect(righe.map((l) => l.slice(2).trim().split(' ')[0])).toEqual(['cli', ...INGRESS_PORT_IDS]);
  });
});
