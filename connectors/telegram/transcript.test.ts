import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramApiLike } from './api.js';
import { TELEGRAM_MAX } from './render.js';
import { negoziazioneTelegram } from './negoziazione.js';
import { startTranscript } from './transcript.js';

/** Le due stanze di Telegram, lette dalla tabella di produzione e non riscritte qui. */
const DM = negoziazioneTelegram('direct');
const GRUPPO = negoziazioneTelegram('group');

/**
 * The transcript, driven directly: what one turn's events become on the wire.
 *
 * Fake timers because the whole file is about *when* an edit goes out, and a
 * suite that only asserts *what* was sent would stay green while the counter
 * stops moving (the exact defect the owner saw). The clock is `vi`'s, so
 * `now` is `Date.now` under fake timers and `setTimeout` is the faked one.
 */

type Call = { method: string; text?: string; messageId?: number; draftId?: number; at?: number };

function recordingApi(fail: { send?: boolean; edit?: boolean; draft?: boolean } = {}): { api: TelegramApiLike; calls: Call[] } {
  const calls: Call[] = [];
  let next = 500;
  const api = {
    sendMessage: async (chatId: number, html: string) => {
      if (fail.send) throw new Error('simulato');
      const messageId = next++;
      calls.push({ method: 'sendMessage', text: html, messageId });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } };
    },
    editMessageText: async (_chatId: number, messageId: number, html: string) => {
      if (fail.edit) throw new Error('simulato');
      calls.push({ method: 'editMessageText', text: html, messageId });
      return true;
    },
    deleteMessage: async (_chatId: number, messageId: number) => {
      calls.push({ method: 'deleteMessage', messageId });
      return true;
    },
    // Il momento della chiamata è registrato, non asserito: il «quando» di
    // un rinnovo si misura sui timbri dell'orologio finto, mai su un timer
    // che il test si aspetta di trovare (memoria «i test verdi non guardano
    // il quando»).
    sendMessageDraft: async (_chatId: number, draftId: number, text: string) => {
      if (fail.draft) throw new Error('simulato');
      calls.push({ method: 'sendMessageDraft', text, draftId, at: Date.now() });
      return true;
    },
  } as unknown as TelegramApiLike;
  return { api, calls };
}

const start = (n: string, args?: unknown) => ({ type: 'tool_start' as const, name: n, capability: 'x', args });
const end = (n: string, isError = false, args?: unknown) => ({ type: 'tool_end' as const, name: n, ms: 1, isError, args });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('one bubble per segment', () => {
  it('the preamble and its steps share one message; the model speaking again opens the next', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });

    t.spoke('Prima leggo la spesa.', 'tool-call');
    t.report(start('fs_read', { path: 'spesa.txt' }));
    await vi.advanceTimersByTimeAsync(0);
    t.report(end('fs_read', false, { path: 'spesa.txt' }));
    // A second tool round with no words: same segment.
    t.report(start('fs_read', { path: 'altro.txt' }));
    t.report(end('fs_read', false, { path: 'altro.txt' }));
    await vi.advanceTimersByTimeAsync(2_000);
    // Now the model talks again before acting: a new message.
    t.spoke('Ora scrivo il totale.', 'tool-call');
    t.report(start('fs_write', { path: 'totale.txt' }));
    t.report(end('fs_write', false, { path: 'totale.txt' }));
    await vi.advanceTimersByTimeAsync(2_000);
    await t.stop();

    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(2);
    expect(sends[0]!.text).toContain('Prima leggo la spesa.');
    expect(sends[1]!.text).toContain('Ora scrivo il totale.');
    // The first message ends up carrying both reads, marked done, and nothing live.
    const first = calls.filter((c) => c.messageId === sends[0]!.messageId).at(-1)!.text!;
    expect(first).toContain('✓ leggo un file: spesa.txt');
    expect(first).toContain('✓ leggo un file: altro.txt');
    expect(first).not.toContain('⏳');
    expect(first).not.toContain('<i>');
    // Nothing is ever deleted.
    expect(calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0);
  });

  it('a turn that answers with no tool call sends nothing from here at all', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report({ type: 'round', n: 1 });
    t.report({ type: 'model', model: 'm', ms: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(5_000);
    await t.stop();
    expect(calls).toEqual([]);
  });

  it('a superseded attempt is named, not removed', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.spoke('Provo così.', 'superseded');
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    const text = calls.at(-1)!.text!;
    expect(text).toContain('Provo così.');
    expect(text).toContain('↺ quel tentativo è stato sostituito');
  });
});

