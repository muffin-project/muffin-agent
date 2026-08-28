import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMANDI } from '../../agent/comandi.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatResult, Provider } from '../../agent/providers/types.js';
import { buildRuntime } from '../../agent/runtime.js';
import { runInit } from '../../cli/init.js';
import type { TelegramApi } from './api.js';
import { TelegramConnector } from './connector.js';
import { TelegramDeliveryStore } from './delivery.js';
import { UpdateInbox } from './updates.js';

/**
 * I comandi, dal telefono.
 *
 * La richiesta dell'owner era «tutti i / commands che abbiamo nella CLI
 * dobbiamo riportarli su telegram, SEMPRE», e il modo di tradirla non è
 * dimenticarne uno: è farne esistere due elenchi. Quindi qui si prova che
 * l'elenco è **uno** (`agent/comandi.ts`), che passa dal connettore senza
 * toccare il modello, e le tre cose che su Telegram si comportano
 * diversamente dal terminale.
 */

const OWNER = 555001;
const STRANGER = 555002;

const msg = (id: number, over: { chatId: number; fromId: number; text: string; type?: string }): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: over.chatId, type: over.type ?? 'private' },
      from: { id: over.fromId, is_bot: false, first_name: 'x' },
      text: over.text,
    },
  }) as unknown as Update;

function harness(comandi?: (riga: string, sessionId: string) => Promise<{ testo: string } | null>) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-cmd-tg-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-cmd-tg-ws-'));
  runInit({ home, apiKey: 'sk-comandi-never-called' });
  const runtime = buildRuntime(home, workspace);

  const sent: { chatId: number; text: string; replyTo?: number }[] = [];
  const turns: string[] = [];
  const menu: { command: string; description: string }[][] = [];
  const controller = new AbortController();

  const api = {
    getMe: async () => ({ id: 1, is_bot: true, first_name: 'muffin', username: 'muffinbot' }),
    // Un giro solo: il poller si ferma da sé, così `run()` arriva in fondo
    // senza che il test debba aspettare un timer vero.
    getUpdates: async () => {
      controller.abort();
      return [];
    },
    setMyCommands: async (commands: { command: string; description: string }[]) => {
      menu.push(commands);
      return true;
    },
    sendMessage: async (chatId: number, text: string, options?: { replyTo?: number }) => {
      sent.push({ chatId, text, ...(options?.replyTo === undefined ? {} : { replyTo: options.replyTo }) });
      return {} as never;
    },
    sendChatAction: async () => true,
    sendMessageDraft: async () => true,
    editMessageText: async () => ({}) as never,
    deleteMessage: async () => true,
  } as unknown as TelegramApi;

  // Un comando che arriva al modello è un comando che il gate non ha fermato.
  const provider: Provider = {
    kind: 'openai-compat',
    chat: async (): Promise<ChatResult> => {
      turns.push('turn ran');
      return {
        text: 'ok',
        toolCalls: [],
        stopReason: 'end',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: 'test-model',
      };
    },
  };

  const connector = new TelegramConnector({
    loop: { ...runtime.deps, provider } satisfies LoopDeps,
    sessions: runtime.deps.sessions,
    inbox: new UpdateInbox(runtime.db),
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER },
    ...(comandi ? { comandi } : {}),
  });
  return { connector, sent, turns, menu, controller };
}

