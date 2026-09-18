import { existsSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigError,
  loadConfig,
  locateSecret,
  locateSecretAll,
  saveConfig,
  SECRET_BACKENDS,
  secretDir,
} from './config.js';
import {
  decryptSystemdSecret,
  listLegacySecretNames,
  provisionSystemdSecret,
  type ProvisionRunner,
} from './systemd.js';
import { SERVICE_NAME, SYSTEM_UNIT_DIR } from '../gateway/unit.js';

/**
 * `muffin secret migrate --yes` as a testable unit: file stores → encrypted
 * systemd credentials. The CLI (`cli/main.ts`) is a thin flag-parser over
 * this; every decision below is pinned here with a stubbed runner so the
 * full flow — including legacy deletion — runs anywhere, not just where
 * `sudo` and `systemd-creds` exist (the disposable VM proves that end).
 *
 * Order is the guarantee (Phase 6): read legacy → provision all → prove by
 * decrypt round-trip → flip the flag → prove the service → ONLY then delete.
 * Any failure before deletion aborts with the backend untouched and the
 * legacy copies intact; deletion failures stay visible (doctor RED-shadows
 * whatever remains).
 */

export type MigrateRunner = ProvisionRunner;

export type MigrateDeps = {
  runner?: MigrateRunner;
  useSudo?: boolean;
  /** Whether the system unit file exists (no service → proof deferred). */
  unitInstalled?: boolean;
  /** Restart + verify a pid change. Only called when unitInstalled. */
  restart?: () => Promise<number>;
  out?: (line: string) => void;
};

export type MigrateResult =
  | { ok: true; migrated: string[]; serviceProven: boolean }
  | { ok: false; message: string; remedy: string; legacyIntact: boolean };

export async function runSecretMigrate(home: string, deps: MigrateDeps = {}): Promise<MigrateResult> {
  const out = deps.out ?? ((): void => {});
  const names = listLegacySecretNames(home);
  if (names.length === 0) return { ok: true, migrated: [], serviceProven: false };

  // 1. Read every legacy value through the file chain (the same precedence
  // `readSecret` uses while the backend is still `file`) — values live in
  // memory only from here on, never on disk, never in argv/env.
  const values = new Map<string, string>();
  for (const n of names) {
    const found = locateSecret(`secret://${n}`, home);
    if (!found) continue;
    try {
      values.set(n, readFileSync(found.path, 'utf8').trim());
    } catch (error) {
      return fail(error, true);
    }
  }
  if (values.size === 0) {
    return {
      ok: false,
      message: 'legacy names found but none readable — aborting, nothing was changed',
      remedy: 'inspect the file permissions, then re-run',
      legacyIntact: true,
    };
  }

  // 2. Provision every blob. Any failure aborts with the backend untouched
  // and the legacy copies intact (falsifier 12).
  const runnerOpts = { ...(deps.runner ? { runner: deps.runner } : {}), ...(deps.useSudo !== undefined ? { useSudo: deps.useSudo } : {}) };
  try {
    for (const [n, v] of values) {
      if (!v) {
        throw new ConfigError(
          `legacy secret "${n}" is empty — refusing to migrate emptiness`,
          `delete it or set a value first: muffin secret set ${n} --file`,
        );
      }
      provisionSystemdSecret(n, v, runnerOpts);
    }
  } catch (error) {
    return fail(error, true, 'migration aborted before any switch: legacy file secrets intact and still authoritative.');
  }

  // 3. Prove the new path by decrypting every blob back and comparing (in
  // memory, never printed) — a corrupt blob must surface here, not at the
  // next boot with the legacy copies already gone.
  try {
    for (const [n, v] of values) {
      if (decryptSystemdSecret(n, runnerOpts) !== v) {
        throw new ConfigError(
          `round-trip mismatch for "${n}" — the blob does not decrypt to the legacy value`,
          'legacy file secrets intact and still authoritative; inspect the blob, then re-run',
        );
      }
    }
  } catch (error) {
    return fail(error, true);
  }

  // 4. Flip the backend, then prove the service on it.
  const previous = loadConfig(home);
  saveConfig({ ...previous, secrets: { backend: 'systemd' } }, home);
  let flipped = true;
  const rollback = (message: string, remedy: string): MigrateResult => {
    if (flipped) {
      try {
        saveConfig({ ...loadConfig(home), secrets: { backend: 'file' } }, home);
      } catch {
        // The flag file itself is broken — reported below; the legacy files
        // are still intact regardless.
      }
      flipped = false;
    }
    return { ok: false, message, remedy: `${remedy} Legacy file secrets intact and authoritative again.`, legacyIntact: true };
  };
  const unitInstalled = deps.unitInstalled ?? existsSync(join(SYSTEM_UNIT_DIR, `${SERVICE_NAME}.service`));
  if (unitInstalled) {
    if (!deps.restart) {
      return rollback('service is installed but no restart hook was provided.', 'Re-run migrate; this is a caller bug, not your install.');
    }
    const code = await deps.restart();
    if (code !== 0) {
      return rollback(`service restart on the new backend failed (exit ${code}).`, 'Fix the cause, then re-run migrate.');
    }
    out('service restarted on the new backend and verified.');
  } else {
    out('service not installed yet — proof deferred to first start; blobs verified by decrypt round-trip above.');
  }

  // 5. Only now delete the legacy copies — then the directories themselves
  // when they are empty, so no store (not just no secret) is left behind.
  // rmdirSync: rmSync without recursive refuses directories outright
  // (EISDIR), so only rmdirSync removes an emptied store. It throws on
  // non-empty dirs — never recursive, never a guess.
  const leftovers: string[] = [];
  for (const n of values.keys()) {
    for (const loc of locateSecretAll(`secret://${n}`, home)) {
      try {
        rmSync(loc.path, { force: true });
      } catch {
        leftovers.push(loc.path);
      }
    }
  }
  if (leftovers.length === 0) {
    for (const backend of SECRET_BACKENDS) {
      try {
        rmdirSync(secretDir(backend, home));
      } catch {
        // Non-empty or already gone: either way nothing of ours remains
        // inside that we know about (doctor's shadow check watches).
      }
    }
  }
  if (leftovers.length > 0) {
    return {
      ok: false,
      message: `migrated, but these legacy copies could not be deleted: ${leftovers.join(', ')}`,
      remedy: 'doctor reports them as a shadow until they are gone.',
      legacyIntact: false,
    };
  }
  return { ok: true, migrated: [...values.keys()], serviceProven: unitInstalled };
}

function fail(error: unknown, legacyIntact: boolean, prefix?: string): MigrateResult {
  if (error instanceof ConfigError) {
    return {
      ok: false,
      message: `${prefix ? `${prefix} ` : ''}${error.message}`,
      remedy: error.remedy,
      legacyIntact,
    };
  }
  throw error;
}
