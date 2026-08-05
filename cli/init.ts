import DatabaseCtor from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA as BUDGET_SCHEMA } from '../core/budget/budget.js';
import { seal } from '../core/rot/verify.js';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  paths,
  saveConfig,
  writeSecret,
  type Config,
  type ProviderKind,
} from '../core/config/config.js';

/**
 * Bootstrap.
 *
 * Idempotent and resumable by construction: every step checks its own outcome,
 * so a Ctrl+C halfway through is repaired by running the command again rather
 * than by knowing which half failed. That property matters more than elegance —
 * the one moment a user is least willing to debug is the first one.
 *
 * Interactive prompts only when stdin is a TTY. Headless, a missing value is an
 * error that names the flag; nothing here waits forever on a pipe.
 */

export type InitOptions = {
  home?: string;
  provider?: ProviderKind;
  baseUrl?: string;
  mainModel?: string;
  lightModel?: string;
  apiKey?: string;
  hardened?: boolean;
  force?: boolean;
};

export type InitStep = { name: string; done: boolean; detail: string };

export function runInit(options: InitOptions = {}): InitStep[] {
  const home = options.home ?? paths().home;
  const p = paths(home);
  const steps: InitStep[] = [];
  const step = (name: string, detail: string, done = true) => steps.push({ name, done, detail });

  for (const dir of [p.home, p.rot, p.vault, p.traces, p.sessions, p.secrets]) {
    mkdirSync(dir, { recursive: true });
  }
  step('directories', p.home);

  const installed = installRotDefaults(p.rot, options.force ?? false);
  step('root of trust', installed.length > 0 ? `installed ${installed.length} files` : 'already present');

  const apiKey = options.apiKey ?? process.env['MUFFIN_API_KEY'];
  if (apiKey) {
    writeSecret('provider_api_key', apiKey, home);
    step('api key', 'stored 0600 in secrets/provider_api_key');
  } else {
    step('api key', 'missing — set MUFFIN_API_KEY or pass --api-key', false);
  }

  const config: Config = {
    ...DEFAULT_CONFIG,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    provider: {
      kind: options.provider ?? 'anthropic',
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      apiKeyRef: 'secret://provider_api_key',
    },
    models: defaultModels(options),
    rot: { mode: options.hardened ? 'hardened' : 'single-user' },
  };
  saveConfig(config, home);
  step('config', p.config);

  const db = new DatabaseCtor(p.db);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(BUDGET_SCHEMA);
  db.close();
  step('database', `${p.db} (WAL)`);

  // Sealing last: the manifest has to describe the files as they ended up,
  // including anything the steps above wrote into the root of trust.
  const manifest = seal(home, CONFIG_SCHEMA_VERSION.toString(), new Date());
  step('sealed', `${manifest.files.length} files hashed, anchor written`);

  return steps;
}

/**
 * Two lanes from the first run, never one.
 *
 * A single-model install is how extraction, judging and consolidation end up on
 * a frontier model: each call is small, none of them look expensive, and the
 * bill arrives at the end of the month. The ids differ by provider — through an
 * OpenAI-compatible gateway they carry a vendor prefix, against Anthropic
 * directly they do not.
 */
function defaultModels(options: InitOptions): { main: string; light: string } {
  const compat = (options.provider ?? 'anthropic') === 'openai-compat';
  return {
    main: options.mainModel ?? (compat ? 'anthropic/claude-sonnet-5' : 'claude-sonnet-5'),
    light: options.lightModel ?? (compat ? 'anthropic/claude-haiku-4.5' : 'claude-haiku-4-5-20251001'),
  };
}

/** Copies the shipped defaults without ever overwriting a personalised file. */
function installRotDefaults(rotDir: string, force: boolean): string[] {
  const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'defaults', 'rot');
  const copied: string[] = [];
  const walk = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      const src = join(from, entry);
      const dst = join(to, entry);
      if (statSync(src).isDirectory()) walk(src, dst);
      else if (force || !existsSync(dst)) {
        copyFileSync(src, dst);
        copied.push(entry);
      }
    }
  };
  walk(source, rotDir);
  return copied;
}
