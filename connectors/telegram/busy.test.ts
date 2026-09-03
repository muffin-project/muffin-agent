import type { Update } from '@grammyjs/types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eseguiComando, type Controlli } from '../../agent/comandi.js';
import type { LoopDeps } from '../../agent/loop.js';
import type { ChatCall, ChatResult, Provider } from '../../agent/providers/types.js';
import { buildRuntime } from '../../agent/runtime.js';
import { runInit } from '../../cli/init.js';
import { Pausa } from '../../core/runtime/pausa.js';
import type { TelegramApi } from './api.js';
import { TelegramConnector } from './connector.js';
import { TelegramDeliveryStore } from './delivery.js';
import { UpdateInbox } from './updates.js';

/**
 * Un messaggio mentre un turno è vivo (ADR-0054), attraverso il **poller
 * vero**: `run()` con un `getUpdates` finto che consegna i batch quando il
 * test glieli dà, e un modello finto che si ferma dove il test lo tiene.
 *
 * È il solo modo di provare la metà che mancava (B2): che `getUpdates` giri
 * *mentre* il modello sta rispondendo. Guidare `drain()` a mano, come fanno
 * gli altri test del connettore, salterebbe esattamente la riga che fino al
 * 03/09 era `await this.drain()`.
 */

const OWNER = 777001;
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

const msg = (id: number, text: string): Update =>
  ({
    update_id: id,
    message: { message_id: id, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, is_bot: false, first_name: 'o' }, text },
  }) as unknown as Update;

type Risposta = (call: ChatCall) => Promise<ChatResult>;
const testo = (t: string): Risposta => async () => ({ text: t, toolCalls: [], stopReason: 'end', usage, model: 'test' });
const tool = (): Risposta => async () => ({
  text: null,
  toolCalls: [{ id: 'c1', name: 'tool_inesistente', args: {} }],
  stopReason: 'tool_use',
  usage,
  model: 'test',
});
/**
 * Una risposta che aspetta il test — o l'abort del turno, che fa quello che fa
 * un SDK vero: la richiesta viene rigettata con un `AbortError`, non
 * completata.
 */
function tenuta(poi: Risposta): { risposta: Risposta; rilascia: () => void } {
  let rilascia: () => void = () => {};
  const porta = new Promise<void>((r) => (rilascia = r));
  return {
    rilascia: () => rilascia(),
    risposta: async (call) => {
      const abortita = new Promise<never>((_r, reject) =>
        call.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))),
      );
      await Promise.race([porta, abortita]);
      return poi(call);
    },
  };
}

function harness(script: Risposta[]) {
  const home = mkdtempSync(join(tmpdir(), 'muffin-busy-tg-'));
  const workspace = mkdtempSync(join(tmpdir(), 'muffin-busy-tg-ws-'));
  runInit({ home, apiKey: 'sk-busy-never-called' });
  const runtime = buildRuntime(home, workspace);

  const sent: { text: string; replyTo?: number }[] = [];
  const chiamate: ChatCall[] = [];
  const batches: Update[][] = [];
  let sveglia: (() => void) | null = null;
  const controller = new AbortController();

  const api = {
    getMe: async () => ({ id: 1, is_bot: true, first_name: 'muffin', username: 'muffinbot' }),
    getUpdates: async () => {
      while (batches.length === 0 && !controller.signal.aborted) {
        await new Promise<void>((r) => (sveglia = r));
      }
      return batches.shift() ?? [];
    },
    setMyCommands: async () => true,
    sendMessage: async (_chatId: number, text: string, options?: { replyTo?: number }) => {
      sent.push({ text, ...(options?.replyTo === undefined ? {} : { replyTo: options.replyTo }) });
      return { message_id: sent.length } as never;
    },
    sendChatAction: async () => true,
    sendMessageDraft: async () => true,
    editMessageText: async () => ({}) as never,
    deleteMessage: async () => true,
  } as unknown as TelegramApi;

  const provider: Provider = {
    kind: 'openai-compat',
    chat: async (call) => {
      chiamate.push(call);
      const r = script[chiamate.length - 1] ?? testo('fine');
      return r(call);
    },
  };

  const pausa = new Pausa(runtime.db);
  const connector = new TelegramConnector({
    loop: { ...runtime.deps, provider } satisfies LoopDeps,
    sessions: runtime.deps.sessions,
    inbox: new UpdateInbox(runtime.db),
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config: { token: 't', ownerUserId: OWNER, ownerChatId: OWNER },
    comandi: async (riga, sessionId, controlli: Controlli) => {
      const e = await eseguiComando(riga, {
        home,
        config: runtime.config,
        profilo: { name: 'test', thinking: 'unset' },
        budget: runtime.budget,
        sessionId,
        verbosity: 'normale',
        puoiUscire: false,
        model: async () => undefined,
        controlli,
      });
      return e.sconosciuto === true ? null : { testo: e.testo };
    },
    pausa,
  });

  const running = connector.run(controller.signal);
  const manda = (...updates: Update[]): void => {
    batches.push(updates);
    sveglia?.();
  };
  const chiudi = async (): Promise<void> => {
    connector.stop();
    controller.abort();
    sveglia?.();
    await running;
    runtime.close();
  };
  return { sent, chiamate, manda, chiudi, pausa };
}

