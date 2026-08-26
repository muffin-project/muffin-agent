import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hardeningHolds, seal, verify } from './verify.js';

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-rot-'));
  mkdirSync(join(dir, 'rot', 'evals'), { recursive: true });
  writeFileSync(join(dir, 'rot', 'policy.json'), '{"schemaVersion":1}\n');
  writeFileSync(join(dir, 'rot', 'identity.md'), '# chi sono\n');
  writeFileSync(join(dir, 'rot', 'evals', 'voice.json'), '{"cases":[]}\n');
  return dir;
}

const NOW = new Date('2026-08-04T12:00:00Z');

describe('root of trust integrity', () => {
  it('passes on a freshly sealed install', () => {
    const dir = home();
    seal(dir, '0.0.0', NOW);
    expect(verify(dir, 'single-user')).toMatchObject({ ok: true, fileCount: 3 });
  });

  it('spots an edited file', () => {
    const dir = home();
    seal(dir, '0.0.0', NOW);
    writeFileSync(join(dir, 'rot', 'identity.md'), '# sono qualcun altro\n');
    expect(verify(dir, 'single-user')).toMatchObject({
      ok: false,
      reason: 'files_diverged',
      diverged: ['identity.md'],
    });
  });

  it('spots a file smuggled into the root of trust', () => {
    const dir = home();
    seal(dir, '0.0.0', NOW);
    writeFileSync(join(dir, 'rot', 'extra.json'), '{}\n');
    const outcome = verify(dir, 'single-user');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.diverged).toContain('extra.json (untracked)');
  });

  it('spots a manifest rewritten to match tampered files', () => {
    // Rewriting the manifest is the obvious next move after editing a file.
    // The anchor lives outside the directory it anchors precisely for this.
    const dir = home();
    seal(dir, '0.0.0', NOW);
    writeFileSync(join(dir, 'rot', 'identity.md'), '# alterato\n');
    seal(dir, '0.0.0', NOW); // re-seals the manifest but we then restore the old anchor
    writeFileSync(join(dir, '.rot-anchor'), 'anchor-di-prima\n');
    expect(verify(dir, 'single-user')).toMatchObject({ ok: false, reason: 'anchor_mismatch' });
  });

  it('degrades instead of bricking when the owner edits by hand, but refuses in hardened mode', () => {
    const dir = home();
    seal(dir, '0.0.0', NOW);
    writeFileSync(join(dir, 'rot', 'identity.md'), '# ci ho messo mano io\n');
    expect(verify(dir, 'single-user')).toMatchObject({ action: 'safe-mode' });
    expect(verify(dir, 'hardened')).toMatchObject({ action: 'refuse' });
  });

  it('accepts the owner change once it is resealed', () => {
    const dir = home();
    seal(dir, '0.0.0', NOW);
    writeFileSync(join(dir, 'rot', 'identity.md'), '# ci ho messo mano io\n');
    seal(dir, '0.0.0', NOW);
    expect(verify(dir, 'single-user')).toMatchObject({ ok: true });
  });
});

