import type { Update } from '@grammyjs/types';
import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../../core/approvals/store.js';
import type { ApprovalRequest, LoopDeps } from '../../agent/loop.js';
import { SessionStore } from '../../core/session/store.js';
import { TurnStore } from '../../core/turns/store.js';
import type { TelegramApi } from './api.js';
import { TelegramConnector, rimuoviTastiereOrfane, type ConnectorDeps } from './connector.js';
import { ModelLane } from '../../core/turns/model-lane.js';
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

const premuto = (data: string, from = OWNER, updateId = 1, message?: Record<string, unknown>): Update =>
  ({
    update_id: updateId,
    callback_query: {
      id: 'q1',
      from: { id: from, is_bot: false, first_name: 'x' },
      chat_instance: 'ci',
      data,
      message: message ?? {
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
  /**
   * Ogni chiamata owner-visible del finto Bot API, con la tastiera quando c'è:
   * la trascrizione parla rich, e la domanda deve poter essere letta e
   * ritrovata per messaggio.
   */
  const inviati: { method: string; chatId?: number; messageId?: number; text?: string; threadId?: unknown; keyboard?: unknown }[] = [];
  let nextMessageId = 700;
  const testoDi = (rich: { html?: string; blocks?: unknown[] }): string =>
    typeof rich.html === 'string' ? rich.html : JSON.stringify(rich.blocks ?? []);
  const api = {
    answerCallbackQuery: async (id: string, text?: string) => {
      risposte.push({ id, text });
      return true;
    },
    editMessageText: async (chatId: number, messageId: number, html: string, options?: { keyboard?: unknown }) => {
      modifiche.push({ chatId, messageId, html });
      inviati.push({ method: 'editMessageText', chatId, messageId, text: html, ...(options?.keyboard === undefined ? {} : { keyboard: options.keyboard }) });
      return true;
    },
    editMessageRichText: async (chatId: number, messageId: number, rich: { html?: string; blocks?: unknown[] }, options?: { keyboard?: unknown }) => {
      const text = testoDi(rich);
      modifiche.push({ chatId, messageId, html: text });
      inviati.push({ method: 'editMessageText', chatId, messageId, text, ...(options?.keyboard === undefined ? {} : { keyboard: options.keyboard }) });
      return true;
    },
    editMessageReplyMarkup: async (chatId: number, messageId: number, keyboard: unknown[] = []) => {
      inviati.push({ method: 'editMessageReplyMarkup', chatId, messageId, keyboard });
      return true;
    },
    sendMessage: async (chatId: number, html: string, options?: { threadId?: unknown; keyboard?: unknown }) => {
      const messageId = nextMessageId++;
      inviati.push({ method: 'sendMessage', chatId, messageId, text: html, ...(options?.threadId === undefined ? {} : { threadId: options.threadId }), ...(options?.keyboard === undefined ? {} : { keyboard: options.keyboard }) });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } } as never;
    },
    sendRichMessage: async (chatId: number, rich: { html?: string; blocks?: unknown[] }, options?: { threadId?: unknown; keyboard?: unknown }) => {
      const messageId = nextMessageId++;
      inviati.push({ method: 'sendMessage', chatId, messageId, text: testoDi(rich), ...(options?.threadId === undefined ? {} : { threadId: options.threadId }), ...(options?.keyboard === undefined ? {} : { keyboard: options.keyboard }) });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } } as never;
    },
    sendMessageDraft: async () => true,
    sendRichMessageDraft: async () => true,
    deleteMessage: async () => true,
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
    lane: new ModelLane(),
    inbox: new UpdateInbox(db),
    delivery: new TelegramDeliveryStore(db),
    api,
    approvals,
    onWork: () => spinte.push(1),
    config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER },
  });
  return { connector, approvals, turns, risposte, modifiche, spinte, inviati, api };
}

async function deliver(h: ReturnType<typeof harness>, updates: Update[]): Promise<void> {
  const inbox = (h.connector as unknown as { deps: { inbox: UpdateInbox } }).deps.inbox;
  inbox.accept(updates, new Date().toISOString());
  await (h.connector as unknown as { drain: () => Promise<void> }).drain();
}

