import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDecide } from '../core/policy/decide.js';
import { POLICY_FLOOR } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal, TrustTier } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { MemoryStore } from '../core/memory/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from './providers/types.js';

/**
 * The record, asserted through the loop rather than through the store.
 *
 * The store's own tests prove it *can* hold these things. What none of them can
 * prove is that a **turn** puts them there — which is the half this repo has
 * got wrong four separate times, and the reason `AGENTS.md` says to write the
 * test that fails without the wiring rather than the one that proves the logic.
 *
 * Three of the properties below fail silently when they are missing: a taint
 * rebuilt from the principal is a privilege escalation nobody sees, a lost
 * thinking block is a worse agent nobody attributes, and a call that may have
 * sent a message is indistinguishable from one that did not.
 *
 * The tests read the database directly, through the handle they opened
 * themselves. That is deliberate: asserting through the store's own reader
 * would let a wiring bug and a reader bug cancel out.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  readonly seen: ChatCall[] = [];
  constructor(
    private readonly script: ChatResult[],
    /** Runs at the moment of the call — for asserting what exists *by then*. */
    private readonly onCall?: () => void,
  ) {}
  async chat(request: ChatCall): Promise<ChatResult> {
    this.seen.push(request);
    this.calls += 1;
    this.onCall?.();
    return this.script[this.calls - 1] ?? answer('fine');
  }
}

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage, model: 'test' });
const callTool = (name: string, args: unknown = {}, id = 'c1'): ChatResult => ({
  text: null,
  toolCalls: [{ id, name, args }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});

const decls: CapabilityDecl[] = [
  { id: 'demo.read', effect: 'context', risk: 'low', reversible: 'yes', rerunnable: true, resourceKind: 'none', policyArgs: [], hostOnly: false },
  // The one that matters: not re-runnable, so a call left open is something
  // nobody may repeat on its own.
  { id: 'demo.send', effect: 'context', risk: 'low', reversible: 'no', rerunnable: false, resourceKind: 'none', policyArgs: [], hostOnly: false },
];

type TurnRow = { id: string; status: string; model: string; taint: number; turn_outcome: string | null };
type CallRow = { call_id: string; tool: string; rerunnable: number; ended_at: string | null; tier: number | null };

type Harness = {
  deps: LoopDeps;
  db: DatabaseCtor.Database;
  sessions: SessionStore;
  provider: Scripted;
  /** The rows, read through the test's own handle. */
  rows: () => TurnRow[];
  calls: () => CallRow[];
};

function harness(
  script: ChatResult[],
  over: { onCall?: () => void; tools?: RegisteredTool[]; db?: DatabaseCtor.Database } = {},
): Harness {
  const home = mkdtempSync(join(tmpdir(), 'muffin-turnrec-'));
  const db = over.db ?? new DatabaseCtor(':memory:');
  const provider = new Scripted(script, over.onCall);
  const sessions = new SessionStore(home);
  const deps: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'claude-opus-5',
    tools: over.tools ?? [],
    capabilities: new Map(decls.map((d) => [d.id, d])),
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions,
    turns: new TurnStore(db),
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin in un gruppo.' },
  };
  return {
    deps,
    db,
    sessions,
    provider,
    rows: () => db.prepare(`SELECT id, status, model, taint, turn_outcome FROM turns`).all() as TurnRow[],
    calls: () =>
      db.prepare(`SELECT call_id, tool, rerunnable, ended_at, tier FROM turn_tool_calls`).all() as CallRow[],
  };
}

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const input = (sessions: SessionStore, over: Record<string, unknown> = {}) => ({
  principal: owner,
  tenant: 'host',
  surface: 'cli',
  session: sessions.open('t1'),
  text: 'fai la cosa',
  ...over,
});

const readTool = (
  name = 'demo_read',
  // `tier: 0` on the fakes: these tools exist to exercise the turn record, and a
  // tier they do not need would make every one of these also a taint test.
  // `demo_web` below is the one that carries provenance, because that is its job.
  handler: RegisteredTool['handler'] = () => ({ content: 'letto', tier: 0 as const }),
  // `throwTier: 0` by default: every caller but one only exercises the return
  // path, where `tier` above already does the work. The one that throws
  // (`'closes when the handler throws'` below) passes a distinct value
  // explicitly, so asserting it there cannot pass by coincidence with a
  // mutation that collapses the recorded tier to a literal `0`.
  throwTier: TrustTier = 0,
): RegisteredTool => ({
  capability: 'demo.read',
  spec: { name, description: 'r', inputSchema: { type: 'object', properties: {} } },
  throwTier,
  handler,
});

