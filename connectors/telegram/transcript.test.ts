import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../../agent/loop.js';
import { TelegramError, type TelegramApiLike } from './api.js';
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

type Call = { method: string; text?: string; messageId?: number; draftId?: number; at?: number; rich?: unknown; keyboard?: unknown };

function recordingApi(fail: { send?: boolean; edit?: boolean; draft?: boolean } = {}): { api: TelegramApiLike; calls: Call[] } {
  const calls: Call[] = [];
  let next = 500;
  const api = {
    sendMessage: async (chatId: number, html: string, options?: { keyboard?: unknown }) => {
      if (fail.send) throw new Error('simulato');
      const messageId = next++;
      calls.push({ method: 'sendMessage', text: html, messageId, ...(options?.keyboard === undefined ? {} : { keyboard: options.keyboard }) });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } };
    },
    editMessageText: async (_chatId: number, messageId: number, html: string, options?: { keyboard?: unknown }) => {
      if (fail.edit) throw new Error('simulato');
      calls.push({ method: 'editMessageText', text: html, messageId, ...(options?.keyboard === undefined ? {} : { keyboard: options.keyboard }) });
      return true;
    },
    editMessageReplyMarkup: async (_chatId: number, messageId: number, keyboard: unknown[] = []) => {
      calls.push({ method: 'editMessageReplyMarkup', messageId, keyboard });
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
    // Rich is the transport now; the fake records it as the legacy twin so the
    // 36 tests below keep asserting the same visible calls. The rich code path
    // is still the one exercised, and the failure flags cover it.
    sendRichMessage: async (chatId: number, rich: { html?: string; blocks?: unknown[] }, options?: { keyboard?: unknown }) => {
      if (fail.send) throw new Error('simulato');
      const messageId = next++;
      calls.push({ method: 'sendMessage', text: richPlain(rich), messageId, ...(options?.keyboard === undefined ? {} : { keyboard: options.keyboard }) });
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } };
    },
    editMessageRichText: async (_chatId: number, messageId: number, rich: { html?: string; blocks?: unknown[] }, options?: { keyboard?: unknown }) => {
      if (fail.edit) throw new Error('simulato');
      calls.push({ method: 'editMessageText', text: richPlain(rich), messageId, ...(options?.keyboard === undefined ? {} : { keyboard: options.keyboard }) });
      return true;
    },
    sendRichMessageDraft: async (_chatId: number, draftId: number, rich: { html?: string; blocks?: unknown[] }) => {
      if (fail.draft) throw new Error('simulato');
      calls.push({ method: 'sendMessageDraft', text: richPlain(rich), draftId, at: Date.now(), rich });
      return true;
    },
  } as unknown as TelegramApiLike;
  return { api, calls };
}

/**
 * Il testo visibile di un payload rich, letto dai blocchi: la bozza ora parla
 * la stessa lingua del finale (`details` + blocchi nativi), quindi le
 * asserzioni restano sul testo che una persona legge, non sul JSON.
 */
