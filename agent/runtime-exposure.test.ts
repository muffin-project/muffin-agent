import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { CAPABILITY_SEARCH_TOOL_NAME, createCapabilityExposure } from './capability-exposure.js';
import { visibleTools } from './context/assemble.js';
import { baseToolOrder, buildRuntime } from './runtime.js';
import { WORK_MESSAGE_TOOL_NAME } from './tools/work-message.js';

// This fixture simulates the base menu, without a bound Telegram turn.
function baseMenuName(name: string): boolean {
  return name !== CAPABILITY_SEARCH_TOOL_NAME && name !== WORK_MESSAGE_TOOL_NAME;
}

/**
 * Native registration order and the #469 model-visible projection.
 *
 * Before #469 this file guarded a hard `slice(0, maxToolsExposed)`: a tool
 * after the profile ceiling simply disappeared from the model request. The
 * structural repair keeps deterministic registration for diagnostics/cache
 * stability, but moves the actual turn view to `createCapabilityExposure`.
 *
 * The tests below therefore prove both facts separately:
 * - `baseToolOrder` still matches the real native catalogue;
 * - profiles that fit stay on the ordinary fast path with no discovery tool;
 * - a pressured profile exposes a small core + capability_search and can load
 *   a needed authorized schema without increasing the ceiling.
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

function ownerProjection(runtime: ReturnType<typeof buildRuntime>) {
  const principal = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;
  const eligible = visibleTools(
    runtime.deps.tools.filter((tool) => tool.spec.name !== WORK_MESSAGE_TOOL_NAME),
    principal,
    runtime.deps.capabilities,
    runtime.deps.grants?.get('host'),
  );
  const discoveryTool = eligible.find((tool) => tool.spec.name === CAPABILITY_SEARCH_TOOL_NAME);
  return createCapabilityExposure({
    eligible,
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
    expect(rt.names.filter((n) => !SANDBOXED.includes(n) && baseMenuName(n))).toEqual(REGISTERED);
    expect(rt.names).toContain(CAPABILITY_SEARCH_TOOL_NAME);
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
    expect(baseToolOrder({ sandboxAvailable: conteneva, searchOn: false })).toEqual(
      rt.names.filter(baseMenuName),
    );
  });

  it('il catalogo reale mostra il nucleo e carica sys_inspect, senza un tetto numerico', () => {
    const rt = realRuntime();
    try {
      const projection = ownerProjection(rt.runtime);
      expect(projection.pressured).toBe(true);
      expect(projection.exposed.map((tool) => tool.spec.name)).toContain(
        CAPABILITY_SEARCH_TOOL_NAME,
      );
      expect(projection.exposed.map((tool) => tool.spec.name)).toContain('fs_read');
      expect(projection.exposed.map((tool) => tool.spec.name)).not.toContain('sys_inspect');

      const found = projection.discovery?.searchAndLoad('inspect current runtime', 2);
      expect(found?.loaded.map((tool) => tool.name)).toContain('sys_inspect');
      projection.discovery?.activatePending();
      expect(projection.exposed.map((tool) => tool.spec.name)).toContain('sys_inspect');
    } finally {
      rt.close();
    }
  });
});