describe('hardening is checked, not believed', () => {
  // Running as root every path is writable, so the "holds" case cannot exist —
  // which is itself the correct answer, and not something to assert around.
  const asRoot = process.getuid?.() === 0;

  const readOnly = (dir: string): void => {
    seal(dir, '0.0.0', NOW);
    chmodSync(join(dir, 'rot', 'evals', 'voice.json'), 0o444);
    chmodSync(join(dir, 'rot', 'policy.json'), 0o444);
    chmodSync(join(dir, 'rot', 'identity.md'), 0o444);
    chmodSync(join(dir, 'rot', 'manifest.json'), 0o444);
    chmodSync(join(dir, '.rot-anchor'), 0o444);
    chmodSync(join(dir, 'rot', 'evals'), 0o555);
    chmodSync(join(dir, 'rot'), 0o555);
  };

  /**
   * The only way to simulate "owned by another OS user" without root: keep
   * the real mode bits `chmodSync` just set (so W_OK still behaves exactly
   * like a real foreign-owned file would) and lie only about `uid`.
   */
  const asForeignOwner =
    (uid: number) =>
    (path: string): { uid: number; mode: number } => ({ uid, mode: statSync(path).mode });

  it('refuses the claim when this process can write the files it names', () => {
    // The defect this closes: `muffin init --hardened` wrote one string into
    // config.json — no service user, no chown, no check — and `agent/runtime.ts`
    // turned that string into `hardened: true`, which `core/policy/decide.ts`
    // reads to make a high-risk owner capability a **silent allow** instead of
    // an ask. Asking for the stronger mode bought a strictly weaker one, on any
    // machine, with no feedback anywhere. `muffin doctor` even recommended it,
    // and warned only in the mode that was honest.
    const dir = home();
    seal(dir, '0.0.0', NOW);
    const check = hardeningHolds(dir);
    expect(check.holds).toBe(false);
    // Names the file that gave it away, because "hardened is false" without a
    // reason is the kind of message that gets configured around.
    if (!check.holds) expect(check.why).toMatch(/rot/);
  });

  it.skipIf(asRoot)(
    'accepts it when the root of trust is truly owned by another OS user',
    () => {
      // "Genuinely unwritable" has to mean owned by someone else, not merely
      // made read-only right now — chmodSync can only produce a same-uid file
      // in a test, so the foreign owner is simulated (uid injected, real mode
      // bits from chmodSync untouched).
      const dir = home();
      readOnly(dir);
      try {
        expect(hardeningHolds(dir, asForeignOwner(999_999))).toEqual({ holds: true });
      } finally {
        chmodSync(join(dir, 'rot'), 0o755);
        chmodSync(join(dir, 'rot', 'evals'), 0o755);
      }
    },
  );

  it.skipIf(asRoot)(
    'refuses the claim when the files are merely read-only under this SAME uid (P36)',
    () => {
      // This used to be the exact setup the previous version of this file
      // called "genuinely unwritable" and accepted as `holds: true` — but a
      // same-uid file is one `chmod +w` away from writable at all times, no
      // privilege required, which is the audit's own reproduction: "un chmod
      // dello stesso utente soddisfa il probe... per tutta la vita del
      // processo". No uid injection here on purpose: these files really are
      // owned by this test process, same as `muffin` running single-uid on a
      // VPS with `chmod -w rot/*` instead of a genuinely separate service
      // user (ADR-0003 revision §4: the separate OS user is what makes
      // "hardened" prevention rather than detection).
      const dir = home();
      readOnly(dir);
      try {
        const check = hardeningHolds(dir);
        expect(check.holds).toBe(false);
        if (!check.holds) expect(check.why).toMatch(/proprietà di questo processo/);
      } finally {
        chmodSync(join(dir, 'rot'), 0o755);
        chmodSync(join(dir, 'rot', 'evals'), 0o755);
      }
    },
  );

  it.skipIf(asRoot)(
    'refuses the claim when a foreign-owned file still grants group or other write',
    () => {
      // Owner-only unwritable is not enough either: a write bit left open to
      // group or other is a grant this check has to see even when *this*
      // process's own W_OK probe happens to fail today (we are neither the
      // owner nor, in this fixture, the group) — group membership can change
      // for the life of a long-running process without a restart.
      const dir = home();
      readOnly(dir);
      chmodSync(join(dir, 'rot', 'identity.md'), 0o464); // owner r--, group rw-, other r--
      try {
        const check = hardeningHolds(dir, asForeignOwner(999_999));
        expect(check.holds).toBe(false);
        if (!check.holds) expect(check.why).toMatch(/group\/other/);
      } finally {
        chmodSync(join(dir, 'rot'), 0o755);
        chmodSync(join(dir, 'rot', 'evals'), 0o755);
      }
    },
  );

  it.skipIf(asRoot)(
    'falls back to the W_OK-only question, and says so, when the uid probe cannot run (Windows)',
    () => {
      // "se il probe non è disponibile (Windows), comportati come oggi e
      // dichiaralo": same-uid files that are merely mode-read-only still
      // pass, exactly like before this fix — but the result names the
      // narrower guarantee instead of claiming the full one silently.
      const dir = home();
      readOnly(dir);
      try {
        expect(hardeningHolds(dir, statSync, () => undefined)).toEqual({
          holds: true,
          caveat: expect.stringContaining('non disponibile'),
        });
      } finally {
        chmodSync(join(dir, 'rot'), 0o755);
        chmodSync(join(dir, 'rot', 'evals'), 0o755);
      }
    },
  );

  it.skipIf(asRoot)('one writable file is enough to break it — including the manifest', () => {
    // The manifest is guarded on purpose. Prevention that covered the sealed
    // files and left the hashes writable would let a process rewrite the
    // manifest instead of the contents: the same attack with one more step.
    // Foreign ownership throughout, so this isolates the manifest tweak —
    // without it, the same-uid check above would already refuse the claim on
    // the very first guarded path, for an unrelated reason.
    const dir = home();
    readOnly(dir);
    try {
      chmodSync(join(dir, 'rot', 'manifest.json'), 0o644);
      const check = hardeningHolds(dir, asForeignOwner(999_999));
      expect(check.holds).toBe(false);
      if (!check.holds) expect(check.why).toContain('manifest.json');
    } finally {
      chmodSync(join(dir, 'rot'), 0o755);
      chmodSync(join(dir, 'rot', 'evals'), 0o755);
    }
  });
});
