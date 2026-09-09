import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import type { AttributeValue, SpanHandle } from '../../core/tracing/types.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { CONSERVATIVE } from '../profiles/profile.js';
import type { Message } from '../providers/types.js';
import { searchCapability, searchSpec } from '../tools/search.js';
import { checkpoint, closeRow, finish, reconcile, suspendHere, type TurnScope } from './durability.js';
import { makeSnapshot } from './permissions.js';
import { TurnRun } from './run-state.js';
import type { LoopDeps, RegisteredTool, ToolContext, TurnInput } from './types.js';

/**
 * Twin test for the `agent/loop/durability.ts` extraction (Fase A, fetta 7):
 * `checkpoint`, `suspendHere`, `reconcile`, `closeRecord`/`announceEnd`/`finish`
 * and `closeRow`, moved out of `guidaIlTurno`'s closure into a module that
 * receives a `TurnScope` instead.
 *
 * The three properties measured here are the ones the design names, and they
 * are all properties of the *durable row*, never of a spy:
 *
 *  - **`checkpoint` returns `true` only when the write landed.** A fenced-out
 *    write (someone else's claim on this row) returns `false`; a write that
 *    merely threw returns `true` and leaves the failure on the span, because a
 *    stale row is not a wrong row.
 *  - **`suspendHere` never swallows a failed `suspend`** (§4 inv. 6). The
 *    `/steer` corrections it drained are destructive — the connector's array is
 *    already empty — so they go back to the funnel via `recupero` before it
 *    falls through to `finish`, and the owner is told in the exact words.
 *  - **`reconcile`'s three states keep their meaning** (§4 inv. 6): *done*
 *    replays the recorded outcome and its tier, *maybe done* declares that the
 *    call may have landed instead of guessing either way, and *not started*
 *    goes through `runTool` so the kernel rules on it again.
 */

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

function recordingSpan(traceId: string): SpanHandle & {
  attrs: Record<string, AttributeValue>;
  ends: { status?: string; error?: unknown }[];
} {
  const attrs: Record<string, AttributeValue> = {};
  const ends: { status?: string; error?: unknown }[] = [];
  return {
    traceId,
    spanId: '0'.repeat(16),
    attrs,
    ends,
    setAttributes(next) {
      Object.assign(attrs, next);
    },
    end(outcome) {
      ends.push({ ...(outcome?.status === undefined ? {} : { status: outcome.status }), ...(outcome?.error === undefined ? {} : { error: outcome.error }) });
    },
  };
}

function freshCounters() {
  return {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 2,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: true,
  };
}

/**
 * A scope over a real `TurnStore` row, claimed exactly the way `drive` claims
 * one — the fencing token is the point of several of these cases, so a fake
 * store would test nothing.
 */
