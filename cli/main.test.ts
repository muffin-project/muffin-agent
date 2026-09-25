import DatabaseCtor from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  // Il figlio gira in una directory vuota, mai nel checkout: `cli/main.ts`
  // carica `${cwd}/.env` quando c'è (comodità di sviluppo documentata), e un
  // `.env` del founder nella radice del repo avvelenerebbe ogni scenario —
  // misurato il 18/09/2026: 18 rossi locali con exit 78
  // ("MUFFIN_API_KEY non è più una sorgente") su un albero verde in CI,
  // dove il checkout è pulito e il file non esiste. Lo script si trova via
  // percorso assoluto, quindi nessuna chiamata perde nulla.
  //
  // La directory vuota sta DENTRO la radice del repo, non in /tmp:
  // `node --import tsx` risolve il pacchetto dalla cwd verso l'alto, e in
  // /tmp il figlio muore con ERR_MODULE_NOT_FOUND (misurato: 37/39 rossi con
  // exit 1). Il loader invece legge solo `${cwd}/.env`, mai i genitori —
  // quindi una sottodirectory fresca non ha nessun `.env` e `tsx` risolve
  // comunque dai node_modules del checkout. Stessa assunzione che questi test
  // fanno già (`join(process.cwd(), 'cli/main.ts')`).
  const cwd = cwdSenzaDotenv();
  const result = spawnSync('node', ['--import', 'tsx', join(process.cwd(), 'cli/main.ts'), ...args], {
    env: { ...process.env, NO_COLOR: '1', ...env },
    input: stdin,
    encoding: 'utf8',
    timeout: 60_000,
    cwd,
  });
  return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' };
}

/** Una cwd fresca dentro il repo: niente `.env`, `tsx` risolvibile. Vedi sopra. */
function cwdSenzaDotenv(): string {
  const cwd = mkdtempSync(join(process.cwd(), 'muffin-test-cwd-'));
  homes.push(cwd);
  return cwd;
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

  it('non-TTY stays exactly as before: no machine interrogation, no new questions — only the new "what was decided" line', () => {
    // slice/init-interroga, owner's brief verbatim: "--yes/non-TTY: nessuna
    // domanda nuova — inferenza attuale + default attuali, MA la stampa dice
    // sempre cosa è stato deciso". spawnSync's piped stdin is never a TTY (no pty in this
    // repo), which is exactly the headless path every other test in this
    // describe already exercises — this one asserts the negative space
    // directly instead of only not-tripping-over it.
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['init'], 'sk-or-v1-realistic-openrouter-key');
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('Supervisore:');
    expect(r.err).not.toContain('Trovato un runtime locale');
    expect(r.err).not.toContain('Che famiglia di modello?');
    // The one new line that IS unconditional: what model got decided, and why.
    expect(r.err).toContain('modelli');
    expect(r.err).toContain('default compilato');
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(config.models.main).toBe('anthropic/claude-sonnet-5'); // unchanged compiled default
  });
});

