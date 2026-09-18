import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ConfigError,
  credstoreEncryptedPath,
  locateSecret,
  loadConfig,
  muffinHome,
  requireSecretRef,
  secretsBackend,
  secretDir,
  SECRET_BACKENDS,
  writeAuthoritativeSecret,
  writeSecret,
  type SecretBackend,
} from './config.js';
import { loadMcpRegistry } from '../mcp/registry.js';

/**
 * The Linux encrypted-credential backend (D2), behind the `secret://` seam.
 *
 * Nothing here resolves a secret VALUE except the privileged sinks that call
 * `readSecret` (config.ts) — this module answers presence ("is it
 * provisioned?"), enumerates required names, and provisions blobs via
 * `systemd-creds encrypt`. Values travel stdin → sudo → systemd-creds and
 * never touch argv, env, logs or files. No function here falls back to the
 * 0600 file stores: unavailability is a `ConfigError` with a remedy (D3).
 */

export type ProvisionRunner = (argv: string[], input: string) => { status: number | null; stderr: string; stdout: string };

const realRunner: ProvisionRunner = (argv, input) => {
  const [cmd, ...rest] = argv;
  const r = spawnSync(cmd ?? '', rest, { input, encoding: 'utf8' });
  if (r.error) return { status: null, stderr: r.error.message, stdout: '' };
  return { status: r.status, stderr: (r.stderr as string | undefined) ?? '', stdout: (r.stdout as string | undefined) ?? '' };
};

/**
 * Presence without value — the only question `doctor`, `surface list` and
 * pairing pre-checks may ask. Under the systemd backend this is ciphertext
 * existence, which proves provisioning, never content.
 *
 * Tri-state, and the third state is load-bearing: systemd secures
 * `/etc/credstore.encrypted` to 0700 at boot, so after every reboot an
 * unprivileged process can neither confirm nor deny a blob. Collapsing that
 * into "absent" would unprovision healthy installs (unit lines dropped,
 * doctor red) on every boot — measured live. `unknown` callers decide
 * explicitly: unit lines follow config intent (activation enforces),
 * liveness proves use, and only verified absence is a hard no.
 */
export type SecretPresence = 'present' | 'absent' | 'unknown';

export function secretPresence(ref: string, home = muffinHome()): SecretPresence {
  const name = requireSecretRef(ref);
  if (secretsBackend(home) !== 'systemd') return locateSecret(ref, home) !== null ? 'present' : 'absent';
  try {
    return statSync(credstoreEncryptedPath(name)).isFile() ? 'present' : 'absent';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';
    return 'unknown';
  }
}

/**
 * Boolean presence for display/pre-check call sites (`surface list`,
 * search status). `unknown` reads as present: post-boot healthy installs
 * must display healthy, and activation (243) plus doctor enforce reality.
 * Callers that decide anything structural use `secretPresence` instead.
 */
export function secretExists(ref: string, home = muffinHome()): boolean {
  return secretPresence(ref, home) !== 'absent';
}

/**
 * Owner-facing store routing for pairing/setup flows (`surface enable`,
 * `search`, Telegram/Discord tokens). Routes by the explicit backend flag —
 * never by platform, never by inference:
 *
 * - `file` → the 0600 write the caller names via `fileBackend` (persistent
 *   authority vs home copy), exactly as before this backend existed;
 * - `systemd` → encrypted provisioning (may need sudo); the returned note
 *   tells the caller what must restart, because credentials materialise at
 *   service activation, not at provisioning time.
 *
 * Throws (fail closed) rather than writing to the wrong store.
 */
