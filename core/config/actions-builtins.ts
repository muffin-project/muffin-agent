import { z } from 'zod';
import { canonicalJson, paramsDigest } from './actions-digest.js';
import type { ActionCategory, ActionSpec, ChangePlan, PlanOutcome } from './actions-types.js';
import { type Config, ConfigError, ConfigSchema, loadConfig, paths, saveConfig } from './config.js';

/**
 * Initial catalog for ADR-0114 slice 1: the two `setConfigKnob` manopole,
 * embedder on/off, and a read-only `status.collect` wrapper. Further knobs
 * (budgets, search provider, fallback chain) arrive in later slices.
 */

function parsePositiveInt(
  raw: string,
  max?: number,
): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return { ok: false, reason: `«${raw}» non è un numero intero` };
  }
  const n = Number(trimmed);
  if (n <= 0) return { ok: false, reason: `${n} non è positivo` };
  if (max !== undefined && n > max) return { ok: false, reason: `${n} supera il massimo (${max})` };
  return { ok: true, value: n };
}

type Knob = {
  key: 'traces.retentionDays' | 'search.maxResults';
  describe: string;
  section: 'profilo' | 'ricerca';
  read: (config: Config) => string;
  parse: (raw: string) => { ok: true; value: number } | { ok: false; reason: string };
  apply: (config: Config, value: number) => Config | null;
  whenMissing?: string;
  widenImpact: string;
  restrictImpact: string;
};

const KNOBS: readonly Knob[] = [
  {
    key: 'traces.retentionDays',
    section: 'profilo',
    describe:
      'quanti giorni tenere le tracce dei turni prima che vengano ripulite (intero positivo)',
    read: (c) => String(c.traces.retentionDays),
    parse: (raw) => parsePositiveInt(raw),
    apply: (c, value) => ({ ...c, traces: { retentionDays: value } }),
    widenImpact: 'le tracce dei turni restano più a lungo sul disco',
    restrictImpact: 'le tracce dei turni vengono ripulite prima',
  },
  {
    key: 'search.maxResults',
    section: 'ricerca',
    describe:
      'quanti risultati chiedere a ogni ricerca web, da 1 a 20 (tocca solo il numero: motore e chiave restano dove sono)',
    read: (c) =>
      c.search
        ? String(c.search.maxResults ?? '(default del motore)')
        : '(ricerca non configurata)',
    parse: (raw) => parsePositiveInt(raw, 20),
    apply: (c, value) => (c.search ? { ...c, search: { ...c.search, maxResults: value } } : null),
    whenMissing:
      'la ricerca web non è configurata su questa installazione — provider e chiave si impostano a mano in config.json, ' +
      'questo comando cambia solo il numero di risultati quando la ricerca esiste già',
    widenImpact: 'ogni ricerca web chiederà più risultati (e potrà costare di più)',
    restrictImpact: 'ogni ricerca web chiederà meno risultati',
  },
];

export const SETTABLE_CONFIG_KEYS: readonly string[] = KNOBS.map((k) => k.key);

export function describeSettableKnobs(): string {
  return KNOBS.map((k) => `  ${k.key.padEnd(20)} ${k.describe}`).join('\n');
}

function loadOrReason(home: string): { ok: true; config: Config } | { ok: false; reason: string } {
  try {
    return { ok: true, config: loadConfig(home) };
  } catch (error) {
    return { ok: false, reason: error instanceof ConfigError ? error.message : String(error) };
  }
}

function revalidated(next: Config): { ok: true; config: Config } | { ok: false; reason: string } {
  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `scrittura rifiutata: il risultato non è una config valida (${parsed.error.issues.map((i) => i.message).join('; ')})`,
    };
  }
  return { ok: true, config: parsed.data };
}

const configSetParams = z.object({
  key: z.string().min(1),
  value: z.string(),
});

function categoryForNumericChange(previous: string, next: string): ActionCategory {
  const a = Number(previous);
  const b = Number(next);
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) return 'widen';
  return 'restrict';
}

