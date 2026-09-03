import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { cmdMcpAdd } from './mcp.js';
import { cmdSearch } from './search-setup.js';
import { paths } from '../core/config/config.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'mcp', 'fixtures', 'echo-server.mjs');

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'muffin-egress-symmetry-'));
  runInit({ home: h, provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-fake' });
  return h;
}

function egressAllow(h: string): string[] {
  return JSON.parse(readFileSync(join(paths(h).rot, 'egress.json'), 'utf8')).allow;
}

/**
 * «Un meccanismo, due porte» (memoria owner) è la ragione per cui
 * `widenEgressForCapability` è una funzione sola — ma una funzione condivisa
 * non basta da sola a garantire un comportamento uguale: ognuna delle due
 * porte decide da sé cosa fare del risultato che quella funzione restituisce,
 * ed è lì che potevano tornare a divergere (il primo giro di questa stessa
 * revisione lo ha fatto: `mcp add` è uscito 1 sul fallimento del widen,
 * `search` è restato a 0). Questo file prova la simmetria stessa — non che
 * ciascuna porta sia corretta per conto suo (già provato in `mcp.test.ts` e
 * `search-setup.test.ts`), ma che le due, davanti allo *stesso* fallimento,
 * concordino sull'exit code — l'unica asserzione che, se una delle due
 * regredisse da sola, lo direbbe.
 */
describe('mcp add --host e search: la stessa mancata accensione di rete esce con lo stesso codice da entrambe le porte', () => {
  it('senza terminale (nessun chiediConferma): entrambe registrano/scrivono la config ma escono 1', async () => {
    const hMcp = home();
    const hSearch = home();

    const codeMcp = await cmdMcpAdd(hMcp, 'echo', process.execPath, [FIXTURE], {}, ['a.example'], {
      out: () => {},
    });
    const codeSearch = await cmdSearch(hSearch, ['tavily'], {
      out: () => {},
      readKey: () => 'tvly-x',
    });

    expect(codeMcp).toBe(codeSearch);
    expect(codeMcp).toBe(1);
    // Nessuna delle due ha allargato l'egress — la ragione per cui l'exit
    // code non può essere 0 in nessuna delle due.
    expect(egressAllow(hMcp)).toEqual([]);
    expect(egressAllow(hSearch)).toEqual([]);
  });

  it('l owner dice esplicitamente no: entrambe restano scritte (config/registro) ma escono 1', async () => {
    const hMcp = home();
    const hSearch = home();

    const codeMcp = await cmdMcpAdd(hMcp, 'echo', process.execPath, [FIXTURE], {}, ['a.example'], {
      out: () => {},
      chiediConferma: () => Promise.resolve('no'),
    });
    const codeSearch = await cmdSearch(hSearch, ['tavily'], {
      out: () => {},
      readKey: () => 'tvly-x',
      chiediConferma: () => Promise.resolve('no'),
    });

    expect(codeMcp).toBe(codeSearch);
    expect(codeMcp).toBe(1);
    expect(egressAllow(hMcp)).toEqual([]);
    expect(egressAllow(hSearch)).toEqual([]);
  });

  it('con conferma esplicita: entrambe allargano l egress ed escono 0 — la simmetria vale anche sul successo', async () => {
    const hMcp = home();
    const hSearch = home();

    const codeMcp = await cmdMcpAdd(hMcp, 'echo', process.execPath, [FIXTURE], {}, ['a.example'], {
      out: () => {},
      chiediConferma: () => Promise.resolve('s'),
    });
    const codeSearch = await cmdSearch(hSearch, ['tavily'], {
      out: () => {},
      readKey: () => 'tvly-x',
      chiediConferma: () => Promise.resolve('s'),
    });

    expect(codeMcp).toBe(codeSearch);
    expect(codeMcp).toBe(0);
    expect(egressAllow(hMcp)).toEqual(['a.example']);
    expect(egressAllow(hSearch)).toEqual(['api.tavily.com']);
  });
});
