import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eseguiComando, type Controlli } from '../../agent/comandi.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { buildRuntime } from '../../agent/runtime.js';
import { runInit } from '../../cli/init.js';
import { Pausa } from '../../core/runtime/pausa.js';
import type { TelegramApi } from './api.js';
import { TelegramConnector } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import { TelegramDeliveryStore } from './delivery.js';
import { UpdateInbox } from './updates.js';

/**
 * Bot API 10.3 `stopped_message_generation` (L): the owner's Stop control
 * reaches the canonical user-stop abort — structurally, never as text.
 *
 * - the press aborts the live turn (the provider sees the abort);
 * - NO second turn starts (nothing was injected for the loop to answer);
 * - the partial generation is NOT marked complete (the aborted outcome,
 *   not a finished answer);
 * - a press with no live turn, from a foreign chat, or malformed is
 *   ignored without touching any lane.
 */

const OWNER = 777001;
const FOREIGN_CHAT = 555002;
const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

const msg = (id: number, text: string, chat: number = OWNER, from: number = OWNER): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' },
      from: { id: from, is_bot: false, first_name: 'o' },
      text,
    },
  }) as unknown as Update;

const stopPress = (id: number, chat: number = OWNER): Update =>
  ({
    update_id: id,
    stopped_message_generation: {
      chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' },
      draft_id: 3,
    },
  }) as unknown as Update;

type Risposta = (call: ChatCall) => Promise<ChatResult>;