function harness(options: { messages?: Message[]; tools?: RegisteredTool[]; decls?: CapabilityDecl[] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-durability-'));
  const decls = options.decls ?? [];
  const tools = options.tools ?? [];
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const onTurnEnd: string[] = [];
  const deps: LoopDeps = {
    provider: undefined as never, // never reached: nothing here calls the model
    profile: CONSERVATIVE,
    model: 'test',
    tools,
    capabilities: new Map(decls.map((d) => [d.id, d])),
    decide: createDecide({
      matrix: POLICY_FLOOR,
      capabilities: new Map(decls.map((d) => [d.id, d])),
      budgetExhausted: () => false,
      hardened: true,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns,
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
    onTurnEnd: ({ stopped }) => {
      onTurnEnd.push(stopped);
    },
  };

  const id = 'a'.repeat(32);
  turns.enqueue({
    id,
    principal: owner,
    tenant: 'host',
    surface: 'cli',
    sessionId: 's1',
    model: 'test',
    messages: options.messages ?? [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
    taint: 0,
    counters: freshCounters(),
  });
  const record = turns.claim(id);
  if (record === null) throw new Error('claim fallita');

  const span = recordingSpan(id);
  const run = new TurnRun(record, { resumed: false, wokenFromWait: false });
  const snapshot = makeSnapshot(deps.decide, owner, 'host', 0);
  const steer: string[] = [];
  const recupero: string[] = [];
  const input: TurnInput = {
    principal: owner,
    tenant: 'host',
    surface: 'cli',
    session: { id: 's1', file: join(home, 's1.jsonl') },
    text: 'ciao',
    steer: () => steer.splice(0),
  };
  const toolContext: ToolContext = {
    tenant: 'host',
    principal: owner,
    turnId: record.id,
    sessionId: 's1',
    taint: () => snapshot.currentTaint(),
    intrinsicTaint: () => snapshot.intrinsicTaint(),
    suspend: (spec) => {
      run.barrier = spec;
    },
  };
  const echoes: { name: string }[] = [];
  const scope: TurnScope = {
    deps,
    record,
    turn: span,
    input,
    run,
    snapshot,
    recupero,
    exposed: tools,
    toolContext,
    noteSensitiveResourceEcho: (call) => {
      echoes.push({ name: call.name });
    },
  };
  /**
   * Another process's claim lands on this row. Written straight onto the
   * column rather than through `reclaim`, which only takes rows whose holder
   * is *dead* — this test's holder is very much alive, and the fact under test
   * is only "the token on the row is not the token in our hand".
   */
  const steal = (): void => {
    db.prepare('UPDATE turns SET claim_token = ? WHERE id = ?').run('un-altro-processo', id);
  };
  return { scope, deps, turns, record, span, run, snapshot, recupero, steer, onTurnEnd, echoes, id, steal };
}

describe('checkpoint reports true only when the write landed', () => {
  it('writes the live transcript and returns true', () => {
    const h = harness();
    h.run.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ecco' }] });
    h.run.iterations = 3;

    expect(checkpoint(h.scope)).toBe(true);

    const row = h.turns.get(h.id);
    expect(row?.messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'ecco' }] });
    expect(row?.counters.iterations).toBe(3);
  });

  /**
   * The fenced case, and the only one that may return `false`. Another process
   * reclaiming the row mints a new `claimToken`, so this scope's token is stale
   * — the write changes nothing, and every caller in `guidaIlTurno` reads that
   * `false` as "stop, you no longer own this row".
   */
  it('returns false when another claim owns the row, and does not overwrite it', () => {
    const h = harness();
    h.steal();
    expect(h.turns.get(h.id)?.claimToken).not.toBe(h.record.claimToken);

    h.run.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'non deve atterrare' }] });

    expect(checkpoint(h.scope)).toBe(false);
    expect(JSON.stringify(h.turns.get(h.id)?.messages)).not.toContain('non deve atterrare');
  });

  /**
   * A throw is a *different fact* from a fenced write and is deliberately not
   * reported as one: `Gateway.drain` closing the database under a long turn
   * leaves a stale row, which the next checkpoint overwrites. Taking the turn
   * down for it would be the worse failure — but it is not silent either, and
   * the span attribute is where "the record stopped being written" is visible.
   */
  it('swallows a thrown write, returns true, and leaves the failure on the span', () => {
    const h = harness();
    h.deps.turns.checkpoint = () => {
      throw new Error('database is closed');
    };

    expect(checkpoint(h.scope)).toBe(true);
    expect(h.span.attrs['muffin.turn.record_error']).toBe('database is closed');
  });
});

