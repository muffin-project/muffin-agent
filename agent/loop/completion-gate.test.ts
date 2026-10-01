import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import type { TodoItem } from '../../core/turns/todo.js';
import { ownedOpenRows } from './completion-gate.js';
import { continueTurn, runTurn, type LoopDeps } from '../loop.js';
import { buildRuntime } from '../runtime.js';
import type { ChatResult, Provider } from '../providers/types.js';

/**
 * The completion gate (#811): a resumed turn that would settle `answered`
 * with granted plan work still open settles `continuable` instead. The
 * decision is a query on rows — these tests would stay green if the gate
 * were replaced by a sentence in context, which is exactly the defect they
 * exist to prevent.
 */

const T0 = '2026-09-30T10:00:00.000Z';
const T1 = '2026-09-30T10:05:00.000Z';
const T2 = '2026-09-30T10:10:00.000Z';

function row(over: Partial<TodoItem> & { text: string }): TodoItem {
  return {
    seq: 1,
    state: 'pending',
    note: null,
    tier: 0,
    dueAt: null,
    createdAt: T1,
    updatedAt: T1,
    ...over,
  };
}

describe('ownedOpenRows — pure ownership rule, no store', () => {
  it('empty in, empty out: no rows, no fire', () => {
    expect(ownedOpenRows({ open: [], turnCreatedAt: T0, leaseStartedAt: T1 })).toEqual([]);
  });

  it('ignores rows that predate the turn and stayed untouched since', () => {
    const old = row({ text: 'vecchio piano di un altro lavoro', createdAt: T0, updatedAt: T0 });
    expect(ownedOpenRows({ open: [old], turnCreatedAt: T1, leaseStartedAt: T2 })).toEqual([]);
  });

  it('fires on rows born under the current lease', () => {
    const fresh = row({ text: 'aperto adesso', createdAt: T2, updatedAt: T2 });
    expect(
      ownedOpenRows({ open: [fresh], turnCreatedAt: T0, leaseStartedAt: T1 }).map((r) => r.text),
    ).toEqual(['aperto adesso']);
  });

  it('fires on pre-existing rows this turn lifetime touched', () => {
    const touched = row({ text: 'ripreso', createdAt: T0, updatedAt: T1 });
    expect(
      ownedOpenRows({ open: [touched], turnCreatedAt: T0, leaseStartedAt: T2 }).map((r) => r.text),
    ).toEqual(['ripreso']);
  });

  it.each(['blocked', 'waiting', 'done'] as const)('never fires on %s rows', (state) => {
    const r = row({ text: 'non dovuto', state, createdAt: T2, updatedAt: T2 });
    expect(ownedOpenRows({ open: [r], turnCreatedAt: T0, leaseStartedAt: T1 })).toEqual([]);
  });

  it('malformed timestamps fail closed into no-fire', () => {
    const r = row({ text: 'orologio rotto', createdAt: 'mai', updatedAt: 'mai' });
    expect(ownedOpenRows({ open: [r], turnCreatedAt: T0, leaseStartedAt: T1 })).toEqual([]);
  });
});

