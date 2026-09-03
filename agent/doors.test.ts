import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../core/memory/store.js';
import { createDecide } from '../core/policy/decide.js';
import { memoryWriteCapability, replyCapability } from '../core/policy/doors.js';
import { POLICY_FLOOR, ROW_FLOOR, type PolicyMatrix } from '../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../core/policy/types.js';
import { SessionStore } from '../core/session/store.js';
import { TurnStore } from '../core/turns/store.js';
import { TodoStore } from '../core/turns/todo.js';
import { JsonlExporter, SimpleTracer } from '../core/tracing/tracer.js';
import type { Span } from '../core/tracing/types.js';
import { runTurn, type LoopDeps, type RegisteredTool } from './loop.js';
import { CONSERVATIVE } from './profiles/profile.js';
import type { ChatResult, Provider } from './providers/types.js';
import { fsCapabilities, makeFsTools, type FsScope } from './tools/fs.js';

/**
 * The two doors, through a real turn (ADR-0055).
 *
 * `agent/loop.ts` used to walk through both without asking anyone: the reply
 * left through the surface with no decision taken, and the episode was written
 * straight from the loop and merely stamped with a tier. The threat model's
 * matrix had a row for each (`reply`, `memory`) and the kernel executed those
 * rows for every capability except the two the rows were written about.
 *
 * The claim these tests carry is deliberately narrow, and the first test is the
 * half that proves it: **nothing is newly forbidden**. Under the shipped floor a
 * turn that has read a file still answers, still remembers, and now leaves a
 * `muffin.policy_decision` behind for both acts. The second and third tests are
 * the half that proves the decision is *load-bearing*: a matrix that tightens
 * the row — the only thing a sealed `rot/policy.json` can do to it
 * (`matrix.ts`, `tighterRows`) — actually stops the reply and actually stops
 * the write.
 *
 * The kernel is the real one and so is the loop: no fake `decide`, no fake
 * store, no assertion on an internal field. The questions are the two an owner
 * would ask — did the words reach me, is the episode on disk.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  /** How many times the model was actually asked — a refused round never gets here. */
  calls = 0;
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    this.calls += 1;
    return this.script[this.i++] ?? {
      text: 'fine',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: 'test',
    };
  }
}

let callId = 0;
const callTool = (name: string, args: unknown): ChatResult => ({
  text: null,
  toolCalls: [{ id: `d${(callId += 1)}`, name, args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});
const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

/**
 * The sentence the second round would say. It appears in exactly one place a
 * refused turn could leak it — the delta stream and the result — so a test that
 * greps for it is asking the owner's own question: did those words reach me?
 */
const SECOND_ROUND = 'MUFFIN-DOORS-SECONDA-RISPOSTA';

const decls: readonly CapabilityDecl[] = fsCapabilities;

function harness(script: ChatResult[], matrix: PolicyMatrix = POLICY_FLOOR) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-doors-'));
  const work = mkdtempSync(join(tmpdir(), 'muffin-doors-work-'));
  writeFileSync(join(work, 'nota.md'), 'una nota qualunque, letta da disco', 'utf8');

  const scope: FsScope = { root: work, denyWrite: [], denyRead: [] };
  const tools: RegisteredTool[] = [...makeFsTools(scope)];
  const capabilities = new Map(decls.map((d) => [d.id, d]));
  // Real store, real DDL: the assertion is "is there a row", and a fake would
  // answer for the loop instead of letting it answer.
  const store = new MemoryStore(new DatabaseCtor(':memory:'));
  const deltas: string[] = [];

  const deps: LoopDeps = {
    provider: new Scripted(script),
    profile: CONSERVATIVE,
    model: 'test',
    tools,
    capabilities,
    // The doors are NOT in `capabilities`: the kernel owns them
    // (`core/policy/decide.ts`), and a harness that had to remember to declare
    // them would be testing its own memory instead of production's.
    decide: createDecide({
      matrix,
      capabilities,
      budgetExhausted: () => false,
      hardened: true,
      egressAllowed: () => false,
    }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns: new TurnStore(new DatabaseCtor(':memory:')),
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    memory: { store, recall: { store } },
    budgetExhausted: () => false,
    approve: async () => 'allow',
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };
  /** Every span the exporter actually wrote — the trace an owner would read, not an in-memory double. */
  const spans = (): Span[] =>
    readdirSync(join(home, 'traces')).flatMap((f) =>
      readFileSync(join(home, 'traces', f), 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Span),
    );
  /** Both rows of the exchange, user and agent. `extraction_v` is 0 on a fresh write. */
  const episodes = () => store.pendingEpisodes('host', 1, 100);
  return { deps, home, spans, episodes, deltas, provider: deps.provider as Scripted };
}

/** A matrix that differs from the shipped floor in exactly one row. */
const tightened = (row: 'reply' | 'memory', policy: { askAbove: number; denyAbove: number }): PolicyMatrix => ({
  ...POLICY_FLOOR,
  rows: { ...ROW_FLOOR, [row]: policy },
});

/** The read → answer script every test below runs, so the matrix is the only variable. */
const script = () => [callTool('fs_read', { path: 'nota.md' }), answer(SECOND_ROUND)];

describe('le due porte, sotto la matrice spedita', () => {
  it('un turno che ha letto un file risponde, ricorda, e lascia una decisione per entrambe', async () => {
    const h = harness(script());

    const result = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('porte-1'),
      text: 'leggi nota.md e dimmi cosa dice',
      onDelta: (d) => {
        if (d.type === 'text') h.deltas.push(d.text);
      },
    });

    // Nothing is newly forbidden. The read raised the turn to 2 and the answer
    // still came out — this is the whole "semantics unchanged" claim, executed.
    expect(result.stopped).toBe('answered');
    expect(result.taint).toBe(2);
    expect(result.text).toBe(SECOND_ROUND);
    // …and both halves of the exchange are on disk, at the tier of who said them.
    expect(h.episodes().map((e) => e.role)).toEqual(['user', 'agent']);

    // The decision exists, in the same vocabulary a tool call's does.
    const decisions = h
      .spans()
      .filter((s) => s.name === 'muffin.policy_decision')
      .map((s) => ({
        capability: s.attributes['muffin.capability'],
        effect: s.attributes['muffin.policy.effect'],
      }));
    expect(decisions).toContainEqual({ capability: replyCapability.id, effect: 'allow' });
    expect(decisions).toContainEqual({ capability: memoryWriteCapability.id, effect: 'allow' });
  });
});

