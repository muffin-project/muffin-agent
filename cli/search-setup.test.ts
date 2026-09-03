import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { cmdSearch } from './search-setup.js';
import { loadConfig, paths, saveConfig } from '../core/config/config.js';
import { SEARCH_PROVIDERS } from '../core/config/providers.js';
import { verify } from '../core/rot/verify.js';

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
  it('senza argomenti dice che è spenta e quali motori ci sono', async () => {
    const { out, sink } = raccogli();
    expect(await cmdSearch(home(), [], { out: sink })).toBe(0);
    expect(out.join('\n')).toContain('spenta');
    expect(out.join('\n')).toContain('tavily');
  });

  /**
   * Una chiave in un argomento di shell è una chiave nella history e in ogni
   * `ps` della macchina — la stessa ragione per cui `muffin secret set` legge
   * stdin da sempre. Fino al 03/09/2026 il rimedio stampato qui era
   * `echo -n "LA_CHIAVE" | muffin search tavily`, cioè proprio quella forma:
   * il comando che rifiuta argv la suggeriva a parole. L'owner l'ha nominato.
   */
  it('senza terminale e senza pipe, nessuna riga stampata mette il segreto sulla riga di comando', async () => {
    const h = home();
    const { out, sink } = raccogli();
    const code = await cmdSearch(h, ['tavily'], { out: sink, readKey: () => '' });
    expect(code).toBe(78);
    expect(loadConfig(h).search).toBeUndefined();
    const stampato = out.join('\n');
    expect(stampato).toContain(SEARCH_PROVIDERS.tavily.keysUrl);

    // La forma vietata, e il letterale che la accompagnava.
    expect(stampato).not.toMatch(/\becho\b/);
    expect(stampato).not.toContain('LA_CHIAVE');
    // E la regola generale, non solo i due casi noti: in una riga di comando
    // stampata (rientrata di due spazi) non ci può stare un valore virgolettato
    // — è la forma che finisce nella history e in `ps`.
    const comandi = out.filter((l) => l.startsWith('  ') && l.includes('muffin'));
    expect(comandi.length).toBeGreaterThan(0);
    for (const riga of comandi) expect(riga).not.toMatch(/["']/);
    // Quello che offre al posto suo: una redirezione da file, o una pipe da chi
    // il segreto ce l'ha già.
    expect(stampato).toContain('muffin search tavily < ');
    expect(stampato).toContain('| muffin search tavily');
  });

  /**
   * Il caso dell'owner: un terminale. La chiave si chiede lì, senza eco, con lo
   * stesso `promptSecret` di `muffin init` — quindi non passa da nessuna riga
   * di comando e non c'è più niente da suggerire.
   */
  it('su un terminale la chiede, e la scrive senza che sia mai passata da argv', async () => {
    const h = home();
    const { out, sink } = raccogli();
    const code = await cmdSearch(h, ['tavily'], {
      out: sink,
      readKey: () => '',
      chiediChiave: () => Promise.resolve('tvly-dal-terminale'),
    });
    expect(code).toBe(0);
    expect(loadConfig(h).search?.apiKeyRef).toBe('secret://tavily_api_key');
    expect(out.join('\n')).not.toContain('tvly-dal-terminale');
    // Non stampa nessun rimedio: non c'è niente da rimediare.
    expect(out.join('\n')).not.toContain('muffin search tavily <');
  });

  it('la pipe vince sul terminale: uno script non si trova una domanda', async () => {
    const h = home();
    let chiesto = 0;
    const code = await cmdSearch(h, ['tavily'], {
      out: () => {},
      readKey: () => 'tvly-dalla-pipe',
      chiediChiave: () => {
        chiesto += 1;
        return Promise.resolve('tvly-dal-terminale');
      },
    });
    expect(code).toBe(0);
    expect(chiesto).toBe(0);
  });

  it('con la chiave in pipe scrive il segreto e la config, e non stampa la chiave', async () => {
    const h = home();
    const { out, sink } = raccogli();
    const code = await cmdSearch(h, ['tavily'], { out: sink, readKey: () => 'tvly-segretissima\n' });
    expect(code).toBe(0);
    const c = loadConfig(h);
    expect(c.search?.provider).toBe('tavily');
    // In config va il riferimento, mai il valore.
    expect(c.search?.apiKeyRef).toBe('secret://tavily_api_key');
    expect(readFileSync(paths(h).config, 'utf8')).not.toContain('tvly-segretissima');
    expect(out.join('\n')).not.toContain('tvly-segretissima');
    expect(out.join('\n')).toContain('17 caratteri');
  });

  it('poi lo stato dice che è accesa e dove sta la chiave', async () => {
    const h = home();
    await cmdSearch(h, ['tavily'], { out: () => {}, readKey: () => 'tvly-x' });
    const { out, sink } = raccogli();
    await cmdSearch(h, [], { out: sink });
    expect(out.join('\n')).toContain('Tavily');
    expect(out.join('\n')).toContain('chiave trovata in');
  });

  /**
   * Spegnere la ricerca non è ruotare una chiave: cancellarne una per effetto
   * collaterale è il tipo di cosa che si scopre il giorno che serviva.
   */
  it('`off` toglie la config e lascia il segreto dov era', async () => {
    const h = home();
    await cmdSearch(h, ['tavily'], { out: () => {}, readKey: () => 'tvly-x' });
    const { out, sink } = raccogli();
    expect(await cmdSearch(h, ['off'], { out: sink })).toBe(0);
    expect(loadConfig(h).search).toBeUndefined();
    expect(out.join('\n')).toContain("resta dov'era");
  });

  it('un motore che non esiste non scrive niente e li elenca', async () => {
    const h = home();
    const { out, sink } = raccogli();
    expect(await cmdSearch(h, ['googolone'], { out: sink })).toBe(2);
    expect(loadConfig(h).search).toBeUndefined();
    expect(out.join('\n')).toContain('tavily');
  });

  /**
   * Lo stato in cui il runtime si degrada in silenzio con un `! web_search
   * spento` che non dice perché: la config c'è e il segreto no.
   */
  it('una apiKeyRef che punta al nulla viene detta, invece di degradare in silenzio', async () => {
    const h = home();
    await cmdSearch(h, ['tavily'], { out: () => {}, readKey: () => 'tvly-x' });
    // La config resta, il segreto sparisce: si simula riscrivendo il riferimento.
    const c = loadConfig(h);
    saveConfig({ ...c, search: { provider: 'tavily', apiKeyRef: 'secret://mai_scritto' } }, h);
    const { out, sink } = raccogli();
    await cmdSearch(h, [], { out: sink });
    expect(out.join('\n')).toContain('quel segreto non esiste');
  });

  /**
   * Il caso esatto dell'owner (ADR-0058): chiave giusta, config giusta, e fino
   * a qui `api.tavily.com` restava fuori da `rot/egress.json` — scoperto solo
   * al boot del runtime, con un `! web_search spento` che non si legge nel
   * momento in cui conta. Da un terminale vero, ora, un solo comando basta:
   * la chiave si scrive, l'host si aggiunge, il root of trust si risigilla —
   * e resta integro, non degradato in modalità sicura.
   */
  it('caso owner: su un terminale vero, un comando solo accende la chiave e apre la porta di rete', async () => {
    const h = home();
    const domande: string[] = [];
    const code = await cmdSearch(h, ['tavily'], {
      out: () => {},
      readKey: () => '',
      chiediChiave: () => Promise.resolve('tvly-dal-terminale'),
      chiediConferma: (d) => {
        domande.push(d);
        return Promise.resolve('s');
      },
    });
    expect(code).toBe(0);
    expect(domande).toHaveLength(1);
    expect(domande[0]).toContain('api.tavily.com');

    const egress = JSON.parse(readFileSync(join(paths(h).rot, 'egress.json'), 'utf8'));
    expect(egress.allow).toContain('api.tavily.com');

    // Il seal è valido, non l'installazione degradata in modalità sicura.
    const stato = verify(h, 'single-user');
    expect(stato.ok).toBe(true);
  });

  it('senza terminale (nessun chiediConferma): la config resta scritta, l egress no, e dice come rimediare a mano', async () => {
    const h = home();
    const { out, sink } = raccogli();
    const code = await cmdSearch(h, ['tavily'], { out: sink, readKey: () => 'tvly-x' });
    expect(code).toBe(0);
    expect(loadConfig(h).search?.provider).toBe('tavily');
    const egress = JSON.parse(readFileSync(join(paths(h).rot, 'egress.json'), 'utf8'));
    expect(egress.allow).toEqual([]);
    expect(out.join('\n')).toContain('nessun terminale interattivo');
    expect(out.join('\n')).toContain('muffin rot reseal');
  });

  it('l owner dice no alla domanda: niente allargato, la config resta', async () => {
    const h = home();
    const code = await cmdSearch(h, ['tavily'], {
      out: () => {},
      readKey: () => 'tvly-x',
      chiediConferma: () => Promise.resolve('no'),
    });
    expect(code).toBe(0);
    expect(loadConfig(h).search?.provider).toBe('tavily');
    const egress = JSON.parse(readFileSync(join(paths(h).rot, 'egress.json'), 'utf8'));
    expect(egress.allow).toEqual([]);
  });
});