/** Answers whatever it is told to, and keeps every request it was sent. */
class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  readonly seen: unknown[] = [];
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: never): Promise<ChatResult> {
    this.seen.push(call);
    const next = this.script.shift();
    if (next === undefined) throw new Error('lo script è finito');
    return next;
  }
}

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const callTodo = (args: unknown, id = 'c1'): ChatResult => ({
  text: '',
  toolCalls: [{ id, name: 'todo', args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const stall = (): ChatResult => ({
  text: null,
  toolCalls: [],
  stopReason: 'error',
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

const owner = { kind: 'owner', connector: 'cli', externalId: 'local' } as const;

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-gate-'));
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

const workspace = () => mkdtempSync(join(tmpdir(), 'muffin-gate-ws-'));

describe('the gate at the finish boundary, on the production loop', () => {
  it('a resumed turn that drops granted rows settles continuable, naming them — never answered', async () => {
    const dir = home();
    const runtime = buildRuntime(dir, workspace());
    const provider = new Scripted([
      callTodo({ action: 'plan', items: ['leggere il contratto', 'rispondere a Marco'] }),
      stall(),
      stall(),
      stall(),
      stall(),
      stall(),
    ]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const session = runtime.deps.sessions.open('piano');

    const first = await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'organizzati',
    });
    expect(first.stopped).toBe('continuable');

    const drop = new Scripted([answer('tutto fatto, nessun passo aperto')]);
    const resumed = await continueTurn(
      { ...deps, provider: drop },
      first.turnId,
      {
        message: { role: 'user', content: [{ type: 'text', text: 'continua pure' }] },
        session: runtime.deps.sessions.open('piano'),
      },
    );
    if ('why' in resumed) throw new Error(`continuation refused: ${resumed.why}`);
    expect(resumed.stopped).toBe('continuable');
    expect(resumed.reason).toBe('plan_open');
    // The diagnostic names the granted work; no secrets in it.
    expect(resumed.text).toContain('leggere il contratto');
    expect(resumed.text).toContain('rispondere a Marco');
    const row = runtime.deps.turns.get(first.turnId);
    expect(row?.status).toBe('continuable');
    expect(row?.continuableReason).toMatchObject({ class: 'plan_open', openSteps: 2 });
    runtime.close();
  });

  it('a resumed turn that closes the rows settles answered', async () => {
    const dir = home();
    const runtime = buildRuntime(dir, workspace());
    const provider = new Scripted([
      callTodo({ action: 'plan', items: ['fare una cosa'] }),
      stall(),
      stall(),
      stall(),
      stall(),
      stall(),
    ]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const session = runtime.deps.sessions.open('piano');

    const first = await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'organizzati',
    });
    expect(first.stopped).toBe('continuable');

    const closer = new Scripted([
      callTodo({ action: 'set', step: 1, state: 'done' }, 'c2'),
      answer('fatto'),
    ]);
    const resumed = await continueTurn(
      { ...deps, provider: closer },
      first.turnId,
      {
        message: { role: 'user', content: [{ type: 'text', text: 'finisci' }] },
        session: runtime.deps.sessions.open('piano'),
      },
    );
    if ('why' in resumed) throw new Error(`continuation refused: ${resumed.why}`);
    expect(resumed.stopped).toBe('answered');
    runtime.close();
  });

  it('a fresh turn that writes a plan for later still settles answered', async () => {
    const dir = home();
    const runtime = buildRuntime(dir, workspace());
    const provider = new Scripted([
      callTodo({ action: 'plan', items: ['domani si vedrà'] }),
      answer('ho scritto il piano'),
    ]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const session = runtime.deps.sessions.open('piano');

    const r = await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'organizzati',
    });
    // Lease 0 owns nothing: multi-turn plans written for later are unaffected.
    expect(r.stopped).toBe('answered');
    runtime.close();
  });

  it('blocked rows do not fire the gate', async () => {
    const dir = home();
    const runtime = buildRuntime(dir, workspace());
    const provider = new Scripted([
      callTodo({ action: 'plan', items: ['aspetto Marco'] }),
      stall(),
      stall(),
      stall(),
      stall(),
      stall(),
    ]);
    const deps: LoopDeps = { ...runtime.deps, provider };
    const session = runtime.deps.sessions.open('piano');

    const first = await runTurn(deps, {
      principal: owner,
      tenant: 'host',
      surface: 'cli',
      session,
      text: 'organizzati',
    });
    expect(first.stopped).toBe('continuable');

    const blocker = new Scripted([
      callTodo({ action: 'set', step: 1, state: 'blocked', note: 'aspetto Marco' }, 'c2'),
      answer('bloccato su Marco'),
    ]);
    const resumed = await continueTurn(
      { ...deps, provider: blocker },
      first.turnId,
      {
        message: { role: 'user', content: [{ type: 'text', text: 'a che punto sei?' }] },
        session: runtime.deps.sessions.open('piano'),
      },
    );
    if ('why' in resumed) throw new Error(`continuation refused: ${resumed.why}`);
    // `blocked` is a deliberate terminal-ish state, not dropped work.
    expect(resumed.stopped).toBe('answered');
    runtime.close();
  });
});
