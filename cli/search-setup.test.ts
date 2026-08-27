import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { cmdSearch } from './search-setup.js';
import { loadConfig, paths, saveConfig } from '../core/config/config.js';
import { SEARCH_PROVIDERS } from '../core/config/providers.js';

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'muffin-search-'));
  runInit({ home: h, provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-fake' });
  return h;
}

const raccogli = (): { out: string[]; sink: (l: string) => void } => {
  const out: string[] = [];
  return { out, sink: (l) => void out.push(l) };
};

describe('muffin search', () => {
  it('senza argomenti dice che è spenta e quali motori ci sono', () => {
    const { out, sink } = raccogli();
    expect(cmdSearch(home(), [], { out: sink })).toBe(0);
    expect(out.join('\n')).toContain('spenta');
    expect(out.join('\n')).toContain('tavily');
  });

  /**
   * Una chiave in un argomento di shell è una chiave nella history e in ogni
   * `ps` della macchina — la stessa ragione per cui `muffin secret set` legge
   * stdin da sempre. Senza chiave non si chiede: si stampa la pipe esatta.
   */
  it('senza chiave in pipe non scrive niente, e stampa la riga da eseguire', () => {
    const h = home();
    const { out, sink } = raccogli();
    const code = cmdSearch(h, ['tavily'], { out: sink, readKey: () => '' });
    expect(code).toBe(78);
    expect(loadConfig(h).search).toBeUndefined();
    expect(out.join('\n')).toContain('| muffin search tavily');
    expect(out.join('\n')).toContain(SEARCH_PROVIDERS.tavily.keysUrl);
  });

  it('con la chiave in pipe scrive il segreto e la config, e non stampa la chiave', () => {
    const h = home();
    const { out, sink } = raccogli();
    const code = cmdSearch(h, ['tavily'], { out: sink, readKey: () => 'tvly-segretissima\n' });
    expect(code).toBe(0);
    const c = loadConfig(h);
    expect(c.search?.provider).toBe('tavily');
    // In config va il riferimento, mai il valore.
    expect(c.search?.apiKeyRef).toBe('secret://tavily_api_key');
    expect(readFileSync(paths(h).config, 'utf8')).not.toContain('tvly-segretissima');
    expect(out.join('\n')).not.toContain('tvly-segretissima');
    expect(out.join('\n')).toContain('17 caratteri');
  });

  it('poi lo stato dice che è accesa e dove sta la chiave', () => {
    const h = home();
    cmdSearch(h, ['tavily'], { out: () => {}, readKey: () => 'tvly-x' });
    const { out, sink } = raccogli();
    cmdSearch(h, [], { out: sink });
    expect(out.join('\n')).toContain('Tavily');
    expect(out.join('\n')).toContain('chiave trovata in');
  });

  /**
   * Spegnere la ricerca non è ruotare una chiave: cancellarne una per effetto
   * collaterale è il tipo di cosa che si scopre il giorno che serviva.
   */
  it('`off` toglie la config e lascia il segreto dov era', () => {
    const h = home();
    cmdSearch(h, ['tavily'], { out: () => {}, readKey: () => 'tvly-x' });
    const { out, sink } = raccogli();
    expect(cmdSearch(h, ['off'], { out: sink })).toBe(0);
    expect(loadConfig(h).search).toBeUndefined();
    expect(out.join('\n')).toContain("resta dov'era");
  });

  it('un motore che non esiste non scrive niente e li elenca', () => {
    const h = home();
    const { out, sink } = raccogli();
    expect(cmdSearch(h, ['googolone'], { out: sink })).toBe(2);
    expect(loadConfig(h).search).toBeUndefined();
    expect(out.join('\n')).toContain('tavily');
  });

  /**
   * Lo stato in cui il runtime si degrada in silenzio con un `! web_search
   * spento` che non dice perché: la config c'è e il segreto no.
   */
  it('una apiKeyRef che punta al nulla viene detta, invece di degradare in silenzio', () => {
    const h = home();
    cmdSearch(h, ['tavily'], { out: () => {}, readKey: () => 'tvly-x' });
    // La config resta, il segreto sparisce: si simula riscrivendo il riferimento.
    const c = loadConfig(h);
    saveConfig({ ...c, search: { provider: 'tavily', apiKeyRef: 'secret://mai_scritto' } }, h);
    const { out, sink } = raccogli();
    cmdSearch(h, [], { out: sink });
    expect(out.join('\n')).toContain('quel segreto non esiste');
  });
});
