import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramApi, TelegramError } from './api.js';

/**
 * `api.ts`'s own header names the risk: *"the download URL, which contains
 * the bot token and must never reach a log, a trace or an error message"* —
 * and `media.ts` already avoids `.message` for exactly that reason. `call`
 * and `upload` did not: a fetch failure's `error.message` went straight into
 * `TelegramError`, which `connectors/telegram/connector.ts` logs on every
 * catch. Probed 2026-08-17 against this Node's `fetch` (DNS failure,
 * connection refused, timeout, malformed URL) — `.message` never carried the
 * URL today — but the token sits in the one string (the URL) a future
 * runtime is most likely to start including in a network error, unlike
 * Discord's header, which no HTTP client error has ever been observed to
 * echo. This test does not wait to find out: it fakes the worst case
 * directly, and pins `.name` as the fix.
 */

const TOKEN = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz1234567';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TelegramApi — a fetch failure never carries the token forward', () => {
  it('call(): a fetch rejection whose own message contains the token is not repeated in the thrown error', async () => {
    // The adversarial fake: an error message that already carries the token,
    // exactly what a chattier future `fetch` could hand back given that the
    // token rides in the URL this call just built.
    const leaky = new TypeError(`fetch failed: could not reach https://api.telegram.org/bot${TOKEN}/getMe`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw leaky;
      }),
    );

    const api = new TelegramApi(TOKEN);
    let caught: unknown;
    try {
      // Two attempts happen (one retry on a network failure) before this
      // throws for good — both must avoid the token, so this covers the
      // method's only two exit points from this catch.
      await api.getMe();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramError);
    const message = (caught as TelegramError).message;
    expect(message, 'the thrown error repeated the leaky fetch message').not.toContain(TOKEN);
    expect((caught as TelegramError).description).not.toContain(TOKEN);
  }, 10_000);

  it('upload(): the same adversarial fetch failure, for the multipart path', async () => {
    const leaky = new TypeError(`fetch failed: could not reach https://api.telegram.org/bot${TOKEN}/sendPhoto`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw leaky;
      }),
    );

    const api = new TelegramApi(TOKEN);
    let caught: unknown;
    try {
      await api.upload('sendPhoto', new FormData());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramError);
    expect((caught as TelegramError).message).not.toContain(TOKEN);
    expect((caught as TelegramError).description).not.toContain(TOKEN);
  });

  /**
   * La cucitura: non basta che il token non esca, deve **uscire la causa**. Con
   * il solo `error.name` questi due casi passavano il controllo sul token e
   * lasciavano al diario la parola «TypeError» e nient'altro — che e'
   * esattamente cio' che il gateway ha scritto 3187 volte in diciannove ore.
   */
  it('call(): il codice della causa arriva fino all errore lanciato', async () => {
    const caduto = new TypeError('fetch failed');
    (caduto as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw caduto;
      }),
    );
    const api = new TelegramApi(TOKEN);
    await expect(api.getMe()).rejects.toThrow('ECONNRESET');
  }, 10_000);

  it('call(): un codice che porta il token non e un codice', async () => {
    const caduto = new TypeError('fetch failed');
    (caduto as { cause?: unknown }).cause = { code: `https://api.telegram.org/bot${TOKEN}/getMe` };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw caduto;
      }),
    );
    const api = new TelegramApi(TOKEN);
    let caught: unknown;
    try {
      await api.getMe();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramError);
    expect((caught as TelegramError).message).not.toContain(TOKEN);
    expect((caught as TelegramError).description).toBe('TypeError');
  }, 10_000);

  it('call(): the ordinary case still works — a real response is unaffected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        // The URL is exactly where the token belongs on the wire — this test
        // is not about hiding it from Telegram, only from our own error path.
        expect(String(input)).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
        return new Response(JSON.stringify({ ok: true, result: { id: 1, username: 'muffin_bot' } }));
      }),
    );
    const api = new TelegramApi(TOKEN);
    const me = await api.getMe();
    expect(me).toMatchObject({ id: 1, username: 'muffin_bot' });
  });
});

describe('TelegramApi — visible sends never retry an ambiguous transport failure', () => {
  it('sendMessage makes one HTTP attempt when the response may have been lost after acceptance', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('response stream closed');
    });
    vi.stubGlobal('fetch', fetch);

    const api = new TelegramApi(TOKEN);
    await expect(api.sendMessage(42, 'una sola volta')).rejects.toBeInstanceOf(TelegramError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
