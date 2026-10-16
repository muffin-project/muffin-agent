import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { verifyInferenceRoute } from '../agent/providers/verify.js';
import { ChatGPTConnection } from '../core/config/chatgpt-oauth.js';
import {
  inferenceProvider,
  loadConfig,
  readSecret,
  saveConfig,
  writeSecret,
} from '../core/config/config.js';
import { PROVIDERS, providerFor } from '../core/config/providers.js';
import { makeEmbedder } from '../core/memory/embed.js';
import { runInit } from './init.js';
import { cmdModel, fetchCatalogue, fetchEndpointTags, priceNote } from './model.js';

const OR = PROVIDERS.openrouter;

beforeEach(() => {
  vi.stubEnv('XDG_CONFIG_HOME', mkdtempSync(join(tmpdir(), 'muffin-model-xdg-')));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** La forma verificata sul vivo il 2026-08-27: prezzi in USD **per token**, stringhe. */
const catalogo = (...m: [string, string, string][]): typeof globalThis.fetch =>
  (async () =>
    new Response(
      JSON.stringify({
        data: m.map(([id, prompt, completion]) => ({ id, pricing: { prompt, completion } })),
      }),
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

async function embeddingEndpoint(naturalDimensions = 1024): Promise<{
  baseUrl: string;
  requests: { path: string | undefined; body: Record<string, unknown> }[];
  close: () => Promise<void>;
}> {
  const requests: { path: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      requests.push({ path: request.url, body });
      const dimensions = typeof body['dimensions'] === 'number' ? body['dimensions'] : naturalDimensions;
      const embedding = Array.from({ length: dimensions }, () => 0.125);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        request.url === '/api/embeddings'
          ? JSON.stringify({ embedding })
          : JSON.stringify({ data: [{ embedding, index: 0, object: 'embedding' }] }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('embedding endpoint did not bind TCP');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

describe('providerFor', () => {
  it('keeps same-host proxy paths outside the canonical provider catalog', () => {
    expect(providerFor({ kind: 'openai-compat', baseUrl: `${OR.baseUrl}/proxy` })).toBeNull();
    expect(providerFor({ kind: 'openai-compat', baseUrl: `${OR.baseUrl}/` })?.id).toBe(
      'openrouter',
    );
  });
  it("riconosce l'endpoint di OpenRouter", () => {
    expect(providerFor({ kind: 'openai-compat', baseUrl: OR.baseUrl })?.id).toBe('openrouter');
  });

  it("riconosce l'endpoint di Groq", () => {
    expect(providerFor({ kind: 'openai-compat', baseUrl: PROVIDERS.groq.baseUrl })?.id).toBe(
      'groq',
    );
  });

  /** Per hostname e non per sottostringa: `openrouter.ai.evil.tld` contiene «openrouter» e non lo è. */
  it('non si fa ingannare da un hostname che contiene il nome', () => {
    expect(
      providerFor({ kind: 'openai-compat', baseUrl: 'https://openrouter.ai.evil.tld/api/v1' }),
    ).toBeNull();
  });

  it('riconosce il provider Anthropic nativo e mantiene fuori catalogo un endpoint locale', () => {
    expect(providerFor({ kind: 'openai-compat', baseUrl: 'http://127.0.0.1:11434/v1' })).toBeNull();
    expect(providerFor({ kind: 'anthropic' })?.id).toBe('anthropic');
  });
});

describe('fetchCatalogue', () => {
  it('converte i prezzi da per-token a per-MTok, che è l unità di pricing.ts', async () => {
    const [m] = await fetchCatalogue(
      OR,
      undefined,
      catalogo(['qwen/qwen3.8-27b', '0.000000425', '0.00000255']),
    );
    expect(m!.inputPerMTok).toBeCloseTo(0.425, 6);
    expect(m!.outputPerMTok).toBeCloseTo(2.55, 6);
  });

  it('un prezzo illeggibile non diventa zero: il modello resta, il confronto lo salta', async () => {
    const [m] = await fetchCatalogue(OR, undefined, catalogo(['strano/modello', 'boh', 'boh']));
    expect(m!.id).toBe('strano/modello');
    expect(Number.isNaN(m!.inputPerMTok)).toBe(true);
    expect(priceNote(m!, OR.baseUrl)).toBeNull();
  });

  it('usa la paginazione e gli header nativi Anthropic, senza inventare prezzi', async () => {
    const requests: { url: string; headers: Headers }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ data: [{ id: 'claude-test' }], has_more: false }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;
    const [model] = await fetchCatalogue(PROVIDERS.anthropic, 'synthetic-anthropic-key', fetchImpl);
    expect(requests[0]?.url).toContain('/v1/models?limit=1000');
    expect(requests[0]?.headers.get('x-api-key')).toBe('synthetic-anthropic-key');
    expect(requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(Number.isNaN(model?.inputPerMTok)).toBe(true);
  });

  it('il catalogo Groq va interrogato con la chiave (Bearer su /models)', async () => {
    const requests: { url: string; headers: Headers }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;
    const [model] = await fetchCatalogue(PROVIDERS.groq, 'synthetic-groq-key', fetchImpl);
    expect(requests[0]?.url).toBe('https://api.groq.com/openai/v1/models');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer synthetic-groq-key');
    expect(model?.id).toBe('llama-3.3-70b-versatile');
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
    const nota = priceNote(
      { id: 'qwen/qwen3.9-ipotetico', inputPerMTok: 2.5, outputPerMTok: 7 },
      OR.baseUrl,
    );
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
    expect(
      priceNote(
        { id: 'anthropic/claude-sonnet-5', inputPerMTok: 2, outputPerMTok: 10 },
        OR.baseUrl,
      ),
    ).toBeNull();
  });

  it('e su un modello locale, che non si fattura affatto', () => {
    expect(
      priceNote(
        { id: 'qwen3-embedding', inputPerMTok: 9, outputPerMTok: 9 },
        'http://127.0.0.1:11434',
      ),
    ).toBeNull();
  });
});

describe('muffin model', () => {
  it('senza argomenti mostra le tre corsie e il provider, distinguendo un router dal modello servito', async () => {
    const h = home();
    expect(
      await cmdModel(h, ['openrouter/free'], {
        out: () => {},
        fetchImpl: catalogo(['openrouter/free', '0', '0']),
      }),
    ).toBe(0);
    const { out, sink } = raccogli();
    expect(await cmdModel(h, [], { out: sink })).toBe(0);
    const testo = out.join('\n');
    expect(testo).toContain('OpenRouter');
    expect(testo).toMatch(/^main /m);
    expect(testo).toMatch(/^light /m);
    expect(testo).toMatch(/^embed /m);
    expect(testo).toContain('openrouter/free · OpenRouter — $0/$0 per MTok');
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

  it('cambia il provider e il modello di main senza toccare il provider né il modello light', async () => {
    const h = home();
    writeSecret('anthropic_api_key', 'synthetic-anthropic-key', h, 'home');
    const before = loadConfig(h);
    const fetchImpl = (async (input: string | URL | Request) => {
      expect(String(input)).toContain('/v1/models?limit=1000');
      return new Response(JSON.stringify({ data: [{ id: 'claude-test' }], has_more: false }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;
    expect(
      await cmdModel(h, ['main', '--provider', 'anthropic', 'claude-test'], {
        out: () => {},
        fetchImpl,
      }),
    ).toBe(0);
    const after = loadConfig(h);
    expect(after.models).toEqual({ ...before.models, main: 'claude-test' });
    expect(inferenceProvider(after, 'main')).toMatchObject({
      kind: 'anthropic',
      apiKeyRef: 'secret://anthropic_api_key',
    });
    expect(inferenceProvider(after, 'light')).toEqual(inferenceProvider(before, 'light'));
  });

  it('accepts the provider shortcut without spelling main', async () => {
    const h = home();
    writeSecret('anthropic_api_key', 'synthetic-anthropic-key', h, 'home');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'claude-test' }] }), {
        status: 200,
      })) as typeof globalThis.fetch;
    expect(
      await cmdModel(h, ['--provider', 'anthropic', 'claude-test'], { out: () => {}, fetchImpl }),
    ).toBe(0);
    expect(inferenceProvider(loadConfig(h), 'main').kind).toBe('anthropic');
  });

  it('does not assign OpenRouter when its inference secret is missing, even though its catalog is public', async () => {
    const h = mkdtempSync(join(tmpdir(), 'muffin-model-no-openrouter-key-'));
    runInit({
      home: h,
      provider: 'anthropic',
      baseUrl: PROVIDERS.anthropic.baseUrl,
      apiKey: 'synthetic-anthropic-key',
    });
    const before = loadConfig(h);
    const fetchImpl = vi.fn<typeof globalThis.fetch>();
    const out: string[] = [];
    expect(
      await cmdModel(h, ['--provider', 'openrouter', 'openai/gpt-test'], {
        out: (line) => out.push(line),
        fetchImpl,
      }),
    ).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadConfig(h)).toEqual(before);
    expect(out.join('\n')).toContain('saved key reference');
  });

  it('keeps a same-host OpenAI-compatible proxy when provider is left blank', async () => {
    const h = home();
    const current = loadConfig(h);
    const provider = {
      kind: 'openai-compat' as const,
      baseUrl: `${OR.baseUrl}/proxy`,
      apiKeyRef: 'secret://proxy_fixture',
    };
    writeSecret('proxy_fixture', 'proxy-canary', h, 'home');
    saveConfig({ ...current, provider }, h);
    const answers = ['main', '', 'proxy-model'];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      expect(String(input)).toBe(`${provider.baseUrl}/models`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer proxy-canary');
      return Response.json({ data: [{ id: 'proxy-model' }] });
    };
    expect(
      await cmdModel(h, ['--select'], {
        out: () => {},
        interactive: true,
        ask: async () => answers.shift(),
        fetchImpl,
      }),
    ).toBe(0);
    expect(loadConfig(h).provider).toEqual(provider);
    expect(loadConfig(h).lightProvider).toEqual(current.lightProvider);
  });

  it('keeps a custom Anthropic-compatible connection when provider is left blank', async () => {
    const h = home();
    const current = loadConfig(h);
    const provider = {
      kind: 'anthropic' as const,
      baseUrl: 'https://proxy.anthropic.example/v1',
      apiKeyRef: 'secret://proxy_anthropic_key',
    };
    writeSecret('proxy_anthropic_key', 'synthetic-proxy-key', h, 'home');
    saveConfig({ ...current, provider }, h);
    const answers = ['main', '', 'proxy-model'];
    const requests: { url: string; authorization: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ data: [{ id: 'proxy-model' }] }), { status: 200 });
    }) as typeof globalThis.fetch;
    expect(
      await cmdModel(h, ['--select'], {
        out: () => {},
        interactive: true,
        ask: async () => answers.shift(),
        fetchImpl,
      }),
    ).toBe(0);
    const after = loadConfig(h);
    expect(after.provider).toEqual(provider);
    expect(after.models.main).toBe('proxy-model');
    expect(after.lightProvider).toEqual(current.lightProvider);
    expect(requests).toEqual([]);
  });

  it('preserves the exact key reference when explicitly reselecting the same native Anthropic endpoint', async () => {
    const h = home();
    const current = loadConfig(h);
    const provider = {
      kind: 'anthropic' as const,
      baseUrl: PROVIDERS.anthropic.baseUrl,
      apiKeyRef: 'secret://owner_anthropic_key',
    };
    writeSecret('owner_anthropic_key', 'synthetic-owner-key', h, 'home');
    saveConfig({ ...current, provider }, h);
    const requests: { url: string; apiKey: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        apiKey: new Headers(init?.headers).get('x-api-key'),
      });
      return new Response(JSON.stringify({ data: [{ id: 'claude-test' }], has_more: false }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;
    expect(
      await cmdModel(h, ['--provider', 'anthropic', 'claude-test'], {
        out: () => {},
        fetchImpl,
      }),
    ).toBe(0);
    expect(requests).toEqual([
      {
        url: 'https://api.anthropic.com/v1/models?limit=1000',
        apiKey: 'synthetic-owner-key',
      },
    ]);
    expect(inferenceProvider(loadConfig(h), 'main')).toEqual(provider);
  });

  it('connects a custom OpenAI-compatible endpoint through the same selector', async () => {
    const h = home();
    const before = loadConfig(h);
    writeSecret('custom_proxy_test', 'synthetic-custom-key', h, 'home');
    const sentAuth: string[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      sentAuth.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), {
        status: 200,
      });
    }) as typeof globalThis.fetch;
    expect(
      await cmdModel(
        h,
        ['--endpoint', 'http://127.0.0.1:1234/v1', '--key-ref', 'custom_proxy_test', 'local-model'],
        {
          out: () => {},
          fetchImpl,
        },
      ),
    ).toBe(0);
    const after = loadConfig(h);
    expect(after.provider).toMatchObject({
      kind: 'openai-compat',
      baseUrl: 'http://127.0.0.1:1234/v1',
    });
    expect(after.models.main).toBe('local-model');
    expect(after.lightProvider).toEqual(before.lightProvider);
    expect(sentAuth).toEqual(['Bearer synthetic-custom-key']);
    expect(sentAuth).not.toContain('Bearer sk-or-fake');
  });

  it('never sends the prior router credential when a custom host is selected without its own saved key', async () => {
    const h = home();
    const before = loadConfig(h);
    const out: string[] = [];
    const fetchImpl = vi.fn<typeof globalThis.fetch>();
    expect(
      await cmdModel(h, ['--endpoint', 'https://proxy.example/v1', 'proxy-model'], {
        out: (line) => out.push(line),
        fetchImpl,
      }),
    ).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadConfig(h)).toEqual(before);
    expect(out.join(' ')).toContain('--key-ref');
  });

  it('signs in to ChatGPT from the terminal menu before listing and verifying a model', async () => {
    const h = home();
    const before = loadConfig(h);
    const connection = new ChatGPTConnection(h);
    vi.spyOn(connection, 'session').mockResolvedValue(null);
    vi.spyOn(connection, 'signIn').mockResolvedValue({
      profileId: 'synthetic-profile',
      connected: true,
      scopes: ['chatgpt.tokens.use.direct'],
    });
    vi.spyOn(connection, 'listModels').mockResolvedValue([
      { slug: 'gpt-test', displayName: 'Test' },
    ]);
    const verify = vi.fn<typeof verifyInferenceRoute>(async () => ({
      status: 'working',
      provider: 'openai-chatgpt',
      requestedModel: 'gpt-test',
      resolvedModel: 'gpt-test',
      capability: { completion: 'pass', toolCall: 'pass' },
      diagnostic: 'synthetic verification',
      observedAt: '2026-10-12T00:00:00Z',
      durationMs: 1,
    }));
    const answers = ['main', 'chatgpt', 'gpt-test'];
    expect(
      await cmdModel(h, ['--select'], {
        out: () => {},
        interactive: true,
        ask: async () => answers.shift(),
        chatgpt: connection,
        verify,
      }),
    ).toBe(0);
    const after = loadConfig(h);
    expect(connection.signIn).toHaveBeenCalledTimes(1);
    expect(inferenceProvider(after, 'main').kind).toBe('openai-chatgpt');
    expect(inferenceProvider(after, 'light')).toEqual(inferenceProvider(before, 'light'));
    expect(after.models.light).toBe(before.models.light);
  });

  it('keeps model and provider assignment intact when the ChatGPT route fails verification', async () => {
    const h = home();
    const before = loadConfig(h);
    const connection = new ChatGPTConnection(h);
    vi.spyOn(connection, 'listModels').mockResolvedValue([
      { slug: 'gpt-test', displayName: 'Test' },
    ]);
    const verify = vi.fn<typeof verifyInferenceRoute>(async () => ({
      status: 'provider_error' as const,
      provider: 'openai-chatgpt' as const,
      requestedModel: 'gpt-test',
      capability: { completion: 'fail' as const, toolCall: 'fail' as const },
      diagnostic: 'synthetic route rejection',
      observedAt: '2026-10-12T00:00:00Z',
      durationMs: 1,
    }));
    expect(
      await cmdModel(h, ['light', '--provider', 'chatgpt', 'gpt-test'], {
        out: () => {},
        chatgpt: connection,
        verify,
      }),
    ).toBe(1);
    expect(loadConfig(h)).toEqual(before);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toMatchObject({ lane: 'light', thinking: 'low' });
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

  it('rifiuta i redirect del catalogo senza inoltrare la chiave né modificare la configurazione', async () => {
    const h = home();
    writeSecret('anthropic_api_key', 'synthetic-anthropic-key', h, 'home');
    const before = loadConfig(h);
    const requests: {
      url: string;
      apiKey: string | null;
      redirect: RequestInit['redirect'];
    }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        apiKey: new Headers(init?.headers).get('x-api-key'),
        redirect: init?.redirect,
      });
      return new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/steal' },
      });
    }) as typeof globalThis.fetch;
    const out: string[] = [];
    expect(
      await cmdModel(h, ['--provider', 'anthropic', 'claude-test'], {
        out: (line) => out.push(line),
        fetchImpl,
      }),
    ).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('https://api.anthropic.com/');
    expect(requests[0]?.redirect).toBe('manual');
    expect(requests[0]?.apiKey).toBe('synthetic-anthropic-key');
    expect(loadConfig(h)).toEqual(before);
    expect(out.join('\n')).toContain('redirect HTTP 302');
    expect(out.join('\n')).toContain('Configurazione preservata');
  });

  it.each([
    ['duplicate provider flags', ['--provider', 'anthropic', '--provider', 'chatgpt', 'model']],
    ['surplus model arguments', ['model', 'ignored-extra']],
    ['provider option on embed lane', ['embed', '--provider', 'anthropic', 'model']],
  ])('rejects %s without changing configuration', async (_label, argv) => {
    const h = home();
    const before = loadConfig(h);
    const out: string[] = [];
    expect(await cmdModel(h, argv, { out: (line) => out.push(line) })).toBe(2);
    expect(loadConfig(h)).toEqual(before);
    expect(out.length).toBeGreaterThan(0);
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

  it('probes the Ollama model dimensions without a fake expected size', async () => {
    const endpoint = await embeddingEndpoint(1024);
    try {
      const h = home();
      saveConfig({ ...loadConfig(h), embedder: { kind: 'ollama', baseUrl: endpoint.baseUrl } }, h);
      const { sink } = raccogli();

      const code = await cmdModel(h, ['embed', 'qwen3-embedding:0.6b'], { out: sink });

      expect(code).toBe(0);
      expect(endpoint.requests[0]).toMatchObject({ path: '/api/embeddings', body: { model: 'qwen3-embedding:0.6b' } });
      expect(endpoint.requests[0]?.body).not.toHaveProperty('dimensions');
      expect(loadConfig(h).embedder?.dimensions).toBe(1024);
    } finally {
      await endpoint.close();
    }
  });

  it('probes OpenAI-compatible native dimensions and keeps them on normal embeddings', async () => {
    const endpoint = await embeddingEndpoint(1536);
    try {
      const h = home();
      writeSecret('embedding_test_key', 'sk-embedding-fake', h, 'home');
      saveConfig(
        {
          ...loadConfig(h),
          embedder: {
            kind: 'openai-compat',
            model: 'old-embedding-model',
            dimensions: 512,
            apiKeyRef: 'secret://embedding_test_key',
            baseUrl: `${endpoint.baseUrl}/v1`,
          },
        },
        h,
      );
      const { sink } = raccogli();

      const code = await cmdModel(h, ['embed', 'new-embedding-model'], { out: sink });

      expect(code).toBe(0);
      expect(endpoint.requests[0]).toMatchObject({
        path: '/v1/embeddings',
        body: { model: 'new-embedding-model', input: ['muffin'] },
      });
      expect(endpoint.requests[0]?.body).not.toHaveProperty('dimensions');
      expect(loadConfig(h).embedder?.dimensions).toBe(1536);

      const configured = loadConfig(h).embedder;
      const active = makeEmbedder(configured, (ref) => readSecret(ref, h));
      await active.embed(['normal runtime embedding']);
      expect(endpoint.requests[1]).toMatchObject({
        path: '/v1/embeddings',
        body: { model: 'new-embedding-model', input: ['normal runtime embedding'], dimensions: 1536 },
      });
    } finally {
      await endpoint.close();
    }
  });

  it('does not save a measured size that would invalidate the configured fallback', async () => {
    const endpoint = await embeddingEndpoint(1536);
    try {
      const h = home();
      writeSecret('embedding_test_key', 'sk-embedding-fake', h, 'home');
      saveConfig(
        {
          ...loadConfig(h),
          embedder: {
            kind: 'openai-compat',
            model: 'old-embedding-model',
            dimensions: 512,
            apiKeyRef: 'secret://embedding_test_key',
            baseUrl: `${endpoint.baseUrl}/v1`,
            fallback: { kind: 'ollama', model: 'qwen3-embedding:0.6b', dimensions: 512 },
          },
        },
        h,
      );
      const { out, sink } = raccogli();

      const code = await cmdModel(h, ['embed', 'new-embedding-model'], { out: sink });

      expect(code).toBe(1);
      expect(loadConfig(h).embedder).toMatchObject({ model: 'old-embedding-model', dimensions: 512 });
      expect(out.join('\n')).toContain('Niente scritto');
    } finally {
      await endpoint.close();
    }
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
      fetchImpl: catalogo(
        ['qwen/qwen3.8-27b', '0.000000425', '0.00000255'],
        ['anthropic/claude-sonnet-5', '0.000002', '0.00001'],
      ),
    });
    expect(out.join('\n')).toContain('qwen/qwen3.8-27b');
    expect(out.join('\n')).not.toContain('claude-sonnet-5');
  });
});