describe('a turn writes its own record', () => {
  it('the row exists, running, before the model is asked anything', async () => {
    let atFirstCall: TurnRow[] = [];
    const h: Harness = harness([answer('ecco')], { onCall: () => (atFirstCall = h.rows()) });
    await runTurn(h.deps, input(h.sessions));
    // Not "a record was written at some point": by the time the provider is
    // asked, the row is already there and already says a live process owns it.
    // A record written afterwards is a log of what happened, which is exactly
    // what the design says a turn record must not be.
    expect(atFirstCall).toHaveLength(1);
    expect(atFirstCall[0]).toMatchObject({ status: 'running', model: 'claude-opus-5', turn_outcome: null });
  });

  it('carries the identity of the turn, and its id is the trace id', async () => {
    const h = harness([answer('ecco')]);
    const result = await runTurn(h.deps, input(h.sessions));
    expect(result.turnId).toBe(result.traceId);
    const row = h.deps.turns.get(result.turnId);
    expect(row).toMatchObject({
      tenant: 'host',
      surface: 'cli',
      sessionId: 't1',
      model: 'claude-opus-5',
      principal: owner,
      status: 'done',
      outcome: 'answered',
    });
  });

  it('pins the model the turn actually ran on', async () => {
    const h = harness([answer('ecco')]);
    h.deps.model = 'un-altro-modello';
    const result = await runTurn(h.deps, input(h.sessions));
    // The column exists so a resume onto a different model can be a refusal
    // rather than an attempt: thinking signatures belong to the model that made
    // them, and ADR-0037 records that sending them elsewhere fails silently.
    expect(h.deps.turns.get(result.turnId)?.model).toBe('un-altro-modello');
  });

  it('keeps the transcript, thinking blocks and signatures included', async () => {
    const thinking = { type: 'thinking' as const, thinking: 'ci penso', signature: 'sig-xyz' };
    const withThinking: ChatResult = { ...callTool('demo_read'), thinking: [thinking] };
    const h = harness([withThinking, answer('finito')], { tools: [readTool()] });
    const result = await runTurn(h.deps, input(h.sessions));
    const blocks = (h.deps.turns.get(result.turnId)?.messages ?? []).flatMap((m) => m.content);
    expect(blocks).toContainEqual(thinking);
    expect(blocks.find((b) => b.type === 'tool_use')).toMatchObject({ name: 'demo_read' });
  });

  it('records the taint the turn climbed to, which nothing else can reconstruct', async () => {
    const h = harness([callTool('demo_web'), answer('finito')], {
      tools: [readTool('demo_web', () => ({ content: 'contenuto dal web', tier: 3 as const }))],
    });
    const result = await runTurn(h.deps, input(h.sessions));
    // An owner turn starts at 0. Only what the turn read moves it, and only the
    // row remembers — `makeSnapshot`'s taint lives in a closure that dies with
    // the process, so a resume rebuilding it from `principal.kind` would hand a
    // turn that has already read the web the permissions of one that has not.
    expect(h.rows()[0]?.taint).toBe(3);
  });

  it('counts what the turn spent of each budget', async () => {
    const h = harness([callTool('demo_read'), answer('finito')], { tools: [readTool()] });
    const result = await runTurn(h.deps, input(h.sessions));
    expect(h.deps.turns.get(result.turnId)?.counters).toMatchObject({
      iterations: 2,
      toolCallsMade: 1,
      usage: { inputTokens: 20, outputTokens: 10 },
    });
  });

  it('records how the turn ended, not only that it ended', async () => {
    const h = harness([answer('mai chiesto')]);
    h.deps.budgetExhausted = () => true;
    const result = await runTurn(h.deps, input(h.sessions));
    // A turn that stopped on the budget is `done` with an outcome that says so
    // — never `interrupted`, which means "nobody knows how this ended".
    expect(result.stopped).toBe('budget');
    expect(h.rows()[0]).toMatchObject({ status: 'done', turn_outcome: 'budget' });
    expect(h.provider.calls).toBe(0);
  });

  it('carries the reply address of a surface that delivers out of band', async () => {
    const h = harness([answer('ecco')]);
    const result = await runTurn(h.deps, input(h.sessions, { replyTo: { chatId: 7, messageId: 9 } }));
    const row = h.deps.turns.get(result.turnId);
    expect(row?.replyTo).toEqual({ chatId: 7, messageId: 9 });
    // Pending until a surface says otherwise: the turn is done, the delivery is
    // a separate question with a separate answer.
    expect(row?.delivery).toBe('pending');
  });
});

