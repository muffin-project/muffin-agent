import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { eseguiComando, type Controlli } from '../../agent/comandi.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { buildRuntime } from '../../agent/runtime.js';
import { runInit } from '../../cli/init.js';
import { Pausa } from '../../core/runtime/pausa.js';
import { TelegramApi, TelegramError } from './api.js';
import type { TelegramApiLike } from './api.js';
import { TelegramConnector } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import { TelegramDeliveryStore } from './delivery.js';
import { UpdateInbox } from './updates.js';

/**
 * Convocazione in guest mode (Bot API 10.0): il bot viene menzionato in una
 * chat dove non è mai entrato, e l'unica risposta possibile è
 * `answerGuestQuery` — una sola, agganciata al `guest_query_id`, senza corsia
 * viva e senza streaming: il canale non li può portare.
 *
 * Il cancello è l'id del chiamante, certificato da Telegram
 * (`guest_bot_caller_user`), contro l'id dell'owner: la convocazione di
 * chiunque altro non apre niente — nemmeno una risposta di diniego: un bot
 * guest che risponde ai curiosi sarebbe una superficie di sondaggio, e questa
 * fetta non ne apre una (issue #924).
 */

const OWNER = 777001;
const CHAT_GUEST = -1009876543210; // una chat qualsiasi: il bot non ne è membro
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

const convoca = (updateId: number, chiamante: number, testo: string, queryId = `q${updateId}`): Update =>
  ({
    update_id: updateId,
    guest_message: {
      message_id: updateId,
      date: 0,
      chat: { id: CHAT_GUEST, type: 'group', title: 'il gruppo di qualcun altro' },
      from: { id: 1, is_bot: true, first_name: 'muffin' },
      guest_query_id: queryId,
      guest_bot_caller_user: { id: chiamante, is_bot: false, first_name: 'chi convoca' },
      text: testo,
    },
  }) as unknown as Update;

const testo = (t: string) => async (): Promise<ChatResult> => ({
  text: t,
  toolCalls: [],
  stopReason: 'end',
  usage,
  model: 'test',
});

function harness(script: Array<(call: ChatCall) => Promise<ChatResult>>, extraApi: Partial<TelegramApiLike> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-guest-tg-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-guest-tg-ws-'));
  runInit({ home, apiKey: 'sk-guest-never-called' });
  const runtime = buildRuntime(home, workspace);

  const inviate: Array<{ chatId: number; text: string }> = [];
  const guest: Array<{ queryId: string; html: string }> = [];
  const chiamate: ChatCall[] = [];
  const log: string[] = [];
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
    sendMessage: async (chatId: number, text: string) => {
      inviate.push({ chatId, text });
      return { message_id: inviate.length } as never;
    },
    sendRichMessage: async (chatId: number, rich: { html?: string }) => {
      inviate.push({ chatId, text: rich.html ?? '' });
      return { message_id: inviate.length } as never;
    },
    sendChatAction: async () => true,
    sendMessageDraft: async () => true,
    sendRichMessageDraft: async () => true,
    editMessageText: async () => ({}) as never,
    editMessageRichText: async () => ({}) as never,
    deleteMessage: async () => true,
    answerGuestQuery: async (guestQueryId: string, html: string) => {
      guest.push({ queryId: guestQueryId, html });
      return true;
    },
    ...extraApi,
  } as unknown as TelegramApi;

  const provider: Provider = {
    kind: 'openai-compat',
    chat: async (call) => {
      chiamate.push(call);
      const r = script[chiamate.length - 1] ?? testo('fine');
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
    log: (line: string) => {
      log.push(line);
    },
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
    runtime.close();
  };
  return { inviate, guest, chiamate, log, manda, chiudi, runtime };
}