async function until(check: () => boolean, stato: () => unknown = () => '', ms = 5_000): Promise<void> {
  const inizio = Date.now();
  while (!check()) {
    if (Date.now() - inizio > ms) throw new Error(`condizione mai vera — stato: ${JSON.stringify(stato())}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const testiUtente = (call: ChatCall): string[] =>
  call.messages.filter((m) => m.role === 'user').flatMap((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')));

describe('il poller riceve mentre un turno gira', () => {
  it('un secondo messaggio viene confermato «in coda» subito, e risposto dopo il primo', async () => {
    const primo = tenuta(testo('prima risposta'));
    const h = harness([primo.risposta, testo('seconda risposta')]);
    try {
      h.manda(msg(1, 'una cosa lunga'));
      await until(() => h.chiamate.length === 1);
      h.manda(msg(2, 'e poi questa'));
      await until(() => h.sent.some((s) => s.text.includes('in coda')));
      // Confermato mentre il modello è ancora fermo sulla prima: una chiamata sola.
      expect(h.chiamate).toHaveLength(1);
      expect(h.sent.find((s) => s.text.includes('in coda'))?.replyTo).toBe(2);

      primo.rilascia();
      await until(() => h.sent.some((s) => s.text === 'seconda risposta'));
      const testi = h.sent.map((s) => s.text);
      expect(testi.indexOf('prima risposta')).toBeLessThan(testi.indexOf('seconda risposta'));
      expect(testi.filter((t) => t.includes('in coda'))).toHaveLength(1);
    } finally {
      await h.chiudi();
    }
  });

  it('/stop ferma il turno vivo: la risposta è «Interrotto.»', async () => {
    const primo = tenuta(testo('non dovrei arrivare'));
    const h = harness([primo.risposta]);
    try {
      h.manda(msg(1, 'una cosa lunga'));
      await until(() => h.chiamate.length === 1);
      h.manda(msg(2, '/stop'));
      await until(() => h.sent.some((s) => s.text.includes('fermato')), () => h.sent);
      await until(() => h.sent.some((s) => s.text === 'Interrotto.'), () => h.sent);
      expect(h.sent.map((s) => s.text)).not.toContain('non dovrei arrivare');
    } finally {
      await h.chiudi();
    }
  });

  it('/steer entra al giro dopo, come parole dell owner', async () => {
    const primo = tenuta(tool());
    const h = harness([primo.risposta, testo('fatto in italiano')]);
    try {
      h.manda(msg(1, 'cerca una cosa'));
      await until(() => h.chiamate.length === 1);
      h.manda(msg(2, '/steer in italiano, per favore'));
      await until(() => h.sent.some((s) => s.text.includes('ricevuto')));
      primo.rilascia();
      await until(() => h.sent.some((s) => s.text === 'fatto in italiano'));
      expect(h.chiamate).toHaveLength(2);
      expect(testiUtente(h.chiamate[1]!).at(-1)).toBe('in italiano, per favore');
    } finally {
      await h.chiudi();
    }
  });

  it('/steer di un turno che nessun giro consuma resta, e apre il turno dopo', async () => {
    // Il caso comune: una risposta senza tool è **un** giro, e l'owner scrive
    // `/steer` proprio mentre quella chiamata è in corso. Non c'è nessun
    // confine di giro successivo, quindi la correzione non viene mai letta dal
    // loop: se sparisse, la conferma «ricevuto» sarebbe una bugia.
    const primo = tenuta(testo('risposta finale'));
    const h = harness([primo.risposta, testo('seconda')]);
    try {
      h.manda(msg(1, 'una cosa lunga'));
      await until(() => h.chiamate.length === 1);
      h.manda(msg(2, '/steer in italiano, per favore'));
      await until(() => h.sent.some((s) => s.text.includes('ricevuto')), () => h.sent);
      primo.rilascia();
      await until(() => h.sent.some((s) => s.text === 'risposta finale'), () => h.sent);
      // Un giro solo: la correzione non è entrata in nessuna chiamata di questo turno.
      expect(h.chiamate).toHaveLength(1);

      h.manda(msg(3, 'e adesso?'));
      await until(() => h.chiamate.length === 2, () => h.sent);
      expect(testiUtente(h.chiamate[1]!).join('\n')).toContain('in italiano, per favore');
    } finally {
      await h.chiudi();
    }
  });

  it('/steer senza turno vivo lo dice, e non lascia niente in giro', async () => {
    const h = harness([testo('ciao')]);
    try {
      h.manda(msg(1, '/steer x'));
      await until(() => h.sent.some((s) => s.text.includes('nessun turno')));
      expect(h.chiamate).toHaveLength(0);
    } finally {
      await h.chiudi();
    }
  });
});

describe('/pause e /resume', () => {
  it('in pausa un messaggio viene confermato e non parte; al /resume parte da solo', async () => {
    const h = harness([testo('eccomi')]);
    try {
      h.manda(msg(1, '/pause'));
      await until(() => h.sent.some((s) => s.text.includes('in pausa')));
      expect(h.pausa.attiva()).toBe(true);
      h.manda(msg(2, 'ci sei?'));
      await until(() => h.sent.some((s) => s.text.includes('⏸')));
      await new Promise((r) => setTimeout(r, 200));
      expect(h.chiamate).toHaveLength(0);
      h.manda(msg(3, '/resume'));
      await until(() => h.sent.some((s) => s.text === 'eccomi'));
      expect(h.pausa.attiva()).toBe(false);
      // Confermato una volta sola, anche se il drain lo ha rivisto più volte.
      expect(h.sent.filter((s) => s.text.includes('⏸'))).toHaveLength(1);
    } finally {
      await h.chiudi();
    }
  });

  it('/pause e /resume nello stesso batch: due risposte, non tre', async () => {
    // I due comandi arrivano in un `getUpdates` solo. `controlla` serve il
    // primo e, mentre lo attende, un drain partito nel frattempo legge lo
    // stesso batch dall'inbox e serve il secondo una seconda volta: il
    // `/resume` doppio risponde «non ero in pausa.» a un owner che ha scritto
    // un comando solo.
    const h = harness([testo('eccomi')]);
    try {
      h.manda(msg(1, '/pause'), msg(2, '/resume'));
      await until(() => h.sent.some((s) => s.text.includes('ripreso')), () => h.sent);
      await new Promise((r) => setTimeout(r, 200));
      const risposte = h.sent.map((s) => s.text);
      expect(risposte).not.toContain('non ero in pausa.');
      expect(risposte.filter((t) => t.includes('in pausa:'))).toHaveLength(1);
      expect(risposte.filter((t) => t.includes('ripreso'))).toHaveLength(1);
      expect(h.pausa.attiva()).toBe(false);
    } finally {
      await h.chiudi();
    }
  });
});
