import type { Update } from '@grammyjs/types';
import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../../core/approvals/store.js';
import type { LoopDeps } from '../../agent/loop.js';
import { SessionStore } from '../../core/session/store.js';
import { TurnStore } from '../../core/turns/store.js';
import type { TelegramApi } from './api.js';
import { TelegramConnector } from './connector.js';
import { TelegramDeliveryStore } from './delivery.js';
import { UpdateInbox } from './updates.js';

/**
 * Il dito sul pulsante.
 *
 * L'altra metà della domanda: i pulsanti li manda l'approvatore
 * (`cli/surface.ts`), qui torna la risposta — come un update qualunque, forse
 * a un processo che quel turno non l'ha mai visto.
 *
 * Le cose che devono valere non sono «la decisione viene scritta». Sono che
 * **il pulsante smette sempre di girare** (`answerCallbackQuery` va mandata
 * anche quando la risposta è storta: è il momento in cui l'owner sta
 * guardando per capire se il tocco ha funzionato), e che **la tastiera non
 * risponde a chi non ha fatto la domanda**.
 */

const OWNER = 771001;
const STRANGER = 771002;

const premuto = (data: string, from = OWNER): Update =>
  ({
    update_id: 1,
    callback_query: {
      id: 'q1',
      from: { id: from, is_bot: false, first_name: 'x' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 55,
        date: 0,
        chat: { id: OWNER, type: 'private' },
        text: '⚠ eseguo rm -rf /tmp/x?',
      },
    },
  }) as unknown as Update;

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'muffin-appr-tg-'));
  const db = new DatabaseCtor(':memory:');
  const approvals = new ApprovalStore(db);
  const turns = new TurnStore(db);

  const risposte: { id: string; text?: string | undefined }[] = [];
  const spinte: number[] = [];
  const modifiche: { chatId: number; messageId: number; html: string }[] = [];
  const api = {
    answerCallbackQuery: async (id: string, text?: string) => {
      risposte.push({ id, text });
      return true;
    },
    editMessageText: async (chatId: number, messageId: number, html: string) => {
      modifiche.push({ chatId, messageId, html });
      return true;
    },
    sendMessage: async () => ({}) as never,
    sendChatAction: async () => true,
  } as unknown as TelegramApi;

  const loop = {
    provider: { kind: 'openai-compat' as const, chat: async () => ({}) as never },
    profile: { iterationCap: 2 },
    model: 't',
    tools: [],
    decide: () => ({ effect: 'allow' as const }),
    tracer: { start: () => ({ traceId: 't', setAttributes: () => {}, end: () => {} }) },
    sessions: new SessionStore(home),
    turns,
    budgetExhausted: () => false,
    systemPrompts: { owner: 'x', group: 'x' },
  } as unknown as LoopDeps;

  const connector = new TelegramConnector({
    loop,
    sessions: loop.sessions,
    inbox: new UpdateInbox(db),
    delivery: new TelegramDeliveryStore(db),
    api,
    approvals,
    onWork: () => spinte.push(1),
    config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER },
  });
  return { connector, approvals, turns, risposte, modifiche, spinte };
}

async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

/** Una riga sospesa come la scrive il loop quando la domanda parte. */
function turnoInAttesa(h: ReturnType<typeof harness>): { turnId: string; approvalId: string } {
  const turnId = 'a'.repeat(32);
  // `create` restituisce la riga già reclamata (`running`), con il suo token:
  // è la forma che ha un turno mentre sta girando, cioè il momento in cui il
  // kernel decide di chiedere.
  const record = h.turns.create({
    id: turnId,
    principal: { kind: 'owner', connector: 'telegram', externalId: String(OWNER) },
    tenant: 'host',
    surface: 'telegram',
    sessionId: `telegram:${OWNER}`,
    model: 't',
    messages: [],
    taint: 0,
    counters: {
      iterations: 1,
      recoveriesUsed: 0,
      transportRetriesLeft: 2,
      toolCallsMade: 1,
      nudgedForCompletion: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0,
      resumes: 0,
      contextBuilt: true,
    },
  });
  const approvalId = h.approvals.ask(
    { turnId, capability: 'sys.shell', resource: 'rm -rf /tmp/x', prompt: 'eseguo?', taint: 0 },
    new Date(),
  );
  h.turns.suspend(
    turnId,
    {
      messages: [],
      taint: 0,
      counters: record.counters,
      wakeAt: new Date(Date.now() + 3_600_000).toISOString(),
      waitFor: `approval:${approvalId}`,
    },
    record.claimToken,
  );
  return { turnId, approvalId };
}

