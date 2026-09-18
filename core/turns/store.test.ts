import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../agent/providers/types.js';
import { HARD_STALE_MULTIPLIER } from '../lock/durable.js';
import type { Principal } from '../policy/types.js';
import { TURN_STALE_AFTER_MS, TurnStore, describeInterrupted, readTurnHealth, type NewTurn, type TurnCounters } from './store.js';

/**
 * The row, and the four things it exists to hold that nothing else can.
 *
 * Each of these is a property the design (`docs/evidence/turno-sospendibile.md`)
 * priced as expensive-if-wrong, and three of the four fail **silently** when
 * they are wrong — the pinned model, the persisted taint, and the difference
 * between a call that finished and one that may have. So they get assertions
 * rather than a docstring.
 */

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

const spec = (over: Partial<NewTurn> = {}): NewTurn => ({
  id: 'turn-1',
  principal: owner,
  tenant: 'host',
  surface: 'cli',
  sessionId: 's1',
  model: 'claude-opus-5',
  messages: [],
  taint: 0,
  counters: {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 2,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: false,
  },
  ...over,
});

const store = (alive: (pid: number) => boolean = () => true, clock: () => Date = () => new Date()) =>
  new TurnStore(new DatabaseCtor(':memory:'), clock, alive);

describe('the turn record', () => {
  it('reassigns only a never-started runnable row to the newly selected model', () => {
    const s = store();
    s.enqueue(spec());

    expect(s.reassignUnstartedModel('turn-1', 'claude-opus-5', 'openrouter/free')).toBe(true);
    expect(s.get('turn-1')?.model).toBe('openrouter/free');

    expect(s.claim('turn-1', 4242)).not.toBeNull();
    expect(s.reassignUnstartedModel('turn-1', 'openrouter/free', 'another/model')).toBe(false);
    expect(s.get('turn-1')?.model).toBe('openrouter/free');
  });

  it('exists as soon as it is created: running, claimed by this process, model pinned', () => {
    const s = store();
    const created = s.create(spec(), 4242);
    expect(created).toMatchObject({ status: 'running', claimedBy: 4242, model: 'claude-opus-5', taint: 0 });
    expect(s.get('turn-1')?.outcome).toBeNull();
  });

  it('keeps the transcript verbatim — thinking blocks and their signatures included', () => {
    const s = store();
    const created = s.create(spec());
    // The exact shape ADR-0037 requires to be sent back unmodified. A record
    // that loses these is not a record of the turn: the loss makes no noise at
    // the API, so nothing downstream would ever report it.
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'fai la cosa' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'ragionamento', signature: 'sig-abc' },
          { type: 'redacted_thinking', data: 'opaco' },
          { type: 'tool_use', id: 'c1', name: 'demo_read', input: { q: 1 } },
        ],
      },
    ];
    expect(s.checkpoint('turn-1', { messages, taint: 0, counters: spec().counters }, created.claimToken)).toBe(true);
    expect(s.get('turn-1')?.messages).toEqual(messages);
  });

  it('raises the taint with the tool result that caused it, in one write', () => {
    const s = store();
    s.create(spec());
    s.startToolCall('turn-1', { callId: 'c1', tool: 'http_get', capability: 'sys.http', rerunnable: true, args: { url: 'https://x' }, effect: { row: 'egress', reversible: 'yes', resource: null, decision: 'allow' } });
    s.endToolCall('turn-1', 'c1', { content: 'body', isError: false, tier: 3 });
    // Not derivable from the principal — an owner turn starts at 0 and this one
    // is at 3 because of what it read. That is the escalation the design names:
    // a resume that rebuilt the taint from `principal.kind` would start again
    // at 0 with the web page still in context.
    expect(s.get('turn-1')?.taint).toBe(3);
    expect(s.uncertainCalls('turn-1')).toEqual([]);
  });

  it('never lowers the taint, whatever a later result says', () => {
    const s = store();
    s.create(spec());
    s.startToolCall('turn-1', { callId: 'c1', tool: 'http_get', capability: 'sys.http', rerunnable: true, args: {}, effect: { row: 'egress', reversible: 'yes', resource: null, decision: 'allow' } });
    s.endToolCall('turn-1', 'c1', { content: 'body', isError: false, tier: 3 });
    s.startToolCall('turn-1', { callId: 'c2', tool: 'fs_read', capability: 'fs.read', rerunnable: true, args: {}, effect: { row: 'host', reversible: 'yes', resource: null, decision: 'allow' } });
    s.endToolCall('turn-1', 'c2', { content: 'file', isError: false, tier: 0 });
    expect(s.get('turn-1')?.taint).toBe(3);
  });

  it('finishing records how the turn went and releases the claim', () => {
    const s = store();
    const created = s.create(spec());
    expect(created.claimToken).not.toBeNull();
    expect(s.finish('turn-1', { outcome: 'answered', messages: [], taint: 1, counters: spec().counters }, created.claimToken)).toBe(true);
    expect(s.get('turn-1')).toMatchObject({ status: 'done', outcome: 'answered', claimedBy: null, taint: 1, claimToken: null });
  });

  it('keeps the two outcomes apart: a failed delivery leaves the turn answered', () => {
    const s = store();
    const created = s.create(spec({ replyTo: { chatId: 7, messageId: 9 } }));
    expect(s.get('turn-1')?.delivery).toBe('pending');
    s.finish('turn-1', { outcome: 'answered', messages: [], taint: 0, counters: spec().counters }, created.claimToken);
    s.delivered('turn-1', 'failed:429 Too Many Requests');
    const row = s.get('turn-1');
    // The property `core/scheduler/scheduler.ts:166-171` already paid for: the
    // work is done, the delivery is not, and nothing here can make the first
    // look undone because the second failed.
    expect(row?.status).toBe('done');
    expect(row?.outcome).toBe('answered');
    expect(row?.delivery).toBe('failed:429 Too Many Requests');
  });

  it('keeps an ambiguous remote effect terminal and visible to undelivered readers', () => {
    const s = store();
    const created = s.create(spec({ replyTo: { chatId: 7, messageId: 9 } }));
    s.finish('turn-1', { outcome: 'answered', messages: [], taint: 0, counters: spec().counters }, created.claimToken);
    s.delivered('turn-1', 'possibly_sent');

    expect(s.get('turn-1')?.delivery).toBe('possibly_sent');
    expect(s.undelivered()).toMatchObject([{ id: 'turn-1', delivery: 'possibly_sent' }]);
  });

  it('a turn nobody has to deliver to has no delivery that can fail', () => {
    const s = store();
    s.create(spec());
    expect(s.get('turn-1')?.replyTo).toBeNull();
    expect(s.get('turn-1')?.delivery).toBeNull();
  });
});

