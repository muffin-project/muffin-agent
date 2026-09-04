import DatabaseCtor from 'better-sqlite3';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { paths, loadConfig, saveConfig, writeSecret } from '../core/config/config.js';
import { runInit } from './init.js';
import { cmdGatewayRun } from './gateway.js';

/**
 * The owner's real failure, reproduced end to end.
 *
 * `~/.muffin/gateway.err`, 2026-09-03, three consecutive lines:
 *
 *     gateway: SIGTERM — drenaggio, nessun turno nuovo (fino a 60s; …)
 *     telegram: update 99665860 fallito — The database connection is not open
 *     telegram: polling fallito (The database connection is not open)
 *
 * The mechanism: `cli/gateway.ts`'s `close` used to call `stopSurfaces?.()`
 * — synchronous, fire-and-forget — and then `runtime.close()` on the very
 * next line. A `getUpdates` long poll already in flight (or the `Pausa`
 * check `controlla()` runs against `runtime.db` for every ordinary message)
 * had no way to finish, or even be told to stop, before the database under
 * it closed.
 *
 * This test drives the real production path — `cmdGatewayRun`, the same
 * function `muffin gateway run` calls — against a fake Telegram Bot API that
 * holds `getUpdates` open until told to answer, so the test controls exactly
 * when the "network" finally delivers the message relative to the SIGTERM.
 */

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

/** Just enough of the Chat Completions shape to answer — no token spent, no network beyond localhost. */
function fakeCompletionsServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'fake-1',
            model: 'fake',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'fatto.' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port assigned');
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/**
 * A Bot API whose `/getUpdates` never answers on its own — the long poll the
 * owner's connector was sitting in. `rilasciaConMessaggio` is the delayed
 * network response arriving late, exactly the race in the log lines above:
 * the test decides whether it lands before or after the process has already
 * decided to leave.
 */
function fintoBotApiInVolo(): Promise<{
  baseUrl: string;
  attesaGetUpdates: Promise<void>;
  rilasciaConMessaggio: (update: Record<string, unknown>) => void;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    let segnalaArrivo: (() => void) | null = null;
    const attesaGetUpdates = new Promise<void>((r) => {
      segnalaArrivo = r;
    });
    let pendingRes: ServerResponse | null = null;
    const server: Server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url.endsWith('/getMe')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { id: 42, is_bot: true, username: 'MuffinDrainTestBot' } }));
        return;
      }
      if (url.endsWith('/getUpdates')) {
        pendingRes = res;
        segnalaArrivo?.();
        segnalaArrivo = null;
        req.on('aborted', () => {
          // Il client (il connettore, dopo `stop()`) ha chiuso la connessione:
          // esattamente l'esito atteso col fix, niente da rispondere più.
          pendingRes = null;
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: [] }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        attesaGetUpdates,
        rilasciaConMessaggio: (update) => {
          if (pendingRes === null) return; // già abortita lato client — niente da consegnare
          try {
            pendingRes.writeHead(200, { 'content-type': 'application/json' });
            pendingRes.end(JSON.stringify({ ok: true, result: [update] }));
          } catch {
            // La connessione può essere già morta: non è un fallimento del test.
          }
          pendingRes = null;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-drenaggio-'));
  homes.push(dir);
  return dir;
}

describe('il drenaggio aspetta la superficie prima di chiudere il database', () => {
  it(
    'un messaggio Telegram in volo al SIGTERM non deve mai scrivere dopo che il database è chiuso',
    async () => {
      const provider = await fakeCompletionsServer();
      const bot = await fintoBotApiInVolo();
      const dir = home();
      try {
        runInit({ home: dir, provider: 'openai-compat', baseUrl: provider.url, apiKey: 'sk-drenaggio-fake' });
        writeSecret('telegram_token', '000:finto', dir, 'home');
        const config = loadConfig(dir);
        saveConfig(
          {
            ...config,
            surfaces: {
              ...config.surfaces,
              enabled: [...config.surfaces.enabled.filter((s) => s !== 'telegram'), 'telegram'],
              telegram: { ownerUserId: 999001, ownerChatId: 999001, apiBase: bot.baseUrl },
            },
          },
          dir,
        );

        const signals = new EventEmitter();
        const righe: string[] = [];
        const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
          righe.push(String(chunk));
          return true;
        });
        try {
          const done = cmdGatewayRun(dir, {
            signals,
            tickMs: 5,
            sleep: () => new Promise((r) => setTimeout(r, 1)),
            drainBudgetMs: 3000,
          });

          // Il long poll è davvero in volo, non solo «dovrebbe esserlo».
          await bot.attesaGetUpdates;

          signals.emit('SIGTERM');
          // `done` è la stessa promise che `gateway.serve()` risolve: risolta
          // solo dopo `close()`, cioè dopo che `stopSurfaces` è stata aspettata
          // e `runtime.close()` è già girato.
          await done;

          // Solo ORA arriva la risposta di rete — la stessa corsa dell'owner:
          // il messaggio che era in volo torna dopo che il processo ha già
          // deciso di uscire. Con il fix il client ha già abortito la
          // richiesta (vedi `req.on('aborted')` sopra) e questa non consegna
          // niente; senza il fix la connessione era ancora viva e il
          // connettore la elabora contro un database già chiuso.
          bot.rilasciaConMessaggio({
            update_id: 1,
            message: {
              message_id: 1,
              date: 0,
              chat: { id: 999001, type: 'private' },
              from: { id: 999001, is_bot: false, first_name: 'o' },
              text: 'ciao',
            },
          });
          // Tempo di elaborare, se per assurdo l'ha ricevuto.
          await new Promise((r) => setTimeout(r, 300));
        } finally {
          errSpy.mockRestore();
        }

        const testo = righe.join('');
        // La riga esatta trovata su `~/.muffin/gateway.err` — un errore
        // interno, mai indirizzato all'owner.
        expect(testo).not.toContain('The database connection is not open');
      } finally {
        await bot.close();
        await provider.close();
      }
    },
    20_000,
  );
});
