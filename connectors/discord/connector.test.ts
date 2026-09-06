import DatabaseCtor from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMessage, principalFor, type ConnectorDeps, DiscordConnector } from './connector.js';
import { DiscordInbox } from './inbox.js';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../../agent/runtime.js';
import type { LoopDeps } from '../../agent/loop.js';
import { makeWaitTool } from '../../agent/tools/wait.js';
import type { Provider } from '../../agent/providers/types.js';
import { CONSERVATIVE } from '../../agent/profiles/profile.js';
import { SessionStore } from '../../core/session/store.js';
import { TurnStore, type DeliveryState } from '../../core/turns/store.js';
import { TodoStore } from '../../core/turns/todo.js';
import type { DiscordApi, DiscordMessage } from './api.js';

/**
 * A real `TurnStore`, not a hand-rolled fake with `create: () => {}`.
 *
 * `agent/loop.ts`'s `drive()` (`slice/turno-sospeso`) rebuilds `TurnInput` from
 * the **return value** of `turns.create(...)`, not from the caller's own
 * `input` — one body for a fresh turn and a resumed one, because two would
 * drift. A fake that returns `undefined` from `create` was invisible while
 * `drive` still read off `input`; merged with that slice, every turn in this
 * file threw `Cannot read properties of undefined (reading 'principal')`
 * before ever reaching the model — the connector's own `try` around
 * `runTurn` swallowed it as a failed turn, so `h.sent` stayed empty and read
 * as "never answered" instead of the real cause. A real store is what every
 * comparable test in this repo already uses (`connectors/telegram/turn-record.test.ts`,
 * `core/turns/lane.test.ts`) for exactly this reason: the contract a fake has
 * to honour is `TurnStore`'s real one, and a hand-written stub drifts from it
 * silently.
 */
function fakeTurns(delivered: [string, DeliveryState][]): LoopDeps['turns'] {
  const store = new TurnStore(new DatabaseCtor(':memory:'));
  // `delivered` shadows the prototype method on this one instance so the
  // tests below can still assert on what was recorded, without re-deriving it
  // from a second `store.get(id)` read.
  store.delivered = (id: string, state: DeliveryState): void => {
    delivered.push([id, state]);
    TurnStore.prototype.delivered.call(store, id, state);
  };
  return store;
}

/**
 * The two decisions this file makes that nothing downstream can correct: what
 * counts as a message, and who is speaking — the Discord half of
 * `connectors/telegram/connector.test.ts`. Identity's own guarantees live in
 * `impersonation.test.ts`; this file is parsing mechanics and the connector's
 * own durability/delivery behaviour.
 */

const OWNER = '888000000000000001';

describe('reading a MESSAGE_CREATE dispatch', () => {
  it('reads a plain DM', () => {
    const parsed = parseMessage({ id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: 'ciao' });
    expect(parsed).toMatchObject({ channelId: '42', text: 'ciao', fromId: OWNER, messageId: '1', direct: true });
  });

  it('carries the first attachment when there is one, text or not', () => {
    const withText = parseMessage({
      id: '1',
      channel_id: '42',
      channel_type: 1,
      author: { id: OWNER, bot: false },
      content: 'guarda',
      attachments: [{ id: 'a1', filename: 'nota.pdf', size: 10, url: 'https://cdn/x' }],
    });
    expect(withText?.attachment?.filename).toBe('nota.pdf');

    // A file with no text is still a complete thought — same rule as Telegram.
    const noText = parseMessage({
      id: '2',
      channel_id: '42',
      channel_type: 1,
      author: { id: OWNER, bot: false },
      content: '',
      attachments: [{ id: 'a1', filename: 'nota.pdf', size: 10, url: 'https://cdn/x' }],
    });
    expect(noText).not.toBeNull();
    expect(noText?.text).toBe('');
  });

  it('skips what it cannot handle instead of guessing', () => {
    expect(parseMessage({ id: '1', channel_id: '42', channel_type: 1, content: 'ciao' })).toBeNull(); // no author
    expect(parseMessage({ id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: '' })).toBeNull(); // no text, no attachment
    expect(parseMessage({ id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: '   ' })).toBeNull(); // whitespace only
    expect(
      parseMessage({ id: '1', channel_id: '42', guild_id: '9', channel_type: 0, author: { id: OWNER, bot: false }, content: 'ciao' }),
    ).toBeNull(); // guild — out of scope for this slice
    expect(
      parseMessage({ id: '1', channel_id: '42', channel_type: 3, author: { id: OWNER, bot: false }, content: 'ciao' }),
    ).toBeNull(); // GROUP_DM (D1) — no guild_id either, but not a one-to-one DM
    expect(parseMessage({ id: '1', channel_id: '42', author: { id: OWNER, bot: false }, content: 'ciao' })).toBeNull(); // channel_type absent — fail-closed, not assumed DM
    expect(parseMessage({ id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: true }, content: 'ciao' })).toBeNull(); // a bot, including this one
    expect(parseMessage({ id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, system: true }, content: 'ciao' })).toBeNull(); // Discord's own system messages
  });

  it('does not decide who the owner is', () => {
    const parsed = parseMessage({ id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: 'ciao' })!;
    expect(Object.keys(parsed)).not.toContain('isOwner');
  });
});

