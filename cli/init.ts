import DatabaseCtor from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA as BUDGET_SCHEMA } from '../core/budget/budget.js';
import { stampFresh } from '../core/db/migrate.js';
import { seal } from '../core/rot/verify.js';
import { isShippedDefault, recordCopied } from '../core/config/defaults-drift.js';
import { LEGACY_API_KEY_NAME, apiKeyCandidates, apiKeyNameFor } from '../core/config/providers.js';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  locateSecret,
  paths,
  saveConfig,
  writeSecret,
  type Config,
  type ProviderKind,
  type SecretBackend,
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
  /** Where `apiKey` is written. `persistent` survives `muffin uninstall`. */
  secretBackend?: SecretBackend;
  hardened?: boolean;
  force?: boolean;
};

export type InitStep = { name: string; done: boolean; detail: string };

/**
 * `--local`'s default and its explicit form (M5-BIS A9). Just a path — never a
 * claim about whether it exists yet: `runInit` creates it below the same way
 * it creates a first-run home.
 */
export function resolveLocalHome(dirArg: string | undefined): string {
  return dirArg !== undefined ? resolve(dirArg) : join(homedir(), '.muffin-local');
}

/**
 * The realpath of `target`, resolved even when it — or an ancestor — does not
 * exist yet: walks up to the deepest entry that does, resolves *that* through
 * any symlink, and re-attaches whatever was still missing. `isSameOrNestedPath`
 * needs this because the directory `--local` names is usually about to be
 * created, so a plain `realpathSync` would throw `ENOENT` on the one case that
 * matters most (a first rehearsal of a fresh install).
 *
 * Exported for `cli/update.ts`'s launcher-identity check: a launcher symlink
 * can legitimately point at a release whose `dist/` a failed build never
 * finished writing, and the same "resolve as far as it exists" need applies —
 * `realpathSync` alone throws `ENOENT` on that dangling target exactly when
 * the caller most needs an answer, not an exception.
 */
export function realishPath(target: string): string {
  let current = resolve(target);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current; // filesystem root: nothing left to resolve against
    missing.unshift(basename(current));
    current = parent;
  }
  return missing.length > 0 ? join(realpathSync(current), ...missing) : realpathSync(current);
}

// macOS and Windows volumes are case-insensitive by default — `~/.Muffin` and
// `~/.muffin` name the same directory, and a plain string compare would miss it.
const CASE_BLIND = process.platform === 'darwin' || process.platform === 'win32';

/**
 * True when `candidate` is `base`, or sits somewhere inside it — compared
 * through symlinks, never the literal strings. The guard `--local` runs
 * before it ever calls `mkdirSync`: a throwaway rehearsal home must never be
 * able to land on, or under, the real home it exists to leave untouched.
 */
