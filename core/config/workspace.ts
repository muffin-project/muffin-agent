import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ConfigError, muffinHome } from './config.js';

/**
 * Where a turn works, which is never where Muffin is installed.
 *
 * ## The measured defect this module exists for
 *
 * The supervised gateway — the way Muffin actually runs on the owner's machine
 * and on the VPS — was handing the agent the **Muffin home** as its working
 * directory, and therefore as its write scope. Measured on the owner's live
 * process, 2026-09-03, not read off the code:
 *
 * ```text
 * $ lsof -p 45750 | awk '$4=="cwd"{print $9}'
 * /Users/…/.muffin
 * ```
 *
 * The chain had four links and no bug in any single one of them. The unit sets
 * `WorkingDirectory=${home}` (`core/gateway/unit.ts`) **on purpose** — ADR-0035
 * requires it, because a unit anchored to a checkout that moves fails at CHDIR
 * before the runtime loads and `Restart=always` crash-loops on a dead
 * directory. `cli/gateway.ts` then called `buildRuntime(home)` with no cwd,
 * `agent/runtime.ts` defaulted `cwd = process.cwd()`, and that cwd became both
 * `FsScope.root` and the sandbox's `writeScope`.
 *
 * So the defect is not the unit. It is that **"the directory the process runs
 * in" and "the directory a turn may write in" were the same variable**, and
 * they are two different questions with two different right answers: the
 * process must sit somewhere that never moves, and the turn must sit somewhere
 * that holds none of Muffin's own state.
 *
 * What that cost, measured against the production `SandboxExecutor` with the
 * real `mandatoryGuards` (`core/sandbox/home-not-workspace.test.ts` keeps the
 * measurement executable): `rot/` and `config.json` held, and everything else
 * in the home went through — `.rot-anchor` (a write there makes the next
 * `verify()` answer `anchor_mismatch`: safe mode, or a refused boot when
 * hardened), `muffin.db` (episodes, chunks, facts, turns, jobs, spend),
 * `voice.md`, `sessions/` (the whole conversation history). Reachable from a
 * turn whose content came from a forwarded message, a web page or a PDF.
 *
 * ## Why the workspace is outside the home, and not a carve-out inside it
 *
 * The tidy-looking alternative — deny the whole home, then allow one
 * subdirectory back — was measured before it was rejected, not argued about
 * (2026-09-03, seatbelt): with `denyWrite: [home]` and `allowWrite:
 * [home/workspace]`, a write **inside** the nested workspace came back
 * `Operation not permitted`. Deny beats a nested allow, so the carve-out is
 * not a carve-out: it is a workspace that does not work. Fail-closed, which is
 * the right direction, and useless, which is the wrong outcome. On Linux the
 * shape is different and no better — srt emits the deny binds *after* the
 * allow binds, so a `--ro-bind` over the home lands on top of the `--bind` of
 * anything beneath it — but the conclusion is the same, and a rule whose
 * safety depends on the emission order of two different mechanisms is exactly
 * the kind of thing this repository has shipped as a no-op before.
 *
 * Outside the home there is nothing to order: the deny and the allow do not
 * overlap, on either mechanism.
 */

// macOS and Windows volumes are case-insensitive by default — `~/.Muffin` and
// `~/.muffin` name the same directory, and a plain string compare would miss it.
const CASE_BLIND = process.platform === 'darwin' || process.platform === 'win32';

/**
 * The realpath of `target`, resolved even when it — or an ancestor — does not
 * exist yet: walks up to the deepest entry that does, resolves *that* through
 * any symlink, and re-attaches whatever was still missing. `isSameOrNestedPath`
 * needs this because the directory being tested is often about to be created,
 * so a plain `realpathSync` would throw `ENOENT` on the one case that matters
 * most (a first rehearsal of a fresh install, or a workspace nobody has used).
 *
 * Re-exported by `cli/init.ts`, which is where it used to live and where
 * `cli/update.ts` still imports it from: a launcher symlink can legitimately
 * point at a release whose `dist/` a failed build never finished writing, and
 * the same "resolve as far as it exists" need applies there. It moved down
 * here because `core/` may not import `cli/`, and the containment decision
 * below needs the same symlink-aware comparison the `--local` guard needed —
 * two copies of a path comparison are one comparison plus a hole.
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

/**
 * True when `candidate` is `base`, or sits somewhere inside it — compared
 * through symlinks, never the literal strings.
 *
 * Two callers, one question. `muffin init --local` runs it before `mkdirSync`
 * so a throwaway rehearsal home cannot land on the real one; `resolveWorkspace`
 * runs it so a turn's write scope cannot land on the installation. A symlink
 * must not be enough to defeat either.
 */
