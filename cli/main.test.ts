import DatabaseCtor from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '../core/memory/store.js';

/**
 * The wiring, from the command line the owner actually types — the same
 * reasoning `cli/gateway.test.ts` states: unit tests already prove
 * `chooseProvider`'s logic, and none of them would notice if `cmdInit`
 * stopped calling it. This spawns the real `cli/main.ts`.
 */

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function scratchHome(): { dir: string; xdg: string } {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-main-cli-'));
  homes.push(dir);
  return { dir, xdg: join(dir, '.config-xdg') };
}

function muffin(env: Record<string, string>, args: string[], stdin = ''): { code: number; out: string; err: string } {
  const result = spawnSync('node', ['--import', 'tsx', join(process.cwd(), 'cli/main.ts'), ...args], {
    env: { ...process.env, NO_COLOR: '1', ...env },
    input: stdin,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' };
}

describe('muffin init infers the provider from the key — headless, no TTY required', () => {
  it('an OpenRouter-shaped key ends up as openai-compat with the OpenRouter base URL, and says so', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin(
      { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg },
      ['init'], 'sk-or-v1-realistic-openrouter-key',
    );
    expect(r.code).toBe(0);
    // Said, not just done: ADR-0036's "never decide silently" half of the fix.
    expect(r.err).toContain('openai-compat');
    expect(r.err).toContain('dedotto dalla chiave');

    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(config.provider.kind).toBe('openai-compat');
    expect(config.provider.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('an Anthropic-shaped key ends up as anthropic, and says so', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['init'], 'sk-ant-api03-realistic');
    expect(r.code).toBe(0);
    expect(r.err).toContain('dedotto dalla chiave');

    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(config.provider.kind).toBe('anthropic');
    expect(config.provider.baseUrl).toBeUndefined();
  });

  it('an unrecognised key still defaults to anthropic, but now names the reason instead of staying silent', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['init'], 'xoxb-unknown-shape');
    expect(r.code).toBe(0);
    expect(r.err).toContain('provider');
    expect(r.err).toMatch(/non è sk-or|default/);

    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(config.provider.kind).toBe('anthropic');
  });

  it('an explicit --provider wins over a key that would have inferred the opposite', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin(
      { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg },
      ['init', '--provider', 'anthropic'], 'sk-or-v1-would-have-inferred-openai-compat',
    );
    expect(r.code).toBe(0);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(config.provider.kind).toBe('anthropic');
  });

  it('a pasted Telegram bot token is rejected even under an explicit --provider, not just when inference would have run', () => {
    // The original guard only ran inside `if (apiKey && !providerFlag)` — an
    // explicit --provider skipped the Telegram-shape check entirely, so a
    // bot token pasted alongside --provider anthropic would have been stored
    // as the model key. Reproduced by asserting the negative directly against
    // the real binary: no secret file should exist afterward.
    const { dir, xdg } = scratchHome();
    const r = muffin(
      { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg },
      ['init', '--provider', 'anthropic'], '8712345678:AAExampleBotTokenLooksLikeThis_abcdef',
    );
    expect(r.err).toContain('token');
    expect(r.err.toLowerCase()).toContain('telegram');
    expect(r.code).toBe(1); // incomplete: no key was actually stored
    expect(() => readFileSync(join(dir, 'secrets', 'provider_api_key'))).toThrow();
  });

  it('a persisted key (not passed fresh) is inferred exactly the same way — the ADR-0039 path', () => {
    const { dir, xdg } = scratchHome();
    // First run stores the key with --persist, outside the home.
    const first = muffin(
      { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg },
      ['secret', 'set', 'provider_api_key', '--persist'],
      'sk-or-v1-persisted-key\n',
    );
    expect(first.code).toBe(0);

    // Second run: no --api-key, no MUFFIN_API_KEY — the only source is the
    // persisted secret `locateSecret` finds.
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['init']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('openai-compat');
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(config.provider.kind).toBe('openai-compat');
  });
});

describe('selective Italian command aliases (ADR-0036)', () => {
  it('memoria behaves exactly like memory', () => {
    const { dir, xdg } = scratchHome();
    const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };
    const alias = muffin(env, ['memoria']);
    const canonical = muffin(env, ['memory']);
    expect(alias.code).toBe(canonical.code);
    expect(alias.err).toBe(canonical.err);
  });

  it('lavori behaves exactly like jobs', () => {
    const { dir, xdg } = scratchHome();
    const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };
    muffin(env, ['init'], 'sk-ant-fixture');
    const alias = muffin(env, ['lavori', 'list']);
    const canonical = muffin(env, ['jobs', 'list']);
    expect(alias.code).toBe(canonical.code);
    expect(alias.out).toBe(canonical.out);
  });

  it('segreto behaves exactly like secret', () => {
    const { dir, xdg } = scratchHome();
    const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };
    const alias = muffin(env, ['segreto', 'set']); // missing NAME on purpose — usage path
    const canonical = muffin(env, ['secret', 'set']);
    expect(alias.code).toBe(78);
    expect(alias.code).toBe(canonical.code);
    expect(alias.err).toBe(canonical.err);
  });

  it('a word that merely resembles an alias is not resolved — the map is exact, not fuzzy', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['memorie']);
    expect(r.code).toBe(78);
    expect(r.err).toContain('comando sconosciuto: memorie');
  });

  it('English names keep working — no alias shadows its own canonical command', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['config']);
    // `config` is deliberately NOT aliased (ADR-0036: "config" stays English)
    // — this just confirms the alias table did not accidentally intercept it.
    expect(r.code === 0 || r.code === 78).toBe(true);
    expect(r.err).not.toContain('comando sconosciuto');
  });
});

