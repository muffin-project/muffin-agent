import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CapabilityDecl, TrustTier } from '../../core/policy/types.js';
import type { ToolSpec } from '../providers/types.js';
import type { RegisteredTool } from '../loop.js';

/**
 * The three filesystem primitives of M1.
 *
 * They ship without a sandbox on purpose, and the reason is worth stating: in
 * M1 the only principal is the owner at a terminal, and no untrusted input has
 * entered the system yet — no connectors, no memory, no MCP. The moment M3
 * adds shell, processes and network, it adds the sandbox in the same module.
 * That ordering is the safety argument, not an accident of scheduling.
 *
 * Containment here is the write scope plus the root-of-trust deny paths, both
 * enforced before the call reaches the disk.
 */

export type FsScope = {
  /** Reads and writes are confined to this subtree. */
  root: string;
  /** Never writable, whatever the scope says. Comes from the root of trust. */
  denyWrite: readonly string[];
  /**
   * Never readable either. Deliberately narrower than `denyWrite`: the agent
   * already has its own identity in its system prompt, so denying it a read of
   * `identity.md` buys nothing. The key does not work that way — a tool that
   * can read it has already won every later argument about exfiltration, and
   * the default working directory is `$HOME`, which contains `~/.muffin`.
   */
  denyRead?: readonly string[];
};

/**
 * The tier of anything read off the local disk. ADR-0044.
 *
 * **2, because the filesystem has no provenance.** The scale is defined on who
 * spoke (0 owner · 1 confirmed contacts · 2 group and strangers · 3 web and
 * external tools), and `~/appunti.md` written by the owner is indistinguishable
 * from `~/Downloads/fattura.pdf` that arrived from a stranger: same `stat`, same
 * bytes, no field anywhere that separates them. Under that uncertainty the only
 * honest reading is the fail-closed one — *somebody who is not the owner may
 * have written this* — and that is what 2 means.
 *
 * **Not 1**, which is where the cost would have been lower and the guarantee
 * empty: at taint 1 an off-allowlist host still comes back as an `ask`
 * (`core/policy/decide.ts`), so a poisoned file could still nominate the
 * destination and wait for a tired yes. The whole chain closes at 2 and nowhere
 * below it. **Not 3**, which would be a lie with a bill attached: a note the
 * owner typed is not a web page, 3 is the top of the scale and spending it here
 * leaves nothing to say about something genuinely worse — and it would put the
 * owner's own notes in the same bucket as an untrusted MCP server.
 *
 * **Not per-path** (`~/.muffin` clean, everywhere else dirty), which was the
 * tempting one: it is a rule you evade by *moving a file*, and it buys less
 * than it looks like. `skill.read` already gives the readable parts of the
 * muffin home their own door and their own tier; `denyRead` already blocks
 * the parts that must not be read (`secrets/`, the working directory's
 * `.env`) by name. **`rot/` and `config.json` are deliberately readable at
 * the same tier as anything else on disk — only `denyWrite` names them** —
 * because a read-only agent inspecting its own policy or config is not the
 * threat `denyRead` exists for (2026-08-16 audit, P29 LOW: this paragraph
 * used to say the opposite). A per-path rule would draw a line `denyRead`
 * already draws, one level up, and it would still launder a poisoned file the
 * moment anything wrote it inside the home.
 *
 * One constant, imported by `agent/tools/shell.ts` too, because a command's
 * stdout is the same disk read through a different door — and two literals that
 * agree today are how the two deny-lists in `core/rot/guards.ts` got written.
 */
export const DISK_TIER: TrustTier = 2;