export function isSameOrNestedPath(candidate: string, base: string): boolean {
  const norm = (p: string): string => (CASE_BLIND ? p.toLowerCase() : p);
  const c = norm(realishPath(candidate));
  const b = norm(realishPath(base));
  if (c === b) return true;
  const rel = relative(b, c);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** The env var that moves the workspace, the sibling of `MUFFIN_HOME`. */
export const WORKSPACE_ENV = 'MUFFIN_WORKSPACE';

/**
 * The default workspace for an install: a **sibling** of the home, never a
 * child of it.
 *
 * Derived from the home rather than hard-coded at `~/muffin-workspace` so that
 * `MUFFIN_HOME=~/.muffin-local` and `MUFFIN_HOME=/var/lib/muffin` each get
 * their own, the same way ADR-0030 point 3 makes `MUFFIN_HOME` the one knob
 * that separates dev from prod. `~/.muffin` → `~/muffin-workspace`;
 * `/var/lib/muffin` → `/var/lib/muffin-workspace`.
 *
 * Visible, not dotted: this is the one directory the owner is expected to open
 * in a file manager, because it is where the agent's own files land.
 *
 * `MUFFIN_WORKSPACE` overrides it — and is ignored, with the default taking
 * over, if it names the home or anything inside it. An env var is not a
 * capability, and the one thing this function exists to guarantee is not
 * something a stray export gets to switch off.
 */
export function muffinWorkspace(home = muffinHome()): string {
  const requested = process.env[WORKSPACE_ENV];
  if (requested !== undefined && requested.trim() !== '') {
    const candidate = resolve(requested.trim());
    if (!isSameOrNestedPath(candidate, home)) return candidate;
  }
  return join(dirname(resolve(home)), `${basename(resolve(home)).replace(/^\./, '')}-workspace`);
}

/**
 * The workspace's status, read without creating anything.
 *
 * `resolveWorkspace` below is the only function allowed to decide and to
 * `mkdirSync` — calling it from a diagnostic would leave a directory on disk
 * as a side effect of asking a question, and would make "esiste già" and "non
 * esiste ancora" indistinguishable (it creates the directory either way).
 * `muffin doctor` needs exactly that distinction, so it reads through here
 * instead: the same default `muffinWorkspace` computes, `existsSync` and
 * nothing else.
 *
 * `sys.inspect` does not call this — it prints `Runtime.workspace` straight
 * from the live `resolveWorkspace` result `buildRuntime` already computed, so
 * a turn mid-way through an owner-chosen cwd is described accurately rather
 * than by this function's installation default. The two agree whenever
 * nobody has stood inside a project directory and typed `muffin` — which is
 * the case this function exists to make legible: a fresh install, or the
 * supervised gateway, where nothing chose a workspace at all.
 */
export type WorkspaceStatus = {
  /** The default an install falls back to absent an owner-chosen cwd. */
  workspace: string;
  exists: boolean;
  /**
   * Set when `MUFFIN_WORKSPACE` named the home, or somewhere inside it, and
   * `muffinWorkspace` silently fell back to the default because of it — the
   * one relocation a diagnostic run without any particular cwd can actually
   * see (a supervisor's imposed cwd is invisible from here; see above).
   */
  envRejected: { requested: string } | null;
};

export function describeWorkspace(home = muffinHome()): WorkspaceStatus {
  const workspace = muffinWorkspace(home);
  const raw = process.env[WORKSPACE_ENV];
  let envRejected: WorkspaceStatus['envRejected'] = null;
  if (raw !== undefined && raw.trim() !== '') {
    const candidate = resolve(raw.trim());
    if (isSameOrNestedPath(candidate, home)) envRejected = { requested: candidate };
  }
  return { workspace, exists: existsSync(workspace), envRejected };
}

/** What `resolveWorkspace` decided, and what the caller has to say about it. */
export type WorkspaceChoice = {
  /** Absolute, existing. Becomes `FsScope.root` and the sandbox write scope. */
  workspace: string;
  /**
   * The rejected directory, when one was rejected — kept as data, separate from
   * `notes`, because tests assert the decision and surfaces print the sentence.
   */
  relocatedFrom: string | null;
  /**
   * Owner-facing lines a surface must print, already written. Silence here
   * would be the failure mode this repository is named for: a mechanism that
   * works and a surface that never says it did anything.
   *
   * Rendered here rather than at the call site so the sentence exists once. A
   * second surface that needs it gets the same words instead of its own.
   */
  notes: string[];
};

/**
 * The one decision: given the home and the directory a process happens to be
 * running in, where may this turn write?
 *
 * `requested` is honoured whenever it is a real directory that is not the
 * installation — an owner who `cd`s into a project and runs `muffin` chose that
 * directory, and this function does not second-guess them. It is replaced by
 * `muffinWorkspace(home)` in exactly the case where nobody chose anything: the
 * cwd is the home, because a supervisor put it there.
 *
 * The directory is created when it is missing, because `resolveInScope`
 * (`agent/tools/fs.ts`) calls `realpathSync(scope.root)` on **every** fs tool
 * call: a workspace that does not exist is not an empty workspace, it is an
 * ENOENT on the first `fs_list`.
 *
 * @throws ConfigError when the workspace cannot be created at all. Permanent by
 * construction — a file sitting where the directory must go, or a parent nobody
 * may write, does not repair itself — and `cli/gateway.ts` maps a `ConfigError`
 * to `EXIT_PERMANENT`, which the unit's `RestartPreventExitStatus` names. Left
 * as a raw `EEXIST`/`EACCES` from Node it would still fail closed, but under
 * `Restart=always` it would fail closed once every `RestartSec` forever, with a
 * five-word errno for a reason.
 */
export function resolveWorkspace(home: string, requested: string): WorkspaceChoice {
  const inside = isSameOrNestedPath(requested, home);
  const workspace = inside ? muffinWorkspace(home) : requested;
  const notes: string[] = [];

  // Unconditional and idempotent. `process.cwd()` always exists, so this is a
  // no-op for the interactive surfaces; the gateway names a workspace that has
  // never been used yet, and on that path the directory has to be here before
  // the first `fs_list` calls `realpathSync` on it.
  try {
    mkdirSync(workspace, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '?';
    throw new ConfigError(
      `non riesco a creare la cartella di lavoro ${workspace} (${code})`,
      code === 'EEXIST' || code === 'ENOTDIR'
        ? `c'è già un file con quel nome: spostalo o rinominalo, oppure indica un'altra cartella con ${WORKSPACE_ENV}`
        : `controlla i permessi della cartella che la contiene, oppure indica un'altra cartella con ${WORKSPACE_ENV}`,
    );
  }

  if (inside) {
    notes.push(
      `! la cartella di lavoro era l'installazione stessa (${requested}): lavoro in ${workspace}. ` +
        `Dentro ~/.muffin ci sono memoria, sessioni e il sigillo — non è uno spazio di lavoro, ` +
        `e nessun turno ci scrive.`,
    );
  }

  // The result, checked against the same question the input was checked
  // against. `muffinWorkspace` already refuses a `MUFFIN_WORKSPACE` that names
  // the home, and it computes a default that is a sibling by construction —
  // but neither fact survives the directory itself being a **symlink** into
  // the home, which `mkdirSync` follows without complaint.
  //
  // Legibility, not security: the belt (`mandatoryGuards` denies the home)
  // still refuses every write, so nothing gets through. What the owner would
  // otherwise get is an agent whose hands do not work and no sentence anywhere
  // saying why — which is the same defect as a silent mechanism, wearing the
  // other face.
  if (isSameOrNestedPath(workspace, home)) {
    notes.push(
      `! la cartella di lavoro ${workspace} porta dentro l'installazione (${home}), probabilmente per un collegamento: ` +
        `nessun turno può scriverci, e finché resta così Muffin non ha le mani. ` +
        `Rimuovi il collegamento, oppure indica un'altra cartella con ${WORKSPACE_ENV}.`,
    );
  }

  return { workspace, relocatedFrom: inside ? requested : null, notes };
}
