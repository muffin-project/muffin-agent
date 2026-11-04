import { describe, expect, it } from 'vitest';
import type { ApprovalRequest, ApprovalWhere } from '../../agent/loop.js';
import { TelegramError, type TelegramApiLike } from './api.js';
import { approvatoreTelegram, askHtml, askKeyboard, askPlain } from './approval.js';

/**
 * Il vocabolario della domanda, e la strada di ripiego.
 *
 * La strada normale — la domanda dentro il messaggio del turno — la prova
 * `transcript.test.ts`; qui si pinna il vocabolario condiviso (le stesse
 * parole su entrambe le strade) e il ripiego: quando nessuna trascrizione viva
 * può ospitarla, la domanda esce come messaggio autonomo con la tastiera
 * sull'ultimo pezzo. Mai muta, mai senza pulsanti.
 */

const request: ApprovalRequest = {
  capability: 'sys.shell.write',
  prompt: 'non si torna indietro: cambia questa macchina — sys.shell.write',
  resource: 'command: echo ciao\ncwd: .',
  description: 'stampa la parola ciao',
  taint: 2,
};

const where: ApprovalWhere = {
  surface: 'telegram',
  turnId: 't1',
  replyTo: { chatId: 42, messageId: 7 },
  approvalId: 'aabbccdd',
};

function recordingApi(refuseRich = false): { api: TelegramApiLike; calls: { method: string; chatId: number; text: string; threadId?: unknown; keyboard?: unknown }[] } {
  const calls: { method: string; chatId: number; text: string; threadId?: unknown; keyboard?: unknown }[] = [];
  const record = (method: string, chatId: number, html: string, options?: { threadId?: unknown; keyboard?: unknown }): void => {
    calls.push({
      method,
      chatId,
      text: html,
      ...(options?.threadId === undefined ? {} : { threadId: options.threadId }),
      ...(options?.keyboard === undefined ? {} : { keyboard: options.keyboard }),
    });
  };
  const api = {
    sendMessage: async (chatId: number, html: string, options?: { threadId?: unknown; keyboard?: unknown }) => {
      record('sendMessage', chatId, html, options);
      return { message_id: calls.length, date: 0, chat: { id: chatId, type: 'private' } };
    },
    // La lane rich si registra come il suo gemello legacy: le asserzioni
    // restano sul testo visibile e sulla tastiera. Con `refuseRich` il
    // rifiuto è deterministico (status > 0), e `present` scende ai pezzi.
    sendRichMessage: async (
      chatId: number,
      rich: { html?: string; blocks?: unknown[] },
      options?: { threadId?: unknown; keyboard?: unknown },
    ) => {
      record('sendRichMessage', chatId, rich.html ?? JSON.stringify(rich.blocks ?? []), options);
      if (refuseRich) throw new TelegramError(400, 'Bad Request: ricco rifiutato (simulato)');
      return { message_id: calls.length, date: 0, chat: { id: chatId, type: 'private' } };
    },
  } as unknown as TelegramApiLike;
  return { api, calls };
}

describe('askHtml / askPlain · le stesse parole, due rese', () => {
  it('porta prompt, descrizione, comando e taint — in quest’ordine', () => {
    const html = askHtml(request);
    expect(html).toContain('non si torna indietro');
    expect(html).toContain('stampa la parola ciao');
    expect(html).toContain('echo ciao');
    expect(html).toContain('taint 2');
    expect(html.indexOf('non si torna indietro')).toBeLessThan(html.indexOf('stampa la parola ciao'));
    expect(html.indexOf('stampa la parola ciao')).toBeLessThan(html.indexOf('echo ciao'));
  });

  it('il gemello in testo semplice dice le stesse cose, senza markup', () => {
    const plain = askPlain(request);
    expect(plain).toContain('non si torna indietro');
    expect(plain).toContain('stampa la parola ciao');
    expect(plain).toContain('echo ciao');
    expect(plain).toContain('taint 2');
    expect(plain).not.toContain('<b>');
    expect(plain).not.toContain('<pre>');
  });

  it('la tastiera porta l’id dentro i due pulsanti, verbatim', () => {
    const keyboard = askKeyboard('sys.shell.write', 'aabbccdd');
    expect(keyboard.flat().map((b) => b.callback_data)).toEqual(['ok:aabbccdd', 'no:aabbccdd']);
  });
});