describe('taintForIds — the batch read agent/context/history-taint.ts needs', () => {
  it('answers with one query for the whole set, keyed by id', () => {
    const s = store();
    s.create(spec({ id: 'turn-1', taint: 2 }));
    s.create(spec({ id: 'turn-2', taint: 0 }));
    s.create(spec({ id: 'turn-3', taint: 3 }));
    expect(s.taintForIds(['turn-1', 'turn-3', 'turn-2'])).toEqual(
      new Map([
        ['turn-1', 2],
        ['turn-3', 3],
        ['turn-2', 0],
      ]),
    );
  });

  it('an id with no row is simply absent from the map, not zero', () => {
    const s = store();
    s.create(spec({ id: 'turn-1', taint: 2 }));
    const result = s.taintForIds(['turn-1', 'never-written']);
    expect(result.get('turn-1')).toBe(2);
    expect(result.has('never-written')).toBe(false);
  });

  it('an empty set of ids is an empty map — no query, no crash on a zero-length IN()', () => {
    const s = store();
    expect(s.taintForIds([])).toEqual(new Map());
  });

  it('duplicate ids do not change the answer', () => {
    const s = store();
    s.create(spec({ id: 'turn-1', taint: 1 }));
    expect(s.taintForIds(['turn-1', 'turn-1', 'turn-1'])).toEqual(new Map([['turn-1', 1]]));
  });
});

describe('markUndone / undoneTraceIds — D11, muffin undo\'s other half', () => {
  const conUnaChiamataFinita = (s: TurnStore, turnId: string, callId = 'w1') => {
    s.create(spec({ id: turnId }));
    s.startToolCall(turnId, { callId, tool: 'fs_write', capability: 'fs.write', rerunnable: false, args: {}, effect: { row: 'host', reversible: 'undoable', resource: null, decision: 'allow' } });
    s.endToolCall(turnId, callId, { content: 'scritto', isError: false, tier: 0 });
  };

  it('un turno con una chiamata marcata compare in undoneTraceIds', () => {
    const s = store();
    conUnaChiamataFinita(s, 'turn-1');
    expect(s.undoneTraceIds(['turn-1'])).toEqual(new Set());
    s.markUndone('turn-1', ['w1']);
    expect(s.undoneTraceIds(['turn-1'])).toEqual(new Set(['turn-1']));
  });

  it('un turno mai marcato non compare, anche se ha chiamate finite', () => {
    const s = store();
    conUnaChiamataFinita(s, 'turn-1');
    conUnaChiamataFinita(s, 'turn-2', 'w2');
    s.markUndone('turn-1', ['w1']);
    expect(s.undoneTraceIds(['turn-1', 'turn-2'])).toEqual(new Set(['turn-1']));
  });

  it('markUndone su una chiamata mai iniziata non scrive nulla e non lancia', () => {
    const s = store();
    s.create(spec({ id: 'turn-1' }));
    expect(() => s.markUndone('turn-1', ['mai-esistita'])).not.toThrow();
    expect(s.undoneTraceIds(['turn-1'])).toEqual(new Set());
  });

  it('undoneTraceIds su un array vuoto è un insieme vuoto, senza query', () => {
    const s = store();
    expect(s.undoneTraceIds([])).toEqual(new Set());
  });

  it('content resta quello del tool: markUndone non lo riscrive', () => {
    const s = store();
    conUnaChiamataFinita(s, 'turn-1');
    s.markUndone('turn-1', ['w1']);
    expect(s.recordedOutcomes('turn-1').get('w1')?.content).toBe('scritto');
  });
});