describe('the owner-facing command surface', () => {
  it('keeps primary help small while the full control plane remains reachable', () => {
    const { dir, xdg } = scratchHome();
    const primary = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['--help']);
    expect(primary.code).toBe(0);
    expect(primary.out).toContain('muffin surface');
    expect(primary.out).not.toContain('muffin orientamento');
    expect(primary.out.split('\n').length).toBeLessThan(20);

    const all = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['help', '--all']);
    expect(all.out).toContain('muffin orientamento');
    expect(all.out).toContain('muffin secret');
  });

  it('generates completion from the same command vocabulary', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['completion', 'bash']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('surface');
    expect(r.out).toContain('orientamento');
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

  it('secret set converges an old home copy onto the one durable authority', () => {
    const { dir, xdg } = scratchHome();
    const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };

    const primo = muffin(env, ['secret', 'set', 'provider_api_key'], 'sk-in-home\n');
    expect(primo.code).toBe(0);
    expect(primo.out).toContain(join(xdg, 'muffin', 'secrets', 'provider_api_key'));

    // The old spelling remains compatible but cannot create a second location.
    const ombreggiata = muffin(env, ['secret', 'set', 'provider_api_key', '--persist'], 'sk-persisted\n');
    expect(ombreggiata.code).toBe(0);
    expect(ombreggiata.err).toBe('');
    expect(readFileSync(join(xdg, 'muffin', 'secrets', 'provider_api_key'), 'utf8')).toContain('sk-persisted');
    expect(existsSync(join(dir, 'secrets', 'provider_api_key'))).toBe(false);
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
    expect(r.err).toContain('muffin help --all');
  });

  it('--help is the compact owner surface; --all keeps the compatible control plane discoverable', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('muffin config');
    expect(r.out).toContain('muffin surface');
    const all = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['help', '--all']);
    expect(all.out).toContain('muffin config');
    expect(all.out).toContain('muffin memory');
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
   * La guardia rifiuta **la sorgente**, non il comando.
   *
   * Misurato sull'installazione dell'owner il 27/08: la chiave era già
   * registrata e valida, la variabile d'ambiente era un residuo che non
   * c'entrava con l'operazione richiesta, e `init` si è rifiutato di fare
   * qualunque cosa uscendo 78. Fail-closed sulla sorgente resta intero — quel
   * valore non viene letto — ma rifiutare anche il comando non aggiungeva
   * nessuna garanzia: aggiungeva un'installazione che non si può riparare
   * finché qualcuno non si ricorda di una variabile esportata mesi prima.
   */
  it('ma con una chiave già registrata prosegue, invece di rifiutare il comando', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-env-ok-'));
    const xdg = mkdtempSync(join(tmpdir(), 'muffin-env-ok-xdg-'));
    const KEY = 'sk-ant-api03-mai-nell-environment';
    try {
      const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };
      // Registrata come si deve: da stdin, mai da argv.
      expect(muffin(env, ['secret', 'set', 'provider_api_key'], 'sk-or-registrata-bene').code).toBe(0);

      const r = muffin({ ...env, MUFFIN_API_KEY: KEY }, ['init']);
      expect(r.code).not.toBe(78);
      // L'avvertimento resta, ed è ancora il primo: una variabile con dentro
      // una chiave è comunque una chiave da ruotare.
      expect(r.err).toContain('MUFFIN_API_KEY');
      expect(r.err).toMatch(/ruota/);
      expect(r.err).toContain('proseguo senza guardare la variabile');
      // E la variabile non è stata letta: né il valore né un suo pezzo escono.
      expect(r.err).not.toContain(KEY);
      expect(r.err).not.toContain(KEY.slice(0, 8));
      expect(existsSync(join(dir, 'config.json'))).toBe(true);
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

  it('accetta la chiave da un produttore LENTO — pass/op/gpg, non solo echo', () => {
    // Il test che mancava, e la ragione per cui il difetto è vissuto due giri:
    // una pipe immediata riempie il buffer prima della lettura e maschera
    // EAGAIN. Qui il produttore ritarda, come `pass show`/`op read`/`gpg -d`.
    const dir = mkdtempSync(join(tmpdir(), 'muffin-slow-'));
    const xdg = mkdtempSync(join(tmpdir(), 'muffin-slow-xdg-'));
    try {
      const cli = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');
      // `cwd` isolata come in `muffin()` qui sopra (stesso `.env` del
      // founder, stesso exit 78); `npx` trova comunque `tsx` perché il
      // PATH eredita `.bin` del checkout — la risoluzione del binario non
      // dipende dalla directory di lavoro.
      const cwd = mkdtempSync(join(tmpdir(), 'muffin-slow-cwd-'));
      homes.push(cwd);
      const r = spawnSync(
        'bash',
        ['-c', `(sleep 1; printf 'sk-ant-api03-produttore-lento') | npx tsx ${cli} init`],
        {
          env: {
            ...process.env,
            PATH: `${join(process.cwd(), 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`,
            MUFFIN_HOME: dir,
            XDG_CONFIG_HOME: xdg,
          },
          encoding: 'utf8',
          cwd,
        },
      );
      expect(r.status).toBe(0);
      expect(existsSync(join(xdg, 'muffin', 'secrets', 'provider_api_key'))).toBe(true);
      expect(existsSync(join(dir, 'secrets', 'provider_api_key'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  }, 60_000);

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

describe('muffin rot harden — spiega e propone, non esegue mai (wiring reale)', () => {
  it('su un install appena fatto: stampa il piano su stdout, exit 1, e non tocca mai il filesystem', () => {
    const { dir, xdg } = scratchHome();
    const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };
    muffin(env, ['init'], 'sk-ant-fixture');

    const before = readFileSync(join(dir, 'rot', 'manifest.json'), 'utf8');
    const r = muffin(env, ['rot', 'harden']);

    // 1, non 0 né 2: come `doctor` in warn, non un errore bloccante — ma
    // nemmeno "va tutto bene", perché non lo va ancora.
    expect(r.code).toBe(1);
    expect(r.out).toContain(join(dir, 'rot'));
    expect(r.out).toContain('sudo chown');
    expect(r.out).toContain('sys.shell');
    // Mai eseguito: il manifest — quindi rot/ — non cambia di una virgola.
    expect(readFileSync(join(dir, 'rot', 'manifest.json'), 'utf8')).toBe(before);
    expect(r.err).toBe('');
  });

  it('un secondo giro dopo `init --hardened` distingue "OS non ancora sistemato" dal caso precedente', () => {
    const { dir, xdg } = scratchHome();
    const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };
    muffin(env, ['init', '--hardened'], 'sk-ant-fixture');

    const r = muffin(env, ['rot', 'harden']);
    // Il file resta di proprietà dell'utente che ha girato `init`: dichiarare
    // "hardened" da solo non regge ancora, quindi il piano va comunque
    // proposto — è esattamente il difetto misurato che questa slice chiude.
    expect(r.code).toBe(1);
    expect(r.out).toContain('sudo chown');
    // E la sezione "dichiaralo in config.json" non compare più, perché quella
    // parte è già vera.
    expect(r.out).not.toContain('config.json');
  });

  it('`rot` senza sub, o con un sub sconosciuto, nomina harden nello usage', () => {
    const { dir, xdg } = scratchHome();
    const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };
    muffin(env, ['init'], 'sk-ant-fixture');
    const r = muffin(env, ['rot', 'bogus']);
    expect(r.code).toBe(78);
    expect(r.err).toContain('harden');
  });

  it('the advanced help keeps rot recovery discoverable without putting it in the owner help', () => {
    const { dir, xdg } = scratchHome();
    const r = muffin({ MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg }, ['help', '--all']);
    expect(r.out).toContain('muffin rot');
  });

  it('un errore che nessuno ha previsto resta una frase, non uno stack', () => {
    // Il pavimento, non un sostituto della gestione. Tre review separate hanno
    // trovato la stessa forma — un errore di filesystem ordinario e in cambio
    // uno stack trace di Node — e ogni volta la riparazione era un `try/catch`
    // in quel punto, e ogni volta il percorso nuovo dopo arrivava senza.
    // Il difetto era che `main` potesse lanciare affatto.
    //
    // Il caso qui è vero, non simulato: `MUFFIN_HOME` che punta a un file
    // esistente invece che a una directory. Nessuno lo aveva previsto, ed è
    // il punto.
    const { dir, xdg } = scratchHome();
    const asFile = join(dir, 'sono-un-file');
    writeFileSync(asFile, 'non sono una directory\n');
    const r = muffin({ MUFFIN_HOME: asFile, XDG_CONFIG_HOME: xdg }, ['init'], 'sk-ant-fixture');

    expect(r.code).toBe(70); // EX_SOFTWARE, non un crash senza codice
    expect(r.err).toContain('muffin:');
    expect(r.err).not.toContain('    at '); // niente frame di stack
    // E dice come ottenerlo, per chi lo stack lo vuole davvero.
    expect(r.err).toContain('MUFFIN_DEBUG=1');
  });

  it('un reseal senza permesso di scrivere il sigillo risponde, invece di vomitare uno stack', () => {
    // Il guasto che `muffin rot harden` **insegna** a produrre: il piano dice
    // all'owner che dopo l'indurimento il reseal «ti servirà un privilegio che
    // oggi non ti serve», quindi dimenticare `sudo` è l'errore previsto, non
    // uno esotico. `main()` non ha una cattura di livello superiore, e la
    // ricompensa per aver seguito il nostro consiglio era un `Error: EACCES`
    // con lo stack. Trovato dal judge su #138.
    const { dir, xdg } = scratchHome();
    const env = { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg };
    muffin(env, ['init'], 'sk-ant-fixture');

    // `seal` riscrive `rot/manifest.json` in place, e riscrivere un file che
    // esiste non chiede il permesso sulla directory: quello serve a creare o
    // cancellare voci. Quindi il permesso da togliere è quello del file.
    const manifest = join(dir, 'rot', 'manifest.json');
    chmodSync(manifest, 0o400);
    try {
      const r = muffin(env, ['rot', 'reseal']);
      expect(r.code).toBe(77); // EX_NOPERM, non un'uscita generica
      expect(r.err).toContain('permesso negato');
      expect(r.err).toContain('sudo');
      // Il punto della slice: una frase, non una traccia di stack.
      expect(r.err).not.toContain('at ');
      expect(r.err).not.toContain('EACCES:');
    } finally {
      chmodSync(manifest, 0o600); // altrimenti la pulizia del temp non riesce
    }
  });
});

/**
 * La cucitura, non il calcolo.
 *
 * `describeBuild` era provata da sola e `--version` poteva continuare a
 * stampare `0.0.0` secco: la suite restava verde. Terza volta in tre giorni che
 * la stessa mutazione sopravvive (#151, #157), quindi la stessa risposta —
 * il binario vero.
 */
describe('muffin --version dice quale build è', () => {
  it('porta il commit, non solo un numero che non identifica niente', () => {
    const r = muffin({}, ['--version']);
    expect(r.code).toBe(0);
    // Il SHA di questo checkout, letto qui e non assunto: il test vale
    // ovunque giri, e la mutazione che toglie la build muore comunque.
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).stdout.trim();
    expect(sha).not.toBe('');
    expect(r.out).toContain(sha.slice(0, 12));
  });
});

/**
 * Le domande di #117 esistono solo su un terminale, e un terminale non si
 * finge: `process.stdin.isTTY` è la condizione, quindi ogni test che passa da
 * una pipe prova il ramo headless — cioè l'altro.
 *
 * Da qui in giù il binario vero gira dietro un pty vero (`script`), che è
 * l'unico modo di vedere il ramo che l'owner incontra davvero.
 */
const SCRIPT_C_E = process.platform === 'linux';

/** Un argomento, al sicuro dentro `sh -c` — serve solo sul ramo util-linux. */
function shq(a: string): string {
  return `'${a.split("'").join(`'\\''`)}'`;
}

function haScript(): boolean {
  return spawnSync('script', ['--version'], { encoding: 'utf8' }).status !== null;
}

/**
 * Il binario, dietro un pty. Le due `script` non hanno la stessa riga di
 * comando: BSD (macOS) prende il comando come argv dopo il file, util-linux
 * (Linux, la produzione) vuole `-c "una stringa"`. Divergono e vanno scritte
 * entrambe, non scelte.
 *
 * `attesa` è il testo che deve comparire **sul pty** prima che il `^D` parta.
 * Non è una comodità di scrittura: è la sola cosa che rende questi test
 * deterministici, e la ragione sta in due meccanismi che si incastrano male.
 *
 * **1. La disciplina di linea mangia un `^D` che arriva troppo presto.** Fino
 * al 05/09/2026 lo stdin era un file che conteneva già il byte 0x04, quindi
 * `script` lo scriveva sul master entro pochi millisecondi — cioè mentre lo
 * slave era ancora in modo *canonico*, perché readline non era nemmeno
 * partita. In modo canonico Linux non consegna VEOF come byte: `n_tty` mette
 * in coda `__DISABLED_CHAR` (0x00) e lo marca come fine-riga. Quando poi
 * readline entra in raw mode, il cambio di canonicità azzera quei marcatori
 * (`n_tty_set_termios`) e in coda resta un **NUL**, non un `^D`. Misurato nel
 * container (ubuntu:24.04 arm64, util-linux 2.39.3, Node 22) intercettando
 * `process.stdin.push`: il byte visto dal processo è `00`, mai `04`.
 *
 * **2. Quello che chiudeva davvero il comando era l'EOF automatico di
 * `script`, e ha una scadenza di 2 secondi.** Quando il *suo* stdin finisce,
 * util-linux accoda un ultimo `^D` per il figlio, ma prima aspetta che la coda
 * dello slave si svuoti (`drain_child_buffers`, lib/pty-session.c): `poll` da
 * 10 ms + `xusleep(250000)`, **al massimo 8 giri**. Se entro ~2 s il figlio
 * non ha ancora letto — cioè non è ancora entrato in raw mode — `script`
 * scrive l'EOF lo stesso, in modo canonico, e quel byte diventa un secondo
 * NUL. Nessuno ne scriverà un terzo: il comando resta appeso per sempre.
 *
 * Da cui l'intermittenza del container e non del Mac: la soglia è «`muffin
 * init` arriva alla prima domanda entro 2 s». Misurato con 16 processi a
 * bruciare CPU, 12 corse: raw mode a +1666 ms → verde, a +1983/+2282/+3262/
 * +3623/+3835/+4321/+4387 ms → appeso, 7 su 12. Con `sleep 2.5` davanti a
 * `node`, 8 appesi su 8. Non è un difetto di `cli/prompt.ts`: un `^D` battuto
 * prima che il programma legga si perde allo stesso modo con `cat`, e su un
 * terminale vero l'owner ne batte semplicemente un altro.
 *
 * La riparazione è battere il `^D` **quando la domanda c'è**, che è anche ciò
 * che fa una persona. `node-pty` non è disponibile qui (nessuna dipendenza
 * nativa in questo repo), quindi il pty resta quello di `script` e a cambiare
 * è la tastiera: una fifo tenuta aperta da un processo che aspetta di vedere
 * `attesa` nella trascrizione del pty. Tenuta aperta fino alla fine, e non
 * chiusa subito dopo il byte: altrimenti `script` manderebbe comunque il suo
 * EOF automatico e la mutazione che toglie la memoria dell'EOF da
 * `cli/prompt.ts` sopravvivrebbe alla seconda domanda.
 */
function muffinTty(env: Record<string, string>, args: string[], attesa: string): { code: number; out: string } {
  const argv = ['node', '--import', 'tsx', join(process.cwd(), 'cli/main.ts'), ...args];
  const lavoro = mkdtempSync(join(tmpdir(), 'muffin-ctrl-d-'));
  const schermo = join(lavoro, 'schermo'); // tutto ciò che il pty ha prodotto
  // La terza divergenza fra le due `script`, e la sola che conta per #437.
  //
  // BSD (macOS) **chiude il pty** quando il suo stdin finisce: il figlio legge
  // 0 byte da un terminale che non c'è più, cioè un EOF che nessuna disciplina
  // di linea può mangiare, in qualunque modo si trovi. Un file con dentro il
  // `^D` basta, e infatti su macOS questo test non ha mai lampeggiato.
  //
  // util-linux no: il pty resta aperto, e l'unico EOF che il figlio vedrà è un
  // byte 0x04 sul master. Quel byte va battuto a domanda fatta — vedi sopra —
  // e per farlo la tastiera dev'essere una **fifo**, non un file già scritto.
  // Il contrario non si può: BSD `script` rifiuta una fifo su stdin con
  // «tcgetattr/ioctl: Operation not supported on socket» (misurato su macOS
  // 25.0, 05/09/2026), la stessa morte che un socket di `spawnSync` gli dà.
  let copione: string;
  if (SCRIPT_C_E) {
    const comando = `script -qec ${shq(argv.map(shq).join(' '))} /dev/null`;
    const tastiera = join(lavoro, 'tastiera'); // la fifo da cui `script` legge
    copione = [
      `mkfifo ${shq(tastiera)}`,
      `: > ${shq(schermo)}`,
      // Il dito sul Ctrl+D. `$$` dentro una subshell resta il pid della `sh`
      // (POSIX), quindi quando il test la uccide questo non resta orfano a
      // girare. Il tetto di 1200 giri è una rete: se la domanda non arriva mai
      // il `^D` parte comunque, e il test fallisce su un'asserzione invece che
      // sul timeout.
      `( i=0`,
      `  while kill -0 $$ 2>/dev/null && ! grep -qaF ${shq(attesa)} ${shq(schermo)} 2>/dev/null && [ $i -lt 1200 ]`,
      `  do sleep 0.1; i=$((i+1)); done`,
      `  printf '\\004'`,
      // Da qui la fifo resta aperta e non arriva altro: un solo Ctrl+D, che è
      // esattamente la claim del test a due domande. Chiuderla farebbe partire
      // l'EOF automatico di `script`, cioè un secondo Ctrl+D che il test non
      // ha battuto.
      `  while kill -0 $$ 2>/dev/null; do sleep 0.2; done`,
      `) > ${shq(tastiera)} 2>/dev/null < /dev/null &`,
      `dita=$!`,
      `${comando} < ${shq(tastiera)} > ${shq(schermo)} 2>&1`,
      `esito=$?`,
      `kill $dita 2>/dev/null`,
      `cat ${shq(schermo)}`,
      `exit $esito`,
    ].join('\n');
  } else {
    // Lo stdin dev'essere comunque un **file vero**: dentro un worker di
    // vitest quello che `spawnSync` fornisce è un socket, e BSD `script` ci
    // chiama sopra `tcgetattr` e muore prima di aprire il pty.
    const comando = `script -q /dev/null ${argv.map(shq).join(' ')}`;
    const ctrlD = join(lavoro, 'eof');
    writeFileSync(ctrlD, '\u0004');
    copione = `${comando} < ${shq(ctrlD)}`;
  }
  const r = spawnSync('sh', ['-c', copione], {
    // 120 s, non 60: nel vecchio runner containerizzato, con gli altri tre job
    // in parallelo, `script` + `muffin init` a freddo passavano i 60 s e il
    // test diceva «appeso» (-1) a un comando che stava solo finendo tardi
    // (05/09/2026, due giri). Il tetto serve solo a non aspettare per
    // sempre, non a misurare la velocita' della macchina.
    //
    // `cwdSenzaDotenv()` per la stessa ragione del `muffin()` headless qui
    // sopra: il figlio eredita la directory di vitest (la radice del repo in
    // locale) e un `.env` del founder lì dentro avvelena gli scenari di
    // `init` con exit 78. `lavoro` resta per gli artefatti (fifo, schermo:
    // tutto a percorsi assoluti), la cwd è una directory a parte — `lavoro`
    // in /tmp non risolverebbe `tsx` (vedi `muffin()` sopra).
    env: { ...process.env, NO_COLOR: '1', ...env }, encoding: 'utf8', timeout: 120_000,
    cwd: cwdSenzaDotenv(),
  });
  // La trascrizione si legge dal **file**, non da `r.stdout`: sul ramo
  // util-linux lo stdout della `sh` arriva tutto in fondo, con un `cat`, e un
  // comando ucciso dal timeout non ci arriva mai. Leggendo il file, un
  // «appeso» dice ancora fin dove era arrivato — cioè `r.code === -1` **con**
  // la domanda sul runtime locale dentro `r.out`, che è esattamente la
  // diagnosi su cui #437 poggiava.
  const trascrizione = existsSync(schermo) ? readFileSync(schermo, 'utf8') : `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // Le sequenze di controllo del pty non sono il contenuto: togliere quelle e i
  // CR rende le asserzioni leggibili quanto quelle del ramo headless.
  const pulito = trascrizione
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r/g, '\n');
  return { code: r.status ?? -1, out: pulito };
}

