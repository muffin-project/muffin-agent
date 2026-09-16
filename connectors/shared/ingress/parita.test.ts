import DatabaseCtor from 'better-sqlite3';
import { readFileSync, readdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Update } from '@grammyjs/types';
import { buildRuntime } from '../../../agent/runtime.js';
import type { LoopDeps } from '../../../agent/loop.js';
import type { ChatCall, Provider } from '../../../agent/providers/types.js';
import { runInit } from '../../../cli/init.js';
import { INGRESS_PORT_IDS } from '../../../cli/surface.js';
import { Pausa } from '../../../core/runtime/pausa.js';
import type { DiscordApi, DiscordMessage } from '../../discord/api.js';
import { DiscordConnector } from '../../discord/connector.js';
import { ModelLane } from '../../../core/turns/model-lane.js';
import { FakeSocket, HELLO, READY } from '../../discord/fake-socket.js';
import { DiscordInbox } from '../../discord/inbox.js';
import type { TelegramApi } from '../../telegram/api.js';
import { TelegramConnector } from '../../telegram/connector.js';
import { TelegramDeliveryStore } from '../../telegram/delivery.js';
import { UpdateInbox } from '../../telegram/updates.js';
import { AVVISO_IN_PAUSA } from './lane.js';
import { INGRESS_STAGES, witnessIngress, type IngressStage, type IngressVisit } from './router.js';
import { PLACES, type FileMode, type Place, type StreamMode } from '../../../core/surface/types.js';
import type { IngressPort } from './types.js';
import { telegramPort } from '../../telegram/surface.js';
import { discordPort } from '../../discord/surface.js';

/**
 * Slice 16 of the ingress decomposition
 * (`docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md` §2.6, §3 row 16): the
 * parity test, and the yardstick phase C is measured against.
 *
 * Four `describe` blocks, and the fourth is the one that holds the other three
 * up. §5 names the falsifier itself: *"il describe 4 non esiste o non diventa
 * rosso quando si inlineano gli stadi nel drain di un connettore importando i
 * moduli condivisi. Allora la parità prova solo che il codice condiviso è
 * condiviso, e tutta la fase B poggia su un divieto di import."*
 *
 * Nothing here is a spy. Every assertion is on something the outside world can
 * see: a row in `turns`, a message the fake transport received, whether the
 * event is still in the inbox, how many times the provider was asked. The one
 * exception is `witnessIngress` in describe 4, and it is not a spy either —
 * it is the router reporting its own walk, which is exactly the fact under
 * test and the only fact an inlined copy of the stages cannot produce.
 */

const OWNER_TG = 777001;
const OWNER_DC = '888000000000000001';
const RISPOSTA = 'risposta del modello';
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/* -------------------------------------------------------------------------- */
/*  L'asse delle porte                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What a scene can observe about one port, whichever port it is.
 *
 * Deliberately the same six answers for both, and deliberately all six about
 * durable or transport-visible state: a scene that had to ask "did you call
 * this internal method" would be asserting an implementation, and two ports
 * are allowed to have different implementations. What they are not allowed to
 * have is a different *outcome*.
 */
type PortaProvata = {
  readonly id: string;
  /** Put one owner message on the wire, through this port's own transport. */
  readonly manda: (testo: string) => void;
  /** Every text this port actually sent back, in order. */
  readonly inviati: () => string[];
  /** How many times the model was asked anything. */
  readonly chiamateAlModello: () => number;
  /** The durable turn rows, with the routing key and the delivery each one carries. */
  readonly turni: () => { id: string; surface: string; status: string; delivery: string | null }[];
  /** The event ids still waiting in this port's inbox. */
  readonly pendenti: () => string[];
  readonly pausa: Pausa;
  readonly chiudi: () => Promise<void>;
};

type Apri = (over?: { readonly sospendi?: boolean }) => Promise<PortaProvata>;

