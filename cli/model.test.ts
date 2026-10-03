import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { cmdModel, fetchCatalogue, fetchEndpointTags, priceNote } from './model.js';
import { loadConfig, saveConfig } from '../core/config/config.js';
import { PROVIDERS, providerFor } from '../core/config/providers.js';

const OR = PROVIDERS.openrouter;

/** La forma verificata sul vivo il 2026-08-27: prezzi in USD **per token**, stringhe. */
const catalogo = (...m: [string, string, string][]): typeof globalThis.fetch =>
  (async () =>
    new Response(
      JSON.stringify({ data: m.map(([id, prompt, completion]) => ({ id, pricing: { prompt, completion } })) }),
      { status: 200 },
    )) as unknown as typeof globalThis.fetch;

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'muffin-model-'));
  runInit({ home: h, provider: 'openai-compat', baseUrl: OR.baseUrl, apiKey: 'sk-or-fake' });
  return h;
}

const raccogli = (): { out: string[]; sink: (l: string) => void } => {
  const out: string[] = [];
  return { out, sink: (l) => void out.push(l) };
};

describe('providerFor', () => {
  it("riconosce l'endpoint di OpenRouter", () => {
    expect(providerFor({ kind: 'openai-compat', baseUrl: OR.baseUrl })?.id).toBe('openrouter');
  });

  /** Per hostname e non per sottostringa: `openrouter.ai.evil.tld` contiene «openrouter» e non lo è. */
  it('non si fa ingannare da un hostname che contiene il nome', () => {
    expect(providerFor({ kind: 'openai-compat', baseUrl: 'https://openrouter.ai.evil.tld/api/v1' })).toBeNull();
  });

  it('un endpoint locale non è nel catalogo, e non è un errore', () => {
    expect(providerFor({ kind: 'openai-compat', baseUrl: 'http://127.0.0.1:11434/v1' })).toBeNull();
    expect(providerFor({ kind: 'anthropic' })).toBeNull();
  });
});

describe('fetchCatalogue', () => {
  it('converte i prezzi da per-token a per-MTok, che è l unità di pricing.ts', async () => {
    const [m] = await fetchCatalogue(OR, undefined, catalogo(['qwen/qwen3.8-27b', '0.000000425', '0.00000255']));
    expect(m!.inputPerMTok).toBeCloseTo(0.425, 6);
    expect(m!.outputPerMTok).toBeCloseTo(2.55, 6);
  });

  it('un prezzo illeggibile non diventa zero: il modello resta, il confronto lo salta', async () => {
    const [m] = await fetchCatalogue(OR, undefined, catalogo(['strano/modello', 'boh', 'boh']));
    expect(m!.id).toBe('strano/modello');
    expect(Number.isNaN(m!.inputPerMTok)).toBe(true);
    expect(priceNote(m!, OR.baseUrl)).toBeNull();
  });
});

/**
 * Il confronto che rende questo comando più di uno scrittore di JSON.
 *
 * `pricing.ts` fa match per sottostringa di famiglia. Fino al 2026-09-04
 * `qwen3` era in tabella a 0.1/0.3 per MTok, e il modello che l'installazione
 * dell'owner usava costava 0.425/2.55: una **sottostima** reale, cioè il tetto
 * in `rot/budgets.json` scattava tardi invece che presto — la direzione che
 * `pricing.ts` chiama pericolosa nella sua stessa intestazione. La stessa
 * ri-verifica che ha chiuso l'item 10 (`core/budget/pricing.ts`, tabella
 * `PRICES`) ha portato `qwen3` a 2/6 — il tetto della linea, non più il
 * pavimento — quindi il modello reale dell'owner non è più il fixture giusto
 * per provare che il meccanismo *nomina* una sottostima: è diventato l'esempio
 * di quella che questo comando ha appena chiuso (vedi il secondo `it` qui
 * sotto). Il primo resta sintetico, sopra il nuovo tetto di famiglia, per non
 * perdere la copertura del ramo che nomina.
 */
