import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
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
 * tempting one: it is a rule you evade by *moving a file*, it buys almost
 * nothing (the readable parts of the muffin home have their own door in
 * `skill.read`, which declares its own tier, and the rest is `denyRead`), and it
 * would launder a poisoned file the moment anything wrote it inside the home.
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
   * ceiling is defensible because no secret is reachable inside `root`:
   * `denyRead` covers both secret stores and the working-directory `.env`
   * (`agent/runtime.ts`). If a secret ever becomes readable there again, this
   * argument stops holding and the number has to be revisited — that, and not
   * the taint value, is the thing to watch.
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
 */
function realpathDeepest(target: string): string {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    // `lstat`, not `existsSync`: the latter follows the link, so a symlink whose
    // target does not exist yet reads as "missing", the loop walks past it, and
    // the check ends up judging the link's own path — while the write follows
    // the link and lands wherever it points. The first write is the one that
    // escapes; from the second on the file exists and the check works, which is
    // exactly the shape of a bug that survives testing.
    if (lstatSync(current, { throwIfNoEntry: false }) !== undefined) {
      const resolved = isSymlink(current) ? realpathSync(dirname(current)) + sep + basename(current) : realpathSync(current);
      return join(resolved, ...missing.reverse());
    }
    const parent = dirname(current);
    if (parent === current) return target; // reached the root without finding anything
    missing.push(current.slice(parent.length + 1));
    current = parent;
  }
}

function isSymlink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

/**
 * Case-insensitive on darwin, where `ROT/` and `rot/` are the same directory
 * and a string comparison says otherwise. Comparing lowercased is coarse — it
 * over-matches on a case-sensitive volume — but over-denying a write is the
 * side to be wrong on.
 */
const CASE_BLIND = process.platform === 'darwin' || process.platform === 'win32';
const norm = (p: string): string => (CASE_BLIND ? p.toLowerCase() : p);

/**
 * Resolves before deciding. `../`, symlinks, hard links and the case of a
 * filename are the four ways a path that looks contained stops being contained,
 * so the check happens on the resolved real path, never on the string the model
 * wrote.
 */
export function resolveInScope(scope: FsScope, requested: string, forWrite: boolean): string {
  const base = realpathSync(resolve(scope.root));
  const target = realpathDeepest(resolve(isAbsolute(requested) ? requested : join(base, requested)));

  const rel = relative(base, target);
  if (rel.startsWith('..') || (rel !== '' && isAbsolute(rel))) {
    throw new PathDenied(`outside the working directory: ${requested}`);
  }

  // A symlink is never written through, wherever it points. Resolving it would
  // work for the paths we can enumerate; refusing it works for the ones we
  // cannot, and a tool has no legitimate need to write through a link.
  if (forWrite && isSymlink(target)) {
    throw new PathDenied(`won't write through a symlink: ${requested}`);
  }

  // Writes check the full deny-list; reads check the narrower one. Both sides go
  // through realpath or the comparison silently stops matching the moment either
  // contains a symlink — on macOS /var alone is enough — and both are compared
  // case-blind where the filesystem is.
  const denied = forWrite ? [...scope.denyWrite, ...(scope.denyRead ?? [])] : (scope.denyRead ?? []);
  const t = norm(target);
  for (const path of denied) {
    const deniedAbs = norm(realpathDeepest(resolve(path)));
    if (t === deniedAbs || t.startsWith(deniedAbs + sep)) {
      throw new PathDenied(`${forWrite ? 'write' : 'read'} denied by the root of trust: ${requested}`);
    }
  }

  // A hard link has its own realpath, so no amount of resolving reveals that it
  // is a second name for a file inside the deny-list. Refusing to write to any
  // multiply-linked file is blunt and cheap: legitimate files in a working
  // directory have one name.
  if (forWrite) {
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing?.isFile() && existing.nlink > 1) {
      throw new PathDenied(`won't write to a hard link (${existing.nlink} names): ${requested}`);
    }
  }

  return target;
}

export function fsRead(scope: FsScope, path: string): string {
  const full = resolveInScope(scope, path, false);
  if (!existsSync(full)) throw new PathDenied(`no such file: ${path}`);
  const stat = statSync(full);
  if (stat.isDirectory()) throw new PathDenied(`${path} is a directory — use fs_list`);
  // A model that asks for a 2 GB file gets a refusal rather than the process
  // getting an out-of-memory kill and the turn dying without a trace.
  if (stat.size > MAX_READ_BYTES) {
    throw new PathDenied(`${path} is ${(stat.size / 1e6).toFixed(1)}MB, over the ${MAX_READ_BYTES / 1e6}MB read limit`);
  }
  return readFileSync(full, 'utf8');
}

/** Large enough for any source file or note, small enough not to blow the context. */
const MAX_READ_BYTES = 2 * 1024 * 1024;

export function fsList(scope: FsScope, path: string): string {
  const full = resolveInScope(scope, path, false);
  if (!existsSync(full)) throw new PathDenied(`no such directory: ${path}`);
  if (!statSync(full).isDirectory()) throw new PathDenied(`${path} is a file — use fs_read`);
  return readdirSync(full)
    .sort()
    .map((entry) => {
      // `statSync` follows links, so one broken symlink in a directory used to
      // throw ENOENT and take the whole listing with it — a real state in any
      // dotfile repo or `node_modules/.bin`.
      const stat = lstatSync(join(full, entry), { throwIfNoEntry: false });
      if (stat === undefined) return `${entry} (illeggibile)`;
      if (stat.isSymbolicLink()) {
        const target = statSync(join(full, entry), { throwIfNoEntry: false });
        if (target === undefined) return `${entry} (link rotto)`;
        return target.isDirectory() ? `${entry}/ →` : `${entry} →`;
      }
      return stat.isDirectory() ? `${entry}/` : entry;
    })
    .join('\n');
}

export function fsWrite(scope: FsScope, path: string, content: string): string {
  const full = resolveInScope(scope, path, true);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
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
      // `throwTier: 0` for the same reason as `fs_read`: `fsList`'s throws are
      // this file's own sentences (`no such directory`, `is a file`) plus the
      // model-typed `path`. The entries a directory actually holds only ever
      // leave through the `return`, tiered above.
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
