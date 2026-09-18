import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import {
  ConfigError,
  credstoreEncryptedPath,
  loadConfig,
  readSecret,
  saveConfig,
  secretsBackend,
  writeSecret,
} from './config.js';
import {
  decryptSystemdSecret,
  listLegacySecretNames,
  provisionSystemdSecret,
  requiredSecretRefs,
  secretExists,
  storeSecret,
  type ProvisionRunner,
} from './systemd.js';

/**
 * The systemd credential backend (D2), behind the `secret://` seam.
 *
 * Everything here runs on any platform: provisioning never shells out for
 * real (the runner is injected), presence is file existence under a
 * MUFFIN_CREDSTORE_ENCRYPTED hook, and values only travel through stubbed
 * memory. The live proof — real `systemd-creds`, real user manager, real
 * reboot — happened on a disposable Ubuntu 24.04 VM and stays there; these
 * tests pin the contract the VM proved (fail-closed, no silent fallback,
 * presence-without-value).
 */

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-systemd-'));
  // Isolate the persistent store: without this, the file chain falls through
  // to the REAL $XDG_CONFIG_HOME/muffin/secrets of whoever runs the suite —
  // names (and in other tests, values) of the founder machine leaking into a
  // fixture. Same discipline as cli/main.test.ts's scratchHome.
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  runInit({ home: dir, apiKey: 'sk-ant-fixture' });
  return dir;
}

/** Whatever name init stored the provider key under (provider-specific, not assumed). */
function providerRef(dir: string): string {
  return loadConfig(dir).provider.apiKeyRef;
}

function flipToSystemd(dir: string): void {
  const config = loadConfig(dir);
  saveConfig({ ...config, secrets: { backend: 'systemd' } }, dir);
  vi.stubEnv('MUFFIN_CREDSTORE_ENCRYPTED', join(dir, 'credstore'));
}

afterEach(() => vi.unstubAllEnvs());

const okRunner: ProvisionRunner = () => ({ status: 0, stderr: '', stdout: '' });