describe('reclaiming what a dead process was holding', () => {
  it('marks the row interrupted and names the calls that may have landed', () => {
    const s = store(() => false);
    s.create(spec(), 99999);
    s.startToolCall('turn-1', { callId: 'c1', tool: 'fs_read', capability: 'fs.read', rerunnable: true, args: {}, effect: { row: 'host', reversible: 'yes', resource: null, decision: 'allow' } });
    s.endToolCall('turn-1', 'c1', { content: 'ok', isError: false, tier: 0 });
    // Intent, no outcome: the process died between the two.
    s.startToolCall('turn-1', { callId: 'c2', tool: 'shell_run', capability: 'sys.shell', rerunnable: false, args: { command: 'send-mail' }, effect: { row: 'host', reversible: 'yes', resource: null, decision: 'allow' } });

    const [reclaimed] = s.reclaim();
    expect(reclaimed).toMatchObject({ id: 'turn-1', surface: 'cli', model: 'claude-opus-5' });
    expect(reclaimed?.uncertain).toEqual([
      { callId: 'c2', tool: 'shell_run', capability: 'sys.shell', rerunnable: false, startedAt: expect.any(String) },
    ]);
    expect(s.get('turn-1')?.status).toBe('interrupted');
    // Reclaimed, never resumed: nothing here may claim a turn is runnable while
    // no resume exists to run it.
    expect(s.get('turn-1')?.status).not.toBe('runnable');
  });

  it('leaves a turn a live process is still running alone', () => {
    const s = store(() => true);
    s.create(spec(), 4242);
    expect(s.reclaim()).toEqual([]);
    expect(s.get('turn-1')?.status).toBe('running');
  });

  it('does not reclaim a live pid past the ordinary horizon — P19', () => {
    // Before the fix, `reclaim()` asked `heldBy` which asked the wall clock
    // before `alive` — a live pid past `TURN_STALE_AFTER_MS` (with no
    // checkpoint to push the horizon out) was reclaimed exactly like a
    // corpse, and the row it left `interrupted` was immediately claimable by
    // a second process while the first was still executing it.
    const start = new Date('2026-08-15T10:00:00.000Z');
    const s = store(() => true, () => start);
    s.create(spec(), 4242);
    expect(s.reclaim(new Date(start.getTime() + TURN_STALE_AFTER_MS - 1))).toEqual([]);
    // Past the ordinary horizon, still alive: still not reclaimed. This exact
    // instant is where the pre-fix code handed the row to a second claimant.
    expect(s.reclaim(new Date(start.getTime() + TURN_STALE_AFTER_MS + 1))).toEqual([]);
    expect(s.get('turn-1')?.status).toBe('running');
  });

  it('reclaims past the hard horizon whatever the pid says — pids get reused', () => {
    const start = new Date('2026-08-15T10:00:00.000Z');
    const s = store(() => true, () => start);
    s.create(spec(), 4242);
    const pastHard = new Date(start.getTime() + TURN_STALE_AFTER_MS * HARD_STALE_MULTIPLIER + 1);
    expect(s.reclaim(pastHard)).toHaveLength(1);
    expect(s.get('turn-1')?.status).toBe('interrupted');
  });

  it('a finished turn is never reclaimed, whoever wrote it', () => {
    const s = store(() => false);
    const created = s.create(spec(), 99999);
    s.finish('turn-1', { outcome: 'answered', messages: [], taint: 0, counters: spec().counters }, created.claimToken);
    expect(s.reclaim()).toEqual([]);
  });

  it('two processes booting at once report each interrupted turn exactly once', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'muffin-turns-')), 'muffin.db');
    const first = new DatabaseCtor(file);
    const second = new DatabaseCtor(file);
    const a = new TurnStore(first, () => new Date(), () => false);
    const b = new TurnStore(second, () => new Date(), () => false);
    a.create(spec(), 99999);

    const reported = [...a.reclaim(), ...b.reclaim()];
    // Not "both see it" — the guarded update is what stops one crash from being
    // announced twice by two surfaces starting together.
    expect(reported).toHaveLength(1);
    first.close();
    second.close();
  });
});

describe('fencing: a stolen claim cannot write over its thief (P19)', () => {
  it("after a steal, the original run's checkpoint/suspend/finish all report the loss instead of landing", () => {
    // The exact scenario the audit's P19 probe demonstrated as broken: a
    // legitimately long turn (pid 4242, still alive) goes 61+ minutes without
    // a checkpoint, a second process reclaims and claims the row (pid 777).
    // Before this fix, pid 4242's writes carried no holder guard — only a
    // status one — so its `suspend`/`finish` landed on the row pid 777 was
    // now executing, silently overwriting the winner's transcript
    // (store.ts:471-481,579 in the audit's citation).
    const file = join(mkdtempSync(join(tmpdir(), 'muffin-fencing-')), 'muffin.db');
    const start = new Date('2026-08-16T10:00:00.000Z');
    const original = new TurnStore(new DatabaseCtor(file), () => start, () => true);
    const created = original.create(spec(), 4242);
    expect(created.claimToken).not.toBeNull();

    const thief = new TurnStore(new DatabaseCtor(file), () => new Date(start.getTime() + TURN_STALE_AFTER_MS * HARD_STALE_MULTIPLIER + 1), () => true);
    expect(thief.reclaim()).toHaveLength(1);
    const stolen = thief.claim('turn-1', 777);
    expect(stolen).toMatchObject({ status: 'running', claimedBy: 777 });
    expect(stolen?.claimToken).not.toBe(created.claimToken);

    // Pid 4242 — still alive, still holding its now-stale token — tries every
    // write the loop makes. All three must change nothing.
    expect(
      original.checkpoint(
        'turn-1',
        { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'work of pid 4242' }] }], taint: 0, counters: spec().counters },
        created.claimToken,
      ),
    ).toBe(false);
    expect(
      original.suspend(
        'turn-1',
        { messages: [], taint: 0, counters: spec().counters, wakeAt: new Date(start.getTime() + 3_600_000).toISOString(), waitFor: null },
        created.claimToken,
      ),
    ).toBe(false);
    expect(
      original.finish('turn-1', { outcome: 'answered', messages: [], taint: 0, counters: spec().counters }, created.claimToken),
    ).toBe(false);

    // The row still reads exactly as pid 777 left it — none of the three
    // writes above touched it.
    expect(thief.get('turn-1')).toMatchObject({ status: 'running', claimedBy: 777, claimToken: stolen?.claimToken });
  });

  it('every claim mints its own token — two turns never share one', () => {
    const s = store();
    const first = s.create(spec({ id: 'turn-a' }), 4242);
    const second = s.create(spec({ id: 'turn-b' }), 4243);
    expect(first.claimToken).not.toBeNull();
    expect(second.claimToken).not.toBeNull();
    expect(first.claimToken).not.toBe(second.claimToken);
  });
});

describe('what an interrupted turn is told to the owner', () => {
  const base = { id: 'abcdef012345678', surface: 'telegram', tenant: 'host', sessionId: 's', model: 'm', startedAt: '2026-08-15T10:11:12.000Z', delivery: null };

  it('says plainly that nothing was half-done when nothing was in flight', () => {
    expect(describeInterrupted({ ...base, uncertain: [] })).toContain('non ha lasciato effetti a metà');
  });

  it('does not raise an alarm for calls that can simply be made again', () => {
    const line = describeInterrupted({
      ...base,
      uncertain: [{ callId: 'c1', tool: 'fs_read', capability: 'fs.read', rerunnable: true, startedAt: base.startedAt }],
    });
    expect(line).toContain('ri-eseguibili');
    expect(line).not.toContain('non è possibile sapere');
  });

  it('says what cannot be known when a call is not declared re-runnable', () => {
    const line = describeInterrupted({
      ...base,
      uncertain: [{ callId: 'c1', tool: 'shell_run', capability: 'sys.shell', rerunnable: false, startedAt: base.startedAt }],
    });
    expect(line).toContain('shell_run');
    expect(line).toContain('non è possibile sapere se ha avuto effetto');
  });
});