describe('who is speaking', () => {
  it('gives the owner the host tenant with a DM', () => {
    const parsed = parseMessage({ id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: 'ciao' })!;
    expect(principalFor(parsed, OWNER)).toEqual({
      principal: { kind: 'owner', connector: 'discord', externalId: OWNER },
      tenant: 'host',
      // La stessa che produce Telegram per lo stesso owner: una conversazione
      // sola attraverso le porte (ADR-0056).
      sessionKey: 'owner',
    });
  });
});

function harness(over: { attachment?: { filename: string; content: string }; suspend?: boolean; inPausa?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-discord-connector-'));
  const sent: { channelId: string; text: string }[] = [];
  const delivered: [string, DeliveryState][] = [];
  const reindexed: { tenantId: string; path: string; tier: number }[] = [];

  const api = {
    sendMessage: async (channelId: string, text: string) => {
      sent.push({ channelId, text });
      return {} as never;
    },
    typing: async () => undefined,
    download: async () => Buffer.from(over.attachment?.content ?? ''),
  } as unknown as DiscordApi;

  const turns = fakeTurns(delivered);
  const loop = {
    provider: {
      kind: 'openai-compat' as const,
      chat: async () => ({
        // `suspend`: the model asks to wait on its first call, which parks the
        // turn inside `runTurn` (`stopped: 'suspended'`, empty text).
        text: over.suspend ? '' : 'fatto',
        toolCalls: over.suspend ? [{ id: 'c1', name: 'wait', args: { seconds: 3600, why: 'aspetto' } }] : [],
        stopReason: over.suspend ? ('tool_use' as const) : ('end' as const),
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 't',
      }),
    },
    profile: CONSERVATIVE,
    model: 't',
    tools: over.suspend ? [makeWaitTool(turns)] : [],
    decide: () => ({ effect: 'allow' as const }),
    // A fresh id per call, not a shared constant: `deps.turns.create` now
    // persists a row keyed by `traceId` (`slice/turno-sospeso`), and `turns`
    // PRIMARY KEYs on `id` — two turns sharing one hardcoded id collided the
    // moment a real `TurnStore` sat behind this fake.
    tracer: { start: () => ({ traceId: randomUUID(), setAttributes: () => {}, end: () => {} }) },
    sessions: new SessionStore(home),
    turns,
    todos: new TodoStore(new DatabaseCtor(':memory:')),
    budgetExhausted: () => false,
    systemPrompts: { owner: 'x', group: 'x' },
  } as unknown as LoopDeps;

  const vaultRoot = mkdtempSync(join(tmpdir(), 'muffin-discord-vault-'));
  // `downloadToVault` writes into `<root>/inbox/`; production creates it once
  // in `cli/surface.ts` before the connector ever runs.
  mkdirSync(join(vaultRoot, 'inbox'), { recursive: true });
  const deps: ConnectorDeps = {
    loop,
    sessions: loop.sessions,
    inbox: new DiscordInbox(new DatabaseCtor(':memory:')),
    api,
    config: { token: 't', ownerUserId: OWNER },
    ...(over.inPausa === undefined ? {} : { pausa: { attiva: () => over.inPausa === true, metti: () => {}, togli: () => {} } }),
    vault: {
      root: vaultRoot,
      reindexPath: async (tenantId, path, tier) => {
        reindexed.push({ tenantId, path, tier });
        return { skipped: [], documents: [] };
      },
    },
  };
  const connector = new DiscordConnector(deps);
  return { connector, sent, delivered, reindexed, deps };
}

async function deliver(h: ReturnType<typeof harness>, messages: DiscordMessage[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: DiscordInbox } }).deps.inbox;
  for (const m of messages) inbox.accept(m.id, m, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('handling a DM end to end', () => {
  it('answers and records the delivery on the turn', async () => {
    const h = harness();
    await deliver(h, [{ id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: 'ciao' }]);

    expect(h.sent).toEqual([{ channelId: '42', text: 'fatto' }]);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.[1]).toBe('sent');
  });

  it('a suspended turn sends nothing and is not marked delivered', async () => {
    // Before the guard: `renderForDiscord('')` is `['(risposta vuota)']`, so a
    // parked turn produced a phantom reply and a `sent` record — found by the
    // integrated judge of the dev→main promotion (#44), between #41 and #42.
    const h = harness({ suspend: true });
    await deliver(h, [{ id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: 'aspetta' }]);
    expect(h.sent).toEqual([]);
    expect(h.delivered.map(([, state]) => state)).not.toContain('sent');
  });

  it('ingests an attachment into the vault before the turn runs, tagged with the sender tenant', async () => {
    const h = harness({ attachment: { filename: 'nota.txt', content: 'hello' } });
    await deliver(h, [
      {
        id: '1',
        channel_id: '42',
        channel_type: 1,
        author: { id: OWNER, bot: false },
        content: 'guarda',
        attachments: [{ id: 'a1', filename: 'nota.txt', size: 5, url: 'https://cdn/x' }],
      },
    ]);

    expect(h.reindexed).toHaveLength(1);
    expect(h.reindexed[0]?.tenantId).toBe('host'); // the owner's DM
    expect(h.reindexed[0]?.tier).toBe(0); // owner-sent, tier 0
  });
});

