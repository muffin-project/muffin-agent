import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import type { CapabilityDecl, Principal } from '../../core/policy/types.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { TurnStore } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import { continueTurn, type LoopDeps, resolveContinuation, resumeTurn, runTurn } from '../loop.js';
import { CONSERVATIVE } from '../profiles/profile.js';
import {
  type ChatCall,
  type ChatResult,
  type Provider,
} from '../providers/types.js';
import { searchCapability, searchSpec } from '../tools/search.js';

/**
 * Incident A (Telegram 2026-09-18, turn ecba5616) as a regression probe.
 *
 * Useful work (file reads, env discovery) checkpoints durably, then the
 * provider stalls: consecutive completed-but-empty `stop=error` responses
 * with zero tokens and no activity. The lease must end as `continuable`
 * with a truthful diagnostic — never as terminal `done/error` with a
 * generic sentence, which is what stranded the real turn and forced the
 * owner to watch the same discovery recomputed from scratch.
 *
 * Written RED-first: before the B3 routing exists, the turn finishes
 * `done/error` and both status assertions fail.
 */

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };
const NOW = () => new Date('2026-09-18T17:01:51.000Z');
const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const someUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The 30s upstream stall wearing a success shape. */
const stall = (): ChatResult => ({
  text: null,
  toolCalls: [],
  stopReason: 'error',
  usage: zeroUsage,
  model: 'test-model',
});

function calls(name: string, id: string, args: unknown = {}): ChatResult {
  return { text: null, toolCalls: [{ id, name, args }], stopReason: 'tool_use', usage: someUsage, model: 'test-model' };
}

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: ChatCall[] = [];
  private i = 0;
  constructor(private readonly script: (ChatResult | Error)[]) {}
  async chat(request: ChatCall): Promise<ChatResult> {
    this.seen.push(request);
    const next = this.script[this.i++];
    if (next === undefined) throw new Error('lo script è finito');
    if (next instanceof Error) throw next;
    return next;
  }
}

function readTool(
  callsByPath: Map<string, number>,
  contentFor: (path: string) => string = (path) => `contenuto di ${path}`,
): { tool: LoopDeps['tools'][number]; decl: CapabilityDecl } {
  const decl: CapabilityDecl = { ...searchCapability, id: 'sys.fs_read', hostOnly: false };
  return {
    decl,
    tool: {
      capability: decl.id,
      spec: {
        ...searchSpec,
        name: 'fs_read',
        description: 'legge un file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      handler: (args) => {
        const path = ((args ?? {}) as Record<string, unknown>).path;
        if (typeof path === 'string') callsByPath.set(path, (callsByPath.get(path) ?? 0) + 1);
        return { content: contentFor(String(path)), tier: 2 };
      },
      throwTier: 0,
    },
  };
}

function world(
  script: (ChatResult | Error)[],
  callsByPath: Map<string, number>,
  profile = CONSERVATIVE,
  contentFor: (path: string) => string = (path) => `contenuto di ${path}`,
) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-incident-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const sessions = new SessionStore(home);
  const capabilities = new Map();
  const { tool, decl } = readTool(callsByPath, contentFor);
  capabilities.set(decl.id, decl);
  const provider = new Scripted(script);
  const deps: LoopDeps = {
    provider,
    profile,
    model: 'test-model',
    tools: [tool],
    capabilities,
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: true }),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions,
    turns,
    todos: new TodoStore(db),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
    now: NOW,
  };
  return { deps, turns, sessions, provider };
}

