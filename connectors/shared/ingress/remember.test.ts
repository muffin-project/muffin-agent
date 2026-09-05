import { describe, expect, it } from 'vitest';
import type { Decision } from '../../../core/policy/types.js';
import { rememberWithoutReplying, type RememberableMessage, type RememberDeps } from './remember.js';

/**
 * Slice 12 verification (`docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md`
 * §3 row 12). Unit-level, against the module directly — the connector-level
 * proof that Telegram actually calls this and that the kernel door is really
 * asked lives in `connectors/telegram/ricordare-senza-rispondere.test.ts`,
 * driven through a real `drain()` rather than reimplemented here.
 */

const OWNER = { kind: 'member' as const, connector: 'fixture', tenantId: 'group:fixture:1', externalId: '99' };

const MESSAGE: RememberableMessage = {
  principal: OWNER,
  tenant: 'group:fixture:1',
  threadKey: 'fixture:1',
  content: 'il criceto è scappato di nuovo',
  trustTier: 2,
  createdAt: '2026-09-05T00:00:00.000Z',
};

function allow(): Decision {
  return { effect: 'allow' };
}

function deny(): Decision {
  return { effect: 'deny', code: 'no_capability' };
}

describe('rememberWithoutReplying', () => {
  it('no memory wired at all: skipped, nothing attempted', () => {
    const deps: RememberDeps = { memory: undefined, decide: allow };
    expect(rememberWithoutReplying(deps, 'fixture', MESSAGE)).toEqual({ kind: 'skipped' });
  });

  it('empty content: skipped, the kernel is never even asked', () => {
    let asked = false;
    const deps: RememberDeps = {
      memory: { store: { addEpisode: () => 0 } },
      decide: () => {
        asked = true;
        return allow();
      },
    };
    const outcome = rememberWithoutReplying(deps, 'fixture', { ...MESSAGE, content: '' });
    expect(outcome).toEqual({ kind: 'skipped' });
    expect(asked).toBe(false);
  });

  it('the kernel can refuse: memory.write denied, nothing is written', () => {
    let wrote = false;
    const deps: RememberDeps = {
      memory: {
        store: {
          addEpisode: () => {
            wrote = true;
            return 0;
          },
        },
      },
      decide: deny,
    };
    const outcome = rememberWithoutReplying(deps, 'fixture', MESSAGE);
    expect(outcome).toEqual({ kind: 'skipped' });
    expect(wrote).toBe(false);
  });

  it('the kernel asked before the write: capability, tenant resource and taint match the message', () => {
    const requests: unknown[] = [];
    const deps: RememberDeps = {
      memory: { store: { addEpisode: () => 0 } },
      decide: (req) => {
        requests.push(req);
        return allow();
      },
    };
    rememberWithoutReplying(deps, 'fixture', MESSAGE);
    expect(requests).toEqual([
      {
        principal: OWNER,
        tenant: 'group:fixture:1',
        capability: 'memory.write',
        resource: { kind: 'tenant', value: 'group:fixture:1' },
        args: {},
        taint: 2,
      },
    ]);
  });

  it('allowed: writes exactly one episode, role user, no actorId, connector as supplied', () => {
    const written: unknown[] = [];
    const deps: RememberDeps = {
      memory: {
        store: {
          addEpisode: (input) => {
            written.push(input);
            return 1;
          },
        },
      },
      decide: allow,
    };
    const outcome = rememberWithoutReplying(deps, 'fixture', MESSAGE);
    expect(outcome).toEqual({ kind: 'written' });
    expect(written).toEqual([
      {
        tenantId: 'group:fixture:1',
        connector: 'fixture',
        threadKey: 'fixture:1',
        role: 'user',
        kind: 'message',
        content: 'il criceto è scappato di nuovo',
        trustTier: 2,
        createdAt: '2026-09-05T00:00:00.000Z',
      },
    ]);
    expect(written[0]).not.toHaveProperty('actorId');
  });

  it('a write that throws is caught here and reported, never left to escape to the caller', () => {
    const deps: RememberDeps = {
      memory: {
        store: {
          addEpisode: () => {
            throw new Error('SqliteError: FOREIGN KEY constraint failed');
          },
        },
      },
      decide: allow,
    };
    expect(() => rememberWithoutReplying(deps, 'fixture', MESSAGE)).not.toThrow();
    const outcome = rememberWithoutReplying(deps, 'fixture', MESSAGE);
    expect(outcome).toEqual({ kind: 'failed', message: 'SqliteError: FOREIGN KEY constraint failed' });
  });
});
