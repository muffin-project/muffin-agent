import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { paths } from '../config/config.js';

/**
 * Where "Muffin builds Muffin" happens — and, just as importantly, where it
 * does not.
 *
 * ADR-0015 draws one hard line: the dev capability works on a DEDICATED clone,
 * never the owner's working tree. That line is made structural here — every
 * workspace is a named directory under `~/.muffin/dev/`, and a workspace name
 * is validated so it cannot climb out. The tool layer above never accepts a
 * path from the model; it accepts a name and this module resolves it.
 */

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function devRoot(home: string): string {
  return paths(home).dev;
}

export type WorkspaceResolution =
  | { ok: true; path: string; exists: boolean }
  | { ok: false; reason: string };

export function resolveWorkspace(home: string, name: string): WorkspaceResolution {
  if (!NAME_RE.test(name)) {
    return { ok: false, reason: `nome workspace non valido: "${name}" (minuscole, cifre, - e _, max 64)` };
  }
  const root = devRoot(home);
  const path = resolve(root, name);
  // Belt and braces: even a name that slipped past the regex cannot land
  // outside the dev root.
  const rel = relative(root, path);
  if (rel === '' || rel === '..' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: `il workspace esce da ${root}` };
  }
  return { ok: true, path, exists: existsSync(join(path, '.git')) };
}

/**
 * A clone source is a local path or a remote URL. For a URL we hand back the
 * host so the executor can allowlist exactly it for the clone — a git clone is
 * read egress, and the forge is the only host it needs.
 */
export type CloneSource =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; url: string; host: string };

export function classifySource(source: string): CloneSource | { error: string } {
  if (/^https?:\/\//.test(source) || /^git@/.test(source) || source.startsWith('ssh://')) {
    try {
      // git@host:owner/repo → normalize to a URL just to read the host.
      const normalized = source.startsWith('git@')
        ? `ssh://${source.replace(':', '/')}`
        : source;
      const host = new URL(normalized).hostname;
      if (!host) return { error: `non riesco a leggere l'host da ${source}` };
      return { kind: 'remote', url: source, host };
    } catch {
      return { error: `URL di clone non valido: ${source}` };
    }
  }
  return { kind: 'local', path: resolve(source) };
}
