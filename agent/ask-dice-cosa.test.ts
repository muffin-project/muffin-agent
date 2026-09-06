import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type ApprovalRequest, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';

/**
 * RETURN S3 (`slice/ask-dice-cosa`) — two claims, both about the human gate
 * staying real when a smaller model drives the loop:
 *
 * D12-min: an ASK shows the concrete action. For `resourceKind: 'none'`
 * capabilities (a shell command, a pid) the kernel's resource has nothing to
 * show, so the request derives it from the tool call's own arguments — the
 * owner approves «rm -rf /tmp/x in /tmp», never a bare capability name. The
 * request also carries the turn's taint, because "why am I being asked" is
 * half of the answer.
 *
 * E6: the per-turn ceiling bounds tool CALLS, not only model iterations —
 * nothing upstream limits how many tool_use blocks one completion emits, so a
 * single response carrying 20 calls must execute at most the profile's
 * `maxToolCallsPerTurn`, refusing the rest with an error the model can read.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  seen: string[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: {
    messages: { content: { type: string; text?: string; content?: string }[] }[];
  }): Promise<ChatResult> {
    for (const m of call.messages) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text) this.seen.push(b.text);
        if (b.type === 'tool_result' && b.content) this.seen.push(b.content);
      }
    }
    return this.script[this.i++] ?? answer('fine');
  }
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 'test' });

/**
 * An irreversible capability with no kernel resource: the shell shape, stubbed.
 *
 * `effect: 'host'` since ADR-0074 — the pair that produces an `ask` is now
 * `reversible: 'no'` plus a row that says irreversibility matters there, not
 * `risk: 'high'`. On the `context` row this stub would be allowed outright and
 * there would be no ASK left for D12 to inspect.
 */
const probeAct: CapabilityDecl = {
  id: 'probe.act',
  effect: 'host',
  risk: 'high',
  reversible: 'no',
  rerunnable: false,
  maxTaint: 2,
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};

/** A benign capability the kernel allows outright, for counting executions. */
const probePing: CapabilityDecl = {
  id: 'probe.ping',
  effect: 'context',
  risk: 'low',
  reversible: 'yes',
  rerunnable: true,
  maxTaint: 3,
  resourceKind: 'none',
  policyArgs: [],
  hostOnly: false,
};

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

function harness(
  script: ChatResult[],
  opts: { decls: CapabilityDecl[]; tools: RegisteredTool[]; maxToolCallsPerTurn?: number },
) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-ask-dice-cosa-'));
  const provider = new Scripted(script);
  const capabilities = new Map(opts.decls.map((d) => [d.id, d]));
  const deps: LoopDeps = {
    provider,
    profile:
      opts.maxToolCallsPerTurn === undefined
        ? CONSERVATIVE
        : { ...CONSERVATIVE, maxToolCallsPerTurn: opts.maxToolCallsPerTurn },
    model: 'test',
    tools: opts.tools,
    capabilities,
    // hardened: false, so a high-risk owner call at taint 0 is an ASK, never a
    // silent allow — the exact doorway D12 is about.
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: false }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return { deps, provider };
}

const actCall = (): ChatResult => ({
  text: null,
  toolCalls: [{ id: 'c1', name: 'probe_act', args: { command: 'rm -rf /tmp/x', cwd: '/tmp' } }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});

const actTool = (ran: { count: number }): RegisteredTool => ({
  capability: probeAct.id,
  spec: {
    name: 'probe_act',
    description: 'probe',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } } },
  },
  handler: () => {
    ran.count += 1;
    return { content: 'fatto', tier: 0 as const };
  },
  throwTier: 0,
});

describe('D12-min — the ASK shows the action, not only the capability name', () => {
  it('a none-resource capability derives the shown resource from the call arguments, with the turn taint', async () => {
    const ran = { count: 0 };
    const asked: ApprovalRequest[] = [];
    const { deps } = harness([actCall(), answer('fine')], { decls: [probeAct], tools: [actTool(ran)] });
    deps.approve = async (request) => {
      asked.push(request);
      return 'deny';
    };

    await runTurn(deps, { principal: owner, tenant: 'host', surface: 'cli', session: deps.sessions.open(), text: 'vai' });

    expect(asked).toHaveLength(1);
    expect(asked[0]!.resource).toContain('rm -rf /tmp/x');
    expect(asked[0]!.resource).toContain('/tmp');
    expect(asked[0]!.taint).toBe(0);
    expect(ran.count).toBe(0); // denied: never executed
  });

  it('with no approver on the surface, the visible ask text carries the action itself', async () => {
    const ran = { count: 0 };
    const { deps } = harness([actCall(), answer('mai')], { decls: [probeAct], tools: [actTool(ran)] });

    const result = await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: deps.sessions.open(),
      text: 'vai',
    });

    expect(result.stopped).toBe('ask');
    expect(result.text).toContain('rm -rf /tmp/x'); // what, not just which capability
    expect(ran.count).toBe(0);
  });
});

describe('E6 — the ceiling bounds tool calls, batch included', () => {
  it('a single response with 20 calls executes at most maxToolCallsPerTurn and refuses the rest, readably', async () => {
    const ran = { count: 0 };
    const batch: ChatResult = {
      text: null,
      toolCalls: Array.from({ length: 20 }, (_, i) => ({ id: `c${i + 1}`, name: 'probe_ping', args: {} })),
      stopReason: 'tool_use',
      usage,
      model: 'test',
    };
    const pingTool: RegisteredTool = {
      capability: probePing.id,
      spec: {
        name: 'probe_ping',
        description: 'probe',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: () => {
        ran.count += 1;
        return { content: 'pong', tier: 0 as const };
      },
      throwTier: 0,
    };
    const { deps, provider } = harness([batch, answer('fine')], {
      decls: [probePing],
      tools: [pingTool],
      maxToolCallsPerTurn: 5,
    });

    const result = await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: deps.sessions.open(),
      text: 'vai',
    });

    expect(ran.count).toBe(5); // the ceiling, not the batch size
    expect(result.stopped).toBe('answered'); // refusing is not crashing
    const refusals = provider.seen.filter((s) => s.includes('Tetto di 5 tool call'));
    expect(refusals.length).toBeGreaterThanOrEqual(1); // the model was told, readably
  });
});