async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('un comando dell owner non passa dal modello', () => {
  it('risponde con quello che dice `agent/comandi.ts`, e nessun turno gira', async () => {
    const visti: string[] = [];
    const h = harness(async (riga, sessionId) => {
      visti.push(`${riga} ${sessionId}`);
      return { testo: '$0.0031 / $20 questo mese' };
    });

    await deliver(h, [msg(1, { chatId: OWNER, fromId: OWNER, text: '/spend' })]);

    expect(h.turns).toEqual([]);
    expect(h.sent[0]?.text).toContain('$0.0031');
    // La sessione è quella della chat: `/session` deve dire l'id vero, non
    // uno inventato per l'occasione.
    expect(visti[0]).toBe(`/spend telegram:${OWNER}`);
  });

  /**
   * La risposta è citata sul messaggio che l'ha chiesta. Su Telegram una
   * risposta può arrivare dopo altri messaggi, e senza citazione si legge
   * come se rispondesse all'ultimo.
   */
  it('e la risposta cita il messaggio che l ha chiesta', async () => {
    const h = harness(async () => ({ testo: 'ok' }));
    await deliver(h, [msg(7, { chatId: OWNER, fromId: OWNER, text: '/session' })]);
    expect(h.sent[0]?.replyTo).toBe(7);
  });

  /**
   * `/model --list` supera i 4096 caratteri con una manciata di modelli.
   * Mandare solo il primo pezzo sarebbe un elenco troncato in silenzio — che
   * è esattamente il difetto che `renderForTelegram` esiste per non avere.
   */
  it('e una risposta lunga arriva tutta, non solo il primo pezzo', async () => {
    const lunga = Array.from({ length: 400 }, (_, i) => `riga numero ${i} del catalogo dei modelli`).join('\n');
    const h = harness(async () => ({ testo: lunga }));

    await deliver(h, [msg(1, { chatId: OWNER, fromId: OWNER, text: '/model --list' })]);

    expect(h.sent.length).toBeGreaterThan(1);
    expect(h.sent.map((s) => s.text).join('')).toContain('riga numero 399');
    // La citazione sta sul primo pezzo soltanto: citarne cinque sarebbe cinque
    // risposte alla stessa domanda.
    expect(h.sent.filter((s) => s.replyTo !== undefined)).toHaveLength(1);
    expect(h.sent[0]?.replyTo).toBe(1);
  });
});

describe('un comando che non è dell owner non è un comando', () => {
  /**
   * `/spend` da uno sconosciuto in un gruppo non è una domanda a cui
   * rispondere. E nemmeno «non sei autorizzato»: direbbe a un estraneo che
   * quel comando esiste ed è di qualcuno. Il testo prosegue verso il modello
   * come una frase qualunque, che è quello che è.
   */
  it('prosegue verso il modello, senza dire che esiste', async () => {
    let chiamato = false;
    const h = harness(async () => {
      chiamato = true;
      return { testo: 'segreto' };
    });

    await deliver(h, [msg(1, { chatId: -900, fromId: STRANGER, text: '/spend', type: 'supergroup' })]);

    expect(chiamato).toBe(false);
    expect(h.turns).toEqual(['turn ran']);
    expect(h.sent.some((s) => s.text.includes('segreto'))).toBe(false);
  });
});

describe('senza `comandi` configurati il connettore si comporta come prima', () => {
  it('uno slash finisce al modello, non in un errore', async () => {
    const h = harness();
    await deliver(h, [msg(1, { chatId: OWNER, fromId: OWNER, text: '/spend' })]);
    expect(h.turns).toEqual(['turn ran']);
  });
});

describe('il menu dei comandi lo dichiara l avvio', () => {
  it('con l elenco di `agent/comandi.ts`, senza quelli che qui non esistono', async () => {
    const h = harness(async () => ({ testo: 'ok' }));
    await h.connector.run(h.controller.signal);

    expect(h.menu).toHaveLength(1);
    const nomi = (h.menu[0] ?? []).map((c) => c.command);
    // Uno solo, e generato: un secondo elenco scritto a mano qui dentro
    // proverebbe soltanto che so scrivere lo stesso codice due volte.
    expect(nomi).toEqual(COMANDI.filter((c) => c.soloTerminale !== true).map((c) => c.nome));
    // `/exit` su Telegram prometterebbe una cosa che non succede.
    expect(nomi).not.toContain('exit');
    // La forma che Telegram accetta: minuscole, cifre e underscore, 1-32.
    for (const c of h.menu[0] ?? []) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });

  /**
   * Il menu è una comodità, non una condizione per partire: i comandi li
   * riconosce `tryCommand` leggendo il testo. Una rete storta al momento
   * dell'avvio non può spegnere Telegram.
   */
  it('e se Telegram rifiuta il menu, il connettore parte lo stesso', async () => {
    const h = harness(async () => ({ testo: 'ok' }));
    const api = (h.connector as unknown as { deps: { api: TelegramApi } }).deps.api as unknown as {
      setMyCommands: () => Promise<boolean>;
    };
    api.setMyCommands = async () => {
      throw new Error('429 Too Many Requests');
    };

    await expect(h.connector.run(h.controller.signal)).resolves.toBeUndefined();
  });
});