describe('secretsBackend', () => {
  it('defaults to file, so every existing config parses unchanged', () => {
    const dir = home();
    expect(secretsBackend(dir)).toBe('file');
    expect(loadConfig(dir).secrets).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips an explicit systemd flag', () => {
    const dir = home();
    flipToSystemd(dir);
    expect(secretsBackend(dir)).toBe('systemd');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('readSecret never falls back to files on the systemd backend (D3)', () => {
  it('throws instead of returning the legacy file value', () => {
    const dir = home();
    const ref = providerRef(dir);
    const name = ref.slice('secret://'.length);
    flipToSystemd(dir);
    // No CREDENTIALS_DIRECTORY: outside the service, by definition here.
    vi.stubEnv('CREDENTIALS_DIRECTORY', '');
    let error: unknown = null;
    try {
      readSecret(ref, dir);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(String((error as Error).message)).toContain(name);
    expect(String((error as Error).message)).not.toContain('sk-ant-fixture');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the materialised file when the service context exists', () => {
    const dir = home();
    const ref = providerRef(dir);
    const name = ref.slice('secret://'.length);
    flipToSystemd(dir);
    const creds = mkdtempSync(join(tmpdir(), 'muffin-creds-'));
    writeFileSync(join(creds, name), 'sk-live-value\n');
    vi.stubEnv('CREDENTIALS_DIRECTORY', creds);
    expect(readSecret(ref, dir)).toBe('sk-live-value');
    rmSync(dir, { recursive: true, force: true });
    rmSync(creds, { recursive: true, force: true });
  });

  it('refuses an empty materialised value', () => {
    const dir = home();
    const ref = providerRef(dir);
    const name = ref.slice('secret://'.length);
    flipToSystemd(dir);
    const creds = mkdtempSync(join(tmpdir(), 'muffin-creds-'));
    writeFileSync(join(creds, name), '  \n');
    vi.stubEnv('CREDENTIALS_DIRECTORY', creds);
    expect(() => readSecret(ref, dir)).toThrow(ConfigError);
    rmSync(dir, { recursive: true, force: true });
    rmSync(creds, { recursive: true, force: true });
  });
});

describe('secretExists asks presence, never value', () => {
  it('file backend: answers from the chain', () => {
    const dir = home();
    const ref = providerRef(dir);
    expect(secretExists(ref, dir)).toBe(true);
    expect(secretExists('secret://mai_esistito', dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('systemd backend: answers from ciphertext existence', () => {
    const dir = home();
    const ref = providerRef(dir);
    const name = ref.slice('secret://'.length);
    flipToSystemd(dir);
    expect(secretExists(ref, dir)).toBe(false);
    const blob = credstoreEncryptedPath(name);
    mkdirSync(dirname(blob), { recursive: true });
    writeFileSync(blob, 'BLOB');
    expect(secretExists(ref, dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('requiredSecretRefs', () => {
  it('collects provider, surface and MCP refs, sorted and unique', () => {
    const dir = home();
    const config = loadConfig(dir);
    saveConfig(
      {
        ...config,
        search: { provider: 'tavily', apiKeyRef: 'secret://tavily_api_key' },
        surfaces: { ...config.surfaces, telegram: { ownerUserId: 42 } },
      },
      dir,
    );
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        schemaVersion: 1,
        servers: { gh: { command: 'x', env: { GITHUB_TOKEN: 'secret://mcp_gh', LANG: 'C' }, approvedAt: 't', tools: {} } },
      }),
    );
    expect(requiredSecretRefs(dir)).toEqual([
      'secret://mcp_gh',
      providerRef(dir),
      'secret://tavily_api_key',
      'secret://telegram_token',
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores malformed refs instead of provisioning wrong names', () => {
    const dir = home();
    const config = loadConfig(dir);
    saveConfig({ ...config, search: { provider: 'tavily', apiKeyRef: 'not-a-ref' } }, dir);
    expect(requiredSecretRefs(dir)).toEqual([providerRef(dir)]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('listLegacySecretNames', () => {
  it('lists validated names across both file stores, ignoring strays', () => {
    const dir = home();
    const name = providerRef(dir).slice('secret://'.length);
    writeSecret('uno_extra', 'x', dir, 'home');
    writeFileSync(join(dir, 'secrets', 'not a name'), 'x');
    expect(listLegacySecretNames(dir).sort()).toEqual([name, 'uno_extra'].sort());
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('provisionSystemdSecret', () => {
  it('encrypts via stdin, never argv, then makes the blob observable', () => {
    const seen: { argv: string[]; input: string }[] = [];
    const runner: ProvisionRunner = (argv, input) => {
      seen.push({ argv, input });
      return { status: 0, stderr: '', stdout: '' };
    };
    const { path } = provisionSystemdSecret('provider_api_key', 'sk-nuova', { runner, useSudo: true });
    expect(path).toContain('provider_api_key.cred');
    expect(seen).toHaveLength(3);
    expect(seen[0]?.argv.slice(0, 3)).toEqual(['sudo', 'mkdir', '-p']);
    expect(seen[1]?.argv).toEqual(['sudo', 'systemd-creds', 'encrypt', '--name=provider_api_key', '-', path]);
    expect(seen[1]?.input).toBe('sk-nuova');
    // The value travels as stdin only: no argv element carries it.
    expect(seen.flatMap((s) => s.argv).join(' ')).not.toContain('sk-nuova');
    expect(seen[2]?.argv).toEqual(['sudo', 'chmod', '644', path]);
  });

  it('skips sudo when already root', () => {
    const seen: string[][] = [];
    provisionSystemdSecret('k', 'v', { runner: (argv) => { seen.push(argv); return { status: 0, stderr: '', stdout: '' }; }, useSudo: false });
    expect(seen[1]?.[0]).toBe('systemd-creds');
  });

  it('refuses empty values and malformed names before touching anything', () => {
    let calls = 0;
    const runner: ProvisionRunner = () => { calls += 1; return { status: 0, stderr: '', stdout: '' }; };
    expect(() => provisionSystemdSecret('k', '', { runner })).toThrow(ConfigError);
    expect(() => provisionSystemdSecret('ha-lo-spazio no', 'v', { runner })).toThrow(ConfigError);
    expect(calls).toBe(0);
  });

  it('fails closed with cleanup on encrypt failure — never a file fallback', () => {
    const dir = home();
    flipToSystemd(dir);
    const runner: ProvisionRunner = (argv) =>
      argv.includes('mkdir') ? { status: 0, stderr: '', stdout: '' } : { status: 1, stderr: 'boom', stdout: '' };
    expect(() => provisionSystemdSecret('k', 'v', { runner, useSudo: false })).toThrow(/systemd-creds encrypt failed/);
    expect(secretExists('secret://k', dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('decryptSystemdSecret', () => {
  it('returns the value to the caller for comparison, never printing it', () => {
    const runner: ProvisionRunner = (argv) => {
      expect(argv).toContain('decrypt');
      return { status: 0, stderr: '', stdout: 'sk-nuova' };
    };
    expect(decryptSystemdSecret('provider_api_key', { runner, useSudo: false })).toBe('sk-nuova');
  });

  it('a failed decrypt is an error, not an empty value', () => {
    const runner: ProvisionRunner = () => ({ status: 1, stderr: 'bad blob', stdout: '' });
    expect(() => decryptSystemdSecret('k', { runner, useSudo: false })).toThrow(/decrypt failed/);
  });
});

describe('storeSecret routes by flag, never by platform', () => {
  it('file backend keeps the caller-chosen file store', () => {
    const dir = home();
    const stored = storeSecret('telegram_token', 'tok', dir, 'persistent', { runner: okRunner });
    expect(stored.kind).toBe('file');
    expect(secretExists('secret://telegram_token', dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('systemd backend provisions instead of writing files', () => {
    // The systemd route needs Linux (provisioning refuses elsewhere by
    // design); the refusal itself is asserted on other platforms.
    if (process.platform !== 'linux') {
      const dir = home();
      flipToSystemd(dir);
      expect(() => storeSecret('telegram_token', 'tok', dir, 'persistent', { runner: okRunner })).toThrow(/this machine is/);
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    const dir = home();
    const initName = providerRef(dir).slice('secret://'.length);
    flipToSystemd(dir);
    const seen: string[][] = [];
    const stored = storeSecret('telegram_token', 'tok', dir, 'persistent', {
      runner: (argv) => { seen.push(argv); return { status: 0, stderr: '', stdout: '' }; },
      useSudo: false,
    });
    expect(stored.kind).toBe('systemd');
    expect(stored.note).toMatch(/restart/);
    expect(seen[0]).toContain('systemd-creds');
    // And no file copy was left behind as a consolation prize.
    expect(listLegacySecretNames(dir)).toEqual([initName]);
    rmSync(dir, { recursive: true, force: true });
  });
});
