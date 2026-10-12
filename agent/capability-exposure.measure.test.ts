import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { CAPABILITY_SEARCH_TOOL_NAME, createCapabilityExposure } from './capability-exposure.js';
import { visibleTools } from './context/assemble.js';
import { buildRuntime } from './runtime.js';

function schemaBytes(tools: readonly { spec: unknown }[]): number {
  return Buffer.byteLength(JSON.stringify(tools.map((tool) => tool.spec)), 'utf8');
}

describe('#469 current-catalog exposure measurement', () => {
  it('measures schema pressure and deterministic selection on representative native tasks', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-capability-measure-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-capability-measure-ws-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const runtime = buildRuntime(home, workspace);

    try {
      const owner = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;
      const eligible = visibleTools(
        runtime.deps.tools,
        owner,
        runtime.deps.capabilities,
        runtime.deps.grants?.get('host'),
      );
      const discoveryTool = eligible.find(
        (tool) => tool.spec.name === CAPABILITY_SEARCH_TOOL_NAME,
      );
      expect(discoveryTool).toBeDefined();

      const maxToolsExposed = 10;
      const flat = eligible.filter(
        (tool) => tool.spec.name !== CAPABILITY_SEARCH_TOOL_NAME,
      );
      expect(flat.length).toBeGreaterThan(maxToolsExposed);

      const projection = createCapabilityExposure({
        eligible,
        maxToolsExposed,
        discoveryTool: discoveryTool!,
      });
      expect(projection.pressured).toBe(true);

      const initialToolCount = projection.exposed.length;
      const fullSchemaBytes = schemaBytes(flat);
      const initialSchemaBytes = schemaBytes(projection.exposed);
      const reduction = 1 - initialSchemaBytes / fullSchemaBytes;

      const cases = [
        ['write a file', 'fs_write'],
        ['edit an existing file', 'fs_edit'],
        ['explain why a memory was recalled', 'memory_why'],
        ['forget a remembered fact', 'memory_forget'],
        ['read an uploaded document', 'document_read'],
        ['save a document in the vault', 'vault_save'],
        ['list running processes', 'process_list'],
        ['kill a running process', 'process_kill'],
        ['fetch a public http url', 'http_get'],
        ['pause this turn until later', 'wait'],
        ['manage the todo plan', 'todo'],
        ['schedule a recurring reminder', 'schedule_recurring'],
        ['inspect the current runtime configuration', 'sys_inspect'],
        ['show effects performed by the agent', 'sys_effects'],
      ] as const;

      const availableNames = new Set(flat.map((tool) => tool.spec.name));
      for (const [, expected] of cases) {
        expect(availableNames.has(expected), 'representative tool missing: ' + expected).toBe(true);
      }

      let hits = 0;
      for (const [query, expected] of cases) {
        const result = projection.discovery!.searchAndLoad(query, 3);
        if (result.loaded.some((entry) => entry.name === expected)) hits += 1;
        projection.discovery!.activatePending();
        expect(
          projection.exposed.some((tool) => tool.spec.name === expected),
          'failed query: ' + query + ' -> ' + expected,
        ).toBe(true);
        expect(projection.exposed.length).toBeLessThanOrEqual(maxToolsExposed);
      }

      const metrics = {
        fullToolCount: flat.length,
        initialToolCount,
        fullSchemaBytes,
        initialSchemaBytes,
        schemaByteReductionPct: Number((reduction * 100).toFixed(1)),
        representativeTasks: cases.length,
        selectionHits: hits,
        selectionSuccessPct: Number(((hits / cases.length) * 100).toFixed(1)),
        extraDiscoveryModelRoundsPerHiddenTask: 1,
      };

      console.info('CAPABILITY_EXPOSURE_METRICS ' + JSON.stringify(metrics));

      expect(reduction).toBeGreaterThan(0.25);
      expect(hits).toBe(cases.length);
    } finally {
      runtime.close();
    }
  });
});