describe('the top-level error and usage surface, in Italian (ADR-0036)', () => {
  it('an unknown command names what was typed, in Italian, and still shows usage', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['frobnicate']);
    expect(r.code).toBe(78);
    expect(r.err).toContain('comando sconosciuto: frobnicate');
    expect(r.err).toContain('muffin config');
  });

  it('--help lists muffin config and the alias table', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('muffin config');
    expect(r.out).toContain('memoria=memory');
    expect(r.out).toContain('lavori=jobs');
    expect(r.out).toContain('segreto=secret');
  });
});

describe('muffin memory review — the register the owner can finally act on', () => {
  /**
   * Through the real argv, because that is the part no unit test covers: the
   * verbs live in a `switch` in this file, and `cli/memory.test.ts` calls the
   * functions directly. A subcommand that exists and is not routed is the same
   * defect as a mechanism with no caller, one layer up.
   *
   * The home needs no `init`: these two verbs open the database and nothing
   * else — no provider, no key, no network — which is the property that makes
   * them usable in the moment you actually need them.
   */
  function seedContradiction(dir: string): { existing: number; incoming: number } {
    const db = new DatabaseCtor(join(dir, 'muffin.db'));
    const store = new MemoryStore(db);
    const episodeId = store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
      content: 'il commercialista ora è Lucia', trustTier: 0, createdAt: '2026-08-13T10:00:00Z',
    });
    const subjectId = store.upsertEntity('host', 'owner', 'person', '2026-08-13T10:00:00Z');
    const believe = (object: string, at: string) =>
      store.addFact({
        tenantId: 'host', subjectId, predicate: 'accountant', objectValue: object,
        episodeId, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: at,
      });
    const existing = believe('Marco', '2026-06-01T10:00:00Z');
    const incoming = believe('Lucia', '2026-08-13T10:00:00Z');
    store.recordReview({
      tenantId: 'host', kind: 'contradiction', subject: 'owner', predicate: 'accountant',
      existingFactId: existing, incomingFactId: incoming,
      detail: 'nessuna delle due frasi dice quando', createdAt: '2026-08-13T10:00:01Z',
    });
    db.close();
    return { existing, incoming };
  }

  it('lists the open question, answers it, and then has nothing left to ask', () => {
    const { dir, xdg } = scratchHome();
    const { existing, incoming } = seedContradiction(dir);
    const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };

    const listed = muffin(env, ['memory', 'review']);
    // Exit 1 is "someone should look", the same code `check` uses for warnings:
    // scriptable, and the only way a shell can tell an install with open
    // questions from one without.
    expect(listed.code).toBe(1);
    expect(listed.out).toContain('Marco');
    expect(listed.out).toContain(`muffin memory review keep ${incoming}`);

    const kept = muffin(env, ['memory', 'review', 'keep', String(incoming)]);
    expect(kept.code).toBe(0);
    expect(kept.out).toContain(`ritiro #${existing}`);

    const after = muffin(env, ['memory', 'review']);
    expect(after.code).toBe(0);
    expect(after.out).toContain('niente da decidere');
  });
});

describe('muffin memory search — the temporal boundary is checked before anything opens', () => {
  /**
   * The three failure paths of C4/C6, through the real argv. All three are
   * rejected before `cmdMemorySearch` ever calls `buildRuntime`, which is what
   * makes them testable without a provider or an embedder: a home that was
   * never even `init`-ed proves the point on its own — if the check reached
   * the runtime, spawning against an un-initialised home would fail for an
   * unrelated reason (no config) and these tests would be exercising the wrong
   * failure.
   */
  it('rejects an unreadable --as-of instead of silently searching without it', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['memory', 'search', 'test', '--as-of', 'not-a-date']);
    expect(r.code).toBe(78);
    expect(r.err).toContain('non è una data leggibile');
  });

  it('rejects --since after --until — a window that cannot contain anything', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, [
      'memory', 'search', 'test', '--since', '2026-08-01', '--until', '2026-01-01',
    ]);
    expect(r.code).toBe(78);
    expect(r.err).toContain('non può contenere niente');
  });

  it('rejects an --as-of that has not happened yet', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['memory', 'search', 'test', '--as-of', '2099-01-01']);
    expect(r.code).toBe(78);
    expect(r.err).toContain('nel futuro');
  });

  it('does not reject --history even though EVERY_INSTANT sorts after any date lexicographically', () => {
    // 'all' > any ISO date string under a naive `>` comparison ('a' > '2' in
    // ASCII) — the same risk `checkTemporalWindow`'s unit tests cover, checked
    // again here at the boundary that actually calls it from argv.
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['memory', 'search', 'test', '--history']);
    // Never 78: an un-initialised home fails later, trying to open the
    // runtime — the one failure mode this test must not produce is the
    // temporal-boundary rejection.
    expect(r.code).not.toBe(78);
  });
});

