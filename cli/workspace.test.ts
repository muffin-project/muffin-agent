import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, saveConfig } from '../core/config/config.js';
import { runInit } from './init.js';
import { cmdWorkspace } from './workspace.js';

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-cmd-workspace-'));
  vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'xdg'));
  runInit({ home: dir, apiKey: 'sk-ant-fixture' });
  return dir;
}

function io(): {
  out: string;
  err: string;
  deps: { out: (l: string) => void; err: (l: string) => void };
} {
  const state = { out: '', err: '' };
  return {
    ...state,
    deps: {
      out: (l) => {
        state.out += `${l}\n`;
      },
      err: (l) => {
        state.err += `${l}\n`;
      },
    },
    get out() {
      return state.out;
    },
    get err() {
      return state.err;
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('muffin workspace', () => {
  it('shows the default when nothing is declared', () => {
    const dir = home();
    const capture = io();
    expect(cmdWorkspace(dir, [], capture.deps)).toBe(0);
    expect(capture.out).toContain('dichiarata  (nessuna');
    expect(capture.out).toContain('default');
  });

  it('declares an existing project outside the install, and persists it', () => {
    const dir = home();
    const project = join(dir, '..', 'progetto');
    mkdirSync(project, { recursive: true });
    const capture = io();
    expect(cmdWorkspace(dir, ['set', project], capture.deps)).toBe(0);
    expect(capture.out).toContain('gateway restart');
    expect(loadConfig(dir).workspace).toBe(project);
  });

  it('refuses the install, a path that is not a directory, and a missing path', () => {
    const dir = home();
    const inside = join(dir, 'dentro');
    mkdirSync(inside);
    for (const bad of [dir, inside]) {
      const capture = io();
      expect(cmdWorkspace(dir, ['set', bad], capture.deps)).toBe(2);
      expect(capture.err).toContain('installazione');
    }
    const file = join(dir, '..', 'file.txt');
    writeFileSync(file, 'x');
    const notDir = io();
    expect(cmdWorkspace(dir, ['set', file], notDir.deps)).toBe(2);
    expect(notDir.err).toContain('non è una cartella');
    const missing = io();
    expect(cmdWorkspace(dir, ['set', join(dir, '..', 'manca')], missing.deps)).toBe(2);
    expect(missing.err).toContain('non esiste');
    expect(loadConfig(dir).workspace).toBeUndefined();
  });

  it('clears the declaration and says the gateway needs a restart', () => {
    const dir = home();
    const project = join(dir, '..', 'progetto-clear');
    mkdirSync(project, { recursive: true });
    const config = loadConfig(dir);
    saveConfig({ ...config, workspace: project }, dir);
    const capture = io();
    expect(cmdWorkspace(dir, ['clear'], capture.deps)).toBe(0);
    expect(capture.out).toContain('gateway restart');
    expect(loadConfig(dir).workspace).toBeUndefined();
  });

  it('flags a hand-edited config that names the install instead of hiding it', () => {
    const dir = home();
    const config = loadConfig(dir);
    saveConfig({ ...config, workspace: join(dir, 'dentro') }, dir);
    const capture = io();
    expect(cmdWorkspace(dir, [], capture.deps)).toBe(0);
    expect(capture.out).toContain("dentro l'installazione: ignorata");
  });

  it('rejects an unknown subcommand with the usage', () => {
    const dir = home();
    const capture = io();
    expect(cmdWorkspace(dir, ['boh'], capture.deps)).toBe(2);
    expect(capture.err).toContain('muffin workspace set');
  });
});
