import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * One home, one config file, one database. Backup, export and "delete
 * everything about me" all have to be a single path — that is worth more than
 * XDG's three directories for a system whose data is this personal.
 */

/**
 * 2 since the spend caps left this file.
 *
 * They lived here *and* in the sealed `rot/budgets.json`, and the one that bound
 * was the copy nobody sealed. Keeping a deprecated-but-parsed `budget` would
 * have been the same defect wearing a warning label — a number that reads as the
 * cap and is not — so the field is gone and `loadConfig` migrates a v1 file in
 * memory instead of refusing to open it. See `core/rot/budgets.ts`.
 */
export const CONFIG_SCHEMA_VERSION = 2;

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
  /**
   * Absent means no web search, and the tool is simply not registered — the
   * same posture as the shell without a working sandbox. A capability that
   * costs the owner money per call does not get switched on by a default.
   */
  search: z
    .object({
      provider: z.literal('tavily'),
      /** `secret://name`, like the model key. Never the key itself. */
      apiKeyRef: z.string().min(1),
      maxResults: z.number().int().min(1).max(20).optional(),
    })
    .optional(),
  // No `budget` here, deliberately. The caps are a rail, so they live inside the
  // seal (`rot/budgets.json`, read by `core/rot/budgets.ts`) and this file — which
  // the agent is meant to be able to change while talking (ADR-0036) — must not
  // carry a second copy of them.
  rot: z.object({ mode: z.enum(['hardened', 'single-user']) }),
  traces: z.object({ retentionDays: z.number().int().positive() }),
  surfaces: z.object({
    /** Where Muffin speaks when nobody asked. Deliberately not the CLI by default. */
    default: z.string().min(1),
    enabled: z.array(z.string().min(1)).min(1),
    /**
     * Per-surface settings. The owner chat id lives here and not in an env var:
     * it is configuration, it survives a reboot, and `muffin surface enable`
     * writes it once instead of every shell needing to export it.
     */
    telegram: z
      .object({
        /**
         * Who the owner *is*. Absent means unpaired, and unpaired means nobody
         * is the owner — which is the fail-closed direction and the whole point
         * of replacing "whoever messaged first".
         */
        ownerUserId: z.number().int().optional(),
        /** Where to deliver. A room, which is a different question from who. */
        ownerChatId: z.number().int().optional(),
        /** The outstanding pairing code, hashed. Cleared the moment it matches. */
        pairing: z
          .object({
            hash: z.string().min(1),
            expiresAt: z.string().min(1),
            attempts: z.number().int().nonnegative(),
          })
          .optional(),
        /**
         * Where the Bot API lives, when it is not Telegram's own servers.
         *
         * A documented deployment mode, not a test hook: Telegram publishes
         * the Bot API server as software you can run yourself — *"You can run
         * it locally and send the requests to your own server instead of
         * `https://api.telegram.org`"* (core.telegram.org/bots/api) — and it
         * is what removes the download size limit and allows plain-HTTP
         * webhooks. The request shape is identical either way,
         * `<base>/bot<token>/METHOD`, which is why one field is enough.
         *
         * It also happens to be the seam the acceptance suite was missing.
         * `evals/acceptance/provider.ts` can point the real binary at a fake
         * model because `init --base-url` exists; Telegram had no equivalent,
         * so pairing and delivery were provable only in-process — the exact
         * "green tests no real path reaches" gap `harness.ts` was built
         * against. Left absent, the default is Telegram's own host.
         */
        apiBase: z.string().url().optional(),
      })
      .optional(),
    /**
     * Same shape as `telegram`, one field different: `ownerUserId` is a
     * **string**, never `z.number()`. A Discord snowflake is a 64-bit id — real
     * ones already exceed `Number.MAX_SAFE_INTEGER` (2^53), so parsing one
     * through `z.number()` would silently round it, and a config file is
     * exactly the hand-edited, JSON-serialised path where that rounding is
     * invisible until the id it produces never matches anyone.
     */
    discord: z
      .object({
        ownerUserId: z.string().regex(/^[0-9]+$/).optional(),
        pairing: z
          .object({
            hash: z.string().min(1),
            expiresAt: z.string().min(1),
            attempts: z.number().int().nonnegative(),
          })
          .optional(),
      })
      .optional(),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Omit<Config, 'provider' | 'models'> = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
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
  // Outside the root of trust on purpose: the voice is the part that learns,
  // so the agent may propose changes to it through the ratchet. `identity.md`
  // lives under rot/ and stays fixed. One entry here rather than the same
  // join() written out at each call site.
  voice: join(home, 'voice.md'),
  // Pure muffin — the character every install shares. `identity.md` under rot/
  // is the owner's overlay on top of it and is read after, so it wins.
  persona: join(home, 'persona.md'),
  vault: join(home, 'vault'),
  traces: join(home, 'traces'),
  sessions: join(home, 'sessions'),
  secrets: join(home, 'secrets'),
});

