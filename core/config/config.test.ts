import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import {
  CONFIG_SCHEMA_VERSION,
  ConfigError,
  loadConfig,
  locateSecret,
  locateSecretAll,
  paths,
  readDefaultChannel,
  readSecret,
  secretDir,
  writeSecret,
} from './config.js';

/**
 * Two things that have to survive an upgrade: the owner's config file, and the
 * owner's key.
 *
 * The spend caps left `config.json` for the sealed `rot/budgets.json`, which is
 * a schema change on the one install that exists. `loadConfig` used to refuse
 * any version it did not recognise, so shipping this without a migration would
 * have bricked that home behind a command nobody had heard of — a fix worse than
 * the defect. And the key left the working-directory `.env` for a fixed path
 * outside both the repo and the wiped home, which turns a single location into a
 * chain: chains fail silently unless somebody can see which link answered.
 */

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-config-'));
  runInit({ home: dir, apiKey: 'sk-ant-fixture' });
  return dir;
}

/** Rewrites config.json as the schemaVersion-1 file the owner's home holds. */
function downgrade(dir: string, budget: unknown): void {
  const file = paths(dir).config;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.schemaVersion = 1;
  if (budget !== undefined) config.budget = budget;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

afterEach(() => vi.unstubAllEnvs());

describe('config migration', () => {
  it('opens a schemaVersion-1 file, drops the stale cap, and names what it dropped', () => {
    const dir = home();
    downgrade(dir, { monthlyUsd: 500, perTenantDailyUsd: 9 });
    const notes: string[] = [];
    const config = loadConfig(dir, (n) => notes.push(n));

    expect(config.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect((config as unknown as { budget?: unknown }).budget).toBeUndefined();
    // The numbers, so the owner can decide whether to carry them across. They
    // are deliberately NOT copied into the sealed file: letting an unsealed
    // value flow into the seal on its own is the exact hole this closed.
    expect(notes.join('\n')).toContain('monthlyUsd 500');
    expect(notes.join('\n')).toContain('perTenantDailyUsd 9');
    expect(notes.join('\n')).toContain('rot reseal');
    rmSync(dir, { recursive: true, force: true });
  });

  it('says nothing when there was nothing to drop', () => {
    // A v1 file with no `budget` at all is a legal input, and a note about a
    // field that was not there would be noise the owner learns to skip.
    const dir = home();
    downgrade(dir, undefined);
    const notes: string[] = [];
    expect(loadConfig(dir, (n) => notes.push(n)).schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(notes).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent: a file already migrated is loaded silently', () => {
    const dir = home();
    const notes: string[] = [];
    loadConfig(dir, (n) => notes.push(n));
    expect(notes).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('still refuses a file from a newer build, and says which direction is wrong', () => {
    // The asymmetry is the point: an older file is a home that predates the
    // schema and gets migrated; a newer one is a build that predates the file
    // and cannot invent the missing knowledge.
    const dir = home();
    const file = paths(dir).config;
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.schemaVersion = CONFIG_SCHEMA_VERSION + 1;
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    let caught: ConfigError | null = null;
    try {
      loadConfig(dir);
    } catch (error) {
      caught = error as ConfigError;
    }
    expect(caught?.message).toContain(`schemaVersion ${CONFIG_SCHEMA_VERSION + 1}`);
    // The remedy, not the message: a config failure the user cannot act on is a
    // bug, and "upgrade muffin" is the only true action here.
    expect(caught?.remedy).toContain('upgrade muffin');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a version that is not a version', () => {
    const dir = home();
    const file = paths(dir).config;
    writeFileSync(file, JSON.stringify({ schemaVersion: 'due' }));
    expect(() => loadConfig(dir)).toThrow(ConfigError);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the secret chain says which link answered', () => {
  it('finds the persistent key when the home has been wiped — the dev loop', () => {
    // `muffin uninstall --yes && muffin init`, which is how the owner re-tests
    // onboarding. It used to work because the key sat in a `.env` in the working
    // directory; that file is inside the tools' read scope, so the key moved.
    // The property has to survive the move or ADR-0030 lost its whole point.
    const dir = mkdtempSync(join(tmpdir(), 'muffin-devloop-'));
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
    const muffinHome = join(dir, '.muffin');

    runInit({ home: muffinHome, apiKey: 'sk-ant-primo', secretBackend: 'persistent' });
    expect(locateSecret('secret://provider_api_key', muffinHome)?.backend).toBe('persistent');

    rmSync(muffinHome, { recursive: true, force: true }); // muffin uninstall --yes
    const steps = runInit({ home: muffinHome }); // muffin init, no key anywhere else

    const key = steps.find((s) => s.name === 'api key');
    expect(key?.done).toBe(true);
    expect(key?.detail).toContain('persistent');
    // Found, never copied: a second copy in the wiped home is the two-files
    // shape that produced the budget defect in the first place.
    expect(locateSecretAll('secret://provider_api_key', muffinHome).map((l) => l.backend)).toEqual([
      'persistent',
    ]);
    expect(readSecret('secret://provider_api_key', muffinHome)).toBe('sk-ant-primo');
    rmSync(dir, { recursive: true, force: true });
  });

  it("this install's own store wins, so `muffin secret set` is never a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-shadow-'));
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
    const muffinHome = join(dir, '.muffin');
    writeSecret('provider_api_key', 'vecchia', muffinHome, 'persistent');
    writeSecret('provider_api_key', 'nuova', muffinHome, 'home');

    expect(readSecret('secret://provider_api_key', muffinHome)).toBe('nuova');
    // Both are visible, which is what lets `doctor` warn instead of the losing
    // copy sitting there forever looking like the key in use.
    expect(locateSecretAll('secret://provider_api_key', muffinHome)).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('names both directories when nothing answers, instead of one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-missing-'));
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
    const muffinHome = join(dir, '.muffin');
    let caught: ConfigError | null = null;
    try {
      readSecret('secret://provider_api_key', muffinHome);
    } catch (error) {
      caught = error as ConfigError;
    }
    expect(caught?.message).toContain(secretDir('home', muffinHome));
    expect(caught?.message).toContain(secretDir('persistent', muffinHome));
    expect(caught?.remedy).toContain('--persist');
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes 0600 in a 0700 directory, wherever it writes', () => {
    // The persistent store is outside `~/.muffin`, so it does not inherit
    // whatever `muffin init` did to that directory's mode.
    const dir = mkdtempSync(join(tmpdir(), 'muffin-modes-'));
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
    const file = writeSecret('provider_api_key', 'k', join(dir, '.muffin'), 'persistent');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(secretDir('persistent', join(dir, '.muffin'))).mode & 0o777).toBe(0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it('honours XDG_CONFIG_HOME, which is what lets a test — and a second machine — move it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-xdg-'));
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'altrove'));
    expect(secretDir('persistent', join(dir, '.muffin'))).toBe(join(dir, 'altrove', 'muffin', 'secrets'));
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The live read behind `Runtime.defaultChannel`.
 *
 * These assertions exist to fail if the boot snapshot ever comes back. A judge
 * measured the defect on a running gateway: `muffin surface default telegram`
 * rewrote `config.json` from another process, the lane kept answering `cli`,
 * and the remedy the agent itself had printed did nothing. Nothing in that
 * failure was visible to a test that read the config once.
 */
describe('readDefaultChannel', () => {
  it('sees a surfaces.default rewritten by another process, with no restart', () => {
    const dir = home();
    expect(readDefaultChannel(dir, 'cli')).toBe('cli');

    const file = paths(dir).config;
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.surfaces = { default: 'telegram', enabled: ['cli', 'telegram'] };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);

    expect(readDefaultChannel(dir, 'cli')).toBe('telegram');
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the booted value rather than throwing, on a config that no longer parses', () => {
    const dir = home();
    writeFileSync(paths(dir).config, '{ non e json');
    // The caller is the 30-second beat that keeps the gateway's claim alive: a
    // config the owner is halfway through editing must not end the process.
    expect(readDefaultChannel(dir, 'telegram')).toBe('telegram');
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back when the home has no config at all', () => {
    expect(readDefaultChannel(join(tmpdir(), 'muffin-non-esiste-mai'), 'discord')).toBe('discord');
  });
});
