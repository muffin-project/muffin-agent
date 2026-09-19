import DatabaseCtor from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA as BUDGET_SCHEMA } from '../core/budget/budget.js';
import { schemaVersionOf, stampFresh } from '../core/db/migrate.js';
import { seal } from '../core/rot/verify.js';
import { isShippedDefault, recordCopied } from '../core/config/defaults-drift.js';
import { LEGACY_API_KEY_NAME, apiKeyCandidates, apiKeyNameFor } from '../core/config/providers.js';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  loadConfig,
  locateSecret,
  paths,
  saveConfig,
  writeAuthoritativeSecret,
  writeSecret,
  type Config,
  type ProviderKind,
  type SecretBackend,
} from '../core/config/config.js';
import { describeWorkspace } from '../core/config/workspace.js';

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
 * `--local`'s default and its explicit form (DAY-1 requirement A9). Just a path — never a
 * claim about whether it exists yet: `runInit` creates it below the same way
 * it creates a first-run home.
 */
export function resolveLocalHome(dirArg: string | undefined): string {
  return dirArg !== undefined ? resolve(dirArg) : join(homedir(), '.muffin-local');
}

/**
 * Re-exported, not defined here: both moved to `core/config/workspace.ts`, where
 * `resolveWorkspace` needs the same symlink-aware containment test this file's
 * `--local` guard needs, and `core/` may not import `cli/`. The spelling stays
 * available from here because `cli/update.ts` and `cli/main.ts` import it from
 * this module and the question they ask has not changed.
 */
