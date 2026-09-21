import DatabaseCtor from 'better-sqlite3';
import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../../agent/runtime.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatCall, ChatResult, Provider, StreamEvent } from '../../agent/providers/types.js';
import { TelegramConnector, type TelegramConfig } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import type { TelegramApiLike } from './api.js';
import { TelegramDeliveryStore } from './delivery.js';
import { UpdateInbox } from './updates.js';

/**
 * The real wiring, B11/B13 — through the actual `TelegramConnector.handle()`,
 * `buildRuntime`, and a scripted provider that streams, not a `Provider`
 * stub that only implements `chat()`. Same shape as `group-context.test.ts`'s
 * own proof for group prompts: the entry point production actually uses (an
 * `Update` off the wire, through `drain()` → `handle()` → `runTurn()`), so a
 * defect in the *composition* — `onDelta` never reaching `transcript.ts#live()`,
 * `transcript.stop()` racing `deliverTo` — shows up here even though each
 * piece is correct in isolation.
 *
 * **Since 2026-09-04 (`docs/evidence/turno-sospendibile.md`), one message per
 * turn, not two.** Before this date, `presence.ts` streamed the growing
 * answer into an ephemeral `sendMessageDraft` bubble while `transcript.ts`
 * sent the tool trail as a *separate* real message, and the durable answer
 * landed as a *third*, distinct `sendMessage` — measured on the owner's own
 * chat as a stray message id between the question and the answer on every
 * turn that used a tool. The scenarios below now assert the opposite of what
 * they asserted before that date: a tool-using turn produces **exactly one**
 * `sendMessage` a person would read, extended by edits, never a second
 * `sendMessage` for the answer.
 *
 * **Dal 06/09/2026 l'anteprima e' tornata, e solo in una DM.** La decisione
 * dell'owner e' che il difetto della PR #388 fosse il rinnovo mancante, non
 * la bolla: `Surface.negotiate('direct')` dichiara `['draft','edit','off']`
 * con `draftTtlMs` 30 s, `negotiate('group')` dichiara `['edit','off']` e
 * basta. Quindi qui sotto `sendMessageDraft` compare nelle scene private e
 * **non deve** comparire in quelle di gruppo, dove non esiste come chiamata;
 * il rinnovo dentro la finestra e' misurato dove si puo' misurare il
 * «quando», cioe' in `transcript.test.ts` con l'orologio finto.
 *
 * **What this file does not attempt, and why**: a scenario asserting several
 * genuinely time-spaced live edits from one round. `agent/loop.ts` buffers a
 * whole round and releases it in one synchronous burst once `done` confirms
 * no tool call (its own `TurnInput.onDelta` docstring explains why — no
 * earlier point is knowable, and "stream then retract" was rejected). A
 * burst has no gaps for `transcript.ts`'s rate limiter to space out, so a
 * single round collapses to exactly one live update in practice — proven
 * below. The rate limiter's own multi-update behaviour is real and is
 * proven where it can actually be observed: `transcript.test.ts`, driving
 * `live()`/`report()` directly across fake-clock time, independent of how
 * `loop.ts` happens to call it today.
 *
 * **DAY-1 requirement B13 lives here too**, same reasoning: `transcript.test.ts`
 * drives `startTranscript` directly and proves the throttle/coalescing/
 * disable-on-failure mechanics; the scenarios below prove the *composition* —
 * `onProgress`/`onDelta` actually reach `TelegramConnector`'s real Telegram
 * calls, and the merge into one message actually happens end to end. Some
 * need `streamingProviderWithRealGap`: every other provider here resolves
 * through pure microtasks with no real I/O anywhere in the turn, so a
 * `setTimeout(fn, 0)` armed by the turn's first event would never get a turn
 * to run before `stop()` cancels it. A genuine model call always has this gap
 * in production (real network I/O); this fake reproduces the gap rather than
 * the race.
 */

const OWNER = 4242;
const GROUP = -100200;
const STRANGER = 9999;

const groupMsg = (id: number): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: GROUP, type: 'supergroup' },
      from: { id: STRANGER, is_bot: false, first_name: 'x' },
      // Menzionato: dal 04/09 un messaggio di gruppo che non chiama Muffin non
      // apre nessun turno (`apreUnTurno`, ADR-0063).
      text: '@MuffinBot raccontami qualcosa',
    },
  }) as unknown as Update;