describe('a tool call is recorded in two halves', () => {
  it('the intent is on disk before the handler can touch the world', async () => {
    let openWhileRunning: CallRow[] = [];
    const h: Harness = harness([callTool('demo_send'), answer('fatto')], {
      tools: [
        {
          capability: 'demo.send',
          spec: { name: 'demo_send', description: 's', inputSchema: { type: 'object', properties: {} } },
          throwTier: 0,
          handler: () => {
            // Read from inside the handler: this is the instant a real crash
            // lands, and the point is that the row already exists by then.
            openWhileRunning = h.calls();
            return { content: 'inviato', tier: 0 as const };
          },
        },
      ],
    });
    await runTurn(h.deps, input(h.sessions));
    expect(openWhileRunning).toHaveLength(1);
    // Copied from the declaration at call time, and `false` here is what stops
    // a resume from sending the same thing twice.
    expect(openWhileRunning[0]).toMatchObject({ tool: 'demo_send', rerunnable: 0, ended_at: null });
  });

  it('closes when the handler returns, so a finished call is never "maybe"', async () => {
    const h = harness([callTool('demo_read'), answer('fatto')], { tools: [readTool()] });
    const result = await runTurn(h.deps, input(h.sessions));
    expect(h.deps.turns.uncertainCalls(result.turnId)).toEqual([]);
    expect(h.calls()[0]?.ended_at).not.toBeNull();
  });

  it('closes when the handler throws — a call that came back is decided, and its tier is not lost', async () => {
    const h = harness([callTool('demo_read'), answer('fatto')], {
      tools: [
        readTool(
          'demo_read',
          () => {
            throw new Error('il tool è esploso');
          },
          3, // distinct from every other tier in this file, on purpose
        ),
      ],
    });
    const result = await runTurn(h.deps, input(h.sessions));
    // Otherwise every failed tool call would look like one that might still
    // have landed, and the "maybe" set would be noise instead of a signal.
    expect(h.deps.turns.uncertainCalls(result.turnId)).toEqual([]);
    // `agent/loop.ts`'s catch records `tier: tool.throwTier` on this same row
    // (ADR-0044) — nothing in this file read the column back before, so a
    // mutation collapsing that write to a literal `0` left the suite green.
    expect(h.calls()[0]).toMatchObject({ tool: 'demo_read', tier: 3 });
  });

  it('a call the kernel refused leaves no intent row: it never reached the world', async () => {
    const h = harness([callTool('demo_hidden'), answer('ok')], {
      tools: [
        {
          // Not in the declaration map at all, so the kernel denies it.
          capability: 'demo.unknown',
          spec: { name: 'demo_hidden', description: 'x', inputSchema: { type: 'object', properties: {} } },
          throwTier: 0,
          handler: () => ({ content: 'mai', tier: 0 as const }),
        },
      ],
    });
    await runTurn(h.deps, input(h.sessions));
    expect(h.calls()).toHaveLength(0);
  });
});