describe('suspendHere does not swallow a failed suspend', () => {
  const spec = { wakeAt: new Date(Date.now() + 60_000).toISOString(), waitFor: null };

  it('persists the pending /steer correction into the row it is about to write', () => {
    const h = harness();
    h.steer.push('anzi, fermati alle 9');

    const out = suspendHere(h.scope, spec);

    expect(out.stopped).toBe('suspended');
    expect(h.recupero).toEqual([]);
    const row = h.turns.get(h.id);
    expect(row?.status).toBe('waiting');
    expect(JSON.stringify(row?.messages)).toContain('anzi, fermati alle 9');
    // The live array is not mutated: the correction goes onto the copy that is
    // written, so the failing branch below cannot leave it on an array nobody
    // wrote.
    expect(JSON.stringify(h.run.messages)).not.toContain('anzi, fermati alle 9');
  });

  /**
   * The mutation this case exists to catch: a `suspendHere` that ignored the
   * `false` from `TurnStore.suspend` would return `stopped: 'suspended'` for a
   * row that never became `waiting` — a wake-up promised to a caller that
   * nothing will ever deliver — and the correction it already drained out of
   * the connector's array would be gone with it.
   */
  it('hands the drained correction back to the funnel and finishes, saying so', () => {
    const h = harness();
    h.steer.push('anzi, fermati alle 9');
    h.deps.turns.suspend = () => false;

    const out = suspendHere(h.scope, spec);

    expect(out.stopped).toBe('error');
    expect(out.text).toBe(
      'Volevo sospendermi e aspettare, ma non sono riuscito a salvare lo stato del turno: ' +
        'se aspettassi comunque non mi sveglierebbe nessuno. Mi fermo qui e te lo dico.',
    );
    expect(h.recupero).toEqual(['anzi, fermati alle 9']);
    expect(h.turns.get(h.id)?.status).toBe('done');
  });

  it('does the same when the suspend write throws instead of returning false', () => {
    const h = harness();
    h.steer.push('anzi, fermati alle 9');
    h.deps.turns.suspend = () => {
      throw new Error('database is closed');
    };

    const out = suspendHere(h.scope, spec);

    expect(out.stopped).toBe('error');
    expect(h.recupero).toEqual(['anzi, fermati alle 9']);
    expect(h.span.attrs['muffin.turn.record_error']).toBe('database is closed');
  });
});

describe('reconcile keeps the three states of the two-phase tool record', () => {
  const decl: CapabilityDecl = { ...searchCapability, hostOnly: false };
  function tool(onCall: () => void): RegisteredTool {
    return {
      capability: decl.id,
      spec: searchSpec,
      handler: () => {
        onCall();
        return { content: 'risultato fresco', tier: 0 as const };
      },
      throwTier: 2,
    };
  }
  const batch: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'cerca' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: searchSpec.name, input: { query: 'x' } }] },
  ];

  it('done: replays the recorded outcome and its tier, without calling the handler', async () => {
    let called = 0;
    const h = harness({ messages: batch, tools: [tool(() => (called += 1))], decls: [decl] });
    h.turns.startToolCall(h.record.id, {
      callId: 'c1',
      tool: searchSpec.name,
      capability: decl.id,
      rerunnable: true,
      args: { query: 'x' },
      effect: { row: 'host', reversible: 'yes', resource: null, decision: 'allow' },
    });
    h.turns.endToolCall(h.record.id, 'c1', { content: 'quello di prima', isError: false, tier: 2 });

    expect(await reconcile(h.scope)).toBeNull();
    expect(called).toBe(0);
    const repaired = h.run.messages.at(-1);
    expect(repaired?.content).toEqual([{ type: 'tool_result', toolCallId: 'c1', content: 'quello di prima' }]);
    // The tier comes back with the content, or a turn that had read the web
    // would resume believing it had not.
    expect(h.snapshot.currentTaint()).toBe(2);
  });

  it('maybe done: a non-rerunnable open call is declared, not re-run and not assumed', async () => {
    let called = 0;
    const h = harness({ messages: batch, tools: [tool(() => (called += 1))], decls: [decl] });
    h.turns.startToolCall(h.record.id, {
      callId: 'c1',
      tool: searchSpec.name,
      capability: decl.id,
      rerunnable: false,
      args: { query: 'x' },
      effect: { row: 'host', reversible: 'yes', resource: null, decision: 'allow' },
    });

    expect(await reconcile(h.scope)).toBeNull();
    expect(called).toBe(0);
    const block = (h.run.messages.at(-1)?.content ?? [])[0];
    expect(block).toMatchObject({ type: 'tool_result', toolCallId: 'c1', isError: true });
    expect(String((block as { content: string }).content)).toContain('non è possibile sapere se ha avuto effetto');
  });

  it('not started: neither row, so the call goes through runTool and the kernel again', async () => {
    let called = 0;
    const h = harness({ messages: batch, tools: [tool(() => (called += 1))], decls: [decl] });

    expect(await reconcile(h.scope)).toBeNull();
    expect(called).toBe(1);
    // Through `runTool` and nowhere else: the intent row exists because that is
    // the only path that writes one.
    expect(h.turns.recordedOutcomes(h.record.id).has('c1')).toBe(true);
    expect(h.echoes).toEqual([{ name: searchSpec.name }]);
  });

  it('leaves a transcript that is not a dangling batch alone', async () => {
    const h = harness();
    expect(await reconcile(h.scope)).toBeNull();
    expect(h.run.messages).toHaveLength(1);
  });

  /**
   * The repair may itself have run tool calls with real effects, so a claim
   * discovered lost at its final checkpoint has nothing left to do but stop and
   * say so — the same shape every checkpoint in the main loop has.
   */
  it('stops with the honest lost-claim result when its own checkpoint is fenced out', async () => {
    const h = harness({ messages: batch, tools: [tool(() => {})], decls: [decl] });
    h.turns.startToolCall(h.record.id, {
      callId: 'c1',
      tool: searchSpec.name,
      capability: decl.id,
      rerunnable: false,
      args: { query: 'x' },
      effect: { row: 'host', reversible: 'yes', resource: null, decision: 'allow' },
    });
    h.steal();

    const out = await reconcile(h.scope);
    expect(out?.stopped).toBe('error');
    expect(out?.text).toBe('');
    expect(h.span.attrs['muffin.turn.lost_claim']).toBe(true);
  });
});

