import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from './init.js';
import { cmdModel, fetchCatalogue, priceNote } from './model.js';
import { loadConfig } from '../core/config/config.js';
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
 * `pricing.ts` fa match per sottostringa di famiglia: `qwen3` è in tabella a
 * 0.1/0.3 per MTok, e il modello che l'installazione dell'owner usava costa
 * 0.425/2.55. Quella è una **sottostima**, cioè il tetto in `rot/budgets.json`
 * scatta tardi invece che presto — la direzione che `pricing.ts` chiama
 * pericolosa nella sua stessa intestazione.
 */
describe('priceNote', () => {
  it('nomina la sottostima, coi due prezzi', () => {
    const nota = priceNote({ id: 'qwen/qwen3.8-27b', inputPerMTok: 0.425, outputPerMTok: 2.55 }, OR.baseUrl);
    expect(nota).toContain('0.425');
    expect(nota).toContain('0.1');
    expect(nota).toContain('rot/budgets.json');
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
  it('senza argomenti mostra le tre corsie e il provider', async () => {
    const { out, sink } = raccogli();
    expect(await cmdModel(home(), [], { out: sink })).toBe(0);
    const testo = out.join('\n');
    expect(testo).toContain('OpenRouter');
    expect(testo).toMatch(/^main /m);
    expect(testo).toMatch(/^light /m);
    expect(testo).toMatch(/^embed /m);
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
