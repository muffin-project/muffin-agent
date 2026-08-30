import { describe, expect, it, vi } from 'vitest';
import { startProgress, formatTelegramProgress } from './progress.js';
import type { TelegramApiLike } from './api.js';
import type { TurnEvent } from '../../agent/loop.js';

/**
 * `startProgress` — M5-BIS B13. Rate limit, coalescing, no-op-on-unchanged,
 * disable-on-failure and cleanup-on-stop, each against a fake `TelegramApiLike`
 * that records every call with the fake clock's own timestamp, the same shape
 * `presence.test.ts` uses for the sibling sink and for the same reason: a test
 * asserting ">=3s apart" costs nothing in wall-clock time and is not flaky
 * under load.
 *
 * Reads through the public `startProgress`/`ProgressReporter` contract only —
 * the point of most of these is that they would go red if the *wiring* inside
 * `startProgress` were undone (drop the rate limit, drop the coalescing, drop
 * disable-on-failure), which is the PRACTICES.md#model-judgement-and-deterministic-contracts-stay-separate shape: assert the mechanism
 * is reached, not only that its pieces compile. The *composition* — that
 * `agent/loop.ts`'s real `onProgress` calls reach a real `TelegramConnector`'s
 * Telegram calls — is `streaming.test.ts`'s own "M5-BIS B13" describe block,
 * not this file.
 */

type Recorded = { method: string; at: number; text?: string; messageId?: number };

function fakeApi(makeOverrides?: (calls: Recorded[]) => Partial<TelegramApiLike>): { api: TelegramApiLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let nextMessageId = 700;
  const api: TelegramApiLike = {
    call: async () => {
      throw new Error('unused in this fake');
    },
    upload: async () => {
      throw new Error('unused in this fake');
    },
    getMe: async () => {
      throw new Error('unused in this fake');
    },
    getUpdates: async () => [],
    sendMessage: async (chatId, html) => {
      const messageId = nextMessageId++;
      calls.push({ method: 'sendMessage', at: Date.now(), text: html, messageId });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } } as never;
    },
    editMessageText: async (_chatId, messageId, html) => {
      calls.push({ method: 'editMessageText', at: Date.now(), text: html, messageId });
      return true;
    },
    deleteMessage: async (_chatId, messageId) => {
      calls.push({ method: 'deleteMessage', at: Date.now(), messageId });
      return true;
    },
    sendChatAction: async () => {
      throw new Error('unused in this fake');
    },
    sendMessageDraft: async () => {
      throw new Error('unused in this fake');
    },
    fileUrl: async () => 'https://example.test/file',
    setMyCommands: async () => true,
    answerCallbackQuery: async () => true,
    ...(makeOverrides ? makeOverrides(calls) : {}),
  };
  return { api, calls };
}

const round = (n: number): TurnEvent => ({ type: 'round', n });
const toolStart = (name: string, args?: unknown): TurnEvent => ({ type: 'tool_start', name, capability: 'test', ...(args === undefined ? {} : { args }) });
const toolEnd = (name: string, isError = false): TurnEvent => ({ type: 'tool_end', name, ms: 1, isError });
const modelEvent = (stopReason: string): TurnEvent => ({
  type: 'model',
  model: 'test-model',
  ms: 1,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  stopReason,
});

