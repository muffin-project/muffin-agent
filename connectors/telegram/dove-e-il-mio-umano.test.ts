import DatabaseCtor from 'better-sqlite3';
import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../../agent/runtime.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { TelegramConnector, type TelegramConfig } from './connector.js';
import { TelegramApi } from './api.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';
import { avvisoAllOwner, decidiInvito, type Invito } from './invito.js';

/**
 * Aggiungere Muffin a un gruppo dove il suo umano non c'è.
 *
 * Direzione owner, 04/09/2026. Non è galateo: un gruppo è un **tenant**, e su
 * Telegram aggiungere un bot a un gruppo non richiede il permesso di nessuno —
 * basta conoscerne lo username. Senza questa uscita, l'unico limite a quanti
 * inquilini esistono è quante persone hanno voglia di aggiungerlo.
 *
 * Il difetto di partenza era a monte della decisione: `allowed_updates` non
 * chiedeva `my_chat_member`, quindi l'invito **non arrivava affatto**.
 */

const OWNER = 4242;
const ESTRANEO = 9999;
const GRUPPO = -100777;

const aggiuntoDa = (id: number, stato = 'member', tipo = 'supergroup'): Update =>
  ({
    update_id: id,
    my_chat_member: {
      chat: { id: GRUPPO, type: tipo, title: 'stanza altrui' },
      from: { id: ESTRANEO, is_bot: false, first_name: 'Tizio', username: 'tizio' },
      date: 0,
      old_chat_member: { status: 'left', user: { id: 1, is_bot: true, first_name: 'M' } },
      new_chat_member: { status: stato, user: { id: 1, is_bot: true, first_name: 'M' } },
    },
  }) as unknown as Update;

const invito: Invito = {
  chatId: GRUPPO,
  titolo: 'stanza altrui',
  tipo: 'supergroup',
  daId: ESTRANEO,
  daNome: 'Tizio',
  daUsername: 'tizio',
  statoNuovo: 'member',
};

describe('decidiInvito', () => {
  it("esce quando l'umano non c'è, resta quando c'è", () => {
    expect(decidiInvito(invito, false).azione).toBe('esci');
    expect(decidiInvito(invito, true).azione).toBe('resta');
  });

  it('esce anche quando non ha potuto chiedere — il rischio non verificabile vale come assente', () => {
    // La scelta scomoda, asserita perché è una decisione e non un caso
    // dimenticato: restare in una stanza non verificata è il rischio che
    // questa funzione toglie, uscire per sbaglio costa un re-invito.
    const e = decidiInvito(invito, undefined);
    expect(e.azione).toBe('esci');
    expect(e.perche).toContain('non ho potuto verificare');
  });

  it('non esce da una chat privata', () => {
    // `my_chat_member` arriva anche quando una persona apre la conversazione
    // col bot: uscire da lì vorrebbe dire rifiutare di parlare con chiunque.
    expect(decidiInvito({ ...invito, tipo: 'private' }, false).azione).toBe('resta');
  });

  it("non reagisce all'uscita stessa", () => {
    // Senza questo ramo, uscire genera il `my_chat_member` che farebbe uscire
    // di nuovo: un ciclo che si autoalimenta.
    for (const stato of ['left', 'kicked']) {
      expect(decidiInvito({ ...invito, statoNuovo: stato }, false).azione).toBe('resta');
    }
  });

  it("l'avviso all'owner porta chi e dove, non un id nudo", () => {
    const testo = avvisoAllOwner(invito, decidiInvito(invito, false));
    expect(testo).toContain('stanza altrui');
    expect(testo).toContain('Tizio');
    expect(testo).toContain('@tizio');
    expect(testo).toContain(String(GRUPPO));
  });

  it('e regge un admin anonimo, che non ha né nome né id', () => {
    // `from` assente: il connettore mette 0. Un messaggio che dicesse «id 0»
    // sarebbe peggio del silenzio.
    const anonimo: Invito = { ...invito, daId: 0, daNome: '', daUsername: undefined };
    const testo = avvisoAllOwner(anonimo, decidiInvito(anonimo, false));
    expect(testo).toContain('non ha nominato');
    expect(testo).not.toContain('id 0');
  });
});

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

function harness(config: TelegramConfig, ownerStatus: string | Error = 'member') {
  const home = mkdtempSync(join(tmpdir(), 'muffin-invito-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-invito-ws-'));
  runInit({ home, apiKey: 'sk-invito-never-called' });
  const runtime = buildRuntime(home, workspace);

  const seen: ChatCall[] = [];
  const provider: Provider = {
    kind: 'openai-compat',
    chat: async (call: ChatCall) => {
      seen.push(call);
      return { text: 'Ok.', toolCalls: [], stopReason: 'end', usage: USAGE, model: 'test' } as ChatResult;
    },
  };
  const loop: LoopDeps = { ...runtime.deps, provider };

  const inviati: { chatId: number; testo: string }[] = [];
  const usciteDa: number[] = [];
  const api = {
    sendMessage: async (chatId: number, testo: string) => {
      inviati.push({ chatId, testo });
      return { message_id: inviati.length } as never;
    },
    editMessageText: async () => ({}) as never,
    sendChatAction: async () => true,
    sendMessageDraft: async () => true,
    getChatMember: async () => {
      if (ownerStatus instanceof Error) throw ownerStatus;
      return { status: ownerStatus };
    },
    leaveChat: async (chatId: number) => {
      usciteDa.push(chatId);
      return true;
    },
  } as unknown as TelegramApi;

  const connector = new TelegramConnector({
    loop,
    sessions: runtime.deps.sessions,
    inbox: new UpdateInbox(runtime.db),
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config,
  });
  return { connector, seen, inviati, usciteDa, runtime };
}