describe('the reader a surface with only a database can use', () => {
  it('says "no table" and "no turns" differently', () => {
    const empty = new DatabaseCtor(':memory:');
    expect(readTurnHealth(empty)).toBeNull();
    new TurnStore(empty);
    expect(readTurnHealth(empty)).toEqual({
      total: 0,
      waiting: { count: 0, oldestWakeAt: null },
      continuable: { count: 0, oldest: null },
      undeliverable: { count: 0 },
      interrupted: [],
    });
  });

  it('sees a crash nobody has reclaimed yet — the state a diagnosis is run in', () => {
    const db = new DatabaseCtor(':memory:');
    // Dead holder, and nothing has booted since: the row still says `running`.
    const s = new TurnStore(db, () => new Date(), () => false);
    s.create(spec(), 99999);
    // `doctor` does not build a runtime, so if this needed the mark to exist it
    // would answer "all clear" for exactly as long as nobody restarts — which
    // is the whole window in which an owner is asking what went wrong.
    expect(readTurnHealth(db)?.interrupted.map((t) => t.id)).toEqual(['turn-1']);
  });

  it('does not report a turn a live process is running right now', () => {
    const db = new DatabaseCtor(':memory:');
    // Claimed by a pid that genuinely exists — this test's own process. The
    // reader uses the real `pidAlive`, deliberately: a diagnosis that trusted
    // an injected answer would be measuring the test and not the machine.
    new TurnStore(db).create(spec(), process.pid);
    expect(readTurnHealth(db)?.interrupted).toEqual([]);
    expect(readTurnHealth(db)?.total).toBe(1);
  });

  it('bounds the window, so last month`s crash is not today`s news', () => {
    const db = new DatabaseCtor(':memory:');
    const old = new Date('2026-07-01T00:00:00.000Z');
    const s = new TurnStore(db, () => old, () => false);
    s.create(spec(), 99999);
    const now = new Date('2026-08-15T00:00:00.000Z');
    expect(s.health({ now, windowMs: 24 * 60 * 60 * 1000 }).interrupted).toEqual([]);
    // Still on the record, never deleted — just not reported as current.
    expect(s.health({ now }).total).toBe(1);
  });

  it('counts what is there and carries the uncertain calls with it', () => {
    const db = new DatabaseCtor(':memory:');
    const s = new TurnStore(db, () => new Date(), () => false);
    s.create(spec(), 99999);
    s.startToolCall('turn-1', { callId: 'c1', tool: 'shell_run', capability: 'sys.shell', rerunnable: false, args: {}, effect: { row: 'host', reversible: 'yes', resource: null, decision: 'allow' } });
    s.reclaim();
    const health = readTurnHealth(db);
    expect(health?.total).toBe(1);
    expect(health?.interrupted[0]?.uncertain[0]?.tool).toBe('shell_run');
  });

  /**
   * D2, judge round 2: `agent/turn-lane.ts` emitted `LaneEvent.undeliverable`
   * for a turn whose answer had no address, but nothing wrote it onto the row
   * — `delivery` stayed at whatever it was (`pending`, or `null` for a turn
   * created in-band), so this reader had nothing to count and `doctor` had
   * nothing to say. Unwindowed on purpose, like `waiting`: a stranded reply
   * from last month is still a stranded reply.
   */
  it('counts turns whose answer has nowhere to go', () => {
    const db = new DatabaseCtor(':memory:');
    const s = new TurnStore(db, () => new Date(), () => true);
    s.create(spec());
    expect(readTurnHealth(db)?.undeliverable.count).toBe(0);

    s.delivered('turn-1', 'undeliverable');
    expect(readTurnHealth(db)?.undeliverable.count).toBe(1);
    // Not confused with a delivery that was attempted and failed — the two
    // columns of `DeliveryState` this table keeps apart.
    expect(s.get('turn-1')?.delivery).toBe('undeliverable');
  });
});