describe('un pulsante premuto dall owner', () => {
  it('scrive la decisione, chiude il pulsante, e riporta il turno eseguibile', async () => {
    const h = harness();
    const { turnId, approvalId } = turnoInAttesa(h);

    await deliver(h, [premuto(`ok:${approvalId}`)]);

    expect(h.approvals.get(approvalId)?.decision).toBe('allow');
    expect(h.risposte[0]).toEqual({ id: 'q1', text: 'Consentito.' });
    // Da `waiting` a `runnable`: a farlo girare è la corsia, non il connettore
    // — che però le dice di guardare subito, invece di far aspettare mezzo
    // minuto chi ha appena premuto.
    expect(h.turns.get(turnId)?.status).toBe('runnable');
    expect(h.spinte).toHaveLength(1);
  });

  it('e un rifiuto è un rifiuto, non un silenzio', async () => {
    const h = harness();
    const { approvalId } = turnoInAttesa(h);

    await deliver(h, [premuto(`no:${approvalId}`)]);

    expect(h.approvals.get(approvalId)?.decision).toBe('deny');
    expect(h.risposte[0]?.text).toBe('Rifiutato.');
  });

  /**
   * Una tastiera che resta premibile dopo la risposta invita a rispondere due
   * volte a una domanda già chiusa. Il messaggio dice cosa è stato deciso, e i
   * pulsanti spariscono perché `editMessageText` non li rimanda.
   */
  it('il messaggio dice cosa è stato deciso, e i pulsanti spariscono', async () => {
    const h = harness();
    const { approvalId } = turnoInAttesa(h);

    await deliver(h, [premuto(`ok:${approvalId}`)]);

    expect(h.modifiche[0]?.messageId).toBe(55);
    expect(h.modifiche[0]?.html).toContain('consentito');
    expect(h.modifiche[0]?.html).toContain('eseguo rm -rf /tmp/x?');
  });
});

describe('il pulsante smette sempre di girare', () => {
  /**
   * Finché `answerCallbackQuery` non arriva, il client mostra il pulsante che
   * gira. Vale soprattutto per i casi storti: è lì che l'owner sta guardando
   * per capire se il tocco ha funzionato.
   */
  it('anche quando la domanda era già stata risposta', async () => {
    const h = harness();
    const { approvalId } = turnoInAttesa(h);
    h.approvals.decide(approvalId, 'allow', new Date());

    await deliver(h, [premuto(`no:${approvalId}`)]);

    expect(h.risposte[0]?.text).toContain('già risposto');
    // E la prima risposta resta quella buona.
    expect(h.approvals.get(approvalId)?.decision).toBe('allow');
  });

  it('e quando quella domanda non esiste più', async () => {
    const h = harness();
    await deliver(h, [premuto('ok:deadbeefdeadbeef')]);
    expect(h.risposte[0]?.text).toContain('non esiste più');
  });

  it('e quando il pulsante porta qualcosa che non abbiamo scritto noi', async () => {
    const h = harness();
    await deliver(h, [premuto('ok:../../etc/passwd')]);
    expect(h.risposte[0]?.text).toContain('Non so a cosa si riferisca');
  });
});

describe('la tastiera non risponde a chi non ha fatto la domanda', () => {
  /**
   * In un gruppo quei pulsanti li vedono tutti. Un estraneo che ne preme uno
   * riceve la stessa risposta vuota di un pulsante scaduto: non gli si
   * conferma che era una domanda vera, fatta a qualcun altro.
   */
  it('uno sconosciuto non decide niente, e non scopre niente', async () => {
    const h = harness();
    const { turnId, approvalId } = turnoInAttesa(h);

    await deliver(h, [premuto(`ok:${approvalId}`, STRANGER)]);

    expect(h.approvals.get(approvalId)?.decision).toBeNull();
    expect(h.turns.get(turnId)?.status).toBe('waiting');
    // E nessuna corsia svegliata per niente.
    expect(h.spinte).toEqual([]);
    // Risposto sì — il pulsante non deve girare per sempre — ma senza testo:
    // nemmeno «non sei autorizzato», che confermerebbe che c'è qualcosa.
    expect(h.risposte).toEqual([{ id: 'q1', text: undefined }]);
  });
});