/** A model call that hangs until released — or until the turn aborts it. */
function bloccata(): { risposta: Risposta; rilascia: () => void; abortita: () => boolean } {
  let rilascia: () => void = () => {};
  const porta = new Promise<void>((r) => (rilascia = r));
  let abortVisto = false;
  return {
    rilascia: () => rilascia(),
    abortita: () => abortVisto,
    risposta: async (call) => {
      const abortita = new Promise<never>((_r, reject) =>
        call.signal?.addEventListener(
          'abort',
          () => {
            abortVisto = true;
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          },
          { once: true },
        ),
      );
      await Promise.race([porta, abortita]);
      return { text: 'risposta dopo lo sblocco', toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test' };
    },
  };
}

function harness(script: Risposta[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-tgstop-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-tgstop-ws-'));
  runInit({ home, apiKey: 'sk-tgstop-never-called' });
  const runtime = buildRuntime(home, workspace);

  const sent: string[] = [];
  const logs: string[] = [];
  const chiamate: ChatCall[] = [];
  const batches: Update[][] = [];
  let sveglia: (() => void) | null = null;
  const controller = new AbortController();

  const api = {
    getMe: async () => ({ id: 1, is_bot: true, first_name: 'muffin', username: 'muffinbot' }),
    getUpdates: async () => {
      while (batches.length === 0 && !controller.signal.aborted) {
        await new Promise<void>((r) => (sveglia = r));
      }
      return batches.shift() ?? [];
    },
    setMyCommands: async () => true,
    sendMessage: async (_chatId: number, text: string) => {
      sent.push(text);
      return { message_id: sent.length } as never;
    },
    sendChatAction: async () => true,
    sendMessageDraft: async () => true,
    editMessageText: async () => ({}) as never,
    deleteMessage: async () => true,
  } as unknown as TelegramApi;

  const provider: Provider = {
    kind: 'openai-compat',
    chat: async (call) => {
      chiamate.push(call);
      const r = script[chiamate.length - 1] ?? (async () => ({ text: 'fine', toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test' }));
      return r(call);
    },
  };

  const pausa = new Pausa(runtime.db);
  const connector = new TelegramConnector({
    loop: { ...runtime.deps, provider } satisfies LoopDeps,
    sessions: runtime.deps.sessions,
    lane: new ModelLane(),
    inbox: new UpdateInbox(runtime.db),
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER },
    comandi: async (riga, sessionId, controlli: Controlli) => {
      const e = await eseguiComando(riga, {
        home,
        config: runtime.config,
        profilo: { name: 'test', thinking: 'unset' },
        budget: runtime.budget,
        sessionId,
        verbosity: 'normale',
        puoiUscire: false,
        model: async () => undefined,
        controlli,
      });
      return e.sconosciuto === true ? null : { testo: e.testo };
    },
    pausa,
    log: (line: string) => logs.push(line),
  });

  const running = connector.run(controller.signal);
  const manda = (...updates: Update[]): void => {
    batches.push(updates);
    sveglia?.();
  };
  const chiudi = async (): Promise<void> => {
    connector.stop();
    controller.abort();
    sveglia?.();
    await running;
    // Il drain è a svuotamento singolo con ripartenza (`drainAgain`): chiudere
    // il database mentre un drain è in volo o sta per ripartire chiude il DB
    // sotto i suoi piedi (`pending()` su handle chiuso → rigetto non gestito).
    // Si chiude solo a drain idle — il poller è già uscito (`running`), quindi
    // nessuna nuova `scheduleDrain` può partire da qui in poi.
    const inizio = Date.now();
    for (;;) {
      const draining = (connector as unknown as { draining: Promise<void> | null }).draining;
      if (draining === null) break;
      if (Date.now() - inizio > 8_000) throw new Error('drain mai idle prima della chiusura');
      await draining.catch(() => {});
    }
    runtime.close();
  };
  const pending = (): number =>
    (connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox.pending().length;
  return { sent, logs, chiamate, manda, chiudi, pending };
}

async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const inizio = Date.now();
  while (!check()) {
    if (Date.now() - inizio > ms) throw new Error('condizione mai vera');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('stop-generation · the Stop press aborts the live turn, structurally (L)', () => {
  it('aborts the running turn without injecting any owner text', async () => {
    const modello = bloccata();
    const h = harness([modello.risposta]);
    try {
      h.manda(msg(1, 'raccontami qualcosa di lungo'));
      await until(() => h.chiamate.length === 1);

      h.manda(stopPress(2));
      await until(() => modello.abortita());
      // The aborted turn settles through the normal aborted path…
      await until(() => h.pending() === 0);
      await until(() => h.sent.length > 0);

      // …exactly one model call: the press started NO second turn, because
      // no fake owner text was ever injected for the loop to answer.
      await new Promise((r) => setTimeout(r, 300));
      expect(h.chiamate).toHaveLength(1);
      // …and the partial generation is not marked complete: the chat gets
      // the aborted outcome, never "risposta dopo lo sblocco" as an answer.
      expect(h.sent.join('\n')).not.toContain('risposta dopo lo sblocco');
      expect(h.logs.some((l) => l.includes('turno interrotto'))).toBe(true);
    } finally {
      modello.rilascia();
      await h.chiudi();
    }
  });

  it('a press with no live turn is a logged no-op, not an error', async () => {
    const h = harness([]);
    try {
      h.manda(stopPress(1));
      // `pending() === 0` è vero anche prima che il poller veda il batch:
      // l'attesa è sulla riga di diario, che esiste solo dopo il servizio.
      await until(() => h.logs.some((l) => l.includes('nessun turno vivo')));
      expect(h.chiamate).toHaveLength(0);
      expect(h.sent).toHaveLength(0);
    } finally {
      await h.chiudi();
    }
  });

  it('a press from a foreign chat never reaches the owner lane', async () => {
    const modello = bloccata();
    const h = harness([modello.risposta]);
    try {
      h.manda(msg(1, 'raccontami qualcosa di lungo'));
      await until(() => h.chiamate.length === 1);

      h.manda(stopPress(2, FOREIGN_CHAT));
      await until(() => h.logs.some((l) => l.includes('non è la chat')));
      // The owner's turn is still running: the foreign signal was refused.
      await new Promise((r) => setTimeout(r, 300));
      expect(modello.abortita()).toBe(false);
      expect(h.chiamate).toHaveLength(1);
      expect(h.logs.some((l) => l.includes('non è la chat'))).toBe(true);
    } finally {
      modello.rilascia();
      await h.chiudi();
    }
  });

  it('a malformed press is ignored without breaking the drain', async () => {
    const h = harness([]);
    try {
      h.manda({ update_id: 1, stopped_message_generation: { draft_id: 3 } } as unknown as Update);
      h.manda(msg(2, 'ciao'));
      await until(() => h.sent.length > 0);
      await until(() => h.logs.some((l) => l.includes('senza chat numerica')));
    } finally {
      await h.chiudi();
    }
  });
});
