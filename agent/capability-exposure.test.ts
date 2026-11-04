import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_SEARCH_TOOL_NAME,
  createCapabilityExposure,
  preloadCapabilitiesForTask,
} from './capability-exposure.js';

function tool(name: string, capability = name, description = name) {
  return { capability, spec: { name, description } };
}

const discovery = tool(
  CAPABILITY_SEARCH_TOOL_NAME,
  'sys.capability_discover',
  'Search and load an authorized capability for the current task.',
);

describe('capability exposure projection', () => {
  it('preserves the legacy fast path when the authorized catalogue fits the cap', () => {
    const eligible = [tool('fs_read'), tool('memory_search'), tool('http_get')];
    const projection = createCapabilityExposure({
      eligible: [...eligible, discovery],
      maxToolsExposed: 10,
      discoveryTool: discovery,
    });

    expect(projection.pressured).toBe(false);
    expect(projection.exposed).toEqual(eligible);
    expect(projection.discovery).toBeUndefined();
  });

  it('discovers and loads a needed authorized tool beyond the old registration cap', () => {
    const eligible = [
      tool('fs_read'),
      tool('fs_list'),
      tool('fs_search'),
      tool('memory_search'),
      tool('skill_read'),
      tool('http_get'),
      tool('process_list'),
      tool('process_kill'),
      tool('todo'),
      tool('sys_inspect'),
      tool('event_watch_create', 'event.watch', 'Create a durable external event trigger.'),
      discovery,
    ];
    const projection = createCapabilityExposure({
      eligible,
      maxToolsExposed: 10,
      discoveryTool: discovery,
    });

    expect(projection.pressured).toBe(true);
    expect(projection.exposed.map((entry) => entry.spec.name)).not.toContain(
      'event_watch_create',
    );
    expect(projection.exposed).toHaveLength(6);

    const result = projection.discovery?.searchAndLoad('external event trigger', 3);

    expect(result?.loaded.map((entry) => entry.name)).toContain('event_watch_create');
    // Search selects for the next round; the current batch cannot immediately
    // invoke a schema the model was never shown.
    expect(projection.exposed.map((entry) => entry.spec.name)).not.toContain(
      'event_watch_create',
    );
    projection.discovery?.activatePending();
    expect(projection.exposed.map((entry) => entry.spec.name)).toContain(
      'event_watch_create',
    );
    expect(projection.exposed.length).toBeLessThanOrEqual(10);
  });

  it('cannot discover a tool that authority filtering removed from the catalogue', () => {
    const eligible = [
      tool('fs_read'),
      tool('fs_list'),
      tool('fs_search'),
      tool('memory_search'),
      tool('skill_read'),
      tool('http_get'),
      tool('todo'),
      tool('wait'),
      tool('sys_inspect'),
      tool('event_watch_list', 'event.watch', 'List external event watches.'),
      discovery,
    ];
    const projection = createCapabilityExposure({
      eligible,
      maxToolsExposed: 8,
      discoveryTool: discovery,
    });

    const result = projection.discovery?.searchAndLoad('secret host write', 5);

    expect(result?.loaded).toEqual([]);
    expect(projection.exposed.map((entry) => entry.spec.name)).not.toContain(
      'forbidden_host_write',
    );
  });

  it('replaces only the dynamic task-local set on a second search', () => {
    const eligible = [
      tool('fs_read'),
      tool('fs_list'),
      tool('fs_search'),
      tool('memory_search'),
      tool('skill_read'),
      tool('http_get', 'net.read', 'Read a public URL.'),
      tool('event_watch_create', 'event.watch', 'Create an event trigger.'),
      tool('event_watch_list', 'event.watch', 'List event triggers.'),
      tool('todo', 'todo.write', 'Manage the current plan.'),
      discovery,
    ];
    const projection = createCapabilityExposure({
      eligible,
      maxToolsExposed: 8,
      discoveryTool: discovery,
    });

    projection.discovery?.searchAndLoad('event trigger', 2);
    projection.discovery?.activatePending();
    expect(projection.exposed.map((entry) => entry.spec.name)).toEqual(
      expect.arrayContaining(['event_watch_create', 'event_watch_list']),
    );

    projection.discovery?.searchAndLoad('public url', 1);
    projection.discovery?.activatePending();
    const names = projection.exposed.map((entry) => entry.spec.name);
    expect(names).toContain('http_get');
    expect(names).not.toContain('event_watch_create');
    expect(names).not.toContain('event_watch_list');
  });

  it('a one-slot profile does not report capability_search itself as a discovered match', () => {
    const projection = createCapabilityExposure({
      eligible: [tool('fs_read'), tool('event_watch_create', 'event.watch'), discovery],
      maxToolsExposed: 1,
      discoveryTool: discovery,
    });

    const result = projection.discovery?.searchAndLoad('does not exist anywhere', 3);
    expect(result?.loaded).toEqual([]);
    expect(result?.matched).toBe(0);
    projection.discovery?.activatePending();
    expect(projection.exposed.map((entry) => entry.spec.name)).toEqual([
      CAPABILITY_SEARCH_TOOL_NAME,
    ]);
  });


  it('preloads an obvious authorized hidden capability from task text without widening the cap', () => {
    const eligible = [
      tool('fs_read'),
      tool('fs_list'),
      tool('fs_search'),
      tool('memory_search'),
      tool('skill_read'),
      tool('event_watch_create', 'event.watch', 'Create a durable external event trigger.'),
      discovery,
    ];
    const projection = createCapabilityExposure({
      eligible,
      maxToolsExposed: 4,
      discoveryTool: discovery,
    });

    const loaded = preloadCapabilitiesForTask(
      projection,
      'create external event trigger',
      2,
    );
    expect(loaded?.loaded.map((entry) => entry.name)).toContain('event_watch_create');
    expect(projection.exposed.map((entry) => entry.spec.name)).toContain('event_watch_create');
    expect(projection.exposed.map((entry) => entry.spec.name)).toContain(
      CAPABILITY_SEARCH_TOOL_NAME,
    );
    expect(projection.exposed.length).toBeLessThanOrEqual(4);
  });

});
