import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import {
  diagnoseRoutingStaleness,
  familyOf,
  repairStaleRouting,
  resolveModelSwitch,
  tagsToEvidence,
  type EndpointEvidence,
} from './model-resolve.js';

/**
 * Il cambio modello che non rompe l'instradamento (issue #501).
 *
 * Il guasto: `routing.only: ["alibaba"]` per Qwen sopravviveva al passaggio a
 * Gemma e ogni richiesta diventava impossibile. Questi test tengono la
 * promessa: i pin di identità si rivalidano al cambio famiglia, le manopole di
 * policy non si toccano mai, senza evidenza non si distrugge niente.
 */

function config(over: Partial<Config> = {}): Config {
  return {
    schemaVersion: 2,
    provider: { kind: 'openai-compat', apiKeyRef: 'secret://k' },
    models: { main: 'qwen/qwen3.8-27b', light: 'qwen/qwen3.8-flash' },
    rot: { mode: 'single-user' },
    traces: { retentionDays: 90 },
    surfaces: { default: 'cli', enabled: ['cli'] },
    ...over,
  };
}

const live: EndpointEvidence = {
  serves: (pin) => ['google', 'alibaba'].includes(pin.toLowerCase()),
};
const nobody: EndpointEvidence = { serves: () => false };

describe('familyOf', () => {
  it('legge il prefisso autore, e il router non è una famiglia', () => {
    expect(familyOf('qwen/qwen3.8-27b')).toBe('qwen');
    expect(familyOf('google/gemma-4-31b-it')).toBe('google');
    expect(familyOf('openrouter/free')).toBe('router');
    expect(familyOf('llama3')).toBe('llama3');
  });
});

describe('resolveModelSwitch', () => {
  it('stesso slug: niente da fare, niente rumore', () => {
    const c = config({ provider: { kind: 'openai-compat', apiKeyRef: 'secret://k', routing: { only: ['alibaba'] } } });
    const { config: out, notes } = resolveModelSwitch(c, 'main', 'qwen/qwen3.8-27b', live);
    expect(out).toBe(c);
    expect(notes).toEqual([]);
  });

  it('stessa famiglia: i pin restano significativi, senza rumore', () => {
    const c = config({ provider: { kind: 'openai-compat', apiKeyRef: 'secret://k', routing: { only: ['alibaba'] } } });
    const { config: out, notes } = resolveModelSwitch(c, 'main', 'qwen/qwen3.8-flash', nobody);
    expect(out.models.main).toBe('qwen/qwen3.8-flash');
    expect(out.provider.routing).toEqual({ only: ['alibaba'] });
    expect(notes).toEqual([]);
  });

  it('la regressione Qwen -> Gemma: cade solo il pin che non serve, con rimedio', () => {
    const c = config({
      provider: {
        kind: 'openai-compat',
        apiKeyRef: 'secret://k',
        routing: { only: ['chutes'], dataCollection: 'deny' },
      },
    });
    const { config: out, notes } = resolveModelSwitch(c, 'main', 'google/gemma-4-31b-it', live);
    expect(out.models.main).toBe('google/gemma-4-31b-it');
    // only svuotato -> rimosso (fail-open); la policy dell'owner resta.
    expect(out.provider.routing).toEqual({ dataCollection: 'deny' });
    // Validato con evidenza: il marcatore avanza, per doctor/update offline.
    expect(out.provider.routingForFamily).toBe('google');
    expect(notes.join('\n')).toContain('chutes');
    expect(notes.join('\n')).toContain('config.json');
  });

  it('senza evidenza il marcatore non avanza: un non-validato non spegne gli avvisi', () => {
    const c = config({
      provider: { kind: 'openai-compat', apiKeyRef: 'secret://k', routing: { only: ['alibaba'] } },
    });
    const { config: out } = resolveModelSwitch(c, 'main', 'google/gemma-4-31b-it', null);
    expect(out.provider.routingForFamily).toBeUndefined();
  });

  it('il pin che serve ancora resta, senza rumore', () => {
    const c = config({
      provider: { kind: 'openai-compat', apiKeyRef: 'secret://k', routing: { only: ['alibaba'] } },
    });
    const { config: out, notes } = resolveModelSwitch(c, 'main', 'google/gemma-4-31b-it', live);
    expect(out.provider.routing).toEqual({ only: ['alibaba'] });
    expect(notes).toEqual([]);
  });

  it('senza evidenza non si distrugge niente, ma lo si dice', () => {
    const c = config({
      provider: { kind: 'openai-compat', apiKeyRef: 'secret://k', routing: { only: ['alibaba'] } },
    });
    const { config: out, notes } = resolveModelSwitch(c, 'main', 'google/gemma-4-31b-it', null);
    expect(out.provider.routing).toEqual({ only: ['alibaba'] });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('non verificato');
  });

  it('senza routing non cè niente da riparare', () => {
    const { config: out, notes } = resolveModelSwitch(config(), 'light', 'google/gemma-4-26b-a4b-it', nobody);
    expect(out.models.light).toBe('google/gemma-4-26b-a4b-it');
    expect(out.provider.routing).toBeUndefined();
    expect(notes).toEqual([]);
  });

  it('order e ignore si rivalidano come only, le policy mai', () => {
    const c = config({
      provider: {
        kind: 'openai-compat',
        apiKeyRef: 'secret://k',
        routing: { order: ['alibaba', 'chutes'], ignore: ['chutes'], quantizations: ['fp8'], sort: 'price' },
      },
    });
    const { config: out } = resolveModelSwitch(c, 'main', 'google/gemma-4-31b-it', live);
    expect(out.provider.routing).toEqual({ order: ['alibaba'], quantizations: ['fp8'], sort: 'price' });
  });
});