const privateMsg = (id: number): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      // Menzionato: dal 04/09 un messaggio di gruppo che non chiama Muffin non
      // apre nessun turno (`apreUnTurno`, ADR-0063).
      text: '@MuffinBot raccontami qualcosa',
    },
  }) as unknown as Update;

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Streams `chunks` (all in one synchronous burst, same as production's `drainStream` replay), then a final `done`. */
function streamingProvider(chunks: string[], finalText: string): Provider {
  return {
    kind: 'openai-compat' as const,
    async chat(): Promise<ChatResult> {
      throw new Error('this scenario must stream, not fall back to chat()');
    },
    async *chatStream(_call: ChatCall): AsyncIterable<StreamEvent> {
      for (const chunk of chunks) yield { type: 'text_delta', text: chunk };
      yield {
        type: 'done',
        result: { text: finalText, toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test-model' },
      };
    },
  };
}

/** A two-round turn: a tool call first (never streamed), then a streamed final answer. */
function streamingProviderWithToolCall(toolName: string, chunks: string[], finalText: string): Provider {
  let call = 0;
  return {
    kind: 'openai-compat' as const,
    async chat(): Promise<ChatResult> {
      throw new Error('this scenario must stream, not fall back to chat()');
    },
    async *chatStream(_call: ChatCall): AsyncIterable<StreamEvent> {
      if (call++ === 0) {
        // The tool round: some "thinking aloud" text a correct wiring must
        // never let reach a surface, plus the call itself.
        yield { type: 'text_delta', text: 'lascia che controlli...' };
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: toolName };
        yield {
          type: 'done',
          result: {
            text: 'lascia che controlli...',
            toolCalls: [{ id: 'c1', name: toolName, args: {} }],
            stopReason: 'tool_use',
            usage: USAGE,
            model: 'test-model',
          },
        };
        return;
      }
      for (const chunk of chunks) yield { type: 'text_delta', text: chunk };
      yield {
        type: 'done',
        result: { text: finalText, toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test-model' },
      };
    },
  };
}

/**
 * Same one-round shape as `streamingProvider`, plus one real macrotask gap
 * before it resolves — see the file docstring's "DAY-1 requirement B13" paragraph for
 * why the B13 scenarios need this and the B11 ones above do not. 20ms is
 * comfortably past Node's own 1ms floor for a `setTimeout(fn, 0)`, so this is
 * margin, not a tuned value.
 */
function streamingProviderWithRealGap(chunks: string[], finalText: string): Provider {
  return {
    kind: 'openai-compat' as const,
    async chat(): Promise<ChatResult> {
      throw new Error('this scenario must stream, not fall back to chat()');
    },
    async *chatStream(_call: ChatCall): AsyncIterable<StreamEvent> {
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const chunk of chunks) yield { type: 'text_delta', text: chunk };
      yield {
        type: 'done',
        result: { text: finalText, toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test-model' },
      };
    },
  };
}

type Recorded = { method: string; text?: string; messageId?: number };

function recordingApi(): { api: TelegramApiLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let nextMessageId = 900;
  const api: TelegramApiLike = {
    call: async () => {
      throw new Error('unused in this fake');
    },
    upload: async () => {
      throw new Error('unused in this fake');
    },
    getMe: async () => {
      throw new Error('unused in this fake');
    },
    getUpdates: async () => [],
    getChatMember: async () => ({ status: 'member' }),
    leaveChat: async () => true,
    sendMessage: async (chatId, html) => {
      const messageId = nextMessageId++;
      calls.push({ method: 'sendMessage', text: html, messageId });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } } as never;
    },
    editMessageText: async (_chatId, messageId, html) => {
      calls.push({ method: 'editMessageText', text: html, messageId });
      return true;
    },
    editMessageReplyMarkup: async (_chatId, messageId) => {
      calls.push({ method: 'editMessageReplyMarkup', messageId });
      return true;
    },
    deleteMessage: async (_chatId, messageId) => {
      calls.push({ method: 'deleteMessage', messageId });
      return true;
    },
    sendChatAction: async () => {
      calls.push({ method: 'sendChatAction' });
      return true;
    },
    sendMessageDraft: async (_chatId, _draftId, text) => {
      calls.push({ method: 'sendMessageDraft', text });
      return true;
    },
    sendRichMessage: async () => {
      throw new Error('unused in this fake');
    },
    editMessageRichText: async () => {
      throw new Error('unused in this fake');
    },
    sendRichMessageDraft: async () => {
      throw new Error('unused in this fake');
    },
    fileUrl: async () => 'https://example.test/file',
    setMyCommands: async () => true,
    answerCallbackQuery: async () => true,
  };
  return { api, calls };
}