function richPlain(rich: { html?: string; blocks?: unknown[] }): string {
  const blockText = (b: unknown): string => {
    if (b === null || typeof b !== 'object') return '';
    const o = b as { text?: unknown; summary?: unknown; blocks?: unknown[] };
    const parts: string[] = [];
    // `summary` è sempre visibile: nella bozza porta il passo in corso.
    if (typeof o.summary === 'string') parts.push(o.summary);
    if (typeof o.text === 'string') parts.push(o.text);
    if (Array.isArray(o.blocks)) parts.push(o.blocks.map(blockText).join('\n'));
    return parts.join('\n');
  };
  if (rich.html !== undefined) return rich.html;
  return Array.isArray(rich.blocks) ? rich.blocks.map(blockText).join('\n') : '';
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
    // La segmentazione in bolle persistenti è comportamento della stanza
    // senza bozza (il gruppo). In DM il processo vive solo nell'anteprima.
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: GRUPPO });

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

  it('a turn that answers with no tool call shows its status in the ephemeral draft, never a persistent message', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report({ type: 'round', n: 1 });
    // Lo stato del turno è visibile nell'anteprima subito, prima di qualunque
    // token: è il buco di ~70 s chiuso il 2026-09-25.
    expect(calls[0]!.method).toBe('sendMessageDraft');
    expect(calls[0]!.text).toContain('sto pensando');
    t.report({ type: 'model', model: 'm', ms: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, stopReason: 'end_turn' });
    await vi.advanceTimersByTimeAsync(5_000);
    await t.stop();
    // Solo anteprime effimere: la chat non conserva niente di questo turno, e
    // la risposta vera arriverà con un normale `sendMessage` di deliverTo.
    expect(calls.every((c) => c.method === 'sendMessageDraft')).toBe(true);
    expect(calls.length).toBeGreaterThan(1); // il rinnovo mentre il turno pensa
    expect(calls.filter((c) => c.method === 'sendMessageDraft' && c.text === '')).toHaveLength(0);
    expect(t.handoff()).toBeNull();
  });

  it('a re-drive wait is painted, not left as a silent stall', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report({ type: 'model_retry', class: 'provider_empty', attempt: 2, max: 3, inMs: 4200 });
    expect(calls.at(-1)?.text).toContain('il provider ha risposto vuoto — riprovo (2/3) tra 4s');
    t.report({ type: 'model_retry', class: 'transport', attempt: 1, max: 10, inMs: 200 });
    expect(calls.at(-1)?.text).toContain('il provider non ha risposto — riprovo (1/10) tra 1s');
    await t.stop();
  });

  it('a superseded attempt is named, not removed', async () => {    const { api, calls } = recordingApi();
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
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
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
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
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
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
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

describe('the draft is the final shape (owner, 2026-09-27)', () => {
  it('done steps inside the collapsed details, the running step visible right below', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('fs_read', { path: 'a' }));
    t.report(end('fs_read', false, { path: 'a' }));
    t.report(start('shell_run', { command: 'npm test' }));
    // Il rinnovo della bozza ha il suo ritmo: un giro di tick mostra lo stato
    // aggiornato (i due passi passati dentro, quello in corso sotto).
    await vi.advanceTimersByTimeAsync(400);
    await t.stop();

    const draft = calls.filter((c) => c.method === 'sendMessageDraft').at(-1)!;
    const blocks = (draft.rich as { blocks?: { type: string; summary?: string; is_open?: boolean; text?: string; blocks?: unknown[] }[] })
      ?.blocks ?? [];
    const details = blocks.find((b) => b.type === 'details');
    expect(details).toBeDefined();
    expect(details!.summary).toBe('Processo');
    // Chiuso come nel finale: il passaggio non cambia l'altezza del messaggio.
    expect(details!.is_open).toBeUndefined();
    // Quello già successo sta dentro, senza contatore.
    expect(JSON.stringify(details!.blocks)).toContain('leggo un file: a');
    expect(JSON.stringify(details!.blocks)).not.toMatch(/· \d+s/);
    // Quello che sta succedendo adesso sta sotto «Processo», col suo tempo.
    const now = blocks.find((b) => b.type === 'paragraph');
    expect(now!.text).toContain('⏳ guardo con un comando: npm test');
    expect(now!.text).toMatch(/· \d+s/);
  });
});