describe('telegram progress · formatTelegramProgress (M5-BIS B13)', () => {
  /**
   * Cosa sta facendo, e da quanto. Niente numero di giro.
   *
   * L'owner ha acceso Telegram il 28/08/2026, ha letto le sue prime righe di
   * avanzamento e ha detto: «non voglio che scriva "passaggio 1", voglio che
   * scriva cosa sta facendo». `passaggio N` è un contatore interno al loop —
   * quante volte ha parlato il modello — e occupava il posto in testa, cioè
   * l'unico pezzo che si legge davvero guardando un telefono di sfuggita.
   */
  it('dice cosa sta facendo e da quanto, senza il numero del giro', () => {
    expect(formatTelegramProgress(round(3), 0)).toBe('sto pensando · 0s');
    expect(formatTelegramProgress(modelEvent('tool_use'), 5000)).toBe('ho deciso i prossimi passi · 5s');
    expect(formatTelegramProgress(modelEvent('end'), 5000)).toBe('sto scrivendo la risposta · 5s');
    expect(formatTelegramProgress(toolEnd('shell_run', false), 50_000)).toBe('✓ eseguo un comando · 50s');
    expect(formatTelegramProgress(toolEnd('shell_run', true), 50_000)).toBe('✗ eseguo un comando · 50s');
  });

  /**
   * Le stesse parole del terminale, dalla stessa mappa.
   *
   * Qui si leggeva `sto usando fs_list` mentre il REPL diceva `guardo una
   * cartella: core/memory` — stessa persona, stesso istante, due vocabolari.
   * Il commento su `tool_end` in `progress.ts` la regola l'aveva già scritta;
   * non poteva mantenerla finché le frasi stavano dietro la porta della CLI
   * (`agent/tool-phrase.ts`, estratto il 28/08).
   */
  it('e usa le stesse parole del terminale, argomento compreso', () => {
    expect(formatTelegramProgress(toolStart('fs_list', { path: 'core/memory' }), 47_000)).toBe(
      'guardo una cartella: core/memory · 47s',
    );
    expect(formatTelegramProgress(toolStart('shell_run'), 47_000)).toBe('eseguo un comando · 47s');
  });

  it('escapes HTML in a tool name — the model chooses `call.name`, and this line is sent with parse_mode HTML', () => {
    const text = formatTelegramProgress(toolStart('<script>&</script>'), 0);
    expect(text).not.toContain('<script>');
    // Un tool MCP non sta nella mappa delle frasi, quindi il nome grezzo passa
    // di qui — ed è esattamente il caso in cui l'escape deve tenere.
    expect(text).toBe('&lt;script&gt;&amp;&lt;/script&gt; · 0s');
  });

  it('rounds elapsed time to the nearest second and never prints a negative one', () => {
    expect(formatTelegramProgress(round(1), 499)).toBe('sto pensando · 0s');
    expect(formatTelegramProgress(round(1), 500)).toBe('sto pensando · 1s');
    expect(formatTelegramProgress(round(1), -50)).toBe('sto pensando · 0s');
  });
});