/**
 * `MUFFIN_LOCAL_RUNTIME_URL` puntato su una porta chiusa: senza, **cosa**
 * questi test esercitano dipende da se chi li esegue ha ollama acceso, e con
 * ollama acceso `init` fa una domanda in piu' prima della chiave. Misurato il
 * 28/08/2026: e' esattamente cosi' che il blocco su Ctrl+D e' rimasto
 * invisibile per settimane.
 */
const SENZA_RUNTIME_LOCALE = { MUFFIN_LOCAL_RUNTIME_URL: 'http://127.0.0.1:1/v1' };

/**
 * Un `/v1/models` che risponde, in un processo separato — vedi il commento nel
 * test che lo usa per il perche' del processo separato.
 *
 * La porta la sceglie il figlio e la scrive su un file: chiederla al sistema
 * qui e poi passarla al figlio lascerebbe una finestra in cui qualcun altro se
 * la prende.
 */
function runtimeFinto(): { porta: number; ferma: () => void } {
  const marca = join(mkdtempSync(join(tmpdir(), 'muffin-runtime-finto-')), 'porta');
  const codice =
    `const {createServer}=require('node:http');const {writeFileSync}=require('node:fs');` +
    `const s=createServer((_q,r)=>{r.writeHead(200,{'content-type':'application/json'});` +
    `r.end(JSON.stringify({data:[{id:'qwen3:8b'}]}))});` +
    `s.listen(0,'127.0.0.1',()=>writeFileSync(${JSON.stringify(marca)},String(s.address().port)));`;
  const figlio = spawn('node', ['-e', codice], { stdio: 'ignore' });
  // Attesa sincrona: questo processo non puo' await-are, perche' subito dopo
  // chiamera' `spawnSync` e bloccherebbe comunque.
  const scadenza = Date.now() + 10_000;
  while (!existsSync(marca) && Date.now() < scadenza) spawnSync('sleep', ['0.05']);
  if (!existsSync(marca)) {
    figlio.kill();
    throw new Error('il runtime finto non e partito');
  }
  return { porta: Number(readFileSync(marca, 'utf8')), ferma: () => figlio.kill() };
}

