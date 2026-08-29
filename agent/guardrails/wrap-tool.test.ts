import { describe, expect, it } from 'vitest';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { RegisteredTool, ToolContext } from '../loop.js';
import { ToolLoopGuardrail } from './tool-loop.js';
import { withToolLoopGuardrail } from './wrap-tool.js';

const ctx: ToolContext = {
  tenant: 'host',
  principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
  turnId: 'turn-1',
  sessionId: 'session-1',
  taint: () => 0,
  suspend: () => {},
};

const readDecl: CapabilityDecl = {
  id: 'test.read',
  risk: 'low',
  reversible: 'yes',
  rerunnable: true,
  progress: 'idempotent_read',
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: true,
};

function tool(handler: RegisteredTool['handler']): RegisteredTool {
  return {
    capability: 'test.read',
    spec: { name: 'test_read', description: 'test', inputSchema: { type: 'object', properties: {} } },
    throwTier: 0,
    handler,
  };
}

describe('withToolLoopGuardrail', () => {
  it('injects a model-visible warning on the second identical idempotent result', async () => {
    const wrapped = withToolLoopGuardrail(
      tool(() => ({ content: 'same fact', tier: 0 })),
      readDecl,
      new ToolLoopGuardrail(),
    );

    expect((await wrapped.handler({ q: 'a' }, ctx)).content).toBe('same fact');
    const second = await wrapped.handler({ q: 'b' }, ctx);
    expect(second.content).toContain('same fact');
    expect(second.content).toContain('[guardrail: no progress]');
  });

  it('does not infer idempotent-read semantics from rerunnable/reversible alone', async () => {
    const { progress: _progress, ...plainDecl } = readDecl;
    const withoutProgress: CapabilityDecl = { ...plainDecl, id: 'test.effect' };
    const wrapped = withToolLoopGuardrail(
      tool(() => ({ content: 'same receipt', tier: 0 })),
      withoutProgress,
      new ToolLoopGuardrail(),
    );

    expect((await wrapped.handler({}, ctx)).content).toBe('same receipt');
    expect((await wrapped.handler({}, ctx)).content).toBe('same receipt');
  });

  it('keeps retry metadata and provenance unchanged when it adds a warning', async () => {
    const wrapped = withToolLoopGuardrail(
      tool(() => ({ content: '503', tier: 3, isError: true, retryable: true })),
      readDecl,
      new ToolLoopGuardrail(),
    );

    await wrapped.handler({ q: 'x' }, ctx);
    const second = await wrapped.handler({ q: 'x' }, ctx);
    expect(second.tier).toBe(3);
    expect(second.isError).toBe(true);
    expect(second.retryable).toBe(true);
    expect(second.content).toContain('[guardrail: no progress]');
  });

  it('preserves thrown failures as cause and appends only the warning text', async () => {
    const original = new Error('backend broke');
    const wrapped = withToolLoopGuardrail(
      tool(() => {
        throw original;
      }),
      readDecl,
      new ToolLoopGuardrail(),
    );

    await expect(wrapped.handler({}, ctx)).rejects.toBe(original);
    try {
      await wrapped.handler({}, ctx);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('backend broke');
      expect((error as Error).message).toContain('[guardrail: no progress]');
      expect((error as Error).cause).toBe(original);
    }
  });
});
