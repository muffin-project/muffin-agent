import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import { isSameOrNestedPath, resolveLocalHome, runInit } from './init.js';
import { CONFIG_SCHEMA_VERSION, ConfigError, loadConfig, paths, saveConfig, writeSecret } from '../core/config/config.js';
import { muffinWorkspace } from '../core/config/workspace.js';
import { readDefaultsRegistry } from '../core/config/defaults-drift.js';
import { sha256 } from '../core/rot/verify.js';

/**
 * The `--local` guard (DAY-1 requirement A9), in isolation from the CLI around it: a
 * throwaway rehearsal home must never be able to land on, or under, the real
 * one — checked through symlinks and through directories that do not exist
 * yet, since the whole point of `--local` is a directory `muffin init` is
 * about to create.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe('resolveLocalHome', () => {
  it('defaults to ~/.muffin-local when no directory is given', () => {
    expect(resolveLocalHome(undefined)).toBe(join(homedir(), '.muffin-local'));
  });

  it('resolves an explicit directory relative to the cwd', () => {
    expect(resolveLocalHome('some/relative/dir')).toBe(resolve('some/relative/dir'));
  });

  it('leaves an explicit absolute directory as-is', () => {
    expect(resolveLocalHome('/tmp/whatever-local-home')).toBe(resolve('/tmp/whatever-local-home'));
  });
});

describe('isSameOrNestedPath', () => {
  it('is true for the identical directory', () => {
    const base = scratchDir('muffin-init-guard-same-');
    expect(isSameOrNestedPath(base, base)).toBe(true);
  });

  it('is true for a directory nested several levels deep that does not exist yet', () => {
    const base = scratchDir('muffin-init-guard-base-');
    const candidate = join(base, 'a', 'b', 'c'); // none of a/b/c exist
    expect(isSameOrNestedPath(candidate, base)).toBe(true);
  });

  it('is false for an unrelated sibling directory', () => {
    const base = scratchDir('muffin-init-guard-base2-');
    const sibling = scratchDir('muffin-init-guard-sibling-');
    expect(isSameOrNestedPath(sibling, base)).toBe(false);
    expect(isSameOrNestedPath(join(sibling, 'nested', 'deeper'), base)).toBe(false);
  });

  it('follows a symlink to the real target before comparing — a link cannot disguise nesting', () => {
    const base = scratchDir('muffin-init-guard-real-');
    const outside = scratchDir('muffin-init-guard-outside-');
    const link = join(outside, 'looks-unrelated');
    symlinkSync(base, link, 'dir');
    // The string `link` shares no prefix with `base` at all — only realpath
    // resolution reveals that it names the same directory, or a directory
    // that will sit inside it once created.
    expect(isSameOrNestedPath(link, base)).toBe(true);
    expect(isSameOrNestedPath(join(link, 'not-yet-created'), base)).toBe(true);
  });

  it('a symlink elsewhere that merely resembles the base by name is not nested', () => {
    const base = scratchDir('muffin-init-guard-real2-');
    const decoyTarget = scratchDir('muffin-init-guard-decoy-target-');
    const outside = scratchDir('muffin-init-guard-outside2-');
    const link = join(outside, 'also-looks-unrelated');
    symlinkSync(decoyTarget, link, 'dir');
    expect(isSameOrNestedPath(link, base)).toBe(false);
  });
});

describe('runInit — the defaults registry it hands `muffin doctor` (core/config/defaults-drift.ts)', () => {
  afterEach(() => vi.unstubAllEnvs());

  function freshHome(): string {
    const dir = scratchDir('muffin-init-registry-');
    // Same isolation doctor.test.ts's own `home()` fixture uses: without it,
    // the persistent secret backend defaults to this machine's real
    // `~/.config`, and a test's result would depend on whoever runs it.
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
    return dir;
  }

  it('records the hash of every file it actually copies, matching the bytes on disk', () => {
    const dir = freshHome();
    runInit({ home: dir, apiKey: 'sk-never-called' });

    const reg = readDefaultsRegistry(dir);
    expect(reg).not.toBeNull();
    const byPath = new Map((reg?.files ?? []).map((f) => [f.path, f.sha256]));
    for (const relPath of ['persona.md', 'voice.md', 'rot/identity.md', 'rot/policy.json', 'rot/egress.json', 'rot/budgets.json']) {
      const installed = join(dir, ...relPath.split('/'));
      expect(byPath.get(relPath), `no registry entry for ${relPath}`).toBe(sha256(readFileSync(installed)));
    }
  });

  it('never re-stamps a file a second `init` found already present — the exact case that would poison rule 1', () => {
    const dir = freshHome();
    runInit({ home: dir, apiKey: 'sk-never-called' });
    const original = readDefaultsRegistry(dir);
    const originalPersonaHash = original?.files.find((f) => f.path === 'persona.md')?.sha256;
    expect(originalPersonaHash).toBeTruthy();

    // The owner edits persona.md by hand, then runs `muffin init` again
    // (e.g. to pick up a config fix) — WITHOUT --force. `installFile` leaves
    // an existing file alone, so the registry must leave its entry alone too.
    writeFileSync(paths(dir).persona, "la mia versione, scritta a mano\n");
    runInit({ home: dir, apiKey: 'sk-never-called' });

    const after = readDefaultsRegistry(dir);
    const afterPersonaHash = after?.files.find((f) => f.path === 'persona.md')?.sha256;
    expect(afterPersonaHash).toBe(originalPersonaHash);
    expect(afterPersonaHash).not.toBe(sha256(readFileSync(paths(dir).persona)));
  });

  it('does re-stamp on `--force`, which really did overwrite the file', () => {
    const dir = freshHome();
    runInit({ home: dir, apiKey: 'sk-never-called' });
    writeFileSync(paths(dir).persona, "la mia versione, scritta a mano\n");
    runInit({ home: dir, apiKey: 'sk-never-called', force: true });

    const reg = readDefaultsRegistry(dir);
    const personaHash = reg?.files.find((f) => f.path === 'persona.md')?.sha256;
    // --force overwrote persona.md back to the shipped default, and the
    // registry now records THAT content, not the hand-written one.
    expect(personaHash).toBe(sha256(readFileSync(paths(dir).persona)));
    expect(readFileSync(paths(dir).persona, 'utf8')).not.toContain('scritta a mano');
  });
});

/**
 * Il nome della chiave viene dal catalogo dei provider, e la migrazione sta
 * tutta nell'ordine in cui si cerca.
 *
 * `provider_api_key` non dice quale provider, e con due provider in albero la
 * stessa installazione avrebbe due chiavi e un nome solo per descriverle. Ma un
 * rename secco spegne ogni installazione esistente: `config.provider.apiKeyRef`
 * punta al nome vecchio, e nessuno lo riscrive. Quindi si scrive il nome nuovo
 * e si legge il vecchio finché esiste.
 */
