import DatabaseCtor from 'better-sqlite3';
import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecide } from '../../core/policy/decide.js';
import { POLICY_FLOOR } from '../../core/policy/matrix.js';
import { SessionStore } from '../../core/session/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';
import { TodoStore } from '../../core/turns/todo.js';
import { TurnStore } from '../../core/turns/store.js';
import type { LoopDeps } from '../../agent/loop.js';
import { CONSERVATIVE } from '../../agent/profiles/profile.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { parseUpdate, TelegramConnector, type Incoming, type TelegramConfig } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import { TelegramError, type TelegramApiLike } from './api.js';
import { TelegramDeliveryStore } from './delivery.js';
import { UpdateInbox, type StoredUpdate } from './updates.js';
import { providerMessages } from '../../agent/loop/provider-checkpoint.js';

/**
 * `slice/inbound-unit` — the fault matrix the owner named, verbatim: *"Ogni
 * `update_id` mappa a UNA sola identità durevole di turno. Dopo un crash
 * Muffin continua o conclude quella stessa identità: non crea un secondo
 * turno, non abbandona il primo, e non richiama modello o tool solo per
 * riconsegnare un risultato già computato."*
 *
 * `TelegramApi` is faked (no network, no real Bot API — `TelegramApi.baseUrl`
 * has no production override, the same reason B16 gives for testing at this
 * level instead of the acceptance harness's real binary); `drain`/`resolve`/
 * `resolveBound`/`runFresh`, `TurnStore` and `UpdateInbox` are all real.
 * `Scripted` (below) is the one thing every test's assertion counts: a model
 * call that should not have happened throws instead of silently answering.
 *
 * Two describe blocks: the first constructs each fault-matrix state directly
 * (mirrors `agent/scheduler-run.test.ts`'s own style — fast, one state per
 * test) against the real resolution code; the second drives fault points
 * 2/3/5 through a genuine crash window, using the same test-only stall seam
 * `agent/scheduler-run.ts` established (`MUFFIN_JOB_FIRES_STALL_*`, #76) —
 * `MUFFIN_TELEGRAM_INBOUND_STALL_*` here — under fake timers, so the "process
 * that died" is a promise whose continuation provably never runs rather than
 * a race hoped to land.
 */

const OWNER = 4242;

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  calls = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(_call?: ChatCall): Promise<ChatResult> {
    const next = this.script[this.calls++];
    if (!next) throw new Error('lo script è finito — il modello non doveva essere richiamato di nuovo');
    return next;
  }
}

const answer = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 'test',
});

/** `TurnCounters`, freshly — `agent/loop.ts`'s own `freshCounters` is not exported. */
function counters(): NonNullable<Parameters<TurnStore['create']>[0]>['counters'] {
  return {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 2,
    truncationsUsed: 0,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: false,
  };
}

const privateMsg = (id: number, text = 'ciao'): Update =>
  ({
    update_id: id,
    message: {
      message_id: id * 10,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      text,
    },
  }) as unknown as Update;

const privateMsgFrom = (id: number, senderId: number, text = 'ciao'): Update =>
  ({
    update_id: id,
    message: {
      message_id: id * 10,
      date: 0,
      chat: { id: senderId, type: 'private' },
      from: { id: senderId, is_bot: false, first_name: 'x' },
      text,
    },
  }) as unknown as Update;