export function storeSecret(
  name: string,
  value: string,
  home: string,
  fileBackend: SecretBackend,
  opts: { runner?: ProvisionRunner; useSudo?: boolean } = {},
): { kind: 'file' | 'systemd'; path: string; note: string | null } {
  const clean = requireSecretRef(`secret://${name}`);
  if (!value) {
    throw new ConfigError(`refusing to store an empty "${clean}"`, 'provide a non-empty value on stdin');
  }
  if (secretsBackend(home) === 'systemd') {
    if (process.platform !== 'linux') {
      throw new ConfigError(
        `backend is systemd but this machine is ${process.platform}`,
        'the systemd credential backend is Linux-only; flip back only deliberately (no automatic fallback exists)',
      );
    }
    const { path } = provisionSystemdSecret(clean, value, opts);
    return {
      kind: 'systemd',
      path,
      note: 'takes effect at next service start: sudo systemctl restart muffin-gateway.service (and regenerate the unit if this name is new: muffin gateway install --write --force)',
    };
  }
  const path =
    fileBackend === 'persistent'
      ? writeAuthoritativeSecret(clean, value, home)
      : writeSecret(clean, value, home, 'home');
  return { kind: 'file', path, note: null };
}

/**
 * Every `secret://` reference this Home needs provisioned: provider key,
 * search key, embedder keys, surface tokens (fixed names, only when the
 * surface is configured), and MCP server env refs. Sorted, unique.
 *
 * A corrupt config/registry is not this function's to report (doctor owns
 * those checks): it contributes what it can name and moves on, so one broken
 * file cannot hide every other required secret.
 */
export function requiredSecretRefs(home = muffinHome()): string[] {
  const out = new Set<string>();
  const add = (ref: unknown): void => {
    if (typeof ref !== 'string' || !ref.startsWith('secret://')) return;
    try {
      out.add(`secret://${requireSecretRef(ref)}`);
    } catch {
      // Malformed refs are config/registry errors, reported where they are
      // validated — not here, and never by provisioning a wrong name.
    }
  };
  try {
    const config = loadConfig(home);
    add(config.provider.apiKeyRef);
    add(config.search?.apiKeyRef);
    const embedder = config.embedder as { apiKeyRef?: unknown; fallback?: { apiKeyRef?: unknown } } | undefined;
    add(embedder?.apiKeyRef);
    add(embedder?.fallback?.apiKeyRef);
    if (config.surfaces.telegram) out.add('secret://telegram_token');
    if (config.surfaces.discord) out.add('secret://discord_token');
  } catch {
    return [...out].sort();
  }
  try {
    const registry = loadMcpRegistry(home);
    for (const server of Object.values(registry.servers)) {
      for (const value of Object.values(server.env)) add(value);
    }
  } catch {
    // See above: registry errors belong to the registry check.
  }
  return [...out].sort();
}

/** Legacy 0600 names present on disk (validated names only). For migration. */
export function listLegacySecretNames(home = muffinHome()): string[] {
  const names = new Set<string>();
  for (const backend of SECRET_BACKENDS) {
    let entries: string[] = [];
    try {
      entries = readdirSync(secretDir(backend, home));
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        names.add(requireSecretRef(`secret://${entry}`));
      } catch {
        // Not a secret name (stray file): migration ignores it, doctor's
        // home-hygiene (if any) owns it — never provision garbage.
      }
    }
  }
  return [...names].sort();
}

/**
 * Provision (or rotate) one encrypted blob. The value travels stdin →
 * `systemd-creds encrypt` and is never argv/env/file. Empty values are
 * refused: presence must imply non-empty, because `doctor` checks presence
 * without decrypting (decrypting to prove existence would need the host key
 * this process must not hold).
 *
 * Root privilege is used exactly once, for the encrypt that must read the
 * host key and write the root-owned store — skipped only when already root.
 * On any failure the target is removed and nothing falls back to files (D3).
 */