describe('a Bot API failure is swallowed and disables the rest of the turn', () => {
  it('after a failed create nothing else is attempted, and stop() makes no call', async () => {
    const log: string[] = [];
    const { api, calls } = recordingApi({ send: true });
    const t = startTranscript(api, 1, { negotiation: GRUPPO, log: (l) => log.push(l) });
    t.report(start('fs_read', { path: 'a' }));
    await vi.advanceTimersByTimeAsync(0);
    t.report(end('fs_read'));
    t.spoke('e poi', 'tool-call');
    await vi.advanceTimersByTimeAsync(10_000);
    await t.stop();
    expect(calls).toEqual([]);
    expect(log.join('\n')).toContain('trascrizione del turno sospesa');
  });

  it('what the model wrote is inert: the rich preview carries it as plain text, never as markup', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('fs_read', { path: '<b>x</b>' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    // Nei blocchi `RichText` è testo semplice: niente entità da produrre e
    // niente markup da interpretare.
    expect(calls[0]!.text).toContain('<b>x</b>');
    expect(calls[0]!.text).not.toContain('&lt;b&gt;');
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

  it('in un gruppo non c\'è anteprima: il preambolo vive nel messaggio persistente, una volta sola', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
    t.live('Prima controllo');
    await vi.advanceTimersByTimeAsync(GRUPPO.editEveryMs);
    // `edit` non apre un messaggio per mezza frase: niente da mostrare finché
    // il turno non possiede un passo.
    expect(calls).toHaveLength(0);
    t.spoke('Prima controllo', 'tool-call');
    t.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(GRUPPO.editEveryMs);
    await t.stop();
    expect(calls.some((c) => c.method === 'sendMessageDraft')).toBe(false);
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

  it('un\'anteprima rifiutata dalla Bot API è decorazione: il processo resta per il `details` finale', async () => {
    const log: string[] = [];
    const { api, calls } = recordingApi({ draft: true });
    const t = startTranscript(api, 1, { negotiation: DM, log: (l) => log.push(l) });
    t.live('Sto');
    await vi.advanceTimersByTimeAsync(0);
    t.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(1_500);
    await t.stop();
    // Niente messaggi persistenti: in DM non esistono. Il processo resta però
    // in memoria, e `deliverTo` lo collassa nel `details` del messaggio finale.
    expect(calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')).toHaveLength(0);
    expect(log.join('\n')).toContain('anteprima del turno sospesa');
    const handoff = t.handoff();
    expect(handoff).not.toBeNull();
    expect(handoff!.messageId).toBeNull();
    expect(handoff!.process.join('\n')).toContain('leggo un file: x');
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
    const prima = calls.filter((c) => c.method === 'sendMessageDraft').length;
    t.live('a b');
    t.live('a b c');
    t.live('a b c d');
    // Le chiamate rapide non producono un invio per token: prima che il timer
    // scatti non è partito niente di nuovo (si coagulano in un rinnovo solo).
    expect(calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(prima);
    // Un rinnovo porta l'ultimo valore, non quattro.
    await vi.advanceTimersByTimeAsync(400);
    const drafts = calls.filter((c) => c.method === 'sendMessageDraft');
    expect(drafts.length).toBeGreaterThan(prima);
    expect(drafts.at(-1)!.text).toContain('a b c d');
    await t.stop();
  });

  it('un testo oltre il limite di un messaggio legacy ma dentro il tetto rich si vede intero, a blocchi', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    const lungo = 'x'.repeat(TELEGRAM_MAX + 500);
    t.live(lungo);
    await vi.advanceTimersByTimeAsync(400);
    const ultimo = calls.filter((c) => c.method === 'sendMessageDraft').at(-1)!;
    // Nessun taglio: il testo intero, in un blocco.
    const blocks = (ultimo.rich as { blocks?: { text?: string }[] } | undefined)?.blocks ?? [];
    expect(blocks[0]?.text).toBe(lungo);
    await t.stop();
  });

  it('oltre il tetto di protocollo la bozza passa alla famiglia legacy, come il finale', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    // Righe intere, come l'output reale di un modello: la coda legacy tiene
    // le ultime che ci stanno.
    t.live(Array.from({ length: 2_000 }, (_, i) => `riga ${i} di una risposta molto lunga`).join('\n'));
    await vi.advanceTimersByTimeAsync(400);
    const ultimo = calls.filter((c) => c.method === 'sendMessageDraft').at(-1)!;
    const rich = ultimo.rich as { html?: string; blocks?: unknown[] };
    expect(rich.blocks).toBeUndefined();
    expect(rich.html).toBeDefined();
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
  it('in DM non resta niente di persistente: solo anteprime effimere', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('fs_read', { path: 'x' }));
    t.report(end('fs_read'));
    await vi.advanceTimersByTimeAsync(0);
    t.live('Sto preparando');
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    const drafts = calls.filter((c) => c.method === 'sendMessageDraft');
    expect(drafts.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === 'sendMessage' || c.method === 'editMessageText')).toBe(false);

    // Il processo "muore": nessuno chiama piu' niente, nemmeno `stop()`.
    // I timer del banco continuano a girare, ed e' il caso peggiore.
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    // Niente messaggi veri, niente da cancellare: la bozza sparisce per TTL.
    expect(calls.some((c) => c.method === 'deleteMessage')).toBe(false);
    expect(calls.some((c) => c.method === 'sendMessage' || c.method === 'editMessageText')).toBe(false);
  });
});

describe('handoff() — what deliverTo extends instead of sending beside', () => {  it('is null when nothing this turn ever produced a real message', () => {
    const { api } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    expect(t.handoff()).toBeNull();
  });

  it('in DM returns the process and no message to extend; in group it also names the message', async () => {
    const { api } = recordingApi();
    const dm = startTranscript(api, 1, { negotiation: DM });
    dm.spoke('Prima leggo.', 'tool-call');
    dm.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(0);
    dm.report(end('fs_read'));
    await vi.advanceTimersByTimeAsync(1_500);
    await dm.stop();

    const dmHandoff = dm.handoff();
    expect(dmHandoff).not.toBeNull();
    expect(dmHandoff!.messageId).toBeNull();
    const process = dmHandoff!.process.join('\n');
    expect(process).toContain('Prima leggo.');
    expect(process).toContain('✓ leggo un file: x');
    // Il tail live è deliberatamente escluso: `deliverTo` porta la risposta
    // autorevole per conto suo.
    expect(process).not.toMatch(/⏳|· \d+s/);

    const g = startTranscript(api, 1, { negotiation: GRUPPO });
    g.spoke('Prima leggo.', 'tool-call');
    g.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(0);
    g.report(end('fs_read'));
    await vi.advanceTimersByTimeAsync(GRUPPO.editEveryMs);
    await g.stop();
    const gHandoff = g.handoff();
    expect(gHandoff).not.toBeNull();
    expect(typeof gHandoff!.messageId).toBe('number');
    expect(gHandoff!.processHtml).toContain('✓ leggo un file: x');
  });

  it('in DM handoff() covers every segment — a rich refusal must not lose an earlier one', async () => {
    const { api } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.spoke('Prima cerco.', 'tool-call');
    t.report(start('fs_read', { path: 'a' }));
    t.report(end('fs_read', false, { path: 'a' }));
    await vi.advanceTimersByTimeAsync(0);
    t.spoke('Ora cerco altro.', 'tool-call');
    t.report(start('fs_read', { path: 'b' }));
    t.report(end('fs_read', false, { path: 'b' }));
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();

    const h = t.handoff();
    expect(h).not.toBeNull();
    const process = h!.process.join('\n');
    for (const expected of ['Prima cerco.', 'leggo un file: a', 'Ora cerco altro.', 'leggo un file: b']) {
      expect(process).toContain(expected);
      // processHtml is the legacy fallback prefix: it must be just as complete,
      // or a refused rich final would drop the earlier segment.
      expect(h!.processHtml).toContain(expected);
    }
  });

  it('is null once a Bot API failure has disabled this transcript — deliverTo must not edit a message it cannot trust', async () => {
    const { api, calls } = recordingApi({ send: true });
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
    t.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]); // the send failed and was swallowed
    await t.stop();
    expect(t.handoff()).toBeNull();
  });
});

/**
 * DEFECT B — il primo tool resta invisibile finché non arriva un secondo evento.
 *
 * Misurato dall'owner (memory search ~70 s senza niente di visibile, poi tutto
 * insieme al secondo tool): la prima pittura dipendeva da un timer
 * (`schedule()` → `setTimeout(attesa())`), quindi senza avanzamento del clock
 * — o senza un secondo evento che facesse scattare un flush — niente arrivava
 * sul filo mentre il tool girava davvero.
 *
 * L'invariante: un primo tool lungo è visibile mentre gira, da solo, senza
 * aspettare né un secondo tool né lo scadere di un timer. Il test non avanza i
 * timer di proposito: concede solo microtask (la pittura immediata), mai un
 * macrotask. Su `transcript.ts` prima della correzione fallisce (zero chiamate
 * persistenti); dopo, il primo `sendMessage` è già partito.
 */
describe('defect B — a long first tool is visible while it runs, alone', () => {
  async function microtasks(n = 25): Promise<void> {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  it('DM: tool_start is on the wire before the handler resolves, with no second tool and no timer advance', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('memory_search', { query: 'q' }));
    // Il tool resta appeso: nessun tool_end, nessun secondo tool, nessun
    // avanzamento dell'orologio finto — solo microtask.
    await microtasks();
    // In DM la prima pittura è l'anteprima (nessun messaggio persistente).
    const drafts = calls.filter((c) => c.method === 'sendMessageDraft');
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(drafts[0]!.text).toContain('⏳');
    await t.stop();
  });

  it('group: same invariant under the group floor', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
    t.report(start('memory_search', { query: 'q' }));
    await microtasks();
    const persistent = calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
    expect(persistent.length).toBeGreaterThanOrEqual(1);
    expect(persistent[0]!.text).toContain('⏳');
    await t.stop();
  });

  /**
   * STRONGER FALSIFIER (owner, 2026-09-18): microtask-only is not enough. A
   * tool handler that blocks the event loop synchronously runs before any
   * `.then()` queued by `report()` — so the first send must be INVOKED inside
   * `report()`'s own stack, not merely scheduled from it. Zero awaits between
   * the fact and the assertion, on purpose.
   */
  it('DM: the first preview is INVOKED synchronously inside report(), before any microtask', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('memory_search', { query: 'q' }));
    // No await of any kind above: if a blocking handler started on the next
    // line, the preview is already on the wire.
    expect(calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(1);
    expect(calls[0]!.text).toContain('⏳');
    await t.stop();
  });

  it('group: same synchronous invocation under the group floor', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
    t.report(start('memory_search', { query: 'q' }));
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    expect(calls[0]!.text).toContain('⏳');
    await t.stop();
  });

  it('a first preamble paints synchronously too — and never opens a persistent message in DM', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.spoke('Prima leggo la spesa.', 'tool-call');
    expect(calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(1);
    t.report(start('fs_read', { path: 'spesa.txt' }));
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    // La bozza è l'unica superficie viva in DM: nessun messaggio vero.
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    await t.stop();
  });

  it('group: still one message, still throttled — a burst after the first paint coalesces', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
    t.report(start('fs_read', { path: 'a' }));
    await microtasks();
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    // Una raffica subito dopo non apre un secondo messaggio: si accoda in edit.
    t.report(end('fs_read', false, { path: 'a' }));
    t.report(start('fs_read', { path: 'b' }));
    await vi.advanceTimersByTimeAsync(GRUPPO.editEveryMs);
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    await t.stop();
  });
});