async function until(check: () => boolean, stato: () => unknown = () => '', ms = 5_000): Promise<void> {
  const inizio = Date.now();
  while (!check()) {
    if (Date.now() - inizio > ms) throw new Error(`condizione mai vera — stato: ${JSON.stringify(stato())}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('convocazione guest — il cancello', () => {
  it('il chiamante che non è l\'owner non ottiene niente: né risposta, né turno', async () => {
    const h = harness([testo('non dovevi nemmeno arrivare qui')]);
    try {
      h.manda(convoca(1, 555, 'ehi bot, chi sei?'));
      // Non c'è niente da aspettare: si lascia girare un giro di poll e si
      // verifica che il silenzio sia davvero il comportamento.
      await new Promise((r) => setTimeout(r, 300));
      expect(h.guest, 'la convocazione di uno sconosciuto non riceve risposta').toEqual([]);
      expect(h.chiamate, 'nessun turno aperto per un non-owner').toEqual([]);
    } finally {
      await h.chiudi();
    }
  }, 15_000);

  it('una convocazione senza `guest_query_id` non ha canale: niente da rispondere', async () => {
    const senzId = convoca(1, OWNER, 'ciao') as unknown as Record<string, unknown>;
    delete (senzId.guest_message as Record<string, unknown>).guest_query_id;
    const h = harness([testo('x')]);
    try {
      h.manda(senzId as unknown as Update);
      await new Promise((r) => setTimeout(r, 300));
      expect(h.guest).toEqual([]);
      expect(h.chiamate).toEqual([]);
    } finally {
      await h.chiudi();
    }
  }, 15_000);
});

describe('convocazione guest — il turno dell\'owner', () => {
  it('l\'owner convoca, il turno gira, la risposta esce UNA sola via answerGuestQuery', async () => {
    const h = harness([testo('eccomi, dimmi')]);
    try {
      h.manda(convoca(1, OWNER, '@muffinbot eccoti?'));
      await until(() => h.guest.length === 1, () => ({ guest: h.guest, chiamate: h.chiamate.length, log: h.log }));
      expect(h.guest[0]!.queryId).toBe('q1');
      expect(h.guest[0]!.html).toContain('eccomi');
      // Il bot non è membro della chat ospite: lì non può partire nessun
      // sendMessage — la risposta esce solo dal canale guest.
      expect(h.inviate.filter((m) => m.chatId === CHAT_GUEST), 'niente sendMessage nella chat ospite').toEqual([]);
      // E il poll non si è inceppato: l'update è processato, il giro dopo
      // chiede il batch successivo senza ripescare il primo.
      h.manda();
      await h.chiudi();
    } catch (e) {
      await h.chiudi();
      throw e;
    }
  }, 15_000);

  it('la seconda convocazione mentre la prima vive non raddoppia il turno: avviso onesto', async () => {
    let rilascia: () => void = () => {};
    const porta = new Promise<void>((r) => (rilascia = r));
    const prima = async (call: ChatCall): Promise<ChatResult> => {
      await porta;
      return { text: 'finito', toolCalls: [], stopReason: 'end', usage, model: 'test' };
    };
    const h = harness([prima, testo('non deve girare')]);
    try {
      h.manda(convoca(1, OWNER, 'primo'), convoca(2, OWNER, 'secondo'));
      // L'avviso di occupato parte subito; la risposta vera arriva solo dopo
      // il rilascio del modello. Se si aspettassero entrambe prima di
      // rilasciare, si aspetterebbe per sempre la propria.
      await until(
        () => h.guest.some((g) => g.queryId === 'q2'),
        () => ({ guest: h.guest, chiamate: h.chiamate.length }),
      );
      rilascia();
      await until(
        () => h.guest.some((g) => g.queryId === 'q1'),
        () => ({ guest: h.guest, chiamate: h.chiamate.length }),
      );
      expect(h.guest.length).toBe(2);
      // L'ordine di uscita non è garantito: l'avviso di occupato parte subito,
      // la risposta vera quando il modello si sblocca. Si cerca per id.
      const prima = h.guest.find((g) => g.queryId === 'q1');
      const seconda = h.guest.find((g) => g.queryId === 'q2');
      expect(prima, 'la prima convocazione riceve la risposta del turno').toBeTruthy();
      expect(seconda!.html).toContain('richiamami');
      expect(h.chiamate.length, 'il secondo turno non si apre sopra il primo').toBe(1);
    } finally {
      rilascia();
      await h.chiudi();
    }
  }, 20_000);
});

describe('answerGuestQuery — il payload', () => {
  it('un solo invito al metodo, con l\'articolo inline agganciato al query id', async () => {
    const chiamate: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      chiamate.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    });
    try {
      await new TelegramApi('123:token').answerGuestQuery('QUERY-7', '<b>ciao</b>');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(chiamate.length).toBe(1);
    expect(chiamate[0]!.url).toContain('/answerGuestQuery');
    expect(chiamate[0]!.body.guest_query_id).toBe('QUERY-7');
    expect(chiamate[0]!.body.result).toEqual({
      type: 'article',
      id: 'muffin',
      message_text: '<b>ciao</b>',
      parse_mode: 'HTML',
    });
  });

  it('un canale chiuso non ha fallback: il drain non cade, il log è tutto', async () => {
    const h = harness([testo('risposta')], {
      answerGuestQuery: async () => {
        throw new TelegramError(400, 'QUERY_ID_INVALID: expired');
      },
    } as Partial<TelegramApiLike>);
    try {
      h.manda(convoca(1, OWNER, 'ciao'));
      // Il turno gira comunque, la risposta è persa e il poll continua vivo:
      // se il drain fosse caduto, la seconda convocazione non arriverebbe.
      await until(() => h.chiamate.length === 1);
      h.manda(convoca(2, OWNER, 'ancora'));
      await until(() => h.chiamate.length === 2);
      expect(h.guest).toEqual([]);
    } finally {
      await h.chiudi();
    }
  }, 15_000);
});
