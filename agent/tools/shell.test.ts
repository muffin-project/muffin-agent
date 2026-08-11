import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { ExecResult } from '../../core/sandbox/executor.js';
import { makeShellTool, shellCapability } from './shell.js';

const ctx = { tenant: 'host', principal: { kind: 'owner', connector: 'cli', externalId: 'local' } } as const;

function fakeExec(result?: Partial<ExecResult>) {
  const calls: unknown[] = [];
  return {
    calls,
    run: async (req: unknown) => {
      calls.push(req);
      return {
        code: 0,
        stdout: 'out',
        stderr: '',
        truncated: false,
        timedOut: false,
        durationMs: 12,
        ...result,
      };
    },
  };
}

/**
 * Policy semantics for sys.shell, through the real kernel. The single-user row
 * is threat model §g: without OS-level prevention of RoT tampering, shell can
 * never be a silent allow — and this test fails if anyone re-declares the
 * capability below `high` risk, which is the wiring that rule hangs from.
 */
describe('sys.shell through the kernel', () => {
  const caps = new Map([[shellCapability.id, shellCapability]]);
  const base = { capabilities: caps, matrix: POLICY_FLOOR, budgetExhausted: () => false };
  const req = {
    tenant: 'host',
    capability: shellCapability.id,
    resource: { kind: 'none' },
    args: { command: 'ls' },
    taint: 0,
  } as const;

  it('single-user mode: always ask, never a silent allow', () => {
    const decide = createDecide({ ...base, hardened: false });
    const d = decide({ ...req, principal: ctx.principal });
    expect(d.effect).toBe('ask');
  });

  it('hardened mode, owner, taint 0: allow', () => {
    const decide = createDecide({ ...base, hardened: true });
    expect(decide({ ...req, principal: ctx.principal }).effect).toBe('allow');
  });

  it('taint 2 is over the ceiling whatever the mode', () => {
    const decide = createDecide({ ...base, hardened: true });
    const d = decide({ ...req, principal: ctx.principal, taint: 2 });
    expect(d).toMatchObject({ effect: 'deny', code: 'taint_exceeded' });
  });

  it('a group member has no path to it', () => {
    const decide = createDecide({ ...base, hardened: true });
    const d = decide({
      ...req,
      principal: { kind: 'member', connector: 'telegram', tenantId: 'group:t:1', externalId: 'u9' },
      tenant: 'group:t:1',
    });
    expect(d).toMatchObject({ effect: 'deny', code: 'principal_forbidden' });
  });

  it('an autonomous principal queues instead of auto-approving', () => {
    const decide = createDecide({ ...base, hardened: true });
    const d = decide({ ...req, principal: { kind: 'system', source: 'scheduler' } });
    expect(d.effect).toBe('ask');
  });
});

describe('shell_run argument boundary', () => {
  const root = join(tmpdir(), 'muffin-shell-root');

  it('rejects a missing command without reaching the executor', async () => {
    const exec = fakeExec();
    const tool = makeShellTool(exec, { root });
    const out = await tool.handler({}, ctx);
    expect(out.isError).toBe(true);
    expect(exec.calls.length).toBe(0);
  });

  it('rejects an out-of-range timeout without reaching the executor', async () => {
    const exec = fakeExec();
    const tool = makeShellTool(exec, { root });
    const out = await tool.handler({ command: 'ls', timeout_ms: 10 }, ctx);
    expect(out.isError).toBe(true);
    expect(exec.calls.length).toBe(0);
  });

  it('rejects a cwd that escapes the workspace', async () => {
    const exec = fakeExec();
    const tool = makeShellTool(exec, { root });
    const out = await tool.handler({ command: 'ls', cwd: '../../etc' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('escapes');
    expect(exec.calls.length).toBe(0);
  });

  it('passes the workspace as the write scope', async () => {
    const exec = fakeExec();
    const tool = makeShellTool(exec, { root });
    await tool.handler({ command: 'ls' }, ctx);
    expect(exec.calls[0]).toMatchObject({ command: 'ls', cwd: root, writeScope: [root] });
  });

  it('a timeout kill is reported as an incomplete run, not a result', async () => {
    const exec = fakeExec({ code: null, timedOut: true, durationMs: 1500, stdout: 'partial' });
    const tool = makeShellTool(exec, { root });
    const out = await tool.handler({ command: 'sleep 99' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('did not complete');
    expect(out.content).toContain('partial');
  });

  it('a non-zero exit is an error with stderr attached', async () => {
    const exec = fakeExec({ code: 2, stderr: 'boom' });
    const tool = makeShellTool(exec, { root });
    const out = await tool.handler({ command: 'false' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('exit 2');
    expect(out.content).toContain('boom');
  });
});