describe('durability — a message survives a failure mid-turn', () => {
  it('stays pending, not lost, when the turn throws', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-discord-fail-'));
    const inbox = new DiscordInbox(new DatabaseCtor(':memory:'));
    const loop = {
      provider: { kind: 'openai-compat' as const, chat: async () => { throw new Error('modello giù'); } },
      profile: CONSERVATIVE,
      model: 't',
      tools: [],
      decide: () => ({ effect: 'allow' as const }),
      // A fresh id per call — see `fakeTurns`'s docstring above.
      tracer: { start: () => ({ traceId: randomUUID(), setAttributes: () => {}, end: () => {} }) },
      sessions: new SessionStore(home),
      turns: fakeTurns([]),
      todos: new TodoStore(new DatabaseCtor(':memory:')),
      budgetExhausted: () => false,
      systemPrompts: { owner: 'x', group: 'x' },
    } as unknown as LoopDeps;
    const api = { sendMessage: async () => ({}) as never, typing: async () => undefined } as unknown as DiscordApi;
    const connector = new DiscordConnector({ loop, sessions: loop.sessions, inbox, api, config: { token: 't', ownerUserId: OWNER } });

    const raw: DiscordMessage = { id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: 'ciao' };
    inbox.accept(raw.id, raw, new Date().toISOString());
    await (connector as unknown as { drain: () => Promise<void> }).drain();

    // Not silently dropped: still pending, with the failure recorded, so the
    // next drain (a restart, or the next dispatch) tries again instead of the
    // message vanishing the way a Discord-side redelivery never happens on
    // its own (`inbox.ts`'s whole reason to exist).
    const pending = inbox.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.messageId).toBe('1');
  });
});

