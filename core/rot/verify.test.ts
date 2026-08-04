import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seal, verify } from './verify.js';

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