describe('muffin memory search — --surface and --around actually reach a result', () => {
  /**
   * U1's other half. The tests above prove three ways argv gets rejected
   * *before* `cmdMemorySearch` calls `buildRuntime`; none of them prove a
   * flag that argv accepts ever arrives at a real result. `--surface` and
   * `--around` are parsed into `values` two subcommand-switch cases up
   * (`cmdMemory`'s `search` branch, `cli/main.ts`) and folded into the options
   * object `cmdMemorySearch` receives — a step no unit test reaches, because
   * `cli/memory.test.ts` calls `cmdMemorySearch` directly and skips exactly
   * this argv-to-options translation.
   */
  it('--surface reaches recall through the real binary, not just through cmdMemorySearch directly', () => {
    const { dir, xdg } = scratchHome();
    const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };
    expect(muffin(env, ['init'], 'sk-ant-api03-fake-main-cli-surface').code).toBe(0);

    const db = new DatabaseCtor(join(dir, 'muffin.db'));
    const store = new MemoryStore(db);
    store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'promemoria dal terminale', trustTier: 0, createdAt: '2026-08-01T10:00:00Z',
    });
    store.addEpisode({
      tenantId: 'host', connector: 'telegram', threadKey: 'g', role: 'user',
      kind: 'message', content: 'promemoria da telegram', trustTier: 0, createdAt: '2026-08-01T10:00:00Z',
    });
    db.close();

    const r = muffin(env, ['memory', 'search', 'promemoria', '--surface', 'telegram']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('da telegram');
    expect(r.out).not.toContain('dal terminale');
  });

  it('--around reaches recall through the real binary, attaching the surrounding messages', () => {
    const { dir, xdg } = scratchHome();
    const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };
    expect(muffin(env, ['init'], 'sk-ant-api03-fake-main-cli-around').code).toBe(0);

    const db = new DatabaseCtor(join(dir, 'muffin.db'));
    const store = new MemoryStore(db);
    const fill = (content: string, minute: number) =>
      store.addEpisode({
        tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
        kind: 'message', content, trustTier: 0, createdAt: `2026-08-01T10:0${minute}:00Z`,
      });
    fill('un messaggio prima', 1);
    const anchor = fill('il codice segreto è ZK-9', 2);
    fill('un messaggio dopo', 3);
    db.close();

    const r = muffin(env, ['memory', 'search', 'codice segreto', '--around', '1']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`intorno a #${anchor}`);
    expect(r.out).toContain('un messaggio prima');
    expect(r.out).toContain('un messaggio dopo');
  });
});

describe('una chiave non passa mai per argv né per l\'environment (owner 2026-08-18)', () => {
  it('rifiuta MUFFIN_API_KEY nominando solo la variabile, mai il valore', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-env-'));
    const xdg = mkdtempSync(join(tmpdir(), 'muffin-env-xdg-'));
    const KEY = 'sk-ant-api03-mai-nell-environment';
    try {
      const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg, MUFFIN_API_KEY: KEY }, ['init']);
      expect(r.code).toBe(78);
      expect(r.err).toContain('MUFFIN_API_KEY');
      expect(r.err).toMatch(/secret set|muffin init/);
      // Il messaggio non deve descrivere il valore: né il valore, né un
      // prefisso, né la lunghezza — «mostrabile» include «deducibile».
      expect(r.err).not.toContain(KEY);
      expect(r.err).not.toContain(KEY.slice(0, 8));
      expect(r.err).not.toMatch(new RegExp(`\\b${KEY.length}\\b`));
      expect(existsSync(join(dir, 'config.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  /**
   * Il difetto che questo test impedisce: `muffin init --api-key sk-…` metteva
   * una chiave di classe 1 in `argv`, cioè nella shell history e nel `ps` di
   * chiunque sulla macchina — e un segreto è un segreto anche **prima** di
   * essere registrato nel backend. Non è deprecato con un avviso: un avviso
   * arriva quando la history l'ha già scritta.
   */
  it('rifiuta --api-key con un valore, e dice come passarla', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-argv-'));
    const xdg = mkdtempSync(join(tmpdir(), 'muffin-argv-xdg-'));
    try {
      const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['init', '--api-key', 'sk-ant-api03-mai-in-argv']);
      expect(r.code).toBe(78);
      expect(r.err).toMatch(/argv/i);
      expect(r.err).toMatch(/stdin/);
      // E non ha scritto niente: un rifiuto che installa metà home sarebbe
      // peggio del difetto.
      expect(existsSync(join(dir, 'config.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  it('accetta la stessa chiave da stdin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-stdin-'));
    const xdg = mkdtempSync(join(tmpdir(), 'muffin-stdin-xdg-'));
    try {
      const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['init'], 'sk-ant-api03-da-stdin-va-bene');
      expect(r.code).toBe(0);
      expect(existsSync(join(dir, 'config.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});