describe.skipIf(!haScript())('muffin init su un terminale vero', () => {
  it('chiede la chiave — la domanda esiste solo qui', () => {
    // Il ramo headless di sopra non la stampa mai. Se `cmdInit` smettesse di
    // chiedere, nessuno di quei test se ne accorgerebbe.
    const { dir, xdg } = scratchHome();
    const r = muffinTty(
      { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg, HOME: dir, ...SENZA_RUNTIME_LOCALE },
      ['init'],
      'Chiave API',
    );
    expect(r.out).toContain('Chiave API');
  });

  it('Ctrl+D alla prima domanda finisce come il ramo headless, non come un crash', () => {
    // Prima: uscita 13 e `Detected unsettled top-level await`, con NIENTE
    // scritto — nemmeno le directory. `rl.question` non chiama il callback su
    // EOF, e la promise non si decideva.
    const { dir, xdg } = scratchHome();
    const r = muffinTty(
      { MUFFIN_HOME: dir, XDG_CONFIG_HOME: xdg, HOME: dir, ...SENZA_RUNTIME_LOCALE },
      ['init'],
      'Chiave API',
    );

    expect(r.out).not.toContain('unsettled top-level await');
    expect(r.code).not.toBe(13);
    // Init incompleto è 1, e dice cosa manca e come riprendere: è esattamente
    // ciò che fa una pipe senza chiave, che è il punto — Ctrl+D a una domanda
    // che dice «invio per saltare» non può fare peggio di Invio.
    expect(r.code).toBe(1);
    expect(r.out).toContain('api key');
    expect(existsSync(join(dir, 'config.json'))).toBe(true);
  });

  /**
   * **Un EOF vale una volta sola per il processo, non per la domanda.**
   *
   * Con un runtime locale acceso `init` fa DUE domande: prima «uso il runtime
   * locale?», poi la chiave. Il Ctrl+D veniva consumato dalla prima; la
   * seconda apriva una nuova interfaccia readline sullo stesso stdin, da cui
   * non sarebbe mai piu' arrivato ne' un dato ne' un `close` — e `init`
   * restava appeso **per sempre**. Misurato il 28/08/2026 sulla macchina
   * dell'owner: 60s di timeout, exit -1, con ollama in esecuzione.
   *
   * In raw mode readline sintetizza l'EOF dal carattere `^D` e il tty non
   * emette mai `end`, quindi lo stream non lo sa: `readableEnded` resta
   * `false`. Chi deve ricordarlo e' `cli/prompt.ts`.
   *
   * Il finto runtime e' un server HTTP vero sul loopback, perche' il difetto
   * vive nel ramo che esiste **solo** quando la sonda trova qualcosa.
   */
  it('con un runtime locale acceso, un solo Ctrl+D chiude comunque — non resta appeso', () => {
    // Il finto runtime gira in un **altro processo**, e non e' un dettaglio:
    // `muffinTty` usa `spawnSync`, che blocca l'event loop di questo processo
    // finche' il comando non finisce. Un server aperto qui dentro non
    // accetterebbe mai la connessione della sonda, e il test passerebbe
    // provando il ramo sbagliato — quello a una domanda sola.
    const { porta, ferma } = runtimeFinto();
    try {
      const { dir, xdg } = scratchHome();
      const r = muffinTty(
        {
          MUFFIN_HOME: dir,
          XDG_CONFIG_HOME: xdg,
          HOME: dir,
          MUFFIN_LOCAL_RUNTIME_URL: `http://127.0.0.1:${String(porta)}/v1`,
        },
        ['init'],
        // Il Ctrl+D parte alla **prima** domanda, quella sul runtime locale:
        // e' quella che lo consumava lasciando la seconda appesa.
        'runtime locale',
      );
      // La domanda in piu' c'e' davvero: senza, questo test non proverebbe
      // niente sul caso a due domande.
      expect(r.out).toContain('runtime locale');
      // E il comando e' finito. -1 significa ucciso dal timeout, cioe' appeso.
      expect(r.code).not.toBe(-1);
      expect(existsSync(join(dir, 'config.json'))).toBe(true);
    } finally {
      ferma();
    }
  });
});