describe('the counter moves on its own', () => {
  it('a running step is re-edited with a growing elapsed time although no event fires', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('shell_run', { command: 'npm test' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)!.text).toMatch(/⏳ guardo con un comando: npm test · 0s/);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    const seconds = calls.map((c) => /· (\d+)s/.exec(c.text ?? '')?.[1]).filter((s) => s !== undefined);
    expect(seconds.length).toBeGreaterThanOrEqual(2);
    expect(Number(seconds.at(-1))).toBeGreaterThan(Number(seconds[0]));
    await t.stop();
    // Quiet after stop: no further edits however long we wait.
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(before);
  });

  it('never more than one call per window, and never two on the wire at once', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
    t.report(start('memory_search', { query: 'a' }));
    await vi.advanceTimersByTimeAsync(0);
    t.report(end('memory_search'));
    t.report(start('memory_search', { query: 'b' }));
    t.report(end('memory_search'));
    t.report(start('memory_search', { query: 'c' }));
    await vi.advanceTimersByTimeAsync(GRUPPO.editEveryMs - 1);
    expect(calls).toHaveLength(1); // solo la creazione: il pavimento della stanza non e' ancora passato
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.text).toContain('✓ cerco in memoria: a');
    expect(calls[1]!.text).toContain('✓ cerco in memoria: b');
    expect(calls[1]!.text).toContain('⏳ cerco in memoria: c');
    await t.stop();
  });
});

describe('nothing is cut', () => {
  it('a preamble longer than one message becomes several, in order, each within the limit', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    const long = Array.from({ length: 300 }, (_, i) => `riga ${i} di un preambolo molto lungo che non deve sparire`).join('\n');
    t.spoke(long, 'tool-call');
    t.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends.length).toBeGreaterThan(1);
    for (const s of sends) expect(s.text!.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(sends[0]!.text).toContain('riga 0 ');
    expect(sends.map((s) => s.text).join('\n')).toContain('riga 299 ');
    // The step is on the last one, where the reader is.
    expect(calls.filter((c) => c.messageId === sends.at(-1)!.messageId).at(-1)!.text).toContain('leggo un file: x');
  });

  it('a step that would overflow the segment opens the next one instead of being dropped', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.spoke('x'.repeat(TELEGRAM_MAX - 30), 'tool-call');
    t.report(start('fs_read', { path: 'un-percorso-lungo-abbastanza-da-non-entrare.txt' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(2);
    expect(sends[1]!.text).toContain('leggo un file');
    for (const s of sends) expect(s.text!.length).toBeLessThanOrEqual(TELEGRAM_MAX);
  });
});

describe('stop() is the last edit, never a deletion', () => {
  it('marks a step the turn abandoned and drops the live counter', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('shell_run', { command: 'sleep 99' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    const last = calls.at(-1)!;
    expect(last.method).toBe('editMessageText');
    expect(last.text).toContain('✗ guardo con un comando: sleep 99 — interrotto');
    expect(last.text).not.toMatch(/· \d+s/);
    expect(calls.some((c) => c.method === 'deleteMessage')).toBe(false);
  });

  it('is idempotent and ignores events after it', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('fs_read', { path: 'a' }));
    t.report(end('fs_read'));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    const n = calls.length;
    await t.stop();
    t.report(start('fs_read', { path: 'b' }));
    t.spoke('ancora', 'tool-call');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(n);
  });

  it('does not hold the answer hostage to a send that never returns', async () => {
    const calls: Call[] = [];
    const api = {
      sendMessage: async () => {
        calls.push({ method: 'sendMessage' });
        return new Promise(() => {}); // never resolves
      },
      editMessageText: async () => true,
    } as unknown as TelegramApiLike;
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('fs_read', { path: 'a' }));
    await vi.advanceTimersByTimeAsync(0);
    const stopping = t.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stopping).resolves.toBeUndefined();
  });
});

