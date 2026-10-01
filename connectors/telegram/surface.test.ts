import { describe, expect, it } from 'vitest';
import type { TelegramApiLike } from './api.js';
import { telegramSurface } from './surface.js';

/**
 * La consegna fuori banda, al confine.
 *
 * `scheduler.ts` consegna anche un esito in errore con testo vuoto — il ramo
 * che di proposito non assorbe un guasto (il silenzio lì sarebbe
 * indistinguibile da «niente da dire»). Al base quel testo arrivava a
 * `sendMessage('')`, la rete lo rifiutava, e il turno finiva
 * `delivery_failed`; con `present` una presentazione vuota è un no-op, quindi
 * senza il controllo esplicito sarebbe diventata un `DELIVERED` muto — un
 * guasto travestito da consegna (reperto del judge, 30/09).
 */

function fake(): { api: TelegramApiLike; calls: string[] } {
  const calls: string[] = [];
  const api = {
    sendMessage: async (_chatId: number, html: string) => {
      calls.push(html);
      return { message_id: calls.length } as never;
    },
    sendRichMessage: async (_chatId: number, rich: { html?: string }) => {
      calls.push(rich.html ?? 'rich');
      return { message_id: calls.length } as never;
    },
  } as unknown as TelegramApiLike;
  return { api, calls };
}

describe('deliver · un testo vuoto non è una consegna', () => {
  it('non manda niente e dice perché', async () => {
    const { api, calls } = fake();
    const esito = await telegramSurface(api, 42).deliver('telegram', '');
    expect(esito.delivered).toBe(false);
    if (!esito.delivered) expect(esito.why).toContain('niente da consegnare');
    expect(calls).toEqual([]);
  });

  it('e un testo che esiste parte dalla lane ricca', async () => {
    const { api, calls } = fake();
    const esito = await telegramSurface(api, 42).deliver('telegram', 'promemoria');
    expect(esito.delivered).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