describe('repairStaleRouting', () => {  it('ripara il modello già configurato contro gli endpoint di oggi', () => {
    const c = config({
      models: { main: 'google/gemma-4-31b-it', light: 'qwen/qwen3.8-flash' },
      provider: { kind: 'openai-compat', apiKeyRef: 'secret://k', routing: { only: ['chutes'] } },
    });
    const { config: out, notes } = repairStaleRouting(c, 'main', live);
    expect(out.provider.routing).toEqual({});
    expect(out.provider.routingForFamily).toBe('google');
    expect(notes).toHaveLength(1);
  });

  it('senza evidenza o senza routing non tocca niente', () => {
    const c = config({
      provider: { kind: 'openai-compat', apiKeyRef: 'secret://k', routing: { only: ['alibaba'] } },
    });
    expect(repairStaleRouting(c, 'main', null).notes).toEqual([]);
    expect(repairStaleRouting(config(), 'main', nobody).notes).toEqual([]);
  });
});

describe('tagsToEvidence', () => {
  it('null resta null, il confronto è sul normalizzato', () => {
    expect(tagsToEvidence(null)).toBeNull();
    const ev = tagsToEvidence(['google']);
    expect(ev?.serves('Google')).toBe(true);
    expect(ev?.serves('chutes')).toBe(false);
  });
});

describe('marcatore stale a slug invariato', () => {
  it('lo stesso slug rivalida quando il marcatore è di unaltra era', () => {
    const c = config({
      models: { main: 'google/gemma-4-31b-it', light: 'google/gemma-4-26b-a4b-it' },
      provider: {
        kind: 'openai-compat',
        apiKeyRef: 'secret://k',
        routing: { only: ['chutes'] },
        routingForFamily: 'qwen',
      },
    });
    const { config: out, notes } = resolveModelSwitch(c, 'main', 'google/gemma-4-31b-it', live);
    expect(out.provider.routing).toEqual({});
    expect(out.provider.routingForFamily).toBe('google');
    expect(notes.join('\n')).toContain('chutes');
  });
});

describe('diagnoseRoutingStaleness', () => {
  const stantia = (): Config =>
    config({
      models: { main: 'google/gemma-4-31b-it', light: 'google/gemma-4-26b-a4b-it' },
      provider: {
        kind: 'openai-compat',
        apiKeyRef: 'secret://k',
        routing: { only: ['alibaba'] },
        routingForFamily: 'qwen',
      },
    });

  it('nomina pin, era e rimedio quando lo può provare', () => {
    const d = diagnoseRoutingStaleness(stantia());
    expect(d?.detail).toContain('alibaba');
    expect(d?.detail).toContain('"qwen"');
    expect(d?.remedy).toContain('muffin model google/gemma-4-31b-it');
  });

  it('tace quando non può provare: niente routing, niente marcatore, marcatore confermato, router', () => {
    expect(diagnoseRoutingStaleness(config())).toBeNull();
    expect(diagnoseRoutingStaleness({ ...stantia(), provider: { ...stantia().provider, routingForFamily: undefined } })).toBeNull();
    expect(
      diagnoseRoutingStaleness({ ...stantia(), provider: { ...stantia().provider, routingForFamily: 'google' } }),
    ).toBeNull();
    expect(
      diagnoseRoutingStaleness({
        ...stantia(),
        models: { main: 'openrouter/free', light: 'openrouter/free' },
      }),
    ).toBeNull();
  });
});