/**
 * The v1 → v2 step: `budget` stops living here.
 *
 * In memory, not on disk, and that is the whole migration story. A loader that
 * rewrites the file it was asked to read is a surprise in every read-only
 * command and a race between the gateway and a REPL; `saveConfig` writes the
 * current version anyway, so the file upgrades itself the first time anything
 * changes a setting. Until then every load repairs it again, which is what
 * "idempotent" has to mean for a step nobody runs on purpose.
 *
 * The dropped numbers are **not** copied into `rot/budgets.json`. Letting an
 * unsealed file's value flow into the seal on its own is precisely the hole this
 * closes, so the note says what was there and leaves the decision — and the
 * `muffin rot reseal` that carries it — to the owner.
 */
function migrateV1(raw: Record<string, unknown>, note: (line: string) => void): Record<string, unknown> {
  const { budget, ...rest } = raw;
  if (budget !== null && typeof budget === 'object') {
    const b = budget as { monthlyUsd?: unknown; perTenantDailyUsd?: unknown };
    note(
      `config.json era schemaVersion 1: "budget" non vive più qui — il tetto viene da rot/budgets.json, ` +
        `dentro il sigillo. I valori che c'erano (monthlyUsd ${String(b.monthlyUsd)}, ` +
        `perTenantDailyUsd ${String(b.perTenantDailyUsd)}) non sono stati copiati: se vuoi quel tetto, ` +
        `scrivilo in rot/budgets.json e fai \`muffin rot reseal\`.`,
    );
  }
  return { ...rest, schemaVersion: 2 };
}

/** Indexed by the version being left behind, so the ladder reads in one direction. */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>, note: (line: string) => void) => Record<string, unknown>> = {
  1: migrateV1,
};

/**
 * @param onNote receives one line per migration step that changed something.
 *   Nothing here is silent by design: a config whose meaning shifted under the
 *   owner has to say so somewhere they look, so `buildRuntime` prints these at
 *   boot and `doctor` shows them as a check. Callers that do not pass it are
 *   read-only paths where the note would have nowhere to go.
 */
