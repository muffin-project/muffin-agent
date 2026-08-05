import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { ToolSpec } from '../providers/types.js';

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

export const fsCapabilities: CapabilityDecl[] = [
  {
    id: 'fs.read',
    risk: 'low',
    reversible: 'yes',
    resourceKind: 'path',
    policyArgs: ['path'],
    hostOnly: true,
  },
  {
    id: 'fs.list',
    risk: 'low',
    reversible: 'yes',
    resourceKind: 'path',
    policyArgs: ['path'],
    hostOnly: true,
  },
  {
    id: 'fs.write',
    risk: 'medium',
    reversible: 'undoable',
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
    .map((entry) => (statSync(join(full, entry)).isDirectory() ? `${entry}/` : entry))
    .join('\n');
}

export function fsWrite(scope: FsScope, path: string, content: string): string {
  const full = resolveInScope(scope, path, true);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return `wrote ${content.length} bytes to ${path}`;
}