/**
 * DEFECT A — dopo la risposta resta una bolla «Thinking…».
 *
 * Fatto API primario (`core.telegram.org/bots/api#sendmessagedraft`, Bot API
 * 10.0 2026-05-08 «Allowed bots to pass an empty text»): `text` 0–4096, e un
 * testo vuoto mostra il placeholder «Thinking…» — non cancella la bozza. La
 * bozza è un'anteprima effimera (~30 s): sparisce per TTL o quando un normale
 * `sendMessage` arriva nella stessa chat/topic; un `editMessageText` non la
 * tocca. Quindi `stop()` che manda `sendMessageDraft(draftId, '')` non pulisce:
 * accende un «Thinking…» post-risposta, e quando `deliverTo` estende il
 * messaggio persistente con un edit (turno con tool), niente lo sostituisce.
 *
 * Ciclo corretto: la bozza vive solo finché non esiste un messaggio vero; dal
 * primo segmento persistente in poi il testo va nel segmento (edit), mai in una
 * nuova bozza; `stop()` non manda mai un testo vuoto; un turno senza tool
 * consegna con un normale `sendMessage` che sostituisce la bozza da solo.
 */
describe('defect A — no stale post-answer Thinking preview', () => {
  it('stop() never sends an empty-text draft', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.live('Sto preparando la risposta');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.some((c) => c.method === 'sendMessageDraft')).toBe(true);
    await t.stop();
    expect(calls.filter((c) => c.method === 'sendMessageDraft' && c.text === '')).toHaveLength(0);
  });

  it('in un gruppo non esiste anteprima: la risposta che si forma entra nel messaggio persistente', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
    t.spoke('Sto preparando', 'tool-call');
    t.report(start('fs_read', { path: 'x' }));
    await vi.advanceTimersByTimeAsync(GRUPPO.editEveryMs);
    // La risposta finale arriva DOPO i tool: entra nel messaggio vero.
    t.live('Ecco la risposta finale che si forma');
    await vi.advanceTimersByTimeAsync(GRUPPO.editEveryMs);
    expect(calls.some((c) => c.method === 'sendMessageDraft')).toBe(false);
    expect(calls.filter((c) => c.method !== 'sendMessageDraft').at(-1)!.text).toContain('Ecco la risposta finale');
    await t.stop();
  });

  it('tool-free turn: only the draft while forming, never an empty one at the end', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.live('Ciao, ecco');
    await vi.advanceTimersByTimeAsync(0);
    await t.stop();
    expect(calls.some((c) => c.method === 'sendMessageDraft')).toBe(true);
    expect(calls.filter((c) => c.method === 'sendMessageDraft' && c.text === '')).toHaveLength(0);
    // Niente di durevole da qui: la risposta vera arriva con un normale
    // sendMessage di deliverTo, che sostituisce la bozza da solo.
    expect(calls.some((c) => c.method === 'sendMessage' || c.method === 'editMessageText')).toBe(false);
    expect(t.handoff()).toBeNull();
  });
});

