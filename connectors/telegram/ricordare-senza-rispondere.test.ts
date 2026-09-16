import DatabaseCtor from 'better-sqlite3';
import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../../agent/runtime.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { Decision } from '../../core/policy/types.js';
import { Consolidator, CONSOLIDATION_TENANT } from '../../core/memory/consolidator.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { TelegramConnector, type TelegramConfig } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
import type { TelegramApi } from './api.js';
import { UpdateInbox } from './updates.js';
import { TelegramDeliveryStore } from './delivery.js';

/**
 * ADR-0063 opens no turn for a group message that does not address Muffin —
 * correct, it saves tokens. Until this slice `drain()`'s gated-out branch
 * called `markProcessedQuietly` and nothing else: the message vanished, so a
 * later "@Muffin cosa avevamo deciso?" found a memory that had never seen the
 * conversation. The owner's directive (privacy mode off): «il sistema riceve
 * tutti i messaggi, semplicemente non usiamo token per tutti».
 *
 * This file proves the repair from the wire, the same shape
 * `group-context.test.ts` uses: a real `TelegramConnector` over a real
 * `buildRuntime`, only the provider replaced. The distinction that matters is
 * not "does an episode-writing function exist" — it is "does `drain()` call
 * it, through the kernel door, only where `apreUnTurno` says no".
 */

const OWNER = 4242;
const GROUP = -100300;
const STRANGER = 8888;

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const reply = (text: string): ChatResult => ({
  text,
  toolCalls: [],
  stopReason: 'end',
  usage: USAGE,
  model: 'test-model',
});

function harness(config: TelegramConfig, decide?: LoopDeps['decide']) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-ricorda-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-ricorda-ws-'));
  runInit({ home, apiKey: 'sk-ricorda-never-called' });
  const runtime = buildRuntime(home, workspace);

  const seen: ChatCall[] = [];
  const provider: Provider = {
    kind: 'openai-compat',
    chat: async (call: ChatCall) => {
      seen.push(call);
      return reply('Ok.');
    },
  };

  const loop: LoopDeps = { ...runtime.deps, provider, ...(decide ? { decide } : {}) };

  const api = {
    sendMessage: async () => ({}) as never,
    editMessageText: async () => ({}) as never,
    sendChatAction: async () => true,
    sendMessageDraft: async () => true,
  } as unknown as TelegramApi;

  const connector = new TelegramConnector({
    loop,
    sessions: runtime.deps.sessions,
    lane: new ModelLane(),
    inbox: new UpdateInbox(runtime.db),
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config,
  });

  // Come in `group-context.test.ts`: senza, il gate di gruppo non riconosce
  // una menzione e fallisce chiuso — corretto in produzione (`connect()` lo
  // prende da `getMe`), inutile in un banco che chiama `drain()` da solo.
  (connector as unknown as { meUsername: string }).meUsername = 'MuffinBot';

  return { connector, seen, runtime };
}

async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

type EpisodeRow = {
  tenant_id: string;
  connector: string;
  thread_key: string;
  role: string;
  trust_tier: number;
  content: string | null;
  turn_id: string | null;
};

function episodes(h: ReturnType<typeof harness>): EpisodeRow[] {
  return h.runtime.db
    .prepare(
      'SELECT tenant_id, connector, thread_key, role, trust_tier, content, turn_id FROM episodes ORDER BY id',
    )
    .all() as EpisodeRow[];
}

const groupMsg = (id: number, text: string): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: GROUP, type: 'supergroup' },
      from: { id: STRANGER, is_bot: false, first_name: 'x' },
      text,
    },
  }) as unknown as Update;

const privateMsg = (id: number, text: string): Update =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'o' },
      text,
    },
  }) as unknown as Update;

