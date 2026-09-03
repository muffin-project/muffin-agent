import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from './init.js';
import { connectSurfaces, rigaDiLog } from './surface.js';
import { buildRuntime } from '../agent/runtime.js';
import { loadConfig, saveConfig, writeSecret } from '../core/config/config.js';
import { startFakeProvider } from '../evals/acceptance/provider.js';

/**
 * Dove finiscono le righe di un connettore — provato fino al connettore, non
 * fino al parametro.
 *
 * `connectSurfaces` prende un sink dal 03/09/2026 perché in un REPL una riga
 * di log va scritta passando dal togli/scrivi/rimetti della casella
 * (`cli/repl.ts`, `makeReplLog`); qui si controlla la metà che nessuno
 * guarderebbe: che quel parametro arrivi davvero dentro `ConnectorDeps.log`,
 * cioè che una riga che il connettore vero emette esca da lì e non da stderr.
 * Un parametro accettato e non passato è esattamente la forma di guasto che
 * `AGENTS.md` chiama «il meccanismo esiste, la produzione non ci passa».
 */

/** Un Bot API finto: risponde a `getMe`, e a tutto il resto con una lista vuota. */
function fintoBotApi(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const url = req.url ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.endsWith('/getMe')) {
        res.end(JSON.stringify({ ok: true, result: { id: 42, is_bot: true, username: 'MuffinAgentTestBot' } }));
        return;
      }
      res.end(JSON.stringify({ ok: true, result: [] }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('il sink di log di `connectSurfaces` arriva fino al connettore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('la riga «telegram: connesso come @…» esce dal sink del chiamante, non da stderr', async () => {
    const provider = await startFakeProvider({ main: [{ text: 'irrilevante' }] });
    const bot = await fintoBotApi();
    const home = mkdtempSync(join(tmpdir(), 'muffin-log-superfici-'));
    try {
      runInit({ home, provider: 'openai-compat', baseUrl: provider.baseUrl, apiKey: 'sk-log-fake' });
      writeSecret('telegram_token', '000:finto', home, 'home');
      const config = loadConfig(home);
      saveConfig(
        {
          ...config,
          surfaces: {
            ...config.surfaces,
            enabled: [...config.surfaces.enabled.filter((s) => s !== 'telegram'), 'telegram'],
            telegram: { ownerUserId: 7, ownerChatId: 7, apiBase: bot.baseUrl },
          },
        },
        home,
      );

      const runtime = buildRuntime(home, home);
      const righe: string[] = [];
      const err: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });
      const surfaces = connectSurfaces(runtime, home, () => {}, undefined, (l) => righe.push(l));
      try {
        // La riga arriva dopo un `getMe` vero contro il finto server: si aspetta
        // che compaia, non un tempo fisso.
        for (let i = 0; i < 200 && !righe.some((l) => l.startsWith('telegram: connesso come')); i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        surfaces.stop();
      }

      expect(righe.some((l) => l === 'telegram: connesso come @MuffinAgentTestBot')).toBe(true);
      // E non su stderr: se il sink non fosse cablato, la riga uscirebbe di lì
      // — che è il modo esatto in cui rompeva la casella.
      expect(err.join('')).not.toContain('telegram: connesso come');
    } finally {
      await bot.close();
      await provider.close();
    }
  }, 20_000);

  it('senza sink resta `rigaDiLog`: una riga sola, datata, su stderr e senza sequenze di escape', () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    rigaDiLog('telegram: 409, un altro getUpdates è attivo — attendo');
    // `\r` e l'a capo sono ciò che `gateway.err` ha sempre avuto; niente `ESC`.
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(
      /^\r\d{4}-\d{2}-\d{2}T[\d:.]+Z telegram: 409, un altro getUpdates è attivo — attendo\n$/,
    );
    expect(err[0]).not.toContain('\x1b');
  });
});
