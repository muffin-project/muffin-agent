import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Root of Trust — data tier.
 *
 * The code tier (policy kernel, capability registry, this verifier) is
 * protected by the absence of a write path plus review on the repo; it needs no
 * file integrity check. What lives here are the *files* the agent must not be
 * able to change at runtime: the permission matrix, the egress allowlist,
 * budgets and quiet hours, identity, the reference eval suite, sandbox profiles.
 *
 * Two modes, and we say honestly which guarantee each one gives:
 *
 *   hardened     — the RoT is owned by another OS user; the runtime cannot write
 *                  it at all. Prevention. A mismatch is an incident: refuse boot.
 *   single-user  — same user, files read-only. Detection, not prevention: a
 *                  process running as that user can chmod its own files back.
 *                  A mismatch degrades to safe mode instead of bricking the
 *                  agent, because the likeliest cause is the owner editing
 *                  identity.md by hand.
 *
 * See docs/adr/0003 (and its revision).
 */

export type RotMode = 'hardened' | 'single-user';

export type RotManifest = {
  schemaVersion: 1;
  rotVersion: string;
  installedAt: string;
  files: { path: string; sha256: string }[];
};

export type VerifyOutcome =
  | { ok: true; mode: RotMode; fileCount: number }
  | {
      ok: false;
      mode: RotMode;
      /** 'refuse' in hardened, 'safe-mode' in single-user. */
      action: 'refuse' | 'safe-mode';
      reason: 'manifest_missing' | 'anchor_missing' | 'anchor_mismatch' | 'files_diverged';
      diverged: string[];
      remedy: string;
    };

const MANIFEST = 'manifest.json';
/** Lives outside the RoT directory: an anchor inside what it anchors is decoration. */
const ANCHOR = '.rot-anchor';

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Deterministic walk: the manifest must not depend on directory iteration order. */
export function listRotFiles(rotDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry !== MANIFEST) out.push(relative(rotDir, full).split(sep).join('/'));
    }
  };
  walk(rotDir);
  return out;
}

/** Whether this machine actually delivers what `hardened` claims, and if not, why not. */
export type HardeningCheck = { holds: true } | { holds: false; why: string };

/**
 * Is the `hardened` claim true of this process, right now?
 *
 * `config.rot.mode` was a **self-report**. `muffin init --hardened` wrote the
 * string and nothing else — no service user, no chown, no check — and
 * `agent/runtime.ts` turned that string into `hardened: true`, which
 * `core/policy/decide.ts` reads to turn a high-risk owner capability from *ask*
 * into a **silent allow**. So asking for the stronger mode delivered a strictly
 * weaker one, on any machine, with no feedback: the label bought the permission
 * that the protection was supposed to pay for. `muffin doctor` even recommended
 * it, and warned only in the mode that was actually safe.
 *
 * The property is not invented here — the docstring at the top of this file
 * already states it in one line: *"hardened — the RoT is owned by another OS
 * user; the runtime cannot write it at all. Prevention."* So that is what gets
 * tested, and `W_OK` is the exact question rather than a proxy for it. Reading
 * uid and mode bits and reasoning about them would re-derive, less accurately,
 * what the kernel will answer directly — and would get ACLs, mounts and
 * `root` all wrong. Running as root fails this check, correctly: root can write
 * anything, so no file is prevention against root.
 *
 * The manifest and the anchor are included deliberately. Prevention that
 * covered the sealed files but left the manifest writable would let a process
 * rewrite the hashes rather than the contents, which is the same attack with
 * one more step.
 */
export function hardeningHolds(homeDir: string): HardeningCheck {
  const rotDir = join(homeDir, 'rot');
  if (!existsSync(rotDir)) return { holds: false, why: `${rotDir} non esiste` };

  let entries: string[];
  try {
    entries = listRotFiles(rotDir);
  } catch (error) {
    return { holds: false, why: `non ho potuto elencare ${rotDir}: ${(error as Error).message}` };
  }

  const guarded = [
    rotDir,
    join(homeDir, ANCHOR),
    join(rotDir, MANIFEST),
    ...entries.map((f) => join(rotDir, ...f.split('/'))),
  ];

  for (const path of guarded) {
    if (!existsSync(path)) continue;
    try {
      accessSync(path, constants.W_OK);
    } catch {
      continue; // not writable by us: this one holds
    }
    return { holds: false, why: `questo processo può scrivere ${relative(homeDir, path) || path}` };
  }
  return { holds: true };
}

export function buildManifest(rotDir: string, rotVersion: string, installedAt: string): RotManifest {
  return {
    schemaVersion: 1,
    rotVersion,
    installedAt,
    files: listRotFiles(rotDir).map((path) => ({
      path,
      sha256: sha256(readFileSync(join(rotDir, path))),
    })),
  };
}

/**
 * Writes manifest + anchor. Called by `muffin init` and by `muffin rot reseal`
 * — the command that exists so an owner editing their own identity file is not
 * treated as an attacker. The RoT means "the agent loop cannot change this",
 * never "nobody can".
 */
export function seal(homeDir: string, rotVersion: string, now: Date): RotManifest {
  const rotDir = join(homeDir, 'rot');
  const manifest = buildManifest(rotDir, rotVersion, now.toISOString());
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(rotDir, MANIFEST), serialized, 'utf8');
  writeFileSync(join(homeDir, ANCHOR), `${sha256(serialized)}\n`, 'utf8');
  return manifest;
}

export function verify(homeDir: string, mode: RotMode): VerifyOutcome {
  const rotDir = join(homeDir, 'rot');
  const manifestPath = join(rotDir, MANIFEST);
  const anchorPath = join(homeDir, ANCHOR);
  const fail = (
    reason: Extract<VerifyOutcome, { ok: false }>['reason'],
    diverged: string[],
    remedy: string,
  ): VerifyOutcome => ({
    ok: false,
    mode,
    action: mode === 'hardened' ? 'refuse' : 'safe-mode',
    reason,
    diverged,
    remedy,
  });

  if (!existsSync(manifestPath)) {
    return fail('manifest_missing', [], 'run `muffin rot reseal` to rebuild it from the current files');
  }
  if (!existsSync(anchorPath)) {
    return fail('anchor_missing', [], 'run `muffin rot reseal`');
  }

  const serialized = readFileSync(manifestPath, 'utf8');
  const anchor = readFileSync(anchorPath, 'utf8').trim();
  if (sha256(serialized) !== anchor) {
    return fail(
      'anchor_mismatch',
      [MANIFEST],
      'the manifest changed without resealing — inspect it, then `muffin rot reseal` if the change was yours',
    );
  }

  const manifest = JSON.parse(serialized) as RotManifest;
  if (manifest.schemaVersion !== 1) {
    return fail('files_diverged', [MANIFEST], `unknown manifest schemaVersion ${manifest.schemaVersion}`);
  }

  const diverged: string[] = [];
  const declared = new Set(manifest.files.map((f) => f.path));
  for (const { path, sha256: expected } of manifest.files) {
    const full = join(rotDir, path);
    if (!existsSync(full) || sha256(readFileSync(full)) !== expected) diverged.push(path);
  }
  // A file added to the RoT without resealing is as much a divergence as an edit.
  for (const path of listRotFiles(rotDir)) if (!declared.has(path)) diverged.push(`${path} (untracked)`);

  if (diverged.length > 0) {
    return fail(
      'files_diverged',
      diverged,
      'inspect the listed files, then `muffin rot reseal` if the change was yours',
    );
  }

  return { ok: true, mode, fileCount: manifest.files.length };
}