function harness(config: TelegramConfig, provider: Provider, api: TelegramApiLike) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-tgstream-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-tgstream-ws-'));
  runInit({ home, apiKey: 'sk-tgstream-never-called' });
  const runtime = buildRuntime(home, workspace);
  const loop: LoopDeps = { ...runtime.deps, provider };
  const inbox = new UpdateInbox(runtime.db);
  const connector = new TelegramConnector({
    loop,
    sessions: runtime.deps.sessions,
    lane: new ModelLane(),
    inbox,
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config,
  });
  // Lo username che `connect()` prenderebbe da `getMe`: il banco chiama
  // `drain()` senza connettersi, e senza questo il gate di gruppo non puo'
  // riconoscere una menzione e fallisce chiuso.
  (connector as unknown as { meUsername: string }).meUsername = 'MuffinBot';

  return { connector, runtime };
}

async function deliver(connector: TelegramConnector, updates: Update[]): Promise<void> {
  const inbox = (connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, new Date().toISOString());
  await (connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('a group turn uses ephemeral presence and durably sends only the final answer', () => {
  it('never creates or edits a crash-orphanable placeholder, and sends the finished answer once', async () => {
    const finalText = 'Cera una volta un muffin che parlava.';
    const provider = streamingProvider(['Cera ', 'una volta ', 'un muffin che parlava.'], finalText);
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [groupMsg(1)]);

      expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0);
      expect(calls.filter((c) => c.method === 'sendMessage').map((c) => c.text)).toEqual([finalText]);
      // In un gruppo l'anteprima non esiste: `assertNegotiable` rifiuta
      // `'draft'` fuori da una stanza uno-a-uno, quindi non c'e' nemmeno il
      // codice che potrebbe chiamarla.
      expect(calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });

  it('keeps the tool round\'s "thinking aloud" text and the final answer in the SAME message — one sendMessage, then an edit, never a second send', async () => {
    const finalText = 'Ecco cosa ho trovato.';
    // A name the model invented — deliberately not registered. `runTool`
    // (`agent/loop.ts`) answers an unknown tool with a `tool_result` telling
    // the model so, never a throw, which is exactly what this scenario
    // needs: a real tool round that resolves on its own, without this test
    // having to reach into the connector to register one.
    //
    // Until 03/09/2026 the preamble never reached the surface at all. From
    // 03/09 it reached a transcript message of its own, but the answer was a
    // *second*, separate `sendMessage` — the exact two-bubble defect
    // measured on the owner's chat (`docs/evidence/turno-sospendibile.md`).
    // Since 04/09: one real message for the whole turn, extended by edits.
    const provider = streamingProviderWithToolCall('tool_non_registrato', ['Ecco ', 'cosa ho trovato.'], finalText);
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [groupMsg(2)]);

      // MUTATION-PROVABLE: exactly one `sendMessage` reaches this chat for a
      // turn that used a tool — not two. Revert `deliverTo`'s handoff merge
      // in `connector.ts` (drop the `handoff` branch of its plan) and this
      // goes back to 2.
      const sent = calls.filter((c) => c.method === 'sendMessage');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain('lascia che controlli');
      const transcriptId = sent[0]!.messageId;

      // The answer lands as an edit of that same message, carrying the
      // preamble/steps above it — never a sendMessage of its own.
      const edits = calls.filter((c) => c.method === 'editMessageText');
      expect(edits.length).toBeGreaterThanOrEqual(1);
      const last = edits[edits.length - 1]!;
      expect(last.messageId).toBe(transcriptId);
      expect(last.text).toContain('lascia che controlli');
      expect(last.text).toContain(finalText);

      expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0);
      expect(calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });
});