async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

describe('un invito che arriva dal filo', () => {
  const config: TelegramConfig = { token: 't', ownerUserId: OWNER, ownerChatId: OWNER };

  it("saluta, avvisa l'umano e se ne va — in quest'ordine", async () => {
    const h = harness(config, 'left');
    try {
      await deliver(h, [aggiuntoDa(1)]);

      // Il saluto **prima** dell'uscita: dopo `leaveChat` non si può più
      // scrivere lì dentro, quindi l'ordine non è cosmetico.
      expect(h.inviati[0]?.chatId).toBe(GRUPPO);
      expect(h.inviati[0]?.testo).toContain('Dove è il mio umano');
      // L'avviso in privato, con chi e dove.
      expect(h.inviati[1]?.chatId).toBe(OWNER);
      expect(h.inviati[1]?.testo).toContain('stanza altrui');
      expect(h.inviati[1]?.testo).toContain('@tizio');
      expect(h.usciteDa).toEqual([GRUPPO]);

      // E nessun turno: un invito non è una conversazione, e farne partire
      // uno vorrebbe dire pagare il modello per ogni stanza in cui qualcuno
      // ci butta dentro.
      expect(h.seen).toEqual([]);
    } finally {
      h.runtime.close();
    }
  });

  it("nel gruppo non racconta niente del suo umano — e' la stanza da cui sta uscendo", async () => {
    const h = harness(config, 'left');
    try {
      await deliver(h, [aggiuntoDa(1)]);
      const nelGruppo = h.inviati.filter((m) => m.chatId === GRUPPO).map((m) => m.testo).join('\n');
      expect(nelGruppo).not.toContain(String(OWNER));
      expect(nelGruppo).not.toContain('@tizio');
    } finally {
      h.runtime.close();
    }
  });

  it("resta dove il suo umano c'e', senza dire niente a nessuno", async () => {
    const h = harness(config, 'member');
    try {
      await deliver(h, [aggiuntoDa(1)]);
      expect(h.usciteDa).toEqual([]);
      expect(h.inviati).toEqual([]);
    } finally {
      h.runtime.close();
    }
  });

  it('esce comunque se non riesce a chiedere chi c’è in quella stanza', async () => {
    const h = harness(config, new Error('rete giù'));
    try {
      await deliver(h, [aggiuntoDa(1)]);
      expect(h.usciteDa).toEqual([GRUPPO]);
      expect(h.inviati[1]?.testo).toContain('non ho potuto verificare');
    } finally {
      h.runtime.close();
    }
  });

  it('esce anche se il saluto nel gruppo non parte', async () => {
    // Il caso più probabile proprio nel gruppo ostile: bot mutato, permessi
    // stretti. Un saluto che fallisce non deve trattenerlo lì dentro.
    const h = harness(config, 'left');
    (h.connector as unknown as { deps: { api: { sendMessage: unknown } } }).deps.api.sendMessage = async (
      chatId: number,
    ) => {
      if (chatId === GRUPPO) throw new Error('bot is muted');
      h.inviati.push({ chatId, testo: '(privato)' });
      return { message_id: 1 } as never;
    };
    try {
      await deliver(h, [aggiuntoDa(1)]);
      expect(h.usciteDa).toEqual([GRUPPO]);
    } finally {
      h.runtime.close();
    }
  });

  it('un bot non appaiato non ha un umano da cercare: esce da ogni stanza', async () => {
    const h = harness({ token: 't' }, 'member');
    try {
      await deliver(h, [aggiuntoDa(1)]);
      expect(h.usciteDa).toEqual([GRUPPO]);
    } finally {
      h.runtime.close();
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('il pezzo senza cui tutto il resto e\' codice morto', () => {
  it("getUpdates chiede `my_chat_member`, o l'invito non arriva affatto", async () => {
    // Il difetto di partenza, e la ragione per cui questa asserzione vale piu'
    // delle dodici sopra: `allowed_updates` era esplicito e non lo elencava,
    // quindi Telegram non mandava mai l'update. Il meccanismo poteva essere
    // perfetto e non sarebbe mai partito — il guasto che `AGENTS.md` nomina
    // per primo.
    let chiesto: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        chiesto = JSON.parse(init.body) as Record<string, unknown>;
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
      }),
    );

    await new TelegramApi('123:abc').getUpdates(0);

    expect(chiesto?.['allowed_updates']).toContain('my_chat_member');
  });
});