describe('il nome della chiave dice di chi è', () => {
  it('un install nuovo su OpenRouter registra `openrouter_api_key`', () => {
    const dir = scratchDir('muffin-init-nome-nuovo-');
    runInit({ home: dir, apiKey: 'sk-or-nuova', provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1' });

    const config = JSON.parse(readFileSync(paths(dir).config, 'utf8')) as { provider: { apiKeyRef: string } };
    expect(config.provider.apiKeyRef).toBe('secret://openrouter_api_key');
    expect(readFileSync(join(dir, 'secrets', 'openrouter_api_key'), 'utf8').trim()).toBe('sk-or-nuova');
  });

  /**
   * Il caso che il rename romperebbe: la chiave c'è già, col nome vecchio.
   * `init` deve **puntarci**, non scrivere un riferimento a un file che non
   * esiste — che è esattamente come si spegne un'installazione funzionante.
   */
  it("e su un'installazione che ha già la chiave col nome vecchio, il riferimento resta quello", () => {
    const dir = scratchDir('muffin-init-nome-vecchio-');
    runInit({ home: dir, apiKey: 'sk-vecchia' }); // provider di default: nome generico
    expect(readFileSync(join(dir, 'secrets', 'provider_api_key'), 'utf8').trim()).toBe('sk-vecchia');

    // Secondo giro, stavolta dichiarando OpenRouter, e senza ripassare la chiave.
    runInit({ home: dir, provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', force: true });

    const config = JSON.parse(readFileSync(paths(dir).config, 'utf8')) as { provider: { apiKeyRef: string } };
    expect(config.provider.apiKeyRef).toBe('secret://provider_api_key');
    // E non ha fabbricato una seconda copia col nome nuovo.
    expect(existsSync(join(dir, 'secrets', 'openrouter_api_key'))).toBe(false);
  });

  it('fuori dal catalogo il nome generico resta quello giusto', () => {
    const dir = scratchDir('muffin-init-nome-locale-');
    runInit({ home: dir, apiKey: 'sk-locale', provider: 'openai-compat', baseUrl: 'http://localhost:11434/v1' });

    const config = JSON.parse(readFileSync(paths(dir).config, 'utf8')) as { provider: { apiKeyRef: string } };
    expect(config.provider.apiKeyRef).toBe('secret://provider_api_key');
  });
});

/**
 * La porta pericolosa: `installTree` copia tutto ciò che trova, e uno dei tre
 * alberi che copia è `defaults/rot/` — l'albero **sigillato**.
 *
 * Un `.DS_Store` finito lì dentro viene sigillato da `seal()` insieme al resto
 * (`listRotFiles` cammina su tutto tranne il manifest), e il Finder lo riscrive
 * appena qualcuno apre quella cartella: l'hash diverge e l'installazione va in
 * safe mode per un file che nessuno legge. Sul checkout dell'owner un
 * `.DS_Store` da 6148 byte stava in `defaults/` dal 16 agosto.
 *
 * Il file di prova viene piantato nel checkout vero, perché è l'unico posto da
 * cui `installTree` legge — e tolto in `finally`, perché lasciarlo lì
 * riprodurrebbe il difetto invece di provarlo.
 */
/**
 * ADR-0059: `runInit` non crea più il workspace — lo crea `resolveWorkspace`
 * al primo `buildRuntime`, e può non farlo mai se l'owner lancia sempre
 * `muffin run`/la REPL dentro un proprio progetto. Ma "pigro" non deve voler
 * dire "muto": prima di questo test l'unica cosa a nominare il workspace era
 * una riga di boot su stderr, e un'installazione appena fatta non diceva
 * niente a riguardo.
 */
describe('runInit nomina il workspace di ADR-0059, senza crearlo', () => {
  it('nomina la cartella di default e non la crea', () => {
    const dir = scratchDir('muffin-init-workspace-');
    const steps = runInit({ home: dir, apiKey: 'sk-never-called' });

    const step = steps.find((s) => s.name === 'workspace');
    expect(step).toBeDefined();
    expect(step?.done).toBe(true);
    expect(step?.detail).toContain(muffinWorkspace(dir));
    // Pigro per davvero: nessun mkdirSync in runInit.
    expect(existsSync(muffinWorkspace(dir))).toBe(false);
  });
});

describe('init non installa la spazzatura del sistema operativo', () => {
  it('un .DS_Store in defaults/rot/ non entra nel sigillo', () => {
    const junk = join(dirname(fileURLToPath(import.meta.url)), '..', 'defaults', 'rot', '.DS_Store');
    const dir = scratchDir('muffin-init-junk-');
    writeFileSync(junk, 'binaria del Finder\n');
    try {
      runInit({ home: dir, apiKey: 'sk-test' });
      expect(existsSync(join(dir, 'rot', '.DS_Store'))).toBe(false);
      // E i file veri del sigillo ci sono comunque.
      expect(existsSync(join(dir, 'rot', 'policy.json'))).toBe(true);
    } finally {
      rmSync(junk, { force: true });
    }
  });
});

/**
 * P0 2026-09-18 — rerunning init on an existing Home must never silently
 * replace owner configuration with defaults.
 *
 * The incident: `install.sh` (TTY branch) re-ran `muffin init` on a
 * configured Home, and `runInit` rebuilt config from DEFAULT_CONFIG +
 * defaultModels + saveConfig. Observed damage on the real Home: models reset
 * to the defaultModels(openai-compat) pair, provider routing dropped,
 * search/embedder/prompt/discord gone, rot hardened → single-user.
 *
 * Contract under test (architectural, not installer-only — direct `runInit`
 * calls included): existing Home → fill missing bootstrap state, apply
 * explicit options, preserve every other owner field. Destruction is
 * `uninstall` + init, never a re-run.
 */
describe('runInit su una Home esistente non la ricostruisce (P0 2026-09-18)', () => {
  afterEach(() => vi.unstubAllEnvs());

  /** A realistic configured Home: every optional field non-default. */
  function existingHome(): string {
    const dir = scratchDir('muffin-init-existing-');
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
    runInit({ home: dir, apiKey: 'sk-ant-fixture' });
    const rich = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      provider: {
        kind: 'openai-compat',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyRef: 'secret://provider_api_key',
        routing: { only: ['alibaba'], dataCollection: 'deny' },
      },
      models: { main: 'qwen/qwen3.8-27b', light: 'qwen/qwen3.8-flash', deep: 'qwen/qwen3.8-80b' },
      thinking: 'off',
      search: { provider: 'tavily', apiKeyRef: 'secret://tavily_api_key' },
      embedder: { kind: 'openai-compat', model: 'text-embedding-3-small', dimensions: 1536, apiKeyRef: 'secret://emb_key' },
      prompt: { version: 'v2' },
      audio: { whisperBin: '/usr/local/bin/whisper-cli' },
      surfaces: {
        default: 'telegram',
        enabled: ['cli', 'telegram'],
        telegram: { ownerUserId: 42, ownerChatId: 42 },
        discord: { ownerUserId: '99' },
      },
      rot: { mode: 'single-user' },
      traces: { retentionDays: 30 },
    };
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify(rich, null, 2)}\n`);
    writeSecret('provider_api_key', 'sk-or-vecchia', dir, 'persistent');
    writeSecret('tavily_api_key', 'tvly-vecchia', dir, 'home');
    writeSecret('emb_key', 'emb-vecchia', dir, 'home');
    return dir;
  }

  function configBytes(dir: string): string {
    return readFileSync(join(dir, 'config.json'), 'utf8');
  }

  it('un rerun senza opzioni conserva ogni campo (semantica, non solo presenza)', () => {
    const dir = existingHome();
    const before = JSON.parse(configBytes(dir));
    const steps = runInit({ home: dir });
    expect(JSON.parse(configBytes(dir))).toEqual(before);
    expect(steps.find((s) => s.name === 'config')?.detail).toMatch(/conservata/);
    // E non ha fabbricato nessun nuovo file di segreto.
    expect(existsSync(join(dir, 'secrets', 'openrouter_api_key'))).toBe(false);
  });

  it('ogni campo owner sopravvive: models/deep, routing, thinking, search, embedder, prompt, audio, surfaces, traces, rot', () => {
    const dir = existingHome();
    runInit({ home: dir });
    const after = JSON.parse(configBytes(dir));
    expect(after.provider.routing).toEqual({ only: ['alibaba'], dataCollection: 'deny' });
    expect(after.provider.apiKeyRef).toBe('secret://provider_api_key');
    expect(after.models).toEqual({ main: 'qwen/qwen3.8-27b', light: 'qwen/qwen3.8-flash', deep: 'qwen/qwen3.8-80b' });
    expect(after.thinking).toBe('off');
    expect(after.search).toEqual({ provider: 'tavily', apiKeyRef: 'secret://tavily_api_key' });
    expect(after.embedder.dimensions).toBe(1536);
    expect(after.prompt).toEqual({ version: 'v2' });
    expect(after.audio).toEqual({ whisperBin: '/usr/local/bin/whisper-cli' });
    expect(after.surfaces.default).toBe('telegram');
    expect(after.surfaces.telegram).toEqual({ ownerUserId: 42, ownerChatId: 42 });
    expect(after.surfaces.discord).toEqual({ ownerUserId: '99' });
    expect(after.traces).toEqual({ retentionDays: 30 });
    expect(after.rot).toEqual({ mode: 'single-user' });
  });

  it('un opzione esplicita cambia solo il suo campo', () => {
    const dir = existingHome();
    runInit({ home: dir, mainModel: 'nuovo/modello' });
    const after = JSON.parse(configBytes(dir));
    expect(after.models.main).toBe('nuovo/modello');
    expect(after.models.light).toBe('qwen/qwen3.8-flash');
    expect(after.models.deep).toBe('qwen/qwen3.8-80b');
    expect(after.provider.routing).toEqual({ only: ['alibaba'], dataCollection: 'deny' });
    expect(after.surfaces.default).toBe('telegram');
  });

  it('una chiave fornita migra atomicamente (scrittura prima, riferimento dopo)', () => {
    const dir = existingHome();
    runInit({ home: dir, apiKey: 'sk-or-nuovissima', provider: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', secretBackend: 'persistent' });
    const after = JSON.parse(configBytes(dir));
    // Il nuovo riferimento punta a un valore appena scritto: migrazione, non rename secco.
    expect(after.provider.apiKeyRef).toBe('secret://openrouter_api_key');
    expect(readFileSync(join(dir, 'xdg', 'muffin', 'secrets', 'openrouter_api_key'), 'utf8').trim()).toBe('sk-or-nuovissima');
    // E il resto della config è intatto.
    expect(after.models.main).toBe('qwen/qwen3.8-27b');
    expect(after.provider.routing).toEqual({ only: ['alibaba'], dataCollection: 'deny' });
  });

  it('un riferimento stale senza alcun valore resta tale (mai inventato il nome nuovo)', () => {
    const dir = existingHome();
    // Cancella TUTTI i valori (home e persistent): nessun candidato risponde.
    rmSync(join(dir, 'xdg', 'muffin', 'secrets', 'provider_api_key'), { force: true });
    rmSync(join(dir, 'secrets', 'provider_api_key'), { force: true });
    rmSync(join(dir, 'secrets', 'tavily_api_key'), { force: true });
    rmSync(join(dir, 'secrets', 'emb_key'), { force: true });
    const steps = runInit({ home: dir });
    const after = JSON.parse(configBytes(dir));
    // Il riferimento esistente è conservato anche se orfano: inventare
    // `secret://openrouter_api_key` sarebbe la silent credential loss.
    expect(after.provider.apiKeyRef).toBe('secret://provider_api_key');
    expect(existsSync(join(dir, 'secrets', 'openrouter_api_key'))).toBe(false);
    expect(steps.find((s) => s.name === 'api key')?.done).toBe(false);
  });

  it('un riferimento stale con un altro candidato valido si ripara verso il valore', () => {
    const dir = existingHome();
    // Il riferimento punta a un nome senza file; il generico ha un valore.
    const config = JSON.parse(configBytes(dir));
    config.provider.apiKeyRef = 'secret://nome_inesistente';
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    runInit({ home: dir });
    const after = JSON.parse(configBytes(dir));
    // Riparazione verso un valore esistente (niente è andato perso: il vecchio
    // riferimento non aveva valore).
    expect(after.provider.apiKeyRef).toBe('secret://provider_api_key');
  });

  it('un riferimento valido non si sposta nemmeno se esiste anche il nome nuovo', () => {
    const dir = existingHome();
    writeSecret('openrouter_api_key', 'sk-or-altra', dir, 'persistent');
    runInit({ home: dir });
    const after = JSON.parse(configBytes(dir));
    expect(after.provider.apiKeyRef).toBe('secret://provider_api_key');
  });

  it('una config corrotta fallisce chiusa senza sovrascrivere', () => {
    const dir = existingHome();
    writeFileSync(join(dir, 'config.json'), '{ non json !!');
    expect(() => runInit({ home: dir })).toThrow(ConfigError);
    // Il file corrotto è ancora lì, intatto: evidenza, non macerie.
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{ non json !!');
  });

  it('un database esistente non viene ri-stampato (le migrazioni restano al boot)', () => {
    const dir = existingHome();
    // Simula un DB fermo a una vecchia versione con dati veri.
    const db = new DatabaseCtor(join(dir, 'muffin.db'));
    try {
      const before = db.prepare(`SELECT group_concat(version, ',') AS v FROM schema_version`).get() as { v: string };
      db.exec(`DELETE FROM schema_version WHERE version > 2`);
      const aged = db.prepare(`SELECT group_concat(version, ',') AS v FROM schema_version`).get() as { v: string };
      expect(aged.v).not.toBe(before.v);
      runInit({ home: dir });
      const after = db.prepare(`SELECT group_concat(version, ',') AS v FROM schema_version`).get() as { v: string };
      expect(after.v).toBe(aged.v);
    } finally {
      db.close();
    }
  });
});