describe('concurrency — two dispatches close together (D2)', () => {
  it('does not double-answer when a second dispatch arrives mid-turn', async () => {
    // Reproduces the race directly: `onDispatch` calls `void this.drain()`
    // on every new arrival with nothing awaiting it. Without a guard, two
    // messages a few milliseconds apart start two concurrent walks of
    // `inbox.pending()` — the first message is still mid-turn (not yet
    // `markProcessed`) when the second walk reads the table, so it processes
    // the same row a second time in parallel with the first: 3 turns for 2
    // messages, one of them answered twice.
    const home = mkdtempSync(join(tmpdir(), 'muffin-discord-concurrency-'));
    const inbox = new DiscordInbox(new DatabaseCtor(':memory:'));
    const sent: { channelId: string; text: string }[] = [];
    let turns = 0;
    const loop = {
      provider: {
        kind: 'openai-compat' as const,
        chat: async () => {
          turns += 1;
          // Long enough that a second dispatch 5ms later still lands mid-turn —
          // the exact window the judge measured against the unguarded code.
          await new Promise((r) => setTimeout(r, 60));
          return {
            text: 'fatto',
            toolCalls: [],
            stopReason: 'end' as const,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            model: 't',
          };
        },
      },
      profile: CONSERVATIVE,
      model: 't',
      tools: [],
      decide: () => ({ effect: 'allow' as const }),
      // A fresh id per call — see `fakeTurns`'s docstring above.
      tracer: { start: () => ({ traceId: randomUUID(), setAttributes: () => {}, end: () => {} }) },
      sessions: new SessionStore(home),
      turns: fakeTurns([]),
      todos: new TodoStore(new DatabaseCtor(':memory:')),
      budgetExhausted: () => false,
      systemPrompts: { owner: 'x', group: 'x' },
    } as unknown as LoopDeps;
    const api = {
      sendMessage: async (channelId: string, text: string) => {
        sent.push({ channelId, text });
        return {} as never;
      },
      typing: async () => undefined,
    } as unknown as DiscordApi;
    const connector = new DiscordConnector({ loop, sessions: loop.sessions, inbox, api, config: { token: 't', ownerUserId: OWNER } });
    const drain = () => (connector as unknown as { drain: () => Promise<void> }).drain();

    const msg1: DiscordMessage = { id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: 'uno' };
    const msg2: DiscordMessage = { id: '2', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: 'due' };

    inbox.accept(msg1.id, msg1, new Date().toISOString());
    const p1 = drain(); // exactly what onDispatch does: fire-and-forget on a new arrival
    await new Promise((r) => setTimeout(r, 5)); // the 5ms gap the judge measured
    inbox.accept(msg2.id, msg2, new Date().toISOString());
    const p2 = drain(); // arrives while p1 is still mid-turn on msg1

    await Promise.all([p1, p2]);

    expect(turns).toBe(2); // not 3 — msg1 is never re-entered by the second call
    expect(sent).toHaveLength(2); // neither message answered twice
    expect(inbox.pending()).toHaveLength(0); // both settled, nothing stranded
  });
});

describe('boundary — a malformed payload never reaches the model (U1)', () => {
  it('discards a message whose id arrived as a number instead of a Discord snowflake string', async () => {
    // A real snowflake this large already lost precision the moment
    // `JSON.parse` read it as a bare number literal, before any type ever
    // looked at it — `data as DiscordMessage` / `JSON.parse(...) as
    // DiscordMessage` let it through typed `string` while it was, at
    // runtime, never one. `DiscordMessageSchema` requires `z.string()` and
    // does not coerce, so this payload fails validation instead of being
    // silently promoted with a corrupted id.
    const h = harness();
    const inbox = (h.connector as unknown as { deps: { inbox: DiscordInbox } }).deps.inbox;
    const corrupted = {
      id: 111111111111111111,
      channel_id: '42',
      channel_type: 1,
      author: { id: OWNER, bot: false },
      content: 'ciao',
    };
    inbox.accept('corrupted-1', corrupted, new Date().toISOString());
    await (h.connector as unknown as { drain: () => Promise<void> }).drain();

    expect(h.sent).toEqual([]); // never answered — never reached parseMessage/handle
    expect(inbox.pending()).toHaveLength(0); // marked processed, not retried forever
  });

  it('still answers a message whose id is a real, correctly-quoted large snowflake', async () => {
    // The schema must reject a numeric id without over-rejecting the normal
    // case: a real snowflake routinely exceeds Number.MAX_SAFE_INTEGER and is
    // still a perfectly ordinary string.
    const h = harness();
    const inbox = (h.connector as unknown as { deps: { inbox: DiscordInbox } }).deps.inbox;
    const big: DiscordMessage = {
      id: '111111111111111111',
      channel_id: '42',
      channel_type: 1,
      author: { id: OWNER, bot: false },
      content: 'ciao',
    };
    inbox.accept(big.id, big, new Date().toISOString());
    await (h.connector as unknown as { drain: () => Promise<void> }).drain();

    expect(h.sent).toEqual([{ channelId: '42', text: 'fatto' }]);
  });
});