describe('when the record cannot be written', () => {
  it('the turn does not start: no model call, no episode, no session line', async () => {
    const db = new DatabaseCtor(':memory:');
    const h = harness([answer('non deve arrivare qui')], { db });
    const memoryDb = new DatabaseCtor(':memory:');
    const memory = new MemoryStore(memoryDb);
    h.deps.memory = { store: memory, recall: { store: memory } };
    const session = h.sessions.open('t-fail');
    // The database goes away under the store — the same shape as `Gateway.drain`
    // closing the handle, which is a measured crash in this repo rather than a
    // hypothetical one.
    db.close();

    await expect(
      runTurn(h.deps, { principal: owner, tenant: 'host', surface: 'cli', session, text: 'fai la cosa' }),
    ).rejects.toThrow();

    // Nothing was done, and that is the whole property: a turn whose record
    // cannot exist has not started, so whatever surface still holds the message
    // can deliver it again without anything having happened twice.
    expect(h.provider.calls).toBe(0);
    expect(h.sessions.read(session)).toEqual([]);
    expect(memory.pendingEpisodes('host', 1)).toEqual([]);
  });

  it('a checkpoint that fails mid-turn does not take the answer down with it', async () => {
    const db = new DatabaseCtor(':memory:');
    const h = harness([callTool('demo_read'), answer('risposta comunque')], {
      db,
      tools: [
        readTool('demo_read', () => {
          // Everything durable is gone from here on, the record included.
          db.close();
          return { content: 'letto', tier: 0 as const };
        }),
      ],
    });
    const result = await runTurn(h.deps, input(h.sessions));
    // The row is left stale and a later boot reclaims it as interrupted, which
    // is what an unwitnessed turn is. What must not happen is the owner losing
    // an answer the model already produced, over a bookkeeping write.
    expect(result.stopped).toBe('answered');
    expect(result.text).toBe('risposta comunque');
  });
});

describe('EFFECT WAL: an intent that cannot be written never reaches the handler', () => {
  /**
   * The DAY-1 EFFECT WAL invariant. Stubbed with `vi.spyOn` rather than closing the
   * database (as the block above does): only `startToolCall` fails here, so
   * the assertion is about the gate itself and not a side effect of the whole
   * store going away. The block above already proves the DB-wide case; this
   * one isolates the one write the invariant is actually about.
   */
  function toolResultOf(h: Harness, turnId: string): { content: string; isError?: boolean } | undefined {
    const blocks = (h.deps.turns.get(turnId)?.messages ?? []).flatMap((m) => m.content);
    return blocks.find((b) => b.type === 'tool_result') as { content: string; isError?: boolean } | undefined;
  }

  it('(a) a non-rerunnable tool: the handler never runs, and no row is left behind', async () => {
    const handler = vi.fn(() => ({ content: 'inviato', tier: 0 as const }));
    const h = harness([callTool('demo_send'), answer('capito')], {
      tools: [
        {
          capability: 'demo.send', // declared `rerunnable: false` in `decls` above
          spec: { name: 'demo_send', description: 's', inputSchema: { type: 'object', properties: {} } },
          throwTier: 0,
          handler,
        },
      ],
    });
    vi.spyOn(h.deps.turns, 'startToolCall').mockImplementation(() => {
      throw new Error('disco pieno');
    });

    const result = await runTurn(h.deps, input(h.sessions));

    expect(handler).not.toHaveBeenCalled();
    expect(h.calls()).toHaveLength(0); // no intent row, so nothing for endToolCall to have closed either
    expect(toolResultOf(h, result.turnId)).toMatchObject({ isError: true, content: expect.stringContaining('non eseguita') });
    // The refusal is information for the model, not a crash for the turn.
    expect(result.stopped).toBe('answered');
  });

  it('(b) a rerunnable tool: the same gate applies — one rule, not one per tool', async () => {
    const handler = vi.fn(() => ({ content: 'letto', tier: 0 as const }));
    const h = harness([callTool('demo_read'), answer('capito')], { tools: [readTool('demo_read', handler)] });
    vi.spyOn(h.deps.turns, 'startToolCall').mockImplementation(() => {
      throw new Error('disco pieno');
    });

    const result = await runTurn(h.deps, input(h.sessions));

    expect(handler).not.toHaveBeenCalled();
    expect(h.calls()).toHaveLength(0);
    expect(toolResultOf(h, result.turnId)).toMatchObject({ isError: true, content: expect.stringContaining('non eseguita') });
  });

  it('(c) the happy path is unchanged: intent written, handler runs, outcome closes it', async () => {
    const handler = vi.fn(() => ({ content: 'inviato', tier: 0 as const }));
    const h = harness([callTool('demo_send'), answer('fatto')], {
      tools: [
        {
          capability: 'demo.send',
          spec: { name: 'demo_send', description: 's', inputSchema: { type: 'object', properties: {} } },
          throwTier: 0,
          handler,
        },
      ],
    });

    await runTurn(h.deps, input(h.sessions));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(h.calls()).toHaveLength(1);
    expect(h.calls()[0]).toMatchObject({ tool: 'demo_send', rerunnable: 0 });
    expect(h.calls()[0]?.ended_at).not.toBeNull();
  });
});
