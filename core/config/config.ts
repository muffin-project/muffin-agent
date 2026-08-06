import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * One home, one config file, one database. Backup, export and "delete
 * everything about me" all have to be a single path — that is worth more than
 * XDG's three directories for a system whose data is this personal.
 */

export const CONFIG_SCHEMA_VERSION = 1;

export type ProviderKind = 'anthropic' | 'openai-compat';

/**
 * The schema is the type, not a copy of it.
 *
 * Parsing was a cast — `JSON.parse(...) as Config` — which meant a config missing
 * `budget` produced `caps.monthlyUsd === undefined`, and `0 >= undefined` is
 * `false`, so the spend cap silently did not exist. A hand-edited file is the
 * normal case for this project (the owner is expected to edit it), so a wrong
 * field has to fail at load with a sentence about which field, not months later
 * as an absence of behaviour.
 */
export const ConfigSchema = z.object({
  schemaVersion: z.number().int().positive(),
  provider: z.object({
    /** Explicit, never inferred from the URL: a wrong guess fails at the first call. */
    kind: z.enum(['anthropic', 'openai-compat']),
    baseUrl: z.string().url().optional(),
    /** `secret://name` — resolved through the secret store, never inlined here. */
    apiKeyRef: z.string().min(1),
  }),
  models: z.object({ main: z.string().min(1), light: z.string().min(1), deep: z.string().min(1).optional() }),
  // Non-negative rather than positive: zero is a legitimate cap, meaning stop.
  budget: z.object({ monthlyUsd: z.number().nonnegative(), perTenantDailyUsd: z.number().nonnegative() }),
  rot: z.object({ mode: z.enum(['hardened', 'single-user']) }),
  traces: z.object({ retentionDays: z.number().int().positive() }),
  surfaces: z.object({
    /** Where Muffin speaks when nobody asked. Deliberately not the CLI by default. */
    default: z.string().min(1),
    enabled: z.array(z.string().min(1)).min(1),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Omit<Config, 'provider' | 'models'> = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  budget: { monthlyUsd: 80, perTenantDailyUsd: 2 },
  rot: { mode: 'single-user' },
  traces: { retentionDays: 90 },
  surfaces: { default: 'cli', enabled: ['cli'] },
};

export function muffinHome(): string {
  return process.env['MUFFIN_HOME'] ?? join(homedir(), '.muffin');
}

export const paths = (home = muffinHome()) => ({
  home,
  config: join(home, 'config.json'),
  db: join(home, 'muffin.db'),
  rot: join(home, 'rot'),
  vault: join(home, 'vault'),
  traces: join(home, 'traces'),
  sessions: join(home, 'sessions'),
  secrets: join(home, 'secrets'),
});

export function loadConfig(home = muffinHome()): Config {
  const file = paths(home).config;
  if (!existsSync(file)) {
    throw new ConfigError(`no config at ${file}`, 'run `muffin init` first');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'fix the syntax, or move it aside and run `muffin init`',
    );
  }

  // Version first: a file from a future build will fail validation for reasons
  // that have nothing to do with the real problem.
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(
      `config schemaVersion ${String(version)}, this build understands ${CONFIG_SCHEMA_VERSION}`,
      'upgrade muffin, or migrate the file by hand',
    );
  }

  const validated = ConfigSchema.safeParse(raw);
  if (!validated.success) {
    // Names the field. "config non valida" sends someone reading the schema.
    const issues = validated.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`${file} is invalid — ${issues}`, 'fix those fields, or re-run `muffin init --force`');
  }
  return validated.data;
}

export function saveConfig(config: Config, home = muffinHome()): void {
  const file = paths(home).config;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Secrets live in a 0600 file, referenced by name from the config.
 *
 * Stated plainly rather than dressed up: this is filesystem permissions, not
 * encryption at rest. It keeps keys out of the config, out of the traces (see
 * tracing/redact.ts) and out of any diff, which is what actually leaks them in
 * practice. Age-encrypted storage is a declared gap, not a silent one.
 */
export function readSecret(ref: string, home = muffinHome()): string {
  const name = requireSecretRef(ref);
  const file = join(paths(home).secrets, name);
  if (!existsSync(file)) {
    throw new ConfigError(`missing secret "${name}"`, `write it with \`muffin secret set ${name}\``);
  }
  return readFileSync(file, 'utf8').trim();
}

export function writeSecret(name: string, value: string, home = muffinHome()): void {
  const dir = paths(home).secrets;
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const file = join(dir, name);
  writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600);
}

export function requireSecretRef(ref: string): string {
  const name = ref.startsWith('secret://') ? ref.slice('secret://'.length) : null;
  if (!name || !/^[a-z0-9_]+$/i.test(name)) {
    throw new ConfigError(`malformed secret reference: ${ref}`, 'expected secret://<name>');
  }
  return name;
}

/** Carries the remedy with the error: a config failure the user cannot fix is a bug. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}