describe('Incident A · useful work then provider stalls', () => {
  it('the lease ends continuable with a truthful diagnostic, not done/error', async () => {
    const reads = new Map<string, number>();
    const w = world(
      [
        // `query` soddisfa il gate sui parametri della capability (che resta
        // quella di search, già provata), `path` è ciò che l'handler conta.
        calls('fs_read', 'c1', { query: 'muffin_thought.py', path: 'muffin_thought.py' }),
        calls('fs_read', 'c2', { query: 'make-music.py', path: 'make-music.py' }),
        stall(),
        stall(),
        stall(),
        stall(),
        stall(),
      ],
      reads,
    );
    const session = w.sessions.open('owner');

    const r = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'proviamo a riprendere il lavoro sul video?',
    });

    // RED before B3 routing: stopped is 'error', row is 'done'.
    expect(r.stopped).toBe('continuable');
    expect(r.reason).toBe('provider_empty');
    const row = w.turns.get(r.turnId);
    expect(row?.status).toBe('continuable');
    expect(row?.continuableReason).toMatchObject({ class: 'provider_empty' });
    // Useful work survived on the durable transcript; no semantic rung burned.
    expect(row?.counters.toolCallsMade).toBe(2);
    expect(row?.counters.recoveriesUsed).toBe(0);
    expect(reads.get('muffin_thought.py')).toBe(1);
    expect(reads.get('make-music.py')).toBe(1);
    // The diagnostic names the turn and the way back; no secrets in it.
    expect(r.text).toContain(r.turnId.slice(0, 12));
    expect(r.text).toContain('riprendi');
  });

  it('"riprendi" continues the same turn on a new lease without re-reading', async () => {
    const reads = new Map<string, number>();
    const w = world(
      [
        calls('fs_read', 'c1', { query: 'muffin_thought.py', path: 'muffin_thought.py' }),
        calls('fs_read', 'c2', { query: 'make-music.py', path: 'make-music.py' }),
        stall(),
        stall(),
        stall(),
        stall(),
        {
          text: 'fatto: il venv dedicato è ~/dev/manim-video/.venv, manim 0.21.0. Dimmi pure come continuare il video.',
          toolCalls: [],
          stopReason: 'end',
          usage: someUsage,
          model: 'test-model',
        },
      ],
      reads,
    );
    const session = w.sessions.open('owner');
    const first = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'proviamo a riprendere il lavoro sul video?',
    });
    expect(first.stopped).toBe('continuable');

    // Conversational resolution finds the same work, deterministically.
    const match = resolveContinuation({
      turns: w.turns,
      principal: owner,
      sessionId: 'owner',
      text: 'Riprendi senza ripetere le cose due volte',
      hasAttachment: false,
      nowMs: NOW().getTime(),
    });
    expect(match).toEqual({ kind: 'single', turnId: first.turnId });

    const second = await continueTurn(w.deps, first.turnId, {
      message: { role: 'user', content: [{ type: 'text', text: 'Riprendi senza ripetere le cose due volte' }] },
      session: w.sessions.open('owner'),
    });
    if ('why' in second) throw new Error(`continuation refused: ${second.why} ${second.detail}`);
    expect(second.turnId).toBe(first.turnId);
    expect(second.stopped).toBe('answered');

    // No replay of settled effects: each file read exactly once across both
    // leases, even though lease 2 never re-issued the calls.
    expect(reads.get('muffin_thought.py')).toBe(1);
    expect(reads.get('make-music.py')).toBe(1);
    // The new lease saw the durable transcript (prior tool results plus the
    // grant message) instead of reconstructing from files/memory.
    const lastCall = w.provider.seen.at(-1)!;
    const wire = JSON.stringify(lastCall.messages);
    expect(wire).toContain('contenuto di muffin_thought.py');
    expect(wire).toContain('Riprendi senza ripetere le cose due volte');
    // Fresh recovery state: no demanded tool, in either lease.
    for (const call of w.provider.seen) expect(call.toolChoice ?? 'auto').toBe('auto');
    // Durable state preserved: taint, model-era transcript, lifetime audit.
    const row = w.turns.get(first.turnId);
    expect(row?.status).toBe('done');
    expect(row?.outcome).toBe('answered');
    expect(row?.taint).toBe(2);
    expect(row?.lifetime).toMatchObject({ leases: 2, toolCallsMade: 2 });
    expect(row?.counters.recoveriesUsed).toBe(0);
  });

  it('requireTool exhaustion becomes continuable; the next lease starts auto', async () => {    // Mandate regression: lease 1 walks the whole cascade to requireTool
    // (the wire IS demanded once, there), becomes continuable, and lease 2
    // runs with fresh recovery state and toolChoice=auto — stale
    // requireTool/strict-json/nudge directives from lease 1 are archived,
    // never behaviorally active.
    const genuine = (): ChatResult => ({
      text: null,
      toolCalls: [],
      stopReason: 'end',
      usage: someUsage,
      model: 'test-model',
    });
    const reads = new Map<string, number>();
    const w = world(
      [
        genuine(),
        genuine(),
        genuine(),
        genuine(),
        genuine(),
        genuine(),
        {
          text: 'eccomi, continuo senza ristudiarmi tutto',
          toolCalls: [],
          stopReason: 'end',
          usage: someUsage,
          model: 'test-model',
        },
      ],
      reads,
      { ...CONSERVATIVE, recovery: ['nudge', 'reinjectTools', 'retryOnce', 'strictJson', 'requireTool'] },
    );
    const session = w.sessions.open('owner');
    const first = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'fai qualcosa',
    });
    expect(first.stopped).toBe('continuable');
    expect(first.reason).toBe('recovery_exhausted');
    expect(w.turns.get(first.turnId)?.counters.recoveriesUsed).toBe(5);
    // The escalation fired exactly once, in lease 1, then was consumed.
    const demanded = w.provider.seen.filter((c) => c.toolChoice === 'required');
    expect(demanded).toHaveLength(1);

    const second = await continueTurn(w.deps, first.turnId, {
      message: { role: 'user', content: [{ type: 'text', text: 'riprendi' }] },
      session: w.sessions.open('owner'),
    });
    if ('why' in second) throw new Error(`refused: ${second.why}`);
    expect(second.stopped).toBe('answered');
    // Lease 2 never demanded a call and never re-read a stale directive:
    // every request auto, no recovery text from lease 1 on the wire.
    const lease2 = w.provider.seen.slice(demanded.length + 5);
    expect(lease2.length).toBeGreaterThan(0);
    for (const call of lease2) expect(call.toolChoice ?? 'auto').toBe('auto');
    const lastWire = JSON.stringify(lease2.at(-1)!.messages);
    expect(lastWire).not.toContain('Devi rispondere con una tool call adesso');
    expect(lastWire).not.toContain('Due sole risposte sono ammesse');
    expect(lastWire).not.toContain('Non ho ricevuto risposta');
    expect(lastWire).toContain('riprendi');
  });

  it('tool-use persisted without a WAL row is never-started, never replayed blind', async () => {
    // Real owner-DB evidence: an assistant tool_use sits in the turn
    // transcript, turn_tool_calls has no row for it, the turn is
    // running/interrupted with delivery pending and a hung claim. The window
    // is model-output-checkpointed → killed before the intent insert — and
    // `runTool` proves the ordering the other way: the intent row is
    // written before the handler runs, and a failed intent write never runs
    // it ("missing intent" means "never started", never "started but lost").
    // So resume/continuation must RUN it once (first execution, even when
    // non-rerunnable), never replay a fake outcome, never declare it "maybe".
    const executions = new Map<string, number>();
    const home = mkdtempSync(join(tmpdir(), 'muffin-incident-'));
    const db = new DatabaseCtor(':memory:');
    const turns = new TurnStore(db);
    const sessions = new SessionStore(home);
    const capabilities = new Map();
    // Proven-allowed capability id (sys.fs_read gate already exercised
    // above), but declared NON-rerunnable: the point is a first execution
    // that must happen exactly once, not an allowlist fight.
    const decl: CapabilityDecl = { ...searchCapability, rerunnable: false };
    capabilities.set(decl.id, decl);
    const provider = new Scripted([
      {
        text: 'fatto dopo la ripresa',
        toolCalls: [],
        stopReason: 'end',
        usage: someUsage,
        model: 'test-model',
      },
    ]);
    const deps: LoopDeps = {
      provider,
      profile: CONSERVATIVE,
      model: 'test-model',
      tools: [
        {
          capability: decl.id,
          spec: { ...searchSpec, name: 'fs_write_once' },
          handler: (args) => {
            const path = ((args ?? {}) as Record<string, unknown>).path;
            if (typeof path === 'string') executions.set(path, (executions.get(path) ?? 0) + 1);
            return { content: 'scritto', tier: 0 };
          },
          throwTier: 0,
        },
      ],
      capabilities,
      decide: createDecide({ matrix: POLICY_FLOOR, capabilities, budgetExhausted: () => false, hardened: true }),
      tracer: new SimpleTracer(new JsonlExporter(home)),
      sessions,
      turns,
      todos: new TodoStore(db),
      budgetExhausted: () => false,
      systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite.' },
      now: NOW,
    };
    const dangling: import('../providers/types.js').Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'scrivi il file' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c-dangle', name: 'fs_write_once', input: { query: 'x', path: 'irreversibile.txt' } }],
      },
    ];
    const created = turns.create(
      {
        id: 'dangle',
        principal: owner,
        tenant: 'host',
        surface: 'cli',
        sessionId: 'owner',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'scrivi il file' }] }],
        taint: 0,
        counters: {
          iterations: 1,
          recoveriesUsed: 0,
          transportRetriesLeft: 10,
          toolCallsMade: 0,
          nudgedForCompletion: false,
          usage: { ...zeroUsage },
          spentUsd: 0,
          resumes: 0,
          contextBuilt: true,
          activeModelMs: 0,
        },
      },
      4242,
    );
    expect(
      turns.checkpoint(
        'dangle',
        { messages: dangling, taint: 0, counters: created.counters },
        created.claimToken,
      ),
    ).toBe(true);
    // The externally observed state: killed process, no API call marks it.
    db.prepare(
      `UPDATE turns SET status = 'interrupted', claimed_by = NULL, claim_token = NULL, updated_at = '2026-09-18T17:14:10.000Z' WHERE id = 'dangle'`,
    ).run();
    expect(turns.recordedOutcomes('dangle').size).toBe(0);
    expect(turns.uncertainCalls('dangle')).toEqual([]);

    const resumed = await resumeTurn(deps, 'dangle');
    if ('why' in resumed) throw new Error(`resume refused: ${resumed.why} ${resumed.detail}`);
    expect(resumed.stopped).toBe('answered');
    // Exactly one first execution — even though non-rerunnable — and no
    // "maybe happened" declaration anywhere in the transcript.
    expect(executions.get('irreversibile.txt')).toBe(1);
    const wire = JSON.stringify(turns.get('dangle')?.messages);
    expect(wire).not.toContain('non è possibile sapere');
    expect(turns.recordedOutcomes('dangle').get('c-dangle')?.content).toBe('scritto');
  });

  it('sensitive echoes survive the lease boundary: read, fail, resume, echo attempt, scrubbed', async () => {
    // The mandated six-step proof. Lease 1 reads a credentials file (the
    // handler returns the secret itself), then stalls into continuable
    // WITHOUT re-reading. Lease 2's model tries to echo the secret verbatim
    // into its answer. The reply must come back scrubbed — proving
    // rehydration rebuilt the RAM-only protection from durable pairs.
    // Deleting the rehydrate call in TurnRun turns this red.
    const SECRET = 'password-supersegreta-del-router-99';
    const reads = new Map<string, number>();
    const w = world(
      [
        calls('fs_read', 'c1', { query: 'router', path: 'credenziali-router.txt' }),
        stall(),
        stall(),
        stall(),
        stall(),
        {
          text: `la password è ${SECRET}, eccola`,
          toolCalls: [],
          stopReason: 'end',
          usage: someUsage,
          model: 'test-model',
        },
      ],
      reads,
      CONSERVATIVE,
      () => SECRET,
    );
    const session = w.sessions.open('owner');
    const first = await runTurn(w.deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'leggi le credenziali del router',
    });
    expect(first.stopped).toBe('continuable');
    expect(reads.get('credenziali-router.txt')).toBe(1);

    const second = await continueTurn(w.deps, first.turnId, {
      message: { role: 'user', content: [{ type: 'text', text: 'riprendi' }] },
      session: w.sessions.open('owner'),
    });
    if ('why' in second) throw new Error(`refused: ${second.why}`);
    expect(second.stopped).toBe('answered');
    expect(second.text).not.toContain(SECRET);
    // And the secret was never re-read to rebuild the protection.
    expect(reads.get('credenziali-router.txt')).toBe(1);
  });
});