describe('telegram progress · startProgress (M5-BIS B13)', () => {
  it('creates the status message on the first event and rate-limits edits to >=3s apart', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
      expect(calls[0]?.text).toBe('sto pensando · 0s');

      // Arrives inside the 3s window (at t=1s) — must coalesce, not fire yet.
      await vi.advanceTimersByTimeAsync(1000);
      progress.report(toolStart('shell_run'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0);

      // The window opens at t=3s; the coalesced latest value goes out as an
      // edit — but its elapsed time reads "1s", not "3s": a progress event
      // reports a fact already true *when it happened* (`report`'s own call
      // site, t=1s), never re-timestamped at whatever later instant the
      // throttle finally lets it out.
      await vi.advanceTimersByTimeAsync(1000);
      const edits = calls.filter((c) => c.method === 'editMessageText');
      expect(edits).toHaveLength(1);
      expect(edits[0]?.text).toBe('eseguo un comando · 1s');

      const [t0, t1] = [calls[0]!.at, edits[0]!.at];
      expect(t1 - t0).toBeGreaterThanOrEqual(3000);

      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never duplicates the message — every update after the first edits the same message id', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);
      progress.report(round(2));
      await vi.advanceTimersByTimeAsync(3000);
      progress.report(round(3));
      await vi.advanceTimersByTimeAsync(3000);

      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
      const messageId = calls[0]!.messageId;
      const edits = calls.filter((c) => c.method === 'editMessageText');
      expect(edits.length).toBeGreaterThanOrEqual(1);
      expect(edits.every((c) => c.messageId === messageId)).toBe(true);

      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips an edit whose rendered text has not changed since the last one shown — Telegram itself rejects a no-op edit', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);

      progress.report(toolStart('shell_run'));
      await vi.advanceTimersByTimeAsync(0);
      const afterFirst = calls.length;

      // The exact same event again, at the exact same fake-clock instant: the
      // rendered line is byte-identical.
      progress.report(toolStart('shell_run'));
      await vi.advanceTimersByTimeAsync(3000); // well past the throttle window reopening
      expect(calls.length).toBe(afterFirst); // no edit was ever attempted

      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('MUTATION-worthy: disables further attempts after the first failed send, without retrying into it', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { api } = fakeApi(() => ({
        sendMessage: async () => {
          attempts += 1; // counted before throwing, so a dropped `disabled` flag still shows up
          throw new Error('telegram rejected it');
        },
      }));
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0); // one attempt, fails
      progress.report(round(2));
      await vi.advanceTimersByTimeAsync(5000); // past the throttle window — a second attempt here would mean `disabled` never latched
      progress.report(round(3));
      await vi.advanceTimersByTimeAsync(5000);

      expect(attempts).toBe(1);
      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed edit (after a successful create) also disables the rest of the turn — MUTATION: dropping `disabled` would retry every 3s forever', async () => {
    vi.useFakeTimers();
    try {
      let editAttempts = 0;
      const { api, calls } = fakeApi(() => ({
        editMessageText: async () => {
          editAttempts += 1;
          throw new Error('telegram rejected it');
        },
      }));
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0); // the create succeeds
      progress.report(round(2));
      await vi.advanceTimersByTimeAsync(3000); // one failed edit attempt
      progress.report(round(3)); // must not attempt a second edit
      await vi.advanceTimersByTimeAsync(10_000);

      expect(editAttempts).toBe(1);
      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() removes the status message it created, with the same message id', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);
      const messageId = calls[0]!.messageId;

      await progress.stop();

      const deletions = calls.filter((c) => c.method === 'deleteMessage');
      expect(deletions).toHaveLength(1);
      expect(deletions[0]?.messageId).toBe(messageId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() before any event was ever shown makes no API call at all', async () => {
    const { api, calls } = fakeApi();
    const progress = startProgress(api, 1);
    await progress.stop();
    expect(calls).toHaveLength(0);
  });

  it('stop() is idempotent', async () => {
    vi.useFakeTimers();
    try {
      const { api } = fakeApi();
      const progress = startProgress(api, 1);
      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);
      await progress.stop();
      await expect(progress.stop()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a report() after stop() is ignored — no message is recreated', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);
      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);
      await progress.stop();
      const before = calls.length;

      progress.report(round(2));
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT force out a never-yet-shown update on stop() — deliberate divergence from presence.ts', async () => {
    // `presence.ts`'s own `stop()` forces out whatever `streamText` last
    // accumulated, because that channel (`sendMessageDraft`) is exclusive to
    // it. This reporter's `send()` calls `sendMessage`/`editMessageText` —
    // the *same* methods the durable answer is sent on — so a forced flush
    // here would inject one more call onto that exact channel for a status
    // line about to be deleted regardless. `connectors/telegram/inbound-
    // unit.test.ts`'s fault-point tests are what first caught this the other
    // way round (extra `sendMessage` calls where those tests assert an exact
    // count) — this test pins the fix down directly.
    vi.useFakeTimers();
    try {
      const { api, calls } = fakeApi();
      const progress = startProgress(api, 1);

      progress.report(round(1)); // schedules its own flush at wait=0, never allowed to fire
      // No `advanceTimersByTimeAsync` here on purpose — `stop()` runs before
      // that timer ever would.
      await progress.stop();

      expect(calls).toHaveLength(0); // nothing sent, nothing to delete
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed deleteMessage on stop() is swallowed, not thrown', async () => {
    vi.useFakeTimers();
    try {
      const { api } = fakeApi(() => ({
        deleteMessage: async () => {
          throw new Error('telegram rejected it');
        },
      }));
      const progress = startProgress(api, 1);
      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);

      await expect(progress.stop()).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('traces a swallowed failure through the optional logger, and never throws without one', async () => {
    vi.useFakeTimers();
    try {
      const logged: string[] = [];
      const { api } = fakeApi(() => ({
        sendMessage: async () => {
          throw new Error('telegram rejected it');
        },
      }));
      const progress = startProgress(api, 1, { log: (line) => logged.push(line) });
      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0);

      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('telegram rejected it');
      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Latenza sul lato **Bot API**, che nessun test simulava.
 *
 * Il judge su #143 ha trovato qui due guasti, entrambi **senza crash**:
 * `flushTimer` diceva soltanto se un flush fosse *programmato*, mai se un
 * invio fosse *in volo*. Nel divario ci stavano due messaggi di stato invece
 * di uno, e un messaggio che nessuno cancella mai — con entrambe le chiamate a
 * `stop()` che ritornavano pulite e niente da nessuna parte a dirlo.
 *
 * Non è un caso di frontiera: `api.ts` ritenta un 429 al suo interno con una
 * pausa che supera regolarmente `MIN_EDIT_MS`, e i turni lunghi — l'unica
 * ragione per cui questa funzione esiste — sono i più esposti.
 */
describe('telegram progress · un invio lento non produce due messaggi né un orfano', () => {
  /** Un `sendMessage` che resta sul filo finché non lo si lascia andare. */
  function slowSendApi(): { api: TelegramApiLike; calls: Recorded[]; release: () => void } {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api, calls } = fakeApi((recorded) => ({
      sendMessage: async (chatId, html) => {
        await gate;
        const messageId = 900;
        recorded.push({ method: 'sendMessage', at: Date.now(), text: html, messageId });
        return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } } as never;
      },
    }));
    return { api, calls, release };
  }

  it('al massimo un sendMessage per reporter, anche se il primo è ancora sul filo', async () => {
    vi.useFakeTimers();
    try {
      const { api, calls, release } = slowSendApi();
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0); // il flush parte: sendMessage è sul filo, bloccato
      expect(calls).toHaveLength(0); // non è ancora tornato

      // Un secondo evento mentre il primo invio non è ancora tornato. Senza la
      // serializzazione entrambi leggono `messageId === null` e chiamano
      // `sendMessage`: due messaggi veri, e quello perdente resta orfano per
      // sempre perché `stop()` conosce un id solo.
      progress.report(toolStart('shell_run'));
      await vi.advanceTimersByTimeAsync(3000); // si riapre la finestra del throttle

      release();
      await vi.advanceTimersByTimeAsync(0);
      await progress.stop();

      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
      // E il secondo evento è arrivato come modifica di quel messaggio, non
      // come messaggio nuovo.
      expect(calls.filter((c) => c.method === 'editMessageText').length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('se stop() ritorna, il messaggio che ha creato non sopravvive — anche correndo contro il primo invio', async () => {
    // Il più semplice dei due: un evento solo, e `stop()` arriva mentre il
    // `sendMessage` è ancora fuori. Prima leggeva `messageId` in modo
    // sincrono, vedeva `null`, non cancellava niente e usciva pulito — e
    // l'invio che si risolveva dopo scriveva il suo id in una closure che
    // nessuno rilegge.
    vi.useFakeTimers();
    try {
      const { api, calls, release } = slowSendApi();
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0); // invio sul filo

      const stopping = progress.stop();
      release();
      await vi.advanceTimersByTimeAsync(0);
      await stopping;
      await progress.stop(); // il secondo, come lo chiama davvero il connettore

      expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
      expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(1);
      expect(calls.find((c) => c.method === 'deleteMessage')?.messageId).toBe(900);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * I due follow-up del judge fresco su #143 — uno su un comportamento che la
 * riparazione ha **introdotto**, l'altro su una guardia che nessuno dei
 * diciassette test esercitava.
 */
describe('telegram progress · il tetto di stop() e la guardia della catena', () => {
  it('stop() non tiene la risposta in ostaggio di un invio che non torna', async () => {
    // Misurato dal judge sulla versione senza tetto: timer finti avanzati di
    // ventiquattro ore con un invio bloccato, e `stop()` non tornava mai.
    // La risposta vera parte DOPO `stop()` (`runFresh` lo attende prima di
    // `deliverTo`), quindi quell'attesa la paga l'owner — per ripulire una
    // riga cosmetica.
    vi.useFakeTimers();
    try {
      let never = (): void => {};
      const gate = new Promise<void>((resolve) => {
        never = resolve;
      });
      const { api, calls } = fakeApi((recorded) => ({
        sendMessage: async (chatId, html) => {
          await gate;
          recorded.push({ method: 'sendMessage', at: Date.now(), text: html, messageId: 900 });
          return { message_id: 900, date: 0, chat: { id: chatId, type: 'private' } } as never;
        },
      }));
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0); // invio sul filo, e non tornerà

      let resolved = false;
      const stopping = progress.stop().then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(resolved).toBe(false); // aspetta, ma non per sempre
      await vi.advanceTimersByTimeAsync(1_000); // superato STOP_WAIT_MS
      await stopping;
      expect(resolved).toBe(true);

      // Il compromesso dichiarato: resta una riga cosmetica, non una risposta
      // trattenuta. Non c'era un id da cancellare, quindi niente deleteMessage.
      expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0);
      never(); // libera il gate per non lasciare la promise appesa
    } finally {
      vi.useRealTimers();
    }
  });

  it('mai due chiamate insieme: un anello che finisce non deve slegare la catena', async () => {
    // La guardia `if (inFlight === mine)` nel `finally` di `send()` è
    // necessaria, e togliendola tutti e diciassette i test restavano verdi.
    //
    // Lo scenario che la cattura ha bisogno di tre anelli, non due: serve un
    // invio che **finisce** mentre il successivo è ancora sul filo. Senza la
    // guardia, il `finally` del primo azzera `inFlight` — che nel frattempo
    // punta al secondo — e il terzo invio non si incatena a niente: parte
    // subito, insieme al secondo. È la stessa classe di difetto che #143
    // ripara, un livello più in profondità.
    vi.useFakeTimers();
    try {
      let concurrent = 0;
      let maxConcurrent = 0;
      let releaseSend = (): void => {};
      let releaseEdit = (): void => {};
      const sendGate = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      const editGate = new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });
      let firstEdit = true;
      const { api } = fakeApi(() => ({
        sendMessage: async (chatId) => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await sendGate; // il primo anello: lento, ma finirà
          concurrent -= 1;
          return { message_id: 900, date: 0, chat: { id: chatId, type: 'private' } } as never;
        },
        editMessageText: async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          if (firstEdit) {
            firstEdit = false;
            await editGate; // il secondo anello: ancora sul filo quando arriva il terzo
          }
          concurrent -= 1;
          return true;
        },
      }));
      const progress = startProgress(api, 1);

      progress.report(round(1));
      await vi.advanceTimersByTimeAsync(0); // sendMessage parte e si blocca
      progress.report(toolStart('a'));
      await vi.advanceTimersByTimeAsync(3_000); // il secondo si incatena al primo

      releaseSend(); // il PRIMO finisce: qui il finally senza guardia azzera inFlight
      await vi.advanceTimersByTimeAsync(0); // il secondo parte e si blocca

      progress.report(toolStart('b')); // il terzo, mentre il secondo è fuori
      await vi.advanceTimersByTimeAsync(3_000);

      expect(maxConcurrent).toBe(1);

      releaseEdit();
      await vi.advanceTimersByTimeAsync(0);
      await progress.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