export function provisionSystemdSecret(
  name: string,
  value: string,
  opts: { runner?: ProvisionRunner; useSudo?: boolean } = {},
): { path: string } {
  const clean = requireSecretRef(`secret://${name}`);
  if (!value) {
    throw new ConfigError(
      `refusing to provision an empty "${clean}" — presence must imply a usable value`,
      'pipe a non-empty value: echo -n "$KEY" | muffin secret set --systemd ' + clean,
    );
  }
  const target = credstoreEncryptedPath(clean);
  const sudo = opts.useSudo ?? (typeof process.getuid === 'function' && process.getuid() !== 0);
  const prefix = sudo ? ['sudo'] : [];
  const run = opts.runner ?? realRunner;
  // The store directory is root-owned by design; creating it is part of the
  // same privileged step, not a prerequisite the owner must guess. dirname of
  // the target (not the production const) so the MUFFIN_CREDSTORE_ENCRYPTED
  // test hook moves both together. Mode 755: ciphertext and names are
  // public-safe, and unprivileged readers (gateway install, doctor presence
  // checks) must traverse it — a 0700 dir here silently unprovisions every
  // secret for everyone but root (measured live: secretExists false,
  // credential lines missing, service dead at boot).
  const mkdir = run([...prefix, 'mkdir', '-p', dirname(target)], '');
  if (mkdir.status !== 0) {
    const why = mkdir.status === null ? `could not run: ${mkdir.stderr}` : mkdir.stderr.trim();
    throw new ConfigError(
      `cannot create ${dirname(target)}${why ? ` — ${why}` : ''}`,
      'needs privilege for the root-owned credential store (`sudo`)',
    );
  }
  const chmodDir = run([...prefix, 'chmod', '755', dirname(target)], '');
  if (chmodDir.status !== 0) {
    throw new ConfigError(
      `cannot chmod ${dirname(target)} (${chmodDir.stderr.trim() || 'unknown error'})`,
      'the store directory must stay traversable or unprivileged presence checks fail closed',
    );
  }
  const encrypt = run([...prefix, 'systemd-creds', 'encrypt', `--name=${clean}`, '-', target], value);
  if (encrypt.status !== 0) {
    try {
      rmSync(target, { force: true });
    } catch {
      // Best effort: the error below already names the target for manual cleanup.
    }
    const why = encrypt.status === null ? `could not run: ${encrypt.stderr}` : encrypt.stderr.trim();
    throw new ConfigError(
      `systemd-creds encrypt failed for "${clean}"${why ? ` — ${why}` : ''}`,
      'needs `systemd-creds` and privilege for the host key (`sudo`); the file stores were NOT touched',
    );
  }
  // Ciphertext is public-safe (AES-GCM with the host key); 644 lets
  // doctor and the owner observe presence without privilege games.
  const chmod = run([...prefix, 'chmod', '644', target], '');
  if (chmod.status !== 0) {
    throw new ConfigError(
      `provisioned "${clean}" but could not chmod the blob (${chmod.stderr.trim() || 'unknown error'})`,
      `fix the mode by hand: sudo chmod 644 ${target}`,
    );
  }
  return { path: target };
}

/**
 * Decrypt one blob back to its value — migration proof only, never a runtime
 * path. Runs with the same privilege as provisioning (it reads the host
 * key); the value is returned to the caller for comparison and must never
 * be printed, logged or stored. `readSecret` remains the only runtime
 * resolver, so the secret-boundary allowlist is untouched by this function.
 */
export function decryptSystemdSecret(
  name: string,
  opts: { runner?: ProvisionRunner; useSudo?: boolean } = {},
): string {
  const clean = requireSecretRef(`secret://${name}`);
  const target = credstoreEncryptedPath(clean);
  const sudo = opts.useSudo ?? (typeof process.getuid === 'function' && process.getuid() !== 0);
  const run = opts.runner ?? realRunner;
  // `--name` is load-bearing, not decorative: decrypt compares the embedded
  // name against the INPUT FILENAME, which carries our `.cred` suffix, and
  // refuses the round-trip without it (measured: "does not match filename
  // '….cred', refusing"). The encrypt side binds the same name at creation,
  // so rename-and-reuse is still refused — by the embedded name, as designed.
  const r = run([...(sudo ? ['sudo'] : []), 'systemd-creds', 'decrypt', `--name=${clean}`, target, '-'], '');
  if (r.status !== 0) {
    const why = r.status === null ? `could not run: ${r.stderr}` : r.stderr.trim();
    throw new ConfigError(
      `systemd-creds decrypt failed for "${clean}"${why ? ` — ${why}` : ''}`,
      'the blob may be corrupt or the host key unavailable; the legacy secret was NOT touched',
    );
  }
  return r.stdout;
}
