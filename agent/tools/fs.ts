import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
    if (existsSync(current)) return join(realpathSync(current), ...missing.reverse());
    const parent = dirname(current);
    if (parent === current) return target; // reached the root without finding anything
    missing.push(current.slice(parent.length + 1));
    current = parent;
  }
}

/**
 * Resolves before deciding. `../` and symlinks are the two ways a path that
 * looks contained stops being contained, so the check happens on the resolved
 * real path, never on the string the model wrote.
 */
export function resolveInScope(scope: FsScope, requested: string, forWrite: boolean): string {
  const base = realpathSync(resolve(scope.root));
  const target = realpathDeepest(resolve(isAbsolute(requested) ? requested : join(base, requested)));

  const rel = relative(base, target);
  if (rel.startsWith('..') || (rel !== '' && isAbsolute(rel))) {
    throw new PathDenied(`outside the working directory: ${requested}`);
  }

  if (forWrite) {
    for (const denied of scope.denyWrite) {
      // Both sides go through realpath or the comparison silently stops matching
      // the moment either contains a symlink — on macOS /var alone is enough.
      const deniedAbs = realpathDeepest(resolve(denied));
      if (target === deniedAbs || target.startsWith(deniedAbs + sep)) {
        throw new PathDenied(`write denied by the root of trust: ${requested}`);
      }
    }
  }
  return target;
}

export function fsRead(scope: FsScope, path: string): string {
  const full = resolveInScope(scope, path, false);
  if (!existsSync(full)) throw new PathDenied(`no such file: ${path}`);
  if (statSync(full).isDirectory()) throw new PathDenied(`${path} is a directory — use fs_list`);
  return readFileSync(full, 'utf8');
}

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