export { isSameOrNestedPath, realishPath } from '../core/config/workspace.js';

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

  // La v2 del prompt, accanto alla v1 e non al posto suo. Copiata come le
  // skill — stesso `installTree`, stessa regola «copia, non sovrascrivere» —
  // perché sono file che l'owner riscriverà: `defaults/v2/` senza questa riga
  // resterebbe leggibile solo dal pacchetto, e `muffin doctor` segnalerebbe due
  // default per sempre `missing`. Copiarli non li **usa**: l'assemblaggio resta
  // su v1 finché `config.prompt.version` non dice altro.
  const v2 = installTree('v2', join(p.home, 'v2'), options.force ?? false);
  step('prompt v2', v2.length > 0 ? `installed ${v2.length} files (non attivi: config.prompt.version resta v1)` : 'already present');

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
  for (const f of v2) copiedForRegistry.push({ path: `v2/${f.relPath}`, content: readFileSync(f.dst) });
  recordCopied(home, copiedForRegistry);

  // The CLI layer (cmdInit) owns key acquisition — flag, env, or the interactive
  // prompt — and its validation (e.g. rejecting a pasted Telegram token). Reading
  // the env here too would silently resurrect a key cmdInit deliberately dropped.
  const apiKey = options.apiKey;
  // An existing Home is NEVER rebuilt from defaults here. `runInit` is
  // idempotent/resumable by contract: on an existing Home it fills missing
  // bootstrap state only and preserves every existing owner field — models,
  // surfaces, provider routing, thinking, search/embedder, prompt, audio,
  // traces, rot mode. Replacing all of that with DEFAULT_CONFIG is what the
  // 2026-09-18 incident did (installer re-ran init on a configured Home and
  // every custom field silently became a default). Deliberate destruction is
  // `muffin uninstall` + init, never a re-run; `--force` only re-copies
  // shipped files, never the config.
  //
  // `loadConfig` throwing here is fail-closed, not a cue to overwrite: a
  // corrupt config is evidence the owner must see (cmdInit prints message +
  // remedy, exit 78), and overwriting it would destroy both the evidence and
  // any surviving fields.
  const prior = existsSync(p.config) ? loadConfig(home) : null;
  // Effective provider: explicit flags win; otherwise the existing Home's
  // provider stays — inference (key prefix, compiled default) is for fresh
  // setup only and must not rename a working config's provider out from
  // under it.
  const effProviderKind = options.provider ?? prior?.provider.kind ?? 'anthropic';
  const effBaseUrl = options.baseUrl ?? prior?.provider.baseUrl;
  const provider = { kind: effProviderKind, ...(effBaseUrl !== undefined ? { baseUrl: effBaseUrl } : {}) };
  // Il nome viene dal catalogo — `openrouter_api_key`, non `provider_api_key` —
  // e sotto quel nome si **scrive**. Cercare, invece, si fa sotto entrambi:
  // `apiKeyCandidates` mette prima il nome del provider e poi il generico, e
  // quell'ordine è tutta la migrazione. Un'installazione già fatta trova solo
  // il secondo e continua a funzionare senza che nessuno tocchi niente.
  const nomeChiave = apiKeyNameFor(provider);
  // Secret-reference invariant: a rename must never point the config at a new
  // name without atomically migrating the value. So on an existing Home the
  // current reference wins whenever it still resolves — even if a
  // "newer" candidate file also exists (doctor already reports that
  // duplication); a supplied key writes first and then points (migration);
  // a stale reference with no value anywhere is KEPT as-is (missing step,
  // honest) rather than invented anew — inventing the new name is exactly
  // the silent credential loss this rule exists to prevent.
  let riferimento: string;
  let chiaveDettaglio: string;
  let chiaveOk = true;
  if (apiKey) {
    const backend = options.secretBackend ?? 'home';
    const at = backend === 'persistent'
      ? writeAuthoritativeSecret(nomeChiave, apiKey, home)
      : writeSecret(nomeChiave, apiKey, home, backend);
    riferimento = `secret://${nomeChiave}`;
    chiaveDettaglio = `stored 0600 in ${at}`;
  } else if (prior?.provider.apiKeyRef && locateSecret(prior.provider.apiKeyRef, home) !== null) {
    riferimento = prior.provider.apiKeyRef;
    chiaveDettaglio = `già presente: ${locateSecret(prior.provider.apiKeyRef, home)?.path} (riferimento esistente conservato)`;
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
      chiaveDettaglio =
        `già presente (${trovato.dove?.backend ?? '?'}): ${trovato.dove?.path ?? '?'}` +
        (eredita ? ` — col nome vecchio \`${LEGACY_API_KEY_NAME}\`, che resta valido` : '');
    } else if (prior?.provider.apiKeyRef) {
      riferimento = prior.provider.apiKeyRef;
      chiaveDettaglio = 'missing — riferimento esistente conservato, ma nessun valore trovato: echo -n "$KEY" | muffin init, oppure lanciala in un terminale e incollala al prompt';
      chiaveOk = false;
    } else {
      riferimento = `secret://${nomeChiave}`;
      chiaveDettaglio = 'missing — echo -n "$KEY" | muffin init, oppure lanciala in un terminale e incollala al prompt';
      chiaveOk = false;
    }
  }
  step('api key', chiaveDettaglio, chiaveOk);

  const defaults = defaultModels({ provider: effProviderKind });
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...prior,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    provider: {
      ...prior?.provider,
      kind: effProviderKind,
      ...(effBaseUrl !== undefined ? { baseUrl: effBaseUrl } : {}),
      apiKeyRef: riferimento,
    },
    models: {
      ...prior?.models,
      main: options.mainModel ?? prior?.models.main ?? defaults.main,
      light: options.lightModel ?? prior?.models.light ?? defaults.light,
    },
    rot: { mode: options.hardened ? 'hardened' : (prior?.rot.mode ?? 'single-user') },
  };
  saveConfig(config, home);
  step('config', prior ? 'esistente conservata (solo bootstrap/mancanti)' : p.config);

  const db = new DatabaseCtor(p.db);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(BUDGET_SCHEMA);
  // A fresh install is born at HEAD: stamp every version without running
  // migrations written for yesterday's populated data (RETURN S2). Later
  // boots go through `migrate()` in buildRuntime and find nothing pending.
  // On an EXISTING database stamping would mark migrations applied that never
  // ran on that data (backfills skipped, version claims current) — so stamp
  // only when no schema version exists yet and leave real data to boot-time
  // migrate(). Same clobber class as the config reset above, quieter.
  if (schemaVersionOf(db) === null) stampFresh(db);
  db.close();
  step('database', `${p.db} (WAL)`);

  // Sealing last: the manifest has to describe the files as they ended up,
  // including anything the steps above wrote into the root of trust.
  const manifest = seal(home, CONFIG_SCHEMA_VERSION.toString(), new Date());
  step('sealed', `${manifest.files.length} files hashed, anchor written`);

  // ADR-0059: named, not created. `resolveWorkspace` (`core/config/
  // workspace.ts`) makes the directory lazily, at the first `buildRuntime` —
  // `muffin run`/the REPL may honour a project directory the owner is already
  // standing in and never touch this default at all, the same reason `traces/`
  // is not created here either. But lazy must not mean silent: before this
  // step the only place that ever named the workspace was a boot line on
  // stderr that reaches `gateway.err` and nowhere a person looks, so a fresh
  // install answered "dove hai scritto?" with nothing. `describeWorkspace`
  // only reads — the same function `muffin doctor` and `sys.inspect` read
  // through, never a second computation that could name a different folder.
  const workspace = describeWorkspace(home);
  step(
    'workspace',
    workspace.exists
      ? `${workspace.workspace} — qui atterrano le scritture di un turno`
      : `${workspace.workspace} (si crea da sola al primo turno che ci scrive)`,
  );

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
