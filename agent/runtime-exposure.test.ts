import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { loadProfiles, selectProfile } from './profiles/profile.js';
import { buildRuntime } from './runtime.js';

/**
 * Which tools a turn is actually shown, and what falls off the end.
 *
 * `profile.maxToolsExposed` truncates the registered list **by registration
 * order**, and `consumer-local.json` sets it to 10 against a default install of
 * eleven or twelve tools (the sandbox decides). So something is always cut on
 * that profile, silently: it is simply not in the request, no line is logged,
 * and the model behaves as if it did not exist. *What* is cut is decided by the
 * order of a literal in `buildRuntime` — a place nobody edits with the cap in
 * mind.
 *
 * That is how `slice/turno-sospeso` cost a small-model install its web access:
 * `wait` and `todo` went into the base array at positions 6-7 and pushed
 * `skill_read` and `http_get` over the line. The trade was never decided, and
 * nothing could have caught it — the suite was green and every tool worked.
 *
 * This file is the thing that would have caught it. It asserts the **whole
 * ordered list**, so any insertion anywhere fails here and names itself, and it
 * asserts the cut for the profile where the cut is real.
 */

function realRuntime(): { names: string[]; close: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'muffin-exposure-'));
  runInit({ home, apiKey: 'sk-never-called' });
  const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-exposure-ws-')));
  const names = runtime.deps.tools.map((t) => t.spec.name);
  return { names, close: () => runtime.close() };
}

/**
 * `shell_run` is registered only where the sandbox probe passed, so it is the
 * one entry whose presence is a property of the machine rather than of the
 * code. Dropped from the comparison, and its absence is the reason this file
 * asserts a *filtered* list rather than a snapshot.
 */
const SANDBOXED = 'shell_run';

/** The order `buildRuntime` registers in, sandbox aside. Change this on purpose. */
const REGISTERED = [
  'fs_read',
  'fs_list',
  'fs_write',
  'memory_search',
  'document_read',
  'process_list',
  'process_kill',
  'skill_read',
  'http_get',
  // Last, and deliberately so — see the comment in `buildRuntime`. A weak model
  // that loses the web in exchange for being able to suspend itself has made
  // the wrong trade on the profile least able to run a multi-turn plan.
  'wait',
  'todo',
];

describe('quali tool vede davvero un turno', () => {
  it('l’ordine di registrazione è quello dichiarato, e cambiarlo fallisce qui', () => {
    const rt = realRuntime();
    rt.close();
    expect(rt.names.filter((n) => n !== SANDBOXED)).toEqual(REGISTERED);
  });

  it('su consumer-local il tetto taglia solo le due primitive, mai il web', () => {
    /**
     * The profile that actually truncates. The cap is not a hypothetical: it is
     * what a local model gets, and the tools past the line are invisible to it —
     * no error, no log, no mention in the prompt.
     *
     * The assertion is on **what the cut may contain**, not on a fixed list,
     * because `shell_run` is registered only where the sandbox probe passed: on
     * a machine with a sandbox twelve tools meet a cap of ten and two are cut,
     * without one it is eleven and one. Pinning either number would make this
     * file pass or fail on the host rather than on the code. What must hold on
     * every host is that the things the cap takes are the two primitives at the
     * end of the list, and never the web, the catalogue or memory.
     */
    const profiles = loadProfiles(join(import.meta.dirname, 'profiles'));
    const profile = selectProfile('qwen3.8-27b', profiles);
    expect(profile.maxToolsExposed).toBe(10);

    const rt = realRuntime();
    rt.close();
    const shown = rt.names.slice(0, profile.maxToolsExposed);
    const cut = rt.names.slice(profile.maxToolsExposed);

    // The cap really bites on this profile — otherwise the rest proves nothing.
    expect(cut.length).toBeGreaterThan(0);
    // And everything it takes is one of the two primitives. Before the
    // reordering this set was `['skill_read', 'http_get']`.
    expect(cut.every((n) => n === 'wait' || n === 'todo')).toBe(true);

    // Said positively too, because a subset assertion passes on an empty world.
    for (const kept of ['fs_read', 'memory_search', 'document_read', 'skill_read', 'http_get']) {
      expect(shown, `${kept} deve restare esposto`).toContain(kept);
    }
  });

  it('su un profilo frontier non taglia niente, quindi l’ordine non si vede', () => {
    // The other half: the trade above is only ever paid by the small profile,
    // and stating it here stops the next reader from thinking `wait` is
    // unavailable in general.
    const profiles = loadProfiles(join(import.meta.dirname, 'profiles'));
    const profile = selectProfile('claude-sonnet-5', profiles);
    const rt = realRuntime();
    rt.close();
    expect(rt.names.length).toBeLessThanOrEqual(profile.maxToolsExposed);
  });
});