export function isSameOrNestedPath(candidate: string, base: string): boolean {
  const norm = (p: string): string => (CASE_BLIND ? p.toLowerCase() : p);
  const c = norm(realishPath(candidate));
  const b = norm(realishPath(base));
  if (c === b) return true;
  const rel = relative(b, c);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function runInit(options: InitOptions = {}): InitStep[] {
  const home = options.home ?? paths().home;
  const p = paths(home);
  const steps: InitStep[] = [];
  const step = (name: string, detail: string, done = true) => steps.push({ name, done, detail });

  for (const dir of [p.home, p.rot, p.vault, p.traces, p.sessions, p.secrets]) {
    mkdirSync(dir, { recursive: true });
  }
  step('directories', p.home);

  const installed = installTree('rot', p.rot, options.force ?? false);
  step('root of trust', installed.length > 0 ? `installed ${installed.length} files` : 'already present');

  // Le skill di serie. Senza questo il meccanismo c'è tutto — scoperta, sezione
  // nel prompt, `skill_read` — e non ha niente da scoprire: `skillsPromptSection`
  // torna stringa vuota, il modello non sente mai la parola «skill», e
  // `skill_read` resta un tool che non può leggere nulla. Un'installazione nuova
  // deve saper già fare qualcosa, non solo essere in grado di imparare.
  const skills = installTree('skills', join(p.home, 'skills'), options.force ?? false);
  step('skills', skills.length > 0 ? `installed ${skills.length} files` : 'already present');

  // voice.md lives outside the root of trust on purpose: it is the part that
  // learns, and the ratchet may rewrite it. identity.md is the part that does not.
  const voiceInstalled = installFile('voice.md', p.voice, options.force ?? false);
  step('voice', voiceInstalled ? 'installed voice.md (modificabile, fuori dal RoT)' : 'already present');

  // Pure muffin: the same character for every install, which is what stops a
  // fresh one from having none at all. identity.md ships empty by design — it
  // is the owner's — so without this file a first run had three bullet points
  // and a set of formatting rules standing in for a personality.
  const personaInstalled = installFile('persona.md', p.persona, options.force ?? false);
  step('persona', personaInstalled ? 'installed persona.md (uguale per tutti)' : 'already present');

  // Only the files this run actually wrote — never the ones found already
  // present, which may already carry the owner's own edits (see
  // recordCopied's own docstring for why stamping those would be wrong).
  // `muffin doctor` reads this back through diagnoseDefaultsDrift to tell a
  // never-touched shipped file from an owner edit, no Git required.
  const copiedForRegistry: { path: string; content: Buffer }[] = [];
  if (personaInstalled) copiedForRegistry.push({ path: 'persona.md', content: readFileSync(p.persona) });
  if (voiceInstalled) copiedForRegistry.push({ path: 'voice.md', content: readFileSync(p.voice) });
  for (const f of installed) copiedForRegistry.push({ path: `rot/${f.relPath}`, content: readFileSync(f.dst) });
  // Anche le skill: sono il tipo di file che l'owner riscrive, ed è
  // esattamente la distinzione che il registro esiste per tenere —
  // «di serie, mai toccata» contro «modificata da chi la usa».
  for (const f of skills) copiedForRegistry.push({ path: `skills/${f.relPath}`, content: readFileSync(f.dst) });
  recordCopied(home, copiedForRegistry);

  // The CLI layer (cmdInit) owns key acquisition — flag, env, or the interactive
  // prompt — and its validation (e.g. rejecting a pasted Telegram token). Reading
  // the env here too would silently resurrect a key cmdInit deliberately dropped.
  const apiKey = options.apiKey;
  // Il nome viene dal catalogo — `openrouter_api_key`, non `provider_api_key` —
  // e sotto quel nome si **scrive**. Cercare, invece, si fa sotto entrambi:
  // `apiKeyCandidates` mette prima il nome del provider e poi il generico, e
  // quell'ordine è tutta la migrazione. Un'installazione già fatta trova solo
  // il secondo e continua a funzionare senza che nessuno tocchi niente.
  const provider = { kind: options.provider ?? 'anthropic', ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) };
  const nomeChiave = apiKeyNameFor(provider);
  // Il riferimento scritto in config è quello del nome **davvero trovato**, non
  // il nome nuovo per principio: scrivere `secret://openrouter_api_key` su
  // un'installazione che ha la chiave sotto il vecchio nome la spegnerebbe, ed
  // è esattamente il rename secco che questa forma esiste per non fare.
  let riferimento = `secret://${nomeChiave}`;
  if (apiKey) {
    const at = writeSecret(nomeChiave, apiKey, home, options.secretBackend ?? 'home');
    step('api key', `stored 0600 in ${at}`);
  } else {
    // The dev loop `muffin uninstall --yes && muffin init` wipes `home` and then
    // arrives here with nothing. It used to be rescued by `MUFFIN_API_KEY` out of
    // a `.env` in the working directory — a file the agent's own `fs_read` could
    // open (ADR-0030's wart, closed by ADR-0039). The persistent store is the
    // replacement, and it is found by *asking the chain*, never by copying the
    // key into the home that is about to be wiped again: a second copy is how the
    // budget cap ended up in two files.
    const candidati = apiKeyCandidates(provider);
    const trovato = candidati
      .map((nome) => ({ nome, dove: locateSecret(`secret://${nome}`, home) }))
      .find((c) => c.dove !== null);
    if (trovato) {
      riferimento = `secret://${trovato.nome}`;
      const eredita = trovato.nome === LEGACY_API_KEY_NAME && nomeChiave !== LEGACY_API_KEY_NAME;
      step(
        'api key',
        `già presente (${trovato.dove?.backend ?? '?'}): ${trovato.dove?.path ?? '?'}` +
          (eredita ? ` — col nome vecchio \`${LEGACY_API_KEY_NAME}\`, che resta valido` : ''),
      );
    } else {
      step('api key', 'missing — echo -n "$KEY" | muffin init, oppure lanciala in un terminale e incollala al prompt', false);
    }
  }

  const config: Config = {
    ...DEFAULT_CONFIG,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    provider: {
      kind: options.provider ?? 'anthropic',
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      apiKeyRef: riferimento,
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
  // A fresh install is born at HEAD: stamp every version without running
  // migrations written for yesterday's populated data (RETURN S2). Later
  // boots go through `migrate()` in buildRuntime and find nothing pending.
  stampFresh(db);
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
 *
 * Exported so `cmdInit` can compute the same pair for `describeModelChoice`
 * without duplicating the fallback logic — it needs to print what got decided
 * even when nothing overrode it (slice/init-interroga: the print is
 * unconditional, TTY or not), which means it has to be able to ask this
 * function the same question `runInit` asks it internally.
 */
export function defaultModels(options: InitOptions): { main: string; light: string } {
  const compat = (options.provider ?? 'anthropic') === 'openai-compat';
  return {
    main: options.mainModel ?? (compat ? 'anthropic/claude-sonnet-5' : 'claude-sonnet-5'),
    light: options.lightModel ?? (compat ? 'anthropic/claude-haiku-4.5' : 'claude-haiku-4-5-20251001'),
  };
}

/** Never overwrites a personalised file: a second `init` must not undo your edits. */
function installFile(name: string, dest: string, force: boolean): boolean {
  if (!force && existsSync(dest)) return false;
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'defaults', name), dest);
  return true;
}

/**
 * Copies a whole shipped subtree of `defaults/` without ever overwriting a
 * personalised file.
 *
 * Returns the *relative* path from `destDir` for each file actually written
 * (e.g. `evals/voice.json`, not just `voice.json`) — `recordCopied`
 * (core/config/defaults-drift.ts) needs that full path to key the registry
 * against `defaults/<sub>/<relPath>`, and a bare basename would silently
 * collide two files of the same name nested at different depths.
 *
 * Preso da `rot` e reso parametrico quando sono arrivate le skill: sono due
 * alberi con la stessa regola («copia, non sovrascrivere, e dichiara cosa hai
 * scritto»), e una seconda copia della camminata sarebbe stata libera di
 * divergere proprio sul ramo che non si guarda.
 */
function installTree(sub: string, destDir: string, force: boolean): { relPath: string; dst: string }[] {
  const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'defaults', sub);
  if (!existsSync(source)) return [];
  const copied: { relPath: string; dst: string }[] = [];
  const walk = (from: string, to: string, prefix: string): void => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      const src = join(from, entry);
      const dst = join(to, entry);
      const relPath = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(src).isDirectory()) walk(src, dst, relPath);
      // La stessa regola che usa la diagnosi, dalla stessa funzione: due copie
      // deriverebbero, e la copia che conta di piu' e' questa — uno dei tre
      // alberi che questo walk copia e' `defaults/rot/`, che e' sigillato.
      else if (isShippedDefault(relPath) && (force || !existsSync(dst))) {
        copyFileSync(src, dst);
        copied.push({ relPath, dst });
      }
    }
  };
  walk(source, destDir, '');
  return copied;
}