describe('a private turn streams into a real message as the answer forms (B11)', () => {
  it("l'anteprima mostra il testo che si forma, e la chat conserva un solo messaggio vero: la risposta", async () => {
    const finalText = 'Ciao! Ecco una storia breve.';
    const provider = streamingProvider(['Ciao! ', 'Ecco una storia breve.'], finalText);
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [privateMsg(3)]);

      // Dal 06/09/2026 la stanza `direct` negozia `['draft','edit','off']`:
      // il testo che si forma passa dall'anteprima effimera, rinnovata dentro
      // la sua finestra (`transcript.test.ts` misura il rinnovo). Quello che
      // la chat **conserva** resta un messaggio vero e uno solo.
      expect(calls.filter((c) => c.method === 'sendMessageDraft').length).toBeGreaterThan(0);

      const sent = calls.filter((c) => c.method === 'sendMessage');
      expect(sent).toHaveLength(1); // un messaggio vero per tutto il turno
      expect(sent[0]!.text).toBe(finalText); // ed e' la risposta finale, non un pezzo di frase
      // L'anteprima non e' un messaggio: non c'e' niente da cancellare e
      // niente da riscrivere quando arriva la risposta.
      expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });
});

describe('the transcript of a turn stays above the answer (DAY-1 requirement B13, the owner\'s shape)', () => {
  it("un turno senza tool conserva un solo messaggio vero, e il testo intermedio passa dall'anteprima", async () => {
    // Un turno senza tool in privato: l'anteprima mostra il testo mentre si
    // forma, e la chat conserva un messaggio solo — la risposta. Fra il
    // 04/09 e il 06/09 conservava lo stesso unico messaggio ma ci arrivava
    // per edit successivi; la differenza che l'owner ha chiesto il 06/09 e'
    // *dove* si vede il testo intermedio, non quanti messaggi restano.
    const finalText = 'Fatto, eccolo.';
    const provider = streamingProviderWithRealGap(['Fatto, ', 'eccolo.'], finalText);
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [privateMsg(30)]);
      const sent = calls.filter((c) => c.method === 'sendMessage');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toBe(finalText);
      expect(calls.filter((c) => c.method === 'sendMessageDraft').length).toBeGreaterThan(0);
      expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });

  it('in a group too the transcript is the one real message, and the durable answer extends it rather than arriving beside it', async () => {
    const finalText = 'Ecco.';
    const provider = streamingProviderWithToolCall('tool_non_registrato', ['Ec', 'co.'], finalText);
    const { api, calls } = recordingApi();
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, api);

    try {
      await deliver(connector, [groupMsg(31)]);
      const sends = calls.filter((c) => c.method === 'sendMessage');
      expect(sends).toHaveLength(1);
      expect(sends[0]!.text).toContain('lascia che controlli');
      // The answer is the *last* touch on this same message, an edit —
      // `connector.ts` awaits `transcript.stop()` ahead of `deliverTo`, and
      // `deliverTo` itself edits the transcript's own message rather than
      // sending the answer as a message of its own.
      const edits = calls.filter((c) => c.method === 'editMessageText' && c.messageId === sends[0]!.messageId);
      expect(edits.length).toBeGreaterThanOrEqual(1);
      expect(edits[edits.length - 1]!.text).toContain(finalText);
    } finally {
      runtime.close();
    }
  });

  it('swallows a Bot API failure creating the transcript — the turn still delivers the real answer (rule 5)', async () => {
    const finalText = 'Va bene comunque.';
    const provider = streamingProviderWithToolCall('tool_non_registrato', ['Va bene ', 'comunque.'], finalText);
    const { api: baseApi, calls } = recordingApi();
    let sendAttempts = 0;
    // The first `sendMessage` a tool turn ever makes is the transcript
    // (before any real answer exists to send) — failing exactly that one
    // proves rule 5 without reaching into `transcript.ts`'s internals. Once
    // that first create fails, `transcript.ts` disables itself for the rest
    // of the turn (`disabled`), so `handoff()` returns `null` and `deliverTo`
    // falls back to its ordinary, un-merged send — the same shape it always
    // had for a turn with no transcript at all.
    const failingApi: TelegramApiLike = {
      ...baseApi,
      sendMessage: async (chatId, html, options) => {
        sendAttempts += 1;
        if (sendAttempts === 1) throw new Error('simulato: chat non trovata');
        return baseApi.sendMessage(chatId, html, options);
      },
    };
    const { connector, runtime } = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, provider, failingApi);

    try {
      await deliver(connector, [privateMsg(32)]);

      expect(sendAttempts).toBe(2); // the failed transcript, then the real answer
      expect(calls.filter((c) => c.method === 'sendMessage').map((c) => c.text)).toEqual([finalText]);
      expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0);
    } finally {
      runtime.close();
    }
  });
});
