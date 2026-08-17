import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../agent/providers/types.js';
import { HARD_STALE_MULTIPLIER } from '../lock/durable.js';
import type { Principal } from '../policy/types.js';
import { TURN_STALE_AFTER_MS, TurnStore, describeInterrupted, readTurnHealth, type NewTurn } from './store.js';

/**
 * The row, and the four things it exists to hold that nothing else can.
 *
 * Each of these is a property the design (`research/turno-sospendibile.md`)
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
    s.startToolCall('turn-1', { callId: 'c1', tool: 'http_get', capability: 'sys.http', rerunnable: true, args: { url: 'https://x' } });
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
    s.startToolCall('turn-1', { callId: 'c1', tool: 'http_get', capability: 'sys.http', rerunnable: true, args: {} });
    s.endToolCall('turn-1', 'c1', { content: 'body', isError: false, tier: 3 });
    s.startToolCall('turn-1', { callId: 'c2', tool: 'fs_read', capability: 'fs.read', rerunnable: true, args: {} });
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

  it('a turn nobody has to deliver to has no delivery that can fail', () => {
    const s = store();
    s.create(spec());
    expect(s.get('turn-1')?.replyTo).toBeNull();
    expect(s.get('turn-1')?.delivery).toBeNull();
  });
});

describe('reclaiming what a dead process was holding', () => {
  it('marks the row interrupted and names the calls that may have landed', () => {
    const s = store(() => false);
    s.create(spec(), 99999);
    s.startToolCall('turn-1', { callId: 'c1', tool: 'fs_read', capability: 'fs.read', rerunnable: true, args: {} });
    s.endToolCall('turn-1', 'c1', { content: 'ok', isError: false, tier: 0 });
    // Intent, no outcome: the process died between the two.
    s.startToolCall('turn-1', { callId: 'c2', tool: 'shell_run', capability: 'sys.shell', rerunnable: false, args: { command: 'send-mail' } });

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
    s.startToolCall('turn-1', { callId: 'c1', tool: 'shell_run', capability: 'sys.shell', rerunnable: false, args: {} });
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