export const fsCapabilities: CapabilityDecl[] = [
  /**
   * `fs.read` states no `maxTaint`, so its ceiling is `defaultMaxTaint.low` —
   * 3 in the shipped `rot/policy.json`. That was examined on its own merits
   * (ADR-0039) and left alone, which is a decision and not an omission.
   *
   * **Why not 1.** `web_search` and `sys.http` both carry 3 with a recorded
   * reason: the first result taints the turn to 3, so a lower ceiling would
   * permit exactly one fetch per turn and deep research would be impossible.
   * Reading a file is the same shape — *"leggi questa pagina e confrontala con
   * i miei appunti"* is a normal owner turn, and at a ceiling of 1 the second
   * half is refused. So the ceiling stays high and the **read itself pays**:
   * every read taints the turn to `DISK_TIER`, which is what a turn that has
   * swallowed unprovenanced bytes actually is.
   *
   * **The half of this argument that was fiction until ADR-0044, named so it
   * does not become fiction again.** The sentence used to be *"the read alone
   * is not the leak: the bytes still have to leave, and the egress leg is
   * separately gated — off-allowlist above taint 1 is DENY, never ask"*. True
   * of `core/policy/decide.ts`, and unreachable from here: that gate reads the
   * **turn's taint**, and `fs_read` returned no `tier`, so a turn that had just
   * read an injected file was still at taint 0 and the off-allowlist host came
   * back as an `ask` the owner could approve. The file's own security argument
   * rested on a property the file did not produce. It produces it now, and
   * `agent/read-then-egress.test.ts` is the thing that fails if it stops.
   *
   * **The precondition that makes it true, stated so it can be falsified.** The
   * ceiling is defensible because no *secret* is reachable inside `root`:
   * `denyRead` covers both secret stores and the working-directory `.env`
   * (`agent/runtime.ts`) — not `rot/` or `config.json`, which stay readable on
   * purpose (see the per-path rejection above). If a secret ever becomes
   * readable there again, this argument stops holding and the number has to
   * be revisited — that, and not the taint value, is the thing to watch.
   *
   * Deliberately *not* pinned to 3 in the declaration: pinning would override an
   * owner who lowered `defaultMaxTaint.low` in `rot/policy.json`, and the file's
   * one legitimate direction is tightening (`core/policy/matrix.ts`).
   */
  {
    id: 'fs.read',
    risk: 'low',
    reversible: 'yes',
    rerunnable: true,
    resourceKind: 'path',
    policyArgs: ['path'],
    hostOnly: true,
  },
  {
    id: 'fs.list',
    risk: 'low',
    reversible: 'yes',
    rerunnable: true,
    resourceKind: 'path',
    policyArgs: ['path'],
    hostOnly: true,
  },
  {
    id: 'fs.write',
    risk: 'medium',
    reversible: 'undoable',
    // The row that proves the two axes are independent: this write is NOT
    // freely reversible (it needs an undo), and it IS re-runnable — the tool
    // replaces a whole file, so the same bytes written twice give the same
    // file. A resume that consulted `reversible` would refuse this one, which
    // is the wrong answer in the safe direction and the reason for a second
    // field rather than a reinterpretation of the first.
    rerunnable: true,
    resourceKind: 'path',
    policyArgs: ['path'],
    hostOnly: true,
  },
];

export const fsToolSpecs: ToolSpec[] = [
  {
    name: 'fs_read',
    description:
      'Read a UTF-8 text file. Paths are relative to the working directory. Returns the file content.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to the working directory' } },
      required: ['path'],
    },
  },
  {
    name: 'fs_list',
    description: 'List the entries of a directory, marking which are directories.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory, relative to the working directory' } },
      required: ['path'],
    },
  },
  {
    name: 'fs_write',
    description:
      'Write a UTF-8 text file, creating parent directories as needed. Overwrites an existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the working directory' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
];

export class PathDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathDenied';
  }
}

/**
 * `path.resolve` normalises `..` but does not follow symlinks — a link inside
 * the scope pointing outside would sail straight through a containment check
 * built on it. So we resolve the deepest ancestor that actually exists and
 * re-attach the rest, which also works for a file about to be created.
 *
 * `lstat`, not `existsSync`, drives the walk: the latter follows a link, so a
 * symlink whose target does not exist yet reads as "missing" and the loop
 * would walk straight past it.
 *
 * `terminal` governs only the *exact* path requested — the first thing this
 * function looks at, before any walking up:
 *  - `'follow'` (reads and lists): a terminal symlink is resolved through to
 *    its real target, exactly as `readFileSync`/`readdirSync` resolve it. A
 *    dangling symlink (target does not exist) is refused explicitly rather
 *    than left to surface as a raw `ENOENT` two frames up.
 *  - `'reject'` (writes): a terminal symlink throws outright, wherever it
 *    points — a write has no legitimate reason to go through a link, and
 *    refusing it means there is nothing to resolve correctly or not.
 *
 * **2026-08-16 audit, P29 (CRITICAL) and P28 (MEDIUM).** The previous version
 * of this function special-cased *any* symlink it found — the exact path
 * requested, or an ancestor reached by walking up — to never fully resolve:
 * `realpathSync(dirname(current)) + sep + basename(current)`, i.e. the link's
 * *own* location with its parent canonicalised, never the target. That was
 * written for the write-terminal case (P28's precursor: a write must not
 * silently follow a link), but it ran unconditionally, for reads too (P29)
 * and for ancestors too (P28): `resolveInScope`'s containment and `denyRead`
 * checks ran on a path that was always inside `root` by construction — the
 * link's own — while `readFileSync`/`readdirSync`/`writeFileSync` followed it
 * to wherever it actually pointed. Every ancestor found by walking up is now
 * *unconditionally* resolved with plain `realpathSync`, which follows the
 * whole chain above it, symlinked or not — there is exactly one place left
 * that treats a symlink specially, and it is the terminal component, on
 * purpose, governed by `terminal`.
 */
