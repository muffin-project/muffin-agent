import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKSPACE_ENV, isSameOrNestedPath, muffinWorkspace, resolveWorkspace } from './workspace.js';

/**
 * The braces of the home-is-not-a-workspace claim, at the level where the
 * decision is made. `core/sandbox/home-not-workspace.test.ts` proves the
 * containment with a real command; this file proves that production never asks
 * the containment the dangerous question in the first place.
 */

afterEach(() => vi.unstubAllEnvs());

function scratch(): { base: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), 'muffin-ws-'));
  const home = join(base, '.muffin');
  mkdirSync(home, { recursive: true });
  return { base, home };
}

describe('the workspace is a sibling of the home, never a child of it', () => {
  it('derives a visible sibling from the home, so MUFFIN_HOME stays the one knob', () => {
    expect(muffinWorkspace('/var/lib/muffin')).toBe('/var/lib/muffin-workspace');
    expect(muffinWorkspace('/home/mario/.muffin')).toBe('/home/mario/muffin-workspace');
    // ADR-0030's `--local` rehearsal home gets its own, for the same reason.
    expect(muffinWorkspace('/home/mario/.muffin-local')).toBe('/home/mario/muffin-local-workspace');
  });

  it('is never inside the home — the property the whole slice rests on', () => {
    for (const home of ['/var/lib/muffin', '/home/mario/.muffin', '/home/mario/.muffin-local']) {
      expect(isSameOrNestedPath(muffinWorkspace(home), home)).toBe(false);
    }
  });
});

describe(`${WORKSPACE_ENV} moves it, but cannot move it into the installation`, () => {
  it('honours a workspace outside the home', () => {
    const s = scratch();
    const altrove = join(s.base, 'progetti');
    vi.stubEnv(WORKSPACE_ENV, altrove);
    expect(muffinWorkspace(s.home)).toBe(altrove);
  });

  it('ignores one that names the home, or anything under it', () => {
    const s = scratch();
    for (const cattivo of [s.home, join(s.home, 'workspace'), join(s.home, 'vault', 'deep')]) {
      vi.stubEnv(WORKSPACE_ENV, cattivo);
      expect(muffinWorkspace(s.home), `${cattivo} was accepted as a workspace`).toBe(
        join(dirname(s.home), 'muffin-workspace'),
      );
    }
  });

  it('ignores a symlink pointing into the home, because a string compare would not', () => {
    const s = scratch();
    const link = join(s.base, 'sembra-fuori');
    symlinkSync(s.home, link);
    vi.stubEnv(WORKSPACE_ENV, link);
    expect(muffinWorkspace(s.home)).toBe(join(dirname(s.home), 'muffin-workspace'));
  });
});

describe('resolveWorkspace: the cwd the owner chose is kept, the one a supervisor imposed is not', () => {
  it('keeps a working directory that is not the installation', () => {
    const s = scratch();
    const progetto = join(s.base, 'progetto');
    mkdirSync(progetto);
    expect(resolveWorkspace(s.home, progetto)).toEqual({ workspace: progetto, relocatedFrom: null });
  });

  it('relocates when the cwd IS the home — the supervised gateway, measured on the owner’s machine', () => {
    const s = scratch();
    const scelta = resolveWorkspace(s.home, s.home);
    expect(scelta.workspace).toBe(join(dirname(s.home), 'muffin-workspace'));
    expect(scelta.relocatedFrom).toBe(s.home);
    expect(isSameOrNestedPath(scelta.workspace, s.home)).toBe(false);
  });

  it('relocates from anywhere inside the home too, not only from its root', () => {
    const s = scratch();
    const dentro = join(s.home, 'vault');
    mkdirSync(dentro, { recursive: true });
    expect(resolveWorkspace(s.home, dentro).relocatedFrom).toBe(dentro);
  });

  it('creates the workspace, because fs_list realpaths the root on every call', () => {
    const s = scratch();
    const { workspace } = resolveWorkspace(s.home, s.home);
    expect(existsSync(workspace)).toBe(true);
  });

  it('says so when it relocates — a mechanism nobody is told about is the failure this repo is named for', () => {
    const s = scratch();
    expect(resolveWorkspace(s.home, s.home).relocatedFrom).not.toBeNull();
    const progetto = join(s.base, 'altro');
    mkdirSync(progetto);
    expect(resolveWorkspace(s.home, progetto).relocatedFrom).toBeNull();
  });
});