describe('una riga stretta sulla porta della risposta', () => {
  /**
   * `denyAbove: 1` on the `reply` row — the one move a sealed `rot/policy.json`
   * is allowed to make on it. Round 1 is decided at taint 0 and runs; the read
   * raises the turn to 2; round 2 is decided at 2 and refused, **before** the
   * model is asked, because a decision taken after the call would be taken
   * about bytes already streaming onto the owner's screen.
   */
  it('lascia girare il primo giro e trattiene il secondo, prima che il modello parli', async () => {
    const h = harness(script(), tightened('reply', { askAbove: 3, denyAbove: 1 }));

    const result = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('porte-2'),
      text: 'leggi nota.md e dimmi cosa dice',
      onDelta: (d) => {
        if (d.type === 'text') h.deltas.push(d.text);
      },
    });

    // The first round really ran: the tool call happened and the turn is tainted.
    expect(result.taint).toBe(2);
    // The second round's words exist nowhere — not in the stream, not in the
    // result. They were never even generated: the model was asked once.
    expect(h.provider.calls).toBe(1);
    expect(h.deltas.join('')).not.toContain(SECOND_ROUND);
    expect(result.text).not.toContain(SECOND_ROUND);
    // What the owner reads instead is the kernel's own sentence, and the turn
    // ended the way the policy told it to rather than as an error.
    expect(result.text).toMatch(/trattenuta dal kernel/);
    expect(result.stopped).toBe('answered');
    // …and the trace says which row closed, not merely that something did.
    const turnSpan = h.spans().find((s) => s.name === 'muffin.turn');
    expect(turnSpan?.attributes['muffin.reply.refused']).toBe('taint_exceeded');
  });
});

describe('una riga stretta sulla porta della memoria', () => {
  /**
   * `denyAbove: -1` — refused at every taint, including 0. The turn still
   * answers: the two doors are independent, and an owner who does not want this
   * install to remember has not asked it to stop talking.
   */
  it('il turno risponde lo stesso e non scrive nessun episodio', async () => {
    const h = harness(script(), tightened('memory', { askAbove: 3, denyAbove: -1 }));

    const result = await runTurn(h.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session: h.deps.sessions.open('porte-3'),
      text: 'leggi nota.md e dimmi cosa dice',
    });

    expect(result.stopped).toBe('answered');
    expect(result.text).toBe(SECOND_ROUND);
    // Not one row: neither the owner's line nor the agent's.
    expect(h.episodes()).toEqual([]);
    // An episode that was not written is a fact about the turn, not a silence.
    const turnSpan = h.spans().find((s) => s.name === 'muffin.turn');
    expect(turnSpan?.attributes['muffin.memory.write_refused']).toBe('taint_exceeded');
  });
});