export function loadConfig(home = muffinHome(), onNote: (line: string) => void = () => {}): Config {
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
  // that have nothing to do with the real problem. An *older* one is not that
  // case — it is a home that has been here longer than the schema, which is the
  // normal case for the only install that exists, so it gets migrated rather
  // than refused. Bricking it would have been a fix worse than the defect.
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ConfigError(
      `config schemaVersion ${String(version)}, this build understands ${CONFIG_SCHEMA_VERSION}`,
      'fix the field, or move the file aside and run `muffin init`',
    );
  }
  if (version > CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(
      `config schemaVersion ${version}, this build understands ${CONFIG_SCHEMA_VERSION}`,
      'upgrade muffin — a newer build wrote this file',
    );
  }
  let migrated = raw as Record<string, unknown>;
  for (let v = version; v < CONFIG_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new ConfigError(
        `no migration from config schemaVersion ${v} to ${v + 1}`,
        'upgrade muffin, or migrate the file by hand',
      );
    }
    migrated = step(migrated, onNote);
  }

  const validated = ConfigSchema.safeParse(migrated);
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
 * Where a secret may live. Ordered: `home` is asked first.
 *
 * `home` is this install's own store, inside `MUFFIN_HOME`. `persistent` is a
 * fixed path outside it — `$XDG_CONFIG_HOME/muffin/secrets/` — and exists so the
 * dev loop `muffin uninstall --yes && muffin init` finds the key again without
 * re-pasting it. That is ADR-0030's actual principle (*"la chiave vive fuori
 * dalla home wipeata"*) with the CWD-dependence removed: the old answer was a
 * gitignored `.env` in the working directory, which `fs_read` can open, because
 * `root` is the repo and the ceiling for a low-risk read is taint 3.
 *
 * **Why `home` wins.** A per-install secret must be able to shadow the shared
 * one, or `muffin secret set` becomes a command with no effect on a machine that
 * has a persistent key. The other order fails silently, which is the direction
 * that never gets noticed.
 */
export type SecretBackend = 'home' | 'persistent';

export const SECRET_BACKENDS: readonly SecretBackend[] = ['home', 'persistent'];

function xdgConfigHome(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  return xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config');
}

export function secretDir(backend: SecretBackend, home = muffinHome()): string {
  return backend === 'home' ? paths(home).secrets : join(xdgConfigHome(), 'muffin', 'secrets');
}

export type SecretLocation = { backend: SecretBackend; path: string };

/**
 * Which backend answers for this name, without reading the value.
 *
 * Separate from `readSecret` so `doctor` can say *where* the key came from
 * without loading it. A chain nobody can see is how a hardened install keeps
 * reading the old copy forever — the migration looks done from every angle
 * except the one that matters.
 */
export function locateSecret(ref: string, home = muffinHome()): SecretLocation | null {
  const name = requireSecretRef(ref);
  for (const backend of SECRET_BACKENDS) {
    const path = join(secretDir(backend, home), name);
    if (existsSync(path)) return { backend, path };
  }
  return null;
}

/** Every backend that holds this name. More than one means one is shadowing the other. */
export function locateSecretAll(ref: string, home = muffinHome()): SecretLocation[] {
  const name = requireSecretRef(ref);
  return SECRET_BACKENDS.map((backend) => ({ backend, path: join(secretDir(backend, home), name) })).filter(
    (l) => existsSync(l.path),
  );
}

/**
 * Secrets live in a 0600 file, referenced by name from the config.
 *
 * Stated plainly rather than dressed up: this is filesystem permissions, not
 * encryption at rest. It keeps keys out of the config, out of the traces (see
 * tracing/redact.ts) and out of any diff, which is what actually leaks them in
 * practice. Age-encrypted storage is a declared gap, not a silent one.
 *
 * Both directories are on the tools' `denyRead` list (`agent/runtime.ts`), so
 * adding a backend here without adding it there re-opens the hole this chain was
 * built to close.
 */
export function readSecret(ref: string, home = muffinHome()): string {
  const name = requireSecretRef(ref);
  const found = locateSecret(ref, home);
  if (!found) {
    throw new ConfigError(
      `missing secret "${name}" — cercato in ${SECRET_BACKENDS.map((b) => secretDir(b, home)).join(' e ')}`,
      `write it with \`muffin secret set ${name}\` (aggiungi --persist perché sopravviva a \`muffin uninstall\`)`,
    );
  }
  return readFileSync(found.path, 'utf8').trim();
}

export function writeSecret(
  name: string,
  value: string,
  home = muffinHome(),
  backend: SecretBackend = 'home',
): string {
  const dir = secretDir(backend, home);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const file = join(dir, name);
  writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
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
