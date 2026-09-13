import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { paths } from './config.js';
import { listConfigKnobs, type ConfigKnob } from './inventory.js';
import { PROVIDERS } from './providers.js';

/**
 * `muffin config`'s data layer: every knob, its value, where it lives, whether
 * it is sealed.
 *
 * ADR-0036 names the failure this replaces: "l'owner non sa cosa può regolare
 * perché non c'è un posto dove chiederlo." A listing that silently drops a
 * knob is the same defect one layer up, so the tests below check three things
 * a mutation could break without any of the surrounding logic looking wrong:
 * a row goes missing, the sealed marker lies, or the value shown is not the
 * one actually bound (a stale copy rather than a live read).
 */

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-inventory-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  // `runInit` itself does no inference — that lives in `cmdInit` (cli/main.ts)
  // and is tested there. Passed explicitly here so this fixture exercises a
  // provider with a base URL to show (openai-compat), which is one of the
  // minimum knobs this file has to prove present.
  runInit({
    home: dir,
    apiKey: 'sk-or-v1-fixture',
    provider: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
  return dir;
}

function find(knobs: ConfigKnob[], key: string): ConfigKnob | undefined {
  return knobs.find((k) => k.key === key);
}

afterEach(() => vi.unstubAllEnvs());

describe('every knob the mandate names as a minimum shows up', () => {
  it('provider, base URL, the two models, rot mode, and trace retention', () => {
    const dir = home();
    const knobs = listConfigKnobs(dir);
    expect(find(knobs, 'provider.kind')?.value).toBe('openai-compat');
    expect(find(knobs, 'provider.baseUrl')?.value).toBe('https://openrouter.ai/api/v1');
    expect(find(knobs, 'models.main')?.value).toBeTruthy();
    expect(find(knobs, 'models.light')?.value).toBeTruthy();
    expect(find(knobs, 'traces.retentionDays')?.value).toBe('90');
    rmSync(dir, { recursive: true, force: true });
  });

  it('the surfaces', () => {
    const dir = home();
    const knobs = listConfigKnobs(dir);
    expect(find(knobs, 'surfaces.default')?.value).toBe('cli');
    expect(find(knobs, 'surfaces.enabled')?.value).toBe('cli');
    rmSync(dir, { recursive: true, force: true });
  });

  it('spend caps and quiet hours, from rot/budgets.json — sealed', () => {
    const dir = home();
    const knobs = listConfigKnobs(dir);
    expect(find(knobs, 'budgets.monthlyUsd')).toMatchObject({ value: '80', sealed: true });
    expect(find(knobs, 'budgets.perTenantDailyUsd')).toMatchObject({ value: '2', sealed: true });
    expect(find(knobs, 'budgets.quietHours.from')).toMatchObject({ value: '23:00', sealed: true });
    expect(find(knobs, 'budgets.quietHours.to')).toMatchObject({ value: '08:00', sealed: true });
    expect(find(knobs, 'budgets.quietHours.timezone')).toMatchObject({ value: 'UTC', sealed: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('the egress allowlist — sealed, and an empty one says so rather than showing nothing', () => {
    const dir = home();
    const knobs = listConfigKnobs(dir);
    const egress = find(knobs, 'egress.allow');
    expect(egress?.sealed).toBe(true);
    expect(egress?.value).toContain('vuoto');
    rmSync(dir, { recursive: true, force: true });
  });

  it('the policy matrix — sealed', () => {
    const dir = home();
    const knobs = listConfigKnobs(dir);
    expect(find(knobs, 'policy.defaultMaxTaint.low')).toMatchObject({ value: '3', sealed: true });
    expect(find(knobs, 'policy.defaultMaxTaint.medium')).toMatchObject({ value: '1', sealed: true });
    expect(find(knobs, 'policy.defaultMaxTaint.high')).toMatchObject({ value: '1', sealed: true });
    expect(find(knobs, 'policy.neverAtRuntime')?.value).toContain('rot.write');
    expect(find(knobs, 'policy.forbiddenForSystem')?.value).toContain('outward.send');
    rmSync(dir, { recursive: true, force: true });
  });

  it('where the secret resolved from, through the same chain doctor uses', () => {
    const dir = home();
    const knobs = listConfigKnobs(dir);
    const resolved = find(knobs, 'provider.apiKeyRef.resolved');
    expect(resolved?.value).toContain('home');
    // Il nome viene dal catalogo, non da una costante ripetuta qui: la fixture
    // sopra dichiara OpenRouter, quindi la chiave si chiama come dice
    // `PROVIDERS.openrouter.secretName`. Rileggerlo da lì e' cio' che fa
    // fallire questo test se il catalogo e `init` smettono di essere d'accordo.
    expect(resolved?.source).toBe(join(paths(dir).secrets, PROVIDERS.openrouter.secretName));
    expect(resolved?.sealed).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('never prints the secret itself — only the reference and where it resolved', () => {
    const dir = home();
    const knobs = listConfigKnobs(dir);
    const text = JSON.stringify(knobs);
    expect(text).not.toContain('sk-or-v1-fixture');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a knob missing from the listing is the failure this file exists to catch', () => {
  it('a field ConfigSchema allows but this install never set — models.deep, unrouted through any hand-written key', () => {
    // Not exercised by `runInit`, which never sets `models.deep`. Written
    // directly into config.json, the way an owner editing the file by hand
    // would set it — this is the proof that the listing is actually derived
    // from the live `Config` object rather than a fixed set of keys typed
    // into `inventory.ts`: nothing in that file mentions "models.deep", and
    // yet a value placed there must appear.
    const dir = home();
    const file = paths(dir).config;
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.models.deep = 'claude-opus-4-8';
    writeFileSync(file, JSON.stringify(config, null, 2));

    const knobs = listConfigKnobs(dir);
    expect(find(knobs, 'models.deep')?.value).toBe('claude-opus-4-8');
    rmSync(dir, { recursive: true, force: true });
  });

  it('search, unconfigured, still shows as a knob instead of not showing at all', () => {
    const dir = home();
    const knobs = listConfigKnobs(dir);
    expect(find(knobs, 'search')?.value).toContain('non configurata');
    rmSync(dir, { recursive: true, force: true });
  });

  it('search, once configured, replaces the placeholder with the real fields', () => {
    const dir = home();
    const file = paths(dir).config;
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.search = { provider: 'tavily', apiKeyRef: 'secret://search_api_key', maxResults: 5 };
    writeFileSync(file, JSON.stringify(config, null, 2));

    const knobs = listConfigKnobs(dir);
    expect(find(knobs, 'search.provider')?.value).toBe('tavily');
    expect(find(knobs, 'search.maxResults')?.value).toBe('5');
    // The placeholder row must not survive alongside the real ones — that
    // would be the "two files claim the same fact" shape ADR-0039 closed for
    // the budget, showing up again here as "two rows claim the same knob".
    expect(find(knobs, 'search')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the sealed marker is a fact about which file holds the value, not about whether it parses today', () => {
  it('stays sealed:true for the budget caps even when rot/budgets.json is broken and the value falls back', () => {
    const dir = home();
    writeFileSync(join(paths(dir).rot, 'budgets.json'), 'not json at all');

    const knobs = listConfigKnobs(dir);
    const monthly = find(knobs, 'budgets.monthlyUsd');
    // The compiled floor answered (BUDGET_FLOOR.monthlyUsd), proving this
    // reads the same fallback-aware loader `doctor` uses rather than a value
    // pinned at install time.
    expect(monthly?.value).toBe('80');
    expect(monthly?.sealed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('stays sealed:true for the policy matrix under the same failure', () => {
    const dir = home();
    writeFileSync(join(paths(dir).rot, 'policy.json'), 'not json at all');

    const knobs = listConfigKnobs(dir);
    const low = find(knobs, 'policy.defaultMaxTaint.low');
    expect(low?.value).toBe('3'); // POLICY_FLOOR
    expect(low?.sealed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('degrades the egress row instead of throwing when rot/egress.json is missing', () => {
    // Unlike the two loaders above, `loadEgress` throws rather than falling
    // back — an existing asymmetry this command has to survive, not fix.
    const dir = home();
    rmSync(join(paths(dir).rot, 'egress.json'));

    const knobs = listConfigKnobs(dir);
    const egress = find(knobs, 'egress.allow');
    expect(egress?.sealed).toBe(true);
    expect(egress?.value).toContain('fallback');
    rmSync(dir, { recursive: true, force: true });
  });

  it('every config.json-derived knob is unsealed, unconditionally', () => {
    const dir = home();
    const knobs = listConfigKnobs(dir);
    const configFile = paths(dir).config;
    for (const k of knobs.filter((k) => k.source === configFile)) {
      expect(k.sealed, `${k.key} should not be sealed — it lives in config.json`).toBe(false);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('every rot/-derived knob is sealed, unconditionally', () => {
    const dir = home();
    const knobs = listConfigKnobs(dir);
    const rotDir = paths(dir).rot;
    for (const k of knobs.filter((k) => k.source.startsWith(rotDir))) {
      expect(k.sealed, `${k.key} should be sealed — it lives under rot/`).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the value shown is a live read, not a snapshot', () => {
  it('reflects a hand-edited budgets.json without any code change', () => {
    const dir = home();
    const file = join(paths(dir).rot, 'budgets.json');
    const edited = JSON.parse(readFileSync(file, 'utf8'));
    edited.monthlyUsd = 12345;
    writeFileSync(file, JSON.stringify(edited, null, 2));

    expect(find(listConfigKnobs(dir), 'budgets.monthlyUsd')?.value).toBe('12345');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reflects a hand-edited egress.json without any code change', () => {
    const dir = home();
    const file = join(paths(dir).rot, 'egress.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, allow: ['api.example.com'] }, null, 2));

    expect(find(listConfigKnobs(dir), 'egress.allow')?.value).toBe('api.example.com');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reflects a hand-edited policy.json without any code change', () => {
    const dir = home();
    const file = join(paths(dir).rot, 'policy.json');
    const edited = JSON.parse(readFileSync(file, 'utf8'));
    edited.defaultMaxTaint = { low: 2, medium: 1, high: 0 };
    writeFileSync(file, JSON.stringify(edited, null, 2));

    const knobs = listConfigKnobs(dir);
    expect(find(knobs, 'policy.defaultMaxTaint.low')?.value).toBe('2');
    expect(find(knobs, 'policy.defaultMaxTaint.high')?.value).toBe('0');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('identity and evals/voice — the remaining two of ADR-0036\'s five sealed files', () => {
  it('both show up, sealed, without printing their content', () => {
    const dir = home();
    const knobs = listConfigKnobs(dir);
    const identity = find(knobs, 'identity');
    const voice = find(knobs, 'evals.voice');
    expect(identity?.sealed).toBe(true);
    expect(identity?.value).toContain('righe');
    expect(voice?.sealed).toBe(true);
    expect(voice?.value).toContain('casi');
    // The identity pact itself must never land in a settings listing.
    const raw = readFileSync(join(paths(dir).rot, 'identity.md'), 'utf8');
    const firstLine = raw.split('\n').find((l) => l.trim().length > 0);
    expect(identity?.value).not.toContain(firstLine ?? ' impossible ');
    rmSync(dir, { recursive: true, force: true });
  });
});