const configSet: ActionSpec<z.infer<typeof configSetParams>> = {
  id: 'config.set',
  section: 'profilo',
  label: 'imposta una manopola di config.json',
  help: describeSettableKnobs(),
  category: 'restrict',
  params: configSetParams,
  store: 'config',
  restart: 'none',
  ownerTypedCommand: true,
  read: (ctx) => ({
    value: describeSettableKnobs(),
    source: paths(ctx.home).config,
  }),
  plan(params, ctx): PlanOutcome {
    const knob = KNOBS.find((k) => k.key === params.key);
    if (!knob) {
      return {
        ok: false,
        reason:
          `«${params.key}» non è un'impostazione modificabile da qui. Quelle che lo sono:\n${describeSettableKnobs()}\n` +
          `Le altre si leggono con \`muffin config\`; molte hanno un comando dedicato ` +
          `(\`muffin model\`, \`/think\`, \`muffin surface default\`, \`muffin prompt version\`), ` +
          `e provider, segreti e \`rot.mode\` non si toccano da qui di proposito.`,
      };
    }
    const loaded = loadOrReason(ctx.home);
    if (!loaded.ok) return loaded;
    const parsed = knob.parse(params.value);
    if (!parsed.ok) return { ok: false, reason: `${knob.key}: ${parsed.reason}` };
    const previous = knob.read(loaded.config);
    const next = knob.apply(loaded.config, parsed.value);
    if (next === null) {
      return {
        ok: false,
        reason: `${knob.key}: ${knob.whenMissing ?? 'non applicabile su questa config'}`,
      };
    }
    const valid = revalidated(next);
    if (!valid.ok) return valid;
    const nextValue = knob.read(valid.config);
    const unchanged = previous === nextValue;
    const category = unchanged ? 'restrict' : categoryForNumericChange(previous, nextValue);
    const plan: ChangePlan = {
      actionId: 'config.set',
      category,
      paramsCanonical: { key: knob.key, value: String(parsed.value) },
      paramsDigest: paramsDigest('config.set', { key: knob.key, value: String(parsed.value) }),
      before: previous,
      after: nextValue,
      files: [paths(ctx.home).config],
      impact: unchanged
        ? 'nessun cambiamento'
        : category === 'widen'
          ? knob.widenImpact
          : knob.restrictImpact,
      restart: 'none',
      ...(unchanged ? { unchanged: true as const } : {}),
    };
    return { ok: true, plan };
  },
  write(plan, ctx, params) {
    const knob = KNOBS.find((k) => k.key === params.key);
    if (!knob) throw new Error(`unknown knob ${params.key}`);
    const loaded = loadConfig(ctx.home);
    const parsed = knob.parse(params.value);
    if (!parsed.ok) throw new Error(parsed.reason);
    const next = knob.apply(loaded, parsed.value);
    if (next === null) throw new Error(knob.whenMissing ?? 'non applicabile');
    const valid = revalidated(next);
    if (!valid.ok) throw new Error(valid.reason);
    saveConfig(valid.config, ctx.home);
    void plan;
  },
  readAfter(ctx, params) {
    const knob = KNOBS.find((k) => k.key === params.key);
    if (!knob) throw new Error(`unknown knob ${params.key}`);
    return knob.read(loadConfig(ctx.home));
  },
};

const emptyParams = z.object({});

function embeddingSummary(config: Config): string {
  const emb = config.embedder;
  if (emb?.enabled === false) return 'off';
  if (emb === undefined) return 'ollama (default)';
  return `${emb.kind}${emb.model ? `:${emb.model}` : ''}`;
}

const embeddingsOff: ActionSpec<Record<string, never>> = {
  id: 'embeddings.off',
  section: 'embedding',
  label: 'spegni gli embedding (resta la ricerca testuale)',
  help: 'Imposta `config.embedder.enabled` a false. La ricerca testuale resta attiva.',
  category: 'restrict',
  params: emptyParams,
  store: 'config',
  restart: 'gateway',
  ownerTypedCommand: true,
  read: (ctx) => {
    const loaded = loadOrReason(ctx.home);
    if (!loaded.ok) return { value: loaded.reason };
    return { value: embeddingSummary(loaded.config), source: paths(ctx.home).config };
  },
  plan(_params, ctx): PlanOutcome {
    const loaded = loadOrReason(ctx.home);
    if (!loaded.ok) return loaded;
    const before = embeddingSummary(loaded.config);
    const next: Config = {
      ...loaded.config,
      embedder: { ...(loaded.config.embedder ?? { kind: 'ollama' }), enabled: false },
    };
    const valid = revalidated(next);
    if (!valid.ok) return valid;
    const after = embeddingSummary(valid.config);
    const unchanged = before === after && loaded.config.embedder?.enabled === false;
    return {
      ok: true,
      plan: {
        actionId: 'embeddings.off',
        category: 'restrict',
        paramsCanonical: {},
        paramsDigest: paramsDigest('embeddings.off', {}),
        before,
        after,
        files: [paths(ctx.home).config],
        impact:
          "l'indicizzazione e il recall semantico si fermano; la ricerca testuale resta attiva",
        restart: 'gateway',
        ...(unchanged ? { unchanged: true as const } : {}),
      },
    };
  },
  write(_plan, ctx) {
    const loaded = loadConfig(ctx.home);
    saveConfig(
      {
        ...loaded,
        embedder: { ...(loaded.embedder ?? { kind: 'ollama' }), enabled: false },
      },
      ctx.home,
    );
  },
  readAfter(ctx) {
    return embeddingSummary(loadConfig(ctx.home));
  },
};