/** Rete finta instradata per URL: catalogo su /models, tag su /models/:author/:slug/endpoints. */
const rete = (
  modelli: [string, string, string][],
  tag: string[] | 'throw',
): typeof globalThis.fetch =>
  (async (url: unknown) => {
    if (String(url).includes('/endpoints')) {
      if (tag === 'throw') throw new Error('fetch failed');
      return new Response(
        JSON.stringify({ data: { endpoints: tag.map((t) => ({ tag: t, provider_name: t })) } }),
        {
          status: 200,
        },
      );
    }
    return new Response(
      JSON.stringify({
        data: modelli.map(([id, prompt, completion]) => ({ id, pricing: { prompt, completion } })),
      }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;

describe('fetchEndpointTags', () => {
  it('legge tag e nomi dai endpoint, minuscoli e senza doppioni', async () => {
    const tags = await fetchEndpointTags(
      OR,
      'google/gemma-4-31b-it',
      undefined,
      rete([], ['Google', 'google', 'Alibaba']),
    );
    expect(tags).toEqual(['google', 'alibaba']);
  });

  it('ignoto quando non si sa: offline, 401, forma diversa, slug senza autore', async () => {
    expect(
      await fetchEndpointTags(OR, 'google/gemma-4-31b-it', undefined, rete([], 'throw')),
    ).toBeNull();
    const ko = (() =>
      Promise.resolve(new Response('{}', { status: 401 }))) as unknown as typeof globalThis.fetch;
    expect(await fetchEndpointTags(OR, 'google/gemma-4-31b-it', undefined, ko)).toBeNull();
    expect(
      await fetchEndpointTags(OR, 'google/gemma-4-31b-it', undefined, catalogo(['x', '0', '0'])),
    ).toBeNull();
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
  function modelli(risposta: { status?: number; body?: unknown; raw?: string } | 'throw'): {
    fetchImpl: typeof globalThis.fetch;
    viste: { url: string; auth: string | null }[];
  } {
    const viste: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      viste.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      if (risposta === 'throw') throw new TypeError('fetch failed');
      const text = risposta.raw ?? JSON.stringify(risposta.body ?? {});
      return new Response(text, { status: risposta.status ?? 200 });
    }) as unknown as typeof globalThis.fetch;
    return { fetchImpl, viste };
  }

  const lista = (...ids: string[]) => ({
    body: { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) },
  });

  it('uno slug elencato: lo dice prima di scriverlo, chiedendo /models con la credenziale salvata', async () => {
    const h = genericHome();
    const rete = modelli(lista('qwen3.6-35b'));
    const { out, sink } = raccogli();
    const code = await cmdModel(h, ['qwen3.6-35b'], {
      out: sink,
      fetchImpl: rete.fetchImpl,
      gatewayStatus: async () => null,
    });
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
    for (const risposta of [
      'throw',
      { status: 401, body: { error: 'Invalid API Key' } },
      { raw: '<html>' },
    ] as const) {
      const h = genericHome();
      const { out, sink } = raccogli();
      const code = await cmdModel(h, ['qualcosa'], {
        out: sink,
        fetchImpl: modelli(risposta).fetchImpl,
        gatewayStatus: async () => null,
      });
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
    await cmdModel(h, ['light', 'qwen3.6-35b'], {
      out: sink,
      fetchImpl: modelli(lista('qwen3.6-35b')).fetchImpl,
      gatewayStatus: async () => null,
    });
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
    const code = await cmdModel(genericHome(), ['--list'], {
      out: sink,
      fetchImpl: modelli('throw').fetchImpl,
    });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('non verificabile');
  });

  describe('--served sceglie solo quando il modello servito è esattamente uno', () => {
    it('uno: lo scrive su main', async () => {
      const h = genericHome();
      const { out, sink } = raccogli();
      const code = await cmdModel(h, ['--served'], {
        out: sink,
        fetchImpl: modelli(lista('qwen3.6-35b')).fetchImpl,
        gatewayStatus: async () => null,
      });
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
      const code = await cmdModel(h, ['--served'], {
        out: sink,
        fetchImpl: modelli(lista()).fetchImpl,
      });
      expect(code).toBe(1);
      expect(loadConfig(h).models.main).toBe(prima);
      expect(out.join('\n')).toContain('nessun modello');
    });

    it('più di uno: li elenca e chiede lo slug, niente scritto', async () => {
      const h = genericHome();
      const prima = loadConfig(h).models.main;
      const { out, sink } = raccogli();
      const code = await cmdModel(h, ['--served'], {
        out: sink,
        fetchImpl: modelli(lista('a-model', 'b-model')).fetchImpl,
      });
      expect(code).toBe(1);
      expect(loadConfig(h).models.main).toBe(prima);
      expect(out.join('\n')).toContain('a-model');
      expect(out.join('\n')).toContain('b-model');
    });

    it('centinaia, da un proxy con route wildcard: anteprima breve, non un muro di testo', async () => {
      const ids = Array.from({ length: 200 }, (_, i) => `proxy/model-${String(i)}`);
      const { out, sink } = raccogli();
      const code = await cmdModel(genericHome(), ['--served'], {
        out: sink,
        fetchImpl: modelli(lista(...ids)).fetchImpl,
      });
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
      const code = await cmdModel(h, ['--served'], {
        out: () => {},
        fetchImpl: modelli('throw').fetchImpl,
      });
      expect(code).toBe(1);
      expect(loadConfig(h).models.main).toBe(prima);
    });

    it('su un catalogo autorevole non ha senso, e lo dice', async () => {
      const h = home();
      const prima = loadConfig(h).models.main;
      const { out, sink } = raccogli();
      const code = await cmdModel(h, ['--served'], {
        out: sink,
        fetchImpl: catalogo(['x/y', '0', '0']),
      });
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
  const vivo = (main: string, light: string) => async () => ({
    pid: 4242,
    models: { main, light },
  });

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