describe('finish writes the row before it ends the span or wakes the lane', () => {
  it('closes the row, ends the span, and announces the end once', () => {
    const h = harness();
    h.run.iterations = 2;

    const out = finish(h.scope, 'answered', 'ecco');

    expect(out).toMatchObject({ text: 'ecco', stopped: 'answered', iterations: 2, turnId: h.id });
    expect(h.turns.get(h.id)?.outcome).toBe('answered');
    expect(h.span.ends).toEqual([{ status: 'ok' }]);
    expect(h.onTurnEnd).toEqual(['answered']);
  });

  /**
   * Fenced out: the row does not say what `stopped`/`text` claim, so neither may
   * be returned — and the background lane is *not* told, because the process
   * that owns the row now is the one whose job that is.
   */
  it('returns nothing it cannot prove when the claim is gone, and stays quiet', () => {
    const h = harness();
    h.steal();

    const out = finish(h.scope, 'answered', 'ecco');

    expect(out.text).toBe('');
    expect(out.stopped).toBe('error');
    expect(h.span.attrs['muffin.turn.lost_claim']).toBe(true);
    expect(h.onTurnEnd).toEqual([]);
  });
});

describe('closeRow closes a row from outside the engine', () => {
  /**
   * The two pre-engine refusals (`model_changed`, `resumes_exhausted`) have no
   * transcript to write and no counters to advance. What they must leave behind
   * is a row that stops being picked up *and* a reason the owner can read —
   * "the turn ended" rather than "the turn vanished".
   */
  it('writes the reason into the transcript and stops the row being picked up', () => {
    const h = harness();

    closeRow(h.deps, h.span, h.record, 'error', 'il modello è cambiato: non riprendo');

    const row = h.turns.get(h.id);
    expect(row?.outcome).toBe('error');
    expect(row?.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'il modello è cambiato: non riprendo' }],
    });
    // No counters advanced: the refusal did not run anything.
    expect(row?.counters.iterations).toBe(0);
  });

  it('does not throw when the write does, and leaves the failure on the span', () => {
    const h = harness();
    h.deps.turns.finish = () => {
      throw new Error('database is closed');
    };

    expect(() => closeRow(h.deps, h.span, h.record, 'error', 'niente')).not.toThrow();
    expect(h.span.attrs['muffin.turn.record_error']).toBe('database is closed');
  });
});
