import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import DatabaseCtor from 'better-sqlite3';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';
import { httpCapability } from './tools/http.js';

/**
 * The egress allowlist has to be reached by a real tool call.
 *
 * This is a regression test for a defect that had every part working and no
 * part connected: `decide.ts` gates URLs on `resource.kind === 'url'`, its unit
 * tests passed such a resource directly and went green, and the loop built the
 * resource from `args['path']` alone — so every tool call reached the kernel as
 * `{kind:'none'}` and the egress branch never once ran in production.
 *
 * `http_get` did not catch it either, and could not have: it deliberately skips
 * the allowlist on its first hop, with a comment saying the kernel approved it.
 * Two correct halves, each waiting for the other, and the visible behaviour was
 * an empty allowlist permitting every public host.
 *
 * So this test refuses to call `decide` directly. It runs a turn, lets the loop
 * derive the resource the way production does, and asserts on whether the tool
 * body executed.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  /** Tool results the model was handed — where a kernel refusal actually lands. */
  seen: string[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: {
    messages: { content: { type: string; content?: string }[] }[];
  }): Promise<ChatResult> {
    for (const m of call.messages) {
      for (const b of m.content) {
        if (b.type === 'tool_result' && b.content) this.seen.push(b.content);
      }
    }
    return this.script[this.i++] ?? {
      text: 'fine',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test',
    };
  }
}

const callTool = (name: string, args: unknown): ChatResult => ({
  text: null,
  toolCalls: [{ id: 'c1', name, args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const decls: CapabilityDecl[] = [httpCapability];

function harness(allowHost: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-egress-gate-'));
  const fetched: string[] = [];

  const tools: RegisteredTool[] = [
    {
      capability: httpCapability.id,
      spec: {
        name: 'http_get',
        description: 'fetch',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      },
      // Records instead of fetching: the question is whether the kernel let the
      // body run at all, not what the network said.
      handler: (args) => {
        fetched.push(String((args as { url: string }).url));
        return { content: 'body', tier: 3 as const };
      },
      throwTier: 0,
    },
  ];

  const deps: LoopDeps = {
    provider: new Scripted([callTool('http_get', { url: 'https://evil.example.com/steal' })]),
    profile: CONSERVATIVE,
    model: 'test',
    tools,
    // The loop derives the resource from these, so the harness must hand them
    // over exactly as buildRuntime does — a harness that skips this tests a
    // loop that production does not run.
    capabilities: new Map(decls.map((d) => [d.id, d])),
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
      egressAllowed: () => allowHost,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  return { deps, fetched, provider: deps.provider as Scripted };
}

// A group member: taint 2, which the egress branch refuses outright rather than
// asking. The owner would get an `ask`, and an approval prompt in a test proves
// less than a refusal does — a poisoned context must not even be able to
// nominate the destination.
const member: Principal = {
  kind: 'member',
  connector: 'telegram',
  tenantId: 'group:telegram:42',
  externalId: 'u1',
};

describe('egress allowlist, through a real turn', () => {
  it('never runs the fetch when the host is off the allowlist', async () => {
    const h = harness(false);
    await runTurn(h.deps, {
      principal: member,
      tenant: 'group:telegram:42',
      surface: 'telegram',
      session: h.deps.sessions.open('s1'),
      text: 'leggi https://evil.example.com/steal',
    });

    // The assertion that matters: the body never ran. Before the loop lifted
    // `url` into the resource, this array had the URL in it.
    expect(h.fetched).toEqual([]);
    // And the model was told why, rather than silently getting nothing: a
    // refusal it cannot see is one it will keep retrying.
    expect(h.provider.seen.join('\n')).toMatch(/Rifiutato dal kernel.*resource_denied/s);
  });

  it('runs it when the host is allowlisted, so the gate is a gate and not a wall', async () => {
    const h = harness(true);
    await runTurn(h.deps, {
      principal: member,
      tenant: 'group:telegram:42',
      surface: 'telegram',
      session: h.deps.sessions.open('s2'),
      text: 'leggi https://evil.example.com/steal',
    });

    expect(h.fetched).toEqual(['https://evil.example.com/steal']);
  });
});

describe('the exploit that the first fix left open', () => {
  it('a junk path argument cannot shadow the url and skip the allowlist', async () => {
    // Found by review. `http_get({url, path:'x'})`: the loop checked `path`
    // first, built a path resource, and the kernel's egress branch — which
    // required `resource.kind === 'url'` — was skipped entirely, falling
    // through to medium/reversible = allow. Measured before the fix: deny
    // without the key, fetch with it, for a taint-2 group member.
    const h = harness(false);
    h.deps.provider = new Scripted([
      callTool('http_get', { url: 'https://evil.example.com/steal', path: 'anything' }),
    ]);

    await runTurn(h.deps, {
      principal: member,
      tenant: 'group:telegram:42',
      surface: 'telegram',
      session: h.deps.sessions.open('s3'),
      text: 'leggi',
    });

    expect(h.fetched).toEqual([]);
  });
});