describe('a Bot API failure is swallowed and disables the rest of the turn', () => {
  it('after a failed create nothing else is attempted, and stop() makes no call', async () => {
    const log: string[] = [];
    const { api, calls } = recordingApi({ send: true });
    const t = startTranscript(api, 1, { negotiation: DM, log: (l) => log.push(l) });
    t.report(start('fs_read', { path: 'a' }));
    await vi.advanceTimersByTimeAsync(0);
    t.report(end('fs_read'));
    t.spoke('e poi', 'tool-call');
    await vi.advanceTimersByTimeAsync(10_000);
    await t.stop();
    expect(calls).toEqual([]);
    expect(log.join('\n')).toContain('trascrizione del turno sospesa');
  });

  it('escapes what the model wrote — the line is sent with parse_mode HTML', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('fs_read', { path: '<b>x</b>' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    expect(calls[0]!.text).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(calls[0]!.text).not.toContain('<b>x</b>');
  });
});

/**
 * `live()` — B11, e dal 06/09/2026 **negoziato per stanza**.
 *
 * La PR #388 aveva tolto l'anteprima `sendMessageDraft` (04/09,
 * `docs/evidence/turno-sospendibile.md`): scadeva dopo trenta secondi e un
 * processo morto smetteva di rinnovarla, quindi l'owner guardava sparire il
 * testo e riceveva la risposta minuti dopo. L'owner il 06/09 ha deciso il
 * contrario di come era stata chiusa: il difetto è **il rinnovo mancante**,
 * non l'anteprima. Quindi in una DM la testa della catena è `'draft'`, e
 * questo blocco misura le due cose che rendono vero quel «quindi»: che
 * l'anteprima si rinnovi dentro la sua finestra, e che non lasci **niente**
 * dietro di sé quando il processo smette di chiamarla.
 *
 * In un gruppo la testa è `'edit'`, e `'edit'` vuol dire alla lettera
 * riscrivere un messaggio *già inviato*: la risposta che si forma si vede
 * dentro il messaggio che il turno possiede già, e nessun messaggio nasce
 * solo per mostrare mezza frase.
 */
describe('live() segue la testa della catena della stanza', () => {
  it('in una DM apre l\'anteprima al primo token e non tocca nessun messaggio vero', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.live('Sto');
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.map((c) => c.method)).toEqual(['sendMessageDraft']);
    expect(calls[0]!.text).toBe('Sto');
    expect(calls[0]!.draftId).toBeGreaterThan(0); // la Bot API rifiuta draft_id = 0
    await t.stop();
    // Niente di durevole: la chat non conserva niente di questo turno finché
    // non arriva la risposta vera.
    expect(calls.some((c) => c.method === 'sendMessage' || c.method === 'editMessageText')).toBe(false);
  });

  it('MUTAZIONE: l\'anteprima si rinnova dentro draftTtlMs anche se nessuno chiama piu\' live()', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.live('Sto preparando la risposta');
    await vi.advanceTimersByTimeAsync(0);

    // Il turno pensa: nessun altro evento, nessun altro token, per molto piu'
    // della finestra dichiarata.
    await vi.advanceTimersByTimeAsync(4 * DM.draftTtlMs);

    const timbri = calls.filter((c) => c.method === 'sendMessageDraft').map((c) => c.at!);
    expect(timbri.length).toBeGreaterThan(1);
    // La proprieta' che conta non e' «quanti», e' «mai un buco piu' lungo
    // della scadenza»: fra due rinnovi consecutivi, e fra l'ultimo e la fine
    // del silenzio.
    const buchi = timbri.slice(1).map((t2, i) => t2 - timbri[i]!);
    for (const buco of buchi) expect(buco).toBeLessThan(DM.draftTtlMs);
    expect(Date.now() - timbri.at(-1)!).toBeLessThan(DM.draftTtlMs);
    await t.stop();
  });

  it('smette di rinnovare quando il testo diventa preambolo di un messaggio vero', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.live('Prima controllo');
    await vi.advanceTimersByTimeAsync(0);
    t.spoke('Prima controllo', 'tool-call');
    t.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(1_500);
    const dopoLaPromozione = calls.filter((c) => c.method === 'sendMessageDraft').length;

    await vi.advanceTimersByTimeAsync(4 * DM.draftTtlMs);
    expect(calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(dopoLaPromozione);
    await t.stop();
    // Il testo ora sta in un messaggio vero, una volta sola.
    const ultimo = calls.filter((c) => c.method !== 'sendMessageDraft').at(-1)!.text!;
    expect(ultimo.split('Prima controllo')).toHaveLength(2);
  });

  it('stop() spegne il rinnovo: dopo, silenzio per sempre', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.live('Sto scrivendo');
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    const dopo = calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(dopo);
  });

  it('un\'anteprima rifiutata dalla Bot API non porta giu\' la trascrizione vera', async () => {
    const { api, calls } = recordingApi({ draft: true });
    const t = startTranscript(api, 1, { negotiation: DM });
    t.live('Sto');
    await vi.advanceTimersByTimeAsync(0);
    // L'anteprima e' decorazione: il turno continua a scrivere i suoi passi.
    t.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(true);
    await t.stop();
  });

  it('in un gruppo non esiste anteprima, e il testo che si forma entra nel messaggio che il turno possiede gia\'', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
    // Nessun messaggio ancora: `edit` non ne apre uno per mezza frase.
    t.live('qualcosa');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(0);

    // Ora il turno possiede un messaggio (un passo), e li' dentro il testo si vede.
    t.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(0);
    t.live('sto rispondendo');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.at(-1)!.text).toContain('sto rispondendo');
    expect(calls.some((c) => c.method === 'sendMessageDraft')).toBe(false);
    await t.stop();
  });

  it('coalesce le chiamate rapide nell\'ultimo valore, col pavimento della stanza', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.live('a');
    await vi.advanceTimersByTimeAsync(0);
    t.live('a b');
    t.live('a b c');
    t.live('a b c d');
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    const drafts = calls.filter((c) => c.method === 'sendMessageDraft');
    expect(drafts).toHaveLength(2); // la prima, poi una sola coalescata — non quattro
    expect(drafts.at(-1)!.text).toBe('a b c d');
    await t.stop();
  });

  it('un testo oltre un messaggio Telegram non viene mostrato in diretta', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.live('x'.repeat(100));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    t.live('x'.repeat(TELEGRAM_MAX + 500));
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    expect(calls.at(-1)!.text).toBe('x'.repeat(100)); // resta l'ultimo che ci stava
    await t.stop();
  });
});

