import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import { toolContext } from '../fixtures/tool-context.js';
import { makeProcessTools, processCapabilities } from './process.js';

const ctx = toolContext();

const FAKE_PS = ['  PID USER   COMM', '    1 root   /sbin/launchd', '  512 giusto node', '  777 giusto redis-server'].join('\n');

function fakeTools(psOut = FAKE_PS) {
  const psCalls: (readonly string[])[] = [];
  const killCalls: Array<[number, string]> = [];
  const tools = makeProcessTools({
    psFn: async (argv) => {
      psCalls.push(argv);
      return psOut;
    },
    killFn: (pid, signal) => {
      killCalls.push([pid, signal]);
    },
  });
  return {
    psCalls,
    killCalls,
    list: tools.find((t) => t.capability === 'sys.process.list')!,
    kill: tools.find((t) => t.capability === 'sys.process.kill')!,
  };
}

describe('process_list', () => {
  it('asks ps for comm, never args — argv with secret flags must not be requested', async () => {
    const { list, psCalls } = fakeTools();
    await list.handler({}, ctx);
    const argv = psCalls[0]!.join(' ');
    expect(argv).toContain('comm');
    // the exact leak this guards: `ps -eo ...,args` would print other
    // processes' command lines, tokens-as-flags included.
    expect(argv).not.toContain('args');
    expect(argv).not.toContain('command');
  });

  it('returns the header and the listed processes', async () => {
    const { list } = fakeTools();
    const out = await list.handler({}, ctx);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('PID USER');
    expect(out.content).toContain('redis-server');
  });

  it('the grep filter narrows to matching lines and keeps the header', async () => {
    const { list } = fakeTools();
    const out = await list.handler({ grep: 'redis' }, ctx);
    expect(out.content).toContain('PID USER');
    expect(out.content).toContain('redis-server');
    expect(out.content).not.toContain('launchd');
  });

  it('a ps failure is reported, not swallowed', async () => {
    const tools = makeProcessTools({
      psFn: async () => {
        throw new Error('ps: command not found');
      },
    });
    const list = tools.find((t) => t.capability === 'sys.process.list')!;
    const out = await list.handler({}, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('ps failed');
  });
});

describe('process_kill argument boundary', () => {
  const { kill } = fakeTools();

  it('refuses pid 0, negatives and init at the schema, never reaching the syscall', async () => {
    const { kill, killCalls } = fakeTools();
    for (const pid of [0, -1, 1]) {
      const out = await kill.handler({ pid }, ctx);
      expect(out.isError).toBe(true);
    }
    expect(killCalls.length).toBe(0);
  });

  it('refuses to signal the agent process itself, before the syscall', async () => {
    const { kill, killCalls } = fakeTools();
    const out = await kill.handler({ pid: process.pid }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('itself');
    expect(killCalls.length).toBe(0);
  });

  it('an invalid signal name is rejected before the syscall', async () => {
    const { kill, killCalls } = fakeTools();
    const out = await kill.handler({ pid: 999999, signal: 'BOOM' }, ctx);
    expect(out.isError).toBe(true);
    expect(killCalls.length).toBe(0);
  });

  it('delivers the chosen signal and reports delivery, not death', async () => {
    const { kill, killCalls } = fakeTools();
    const out = await kill.handler({ pid: 512, signal: 'KILL' }, ctx);
    expect(out.isError).toBeUndefined();
    expect(killCalls).toEqual([[512, 'SIGKILL']]);
    expect(out.content).toContain('delivered');
  });

  it('defaults to SIGTERM when no signal is given', async () => {
    const { kill, killCalls } = fakeTools();
    await kill.handler({ pid: 512 }, ctx);
    expect(killCalls).toEqual([[512, 'SIGTERM']]);
  });

  it('translates ESRCH into a clear no-such-process message', async () => {
    const tools = makeProcessTools({
      killFn: () => {
        const e = new Error('kill ESRCH') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      },
    });
    const killTool = tools.find((t) => t.capability === 'sys.process.kill')!;
    const out = await killTool.handler({ pid: 424242 }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('no process');
  });
});

/**
 * The wiring these hang from: list must never exceed taint 1, kill must be
 * high risk — that is the matrix row "Shell / filesystem host / processi" and
 * the single-user shell rule applied to kill. A future edit that loosens the
 * declarations fails here.
 */
describe('process capabilities through the kernel', () => {
  const caps = new Map(processCapabilities.map((c) => [c.id, c]));
  const base = { capabilities: caps, matrix: POLICY_FLOOR, budgetExhausted: () => false };
  const owner = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;

  it('list is denied once the context is tainted to 2', () => {
    const decide = createDecide({ ...base, hardened: true });
    const d = decide({
      principal: owner,
      tenant: 'host',
      capability: 'sys.process.list',
      resource: { kind: 'none' },
      args: {},
      taint: 2,
    });
    expect(d).toMatchObject({ effect: 'deny', code: 'taint_exceeded' });
  });

  it('kill in single-user mode always asks — never a silent allow', () => {
    const decide = createDecide({ ...base, hardened: false });
    const d = decide({
      principal: owner,
      tenant: 'host',
      capability: 'sys.process.kill',
      resource: { kind: 'none' },
      args: { pid: 42, signal: 'TERM' },
      taint: 0,
    });
    expect(d.effect).toBe('ask');
  });

  it('a group member has no path to either', () => {
    const decide = createDecide({ ...base, hardened: true });
    const member = { kind: 'member', connector: 'telegram', tenantId: 'group:t:1', externalId: 'u' } as const;
    for (const capability of ['sys.process.list', 'sys.process.kill'] as const) {
      const d = decide({
        principal: member,
        tenant: 'group:t:1',
        capability,
        resource: { kind: 'none' },
        args: {},
        taint: 0,
      });
      expect(d).toMatchObject({ effect: 'deny', code: 'principal_forbidden' });
    }
  });
});