/**
 * #616: scanability first, inspectability on demand.
 *
 * The compact line stays what a person reads; the exact command lives under it
 * in a `<blockquote expandable>` (Telegram 7.10+), so the 48-char clamp is a
 * display choice rather than an information loss. A short command has no
 * detail to show and must not grow a pointless block.
 */
describe('a tool step shows the whole command, never a cut (#616)', () => {
  const command = 'grep -rn "continuation" agent/loop/round.ts connectors/telegram/transcript.ts core/turns/store.ts';

  it('a long command is on the line, character for character', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('shell_run', { command }));
    await vi.advanceTimersByTimeAsync(0);
    const text = calls.at(-1)!.text!;
    expect(text).toContain(`guardo con un comando: ${command}`);
    expect(text).not.toContain('…');
    await t.stop();
  });

  it('a short command is the same line, with nothing added', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('shell_run', { command: 'npm test' }));
    await vi.advanceTimersByTimeAsync(0);
    const text = calls.at(-1)!.text!;
    expect(text).toContain('guardo con un comando: npm test');
    expect(text).not.toContain('<blockquote');
    await t.stop();
  });

  it('a secret-shaped argument is redacted, and the rest of the command survives', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    const secret = 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    t.report(start('shell_run', { command: `curl -H "Authorization: Bearer ${secret}" https://example.com/a/long/path/here` }));
    await vi.advanceTimersByTimeAsync(0);
    const text = calls.at(-1)!.text!;
    expect(text).not.toContain('sk-live');
    expect(text).toContain('«redacted:');
    expect(text).toContain('https://example.com/a/long/path/here');
    await t.stop();
  });
});