/**
 * Il difetto misurato il 04/09 (SIGTERM a meta' turno) letto al contrario:
 * un'anteprima che nessuno rinnova **deve** sparire, ed e' proprio questo che
 * la rende sicura dove un messaggio vero non lo sarebbe. Cio' che il turno ha
 * gia' scritto per davvero — i passi — resta invece esattamente com'era.
 */
describe('un processo che smette di chiamare questo file non lascia niente a meta\'', () => {
  it('l\'anteprima smette di essere rinnovata e non c\'e\' niente da cancellare', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    // Un passo gia' chiuso: cosi' il contatore non ha niente da far scorrere
    // e cio' che resta sullo schermo e' esattamente cio' che era stato scritto.
    t.report(start('fs_read', { path: 'x' }));
    t.report(end('fs_read'));
    await vi.advanceTimersByTimeAsync(0);
    t.live('Sto preparando');
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    const passiMostrati = calls.filter((c) => c.method !== 'sendMessageDraft').at(-1)!.text;

    // Il processo "muore": nessuno chiama piu' niente, nemmeno `stop()`.
    // I timer del banco continuano a girare, ed e' il caso peggiore.
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    // Il messaggio vero e' ancora quello, e non e' stato cancellato.
    expect(calls.filter((c) => c.method !== 'sendMessageDraft').at(-1)!.text).toBe(passiMostrati);
    expect(calls.some((c) => c.method === 'deleteMessage')).toBe(false);
  });
});

describe('handoff() — what deliverTo extends instead of sending beside', () => {
  it('is null when nothing this turn ever produced a real message', () => {
    const { api } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    expect(t.handoff()).toBeNull();
  });

  it('names the last segment\'s message and its settled, non-live text once stop() has resolved', async () => {
    const { api } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.spoke('Prima leggo.', 'tool-call');
    t.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(0);
    t.report(end('fs_read'));
    await vi.advanceTimersByTimeAsync(1_500);
    await t.stop();

    const handoff = t.handoff();
    expect(handoff).not.toBeNull();
    expect(handoff!.stepsText).toContain('Prima leggo.');
    expect(handoff!.stepsText).toContain('✓ leggo un file: x');
    // The live tail (there was none here) is deliberately excluded —
    // `deliverTo` supplies the authoritative, freshly split answer itself.
    expect(handoff!.stepsText).not.toMatch(/⏳|· \d+s/);
  });

  it('is null once a Bot API failure has disabled this transcript — deliverTo must not edit a message it cannot trust', async () => {
    const { api, calls } = recordingApi({ send: true });
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]); // the send failed and was swallowed
    await t.stop();
    expect(t.handoff()).toBeNull();
  });
});