describe('priceNote', () => {
  it('nomina la sottostima, coi due prezzi', () => {
    // Sintetico: nessun host reale costa questo per qwen3 al 2026-09-04, ma è
    // sopra il tetto di famiglia (2/6) che la tabella corretta usa adesso, ed
    // è quello che serve per provare che il ramo "nomina" è ancora vivo dopo
    // la correzione dei prezzi.
    const nota = priceNote({ id: 'qwen/qwen3.9-ipotetico', inputPerMTok: 2.5, outputPerMTok: 7 }, OR.baseUrl);
    expect(nota).toContain('2.5');
    expect(nota).toContain('2'); // il prezzo fatturato dalla tabella corretta
    expect(nota).toContain('rot/budgets.json');
  });

  it('il qwen3.8-27b reale dell owner, sottostimato prima del 2026-09-04, ora tace: la tabella lo sovrastima', () => {
    // Stesso fixture che prima del fix nominava la sottostima (0.1/0.3 in
    // tabella contro 0.425/2.55 reali). Con la tabella corretta a 2/6 il
    // reale sta sotto il fatturato: silenzio, ed è il silenzio giusto.
    expect(
      priceNote({ id: 'qwen/qwen3.8-27b', inputPerMTok: 0.425, outputPerMTok: 2.55 }, OR.baseUrl),
    ).toBeNull();
  });

  it('tace sulla sovrastima: il tetto che scatta presto è la direzione sicura', () => {
    // claude-sonnet-5 costa 2/10 e la tabella lo fattura 3/15.
    expect(priceNote({ id: 'anthropic/claude-sonnet-5', inputPerMTok: 2, outputPerMTok: 10 }, OR.baseUrl)).toBeNull();
  });

  it('e su un modello locale, che non si fattura affatto', () => {
    expect(priceNote({ id: 'qwen3-embedding', inputPerMTok: 9, outputPerMTok: 9 }, 'http://127.0.0.1:11434')).toBeNull();
  });
});

describe('muffin model', () => {
  it('senza argomenti mostra le tre corsie e il provider, distinguendo un router dal modello servito', async () => {
    const h = home();
    expect(
      await cmdModel(h, ['openrouter/free'], { out: () => {}, fetchImpl: catalogo(['openrouter/free', '0', '0']) }),
    ).toBe(0);
    const { out, sink } = raccogli();
    expect(await cmdModel(h, [], { out: sink })).toBe(0);
    const testo = out.join('\n');
    expect(testo).toContain('OpenRouter');
    expect(testo).toMatch(/^main /m);
    expect(testo).toMatch(/^light /m);
    expect(testo).toMatch(/^embed /m);
    expect(testo).toContain('openrouter/free — fatturato $0/$0 per MTok');
    expect(testo).toContain('router gratuito (il modello servito può cambiare per richiesta)');
  });

  it('uno slug che esiste viene scritto, col prezzo vero accanto', async () => {
    const h = home();
    const { out, sink } = raccogli();
    const code = await cmdModel(h, ['anthropic/claude-sonnet-5'], {
      out: sink,
      fetchImpl: catalogo(['anthropic/claude-sonnet-5', '0.000002', '0.00001']),
    });
    expect(code).toBe(0);
    expect(loadConfig(h).models.main).toBe('anthropic/claude-sonnet-5');
    expect(out.join('\n')).toContain('$2');
  });

  /** Un refuso altrimenti si scopre al primo 404, cioè al primo turno dopo. */
  it('uno slug che non esiste non viene scritto, e il comando propone i vicini', async () => {
    const h = home();
    const prima = loadConfig(h).models.main;
    const { out, sink } = raccogli();
    const code = await cmdModel(h, ['anthropic/claude-sonnet-9'], {
      out: sink,
      fetchImpl: catalogo(['anthropic/claude-sonnet-5', '0.000002', '0.00001']),
    });
    expect(code).toBe(1);
    expect(loadConfig(h).models.main).toBe(prima);
    expect(out.join('\n')).toContain('claude-sonnet-5');
  });

  it('la corsia light si sceglie per nome, e main resta dov era', async () => {
    const h = home();
    const mainPrima = loadConfig(h).models.main;
    const { sink } = raccogli();
    await cmdModel(h, ['light', 'qwen/qwen3.7-flash'], {
      out: sink,
      fetchImpl: catalogo(['qwen/qwen3.7-flash', '0.00000003', '0.00000013']),
    });
    const c = loadConfig(h);
    expect(c.models.light).toBe('qwen/qwen3.7-flash');
    expect(c.models.main).toBe(mainPrima);
  });

  /**
   * Irraggiungibile non è inesistente: rifiutare qui bloccherebbe un owner
   * offline su una scelta perfettamente valida. Si scrive, e si dice.
   */
  it('col catalogo irraggiungibile scrive lo stesso, dicendo che non ha verificato', async () => {
    const h = home();
    const { out, sink } = raccogli();
    const code = await cmdModel(h, ['qualcosa/di-nuovo'], {
      out: sink,
      fetchImpl: (async () => {
        throw new Error('fetch failed');
      }) as unknown as typeof globalThis.fetch,
    });
    expect(code).toBe(0);
    expect(loadConfig(h).models.main).toBe('qualcosa/di-nuovo');
    expect(out.join('\n')).toContain('NON verificato');
  });

  /**
   * `dimensions` è l'unico campo dello schema che la sua stessa docstring
   * dichiara senza default sensato. Un comando che la chiede sposta
   * l'indovinello; una chiamata e un `vector.length` lo tolgono.
   */
  it("embed misura la dimensione chiamando l'embedder, invece di chiederla", async () => {
    const h = home();
    const { out, sink } = raccogli();
    const code = await cmdModel(h, ['embed', 'text-embedding-3-small'], {
      out: sink,
      probe: async () => 1536,
    });
    expect(code).toBe(0);
    const c = loadConfig(h);
    expect(c.embedder?.model).toBe('text-embedding-3-small');
    expect(c.embedder?.dimensions).toBe(1536);
    expect(out.join('\n')).toContain('1536');
  });

  it('un embedder che non risponde non viene scritto', async () => {
    const h = home();
    const { out, sink } = raccogli();
    const code = await cmdModel(h, ['embed', 'inventato'], {
      out: sink,
      probe: async () => {
        throw new Error('fetch failed');
      },
    });
    expect(code).toBe(1);
    expect(loadConfig(h).embedder?.model).not.toBe('inventato');
    expect(out.join('\n')).toContain('Niente scritto');
  });

  it('--list sfoglia, e il filtro restringe', async () => {
    const { out, sink } = raccogli();
    await cmdModel(home(), ['--list', 'qwen'], {
      out: sink,
      fetchImpl: catalogo(['qwen/qwen3.8-27b', '0.000000425', '0.00000255'], ['anthropic/claude-sonnet-5', '0.000002', '0.00001']),
    });
    expect(out.join('\n')).toContain('qwen/qwen3.8-27b');
    expect(out.join('\n')).not.toContain('claude-sonnet-5');
  });
});