function fixture(script: ChatResult[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-inbound-unit-'));
  const db = new DatabaseCtor(':memory:');
  const turns = new TurnStore(db);
  const todos = new TodoStore(db);
  const provider = new Scripted(script);
  const loop: LoopDeps = {
    provider,
    profile: CONSERVATIVE,
    model: 'test-model',
    tools: [],
    decide: createDecide({ matrix: POLICY_FLOOR, capabilities: new Map(), budgetExhausted: () => false, hardened: true }),
    capabilities: new Map(),
    tracer: new SimpleTracer(new JsonlExporter(home)),
    sessions: new SessionStore(home),
    turns,
    todos,
    budgetExhausted: () => false,
    systemPrompts: { owner: 'Sei Muffin.', group: 'Sei Muffin, ospite in un gruppo.' },
  };

  const sent: string[] = [];
  const sendMessage = vi.fn(async (_chatId: number, text: string) => {
    sent.push(`send:${text}`);
    return {} as never;
  });
  const editMessageText = vi.fn(async (_chatId: number, _id: number, text: string) => {
    sent.push(`edit:${text}`);
    return {} as never;
  });
  // `vi.fn()` even on the presence calls: the interleaving tests below need a
  // signal for "past `startPresence`'s own await chain, about to reach the
  // stall" that does not touch the database — `startPresence` only talks to
  // this fake API, never to a store.
  const sendChatAction = vi.fn(async () => true);
  const sendMessageDraft = vi.fn(async () => true);
  // Rich is the transport now; the fake records it in the same `sent` log.
  // Rich delegates to the legacy spies, so every existing assertion on
  // `sendMessage`/`editMessageText` keeps observing the same effect.
  const sendRichMessage = vi.fn((chatId: number, rich: { html?: string }) => sendMessage(chatId, rich.html ?? ''));
  const editMessageRichText = vi.fn((_chatId: number, _id: number, rich: { html?: string }) =>
    editMessageText(_chatId, _id, rich.html ?? ''),
  );
  const sendRichMessageDraft = vi.fn(async () => true);
  const api = {
    sendMessage,
    editMessageText,
    sendChatAction,
    sendMessageDraft,
    sendRichMessage,
    editMessageRichText,
    sendRichMessageDraft,
  } as unknown as TelegramApiLike;

  const inbox = new UpdateInbox(db);
  const delivery = new TelegramDeliveryStore(db);
  const config: TelegramConfig = { token: 't', ownerUserId: OWNER, ownerChatId: OWNER };
  const logged: string[] = [];
  const connector = new TelegramConnector({
    loop,
    sessions: loop.sessions,
    lane: new ModelLane(),
    inbox,
    delivery,
    api,
    config,
    log: (l) => logged.push(l),
  });

  return { connector, db, inbox, provider, turns, sent, sendMessage, editMessageText, sendMessageDraft, logged };
}

function acceptOne(h: ReturnType<typeof fixture>, update: Update, now = '2026-08-18T09:00:00Z'): { stored: StoredUpdate; incoming: Incoming } {
  h.inbox.accept([update as unknown as { update_id: number }], now);
  return { stored: h.inbox.get(update.update_id)!, incoming: parseUpdate(update)! };
}

/** `resolve` is private — the same entry point `drain()` calls per pending row. */
function resolveOnce(h: ReturnType<typeof fixture>, stored: StoredUpdate, incoming: Incoming): Promise<void> {
  return (h.connector as unknown as { resolve: (s: StoredUpdate, i: Incoming) => Promise<void> }).resolve(stored, incoming);
}

describe('resolve — a fresh update binds and runs exactly one turn', () => {
  it('retires the raw body once settled: downstream evidence first, stub second', async () => {
    const h = fixture([answer('ciao a te')]);
    const { stored, incoming } = acceptOne(h, privateMsg(1));

    await resolveOnce(h, stored, incoming);

    const row = h.inbox.get(1)!;
    // The turn ran and delivered — the durable downstream exists.
    expect(row.turnId).toBeTruthy();
    expect(h.turns.get(row.turnId!)?.delivery).toBe('sent');
    expect(h.sent).toEqual(['send:ciao a te']);
    // …and only then did the body retire: stub in place of bytes, every
    // evidence column intact, nothing left pending.
    expect(JSON.parse(row.payload)).toEqual({ scrubbed: true, update_id: 1 });
    expect(row.settledAt).toBeTruthy();
    expect(h.inbox.pending()).toHaveLength(0);
  });

  it('creates one turn, binds the update to it, sends once, settles, marks processed', async () => {
    const h = fixture([answer('ciao a te')]);
    const { stored, incoming } = acceptOne(h, privateMsg(1));

    await resolveOnce(h, stored, incoming);

    expect(h.provider.calls).toBe(1);
    expect(h.sent).toEqual(['send:ciao a te']);
    const row = h.inbox.get(1)!;
    expect(row.turnId).toBeTruthy();
    expect(row.settledAt).toBeTruthy();
    expect((h.db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n).toBe(1);
    expect(h.turns.get(row.turnId!)?.delivery).toBe('sent');
    expect(h.inbox.pending()).toHaveLength(0);
  });
});

describe('resolve — a private Telegram chat is owner-only', () => {
  it.each(['ciao', '/pause'])('silently consumes a non-owner DM (%s) before memory, commands, or the model', async (text) => {
    const h = fixture([answer('questa risposta non deve partire')]);
    const { stored, incoming } = acceptOne(h, privateMsgFrom(2, OWNER + 1, text));
    const remember = vi.spyOn(
      h.connector as unknown as {
        ricordaSenzaRispondere: (incoming: Incoming, log: (line: string) => void) => void;
      },
      'ricordaSenzaRispondere',
    );

    await resolveOnce(h, stored, incoming);

    expect(h.provider.calls).toBe(0);
    expect(remember).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.editMessageText).not.toHaveBeenCalled();
    expect(h.sendMessageDraft).not.toHaveBeenCalled();
    expect((h.db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n).toBe(0);
    expect(h.inbox.get(2)?.turnId).toBeNull();
    expect(h.inbox.pending()).toHaveLength(0);
    expect(h.inbox.get(2)?.payload).toBe('{}');
  });

  it('does not recover or redeliver a non-owner DM already bound by an older run', async () => {
    const h = fixture([answer('una vecchia risposta non va ripresa')]);
    const { incoming } = acceptOne(h, privateMsgFrom(3, OWNER + 1));
    h.inbox.bind(3, 'turn-from-permissive-run');
    const stored = h.inbox.get(3);
    if (!stored) throw new Error('update di test non presente nell’inbox');

    await resolveOnce(h, stored, incoming);

    expect(h.provider.calls).toBe(0);
    expect(h.sent).toEqual([]);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.inbox.pending()).toHaveLength(0);
    expect(h.inbox.get(3)?.payload).toBe('{}');
  });
});

describe('resolveBound — fault points 3/4: a turn still in flight defers, never a second turn', () => {
  it.each(['running', 'interrupted', 'waiting'] as const)(
    "an update bound to a turn that is still '%s' defers — no model call, no send, stays pending",
    async (status) => {
      const h = fixture([answer('non deve mai essere chiamato')]);
      const { stored, incoming } = acceptOne(h, privateMsg(1));
      const turnId = h.inbox.bind(1, `turn-${status}`);
      h.turns.create(
        {
          id: turnId,
          principal: { kind: 'owner', connector: 'telegram', externalId: String(OWNER) },
          tenant: 'host',
          surface: 'telegram',
          sessionId: `sess-${status}`,
          model: 'test-model',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
          taint: 0,
          counters: counters(),
          replyTo: { chatId: OWNER, messageId: 10, channel: `telegram:${OWNER}` },
        },
        99999,
      );
      if (status !== 'running') h.db.prepare(`UPDATE turns SET status = ? WHERE id = ?`).run(status, turnId);

      await resolveOnce(h, h.inbox.get(1)!, incoming);

      expect(h.provider.calls).toBe(0);
      expect(h.sent).toEqual([]);
      expect(h.inbox.get(1)?.settledAt).toBeNull();
      expect(h.inbox.pending()).toHaveLength(1); // still owed to the next drain, or the turn lane
    },
  );
});

describe('resolveBound — fault point 2: bound but the turn row is missing completes with the SAME id', () => {
  it('an update that arrives already bound (to any id) is always resolved through that id, never a competing one', async () => {
    const h = fixture([answer('completa il binding interrotto')]);
    const { incoming } = acceptOne(h, privateMsg(1));
    h.inbox.bind(1, 'turn-winner'); // bound, but never created

    await resolveOnce(h, h.inbox.get(1)!, incoming);

    expect(h.provider.calls).toBe(1);
    expect(h.turns.get('turn-winner')?.status).toBe('done');
    expect((h.db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n).toBe(1);
    expect(h.inbox.get(1)?.turnId).toBe('turn-winner');
  });
});

describe('resolveBound — fault point 6: the same update resolved twice never re-runs the model', () => {
  it('a live retry after a failed send redelivers the durable result instead of recomputing it', async () => {
    const h = fixture([answer('primo e unico giro')]);
    // Fail EVERY send for the first pass, rich and its legacy fallback alike:
    // a single rejection would be absorbed by the rich→legacy fallback and the
    // delivery would succeed.
    const originalSend = h.sendMessage.getMockImplementation()!;
    h.sendMessage.mockImplementation(async () => {
      throw new TelegramError(429, 'Too Many Requests', 1);
    });
    const { stored, incoming } = acceptOne(h, privateMsg(1));

    await expect(resolveOnce(h, stored, incoming)).rejects.toThrow('429');
    expect(h.provider.calls).toBe(1);
    expect(h.inbox.pending()).toHaveLength(1); // unchanged: stays pending, retried

    // The next drain reads the same row back — still bound to the turn the
    // first attempt already ran.
    h.sendMessage.mockImplementation(originalSend);
    await resolveOnce(h, h.inbox.get(1)!, incoming);

    expect(h.provider.calls).toBe(1); // never called twice
    expect(h.sent.filter((s) => s === 'send:primo e unico giro')).toHaveLength(1);
    expect(h.inbox.pending()).toHaveLength(0);
  });

  it('a response lost after Telegram accepted the send settles as possibly sent and is never retried', async () => {
    const h = fixture([answer('risposta accettata ma conferma persa')]);
    h.sendMessage.mockImplementationOnce(async (_chatId: number, text: string) => {
      // The remote side accepted the visible effect; only its HTTP response is
      // lost. Recording the acceptance before throwing is the load-bearing
      // distinction from the existing "failed before success" fixture.
      h.sent.push(`accepted:${text}`);
      throw new TypeError('response stream closed');
    });
    const { stored, incoming } = acceptOne(h, privateMsg(1));

    await resolveOnce(h, stored, incoming);
    await resolveOnce(h, h.inbox.get(1)!, incoming);

    expect(h.provider.calls).toBe(1);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual(['accepted:risposta accettata ma conferma persa']);
    expect(h.turns.get(h.inbox.get(1)!.turnId!)?.delivery).toBe('possibly_sent');
    expect(h.inbox.get(1)?.settledAt).toBeTruthy();
    expect(h.inbox.pending()).toHaveLength(0);
  });
});

describe('resolveBound — fault points 5/7: a turn already delivered settles without resending', () => {
  it('delivery already `sent` (an earlier pass, or an independent turn-lane delivery) settles without touching the model or the API', async () => {
    const h = fixture([answer('non deve mai essere chiamato')]);
    const { incoming } = acceptOne(h, privateMsg(1));
    const turnId = h.inbox.bind(1, 'turn-done-sent');
    const rec = h.turns.create(
      {
        id: turnId,
        principal: { kind: 'owner', connector: 'telegram', externalId: String(OWNER) },
        tenant: 'host',
        surface: 'telegram',
        sessionId: 'sess-sent',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
        taint: 0,
        counters: counters(),
        replyTo: { chatId: OWNER, messageId: 10, channel: `telegram:${OWNER}` },
      },
      99999,
    );
    h.turns.finish(rec.id, { outcome: 'answered', messages: providerMessages(rec), taint: 0, counters: rec.counters }, rec.claimToken);
    h.turns.delivered(rec.id, 'sent'); // some other pass already delivered it

    await resolveOnce(h, h.inbox.get(1)!, incoming);

    expect(h.provider.calls).toBe(0);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.inbox.get(1)?.settledAt).toBeTruthy();
    expect(h.inbox.pending()).toHaveLength(0);
  });

  it('delivery already `undeliverable` settles without resending and without relabelling it `sent`', async () => {
    const h = fixture([answer('non deve mai essere chiamato')]);
    const { incoming } = acceptOne(h, privateMsg(1));
    const turnId = h.inbox.bind(1, 'turn-undeliverable');
    const rec = h.turns.create(
      {
        id: turnId,
        principal: { kind: 'owner', connector: 'telegram', externalId: String(OWNER) },
        tenant: 'host',
        surface: 'telegram',
        sessionId: 'sess-undeliverable',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
        taint: 0,
        counters: counters(),
        replyTo: { chatId: OWNER, messageId: 10, channel: `telegram:${OWNER}` },
      },
      99999,
    );
    h.turns.finish(rec.id, { outcome: 'answered', messages: providerMessages(rec), taint: 0, counters: rec.counters }, rec.claimToken);
    h.turns.delivered(rec.id, 'undeliverable');

    await resolveOnce(h, h.inbox.get(1)!, incoming);

    expect(h.provider.calls).toBe(0);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.turns.get(turnId)?.delivery).toBe('undeliverable'); // not overwritten to 'sent'
    expect(h.inbox.pending()).toHaveLength(0);
  });

  it('delivery still `pending` (never attempted) recovers the text from the session file and delivers exactly once', async () => {
    const h = fixture([answer('non deve mai essere chiamato')]);
    const { incoming } = acceptOne(h, privateMsg(1));
    const turnId = h.inbox.bind(1, 'turn-crash-before-send');
    // The session file `drive` (`agent/loop.ts`) would have appended to, had
    // the turn actually run to completion in this process — written directly
    // here since this test constructs the "already done" state by hand.
    const connectorSessions = (h.connector as unknown as { deps: { sessions: SessionStore } }).deps.sessions;
    const sess = connectorSessions.open(`telegram:${OWNER}`);
    connectorSessions.append(sess, {
      role: 'assistant',
      content: 'la risposta che il crash non ha mai consegnato',
      surface: 'telegram',
      createdAt: new Date().toISOString(),
      traceId: turnId,
    });
    const rec = h.turns.create(
      {
        id: turnId,
        principal: { kind: 'owner', connector: 'telegram', externalId: String(OWNER) },
        tenant: 'host',
        surface: 'telegram',
        sessionId: sess.id,
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
        taint: 0,
        counters: counters(),
        replyTo: { chatId: OWNER, messageId: 10, channel: `telegram:${OWNER}` },
      },
      99999,
    );
    h.turns.finish(rec.id, { outcome: 'answered', messages: providerMessages(rec), taint: 0, counters: rec.counters }, rec.claimToken);
    // delivery is still 'pending' — nothing has told the channel yet.

    await resolveOnce(h, h.inbox.get(1)!, incoming);

    expect(h.provider.calls).toBe(0); // never called the model again
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual(['send:la risposta che il crash non ha mai consegnato']);
    expect(h.turns.get(turnId)?.delivery).toBe('sent');
    expect(h.inbox.pending()).toHaveLength(0);
  });

  it("delivery still `pending` but this update's own settle marker is already set does NOT resend — the residual `runFresh` names", async () => {
    // Simulates the exact crash window fault point 5 is hardest about:
    // `sendMessage` returned successfully and `inbox.settle` ran, but the
    // process died before `turns.delivered` recorded it.
    const h = fixture([answer('non deve mai essere chiamato')]);
    const { incoming } = acceptOne(h, privateMsg(1));
    const turnId = h.inbox.bind(1, 'turn-settled-not-recorded');
    const rec = h.turns.create(
      {
        id: turnId,
        principal: { kind: 'owner', connector: 'telegram', externalId: String(OWNER) },
        tenant: 'host',
        surface: 'telegram',
        sessionId: 'sess-settled-not-recorded',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ciao' }] }],
        taint: 0,
        counters: counters(),
        replyTo: { chatId: OWNER, messageId: 10, channel: `telegram:${OWNER}` },
      },
      99999,
    );
    h.turns.finish(rec.id, { outcome: 'answered', messages: providerMessages(rec), taint: 0, counters: rec.counters }, rec.claimToken);
    h.inbox.settle(1, '2026-08-18T09:05:00Z'); // the send already happened; only the bookkeeping did not land
    // delivery is still 'pending' on the turns row — that is the whole point.

    await resolveOnce(h, h.inbox.get(1)!, incoming);

    expect(h.provider.calls).toBe(0);
    expect(h.sendMessage).not.toHaveBeenCalled(); // no second message
    expect(h.turns.get(turnId)?.delivery).toBe('sent'); // bookkeeping repaired
    expect(h.inbox.pending()).toHaveLength(0);
  });
});