function runtimeVero(nome: string, over: { sospendi?: boolean }, chiamate: ChatCall[]) {
  const home = mkdtempSync(join(tmpdir(), `muffin-parita-${nome}-`));
  const workspace = mkdtempSync(join(tmpdir(), `muffin-parita-${nome}-ws-`));
  runInit({ home, apiKey: 'sk-parita-mai-usata' });
  const runtime = buildRuntime(home, workspace);
  const provider: Provider = {
    kind: 'openai-compat',
    chat: async (call) => {
      chiamate.push(call);
      return {
        text: over.sospendi ? '' : RISPOSTA,
        toolCalls: over.sospendi ? [{ id: 'c1', name: 'wait', args: { seconds: 3600, why: 'aspetto' } }] : [],
        stopReason: over.sospendi ? ('tool_use' as const) : ('end' as const),
        usage,
        model: 'test',
      } as never;
    },
  };
  return { home, runtime, loop: { ...runtime.deps, provider } as LoopDeps };
}

/** Le righe durevoli, lette dal database e non dedotte dal connettore. */
function righeDeiTurni(
  db: InstanceType<typeof DatabaseCtor>,
): { id: string; surface: string; status: string; delivery: string | null }[] {
  return db.prepare(`SELECT id, surface, status, delivery FROM turns ORDER BY rowid`).all() as {
    id: string;
    surface: string;
    status: string;
    delivery: string | null;
  }[];
}

/**
 * Telegram, guidato dal suo trasporto finto: un `getUpdates` che risponde
 * quando il test gli mette qualcosa in coda, esattamente come
 * `connectors/telegram/busy.test.ts`, così il poller vero gira.
 */
const apriTelegram: Apri = async (over = {}) => {
  const chiamate: ChatCall[] = [];
  const { runtime, loop } = runtimeVero('tg', over, chiamate);
  const inviati: string[] = [];
  const batches: Update[][] = [];
  let sveglia: (() => void) | null = null;
  const controller = new AbortController();
  let prossimo = 100;

  const api = {
    getMe: async () => ({ id: 1, is_bot: true, first_name: 'muffin', username: 'muffinbot' }),
    getUpdates: async () => {
      while (batches.length === 0 && !controller.signal.aborted) {
        await new Promise<void>((r) => (sveglia = r));
      }
      return batches.shift() ?? [];
    },
    setMyCommands: async () => true,
    sendMessage: async (_chatId: number, text: string) => {
      inviati.push(text);
      return { message_id: inviati.length } as never;
    },
    sendChatAction: async () => true,
    sendMessageDraft: async () => true,
    editMessageText: async () => ({}) as never,
    deleteMessage: async () => true,
  } as unknown as TelegramApi;

  const inbox = new UpdateInbox(runtime.db);
  const pausa = new Pausa(runtime.db);
  const connector = new TelegramConnector({
    loop,
    sessions: runtime.deps.sessions,
    lane: new ModelLane(),
    inbox,
    delivery: new TelegramDeliveryStore(runtime.db),
    api,
    config: { token: 't', ownerUserId: OWNER_TG, ownerChatId: OWNER_TG },
    pausa,
  });
  const running = connector.run(controller.signal);

  return {
    id: 'telegram',
    manda: (testo) => {
      prossimo += 1;
      batches.push([
        {
          update_id: prossimo,
          message: {
            message_id: prossimo,
            date: 0,
            chat: { id: OWNER_TG, type: 'private' },
            from: { id: OWNER_TG, is_bot: false, first_name: 'o' },
            text: testo,
          },
        } as unknown as Update,
      ]);
      sveglia?.();
    },
    inviati: () => [...inviati],
    chiamateAlModello: () => chiamate.length,
    turni: () => righeDeiTurni(runtime.db),
    pendenti: () => inbox.pending().map((u) => String(u.updateId)),
    pausa,
    chiudi: async () => {
      connector.stop();
      controller.abort();
      sveglia?.();
      await running.catch(() => {});
    },
  };
};

/**
 * Discord, guidato dal suo trasporto finto: il websocket scriptato di
 * `fake-socket.ts`, con `run()` vero che fa la stretta di mano e riceve i
 * `MESSAGE_CREATE` dal socket.
 */