function realpathDeepest(target: string, terminal: 'follow' | 'reject'): string {
  const missing: string[] = [];
  let current = target;
  let isTerminal = true;
  for (;;) {
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (st !== undefined) {
      if (isTerminal && st.isSymbolicLink() && terminal === 'reject') {
        throw new PathDenied(`won't write through a symlink: ${target}`);
      }
      try {
        return join(realpathSync(current), ...missing.reverse());
      } catch {
        // Only reachable when `current` is a symlink whose target does not
        // exist: `lstat` above succeeded on the link itself, and `realpath`
        // then failed trying to follow it.
        throw new PathDenied(`won't follow a dangling symlink: ${target}`);
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      // Walked all the way to the filesystem root without ever finding an
      // entry that exists. Failing closed here — rather than the old
      // `return target` — matters because a caller receiving `target` back
      // unresolved would have no way to tell "this is already real" from
      // "nothing to resolve was found"; audit note, out of scope of P29/P28
      // but named there.
      throw new PathDenied(`can't resolve within the filesystem: ${target}`);
    }
    missing.push(current.slice(parent.length + 1));
    current = parent;
    isTerminal = false;
  }
}

/**
 * Case-insensitive on darwin, where `ROT/` and `rot/` are the same directory
 * and a string comparison says otherwise. Comparing lowercased is coarse — it
 * over-matches on a case-sensitive volume — but over-denying a write is the
 * side to be wrong on.
 */
const CASE_BLIND = process.platform === 'darwin' || process.platform === 'win32';
const norm = (p: string): string => (CASE_BLIND ? p.toLowerCase() : p);

/** Is `target` (already real) inside `base` (already real)? */
function containmentCheck(base: string, target: string): boolean {
  const rel = relative(base, target);
  return !(rel.startsWith('..') || (rel !== '' && isAbsolute(rel)));
}

/**
 * Is `target` (already real) on one of `scope`'s deny-lists?
 *
 * Shared by `resolveInScope` (the path a tool is about to touch) and `fsList`
 * (each entry it is about to *describe*) — a directory listing must not show
 * more about a denied path than a read of that same path would allow.
 */
function isDenied(scope: FsScope, target: string, forWrite: boolean): boolean {
  const denied = forWrite ? [...scope.denyWrite, ...(scope.denyRead ?? [])] : (scope.denyRead ?? []);
  const t = norm(target);
  return denied.some((path) => {
    const deniedAbs = norm(realpathDeepest(resolve(path), 'follow'));
    return t === deniedAbs || t.startsWith(deniedAbs + sep);
  });
}

/**
 * Resolves before deciding. `../`, symlinks, hard links and the case of a
 * filename are the four ways a path that looks contained stops being
 * contained, so the check happens on the resolved real path — the one the OS
 * will actually touch — never on the string the model wrote.
 *
 * `forWrite` picks `realpathDeepest`'s terminal policy: `'reject'` for a
 * write (a link is never written through, wherever it points), `'follow'`
 * for a read or a list (the OS follows it, so the check has to run on where
 * it leads — see that function's docstring for the audit finding this closes).
 */
export function resolveInScope(scope: FsScope, requested: string, forWrite: boolean): string {
  const base = realpathSync(resolve(scope.root));
  const requestedFull = resolve(isAbsolute(requested) ? requested : join(base, requested));
  const target = realpathDeepest(requestedFull, forWrite ? 'reject' : 'follow');

  if (!containmentCheck(base, target)) {
    throw new PathDenied(`outside the working directory: ${requested}`);
  }

  // Writes check the full deny-list; reads check the narrower one — see
  // `FsScope.denyRead`'s own comment for why the two differ. Both sides
  // compare against `target`, which is now always the resolved real path
  // (never the unresolved location of a symlink), case-blind where the
  // filesystem is.
  if (isDenied(scope, target, forWrite)) {
    throw new PathDenied(`${forWrite ? 'write' : 'read'} denied by the root of trust: ${requested}`);
  }

  // A hard link has its own realpath, so no amount of resolving reveals that it
  // is a second name for a file inside the deny-list. Refusing any
  // multiply-linked file is blunt and cheap: legitimate files in a working
  // directory have one name. It applies to reads as much as to writes — the
  // judge of PR #52 read the provider key verbatim through a hard link inside
  // root while the write-only guard below stood; the deny-list is a read
  // guard first (`denyRead` covers the secret stores and `.env`), so the same
  // one line must stand on the read path. Cost: an owner's legitimately
  // hard-linked file inside root is unreadable through fs_read; named as a
  // limit, not hidden.
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isFile() && existing.nlink > 1) {
    throw new PathDenied(
      `won't ${forWrite ? 'write to' : 'read'} a hard link (${existing.nlink} names): ${requested}`,
    );
  }

  return target;
}

