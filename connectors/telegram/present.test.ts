import { describe, expect, it } from 'vitest';
import { TelegramError, type InlineButton, type TelegramApiLike } from './api.js';
import { present, presentationOf, presentationOfHtml } from './present.js';

/**
 * La waist della presentazione fuori-turno, al filo.
 *
 * I test dei producer registrano la lane rich come il suo gemello legacy (le
 * asserzioni restano sul testo visibile); qui invece si pinna **quale** lane
 * parte: rich per primo, legacy solo su rifiuto deterministico (`status > 0`),
 * e uno status 0 che risale senza ritentare. È la prova che togliere il filo
 * fa fallire qualcosa — un fake normalizzato non distingue le due strade.
 */

type Call = {
  method: string;
  chatId: number;
  messageId?: number;
  text: string;
  threadId?: number;
  replyTo?: number;
  keyboard?: unknown;
};

function fake(options: { rich?: 'ok' | 'refuse' | 'ambiguous' | 'notModified' } = {}): {
  api: TelegramApiLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const modo = options.rich ?? 'ok';
  const richError = (): void => {
    if (modo === 'refuse') throw new TelegramError(400, 'Bad Request: ricco rifiutato (simulato)');
    if (modo === 'notModified') throw new Error('Bad Request: message is not modified');
    throw new Error('rete giù');
  };
  const record = (
    method: string,
    chatId: number,
    text: string,
    options2?: { threadId?: number; replyTo?: number; keyboard?: unknown },
    messageId?: number,
  ): void => {
    calls.push({
      method,
      chatId,
      ...(messageId === undefined ? {} : { messageId }),
      text,
      ...(options2?.threadId === undefined ? {} : { threadId: options2.threadId }),
      ...(options2?.replyTo === undefined ? {} : { replyTo: options2.replyTo }),
      ...(options2?.keyboard === undefined ? {} : { keyboard: options2.keyboard }),
    });
  };
  const testo = (rich: { html?: string; blocks?: unknown[] }): string =>
    typeof rich.html === 'string' ? rich.html : JSON.stringify(rich.blocks ?? []);
  const api = {
    sendMessage: async (chatId: number, html: string, o?: { threadId?: number; replyTo?: number; keyboard?: unknown }) => {
      record('sendMessage', chatId, html, o);
      return { message_id: calls.length, date: 0, chat: { id: chatId, type: 'private' } };
    },
    sendRichMessage: async (
      chatId: number,
      rich: { html?: string; blocks?: unknown[] },
      o?: { threadId?: number; replyTo?: number; keyboard?: unknown },
    ) => {
      record('sendRichMessage', chatId, testo(rich), o);
      if (modo !== 'ok') richError();
      return { message_id: calls.length, date: 0, chat: { id: chatId, type: 'private' } };
    },
    editMessageText: async (chatId: number, messageId: number, html: string, o?: { keyboard?: unknown }) => {
      record('editMessageText', chatId, html, o, messageId);
      return true;
    },
    editMessageRichText: async (
      chatId: number,
      messageId: number,
      rich: { html?: string; blocks?: unknown[] },
      o?: { keyboard?: unknown },
    ) => {
      if (modo !== 'ok') richError();
      record('editMessageRichText', chatId, testo(rich), o, messageId);
      return true;
    },
  } as unknown as TelegramApiLike;
  return { api, calls };
}

const keyboard: InlineButton[][] = [[{ text: 'ok', callback_data: 'ok:1' }]];

describe('present · rich per primo, legacy solo su rifiuto deterministico', () => {
  it('la send parte ricca, con thread, citazione e tastiera sulla stessa chiamata', async () => {
    const { api, calls } = fake();
    const esito = await present(
      api,
      { chatId: 7, threadId: 3, replyTo: 9, keyboard },
      presentationOf('**ciao**\n\nmondo'),
    );

    expect(esito).toBe('rich');
    expect(calls.map((c) => c.method)).toEqual(['sendRichMessage']);
    expect(calls[0]).toMatchObject({ chatId: 7, threadId: 3, replyTo: 9, keyboard });
    expect(calls[0]!.text).toContain('<b>ciao</b>');
    // L'a-capo ricco, non il `\n` nudo che il renderer collassa.
    expect(calls[0]!.text).toContain('<br>');
  });

  it('un rifiuto deterministico scende ai pezzi legacy: thread ovunque, citazione sul primo, tastiera sull’ultimo', async () => {
    const { api, calls } = fake({ rich: 'refuse' });
    const lunga = Array.from({ length: 300 }, (_, i) => `riga numero ${i} di un testo che non entra in un messaggio`).join('\n');
    const esito = await present(api, { chatId: 7, threadId: 3, replyTo: 9, keyboard }, presentationOf(lunga));

    expect(esito).toBe('legacy');
    // Il tentativo ricco c'è stato, ed è stato rifiutato: una volta sola.
    expect(calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1);
    const legacy = calls.filter((c) => c.method === 'sendMessage');
    expect(legacy.length).toBeGreaterThan(1);
    for (const call of legacy) {
      expect(call.threadId).toBe(3);
    }
    expect(legacy.filter((c) => c.replyTo === 9)).toHaveLength(1);
    expect(legacy[0]!.replyTo).toBe(9);
    expect(legacy.filter((c) => c.keyboard !== undefined)).toHaveLength(1);
    expect(legacy.at(-1)!.keyboard).toBe(keyboard);
    expect(legacy.map((c) => c.text).join('')).toContain('riga numero 299');
  });

  it('uno status 0 è ambiguo: risale, e il legacy non parte mai (niente doppioni)', async () => {
    const { api, calls } = fake({ rich: 'ambiguous' });
    await expect(present(api, { chatId: 7 }, presentationOf('ciao'))).rejects.toThrow('rete giù');
    expect(calls.map((c) => c.method)).toEqual(['sendRichMessage']);
  });

  it('`message is not modified` non è un fallimento: il messaggio è già come lo vogliamo', async () => {
    const { api, calls } = fake({ rich: 'notModified' });
    const esito = await present(api, { chatId: 7 }, presentationOf('ciao'));
    expect(esito).toBe('rich');
    expect(calls.map((c) => c.method)).toEqual(['sendRichMessage']);
  });

  it('l’edit parte ricco; su rifiuto l’edit legacy porta `keyboard: []` esplicita', async () => {
    const ok = fake();
    await present(ok.api, { chatId: 7, editMessageId: 55, keyboard: [] }, presentationOfHtml('verdetto'));
    expect(ok.calls.map((c) => c.method)).toEqual(['editMessageRichText']);
    expect(ok.calls[0]).toMatchObject({ messageId: 55, keyboard: [] });

    const giù = fake({ rich: 'refuse' });
    await present(giù.api, { chatId: 7, editMessageId: 55, keyboard: [] }, presentationOfHtml('verdetto'));
    expect(giù.calls.map((c) => c.method)).toEqual(['editMessageText']);
    expect(giù.calls[0]).toMatchObject({ messageId: 55, keyboard: [] });
  });

  it('oltre i limiti di protocollo non si tenta il ricco: si va dritti ai pezzi', async () => {
    const { api, calls } = fake();
    const esito = await present(api, { chatId: 7 }, presentationOfHtml('x'.repeat(40_000)));
    expect(esito).toBe('legacy');
    expect(calls.some((c) => c.method === 'sendRichMessage')).toBe(false);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('una presentazione vuota non manda niente', async () => {
    const { api, calls } = fake();
    const esito = await present(api, { chatId: 7 }, presentationOf(''));
    expect(esito).toBe('legacy');
    expect(calls).toEqual([]);
  });
});