describe('approvatoreTelegram · il ripiego, quando nessuna trascrizione può ospitarla', () => {
  it('manda la domanda intera e mette la tastiera sull’ultimo pezzo', async () => {
    const { api, calls } = recordingApi();
    const esito = await approvatoreTelegram(api)(request, where);

    expect(esito).toBe('asked');
    expect(calls).toHaveLength(1);
    // La lane è quella ricca: la politica fuori-turno non è un `sendMessage`
    // ad hoc che per caso manda le stesse parole.
    expect(calls[0]!.method).toBe('sendRichMessage');
    expect(calls[0]!.text).toContain('non si torna indietro');
    expect(calls[0]!.text).toContain('echo ciao');
    expect(calls[0]!.keyboard).toBeDefined();
  });

  it('in un topic ogni pezzo porta il thread: la domanda di ripiego non finisce in *General*', async () => {
    // Oltre il tetto di compatibilità la domanda non parte ricca: scende ai
    // pezzi legacy — il caso che il difetto riguardava. Il ricco, quando
    // parte, è un messaggio solo e il thread lo porta per costruzione.
    const { api, calls } = recordingApi();
    // Abbastanza lunga da spezzarsi: il difetto non è solo sul primo pezzo, è
    // che ogni `sendMessage` del ripiego ignorava `where.replyTo.threadId`.
    const lunga: ApprovalRequest = { ...request, resource: `command: ${'x'.repeat(9000)}` };
    const esito = await approvatoreTelegram(api)(lunga, {
      ...where,
      replyTo: { chatId: 42, messageId: 7, threadId: 77 },
    });

    expect(esito).toBe('asked');
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) expect(call.threadId).toBe(77);
    expect(calls.at(-1)!.keyboard).toBeDefined();
  });

  it('fuori da un topic non aggiunge nessun thread — la DM resta la DM', async () => {
    const { api, calls } = recordingApi();
    await approvatoreTelegram(api)(request, where);
    for (const call of calls) expect(call.threadId).toBeUndefined();
  });

  it('senza indirizzo durevole non inventa la chat dell’owner: `unavailable`', async () => {
    const { api, calls } = recordingApi();
    const esito = await approvatoreTelegram(api)(request, { ...where, replyTo: undefined });
    expect(esito).toBe('unavailable');
    expect(calls).toEqual([]);
  });

  it('senza id nel registro non può chiedere: `unavailable`', async () => {
    const { api, calls } = recordingApi();
    const esito = await approvatoreTelegram(api)(request, { ...where, approvalId: undefined });
    expect(esito).toBe('unavailable');
    expect(calls).toEqual([]);
  });
});

describe('approvatoreTelegram · onAsked registra dove la domanda si è mostrata (#784)', () => {
  it('dopo l’invio chiama onAsked con l’id del registro e quello del messaggio', async () => {
    const { api, calls } = recordingApi();
    const viste: { approvalId: string; messageId: number }[] = [];
    const esito = await approvatoreTelegram(api, (m) => {
      viste.push(m);
    })(request, where);

    expect(esito).toBe('asked');
    expect(viste).toHaveLength(1);
    expect(viste[0]!.approvalId).toBe('aabbccdd');
    expect(typeof viste[0]!.messageId).toBe('number');
    // È il messaggio mandato davvero, non un numero inventato.
    expect(calls.length).toBeGreaterThan(0);
  });

  it('una domanda spezzata registra l’ultimo pezzo: è lì che sta la tastiera', async () => {
    const { api, calls } = recordingApi();
    const lunga: ApprovalRequest = { ...request, resource: `command: ${'x'.repeat(9000)}` };
    const viste: { approvalId: string; messageId: number }[] = [];
    const esito = await approvatoreTelegram(api, (m) => {
      viste.push(m);
    })(lunga, where);

    expect(esito).toBe('asked');
    expect(calls.length).toBeGreaterThan(1);
    expect(viste).toHaveLength(1);
    // L’ultimo pezzo è l’unico con la tastiera.
    expect(calls.at(-1)!.keyboard).toBeDefined();
  });

  it('un gancio che lancia non rompe la domanda: è già partita', async () => {
    const { api, calls } = recordingApi();
    const esito = await approvatoreTelegram(api, () => {
      throw new Error('simulato');
    })(request, where);

    expect(esito).toBe('asked');
    expect(calls).toHaveLength(1);
  });

  it('senza gancio non cambia niente: `asked` come prima', async () => {
    const { api, calls } = recordingApi();
    const esito = await approvatoreTelegram(api)(request, where);

    expect(esito).toBe('asked');
    expect(calls).toHaveLength(1);
  });
});
