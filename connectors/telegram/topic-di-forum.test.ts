import DatabaseCtor from 'better-sqlite3';
import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../../agent/runtime.js';
import { identify } from '../../core/surface/types.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { TelegramConnector, parseUpdate, type TelegramConfig } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import { TelegramApi, type SendOptions, type TelegramApi as TelegramApiType } from './api.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore, deliverTelegram } from './delivery.js';

/**
 * Un topic di forum è una sotto-conversazione, e prima di questa slice non
 * esisteva affatto: `message_thread_id` non compariva in nessun file di
 * `connectors/`, `core/` o `agent/`.
 *
 * Due guasti, entrambi visibili all'owner in un gruppo con i topic accesi:
 *
 *  1. **Una memoria sola.** Due topic producevano la stessa `sessionKey`,
 *     quindi «Bug» e «Spesa» erano lo stesso discorso.
 *  2. **La risposta spezzata.** `reply_parameters` porta nel topic soltanto
 *     il messaggio che cita, e la citazione la metteva solo il primo pezzo:
 *     una risposta lunga finiva metà nel topic e metà in *General*.
 *
 * Il taglio deciso qui — e la ragione per cui il tenant non si muove — è che
 * un topic **non è un inquilino**: non ha membri, permessi né amministratore
 * propri. Vedi `IncomingIdentity.threadId`.
 */

const OWNER = 4242;
const GROUP = -100200;
const STRANGER = 9999;

const TOPIC_BUG = 77;
const TOPIC_SPESA = 91;

/** Un messaggio dentro un topic del forum: `is_topic_message` è il campo che lo dichiara. */
const inTopic = (id: number, threadId: number, text: string): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: GROUP, type: 'supergroup', is_forum: true },
      from: { id: STRANGER, is_bot: false, first_name: 'x' },
      message_thread_id: threadId,
      is_topic_message: true,
      text,
    },
  }) as unknown as Update;

describe('identify: un topic divide la conversazione, mai il tenant', () => {
  const base = { connector: 'telegram', authorId: String(STRANGER), conversationId: String(GROUP), direct: false };

  it('due topic dello stesso gruppo sono due sessioni', () => {
    const bug = identify({ ...base, threadId: String(TOPIC_BUG) }, String(OWNER));
    const spesa = identify({ ...base, threadId: String(TOPIC_SPESA) }, String(OWNER));

    expect(bug.sessionKey).not.toBe(spesa.sessionKey);
    expect(bug.sessionKey).toBe(`telegram:${GROUP}#${TOPIC_BUG}`);
  });

  it('ma restano lo stesso inquilino, cioè gli stessi permessi', () => {
    const bug = identify({ ...base, threadId: String(TOPIC_BUG) }, String(OWNER));
    const spesa = identify({ ...base, threadId: String(TOPIC_SPESA) }, String(OWNER));

    // La riga che tiene il taglio: se un giorno il topic finisse nel tenant,
    // chiunque può aprirne uno e ogni topic diventerebbe un confine di
    // sicurezza nuovo, creato da chi passa di lì.
    expect(bug.tenant).toBe(spesa.tenant);
    expect(bug.tenant).toBe(`group:telegram:${GROUP}`);
    expect(bug.principal.kind).toBe('member');
  });

  it('un gruppo senza topic non cambia nome di sessione', () => {
    // Regressione: la chiave di un gruppo normale è un nome di file esistente
    // sui database già installati. Se questa cambia, ogni gruppo perde la
    // sua storia il giorno dell'aggiornamento.
    expect(identify(base, String(OWNER)).sessionKey).toBe(`telegram:${GROUP}`);
    expect(identify({ ...base, threadId: undefined }, String(OWNER)).sessionKey).toBe(`telegram:${GROUP}`);
  });
});

