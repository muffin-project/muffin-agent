import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  it.skipIf(asRoot)('accepts it when the root of trust is genuinely unwritable', () => {
    const dir = home();
    readOnly(dir);
    try {
      expect(hardeningHolds(dir)).toEqual({ holds: true });
    } finally {
      chmodSync(join(dir, 'rot'), 0o755);
      chmodSync(join(dir, 'rot', 'evals'), 0o755);
    }
  });

  it.skipIf(asRoot)('one writable file is enough to break it — including the manifest', () => {
    // The manifest is guarded on purpose. Prevention that covered the sealed
    // files and left the hashes writable would let a process rewrite the
    // manifest instead of the contents: the same attack with one more step.
    const dir = home();
    readOnly(dir);
    try {
      chmodSync(join(dir, 'rot', 'manifest.json'), 0o644);
      const check = hardeningHolds(dir);
      expect(check.holds).toBe(false);
      if (!check.holds) expect(check.why).toContain('manifest.json');
    } finally {
      chmodSync(join(dir, 'rot'), 0o755);
      chmodSync(join(dir, 'rot', 'evals'), 0o755);
    }
  });
});