const apriDiscord: Apri = async (over = {}) => {
  const chiamate: ChatCall[] = [];
  const { runtime, loop } = runtimeVero('dc', over, chiamate);
  const inviati: string[] = [];
  const sockets: FakeSocket[] = [];
  let prossimo = 200;

  const api = {
    me: async () => ({ id: '1', username: 'muffin' }),
    gatewayUrl: async () => ({ url: 'wss://gateway' }),
    sendMessage: async (_channelId: string, text: string) => {
      inviati.push(text);
      return {} as never;
    },
    typing: async () => undefined,
  } as unknown as DiscordApi;

  const inbox = new DiscordInbox(runtime.db);
  const pausa = new Pausa(runtime.db);
  const connector = new DiscordConnector({
    loop,
    sessions: runtime.deps.sessions,
    lane: new ModelLane(),
    inbox,
    api,
    config: { token: 't', ownerUserId: OWNER_DC },
    pausa,
    wsFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  const running = connector.run();
  await vi.waitFor(() => expect(sockets.length).toBe(1));
  sockets[0]!.serverSends(HELLO());
  sockets[0]!.serverSends(READY());

  return {
    id: 'discord',
    manda: (testo) => {
      prossimo += 1;
      const raw: DiscordMessage = {
        id: String(prossimo),
        channel_id: '42',
        channel_type: 1,
        author: { id: OWNER_DC, bot: false },
        content: testo,
      };
      sockets[0]!.serverSends({ op: 0, s: prossimo, t: 'MESSAGE_CREATE', d: raw });
    },
    inviati: () => [...inviati],
    chiamateAlModello: () => chiamate.length,
    turni: () => righeDeiTurni(runtime.db),
    pendenti: () => inbox.pending().map((m) => m.messageId),
    pausa,
    chiudi: async () => {
      await connector.stop(2_000);
      await running.catch(() => {});
    },
  };
};

/**
 * L'asse delle porte.
 *
 * Non una lista scritta a mano accanto alla produzione — è §5 stesso a
 * nominarlo come falsificatore (*"`INGRESS_PORT_IDS` resta una lista scritta a
 * mano"*). `INGRESS_PORT_IDS` è derivato dalla tabella `INGRESS_PORTS` di
 * `cli/surface.ts`, e il primo `it` di questo file rende rossa una terza porta
 * registrata lì senza una scena qui.
 */
const PORTE: readonly { readonly id: string; readonly apri: Apri }[] = [
  { id: 'telegram', apri: apriTelegram },
  { id: 'discord', apri: apriDiscord },
];

/* -------------------------------------------------------------------------- */
/*  Le divergenze ammesse                                                      */
/* -------------------------------------------------------------------------- */

type Divergenza = { readonly porta: string; readonly stadio: IngressStage; readonly adr: string };

/**
 * Ogni cella della tabella «stadio × porta» che **non** è una scena, con la
 * ragione per cui non lo è. Ogni fetta della fase C ne cancella una riga.
 *
 * Le due che ci sono nascono col file, ed è deliberato (§5): dichiararne zero
 * farebbe nascere rosso il describe 1, e dichiararne di più farebbe mentire il
 * describe 2 quando dice «le stesse asserzioni su entrambe le porte».
 */
const DIVERGENZE_AMMESSE: readonly Divergenza[] = [
  {
    porta: 'discord',
    stadio: 'gate',
    adr:
      "connectors/discord/connector.ts parseMessage:155-156 — solo i DM uno-a-uno passano, quindi ogni evento arriva direct:true per costruzione e non esiste un ramo di gruppo che il gate possa rifiutare (ADR-0063 riguarda Telegram)",
  },
  {
    porta: 'discord',
    stadio: 'remember',
    adr:
      "connectors/discord/connector.ts parseMessage:155-156 — ricorda-senza-rispondere è il ramo che il gate dirotta, e senza un gate che rifiuti non c'è niente da ricordare senza rispondere",
  },
];

/* -------------------------------------------------------------------------- */
/*  Describe 1 — ogni stadio ha una scena su ogni porta                        */
/* -------------------------------------------------------------------------- */

type Cella = { readonly scena: Scena } | { readonly nonApplicabile: true; readonly adr: string };

/**
 * I nomi delle scene che il describe 2 esegue davvero.
 *
 * La tabella qui sotto cita uno di questi, e un `it` del describe 2 porta lo
 * stesso nome: una cella non può dichiararsi coperta da una scena che nessuno
 * esegue.
 */
const SCENE = [
  'un turno dell owner arriva a una risposta',
  'in pausa nessuna porta parte, e ognuna lo dice con le stesse parole',
  'un turno sospeso non consegna niente e non si dichiara consegnato',
] as const;

type Scena = (typeof SCENE)[number];

const RISPONDE: Scena = 'un turno dell owner arriva a una risposta';
const IN_PAUSA: Scena = 'in pausa nessuna porta parte, e ognuna lo dice con le stesse parole';
const SOSPESO: Scena = 'un turno sospeso non consegna niente e non si dichiara consegnato';

/**
 * La tabella: una riga per stadio, una colonna per porta.
 *
 * **Scritta a mano, e non derivata da `DIVERGENZE_AMMESSE`.** Se le celle
 * nascessero dalla lista delle divergenze il confronto deep-equal più sotto
 * sarebbe una tautologia: due viste dello stesso array non possono mai
 * discordare. Sono due dichiarazioni indipendenti proprio perché il test che
 * conta è quello che le mette a confronto — segnare qui una cella
 * `nonApplicabile` senza aggiungerla là (o togliere una riga là senza toccare
 * qui) è la mutazione D del disegno, e diventa rossa.
 */
const TABELLA: Record<string, Record<IngressStage, Cella>> = {
  telegram: {
    pair: { scena: RISPONDE },
    gate: { scena: RISPONDE },
    remember: { scena: RISPONDE },
    command: { scena: RISPONDE },
    busy: { scena: IN_PAUSA },
    compose: { scena: RISPONDE },
    ingest: { scena: RISPONDE },
    work: { scena: RISPONDE },
    deliver: { scena: SOSPESO },
    settle: { scena: RISPONDE },
  },
  discord: {
    pair: { scena: RISPONDE },
    gate: {
      nonApplicabile: true,
      adr: 'connectors/discord/connector.ts parseMessage:155-156 — solo i DM uno-a-uno passano, quindi ogni evento arriva direct:true per costruzione e non esiste un ramo di gruppo che il gate possa rifiutare (ADR-0063 riguarda Telegram)',
    },
    remember: {
      nonApplicabile: true,
      adr: "connectors/discord/connector.ts parseMessage:155-156 — ricorda-senza-rispondere è il ramo che il gate dirotta, e senza un gate che rifiuti non c'è niente da ricordare senza rispondere",
    },
    command: { scena: RISPONDE },
    busy: { scena: IN_PAUSA },
    compose: { scena: RISPONDE },
    ingest: { scena: RISPONDE },
    work: { scena: RISPONDE },
    deliver: { scena: SOSPESO },
    settle: { scena: RISPONDE },
  },
};

describe('1. ogni stadio ha una scena su ogni porta', () => {
  it("l'asse delle porte è quello che cli/surface.ts registra davvero, non una lista scritta qui", () => {
    expect([...PORTE.map((p) => p.id)].sort()).toEqual([...INGRESS_PORT_IDS].sort());
    // E la tabella copre esattamente quell'asse: una terza porta registrata in
    // `cli/surface.ts` senza una colonna qui è rossa il giorno in cui viene
    // registrata (§5, il falsificatore di `INGRESS_PORT_IDS`).
    expect(Object.keys(TABELLA).sort()).toEqual([...INGRESS_PORT_IDS].sort());
  });

  it("l'asse dei comportamenti è INGRESS_STAGES, lo stesso array che receive itera", () => {
    for (const porta of PORTE) {
      expect(Object.keys(TABELLA[porta.id]!).sort()).toEqual([...INGRESS_STAGES].sort());
    }
  });

  it('ogni cella nomina una scena che il describe 2 esegue davvero', () => {
    for (const porta of PORTE) {
      for (const stadio of INGRESS_STAGES) {
        const c = TABELLA[porta.id]![stadio];
        if ('scena' in c) expect(SCENE).toContain(c.scena);
      }
    }
  });

  it("l'insieme dei nonApplicabile è esattamente DIVERGENZE_AMMESSE", () => {
    const trovate: Divergenza[] = [];
    for (const porta of PORTE) {
      for (const stadio of INGRESS_STAGES) {
        const c = TABELLA[porta.id]![stadio];
        if ('nonApplicabile' in c) trovate.push({ porta: porta.id, stadio, adr: c.adr });
      }
    }
    // Deep-equal, non «contiene»: una divergenza aggiunta alla tabella senza
    // dichiararla, o dichiarata senza esistere nella tabella, è rossa nello
    // stesso modo.
    expect(trovate).toEqual([...DIVERGENZE_AMMESSE]);
  });

  it('ogni divergenza cita il codice che la rende inevitabile', () => {
    for (const d of DIVERGENZE_AMMESSE) {
      expect(d.adr).toMatch(/connectors\/[a-z]+\/[a-z-]+\.ts \w+:\d+/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Describe 2 — la stessa scena, lo stesso esito                              */
/* -------------------------------------------------------------------------- */

describe('2. la stessa scena produce lo stesso esito su ogni porta', () => {
  for (const porta of PORTE) {
    describe(porta.id, () => {
      it('un turno dell owner arriva a una risposta', async () => {
        const p = await porta.apri();
        try {
          p.manda('ciao');
          await vi.waitFor(() => expect(p.inviati()).toContain(RISPOSTA), { timeout: 15_000 });
          // Il modello chiamato una volta: una risposta, non due.
          expect(p.chiamateAlModello()).toBe(1);
          // §4 invariante 1: la chiave d'instradamento durevole è l'id della
          // porta, non un letterale scritto nel connettore.
          expect(p.turni().map((t) => t.surface)).toEqual([porta.id]);
          // L'evento è consumato: la coda si svuota.
          await vi.waitFor(() => expect(p.pendenti()).toEqual([]), { timeout: 15_000 });
        } finally {
          await p.chiudi();
        }
      }, 30_000);

      it('in pausa nessuna porta parte, e ognuna lo dice con le stesse parole', async () => {
        const p = await porta.apri();
        try {
          p.pausa.metti();
          p.manda('ci sei?');
          // Byte per byte la stessa frase, §4 invariante 9.
          await vi.waitFor(() => expect(p.inviati()).toContain(AVVISO_IN_PAUSA), { timeout: 15_000 });
          // Niente modello, niente riga di turno, e l'evento resta dov'era: è
          // ciò che lo fa ri-drenare alla ripresa (§2.4, `{kind:'queued'}`).
          expect(p.chiamateAlModello()).toBe(0);
          expect(p.turni()).toEqual([]);
          expect(p.pendenti()).toHaveLength(1);
        } finally {
          await p.chiudi();
        }
      }, 30_000);

      it('un turno sospeso non consegna niente e non si dichiara consegnato', async () => {
        const p = await porta.apri({ sospendi: true });
        try {
          p.manda('aspetta');
          await vi.waitFor(() => expect(p.turni()).toHaveLength(1), { timeout: 15_000 });
          await vi.waitFor(() => expect(p.turni()[0]?.status).not.toBe('running'), { timeout: 15_000 });
          // `renderForDiscord('')` è `['(risposta vuota)']` e il render di
          // Telegram manderebbe un messaggio vuoto: nessuna delle due deve
          // partire, o l'owner legge il vuoto come la risposta.
          //
          // Asserito sulla riga durevole e sull'assenza della risposta, non su
          // `inviati()` vuoto: Telegram **ha** un trascritto e Discord no
          // (`streaming: {transport:'off'}`), quindi la porta con lo streaming
          // ha già scritto «✓ mi metto in attesa» in un messaggio di stato. È
          // una differenza di sink viva e dichiarata, non di esito: ciò che le
          // due porte devono dire allo stesso modo è che **niente è stato
          // consegnato**.
          expect(p.inviati()).not.toContain(RISPOSTA);
          expect(p.inviati()).not.toContain('');
          expect(p.turni().map((t) => t.delivery)).not.toContain('sent');
        } finally {
          await p.chiudi();
        }
      }, 30_000);
    });
  }
});

/* -------------------------------------------------------------------------- */
/*  Describe 3 — nessun connettore possiede il loop                            */
/* -------------------------------------------------------------------------- */

const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function fileNonTest(dir: string): string[] {
  const out: string[] = [];
  const cammina = (d: string): void => {
    for (const voce of readdirSync(d)) {
      if (voce === 'node_modules' || voce === 'dist' || voce.startsWith('.')) continue;
      const pieno = join(d, voce);
      if (statSync(pieno).isDirectory()) {
        cammina(pieno);
        continue;
      }
      if (!voce.endsWith('.ts') || voce.endsWith('.test.ts')) continue;
      out.push(pieno);
    }
  };
  cammina(join(RADICE, dir));
  return out;
}

/** Un import di **valore** (non `import type`) del nome dato. */
function importaComeValore(sorgente: string, nome: string): boolean {
  const righe = sorgente.split('\n');
  return righe.some((r) => {
    const m = /^import\s+(?!type\b)(.+?)\s+from\s+['"](.+?)['"];?$/.exec(r.trim());
    if (m === null) return false;
    const clausola = m[1] ?? '';
    // `import { type X, runTurn }` conta; `import { type X }` no.
    return new RegExp(`(^|[{,\\s])${nome}(\\s|,|}|$)`).test(clausola.replace(/\btype\s+\w+/g, ''));
  });
}

/**
 * Le bocche che chiamano `runTurn` **senza** essere porte d'ingresso.
 *
 * Enumerate e non escluse per pattern: il terminale non ha un inbox, non ha un
 * evento durevole da legare e non ha una consegna da recuperare dopo un crash,
 * quindi non ha niente da guadagnare dagli stadi — ma il giorno in cui una
 * terza riga comparisse qui sarebbe una decisione, non una svista.
 *
 * Quel giorno è #533: `cli/gateway.ts` esegue i turni che il terminale gli
 * inoltra sul socket di controllo, sullo stesso runtime e la stessa ModelLane
 * di Telegram — è l'execution owner che esegue, non una terza bocca
 * indipendente. Il REPL resta in lista per i turni locali senza gateway.
 */
const BOCCHE_SENZA_INGRESSO = ['cli/gateway.ts', 'cli/repl.ts', 'cli/run.ts'];

describe('3. nessun connettore possiede il loop', () => {
  const sorgenti = [...fileNonTest('connectors'), ...fileNonTest('cli')].map((f) => ({
    path: relative(RADICE, f),
    testo: readFileSync(f, 'utf8'),
  }));

  it('sotto connectors/ solo lo stadio work importa runTurn come valore', () => {
    const colpevoli = sorgenti.filter((s) => s.path.startsWith('connectors/') && importaComeValore(s.testo, 'runTurn'));
    // Un elemento solo, e non «zero fra i connettori»: lo stadio `work` **è**
    // sotto `connectors/`, ed è deliberato (§2.2, il cammino condiviso nasce
    // in `connectors/shared/`, non nel nucleo). La clausola che conta è che
    // sia l'unico. Fino alla fetta 15 questa lista aveva tre voci: Discord
    // chiamava `runTurn` davvero, e Telegram ne aveva ancora l'import di
    // valore rimasto dietro alla fetta 14 — vivo abbastanza da farlo tornare
    // a essere una chiamata con una riga sola.
    expect(colpevoli.map((s) => s.path)).toEqual(['connectors/shared/ingress/work.ts']);
  });

  it('sotto cli/ solo il terminale lo fa, e i due file sono nominati', () => {
    const colpevoli = sorgenti.filter((s) => s.path.startsWith('cli/') && importaComeValore(s.testo, 'runTurn'));
    expect(colpevoli.map((s) => s.path).sort()).toEqual([...BOCCHE_SENZA_INGRESSO].sort());
  });

  it('nessun connettore apre da sé il registro dei turni: le scritture passano da deps.loop.turns', () => {
    const colpevoli = sorgenti.filter(
      (s) => s.path.startsWith('connectors/') && importaComeValore(s.testo, 'TurnStore'),
    );
    expect(colpevoli.map((s) => s.path)).toEqual([]);
  });

  it("l'unico modulo che chiama runTurn per un evento in arrivo è lo stadio work", () => {
    const chiamano = [...fileNonTest('connectors')]
      .map((f) => ({ path: relative(RADICE, f), testo: readFileSync(f, 'utf8') }))
      .filter((s) => /\brunTurn\s*\(/.test(s.testo.replace(/`[^`]*`/g, '')))
      .map((s) => s.path);
    expect(chiamano).toEqual(['connectors/shared/ingress/work.ts']);
  });
});

/* -------------------------------------------------------------------------- */
/*  Describe 4 — il connettore entra davvero dal router                        */
/* -------------------------------------------------------------------------- */

/**
 * Il describe che regge gli altri tre.
 *
 * Le prime tre clausole restano tutte verdi davanti a un connettore che
 * importa `composeTurnText`, `ingestAttachment` e `runWork` e li chiama nel
 * proprio ordine scritto a mano: il codice condiviso sarebbe condiviso, e il
 * *cammino* no. `witnessIngress` è l'unica cosa che distingue i due casi,
 * perché è il router a emetterla e nessun ricalco degli stadi ha ragione di
 * riprodurla.
 */
describe('4. il connettore entra davvero dal router', () => {
  for (const porta of PORTE) {
    it(`${porta.id}: il drain vero cammina INGRESS_STAGES, dal primo all'ultimo`, async () => {
      const visite: IngressVisit[] = [];
      const smetti = witnessIngress((v) => visite.push(v));
      const p = await porta.apri();
      try {
        p.manda('ciao');
        await vi.waitFor(() => expect(p.inviati()).toContain(RISPOSTA), { timeout: 15_000 });
      } finally {
        await p.chiudi();
        smetti();
      }

      const mie = visite.filter((v) => v.portId === porta.id);
      // Una porta che ricalcasse gli stadi accanto al router non produrrebbe
      // nessuna visita: `mie` sarebbe vuoto, ed è la mutazione C del disegno.
      expect(mie.length).toBeGreaterThan(0);
      const evento = mie[0]!.eventId;
      expect(mie.every((v) => v.eventId === evento)).toBe(true);
      // Il cammino intero, nell'ordine dell'array che la produzione itera.
      expect(mie.map((v) => v.stage)).toEqual([...INGRESS_STAGES]);
    }, 30_000);
  }

  it('la testimonianza viene dal router e non da un gancio che la porta potrebbe chiamare', () => {
    // `witnessIngress` non compare in nessun connettore: se comparisse, una
    // porta potrebbe soddisfare il describe qui sopra senza camminare niente.
    const colpevoli = fileNonTest('connectors')
      .filter((f) => !f.endsWith(join('shared', 'ingress', 'router.ts')))
      .filter((f) => readFileSync(f, 'utf8').includes('witnessIngress'));
    expect(colpevoli.map((f) => relative(RADICE, f))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Il quarto asse — la stanza                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Decisione dell'owner del 06/09/2026: cosa Muffin puo' fare non e' una
 * proprieta' della porta, e' una proprieta' della coppia `(porta, stanza)`.
 * Fino a quel giorno `Surface.streaming.transport` era un valore per porta —
 * `'edit'` per tutta Telegram — e il codice che doveva sapere se qui dentro
 * si poteva mostrare un'anteprima lo deduceva da un booleano `isPrivate`
 * passato a mano a un renderer.
 *
 * Questo asse e' scritto **a mano** e non derivato da `negotiate`, per la
 * stessa ragione per cui `TABELLA` non e' derivata da `DIVERGENZE_AMMESSE`:
 * due viste dello stesso oggetto non possono discordare, e il test che conta
 * e' quello che mette a confronto due dichiarazioni indipendenti. Una porta
 * che comincia a servire una stanza nuova, o che cambia cosa promette in una
 * che gia' serviva, diventa rossa qui.
 */
type Promessa = { readonly stream: readonly StreamMode[]; readonly files: readonly FileMode[] };

const NEGOZIAZIONE: Record<string, Partial<Record<Place, Promessa>>> = {
  telegram: {
    // `sendMessageDraft` esiste solo in una chat privata, e la risposta
    // finale resta un messaggio vero: la catena dice esattamente questo.
    direct: { stream: ['draft', 'edit', 'off'], files: ['native', 'say'] },
    group: { stream: ['edit', 'off'], files: ['native', 'say'] },
    // Un topic eredita i limiti della chat: cambia dove si scrive, non cosa si puo' fare.
    topic: { stream: ['edit', 'off'], files: ['native', 'say'] },
  },
  discord: {
    // Dichiarato com'e' oggi: `connectors/discord/connector.ts` non riscrive
    // mai un messaggio inviato, e accetta solo DM uno-a-uno.
    direct: { stream: ['off'], files: ['native', 'say'] },
  },
};

/** Le porte come `cli/surface.ts` le costruisce, con un trasporto che non viene mai toccato. */
const FINTA = {} as never;
const PORTE_DICHIARATE: readonly { readonly id: string; readonly porta: IngressPort }[] = [
  { id: 'telegram', porta: telegramPort(FINTA, 1) },
  { id: 'discord', porta: discordPort(FINTA, '1') },
];

describe('5. ogni porta dichiara cosa sa fare in ogni stanza che serve', () => {
  it("l'asse delle stanze copre esattamente le porte registrate", () => {
    expect(PORTE_DICHIARATE.map((p) => p.id).sort()).toEqual([...INGRESS_PORT_IDS].sort());
    expect(Object.keys(NEGOZIAZIONE).sort()).toEqual([...INGRESS_PORT_IDS].sort());
  });

  for (const { id, porta } of PORTE_DICHIARATE) {
    it(`${id}: la tabella scritta qui e quella che la porta risponde sono la stessa`, () => {
      const dichiarate = [...porta.surface.places].sort();
      // Una stanza servita senza una riga qui (o una riga qui senza la
      // stanza) e' la porta che «salta la negoziazione»: rossa.
      expect(Object.keys(NEGOZIAZIONE[id]!).sort()).toEqual(dichiarate);
      for (const place of porta.surface.places) {
        const attesa = NEGOZIAZIONE[id]![place]!;
        const vera = porta.surface.negotiate(place);
        expect({ stream: vera.stream, files: vera.files }).toEqual(attesa);
      }
    });

    it(`${id}: nelle stanze che non serve non promette niente`, () => {
      for (const place of PLACES) {
        if (porta.surface.places.includes(place)) continue;
        const n = porta.surface.negotiate(place);
        expect(n.stream[0]).toBe('off');
        expect(n.files[0]).toBe('say');
      }
    });
  }

  it('una stanza che dichiara un ritmo lo dichiara intero', () => {
    for (const { porta } of PORTE_DICHIARATE) {
      for (const place of porta.surface.places) {
        const n = porta.surface.negotiate(place);
        if (n.stream.includes('edit')) {
          expect(n.editEveryMs).toBeGreaterThan(0);
          expect(n.maxEditsPerMinute).toBeGreaterThan(0);
          // I due limiti della Bot API devono poter coesistere: un tetto
          // oltre quello che il pavimento lascia passare non e' un tetto.
          expect(n.maxEditsPerMinute).toBeLessThanOrEqual(Math.floor(60_000 / n.editEveryMs));
        }
        if (n.stream.includes('draft')) expect(n.draftTtlMs).toBeGreaterThan(0);
      }
    }
  });
});