export function fsRead(scope: FsScope, path: string): string {
  const full = resolveInScope(scope, path, false);
  // Opened with `O_NOFOLLOW` rather than checked-then-read on a path string:
  // `resolveInScope` above and this open are still two syscalls (a TOCTOU
  // window the PR notes as a known limit), but the one race that mattered —
  // something replacing the resolved leaf with a symlink in the gap between
  // the check and the read — now fails the open (`ELOOP`) instead of
  // silently following it. `full` is already fully realpath'd, so a
  // legitimate call never has a symlink sitting at this exact path to trip
  // over; verified against Node's own docs and a throwaway probe before
  // relying on it (`O_NOFOLLOW` is POSIX-wide, no macOS/Linux split).
  let fd: number;
  try {
    fd = openSync(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new PathDenied(`no such file: ${path}`);
    if (code === 'ELOOP') throw new PathDenied(`a symlink appeared at ${path} between the check and the read`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isDirectory()) throw new PathDenied(`${path} is a directory — use fs_list`);
    // A model that asks for a 2 GB file gets a refusal rather than the process
    // getting an out-of-memory kill and the turn dying without a trace.
    if (stat.size > MAX_READ_BYTES) {
      throw new PathDenied(`${path} is ${(stat.size / 1e6).toFixed(1)}MB, over the ${MAX_READ_BYTES / 1e6}MB read limit`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** Large enough for any source file or note, small enough not to blow the context. */
const MAX_READ_BYTES = 2 * 1024 * 1024;

export function fsList(scope: FsScope, path: string): string {
  const full = resolveInScope(scope, path, false);
  if (!existsSync(full)) throw new PathDenied(`no such directory: ${path}`);
  if (!statSync(full).isDirectory()) throw new PathDenied(`${path} is a file — use fs_read`);
  // For the same reason `resolveInScope` needs it: describing an entry that
  // is itself a symlink means resolving it and checking the result the same
  // way a read of that entry would be checked.
  const base = realpathSync(resolve(scope.root));
  return readdirSync(full)
    .sort()
    .map((entry) => {
      // `statSync` follows links, so one broken symlink in a directory used to
      // throw ENOENT and take the whole listing with it — a real state in any
      // dotfile repo or `node_modules/.bin`. `throwIfNoEntry: false` covers
      // that ENOENT case, but only that one: a directory that is readable but
      // not traversable (`chmod 0o400`, no +x) lets `readdirSync` above
      // succeed while `lstatSync` on an entry it just returned throws EACCES
      // instead of coming back `undefined` — and the `statSync` a few lines
      // down, which follows a symlink's target, can throw the same way for the
      // same reason. Both calls sit behind one try/catch so neither can throw
      // past this function with the entry's name (bytes `readdirSync` read off
      // the disk, not the model-typed `path`) riding in Node's own error
      // message: any failure in here answers exactly like the ENOENT branch
      // already does, which is what makes `throwTier: 0` below true rather
      // than assumed.
      try {
        const entryPath = join(full, entry);
        const stat = lstatSync(entryPath, { throwIfNoEntry: false });
        if (stat === undefined) return `${entry} (illeggibile)`;
        if (stat.isSymbolicLink()) {
          // 2026-08-16 audit, P29 OUT_OF_SCOPE note: a listing used to show a
          // symlink's target type (file or directory) with no check at all —
          // enumerating what a denied or out-of-scope link points at is its
          // own small leak, even though `fs_read` would already have refused
          // it. Resolved and checked exactly as `resolveInScope` checks a
          // read, so the listing never says more than a read would allow.
          let resolved: string;
          try {
            resolved = realpathSync(entryPath);
          } catch {
            return `${entry} (link rotto)`;
          }
          if (!containmentCheck(base, resolved) || isDenied(scope, resolved, false)) {
            return `${entry} → (fuori dallo scope)`;
          }
          const target = statSync(entryPath, { throwIfNoEntry: false });
          if (target === undefined) return `${entry} (link rotto)`;
          return target.isDirectory() ? `${entry}/ →` : `${entry} →`;
        }
        return stat.isDirectory() ? `${entry}/` : entry;
      } catch {
        return `${entry} (illeggibile)`;
      }
    })
    .join('\n');
}

export function fsWrite(scope: FsScope, path: string, content: string): string {
  const full = resolveInScope(scope, path, true);
  mkdirSync(dirname(full), { recursive: true });
  // Same `O_NOFOLLOW` hardening as `fsRead`, and it closes the write half of
  // the TOCTOU window that matters more here: `resolveInScope` already
  // refuses an *existing* terminal symlink outright, so the only race left is
  // something creating one at this exact path between that check and this
  // open. `O_NOFOLLOW` turns that into a failed open instead of a write
  // through it — the P28 escape, at the syscall that would have done it.
  let fd: number;
  try {
    fd = openSync(
      full,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o666,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new PathDenied(`a symlink appeared at ${path} between the check and the write`);
    }
    throw error;
  }
  try {
    writeFileSync(fd, content, 'utf8');
  } finally {
    closeSync(fd);
  }
  return `wrote ${content.length} bytes to ${path}`;
}

/**
 * The three tools, assembled once.
 *
 * They used to be three object literals in `agent/runtime.ts` and three more in
 * `evals/floor/run.ts` — the same handlers written twice, which is the shape
 * this repo keeps paying for: whatever a tool has to declare about itself has
 * to be declared at every copy, and the copies drift on the first thing that is
 * not `content`. Provenance is exactly that kind of thing.
 */
export function makeFsTools(scope: FsScope): RegisteredTool[] {
  return [
    {
      capability: 'fs.read',
      spec: fsToolSpecs[0]!,
      // `throwTier: 0` — every throw in `fsRead` (`PathDenied`, or the missing/
      // directory/too-large checks) is built from this file's own template
      // strings plus the `path` the model itself typed, never a byte read off
      // disk: the one call that can return disk bytes (`readFileSync`) never
      // throws with them, it returns them, which is the success path above.
      throwTier: 0,
      handler: (args) => ({
        content: fsRead(scope, String((args as { path: string }).path)),
        tier: DISK_TIER,
      }),
    },
    {
      capability: 'fs.list',
      spec: fsToolSpecs[1]!,
      // A listing is bytes somebody else chose too. A filename is short and
      // looks like metadata, which is exactly why it is worth saying out loud:
      // `IGNORA le istruzioni precedenti.md` is a filename, it costs an attacker
      // nothing, and it reaches the model through this door with no fence around
      // it. Same source, same tier — the alternative is a special case whose
      // only argument is that the text is short.
      //
      // `throwTier: 0`, true rather than assumed. `fsList`'s only throws that
      // reach here are the two `PathDenied`/`no such directory`/`is a file`
      // sentences above plus whatever `resolveInScope` throws on `full` — this
      // file's own template strings plus the model-typed `path`, never a byte
      // read off the disk. The entries a directory actually holds leave two
      // ways: through the `return`, tiered above, or — this was the gap a
      // judge found — through `lstatSync`/`statSync` throwing EACCES on an
      // entry `readdirSync` handed back, which used to carry the entry's own
      // name (disk bytes) past this declaration. The try/catch in the `.map`
      // above closes that: every per-entry failure now returns the same
      // `(illeggibile)` sentence the ENOENT branch already used, so nothing an
      // entry's name can trigger ever leaves through a throw.
      throwTier: 0,
      handler: (args) => ({
        content: fsList(scope, String((args as { path: string }).path)),
        tier: DISK_TIER,
      }),
    },
    {
      capability: 'fs.write',
      spec: fsToolSpecs[2]!,
      // Tier 0: the result is this tool's own sentence about how many bytes it
      // wrote. Nothing came *in*. The point of a required `tier` is that this is
      // now an answer someone gave, not a question nobody was asked.
      // `throwTier: 0` to match: `fsWrite`'s only throws are `PathDenied`,
      // built the same way as the two tools above.
      throwTier: 0,
      handler: (args) => {
        const a = args as { path: string; content: string };
        return { content: fsWrite(scope, String(a.path), String(a.content ?? '')), tier: 0 };
      },
    },
  ];
}