describe('ricordare senza rispondere — un gruppo che non chiama Muffin non sparisce', () => {
  it('un messaggio di gruppo non indirizzato: zero chiamate al modello, un episodio nel tenant del gruppo', async () => {
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER });
    try {
      await deliver(h, [groupMsg(1, 'il criceto di Sara è scappato di nuovo stasera')]);

      // Il gate di gruppo (ADR-0063) resta intatto: nessun turno, nessuna
      // chiamata al provider.
      expect(h.seen).toHaveLength(0);

      const rows = episodes(h);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: `group:telegram:${GROUP}`,
        connector: 'telegram',
        thread_key: `telegram:${GROUP}`,
        role: 'user',
        trust_tier: 2,
        turn_id: null,
      });
      expect(rows[0]!.content).toContain('criceto');
    } finally {
      h.runtime.close();
    }
  });

  it('una menzione dopo trova la conversazione: il richiamo la ripesca grezza', async () => {
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER });
    try {
      await deliver(h, [groupMsg(1, 'il criceto di Sara è scappato di nuovo stasera')]);
      expect(h.seen).toHaveLength(0);

      await deliver(h, [groupMsg(2, '@MuffinBot avete più saputo niente del criceto?')]);
      expect(h.seen).toHaveLength(1);

      // "Il primo messaggio del provider" — il richiamo precede sempre il
      // testo dell'utente nello stesso messaggio (`buildContext`,
      // `agent/loop.ts`), quindi e' qui che il testo di prima deve comparire.
      const firstMessage = h.seen[0]!.messages[0]!;
      const text = firstMessage.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      expect(text).toContain('criceto di Sara è scappato');

      // Tre episodi ora: quello non indirizzato di prima (questo slice), e i
      // due che il turno vero scrive per il messaggio con la menzione
      // (l'utente e la risposta dell'agente, `agent/loop.ts`).
      const rows = episodes(h);
      expect(rows).toHaveLength(3);
    } finally {
      h.runtime.close();
    }
  });

  it('lo stesso testo, in privata, non passa da questo ramo', async () => {
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER });
    try {
      // In privata `apreUnTurno` e' sempre vero: il ramo nuovo non e'
      // raggiungibile affatto, e i due episodi (utente + risposta) arrivano
      // dalla scrittura che `agent/loop.ts` fa dentro un turno vero — ognuno
      // porta un `turn_id`, cosa che la scrittura di questo slice non porta
      // mai (nessun turno esiste quando la scrive). Se un giorno un refactor
      // spostasse la chiamata fuori dal ramo gated-out e la facesse eseguire
      // anche qui, il messaggio privato produrrebbe un terzo episodio con
      // `turn_id NULL` — questa asserzione lo scoprirebbe.
      await deliver(h, [privateMsg(1, 'il criceto di Sara è scappato di nuovo stasera')]);
      expect(h.seen).toHaveLength(1);

      const rows = episodes(h);
      expect(rows).toHaveLength(2); // il messaggio dell'owner e la risposta dell'agente
      for (const row of rows) expect(row.turn_id).not.toBeNull();
      const utente = rows.find((r) => r.role === 'user')!;
      expect(utente.thread_key).toBe('owner');
      expect(utente.trust_tier).toBe(0);
    } finally {
      h.runtime.close();
    }
  });

  it('il kernel puo rifiutare: senza `allow` su memory.write, niente viene scritto', async () => {
    const denyMemoryWrite: LoopDeps['decide'] = (req): Decision =>
      req.capability === 'memory.write' ? { effect: 'deny', code: 'no_capability' } : { effect: 'allow' };
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER }, denyMemoryWrite);
    try {
      await deliver(h, [groupMsg(1, 'il criceto di Sara è scappato di nuovo stasera')]);
      expect(h.seen).toHaveLength(0);
      expect(episodes(h)).toHaveLength(0);
    } finally {
      h.runtime.close();
    }
  });
});

describe('il costo modello resta zero per un tenant di gruppo', () => {
  /**
   * La citazione che il claim promette, non una riderivazione: la ragione per
   * cui scrivere un episodio di gruppo costa zero modello e' che
   * `Consolidator.notify` scarta ogni tenant diverso da `CONSOLIDATION_TENANT`
   * (`core/memory/consolidator.ts`) **prima** di toccare il contatore che arma
   * l'estrazione — mai fact-extraction per un gruppo, quindi mai un giro di
   * modello per l'episodio che questa slice scrive.
   */
  it("CONSOLIDATION_TENANT e' 'host', e notify() su un tenant di gruppo non arma nulla", async () => {
    expect(CONSOLIDATION_TENANT).toBe('host');

    const db = new DatabaseCtor(':memory:');
    const calls: number[] = [];
    const consolidator = new Consolidator({
      db,
      ingest: async (limit) => {
        calls.push(limit);
        return {
          tenantId: 'host',
          fetched: 1,
          marked: 1,
          episodes: 1,
          factsAdded: 1,
          rejected: 0,
          superseded: 0,
          skippedAgentOutput: 0,
          skippedDocuments: 0,
          skippedEmpty: 0,
          indexed: 0,
          forgottenRequestChunks: 0,
          busy: false,
          needsReview: [],
          errors: [],
          judgeUnavailable: [],
        };
      },
      budgetExhausted: () => false,
    });
    try {
      consolidator.notify(`group:telegram:1`);
      // Nessun timer armato: il tenant di gruppo non ha mai raggiunto la riga
      // che incrementa `sinceLastRun` (`notify` esce prima), quindi non e'
      // mai a un turno dalla soglia che fa scattare l'estrazione.
      expect(consolidator.isArmed()).toBe(false);
      await consolidator.settled();
      expect(calls).toEqual([]);
    } finally {
      consolidator.stop();
      db.close();
    }
  });
});

describe('un errore di memoria non spegne la superficie', () => {
  it("se addEpisode lancia, l'update viene comunque archiviato e il prossimo elaborato", async () => {
    const h = harness({ token: 't', ownerUserId: OWNER, ownerChatId: OWNER });
    try {
      const store = h.runtime.deps.memory!.store;
      const originale = store.addEpisode.bind(store);
      let lanci = 0;
      // Lancia **una volta sola**, sul ramo silenzioso; poi torna vero.
      // Altrimenti il turno aperto dal secondo update, che scrive il suo
      // episodio dal loop, incontrerebbe lo stesso errore e proverebbe
      // un'altra cosa.
      (store as unknown as { addEpisode: unknown }).addEpisode = (...args: unknown[]) => {
        lanci += 1;
        if (lanci === 1) throw new Error('FOREIGN KEY constraint failed');
        return (originale as (...a: unknown[]) => unknown)(...args);
      };
      await deliver(h, [groupMsg(1, 'prima riga'), groupMsg(2, '@MuffinBot ci sei?')]);
      (store as unknown as { addEpisode: unknown }).addEpisode = originale;

      expect(lanci).toBeGreaterThanOrEqual(2);
      // Il secondo update — quello che apre un turno — e' stato elaborato lo
      // stesso: senza il `try`, l'eccezione del primo fermava `drain()` e il
      // provider non veniva mai chiamato.
      expect(h.seen).toHaveLength(1);
    } finally {
      h.runtime.close();
    }
  });
});
