import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { CAPABILITY_SEARCH_TOOL_NAME, createCapabilityExposure } from './capability-exposure.js';
import { visibleTools } from './context/assemble.js';
import { loadProfiles, selectProfile } from './profiles/profile.js';
import { baseToolOrder, buildRuntime } from './runtime.js';

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

function realRuntime(): {
  names: string[];
  runtime: ReturnType<typeof buildRuntime>;
  close: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), 'muffin-exposure-'));
  runInit({ home, apiKey: 'sk-never-called' });
  const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-exposure-ws-')));
  const names = runtime.deps.tools.map((t) => t.spec.name);
  return { names, runtime, close: () => runtime.close() };
}

function ownerProjection(runtime: ReturnType<typeof buildRuntime>, maxToolsExposed: number) {
  const principal = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;
  const eligible = visibleTools(
    runtime.deps.tools,
    principal,
    runtime.deps.capabilities,
    runtime.deps.grants?.get('host'),
  );
  const discoveryTool = eligible.find((tool) => tool.spec.name === CAPABILITY_SEARCH_TOOL_NAME);
  return createCapabilityExposure({
    eligible,
    maxToolsExposed,
    ...(discoveryTool === undefined ? {} : { discoveryTool }),
  });
}

/**
 * Le due corsie della shell sono registrate solo dove la sonda del sandbox è
 * passata, quindi sono le uniche voci la cui presenza è una proprietà della
 * macchina e non del codice. Tolte dal confronto, ed è la ragione per cui
 * questo file asserisce una lista *filtrata* e non un'istantanea.
 *
 * Due e non una dal 06/09 (ADR-0074 punto 4): filtrarne una sola lascerebbe l'altra
 * dentro il confronto e lo renderebbe dipendente dall'host, che è esattamente
 * il difetto che questa costante evita.
 */
const SANDBOXED = ['shell_run', 'shell_run_write'];

/**
 * L'ordine dichiarato, sandbox e search a parte — non più un secondo elenco
 * scritto a mano qui: `baseToolOrder` (`agent/runtime.ts`) è la stessa lista
 * che `muffin doctor` legge per dire quali tool un tetto taglierebbe senza
 * costruire un runtime intero. Un elenco qui e un elenco là erano due modi di
 * saperlo, ed è esattamente la forma di guasto che questo file esiste per
 * impedire (`slice/turno-sospeso`: `wait`/`todo` in posizione 6-7 spinsero
 * `skill_read` e `http_get` oltre il tetto, in silenzio, e la suite restò
 * verde).
 */
const REGISTERED = baseToolOrder({ sandboxAvailable: false, searchOn: false });

describe('quali tool vede davvero un turno', () => {
  it('l’ordine di registrazione è quello dichiarato, e cambiarlo fallisce qui', () => {
    const rt = realRuntime();
    rt.close();
    expect(rt.names.filter((n) => !SANDBOXED.includes(n))).toEqual(REGISTERED);
  });

  it('baseToolOrder non diverge dal registro reale, sandbox della macchina compresa', () => {
    // Il de-drift esplicito: qui `shell_run` NON viene filtrato, a differenza
    // del test sopra — `baseToolOrder` deve prevedere esattamente la
    // posizione reale di `sys.shell` quando la sandbox di questa macchina è
    // disponibile, non solo il caso senza. Se un domani un tool si inserisce
    // fra `document_read` e `process_list` senza toccare `baseToolOrder`, qui
    // diventa rosso — non a `cli/doctor.test.ts`, dove nessuno lo cercherebbe.
    const rt = realRuntime();
    rt.close();
    const conteneva = SANDBOXED.every((n) => rt.names.includes(n));
    // O tutte e due o nessuna: `agent/runtime.ts` le registra insieme, e un
    // host che ne offrisse una sola sarebbe la degradazione silenziosa che
    // ADR-0074 punto 4 vieta — qui si vede, invece di passare inosservata.
    expect(SANDBOXED.some((n) => rt.names.includes(n))).toBe(conteneva);
    expect(baseToolOrder({ sandboxAvailable: conteneva, searchOn: false })).toEqual(rt.names);
  });

  it('su consumer-local resta il fast path ordinario finché il catalogo entra nel profilo', () => {
    const profiles = loadProfiles(join(import.meta.dirname, 'profiles'));
    const profile = selectProfile('qwen3.8-27b', profiles);
    expect(profile.maxToolsExposed).toBe(22);

    const rt = realRuntime();
    try {
      const projection = ownerProjection(rt.runtime, profile.maxToolsExposed);
      expect(projection.pressured).toBe(false);
      expect(projection.discovery).toBeUndefined();
      expect(projection.exposed.map((tool) => tool.spec.name)).not.toContain(
        CAPABILITY_SEARCH_TOOL_NAME,
      );
    } finally {
      rt.close();
    }
  });

  it('su conservative il tetto limita gli schema ma non rende irraggiungibile sys_inspect', () => {
    const rt = realRuntime();
    try {
      const projection = ownerProjection(rt.runtime, 10);
      expect(projection.pressured).toBe(true);
      expect(projection.exposed.length).toBeLessThanOrEqual(10);
      expect(projection.exposed.map((tool) => tool.spec.name)).toContain(
        CAPABILITY_SEARCH_TOOL_NAME,
      );
      expect(projection.exposed.map((tool) => tool.spec.name)).not.toContain('sys_inspect');

      const found = projection.discovery?.searchAndLoad('inspect current runtime', 2);
      expect(found?.loaded.map((tool) => tool.name)).toContain('sys_inspect');
      projection.discovery?.activatePending();
      expect(projection.exposed.map((tool) => tool.spec.name)).toContain('sys_inspect');
      expect(projection.exposed.length).toBeLessThanOrEqual(10);
    } finally {
      rt.close();
    }
  });

  it('su un profilo frontier il catalogo resta sul fast path statico', () => {
    const profiles = loadProfiles(join(import.meta.dirname, 'profiles'));
    const profile = selectProfile('claude-sonnet-5', profiles);
    const rt = realRuntime();
    try {
      const projection = ownerProjection(rt.runtime, profile.maxToolsExposed);
      expect(projection.pressured).toBe(false);
      expect(projection.discovery).toBeUndefined();
    } finally {
      rt.close();
    }
  });
});
