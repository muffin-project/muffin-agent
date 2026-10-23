import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { loadConfig, saveConfig } from '../core/config/config.js';
import { isSameOrNestedPath, muffinWorkspace } from '../core/config/workspace.js';
import { buildRuntime } from './runtime.js';

/**
 * The join this slice exists for: `workspace` in `config.json` has to reach
 * `Runtime.workspace`, not just sit in the schema.
 *
 * A schema field with no reader is the exact failure this repository has paid
 * for before. The gateway and `muffin run` call `buildRuntime(home)` with no
 * cwd — the two surfaces that cannot choose a directory by standing in one —
 * so this test asks the same call, with the same absence, and checks where the
 * turn would actually write.
 */
describe('buildRuntime reads the declared workspace', () => {
  it('uses config.workspace when the caller passes no cwd (the supervised surfaces)', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ws-config-home-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const project = mkdtempSync(join(tmpdir(), 'muffin-ws-config-project-'));
    saveConfig({ ...loadConfig(home), workspace: project }, home);

    const runtime = buildRuntime(home);
    try {
      expect(runtime.workspace).toBe(project);
    } finally {
      runtime.close();
    }
  }, 30_000);

  it('refuses a declared workspace inside the install, and lands on the default', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-ws-config-bad-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const inside = join(home, 'progetto');
    mkdirSync(inside);
    saveConfig({ ...loadConfig(home), workspace: inside }, home);

    const runtime = buildRuntime(home);
    try {
      expect(runtime.workspace).toBe(muffinWorkspace(home));
      expect(isSameOrNestedPath(runtime.workspace, home)).toBe(false);
    } finally {
      runtime.close();
    }
  }, 30_000);
});
