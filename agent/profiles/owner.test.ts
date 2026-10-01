import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../runtime.js';
import {
  CONSERVATIVE,
  loadEffectiveProfiles,
  ownerProfilesDir,
  selectSourcedProfile,
} from './profile.js';

/**
 * Owner profiles live outside the release tree (#764): `<home>/profiles/`,
 * read owner-first beside the shipped directory, surviving `muffin update`
 * and image replacements because no release step touches the home.
 */

const shipped = (name: string, match: string[]) => ({
  schemaVersion: 1 as const,
  name,
  match,
  maxToolsExposed: 20,
  maxToolCallsPerTurn: 50 as number | null,
  thinking: 'off' as const,
  sampling: 'deterministic' as const,
  recovery: ['nudge'] as ('nudge')[],
  notes: `${name} shipped fixture`,
});

const ownerLan = () => ({
  ...shipped('owner-lan', ['my-lan-model']),
  notes: 'owner fixture',
});

function layout(opts: { shippedNames?: [string, string[]][]; ownerFiles?: Record<string, unknown> }): {
  home: string;
  release: string;
} {
  const base = mkdtempSync(join(tmpdir(), 'muffin-owner-profiles-'));
  const release = join(base, 'release');
  const home = join(base, 'home');
  mkdirSync(release, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const [name, match] of opts.shippedNames ?? [['shipped-a', ['my-lan-model']]]) {
    writeFileSync(join(release, `${name}.json`), JSON.stringify(shipped(name, match)));
  }
  if (opts.ownerFiles !== undefined) {
    mkdirSync(ownerProfilesDir(home), { recursive: true });
    for (const [file, contents] of Object.entries(opts.ownerFiles)) {
      writeFileSync(
        join(ownerProfilesDir(home), file),
        typeof contents === 'string' ? contents : JSON.stringify(contents),
      );
    }
  }
  return { home, release };
}

const cleanup = (home: string) => rmSync(join(home, '..'), { recursive: true, force: true });

describe('owner profiles outside the release tree (#764)', () => {
  it('resolves an owner profile the release tree never contained', () => {
    // The failure this pins: `loadProfiles` knew a single directory beside
    // the module, so anything outside the release was invisible and the model
    // fell to the conservative floor.
    const { home, release } = layout({ ownerFiles: { 'owner-lan.json': ownerLan() } });
    try {
      const problems: string[] = [];
      const sourced = selectSourcedProfile(
        'my-lan-model',
        loadEffectiveProfiles(home, release, (line) => problems.push(line)),
      );
      expect(problems).toEqual([]);
      expect(sourced?.profile.name).toBe('owner-lan');
      expect(sourced?.origin).toBe('owner');
      expect(sourced?.file).toBe(join(ownerProfilesDir(home), 'owner-lan.json'));
    } finally {
      cleanup(home);
    }
  });

  it('owner wins over shipped, and the retired shipped file is named', () => {
    const { home, release } = layout({
      shippedNames: [['owner-lan', ['my-lan-model']]],
      ownerFiles: { 'owner-lan.json': ownerLan() },
    });
    try {
      const problems: string[] = [];
      const sourced = selectSourcedProfile(
        'my-lan-model',
        loadEffectiveProfiles(home, release, (line) => problems.push(line)),
      );
      expect(sourced?.profile.notes).toBe('owner fixture');
      expect(sourced?.origin).toBe('owner');
      expect(problems.join(' ')).toContain('ombreggia');
    } finally {
      cleanup(home);
    }
  });

  it('a malformed owner file is dropped and named while shipped still resolves', () => {
    const { home, release } = layout({
      ownerFiles: { 'broken.json': '{ not json', 'owner-lan.json': ownerLan() },
    });
    try {
      const problems: string[] = [];
      const sourced = selectSourcedProfile(
        'my-lan-model',
        loadEffectiveProfiles(home, release, (line) => problems.push(line)),
      );
      expect(sourced?.profile.name).toBe('owner-lan');
      expect(problems.join(' ')).toContain('broken.json');
    } finally {
      cleanup(home);
    }
  });

  it('a missing owner directory is silence, not a problem line', () => {
    const { home, release } = layout({});
    try {
      const problems: string[] = [];
      const sourced = selectSourcedProfile(
        'my-lan-model',
        loadEffectiveProfiles(home, release, (line) => problems.push(line)),
      );
      expect(problems).toEqual([]);
      expect(sourced?.profile.name).toBe('shipped-a');
      expect(sourced?.origin).toBe('shipped');
    } finally {
      cleanup(home);
    }
  });

  it('an unmatched model resolves to nothing, so the caller falls back visibly', () => {
    const { home, release } = layout({ ownerFiles: { 'owner-lan.json': ownerLan() } });
    try {
      const sourced = selectSourcedProfile(
        'some-unknown-model',
        loadEffectiveProfiles(home, release),
      );
      expect(sourced).toBeUndefined();
    } finally {
      cleanup(home);
    }
  });

  it('the production runtime resolves the owner profile and carries its provenance', () => {
    // The wiring half of the claim: an update-surviving profile is useless if
    // the loop never sees it. `buildRuntime` must hand the loop the owner
    // envelope, with the origin attached for diagnostics.
    const home = mkdtempSync(join(tmpdir(), 'muffin-owner-wiring-'));
    try {
      runInit({ home, apiKey: 'sk-never-called', mainModel: 'my-lan-model' });
      mkdirSync(ownerProfilesDir(home), { recursive: true });
      writeFileSync(join(ownerProfilesDir(home), 'owner-lan.json'), JSON.stringify(ownerLan()));
      const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-owner-ws-')));
      try {
        expect(runtime.deps.profile.name).toBe('owner-lan');
        expect(runtime.deps.runtimeInfo?.profileSource).toEqual({
          origin: 'owner',
          file: join(ownerProfilesDir(home), 'owner-lan.json'),
        });
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('without an owner match the runtime stays on shipped or conservative, as before', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-owner-wiring-'));
    try {
      runInit({ home, apiKey: 'sk-never-called' });
      const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-owner-ws-')));
      try {
        expect(runtime.deps.profile.name).toBe(
          selectSourcedProfile(runtime.config.models.main, loadEffectiveProfiles(home))?.profile.name ??
            CONSERVATIVE.name,
        );
        expect(runtime.deps.runtimeInfo?.profileSource?.origin).not.toBe('owner');
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
