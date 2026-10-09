import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { buildRuntime } from './runtime.js';

describe('runtime automation rule storage', () => {
  it('reopens non-time rule definitions through the canonical runtime database', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-automation-runtime-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-automation-workspace-'));
    runInit({ home, apiKey: 'sk-automation-mai-usata' });

    const first = buildRuntime(home, workspace);
    first.automationRules.create({
      id: 'persistent-message-rule',
      tenant: 'host',
      eventKind: 'message.received',
      matcher: { type: 'evidence_equals', key: 'text', value: 'buongiorno' },
      action: { mode: 'deterministic', ref: 'test.checked' },
      origin: {
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        surface: 'cli',
        turnId: 'turn-create',
        tier: 0,
      },
    });
    first.close();

    const second = buildRuntime(home, workspace);
    expect(second.automationRules.listEnabled('host', 'message.received')).toEqual([
      expect.objectContaining({
        id: 'persistent-message-rule',
        eventKind: 'message.received',
        enabled: true,
        version: 1,
      }),
    ]);
    second.close();
  });
});