/**
 * Fault points 2, 3 and 5 against the real path, with a crash injected
 * between two writes — `docs/development/JUDGE.md`'s own bar for a CRITICAL claim.
 * `MUFFIN_TELEGRAM_INBOUND_STALL_*` widens the window `runFresh` already
 * names; fake timers make "the process died there" a promise whose
 * continuation is provably never scheduled, not a race hoped to land.
 *
 * The synchronisation is self-verifying rather than timing-shaped: `bind()`
 * happens inside `resolve()`, a full step *before* `runFresh` (and
 * `startPresence`, and the stall itself) ever runs, so "the update is bound"
 * is *not* proof the stalled call has reached the stall — a first version of
 * this file used that as its wait condition and produced exactly the
 * unbounded race this file exists to rule out (two calls both reaching
 * `runTurn`, one throwing `UNIQUE constraint failed` on `turns.id` — a
 * finding worth keeping, since it is the mutation this claim's own tests
 * would need to survive). So every test below drains a generous, fixed
 * budget of microtask ticks — cheap, since none of them are gated on a real
 * timer — and then *proves* the stalled call is still genuinely parked
 * (`stalledSettled` false, set only by the promise's own `.then`) before
 * treating any database state as the crash window.
 */
describe('resolve — fault points 2/3/5 against a real crash window (fake-timer stall, #76 precedent)', () => {
  afterEach(() => {
    delete process.env['MUFFIN_TELEGRAM_INBOUND_STALL_AFTER_BIND_MS'];
    delete process.env['MUFFIN_TELEGRAM_INBOUND_STALL_AFTER_DONE_MS'];
    vi.useRealTimers();
  });

  /**
   * Lets every already-scheduled microtask run, `n` times over. Never
   * advances the fake timer clock, so a call parked on `testStall`'s
   * `setTimeout` cannot progress no matter how large `n` is — only a real
   * `vi.advanceTimersByTime` (never called in this file) could do that.
   */
  async function drainTicks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  /** Fires `work`, and a flag `.then` sets regardless of outcome — the ground truth for "has this call finished yet", independent of tick counting. */
  function fireAndTrack(work: Promise<void>): { settled: () => boolean } {
    let settled = false;
    work.then(
      () => (settled = true),
      () => (settled = true),
    );
    return { settled: () => settled };
  }

  it('a crash between bind and turn-creation (2) is completed with the SAME id by the next pass, and the model runs exactly once (3)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    process.env['MUFFIN_TELEGRAM_INBOUND_STALL_AFTER_BIND_MS'] = '60000';

    const h = fixture([answer('completa il binding interrotto')]);
    const { stored, incoming } = acceptOne(h, privateMsg(1));

    // Fired, never awaited directly: parked on the fake timer for the rest of
    // this test — `stalled.settled()` proves it, below, rather than assuming it.
    const stalled = fireAndTrack(resolveOnce(h, stored, incoming));

    await drainTicks(2000);
    // Proof the call is genuinely still parked, not just "probably far enough
    // along": if the stall placement or the fake-timer wiring were wrong,
    // this is what would catch it, rather than a race silently resolving in
    // the expected order by luck.
    expect(stalled.settled()).toBe(false);
    const boundTurnId = h.inbox.get(1)!.turnId!;
    expect(boundTurnId).toBeTruthy();
    // The window fault point 2 names, observed directly: bound, but no turn
    // row exists yet.
    expect((h.db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n).toBe(0);

    // The "restart": a fresh pass over the same row — and, unlike the first
    // pass, one that is not itself being killed, so its own `runFresh` (fault
    // point 2's recovery calls `runFresh` again, with the SAME id) must not
    // hit the same stall a second time. The first call's continuation never
    // runs — proven above, not merely assumed — exactly a process that died
    // and did not come back.
    delete process.env['MUFFIN_TELEGRAM_INBOUND_STALL_AFTER_BIND_MS'];
    await resolveOnce(h, h.inbox.get(1)!, incoming);

    expect(h.provider.calls).toBe(1); // the model ran exactly once
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual(['send:completa il binding interrotto']);
    expect((h.db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n).toBe(1); // never a second, competing turn
    expect(h.turns.get(boundTurnId)?.id).toBe(boundTurnId);
    expect(h.inbox.get(1)?.turnId).toBe(boundTurnId); // same identity throughout
    expect(stalled.settled()).toBe(false); // still parked — never got a turn to run
  });

  it('a crash between turn-done and delivery (5) never sends a second message on the next pass', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    process.env['MUFFIN_TELEGRAM_INBOUND_STALL_AFTER_DONE_MS'] = '60000';

    const h = fixture([answer('non deve mai arrivare due volte')]);
    const { stored, incoming } = acceptOne(h, privateMsg(1));

    const stalled = fireAndTrack(resolveOnce(h, stored, incoming));

    await drainTicks(2000);
    expect(stalled.settled()).toBe(false); // proof, not assumption
    const boundTurnId = h.inbox.get(1)!.turnId!;
    // The window fault point 5 names: `done`, but delivery was never
    // attempted — the model ran, the API was never asked to send the answer.
    expect(h.provider.calls).toBe(1);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.turns.get(boundTurnId)?.status).toBe('done');
    expect(h.turns.get(boundTurnId)?.delivery).toBe('pending');

    delete process.env['MUFFIN_TELEGRAM_INBOUND_STALL_AFTER_DONE_MS'];
    await resolveOnce(h, h.inbox.get(1)!, incoming);

    expect(h.provider.calls).toBe(1); // never called twice
    // The strongest evidence against a duplicate message: the fake API's own
    // call log, not an inference from the database (docs/development/JUDGE.md).
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual(['send:non deve mai arrivare due volte']);
    expect(h.turns.get(boundTurnId)?.delivery).toBe('sent');
    expect(h.inbox.pending()).toHaveLength(0);
    expect(stalled.settled()).toBe(false); // still parked
  });
});