describe('parseUpdate: `message_thread_id` da solo non è un topic', () => {
  it('lo legge quando `is_topic_message` lo dichiara', () => {
    expect(parseUpdate(inTopic(1, TOPIC_BUG, 'ciao'))?.threadId).toBe(TOPIC_BUG);
  });

  it('lo ignora in un supergruppo normale, dove marca le catene di risposta', () => {
    // Il caso che avrebbe rotto la continuità invece di ripararla: su ogni
    // risposta dentro un gruppo qualsiasi Telegram manda `message_thread_id`,
    // e leggerlo lì avrebbe aperto una sessione nuova per ogni scambio.
    const catenaDiRisposte = {
      update_id: 2,
      message: {
        message_id: 2,
        date: 0,
        chat: { id: GROUP, type: 'supergroup' },
        from: { id: STRANGER, is_bot: false, first_name: 'x' },
        message_thread_id: 55,
        text: 'ciao',
      },
    } as unknown as Update;

    expect(parseUpdate(catenaDiRisposte)?.threadId).toBeUndefined();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TelegramApi: il topic arriva sul filo', () => {
  it('sendMessage mette `message_thread_id` nel payload', async () => {
    const inviati: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        inviati.push(JSON.parse(init.body) as Record<string, unknown>);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      }),
    );

    const api = new TelegramApi('123:abc');
    await api.sendMessage(GROUP, 'ciao', { threadId: TOPIC_BUG });
    await api.sendChatAction(GROUP, 'typing', TOPIC_BUG);
    await api.sendMessage(GROUP, 'fuori dai topic');

    expect(inviati[0]!['message_thread_id']).toBe(TOPIC_BUG);
    // Il «sta scrivendo…» in *General* mentre la persona guarda il suo topic
    // è un segnale che c'è e non si vede: peggio di nessun segnale.
    expect(inviati[1]!['message_thread_id']).toBe(TOPIC_BUG);
    // E fuori da un forum il campo non compare affatto.
    expect(inviati[2]).not.toHaveProperty('message_thread_id');
  });
});

describe('deliverTelegram: ogni pezzo, non solo quello che cita', () => {
  const pezzo = (html: string, i: number) => ({
    operation: 'send' as const,
    chatId: GROUP,
    threadId: TOPIC_BUG,
    replyTo: i === 0 ? 7 : null,
    editMessageId: null,
    html,
  });

  it('mette il topic anche sulle parti dopo la prima', async () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TelegramDeliveryStore(db);
    const opzioni: (SendOptions | undefined)[] = [];
    const api = {
      sendMessage: async (_c: number, _h: string, o?: SendOptions) => {
        opzioni.push(o);
        return { message_id: opzioni.length } as never;
      },
      sendRichMessage: async (_c: number, _rich: unknown, o?: SendOptions) => {
        opzioni.push(o);
        return { message_id: opzioni.length } as never;
      },
    } as unknown as TelegramApiType;

    let n = 0;
    await deliverTelegram(store, api, 't1', [pezzo('a', 0), pezzo('b', 1), pezzo('c', 2)], () =>
      new Date(1_700_000_000_000 + n++).toISOString(),
    );

    expect(opzioni).toHaveLength(3);
    // Il difetto era esattamente qui: il primo pezzo arrivava nel topic per
    // via della citazione, gli altri due in *General*.
    expect(opzioni.map((o) => o?.threadId)).toEqual([TOPIC_BUG, TOPIC_BUG, TOPIC_BUG]);
    db.close();
  });

  it('aggiunge la colonna a un database installato prima di questa slice', () => {
    const db = new DatabaseCtor(':memory:');
    // Lo schema esatto di prima, senza `thread_id`: `CREATE TABLE IF NOT
    // EXISTS` non lo tocca, quindi senza la migrazione ogni INSERT fallisce.
    db.exec(`CREATE TABLE telegram_delivery_parts (
      turn_id TEXT NOT NULL, part_index INTEGER NOT NULL CHECK (part_index >= 0),
      operation TEXT NOT NULL CHECK (operation IN ('send','edit')), chat_id INTEGER NOT NULL,
      reply_to INTEGER, edit_message_id INTEGER, html TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','attempting','sent','rejected','possibly_sent')),
      attempt_id TEXT, telegram_message_id INTEGER, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (turn_id, part_index));`);

    const store = new TelegramDeliveryStore(db);
    const parti = store.plan('t1', [pezzo('a', 0)], '2026-09-04T00:00:00.000Z');

    expect(parti[0]!.threadId).toBe(TOPIC_BUG);
    db.close();
  });
});

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const reply = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: USAGE,
  model: 'test-model',
});