const embeddingsSetParams = z.object({
  embedder: z.object({
    kind: z.enum(['ollama', 'openai-compat']),
    enabled: z.boolean().optional(),
    model: z.string().min(1).optional(),
    dimensions: z.number().int().positive().optional(),
    baseUrl: z.string().url().optional(),
    apiKeyRef: z.string().min(1).optional(),
    fallback: z
      .object({
        kind: z.enum(['ollama', 'openai-compat']),
        model: z.string().min(1).optional(),
        dimensions: z.number().int().positive().optional(),
        baseUrl: z.string().url().optional(),
        apiKeyRef: z.string().min(1).optional(),
      })
      .optional(),
  }),
});

const embeddingsSet: ActionSpec<z.infer<typeof embeddingsSetParams>> = {
  id: 'embeddings.set',
  section: 'embedding',
  label: "imposta o riaccendi l'embedder",
  help: 'Scrive `config.embedder` (modello, dimensioni, abilitazione). Accendere è un widen; spegnere è restrict.',
  category: 'widen',
  params: embeddingsSetParams,
  store: 'config',
  restart: 'gateway',
  ownerTypedCommand: true,
  read: (ctx) => {
    const loaded = loadOrReason(ctx.home);
    if (!loaded.ok) return { value: loaded.reason };
    return { value: embeddingSummary(loaded.config), source: paths(ctx.home).config };
  },
  plan(params, ctx): PlanOutcome {
    const loaded = loadOrReason(ctx.home);
    if (!loaded.ok) return loaded;
    const before = embeddingSummary(loaded.config);
    const next: Config = { ...loaded.config, embedder: params.embedder };
    const valid = revalidated(next);
    if (!valid.ok) return valid;
    const after = embeddingSummary(valid.config);
    const enabling = params.embedder.enabled !== false && loaded.config.embedder?.enabled === false;
    const disabling =
      params.embedder.enabled === false && loaded.config.embedder?.enabled !== false;
    const unchanged = JSON.stringify(loaded.config.embedder) === JSON.stringify(params.embedder);
    const category: ActionCategory =
      disabling || (unchanged && params.embedder.enabled === false) ? 'restrict' : 'widen';
    return {
      ok: true,
      plan: {
        actionId: 'embeddings.set',
        category,
        paramsCanonical: canonicalizeSafe(params),
        paramsDigest: paramsDigest('embeddings.set', params),
        before,
        after,
        files: [paths(ctx.home).config],
        impact: disabling
          ? "l'indicizzazione e il recall semantico si fermano; la ricerca testuale resta attiva"
          : enabling
            ? "si riaccende l'indicizzazione semantica; può richiedere un embedder in rete o in locale"
            : "cambia la rotta di embedding; l'indice vettoriale può essere ricostruito",
        restart: 'gateway',
        ...(unchanged ? { unchanged: true as const } : {}),
      },
    };
  },
  write(_plan, ctx, params) {
    const loaded = loadConfig(ctx.home);
    const next = { ...loaded, embedder: params.embedder };
    const valid = revalidated(next);
    if (!valid.ok) throw new Error(valid.reason);
    saveConfig(valid.config, ctx.home);
  },
  readAfter(ctx) {
    return embeddingSummary(loadConfig(ctx.home));
  },
};

function canonicalizeSafe(value: unknown): unknown {
  // Local copy so this file does not depend on a cycle; digest.ts already
  // sorts keys when hashing, and plan.paramsCanonical is the hashed object.
  return JSON.parse(canonicalJson(value));
}

export const builtinActions = [configSet, embeddingsOff, embeddingsSet];