/** Rete finta instradata per URL: catalogo su /models, tag su /models/:author/:slug/endpoints. */
const rete = (modelli: [string, string, string][], tag: string[] | 'throw'): typeof globalThis.fetch =>
  (async (url: unknown) => {
    if (String(url).includes('/endpoints')) {
      if (tag === 'throw') throw new Error('fetch failed');
      return new Response(JSON.stringify({ data: { endpoints: tag.map((t) => ({ tag: t, provider_name: t })) } }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({ data: modelli.map(([id, prompt, completion]) => ({ id, pricing: { prompt, completion } })) }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;

describe('fetchEndpointTags', () => {
  it('legge tag e nomi dai endpoint, minuscoli e senza doppioni', async () => {
    const tags = await fetchEndpointTags(OR, 'google/gemma-4-31b-it', undefined, rete([], ['Google', 'google', 'Alibaba']));
    expect(tags).toEqual(['google', 'alibaba']);
  });

  it('ignoto quando non si sa: offline, 401, forma diversa, slug senza autore', async () => {
    expect(await fetchEndpointTags(OR, 'google/gemma-4-31b-it', undefined, rete([], 'throw'))).toBeNull();
    const ko = (() => Promise.resolve(new Response('{}', { status: 401 }))) as unknown as typeof globalThis.fetch;
    expect(await fetchEndpointTags(OR, 'google/gemma-4-31b-it', undefined, ko)).toBeNull();
    expect(await fetchEndpointTags(OR, 'google/gemma-4-31b-it', undefined, catalogo(['x', '0', '0']))).toBeNull();
    expect(await fetchEndpointTags(OR, 'llama3', undefined, rete([], ['x']))).toBeNull();
  });
});

describe('muffin model rivalida il routing (issue #501)', () => {
  it('la regressione Qwen -> Gemma: il pin morto cade con rimedio, la policy resta', async () => {
    const h = home();
    const base = loadConfig(h);
    saveConfig(
      {
        ...base,
        models: { main: 'qwen/qwen3.8-27b', light: 'qwen/qwen3.8-flash' },
        provider: { ...base.provider, routing: { only: ['chutes'], dataCollection: 'deny' } },
      },
      h,
    );
    const { out, sink } = raccogli();
    const code = await cmdModel(h, ['google/gemma-4-31b-it'], {
      out: sink,
      fetchImpl: rete([['google/gemma-4-31b-it', '0', '0']], ['google']),
    });
    expect(code).toBe(0);
    const c = loadConfig(h);
    expect(c.models.main).toBe('google/gemma-4-31b-it');
    expect(c.provider.routing).toEqual({ dataCollection: 'deny' });
    expect(out.join('\n')).toContain('chutes');
    expect(out.join('\n')).toContain('config.json');
  });

  it('il pin che serve ancora resta, senza una riga di rumore', async () => {
    const h = home();
    const base = loadConfig(h);
    saveConfig(
      {
        ...base,
        models: { main: 'qwen/qwen3.8-27b', light: 'qwen/qwen3.8-flash' },
        provider: { ...base.provider, routing: { only: ['alibaba'] } },
      },
      h,
    );
    const { out, sink } = raccogli();
    await cmdModel(h, ['google/gemma-4-31b-it'], {
      out: sink,
      fetchImpl: rete([['google/gemma-4-31b-it', '0', '0']], ['google', 'alibaba']),
    });
    expect(loadConfig(h).provider.routing).toEqual({ only: ['alibaba'] });
    expect(out.join('\n')).not.toContain('rimossi');
  });

  it('senza evidenza tiene tutto e lo dice', async () => {
    const h = home();
    const base = loadConfig(h);
    saveConfig(
      {
        ...base,
        models: { main: 'qwen/qwen3.8-27b', light: 'qwen/qwen3.8-flash' },
        provider: { ...base.provider, routing: { only: ['alibaba'] } },
      },
      h,
    );
    const { out, sink } = raccogli();
    await cmdModel(h, ['google/gemma-4-31b-it'], {
      out: sink,
      fetchImpl: rete([['google/gemma-4-31b-it', '0', '0']], 'throw'),
    });
    expect(loadConfig(h).provider.routing).toEqual({ only: ['alibaba'] });
    expect(out.join('\n')).toContain('non verificato');
  });
});

/**
 * Endpoint openai-compat fuori catalogo (issue #763): un llama-server, un
 * vLLM, un Ollama, un proxy. Il server accetta qualunque nome gli si chieda
 * (misurato su llama-server con `--api-key`), quindi un refuso o un modello
 * cambiato lato server passavano in silenzio. `/models` è un indizio, non
 * un'autorità: un proxy con route wildcard ne elenca di finti.
 */
describe('muffin model su un endpoint compat generico (issue #763)', () => {
  const GENERIC = 'http://llm.example.test:8080/v1';
  const CHIAVE = 'sk-local-canary-763';

  function genericHome(): string {
    const h = mkdtempSync(join(tmpdir(), 'muffin-model-generic-'));
    runInit({ home: h, provider: 'openai-compat', baseUrl: GENERIC, apiKey: CHIAVE });
    return h;
  }

  /** `/models` finto che registra ogni richiesta: URL e Authorization. */
  function modelli(
    risposta: { status?: number; body?: unknown; raw?: string } | 'throw',
  ): { fetchImpl: typeof globalThis.fetch; viste: { url: string; auth: string | null }[] } {
    const viste: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      viste.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      if (risposta === 'throw') throw new TypeError('fetch failed');
      const text = risposta.raw ?? JSON.stringify(risposta.body ?? {});
      return new Response(text, { status: risposta.status ?? 200 });
    }) as unknown as typeof globalThis.fetch;
    return { fetchImpl, viste };
  }

  const lista = (...ids: string[]) => ({ body: { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) } });

  it('uno slug elencato: lo dice prima di scriverlo, chiedendo /models con la credenziale salvata', async () => {
    const h = genericHome();
    const rete = modelli(lista('qwen3.6-35b'));
    const { out, sink } = raccogli();
    const code = await cmdModel(h, ['qwen3.6-35b'], { out: sink, fetchImpl: rete.fetchImpl, gatewayStatus: async () => null });
    expect(code).toBe(0);
    expect(loadConfig(h).models.main).toBe('qwen3.6-35b');
    expect(rete.viste).toEqual([{ url: `${GENERIC}/models`, auth: `Bearer ${CHIAVE}` }]);
    const testo = out.join('\n');
    expect(testo).toContain('visto in /models');
    expect(testo).not.toContain(CHIAVE);
  });

  it('uno slug assente: avvisa, propone i vicini, e scrive lo stesso', async () => {
    const h = genericHome();
    const { out, sink } = raccogli();
    const code = await cmdModel(h, ['qwen3.5-9b-abliterated'], {
      out: sink,
      fetchImpl: modelli(lista('qwen3.5-9b')).fetchImpl,
      gatewayStatus: async () => null,
    });
    expect(code).toBe(0);
    expect(loadConfig(h).models.main).toBe('qwen3.5-9b-abliterated');
    const testo = out.join('\n');
    expect(testo).toContain('non compare');
    expect(testo).toContain('qwen3.5-9b');
    expect(testo).toContain('lo scrivo lo stesso');
  });

  it('rete giù, 401 o risposta malformata: scrive e dice NON verificato, mai «non esiste»', async () => {
    for (const risposta of ['throw', { status: 401, body: { error: 'Invalid API Key' } }, { raw: '<html>' }] as const) {
      const h = genericHome();
      const { out, sink } = raccogli();
      const code = await cmdModel(h, ['qualcosa'], { out: sink, fetchImpl: modelli(risposta).fetchImpl, gatewayStatus: async () => null });
      expect(code).toBe(0);
      expect(loadConfig(h).models.main).toBe('qualcosa');
      const testo = out.join('\n');
      expect(testo).toContain('NON verificato');
      expect(testo).not.toContain('non esiste');
    }
  });

  it('la corsia light passa dalla stessa verifica', async () => {
    const h = genericHome();
    const mainPrima = loadConfig(h).models.main;
    const { out, sink } = raccogli();
    await cmdModel(h, ['light', 'qwen3.6-35b'], { out: sink, fetchImpl: modelli(lista('qwen3.6-35b')).fetchImpl, gatewayStatus: async () => null });
    const c = loadConfig(h);
    expect(c.models.light).toBe('qwen3.6-35b');
    expect(c.models.main).toBe(mainPrima);
    expect(out.join('\n')).toContain('visto in /models');
  });

  it('--list elenca ciò che /models dichiara, col filtro', async () => {
    const { out, sink } = raccogli();
    const code = await cmdModel(genericHome(), ['--list', 'qwen'], {
      out: sink,
      fetchImpl: modelli(lista('qwen3.6-35b', 'gemma-4-12b')).fetchImpl,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('qwen3.6-35b');
    expect(out.join('\n')).not.toContain('gemma-4-12b');
  });

  it('--list su un endpoint che non risponde fallisce dicendo perché', async () => {
    const { out, sink } = raccogli();
    const code = await cmdModel(genericHome(), ['--list'], { out: sink, fetchImpl: modelli('throw').fetchImpl });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('non verificabile');
  });

  describe('--served sceglie solo quando il modello servito è esattamente uno', () => {
    it('uno: lo scrive su main', async () => {
      const h = genericHome();
      const { out, sink } = raccogli();
      const code = await cmdModel(h, ['--served'], { out: sink, fetchImpl: modelli(lista('qwen3.6-35b')).fetchImpl, gatewayStatus: async () => null });
      expect(code).toBe(0);
      expect(loadConfig(h).models.main).toBe('qwen3.6-35b');
      expect(out.join('\n')).toContain('qwen3.6-35b');
    });

    it('uno, sulla corsia light', async () => {
      const h = genericHome();
      const code = await cmdModel(h, ['light', '--served'], {
        out: () => {},
        fetchImpl: modelli(lista('qwen3.6-35b')).fetchImpl,
        gatewayStatus: async () => null,
      });
      expect(code).toBe(0);
      expect(loadConfig(h).models.light).toBe('qwen3.6-35b');
    });

    it('zero: errore esplicito, niente scritto', async () => {
      const h = genericHome();
      const prima = loadConfig(h).models.main;
      const { out, sink } = raccogli();
      const code = await cmdModel(h, ['--served'], { out: sink, fetchImpl: modelli(lista()).fetchImpl });
      expect(code).toBe(1);
      expect(loadConfig(h).models.main).toBe(prima);
      expect(out.join('\n')).toContain('nessun modello');
    });

    it('più di uno: li elenca e chiede lo slug, niente scritto', async () => {
      const h = genericHome();
      const prima = loadConfig(h).models.main;
      const { out, sink } = raccogli();
      const code = await cmdModel(h, ['--served'], { out: sink, fetchImpl: modelli(lista('a-model', 'b-model')).fetchImpl });
      expect(code).toBe(1);
      expect(loadConfig(h).models.main).toBe(prima);
      expect(out.join('\n')).toContain('a-model');
      expect(out.join('\n')).toContain('b-model');
    });

    it('centinaia, da un proxy con route wildcard: anteprima breve, non un muro di testo', async () => {
      const ids = Array.from({ length: 200 }, (_, i) => `proxy/model-${String(i)}`);
      const { out, sink } = raccogli();
      const code = await cmdModel(genericHome(), ['--served'], { out: sink, fetchImpl: modelli(lista(...ids)).fetchImpl });
      expect(code).toBe(1);
      const testo = out.join('\n');
      expect(testo).toContain('200 modelli');
      expect(testo).toContain('--list');
      expect(testo).not.toContain('proxy/model-199');
      expect(testo.length).toBeLessThan(600);
    });

    it('endpoint non verificabile: non indovina, niente scritto', async () => {
      const h = genericHome();
      const prima = loadConfig(h).models.main;
      const code = await cmdModel(h, ['--served'], { out: () => {}, fetchImpl: modelli('throw').fetchImpl });
      expect(code).toBe(1);
      expect(loadConfig(h).models.main).toBe(prima);
    });

    it('su un catalogo autorevole non ha senso, e lo dice', async () => {
      const h = home();
      const prima = loadConfig(h).models.main;
      const { out, sink } = raccogli();
      const code = await cmdModel(h, ['--served'], { out: sink, fetchImpl: catalogo(['x/y', '0', '0']) });
      expect(code).toBe(2);
      expect(loadConfig(h).models.main).toBe(prima);
      expect(out.join('\n')).toContain('--served');
    });
  });
});

describe('muffin model distingue persistito da attivo (issue #500)', () => {
  const casa = (main: string, light: string) => {
    const h = home();
    const base = loadConfig(h);
    saveConfig({ ...base, models: { main, light } }, h);
    return h;
  };
  const rete = catalogo(['google/gemma-4-31b-it', '0', '0']);
  const vivo = (main: string, light: string) => async () => ({ pid: 4242, models: { main, light } });

  it('senza gateway: vale dal prossimo avvio', async () => {
    const { out, sink } = raccogli();
    await cmdModel(casa('qwen/qwen3.8-27b', 'qwen/qwen3.8-flash'), ['google/gemma-4-31b-it'], {
      out: sink,
      fetchImpl: rete,
      gatewayStatus: async () => null,
    });
    expect(out.join('\n')).toContain('Nessun gateway vivo');
    expect(out.join('\n')).toContain('prossimo avvio');
  });

  it('gateway già allineato: niente riavvio', async () => {
    const { out, sink } = raccogli();
    await cmdModel(casa('qwen/qwen3.8-27b', 'qwen/qwen3.8-flash'), ['google/gemma-4-31b-it'], {
      out: sink,
      fetchImpl: rete,
      gatewayStatus: vivo('google/gemma-4-31b-it', 'qwen/qwen3.8-flash'),
    });
    expect(out.join('\n')).toContain('niente riavvio');
  });

  it('gateway indietro: passa al prossimo turno, il volo finisce sul vecchio', async () => {
    const { out, sink } = raccogli();
    await cmdModel(casa('qwen/qwen3.8-27b', 'qwen/qwen3.8-flash'), ['google/gemma-4-31b-it'], {
      out: sink,
      fetchImpl: rete,
      gatewayStatus: vivo('qwen/qwen3.8-27b', 'qwen/qwen3.8-flash'),
    });
    const testo = out.join('\n');
    expect(testo).toContain('dal prossimo turno');
    expect(testo).toContain('in volo');
  });

  it('gateway muto sul modello: dice come verificare invece di indovinare', async () => {
    const { out, sink } = raccogli();
    await cmdModel(casa('qwen/qwen3.8-27b', 'qwen/qwen3.8-flash'), ['google/gemma-4-31b-it'], {
      out: sink,
      fetchImpl: rete,
      gatewayStatus: async () => ({ pid: 4242 }),
    });
    expect(out.join('\n')).toContain('gen_ai.request.model');
  });
});