/** Una riga sospesa come la scrive il loop quando la domanda parte. */
function turnoInAttesa(h: ReturnType<typeof harness>, replyTo?: Record<string, unknown>): { turnId: string; approvalId: string } {
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
    ...(replyTo === undefined ? {} : { replyTo }),
    counters: {
      iterations: 1,
      recoveriesUsed: 0,
      transportRetriesLeft: 2,
      truncationsUsed: 0,
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
    // La tastiera si toglie nella stessa chiamata che scrive il verdetto:
    // senza l'asserzione, togliere `keyboard: []` dal produttore non farebbe
    // fallire niente (reperto del judge).
    const verdetto = h.inviati.find((c) => c.method === 'editMessageText' && c.messageId === 55);
    expect(verdetto?.keyboard).toEqual([]);
  });

  /**
   * La domanda di ripiego parte ricca (`present`): il messaggio del callback
   * non ha `text`, solo `rich_message`. Guardare solo `text` salterebbe
   * l'edit — e la tastiera resterebbe premibile su una domanda chiusa
   * (reperto bloccante del judge, 30/09).
   */
  it('una domanda partita ricca non ha `text`: il verdetto la legge dai blocchi, la tastiera sparisce', async () => {
    const h = harness();
    const { approvalId } = turnoInAttesa(h);

    await deliver(h, [
      premuto(`ok:${approvalId}`, OWNER, 1, {
        message_id: 55,
        date: 0,
        chat: { id: OWNER, type: 'private' },
        rich_message: { blocks: [{ type: 'paragraph', text: '⚠ eseguo rm -rf /tmp/x?' }] },
      }),
    ]);

    expect(h.modifiche[0]?.messageId).toBe(55);
    expect(h.modifiche[0]?.html).toContain('consentito');
    expect(h.modifiche[0]?.html).toContain('eseguo rm -rf /tmp/x?');
    const verdetto = h.inviati.find((c) => c.method === 'editMessageText' && c.messageId === 55);
    expect(verdetto?.keyboard).toEqual([]);
  });

  /**
   * #760 — il verdetto di ripiego in un topic resta nel topic.
   *
   * Una domanda di ripiego partita ricca dentro un topic di forum, il cui
   * verdetto ri-renderizzato supera il tetto di compatibilità (8192): il
   * primo pezzo è un `editMessageText` (gli edit non portano thread, giusto
   * così) ma i pezzi in coda sono `sendMessage` — e senza thread finirebbero
   * in *General*. Falsificatore: togliere `threadId` dal target di `present`
   * in `handleCallback` deve far fallire questo test (e nessun altro).
   */
  it('un verdetto oltre il tetto in un topic: ogni `sendMessage` di coda porta il thread', async () => {
    const h = harness();
    const { approvalId } = turnoInAttesa(h);

    const THREAD = 77;
    // Oltre il tetto di compatibilità: il verdetto non parte ricco — il
    // primo pezzo riusa il messaggio, la coda sono `sendMessage`.
    const domandaLunga = `⚠ eseguo rm -rf /tmp/x?\n${'x'.repeat(9000)}`;
    await deliver(h, [
      premuto(`ok:${approvalId}`, OWNER, 1, {
        message_id: 55,
        date: 0,
        chat: { id: OWNER, type: 'private' },
        message_thread_id: THREAD,
        text: domandaLunga,
      }),
    ]);

    expect(h.approvals.get(approvalId)?.decision).toBe('allow');
    // Il primo pezzo riusa il messaggio: è un edit, e gli edit non portano thread.
    expect(h.inviati[0]?.method).toBe('editMessageText');
    expect(h.inviati[0]?.messageId).toBe(55);
    const coda = h.inviati.filter((c) => c.method === 'sendMessage');
    expect(coda.length).toBeGreaterThan(0);
    for (const pezzo of coda) expect(pezzo.threadId).toBe(THREAD);
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

/**
 * #746 — un Turn ripreso che sospende di nuovo su un'approvazione resta vivo.
 *
 * Il difetto: `makeLaneRunner` chiude sempre il sink nel suo `finally`, anche
 * quando la ripresa torna `suspended` su un'approvazione. Da quando la domanda
 * vive sul messaggio del turno (#737), `transcript.stop()` con una domanda
 * pendente toglie la tastiera per costruzione: la seconda approvazione di un
 * turno ripreso restava visibile ma non azionabile, e il passo non si
 * risolveva più. Il percorso fresco ha la guardia (`apriIlVivo.ran` tiene
 * aperta la trascrizione); quello ripreso no.
 *
 * Il test guida il percorso reale: AttachStream del connettore → approvatore
 * reale (la domanda compare sul messaggio del turno) → finalizzazione del
 * sink come la fa la lane → decisione dell'owner → stesso passo, stesso
 * messaggio, stesso turno svegliato.
 */
describe('#746 — un turno ripreso che sospende di nuovo resta approvabile', () => {
  it('la tastiera resta viva, la decisione risolve lo stesso passo, il turno riprende', async () => {
    const h = harness();
    const { turnId } = turnoInAttesa(h, { chatId: OWNER, messageId: 5 });

    // La corsia riprende il turno sospeso: l'AttachStream reale apre la
    // trascrizione sull'indirizzo durevole della riga.
    const stream = h.connector.resumeStream(h.turns.get(turnId)!);
    expect(stream).toBeDefined();

    // Il turno ripreso chiede una seconda approvazione: è l'approvatore reale,
    // e la domanda deve comparire sul messaggio del turno con la tastiera.
    const request: ApprovalRequest = {
      capability: 'sys.shell.write',
      prompt: 'non si torna indietro: cambia questa macchina — sys.shell.write',
      resource: 'command: echo ciao',
      taint: 0,
    };
    const secondId = h.approvals.ask({ turnId, capability: request.capability, resource: request.resource, prompt: request.prompt, taint: 0 }, new Date());
    await expect(
      h.connector.approval(request, { surface: 'telegram', turnId, replyTo: { chatId: OWNER, messageId: 5 }, approvalId: secondId }),
    ).resolves.toBe('asked');
    const domanda = h.inviati.find((c) => c.method === 'sendMessage' && c.keyboard !== undefined);
    expect(domanda).toBeDefined();
    const askMessageId = domanda!.messageId!;

    // La finalizzazione dell'AttachStream, come la fa `makeLaneRunner` quando
    // `resumeTurn` torna `suspended`.
    await stream!.stop?.();

    // La tastiera non è stata tolta: la domanda è ancora azionabile.
    const rimosse = h.inviati.filter((c) => c.method === 'editMessageReplyMarkup' && Array.isArray(c.keyboard) && c.keyboard.length === 0);
    expect(rimosse).toEqual([]);

    // L'owner decide: lo stesso passo si risolve, nello stesso messaggio, e il
    // turno viene svegliato. L'edit della trascrizione è rate-limited
    // (`editEveryMs`), quindi si attende che parta.
    await deliver(h, [premuto(`ok:${secondId}`)]);
    expect(h.approvals.get(secondId)?.decision).toBe('allow');
    const scadenza = Date.now() + 3_000;
    const risolto = (): boolean =>
      h.modifiche.some((m) => m.messageId === askMessageId && m.html.includes('sys.shell.write: consentito'));
    while (!risolto() && Date.now() < scadenza) await new Promise((r) => setTimeout(r, 50));
    expect(risolto()).toBe(true);
    expect(h.spinte.length).toBeGreaterThan(0);
  });
});

/**
 * #742 — un tocco su una domanda ritirata non decide niente.
 *
 * Il turno è finito mentre la domanda era aperta: il registro l'ha ritirata.
 * Il pulsante può ancora essere sullo schermo (una bolla di ripiego, un
 * client che non ha aggiornato): il tocco deve togliere la tastiera e dire
 * che non serve più, mai scrivere «consentito» per un turno che non c'è.
 */
describe('#742 — una domanda ritirata non decide', () => {
  it('risponde che non serve più, toglie la tastiera, non sveglia il turno', async () => {
    const h = harness();
    const { turnId, approvalId } = turnoInAttesa(h);
    h.approvals.withdrawForTurn(turnId, new Date());

    await deliver(h, [premuto(`ok:${approvalId}`)]);

    expect(h.approvals.get(approvalId)?.decision).toBeNull();
    expect(h.turns.get(turnId)?.status).toBe('waiting');
    expect(h.spinte).toEqual([]);
    expect(h.risposte[0]?.text).toContain('Non serve più');
    expect(h.inviati.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
  });
});

/**
 * #745 — il click di una domanda vecchia non risolve un altro turno.
 *
 * `handleCallback` cercava la trascrizione per **chat** come ripiego: una
 * approvazione di un turno finito, con la stessa capability di una domanda
 * viva di un altro turno nella stessa chat, ne risolveva il passo. La ricerca
 * ora è per turno (la mappa si riempie quando la domanda è presa).
 */
describe('#745 — il click di una domanda vecchia non risolve un altro turno', () => {
  it('una approvazione del turno A non tocca il passo in attesa del turno B', async () => {
    const h = harness();
    const counters = {
      iterations: 1,
      recoveriesUsed: 0,
      transportRetriesLeft: 10,
      truncationsUsed: 0,
      toolCallsMade: 1,
      nudgedForCompletion: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0,
      resumes: 0,
      contextBuilt: true,
      activeModelMs: 0,
    };
    // Turno B vivo, con una domanda in attesa sul suo messaggio.
    const recordB = h.turns.create(
      {
        id: 'b'.repeat(32),
        principal: { kind: 'owner', connector: 'telegram', externalId: String(OWNER) },
        tenant: 'host',
        surface: 'telegram',
        sessionId: `telegram:${OWNER}`,
        model: 't',
        messages: [],
        taint: 0,
        replyTo: { chatId: OWNER, messageId: 9 },
        counters,
      },
      4242,
    );
    const streamB = h.connector.resumeStream(h.turns.get(recordB.id)!);
    const reqB: ApprovalRequest = {
      capability: 'sys.shell.write',
      prompt: 'non si torna indietro: cambia questa macchina — sys.shell.write',
      resource: 'command: echo b',
      taint: 0,
    };
    const bId = h.approvals.ask({ turnId: recordB.id, capability: reqB.capability, resource: reqB.resource, prompt: reqB.prompt, taint: 0 }, new Date());
    await expect(
      h.connector.approval(reqB, { surface: 'telegram', turnId: recordB.id, replyTo: { chatId: OWNER, messageId: 9 }, approvalId: bId }),
    ).resolves.toBe('asked');
    const domandaB = h.inviati.filter((c) => c.method === 'sendMessage' && c.keyboard !== undefined).at(-1)!;

    // Una domanda vecchia del turno A, stessa capability e risorsa.
    const aId = h.approvals.ask({ turnId: 'a'.repeat(32), capability: reqB.capability, resource: reqB.resource, prompt: reqB.prompt, taint: 0 }, new Date());

    await deliver(h, [premuto(`ok:${aId}`)]);

    expect(h.approvals.get(aId)?.decision).toBe('allow');
    // Il passo di B resta in attesa: `resolveAsk` non è mai stato chiamato su
    // di lui — la rimozione della tastiera è immediata (non rate-limited),
    // l'eventuale edit del verdetto arriva dopo il pavimento della stanza.
    const rimozioneB = h.inviati.some(
      (c) => c.method === 'editMessageReplyMarkup' && c.messageId === domandaB.messageId && Array.isArray(c.keyboard) && c.keyboard.length === 0,
    );
    expect(rimozioneB).toBe(false);
    await new Promise((r) => setTimeout(r, 1_800));
    const risoltoB = h.modifiche.some((m) => m.messageId === domandaB.messageId && m.html.includes('consentito'));
    expect(risoltoB).toBe(false);
    await streamB?.stop?.();
  });
});

/**
 * #745 (review) — stessa capability, risorse diverse: due passi, due tastiere,
 * e nessuna riga aperta senza pulsanti. Più il click che arriva **prima**
 * della sospensione: la mappa si riempie quando la domanda è presa.
 */
describe('#745 review — stessa capability su risorse diverse', () => {
  const counters = {
    iterations: 1,
    recoveriesUsed: 0,
    transportRetriesLeft: 10,
    truncationsUsed: 0,
    toolCallsMade: 1,
    nudgedForCompletion: false,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: true,
    activeModelMs: 0,
  };

  function turnoVivo(h: ReturnType<typeof harness>, id: string) {
    const record = h.turns.create(
      {
        id,
        principal: { kind: 'owner', connector: 'telegram', externalId: String(OWNER) },
        tenant: 'host',
        surface: 'telegram',
        sessionId: `telegram:${OWNER}`,
        model: 't',
        messages: [],
        taint: 0,
        replyTo: { chatId: OWNER, messageId: 9 },
        counters,
      },
      4242,
    );
    const stream = h.connector.resumeStream(h.turns.get(record.id)!);
    return { record, stream };
  }

  it('due domande `sys.shell.write` su comandi diversi: ognuna risolve la sua, nessuna resta muta', async () => {
    const h = harness();
    const { record, stream } = turnoVivo(h, 'c'.repeat(32));
    const uno: ApprovalRequest = {
      capability: 'sys.shell.write',
      prompt: 'non si torna indietro: cambia questa macchina — sys.shell.write',
      resource: 'command: echo uno',
      taint: 0,
    };
    const due: ApprovalRequest = { ...uno, resource: 'command: echo due' };
    const id1 = h.approvals.ask({ turnId: record.id, capability: uno.capability, resource: uno.resource, prompt: uno.prompt, taint: 0 }, new Date());
    await expect(h.connector.approval(uno, { surface: 'telegram', turnId: record.id, replyTo: { chatId: OWNER, messageId: 9 }, approvalId: id1 })).resolves.toBe('asked');
    const id2 = h.approvals.ask({ turnId: record.id, capability: due.capability, resource: due.resource, prompt: due.prompt, taint: 0 }, new Date());
    await expect(h.connector.approval(due, { surface: 'telegram', turnId: record.id, replyTo: { chatId: OWNER, messageId: 9 }, approvalId: id2 })).resolves.toBe('asked');

    const messaggio = h.inviati.filter((c) => c.method === 'sendMessage' && c.keyboard !== undefined).at(-1)!.messageId!;
    const testo = h.inviati.map((c) => c.text ?? '').join('\n');
    expect(testo).toContain('echo uno');
    expect(testo).toContain('echo due');

    // Il click sulla seconda: la tastiera passa alla prima, che resta aperta
    // e azionabile — mai una riga aperta senza pulsanti.
    await deliver(h, [premuto(`ok:${id2}`)]);
    const tastieraDopo = h.inviati.filter((c) => c.method === 'editMessageReplyMarkup').at(-1)!;
    expect(JSON.stringify(tastieraDopo.keyboard)).toContain(id1);
    expect(h.approvals.get(id1)?.decision).toBeNull();

    await new Promise((r) => setTimeout(r, 1_800));
    const edit = h.modifiche.filter((m) => m.messageId === messaggio).at(-1)!;
    expect(edit.html).toMatch(/⏸[\s\S]*echo uno/);
    expect(edit.html).toMatch(/✓[\s\S]*echo due[\s\S]*consentito/);

    // Il click sulla prima chiude anche lei.
    await deliver(h, [premuto(`ok:${id1}`, OWNER, 2)]);
    expect(h.approvals.get(id1)?.decision).toBe('allow');
    await stream?.stop?.();
  });

  it('un click che arriva prima della sospensione trova comunque il passo', async () => {
    const h = harness();
    const { record, stream } = turnoVivo(h, 'd'.repeat(32));
    const req: ApprovalRequest = {
      capability: 'sys.shell.write',
      prompt: 'non si torna indietro: cambia questa macchina — sys.shell.write',
      resource: 'command: echo presto',
      taint: 0,
    };
    const id = h.approvals.ask({ turnId: record.id, capability: req.capability, resource: req.resource, prompt: req.prompt, taint: 0 }, new Date());
    await expect(h.connector.approval(req, { surface: 'telegram', turnId: record.id, replyTo: { chatId: OWNER, messageId: 9 }, approvalId: id })).resolves.toBe('asked');
    const messaggio = h.inviati.filter((c) => c.method === 'sendMessage' && c.keyboard !== undefined).at(-1)!.messageId!;

    // Nessuna sospensione è stata registrata: il click arriva subito.
    await deliver(h, [premuto(`ok:${id}`)]);

    await new Promise((r) => setTimeout(r, 1_800));
    const edit = h.modifiche.filter((m) => m.messageId === messaggio).at(-1)!;
    expect(edit.html).toContain('sys.shell.write: consentito');
    await stream?.stop?.();
  });
});

/**
 * #784 — la bolla vecchia perde la tastiera senza che nessuno la tocchi.
 *
 * Fino a qui la chiusura terminale (`withdrawForTurn`, #742) ritirava la
 * riga ma non poteva toccare il messaggio: l'id della domanda non era
 * persistito, e il processo che finisce il turno non ha mai visto la bolla
 * mandata da quello morto prima del riavvio. La tastiera restava viva finché
 * qualcuno non la premeva — e premerla diceva «Non serve più».
 *
 * La prova guida il percorso vero: domanda chiesta (sul messaggio del turno
 * o di ripiego) → processo «morto» (un connettore nuovo sullo stesso
 * database, mappe in memoria vuote) → chiusura terminale del turno →
 * consegna finale. La vecchia bolla deve perdere i pulsanti senza che nessun
 * update di callback sia mai arrivato.
 */
describe('#784 — restart con domanda aperta: la vecchia bolla si spegne da sola', () => {
  const domanda: ApprovalRequest = {
    capability: 'sys.shell.write',
    prompt: 'non si torna indietro: cambia questa macchina — sys.shell.write',
    resource: 'command: echo ciao',
    taint: 0,
  };

  /** Un «processo nuovo» sullo stesso database: niente mappe in memoria. */
  function riavvia(h: ReturnType<typeof harness>): TelegramConnector {
    const deps = (h.connector as unknown as { deps: ConnectorDeps }).deps;
    return new TelegramConnector({ ...deps });
  }

  function spente(h: ReturnType<typeof harness>, messageId: number): boolean {
    return h.inviati.some(
      (c) => c.method === 'editMessageReplyMarkup' && c.messageId === messageId && Array.isArray(c.keyboard) && c.keyboard.length === 0,
    );
  }

  it('domanda di ripiego: registrata all’invio, spenta alla consegna finale dopo il restart', async () => {
    const h = harness();
    // Nessuna trascrizione viva: la domanda esce come messaggio autonomo.
    const { turnId, approvalId } = turnoInAttesa(h, { chatId: OWNER, messageId: 5 });
    await expect(
      h.connector.approval(domanda, { surface: 'telegram', turnId, replyTo: { chatId: OWNER, messageId: 5 }, approvalId }),
    ).resolves.toBe('asked');
    const bolla = h.inviati.find((c) => c.method === 'sendMessage' && c.keyboard !== undefined)!;
    expect(bolla).toBeDefined();
    expect(h.approvals.get(approvalId)?.questionMessageIds).toEqual([bolla.messageId!]);

    // Il processo muore e uno nuovo finisce il turno: chiusura terminale
    // (come la fa `closeRecord`) e consegna finale.
    const dopo = riavvia(h);
    h.approvals.withdrawForTurn(turnId, new Date());
    await dopo.deliverTo(turnId, { chatId: OWNER }, 'fatto');

    expect(spente(h, bolla.messageId!)).toBe(true);
    // Senza nessun tocco: nessuna risposta al pulsante, nessuna decisione.
    expect(h.risposte).toEqual([]);
    expect(h.approvals.get(approvalId)?.decision).toBeNull();
  });

  it('domanda sul messaggio del turno: restart, turno finito, vecchia bolla senza pulsanti', async () => {
    const h = harness();
    const { turnId, approvalId } = turnoInAttesa(h, { chatId: OWNER, messageId: 5 });
    const stream = h.connector.resumeStream(h.turns.get(turnId)!);
    await expect(
      h.connector.approval(domanda, { surface: 'telegram', turnId, replyTo: { chatId: OWNER, messageId: 5 }, approvalId }),
    ).resolves.toBe('asked');
    const bolla = h.inviati.find((c) => c.method === 'sendMessage' && c.keyboard !== undefined)!;
    expect(h.approvals.get(approvalId)?.questionMessageIds).toEqual([bolla.messageId!]);

    const dopo = riavvia(h);
    h.approvals.withdrawForTurn(turnId, new Date());
    await dopo.deliverTo(turnId, { chatId: OWNER }, 'fatto');

    expect(spente(h, bolla.messageId!)).toBe(true);
    expect(h.risposte).toEqual([]);
    expect(h.approvals.get(approvalId)?.decision).toBeNull();
    await stream?.stop?.();
  });

  it('re-ask dopo il riavvio: si spengono la bolla vecchia e quella nuova', async () => {
    const h = harness();
    const { turnId, approvalId } = turnoInAttesa(h, { chatId: OWNER, messageId: 5 });
    await expect(
      h.connector.approval(domanda, { surface: 'telegram', turnId, replyTo: { chatId: OWNER, messageId: 5 }, approvalId }),
    ).resolves.toBe('asked');
    const prima = h.inviati.filter((c) => c.method === 'sendMessage' && c.keyboard !== undefined).at(-1)!.messageId!;

    // Il processo nuovo ri-chiede la stessa domanda (stessa riga riusata):
    // bolla nuova, e la vecchia resta registrata.
    const dopo = riavvia(h);
    await expect(
      dopo.approval(domanda, { surface: 'telegram', turnId, replyTo: { chatId: OWNER, messageId: 5 }, approvalId }),
    ).resolves.toBe('asked');
    const seconda = h.inviati.filter((c) => c.method === 'sendMessage' && c.keyboard !== undefined).at(-1)!.messageId!;
    expect(seconda).not.toBe(prima);
    expect(h.approvals.get(approvalId)?.questionMessageIds).toEqual([prima, seconda]);

    h.approvals.withdrawForTurn(turnId, new Date());
    await dopo.deliverTo(turnId, { chatId: OWNER }, 'fatto');

    expect(spente(h, prima)).toBe(true);
    expect(spente(h, seconda)).toBe(true);
    expect(h.risposte).toEqual([]);
  });

  it('due righe sulla stessa bolla: un solo edit, non due', async () => {
    const h = harness();
    const { turnId } = turnoInAttesa(h, { chatId: OWNER, messageId: 5 });
    const prima = h.approvals.ask({ turnId, capability: 'sys.shell', resource: 'uno', prompt: 'uno?', taint: 0 }, new Date());
    const seconda = h.approvals.ask({ turnId, capability: 'sys.http', resource: 'due', prompt: 'due?', taint: 0 }, new Date());
    h.approvals.noteQuestionMessage(prima, 700);
    h.approvals.noteQuestionMessage(seconda, 700);

    h.approvals.withdrawForTurn(turnId, new Date());
    await rimuoviTastiereOrfane(h.api, h.approvals, turnId, OWNER);

    expect(h.inviati.filter((c) => c.method === 'editMessageReplyMarkup' && c.messageId === 700)).toHaveLength(1);
  });

  it('righe senza registrazione non producono edit: né crash né falsi', async () => {
    const h = harness();
    // Mai mostrata sul filo: la riga di prima della colonna.
    const { turnId } = turnoInAttesa(h);
    h.approvals.withdrawForTurn(turnId, new Date());

    await rimuoviTastiereOrfane(h.api, h.approvals, turnId, OWNER);

    expect(h.inviati.filter((c) => c.method === 'editMessageReplyMarkup')).toEqual([]);
  });

  it('un tocco tardivo su domanda registrata dice la stessa frase di sempre, byte per byte', async () => {
    const h = harness();
    const { approvalId } = turnoInAttesa(h);
    h.approvals.noteQuestionMessage(approvalId, 700);
    h.approvals.withdrawForTurn('a'.repeat(32), new Date());

    await deliver(h, [premuto(`ok:${approvalId}`)]);

    expect(h.risposte[0]?.text).toBe('Non serve più: quel turno è finito.');
    expect(h.approvals.get(approvalId)?.decision).toBeNull();
    expect(h.spinte).toEqual([]);
  });

  it('la spazzata non lancia mai: registro guasto, filo guasto, o niente registro', async () => {
    const h = harness();
    const { turnId, approvalId } = turnoInAttesa(h);
    h.approvals.noteQuestionMessage(approvalId, 700);
    h.approvals.withdrawForTurn(turnId, new Date());

    const registroGuasto = { withdrawnQuestionMessages: (): never[] => { throw new Error('db giù'); } };
    await expect(rimuoviTastiereOrfane(h.api, registroGuasto, turnId, OWNER)).resolves.toBeUndefined();
    const filoGuasto = { editMessageReplyMarkup: async (): Promise<never> => { throw new Error('rete giù'); } };
    await expect(rimuoviTastiereOrfane(filoGuasto, h.approvals, turnId, OWNER)).resolves.toBeUndefined();
    await expect(rimuoviTastiereOrfane(h.api, undefined, turnId, OWNER)).resolves.toBeUndefined();
    // E un turno senza niente da spegnere non tocca il filo.
    await expect(rimuoviTastiereOrfane(h.api, h.approvals, 'turno-mai-esistito', OWNER)).resolves.toBeUndefined();
    expect(h.inviati.filter((c) => c.method === 'editMessageReplyMarkup')).toEqual([]);
  });
});