describe('rich transport failure handling', () => {
  function api(calls: Call[], richSend: () => Promise<never>): TelegramApiLike {
    let next = 700;
    return {
      sendMessage: async (chatId: number, html: string) => {
        const messageId = next++;
        calls.push({ method: 'sendMessage', text: html, messageId });
        return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' } };
      },
      editMessageText: async () => true,
      sendMessageDraft: async () => true,
      sendRichMessage: richSend,
      editMessageRichText: async () => true,
      sendRichMessageDraft: async () => true,
    } as unknown as TelegramApiLike;
  }

  it('a deterministic refusal flips the turn to legacy, exactly once', async () => {
    const calls: Call[] = [];
    const t = startTranscript(
      api(calls, async () => {
        throw new TelegramError(400, 'Bad Request: rich refused');
      }),
      1,
      { negotiation: GRUPPO },
    );
    t.report(start('shell_run', { command: 'npm test' }));
    await vi.advanceTimersByTimeAsync(0);
    // The rich attempt was refused deterministically: one legacy create.
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    await t.stop();
  });

  it('a refused blocks preview falls back to a text draft, not to silence', async () => {
    const calls: Call[] = [];
    const api = {
      sendMessage: async () => {
        throw new Error('unused in this fake');
      },
      editMessageText: async () => true,
      sendMessageDraft: async (_c: number, draftId: number, text: string) => {
        calls.push({ method: 'sendMessageDraft', text, draftId });
        return true;
      },
      sendRichMessageDraft: async () => {
        throw new TelegramError(400, 'Bad Request: rich refused');
      },
      sendRichMessage: async () => {
        throw new TelegramError(400, 'unused in this fake');
      },
      editMessageRichText: async () => true,
    } as unknown as TelegramApiLike;
    const t = startTranscript(api, 1, { negotiation: DM });
    t.report(start('shell_run', { command: 'npm test' }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);
    await t.stop();
    // Il gemello di testo della bozza ha preso il posto dei blocchi rifiutati.
    expect(calls.filter((c) => c.method === 'sendMessageDraft').length).toBeGreaterThan(0);
    expect(calls.at(-1)!.text).toContain('guardo con un comando: npm test');
  });

  it('an ambiguous failure never re-sends — no duplicate transcript', async () => {
    const calls: Call[] = [];
    const t = startTranscript(
      api(calls, async () => {
        // status 0: the request may already have reached Telegram.
        throw new TelegramError(0, 'response stream closed');
      }),
      1,
      { negotiation: GRUPPO },
    );
    t.report(start('shell_run', { command: 'npm test' }));
    await vi.advanceTimersByTimeAsync(0);
    // No legacy re-send: a second message would be the duplicate this surface
    // forbids when the first attempt is unconfirmed.
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    await t.stop();
  });
});

/**
 * La domanda di approvazione è un passo del turno, non una bolla a parte
 * (owner, 2026-09-29: quattro comandi, quattro messaggi residui sotto la
 * risposta).
 *
 * L'invariante: quando una trascrizione viva può ospitarla, la domanda apre il
 * messaggio **del turno** — anche in una stanza che preferirebbe la bozza,
 * perché i pulsanti non vivono su un'anteprima effimera — e da lì in poi la
 * risposta che si forma edita quello stesso messaggio. `resolveAsk` toglie la
 * tastiera per costruzione e lascia il verdetto dentro il passo, che la
 * consegna finale ripiega nel `details`.
 */
describe('la domanda di approvazione vive nel messaggio del turno', () => {
  const request: ApprovalRequest = {
    capability: 'sys.shell.write',
    prompt: 'non si torna indietro: cambia questa macchina — sys.shell.write',
    resource: 'command: echo ciao\ncwd: .',
    description: 'stampa la parola ciao',
    taint: 2,
  };

  it('in DM apre il messaggio vero (non una bozza), visibile, con la tastiera', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });

    await expect(t.ask({ request, approvalId: 'aabb' })).resolves.toBe(true);

    const invio = calls.find((c) => c.method === 'sendMessage');
    expect(invio).toBeDefined();
    expect(invio!.text).toContain('non si torna indietro');
    expect(invio!.text).toContain('echo ciao');
    expect(invio!.text).toContain('taint 2');
    expect(invio!.keyboard).toBeDefined();
    // La tastiera non vive su un'anteprima effimera: niente bozza da qui in poi.
    expect(calls.some((c) => c.method === 'sendMessageDraft')).toBe(false);
    await t.stop();
  });

  it("il loop emette `ask` dopo: stesso passo, mai due", async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });

    await t.ask({ request, approvalId: 'aabb' });
    t.report({ type: 'ask', name: 'shell_run_write', capability: 'sys.shell.write' });
    await vi.advanceTimersByTimeAsync(0);

    const testo = calls
      .filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
      .map((c) => c.text ?? '')
      .join('\n');
    expect(testo.match(/aspetto la tua approvazione/g) ?? []).toHaveLength(0);
    expect(testo.match(/non si torna indietro/g) ?? []).toHaveLength(1);
    await t.stop();
  });

  it('resolveAsk toglie la tastiera per costruzione e lascia il verdetto nel passo', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    await t.ask({ request, approvalId: 'aabb' });

    t.resolveAsk('sys.shell.write', true);
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);

    const tolt = calls.find((c) => c.method === 'editMessageReplyMarkup');
    expect(tolt).toBeDefined();
    expect(tolt!.keyboard).toEqual([]);
    const edit = calls.filter((c) => c.method === 'editMessageText').at(-1);
    expect(edit!.text).toContain('sys.shell.write: consentito');
    // Il contenuto della domanda resta nel passo: il Processo è dove si ripiega.
    expect(edit!.text).toContain('non si torna indietro');
    await t.stop();
  });

  it('dopo la domanda la risposta che si forma edita quel messaggio, e handoff lo nomina', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    await t.ask({ request, approvalId: 'aabb' });
    const id = calls.find((c) => c.method === 'sendMessage')!.messageId;
    t.resolveAsk('sys.shell.write', true);
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);

    t.live('sto scrivendo la risposta');
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);

    expect(calls.filter((c) => c.method === 'editMessageText').every((c) => c.messageId === id)).toBe(true);
    expect(calls.some((c) => c.method === 'sendMessageDraft')).toBe(false);
    expect(t.handoff()?.messageId).toBe(id);
    await t.stop();
  });

  it('senza un messaggio vivo la domanda non è presa: il chiamante ripiega', async () => {
    const { api } = recordingApi({ send: true });
    const t = startTranscript(api, 1, { negotiation: GRUPPO });

    await expect(t.ask({ request, approvalId: 'aabb' })).resolves.toBe(false);
    await t.stop();
  });
});