describe('a discord turn records the SurfaceRegistry address (#41 stitching)', () => {
  it('writes channel: "discord:<channelId>" onto the durable replyTo', async () => {
    // The Discord half of connectors/telegram/turn-record.test.ts's own
    // assertion: `replyTo` used to carry Discord's own addressing
    // (channelId/messageId) with nothing saying which SurfaceRegistry entry
    // a future lane should deliver through. Real runtime, real turns table —
    // reads the row back, not the value handed to runTurn.
    const home = mkdtempSync(join(tmpdir(), 'muffin-discord-turnrec-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-discord-turnrec-ws-'));
    runInit({ home, apiKey: 'sk-discordrec-never-called' });
    const runtime = buildRuntime(home, workspace);
    const provider: Provider = {
      kind: 'openai-compat',
      chat: async () => ({
        text: 'ecco la risposta',
        toolCalls: [],
        stopReason: 'end' as const,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'test-model',
      }),
    };
    const loop: LoopDeps = { ...runtime.deps, provider };
    const api = { sendMessage: async () => ({}) as never, typing: async () => undefined } as unknown as DiscordApi;
    const inbox = new DiscordInbox(new DatabaseCtor(':memory:'));
    const connector = new DiscordConnector({
      loop,
      sessions: runtime.deps.sessions,
      inbox,
      api,
      config: { token: 't', ownerUserId: OWNER },
    });

    const raw: DiscordMessage = { id: '1', channel_id: '555', channel_type: 1, author: { id: OWNER, bot: false }, content: 'ciao' };
    inbox.accept(raw.id, raw, new Date().toISOString());
    await (connector as unknown as { drain: () => Promise<void> }).drain();

    const id = (runtime.db.prepare(`SELECT id FROM turns LIMIT 1`).get() as { id: string } | undefined)?.id;
    const row = id === undefined ? null : runtime.deps.turns.get(id);
    expect(row?.replyTo).toMatchObject({ channelId: '555', messageId: '1', channel: 'discord:555' });
    runtime.close();
  });
});

/**
 * ADR-0054 §4, through the `busy` stage of the shared router (slice 15).
 *
 * The one behaviour this slice adds. Before it, `/pause` — a durable,
 * cross-process fact (`core/runtime/pausa.ts`) that already stops the
 * scheduler, the turn lane and Telegram — did not exist for this connector:
 * a paused Muffin kept answering on Discord. It now says the same sentence
 * Telegram says, once, and leaves the message in the inbox.
 */
describe('in pausa, questa porta non parte (ADR-0054 §4)', () => {
  it('lo dice una volta sola, non chiama il modello, e lascia il messaggio nell inbox', async () => {
    const h = harness({ inPausa: true });
    const inbox = (h.connector as unknown as { deps: { inbox: DiscordInbox } }).deps.inbox;
    const raw: DiscordMessage = { id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: 'ciao' };
    inbox.accept(raw.id, raw, new Date().toISOString());

    await (h.connector as unknown as { drain: () => Promise<void> }).drain();
    // Byte per byte, la stessa frase di Telegram (`lane.ts`'s AVVISO_IN_PAUSA).
    expect(h.sent).toEqual([{ channelId: '42', text: '⏸ in pausa: lo leggo al /resume.' }]);
    expect(h.delivered).toEqual([]);
    // Niente di durevole: e' cio' che lo fa ri-drenare.
    expect(inbox.pending().map((m) => m.messageId)).toEqual(['1']);

    // Un secondo drain non ripete l'avviso allo stesso messaggio.
    await (h.connector as unknown as { drain: () => Promise<void> }).drain();
    expect(h.sent).toHaveLength(1);
  });

  it('senza pausa risponde come sempre', async () => {
    const h = harness({ inPausa: false });
    await deliver(h, [{ id: '1', channel_id: '42', channel_type: 1, author: { id: OWNER, bot: false }, content: 'ciao' }]);
    expect(h.sent).toEqual([{ channelId: '42', text: 'fatto' }]);
  });
});