/** Lo stesso banco di `group-context.test.ts`: la fetta va provata dal filo. */
function harness(config: TelegramConfig, script: ChatResult[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-topic-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-topic-ws-'));
  runInit({ home, apiKey: 'sk-topic-never-called' });
  const runtime = buildRuntime(home, workspace);

  const seen: ChatCall[] = [];
  let step = 0;
  const provider: Provider = {
    kind: 'openai-compat',
    chat: async (call: ChatCall) => {
      seen.push(call);
      return script[step++] ?? reply('Ok.');
    },
  };
  const loop: LoopDeps = { ...runtime.deps, provider };

  const inviati: { chatId: number; options: SendOptions | undefined }[] = [];
  const azioni: (number | undefined)[] = [];
  const api = {
    sendMessage: async (chatId: number, _html: string, options?: SendOptions) => {
      inviati.push({ chatId, options });
      return { message_id: inviati.length } as never;
    },
    sendRichMessage: async (chatId: number, _rich: unknown, options?: SendOptions) => {
      inviati.push({ chatId, options });
      return { message_id: inviati.length } as never;
    },
    editMessageText: async () => ({}) as never,
    editMessageRichText: async () => ({}) as never,
    sendRichMessageDraft: async () => true,
    sendChatAction: async (_c: number, _a?: string, threadId?: number) => {
      azioni.push(threadId);
      return true;
    },
    sendMessageDraft: async () => true,
  } as unknown as TelegramApiType;

  const connector = new TelegramConnector({
    loop,
    sessions: runtime.deps.sessions,
    lane: new ModelLane(),
    inbox: new UpdateInbox(runtime.db),
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config,
  });
  (connector as unknown as { meUsername: string }).meUsername = 'MuffinBot';

  return { connector, seen, inviati, azioni, runtime };
}

async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('un turno nato in un topic, dal filo', () => {
  it('risponde dentro il topic — ogni pezzo, e anche il «sta scrivendo»', async () => {
    // Abbastanza lunga da spezzarsi: il limite di Telegram è 4096 caratteri,
    // ed è proprio la seconda parte che finiva in *General*.
    const lunga = reply('x'.repeat(9000));
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, [lunga]);
    try {
      await deliver(h, [inTopic(1, TOPIC_BUG, '@MuffinBot ciao')]);

      // Rich: the whole answer is one message now, and it still lands in the topic.
      expect(h.inviati.length).toBeGreaterThanOrEqual(1);
      for (const invio of h.inviati) expect(invio.options?.threadId).toBe(TOPIC_BUG);
      expect(h.azioni.length).toBeGreaterThan(0);
      for (const t of h.azioni) expect(t).toBe(TOPIC_BUG);
    } finally {
      h.runtime.close();
    }
  });

  it('continua il discorso nel proprio topic e non in quello accanto', async () => {
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, [
      reply('IL-PONTE-È-CHIUSO'),
      reply('ok'),
      reply('ok'),
    ]);
    try {
      await deliver(h, [inTopic(1, TOPIC_BUG, '@MuffinBot che succede')]);
      await deliver(h, [inTopic(2, TOPIC_SPESA, '@MuffinBot quanto manca')]);
      await deliver(h, [inTopic(3, TOPIC_BUG, '@MuffinBot e adesso')]);

      expect(h.seen).toHaveLength(3);
      const nelTopicAccanto = JSON.stringify(h.seen[1]!.messages);
      const nelloStessoTopic = JSON.stringify(h.seen[2]!.messages);

      // Le due metà insieme, perché una sola sarebbe verde anche con la
      // continuità rotta del tutto (nessuno vede niente) o mai divisa
      // (tutti vedono tutto).
      expect(nelloStessoTopic).toContain('IL-PONTE-È-CHIUSO');
      expect(nelTopicAccanto).not.toContain('IL-PONTE-È-CHIUSO');
    } finally {
      h.runtime.close();
    }
  });
});