describe('resolve — "riprendi" continua la riga continuabile, non ne apre una', () => {
  /**
   * P0-B acceptance on the real connector path: a bare "riprendi" in the
   * owner's DM binds the update to the existing continuable row (no second
   * turn, no recomputation of settled work) and delivers the continued
   * answer through the normal stages.
   */
  it('binds the update to the old turn and delivers the continuation', async () => {
    const h = fixture([answer('continuo da dove ero rimasto')]);
    const created = h.turns.create(
      {
        id: 'vecchia-lease',
        principal: { kind: 'owner', connector: 'telegram', externalId: String(OWNER) },
        tenant: 'host',
        surface: 'telegram',
        sessionId: 'owner',
        model: 'test-model',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'fai' }] }],
        taint: 0,
        counters: {
          iterations: 3,
          recoveriesUsed: 5,
          transportRetriesLeft: 7,
          truncationsUsed: 0,
          toolCallsMade: 2,
          nudgedForCompletion: false,
          usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          spentUsd: 0,
          resumes: 0,
          contextBuilt: true,
          activeModelMs: 0,
        },
      },
      4242,
    );
    expect(
      h.turns.releaseContinuable(
        'vecchia-lease',
        {
          messages: providerMessages(created),
          taint: 0,
          counters: {
            iterations: 3,
            recoveriesUsed: 5,
            transportRetriesLeft: 7,
            truncationsUsed: 0,
            toolCallsMade: 2,
            nudgedForCompletion: false,
            usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            spentUsd: 0,
            resumes: 0,
            contextBuilt: true,
            activeModelMs: 0,
          },
          reason: { class: 'provider_empty' as const, lease: 0, at: '2026-09-18T17:14:09.000Z' },
        },
        created.claimToken,
      ),
    ).toBe(true);

    const { stored, incoming } = acceptOne(h, privateMsg(9, 'riprendi'));
    await resolveOnce(h, stored, incoming);

    // Same durable identity, new lease — and nothing else was created.
    const row = h.inbox.get(9)!;
    expect(row.turnId).toBe('vecchia-lease');
    const ids = (h.db.prepare(`SELECT id FROM turns`).all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(['vecchia-lease']);
    // One model call (the continuation itself), answer delivered, settled.
    expect(h.provider.calls).toBe(1);
    expect(h.sent).toEqual(['send:continuo da dove ero rimasto']);
    expect(h.turns.get('vecchia-lease')).toMatchObject({ status: 'done', outcome: 'answered', leaseIndex: 1 });
    expect(h.inbox.pending()).toHaveLength(0);
  });
});