/**
 * I difetti trovati dalla review del 29/09 sul primo head di #737.
 *
 * Radice unica: `ask()` scriveva fuori dal writer serializzato. In un
 * gruppo/topic il primo tool può aver già avviato la sua `sendMessage`
 * (`trySyncFirstPaint`): la domanda ne mandava una seconda, e sotto
 * riordino delle risposte il segmento poteva registrare l'id sbagliato — con
 * la tastiera che sopravviveva alla decisione sul messaggio della domanda.
 * E un re-ask della stessa capability non produce un edit (testo identico):
 * senza riattacco esplicito la domanda restava visibile ma muta.
 */
describe('la domanda non apre una seconda bolla, e non resta mai muta', () => {
  const request: ApprovalRequest = {
    capability: 'sys.shell.write',
    prompt: 'non si torna indietro: cambia questa macchina — sys.shell.write',
    resource: 'command: echo ciao\ncwd: .',
    description: 'stampa la parola ciao',
    taint: 0,
  };

  it('in gruppo, se il primo tool ha già avviato la pittura, la domanda la edita invece di mandare una seconda bolla', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: GRUPPO });

    // Il primo fatto è il tool: `trySyncFirstPaint` avvia la send nello stesso stack.
    t.report(start('shell_run_write', { command: 'echo ciao' }));
    await expect(t.ask({ request, approvalId: 'aabb' })).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(GRUPPO.editEveryMs);

    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    const edit = calls.filter((c) => c.method === 'editMessageText');
    expect(edit.length).toBeGreaterThan(0);
    expect(edit.at(-1)!.text).toContain('non si torna indietro');
    expect(edit.at(-1)!.keyboard).toBeDefined();
    await t.stop();
  });

  it('un re-ask di una capability ancora in attesa riattacca la tastiera', async () => {
    const { api, calls } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: DM });
    const requestB: ApprovalRequest = { ...request, capability: 'sys.http', prompt: 'non si torna indietro: chiama un servizio di terzi' };

    await t.ask({ request, approvalId: 'aabb' });
    await t.ask({ request: requestB, approvalId: 'bbcc' });
    t.resolveAsk('sys.http', true); // risolve la seconda
    await vi.advanceTimersByTimeAsync(DM.editEveryMs);

    // Il modello ri-chiede la prima, ancora in attesa: stesso passo, testo identico.
    await expect(t.ask({ request, approvalId: 'ccdd' })).resolves.toBe(true);

    const ultima = calls.filter((c) => c.method === 'editMessageReplyMarkup').at(-1)!;
    const tastiera = ultima.keyboard as { callback_data: string }[][];
    expect(tastiera.flat().map((b) => b.callback_data)).toEqual(['ok:ccdd', 'no:ccdd']);
    await t.stop();
  });

  it('con due domande in attesa il verdetto rientra nel passo giusto', async () => {
    const { api } = recordingApi();
    const t = startTranscript(api, 1, { negotiation: GRUPPO });
    const requestB: ApprovalRequest = { ...request, capability: 'sys.http', prompt: 'non si torna indietro: chiama un servizio di terzi' };

    await t.ask({ request, approvalId: 'aabb' });
    await t.ask({ request: requestB, approvalId: 'bbcc' });
    t.resolveAsk('sys.shell.write', true);
    await vi.advanceTimersByTimeAsync(GRUPPO.editEveryMs);

    const righe = t.handoff()?.process ?? [];
    const processo = righe.join('\n');
    expect(processo).toContain('sys.shell.write: consentito');
    expect(processo).not.toContain('sys.http: consentito');
    // La domanda ancora in attesa è quella di `sys.http`, non l'ultima
    // incontrata: senza il filtro per capability il verdetto atterra sul passo
    // sbagliato, e questa riga lo distingue (review 2026-09-29).
    const attesa = righe.find((r) => r.startsWith('⏸'));
    expect(attesa).toBeDefined();
    expect(attesa).toContain('chiama un servizio di terzi');
    expect(attesa).not.toContain('cambia questa macchina');
    await t.stop();
  });
});