describe('continuable · the lease ends, the work does not (P0-B)', () => {
  const reason = { class: 'provider_empty' as const, lease: 0, attempts: 4, at: '2026-09-18T17:14:09.000Z' };

  const releaseIt = (s: TurnStore, id = 'turn-1') => {
    const rec = s.get(id);
    if (rec === null) throw new Error('no row');
    return s.releaseContinuable(id, { messages: rec.messages, taint: rec.taint, counters: rec.counters, reason }, rec.claimToken);
  };

  const grantIt = (s: TurnStore, id = 'turn-1', fresh?: TurnCounters) => {
    const rec = s.get(id);
    if (rec === null) throw new Error('no row');
    return s.grantContinuation(
      id,
      {
        messages: [...rec.messages, { role: 'user', content: [{ type: 'text', text: 'riprendi' }] }],
        taint: rec.taint,
        // Fresh lease-local capacity. iterations and resumes ride along
        // unchanged: iterations stays cumulative, resumes is the crash-loop
        // bound, not a lease allowance (see the reset-contract test below).
        // contextBuilt stays true: the preamble ran in lease 0 and never
        // re-runs (it would duplicate the owner episode and session lines).
        counters: fresh ?? {
          ...rec.counters,
          recoveriesUsed: 0,
          transportRetriesLeft: 10,
          toolCallsMade: 0,
          nudgedForCompletion: false,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          spentUsd: 0,
          activeModelMs: 0,
          contextBuilt: true,
        },
        newLeaseStartedAt: '2026-09-18T17:16:35.000Z',
      },
      4242,
    );
  };

  it('releases a running lease as continuable with a typed reason, and frees the claim', () => {
    const s = store();
    const created = s.create(spec(), 4242);

    expect(releaseIt(s)).toBe(true);
    const rec = s.get('turn-1');
    expect(rec).toMatchObject({ status: 'continuable', outcome: null, claimedBy: null, claimToken: null });
    expect(rec?.continuableReason).toMatchObject({ class: 'provider_empty', lease: 0 });
    expect(created.claimToken).not.toBeNull();
  });

  it('a released-and-never-granted lease is fully archived: falsifier for close-at-release', () => {
    // Blocker 1: the finished lease must be in the declared source of truth
    // from the release moment on — not only once somebody grants.
    const s = store();
    s.create(spec({ counters: { ...spec().counters, toolCallsMade: 16, contextBuilt: true } }), 4242);
    expect(releaseIt(s)).toBe(true);

    const leases = s.leasesFor('turn-1');
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ leaseIndex: 0, outcome: 'provider_empty', endedAt: expect.any(String) });
    expect(leases[0]?.counters).toMatchObject({ toolCallsMade: 16 });
    expect(leases[0]?.transportAllowance).toBe(2);
    const rec = s.get('turn-1');
    expect(rec?.lifetime).toEqual(s.recomputeLifetime('turn-1'));
    expect(rec?.lifetime).toMatchObject({ leases: 1, toolCallsMade: 16 });
  });

  it('refuses release from waiting and done: barrier pending and endings stay what they are', () => {
    const s = store();
    const created = s.create(spec(), 4242);
    expect(
      s.suspend('turn-1', { messages: [], taint: 0, counters: spec().counters, wakeAt: '2026-09-18T18:00:00.000Z', waitFor: null }, created.claimToken),
    ).toBe(true);
    const waiting = s.get('turn-1');
    expect(s.releaseContinuable('turn-1', { messages: [], taint: 0, counters: spec().counters, reason }, waiting?.claimToken ?? null)).toBe(false);
    expect(s.get('turn-1')?.status).toBe('waiting');
  });

  it('grants the next lease without touching lifetime: claim, reset, open', () => {
    const s = store();
    s.create(spec(), 4242);
    expect(releaseIt(s)).toBe(true);
    const releasedLifetime = s.get('turn-1')?.lifetime;

    const granted = grantIt(s);
    expect(granted).not.toBeNull();
    expect(granted).toMatchObject({ status: 'running', claimedBy: 4242, leaseIndex: 1, continuableReason: null });
    expect(granted?.claimToken).not.toBeNull();
    // Fresh lease-local capacity.
    expect(granted?.counters).toMatchObject({ recoveriesUsed: 0, transportRetriesLeft: 10, toolCallsMade: 0 });
    // Lifetime untouched by the grant: the previous lease was already
    // closed and folded at release. A grant that also folded would count
    // it twice.
    expect(granted?.lifetime).toEqual(releasedLifetime);
    // The owner's continuation message is on the durable transcript.
    expect(granted?.messages.at(-1)).toMatchObject({ role: 'user' });
    // New lease opened with the fresh allowance; previous lease stays as
    // the release left it.
    const leases = s.leasesFor('turn-1');
    expect(leases).toHaveLength(2);
    expect(leases[0]).toMatchObject({ leaseIndex: 0, outcome: 'provider_empty', endedAt: expect.any(String) });
    expect(leases[1]).toMatchObject({
      leaseIndex: 1,
      startedAt: '2026-09-18T17:16:35.000Z',
      endedAt: null,
      transportAllowance: 10,
    });
  });

  it('two processes cannot win the same continuation', () => {
    const s = store();
    s.create(spec(), 4242);
    expect(releaseIt(s)).toBe(true);

    expect(grantIt(s)).not.toBeNull();
    // Second grant finds a running row, not a continuable one.
    expect(grantIt(s)).toBeNull();
    expect(s.get('turn-1')?.leaseIndex).toBe(1);
  });

  it('the lane never picks continuable up on its own', () => {
    const s = store();
    s.create(spec(), 4242);
    expect(releaseIt(s)).toBe(true);

    expect(s.due().map((r) => r.id)).not.toContain('turn-1');
    expect(s.claim('turn-1', 9999)).toBeNull();
    expect(s.get('turn-1')?.status).toBe('continuable');
  });

  it('finds eligible rows per conversation, matching the speaker by fields', () => {
    const s = store();
    s.create(spec({ id: 'a', sessionId: 'owner' }), 1);
    s.create(spec({ id: 'b', sessionId: 'owner' }), 1);
    s.create(spec({ id: 'other-session', sessionId: 'altra' }), 1);
    for (const id of ['a', 'b', 'other-session']) {
      const rec = s.get(id);
      s.releaseContinuable(id, { messages: [], taint: 0, counters: spec().counters, reason }, rec?.claimToken ?? null);
    }
    // Key order in stored JSON must never split one speaker in two.
    const shuffled: Principal = { externalId: 'local', connector: 'cli', kind: 'owner' };
    const found = s.continuableFor('owner', shuffled, '2026-01-01T00:00:00.000Z');
    expect(found.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(s.continuableFor('owner', owner, '2999-01-01T00:00:00.000Z')).toEqual([]);
    const stranger: Principal = { kind: 'member', connector: 'cli', tenantId: 'x', externalId: 'local' };
    expect(s.continuableFor('owner', stranger, '2026-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('a terminal finish closes the current lease audit in the same write', () => {
    const s = store();
    const created = s.create(spec(), 4242);
    // Allowance 2 (spec), one retry spent: derived used is 1, from the
    // persisted open row — no caller-supplied summary anywhere.
    const counters = { ...spec().counters, toolCallsMade: 16, transportRetriesLeft: 1, contextBuilt: true };
    expect(s.finish('turn-1', { outcome: 'answered', messages: [], taint: 0, counters }, created.claimToken)).toBe(true);
    const leases = s.leasesFor('turn-1');
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ leaseIndex: 0, outcome: 'answered', transportUsed: 1, transportAllowance: 2 });
    expect(leases[0]?.counters).toMatchObject({ toolCallsMade: 16 });
    // And the terminal fold lands in the same write: stored equals recomputed.
    expect(s.get('turn-1')?.lifetime).toEqual(s.recomputeLifetime('turn-1'));
    expect(s.get('turn-1')?.lifetime).toMatchObject({ leases: 1, toolCallsMade: 16, transportRetriesUsed: 1 });
  });

  it('stored lifetime always equals the recomputed fold across grant and finish', () => {
    const s = store();
    s.create(spec(), 4242);
    expect(releaseIt(s)).toBe(true);
    const granted = grantIt(s);
    if (granted === null) throw new Error('grant failed');
    // Lease 2 does work, then finishes terminally. The finish derives its
    // close from these exact counters — there is no second input to disagree.
    const worked = { ...granted.counters, toolCallsMade: 4, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    expect(s.finish('turn-1', { outcome: 'answered', messages: granted.messages, taint: 0, counters: worked }, granted.claimToken)).toBe(
      true,
    );
    const final = s.get('turn-1');
    expect(final?.lifetime).toEqual(s.recomputeLifetime('turn-1'));
    expect(final?.lifetime).toMatchObject({ leases: 2, toolCallsMade: 4 });
    expect(s.leasesFor('turn-1')).toHaveLength(2);
  });

  it('a refused grant writes nothing: no lease row, no lifetime movement', () => {
    const s = store();
    s.create(spec(), 4242);
    expect(releaseIt(s)).toBe(true);
    expect(grantIt(s)).not.toBeNull();
    const before = s.get('turn-1');
    expect(grantIt(s)).toBeNull();
    const after = s.get('turn-1');
    expect(s.leasesFor('turn-1')).toHaveLength(2);
    expect(after?.lifetime).toEqual(before?.lifetime);
    expect(after?.leaseIndex).toBe(1);
  });

  it('a finish on a row that never ran folds nothing and closes nothing', () => {
    const s = store();
    const created = s.create(spec(), 4242);
    expect(s.finish('turn-1', { outcome: 'budget', messages: [], taint: 0, counters: spec().counters }, created.claimToken)).toBe(
      true,
    );
    // The lease-0 open row from creation is still open (never closed), the
    // fold sees no finished lease, lifetime stays zero.
    const leases = s.leasesFor('turn-1');
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ leaseIndex: 0, endedAt: null, outcome: null });
    expect(s.get('turn-1')?.lifetime).toMatchObject({ leases: 0, toolCallsMade: 0 });
    expect(s.get('turn-1')?.lifetime).toEqual(s.recomputeLifetime('turn-1'));
  });

  it('reset contract: every field class behaves exactly once across two leases', () => {
    // The Incident-A shape at store level: lease 0 ends with full counters.
    const lease0 = {
      ...spec().counters,
      iterations: 19,
      recoveriesUsed: 5,
      transportRetriesLeft: 7,
      toolCallsMade: 16,
      nudgedForCompletion: true,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 5 },
      spentUsd: 1.5,
      resumes: 2,
      contextBuilt: true,
      activeModelMs: 394201,
    };
    const s = store();
    // Allowance 10: the open row records what the lease started with.
    s.create(spec({ counters: { ...spec().counters, transportRetriesLeft: 10, contextBuilt: true } }), 4242);
    const running = s.get('turn-1');
    expect(
      s.releaseContinuable(
        'turn-1',
        { messages: [], taint: 3, counters: lease0, reason },
        running?.claimToken ?? null,
      ),
    ).toBe(true);
    // Release folded lease 0 exactly once.
    expect(s.get('turn-1')?.lifetime).toEqual(s.recomputeLifetime('turn-1'));
    expect(s.get('turn-1')?.lifetime).toMatchObject({
      leases: 1,
      toolCallsMade: 16,
      recoveriesUsed: 5,
      transportRetriesUsed: 3,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 5 },
      spentUsd: 1.5,
      activeModelMs: 394201,
    });

    // Grant: lease-local capacity fresh, everything else preserved.
    const fresh: TurnCounters = {
      iterations: 19,
      recoveriesUsed: 0,
      transportRetriesLeft: 10,
      toolCallsMade: 0,
      nudgedForCompletion: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0,
      resumes: 2,
      contextBuilt: true,
      activeModelMs: 0,
    };
    const granted = grantIt(s, 'turn-1', fresh);
    if (granted === null) throw new Error('grant failed');
    expect(granted.counters).toEqual(fresh);
    expect(granted.leaseIndex).toBe(1);
    // No double fold at grant: lifetime is still exactly lease 0.
    expect(granted.lifetime).toEqual(s.recomputeLifetime('turn-1'));
    expect(granted.lifetime).toMatchObject({ leases: 1, toolCallsMade: 16 });

    // Lease 1 works and finishes: each lease lands in lifetime exactly once.
    const lease1: TurnCounters = {
      ...fresh,
      iterations: 25,
      recoveriesUsed: 1,
      transportRetriesLeft: 9,
      toolCallsMade: 5,
      nudgedForCompletion: true,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0.5,
      activeModelMs: 60000,
    };
    expect(
      s.finish('turn-1', { outcome: 'answered', messages: [], taint: 3, counters: lease1 }, granted.claimToken),
    ).toBe(true);
    const final = s.get('turn-1');
    expect(final?.lifetime).toEqual(s.recomputeLifetime('turn-1'));
    expect(final?.lifetime).toEqual({
      leases: 2,
      toolCallsMade: 21,
      recoveriesUsed: 6,
      transportRetriesUsed: 4,
      usage: { inputTokens: 1100, outputTokens: 220, cacheReadTokens: 50, cacheWriteTokens: 5 },
      spentUsd: 2,
      activeModelMs: 454201,
    });
    // Cumulative stays on the row, out of the rollup; crash budget untouched.
    expect(final?.counters.iterations).toBe(25);
    expect(final?.counters.resumes).toBe(2);
    expect(final?.counters.nudgedForCompletion).toBe(true);
  });

  it('health counts continuable work like waiting: owed, unwindowed', () => {
    const s = store();
    s.create(spec(), 4242);
    expect(s.health().continuable.count).toBe(0);
    expect(releaseIt(s)).toBe(true);
    expect(s.health().continuable.count).toBe(1);
    expect(s.health().continuable.oldest).not.toBeNull();
  });

  it('migrates a pre-continuable database without losing a row', () => {
    const db = new DatabaseCtor(':memory:');
    // The table as the previous slice left it: no continuable status, no
    // lease columns. Built by hand so this test fails if the copy drifts.
    db.exec(`CREATE TABLE turns (
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, surface TEXT NOT NULL,
      session_id TEXT NOT NULL, model TEXT NOT NULL, messages TEXT NOT NULL,
      taint INTEGER NOT NULL CHECK (taint BETWEEN 0 AND 3), counters TEXT NOT NULL, reply_to TEXT,
      job_id TEXT, status TEXT NOT NULL CHECK (status IN ('runnable','running','waiting','interrupted','done')),
      wake_at TEXT, wait_for TEXT, claimed_by INTEGER, claimed_at TEXT, claim_token TEXT,
      turn_outcome TEXT, delivery TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    const counters = JSON.stringify(spec().counters);
    db.prepare(
      `INSERT INTO turns (id, principal, tenant, surface, session_id, model, messages, taint, counters, status, created_at, updated_at)
       VALUES ('vecchio', ?, 'host', 'cli', 's1', 'm', '[]', 3, ?, 'done', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run(JSON.stringify(owner), counters);

    const s = new TurnStore(db, () => new Date(), () => true);
    const rec = s.get('vecchio');
    expect(rec).toMatchObject({ status: 'done', taint: 3, leaseIndex: 0, continuableReason: null });
    expect(rec?.lifetime).toMatchObject({ leases: 0, toolCallsMade: 0 });
    expect(rec?.counters.toolCallsMade).toBe(0);
    // And the migrated table takes continuable rows from here on.
    s.create(spec({ id: 'nuovo' }), 7);
    const created = s.get('nuovo');
    expect(
      s.releaseContinuable('nuovo', { messages: [], taint: 0, counters: spec().counters, reason }, created?.claimToken ?? null),
    ).toBe(true);
    expect(s.get('nuovo')?.status).toBe('continuable');
  });

  it('migration copies every populated column byte-intact, keeps tool rows and indexes', () => {
    const db = new DatabaseCtor(':memory:');
    db.exec(`CREATE TABLE turns (
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, surface TEXT NOT NULL,
      session_id TEXT NOT NULL, model TEXT NOT NULL, messages TEXT NOT NULL,
      taint INTEGER NOT NULL CHECK (taint BETWEEN 0 AND 3), counters TEXT NOT NULL, reply_to TEXT,
      job_id TEXT, status TEXT NOT NULL CHECK (status IN ('runnable','running','waiting','interrupted','done')),
      wake_at TEXT, wait_for TEXT, claimed_by INTEGER, claimed_at TEXT, claim_token TEXT,
      turn_outcome TEXT, delivery TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE turn_tool_calls (
      turn_id TEXT NOT NULL, call_id TEXT NOT NULL, tool TEXT NOT NULL, capability TEXT NOT NULL,
      rerunnable INTEGER NOT NULL, args_digest TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
      content TEXT, is_error INTEGER, tier INTEGER, undone_at TEXT,
      effect_row TEXT, reversible TEXT, resource TEXT, decision TEXT,
      PRIMARY KEY (turn_id, call_id)
    );
    CREATE INDEX idx_turns_status ON turns(status, updated_at);
    CREATE INDEX idx_turns_due ON turns(status, wake_at);`);
    const messages = JSON.stringify([
      { role: 'user', content: [{ type: 'text', text: 'fai' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'penso', signature: 'sig' },
          { type: 'tool_use', id: 'c1', name: 'fs_read', input: { path: 'segreto.txt' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'contenuto-segreto' }] },
    ]);
    const counters = JSON.stringify({ ...spec().counters, toolCallsMade: 3, activeModelMs: 12345 });
    db.prepare(
      `INSERT INTO turns (id, principal, tenant, surface, session_id, model, messages, taint, counters,
                          reply_to, job_id, status, wake_at, wait_for, claimed_by, claimed_at, claim_token,
                          turn_outcome, delivery, created_at, updated_at)
       VALUES ('pieno', ?, 'host', 'cli', 's1', 'qwen/x', ?, 3, ?, ?, 'job-9', 'waiting',
               '2026-09-18T18:00:00.000Z', 'approval:abc', 4242, '2026-09-18T17:00:00.000Z', 'tok-1',
               NULL, 'pending', '2026-09-18T17:00:00.000Z', '2026-09-18T17:01:00.000Z')`,
    ).run(JSON.stringify(owner), messages, counters, JSON.stringify({ chatId: 1 }));
    db.prepare(
      `INSERT INTO turn_tool_calls (turn_id, call_id, tool, capability, rerunnable, args_digest, started_at,
                                    ended_at, content, is_error, tier, effect_row, reversible, resource, decision)
       VALUES ('pieno', 'c1', 'fs_read', 'fs.read', 1, 'abcd', '2026-09-18T17:00:10.000Z',
               '2026-09-18T17:00:11.000Z', 'contenuto-segreto', 0, 2, 'row', 'yes', 'segreto.txt', 'allow')`,
    ).run();

    const before = db.prepare(`SELECT * FROM turns WHERE id = 'pieno'`).get() as Record<string, unknown>;
    const s = new TurnStore(db, () => new Date(), () => true);
    const after = db.prepare(`SELECT * FROM turns WHERE id = 'pieno'`).get() as Record<string, unknown>;
    // Every pre-existing column byte-identical; only the three additive
    // columns differ (defaults), plus the CHECK.
    for (const col of Object.keys(before)) expect(after[col]).toBe(before[col]);
    expect(after).toMatchObject({ lease_index: 0, continuable_reason: null, lifetime: null });
    const rec = s.get('pieno');
    expect(rec).toMatchObject({ status: 'waiting', taint: 3, model: 'qwen/x', jobId: 'job-9', delivery: 'pending' });
    expect(rec?.messages).toHaveLength(3);
    expect(rec?.counters).toMatchObject({ toolCallsMade: 3, activeModelMs: 12345 });
    // Tool WAL untouched.
    expect(s.recordedOutcomes('pieno').get('c1')).toMatchObject({ content: 'contenuto-segreto', isError: false });
    // Indexes rebuilt, no leftover staging table, new status in the CHECK.
    const objects = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'turn%' OR name LIKE 'idx_turn%'`).all() as {
      type: string;
      name: string;
      sql: string;
    }[];
    const names = objects.map((o) => o.name).sort();
    expect(names).toEqual(['idx_turn_leases_turn', 'idx_turn_tool_calls_open', 'idx_turn_tool_calls_started', 'idx_turns_due', 'idx_turns_status', 'turn_leases', 'turn_tool_calls', 'turns']);
    expect(objects.find((o) => o.name === 'turns')?.sql).toContain("'continuable'");
  });

  it('a half-finished rebuild (stray turns_new) recovers with data intact', () => {
    const db = new DatabaseCtor(':memory:');
    db.exec(`CREATE TABLE turns (
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, surface TEXT NOT NULL,
      session_id TEXT NOT NULL, model TEXT NOT NULL, messages TEXT NOT NULL,
      taint INTEGER NOT NULL, counters TEXT NOT NULL, reply_to TEXT,
      job_id TEXT, status TEXT NOT NULL CHECK (status IN ('runnable','running','waiting','interrupted','done')),
      wake_at TEXT, wait_for TEXT, claimed_by INTEGER, claimed_at TEXT, claim_token TEXT,
      turn_outcome TEXT, delivery TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE turns_new (id TEXT PRIMARY KEY, mezza TEXT);`);
    db.prepare(
      `INSERT INTO turns (id, principal, tenant, surface, session_id, model, messages, taint, counters, status, created_at, updated_at)
       VALUES ('sopravvissuto', ?, 'host', 'cli', 's1', 'm', '[]', 0, ?, 'done', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run(JSON.stringify(owner), JSON.stringify(spec().counters));

    const s = new TurnStore(db, () => new Date(), () => true);
    expect(s.get('sopravvissuto')?.status).toBe('done');
    const leftover = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'turns_new'`).get();
    expect(leftover).toBeUndefined();
  });

  it('a locked database fails the migration loudly and keeps old rows readable after', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-migrate-'));
    const path = join(dir, 'muffin.db');
    const setup = new DatabaseCtor(path);
    setup.exec(`CREATE TABLE turns (
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, surface TEXT NOT NULL,
      session_id TEXT NOT NULL, model TEXT NOT NULL, messages TEXT NOT NULL,
      taint INTEGER NOT NULL, counters TEXT NOT NULL, reply_to TEXT,
      job_id TEXT, status TEXT NOT NULL CHECK (status IN ('runnable','running','waiting','interrupted','done')),
      wake_at TEXT, wait_for TEXT, claimed_by INTEGER, claimed_at TEXT, claim_token TEXT,
      turn_outcome TEXT, delivery TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    setup.prepare(
      `INSERT INTO turns (id, principal, tenant, surface, session_id, model, messages, taint, counters, status, created_at, updated_at)
       VALUES ('bloccato', ?, 'host', 'cli', 's1', 'm', '[]', 0, ?, 'done', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run(JSON.stringify(owner), JSON.stringify(spec().counters));
    // EXCLUSIVE held by another connection: the opener cannot migrate.
    setup.exec('BEGIN EXCLUSIVE');
    const locked = new DatabaseCtor(path);
    expect(() => new TurnStore(locked, () => new Date(), () => true)).toThrow();
    locked.close();
    setup.exec('ROLLBACK');
    // Nothing half-written: the old table answers, and the retry migrates.
    expect((setup.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n).toBe(1);
    const s = new TurnStore(new DatabaseCtor(path), () => new Date(), () => true);
    expect(s.get('bloccato')?.status).toBe('done');
    expect(s.get('bloccato')?.leaseIndex).toBe(0);
    setup.close();
  });

  it('read-only handles diagnose an old database without migrating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-readonly-'));
    const path = join(dir, 'muffin.db');
    const setup = new DatabaseCtor(path);
    setup.exec(`CREATE TABLE turns (
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, surface TEXT NOT NULL,
      session_id TEXT NOT NULL, model TEXT NOT NULL, messages TEXT NOT NULL,
      taint INTEGER NOT NULL, counters TEXT NOT NULL, reply_to TEXT,
      job_id TEXT, status TEXT NOT NULL CHECK (status IN ('runnable','running','waiting','interrupted','done')),
      wake_at TEXT, wait_for TEXT, claimed_by INTEGER, claimed_at TEXT, claim_token TEXT,
      turn_outcome TEXT, delivery TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE turn_tool_calls (
      turn_id TEXT NOT NULL, call_id TEXT NOT NULL, tool TEXT NOT NULL, capability TEXT NOT NULL,
      rerunnable INTEGER NOT NULL, args_digest TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
      content TEXT, is_error INTEGER, tier INTEGER, undone_at TEXT,
      effect_row TEXT, reversible TEXT, resource TEXT, decision TEXT,
      PRIMARY KEY (turn_id, call_id)
    )`);
    setup.prepare(
      `INSERT INTO turns (id, principal, tenant, surface, session_id, model, messages, taint, counters, status, created_at, updated_at)
       VALUES ('vecchio', ?, 'host', 'cli', 's1', 'm', '[]', 0, ?, 'done', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run(JSON.stringify(owner), JSON.stringify(spec().counters));
    setup.close();

    const ro = new DatabaseCtor(path, { readonly: true });
    const before = (ro.prepare(`SELECT sql FROM sqlite_master WHERE name = 'turns'`).get() as { sql: string }).sql;
    const health = readTurnHealth(ro);
    expect(health?.total).toBe(1);
    expect(health?.continuable.count).toBe(0);
    // Untouched: same CHECK, no lease table, no additive columns.
    const afterDb = new DatabaseCtor(path);
    const after = (afterDb.prepare(`SELECT sql FROM sqlite_master WHERE name = 'turns'`).get() as { sql: string }).sql;
    expect(after).toBe(before);
    expect(afterDb.prepare(`SELECT name FROM sqlite_master WHERE name = 'turn_leases'`).get()).toBeUndefined();
    expect(afterDb.prepare(`PRAGMA table_info(turns)`).all() as { name: string }[]).not.toContainEqual(
      expect.objectContaining({ name: 'lifetime' }),
    );
    ro.close();
    afterDb.close();
  });
});
