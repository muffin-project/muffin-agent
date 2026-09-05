import { describe, expect, it } from 'vitest';
import type { Principal } from '../../../core/policy/types.js';
import { identify, OWNER_SESSION_KEY } from '../../../core/surface/types.js';
import {
  AVVISO_IN_CODA,
  AVVISO_IN_PAUSA,
  controlliPerCorsia,
  laneKey,
  LaneRegistry,
  QueueNotices,
  tryControlCommand,
} from './lane.js';

/**
 * Slice 13's twin test: the live-lane registry, the per-event queue notice,
 * and the command stitching, tested where they now live instead of only
 * through the Telegram connector that used to own them.
 *
 * The mutations this file is written to catch, per §3 row 13:
 *  - the queue notice deduplicated per drain (or per lane) instead of per
 *    event → "due messaggi, due avvisi" goes red;
 *  - the lane keyed on `sessionKey` alone → the invariant 5 describe goes red;
 *  - a control command served after the queue rather than before → red in
 *    `connectors/telegram/busy.test.ts`, which drives the real poller.
 */

const owner: Principal = { kind: 'owner', connector: 'telegram', externalId: '1' };
const member: Principal = { kind: 'member', connector: 'telegram', tenantId: 'group:telegram:9', externalId: '2' };

describe('LaneRegistry: due scrittori, due lettori', () => {
  it('un turno fresco apre la corsia e la chiude, e i lettori la vedono viva solo in mezzo', () => {
    const corsie = new LaneRegistry();
    const k = laneKey('telegram', 42);
    expect(corsie.isLive(k)).toBe(false);
    expect(corsie.stop(k)).toBe(false);
    expect(corsie.steer(k, 'tardi')).toBe(false);

    const lane = corsie.open(k);
    expect(corsie.isLive(k)).toBe(true);
    expect(corsie.steer(k, 'in italiano')).toBe(true);
    expect(lane.correzioni).toEqual(['in italiano']);
    expect(corsie.stop(k)).toBe(true);
    expect(lane.controller.signal.aborted).toBe(true);

    corsie.close(k);
    expect(corsie.isLive(k)).toBe(false);
    // Idempotente, come il `finally` che sostituisce.
    corsie.close(k);
    expect(corsie.isLive(k)).toBe(false);
  });

  it('un resume che trova la corsia libera la registra, e la restituisce a `release`', () => {
    const corsie = new LaneRegistry();
    const k = laneKey('telegram', 43);
    const { lane, release } = corsie.attach(k);
    expect(corsie.isLive(k)).toBe(true);
    expect(corsie.get(k)).toBe(lane);
    release();
    expect(corsie.isLive(k)).toBe(false);
  });

  it('un resume che trova un turno fresco vivo usa la sua leva e non gliela toglie', () => {
    const corsie = new LaneRegistry();
    const k = laneKey('telegram', 44);
    const fresco = corsie.open(k);

    const { lane, release } = corsie.attach(k);
    expect(lane).toBe(fresco);
    release();
    // Il turno fresco sta ancora girando: `/stop` deve continuare a trovarlo.
    expect(corsie.isLive(k)).toBe(true);
    expect(corsie.stop(k)).toBe(true);
    expect(fresco.controller.signal.aborted).toBe(true);
  });

  it('due chat della stessa porta sono due corsie: `/stop` dal gruppo non ferma la privata', () => {
    const corsie = new LaneRegistry();
    const privata = corsie.open(laneKey('telegram', 42));
    corsie.open(laneKey('telegram', -100));
    expect(corsie.stop(laneKey('telegram', -100))).toBe(true);
    expect(privata.controller.signal.aborted).toBe(false);
  });
});

/**
 * §4 invariante 5 — la decisione esplicita, non l'effetto collaterale.
 *
 * `identify()` risponde `OWNER_SESSION_KEY` (il letterale `'owner'`) per
 * l'owner su **ogni** porta: la chiave di sessione, da sola, non distingue
 * Telegram da Discord. Oggi le corsie sono per connettore e quindi le due
 * porte non condividono mai un turno vivo; il registro condiviso conserva
 * quel comportamento perché la chiave porta il prefisso della porta.
 *
 * Cancellare il prefisso da `laneKey` (la mutazione «chiave sulla sola
 * `sessionKey`») rende rosso questo describe e nient'altro: è la prova che
 * la scelta è cablata e non solo scritta nel docstring. Vedi ADR-0054 per la
 * corsia, ADR-0056 per la sessione unica dell'owner attraverso le porte — è
 * la sessione a essere condivisa, non la corsia.
 */
describe('invariante 5: lo stesso owner su due porte sono due corsie', () => {
  it('`identify` dà la stessa `sessionKey` alle due porte, e `laneKey` le tiene distinte', () => {
    const tg = identify(
      { connector: 'telegram', authorId: '77', conversationId: '77', direct: true },
      '77',
    );
    const dc = identify(
      { connector: 'discord', authorId: '77', conversationId: '77', direct: true },
      '77',
    );
    expect(tg.sessionKey).toBe(OWNER_SESSION_KEY);
    expect(dc.sessionKey).toBe(OWNER_SESSION_KEY);
    // La sessione è una sola (ADR-0056) — la corsia no.
    expect(laneKey('telegram', tg.sessionKey)).not.toBe(laneKey('discord', dc.sessionKey));
  });

  it('un turno vivo su una porta non risulta vivo sull altra, e `/stop` non attraversa', () => {
    const corsie = new LaneRegistry();
    const suTelegram = laneKey('telegram', OWNER_SESSION_KEY);
    const suDiscord = laneKey('discord', OWNER_SESSION_KEY);

    const turnoTelegram = corsie.open(suTelegram);
    expect(corsie.isLive(suTelegram)).toBe(true);
    // Se la chiave fosse la sola `sessionKey`, questa sarebbe `true`: l'owner
    // su Discord riceverebbe «📥 in coda» per un turno che gira su Telegram.
    expect(corsie.isLive(suDiscord)).toBe(false);

    // E `/stop` scritto su Discord non fermerebbe il turno di Telegram.
    expect(corsie.stop(suDiscord)).toBe(false);
    expect(turnoTelegram.controller.signal.aborted).toBe(false);
    expect(corsie.stop(suTelegram)).toBe(true);
    expect(turnoTelegram.controller.signal.aborted).toBe(true);
  });
});

describe('QueueNotices: una volta per evento, non per drain', () => {
  it('tace quando non c è niente di vero da dire', () => {
    const avvisi = new QueueNotices();
    expect(avvisi.decide(1, { inPausa: false, vivo: false })).toBeUndefined();
    expect(avvisi.size).toBe(0);
  });

  it('dice «in coda» con un turno vivo, e «in pausa» quando il runtime è fermo', () => {
    const avvisi = new QueueNotices();
    expect(avvisi.decide(1, { inPausa: false, vivo: true })).toBe(AVVISO_IN_CODA);
    expect(avvisi.decide(2, { inPausa: true, vivo: false })).toBe(AVVISO_IN_PAUSA);
    // La pausa vince: il turno in coda non partirebbe comunque.
    expect(avvisi.decide(3, { inPausa: true, vivo: true })).toBe(AVVISO_IN_PAUSA);
  });

  it('byte-identico al testo che l owner legge oggi (invariante 9)', () => {
    expect(AVVISO_IN_CODA).toBe('📥 in coda: rispondo appena finisco con quello di prima.');
    expect(AVVISO_IN_PAUSA).toBe('⏸ in pausa: lo leggo al /resume.');
  });

  it('due messaggi mentre lo stesso turno gira ricevono due avvisi', () => {
    // La mutazione «avviso per drain invece che per evento» (dedurre una
    // volta per corsia, o azzerare il registro a ogni drain) rende rosso
    // esattamente questo: l'owner vedrebbe confermato solo il primo dei due
    // messaggi e non saprebbe se il secondo è stato sentito.
    const avvisi = new QueueNotices();
    expect(avvisi.decide(10, { inPausa: false, vivo: true })).toBe(AVVISO_IN_CODA);
    expect(avvisi.decide(11, { inPausa: false, vivo: true })).toBe(AVVISO_IN_CODA);
    expect(avvisi.size).toBe(2);
  });

  it('lo stesso messaggio visto da un secondo drain non viene riconfermato', () => {
    const avvisi = new QueueNotices();
    expect(avvisi.decide(10, { inPausa: false, vivo: true })).toBe(AVVISO_IN_CODA);
    expect(avvisi.decide(10, { inPausa: false, vivo: true })).toBeUndefined();
    expect(avvisi.size).toBe(1);
  });
});

describe('il cucito dei comandi: `Controlli` dalla corsia, risposta dalla porta', () => {
  const base = {
    text: '/stop',
    sessionId: 's1',
    esegui: async () => ({ testo: 'Fermato.' }),
  };

  it('costruisce le leve di ADR-0054 su **questa** corsia', () => {
    const corsie = new LaneRegistry();
    const k = laneKey('telegram', 42);
    const controlli = controlliPerCorsia(corsie, k, undefined);
    expect(controlli.vivo()).toBe(false);
    expect(controlli.stop()).toBe(false);
    expect(controlli.steer('x')).toBe(false);
    // Senza una pausa cablata, le tre leve rispondono «qui non posso» invece di lanciare.
    expect(controlli.pausa.attiva()).toBe(false);
    controlli.pausa.metti();
    controlli.pausa.togli();

    const lane = corsie.open(k);
    expect(controlli.vivo()).toBe(true);
    expect(controlli.steer('in italiano')).toBe(true);
    expect(lane.correzioni).toEqual(['in italiano']);
    expect(controlli.stop()).toBe(true);
    expect(lane.controller.signal.aborted).toBe(true);
  });

  it('inoltra la pausa durevole, senza copiarne lo stato', () => {
    let attiva = false;
    const controlli = controlliPerCorsia(new LaneRegistry(), laneKey('telegram', 1), {
      attiva: () => attiva,
      metti: () => {
        attiva = true;
      },
      togli: () => {
        attiva = false;
      },
    });
    expect(controlli.pausa.attiva()).toBe(false);
    controlli.pausa.metti();
    expect(controlli.pausa.attiva()).toBe(true);
    controlli.pausa.togli();
    expect(controlli.pausa.attiva()).toBe(false);
  });

  it('esegue il comando dell owner e lo fa dire alla porta', async () => {
    const detto: string[] = [];
    const fatto = await tryControlCommand({
      ...base,
      principal: owner,
      controlli: controlliPerCorsia(new LaneRegistry(), laneKey('telegram', 1), undefined),
      rispondi: async (testo) => {
        detto.push(testo);
      },
    });
    expect(fatto).toBe(true);
    expect(detto).toEqual(['Fermato.']);
  });

  it('un comando che non è dell owner non è un comando, e non lo si dice', async () => {
    const detto: string[] = [];
    let chiamato = false;
    const fatto = await tryControlCommand({
      ...base,
      principal: member,
      esegui: async () => {
        chiamato = true;
        return { testo: 'Fermato.' };
      },
      controlli: controlliPerCorsia(new LaneRegistry(), laneKey('telegram', 1), undefined),
      rispondi: async (testo) => {
        detto.push(testo);
      },
    });
    // `false` e silenzio: il testo prosegue verso il modello come una frase
    // qualunque, senza dire a un estraneo che quel comando esiste.
    expect(fatto).toBe(false);
    expect(chiamato).toBe(false);
    expect(detto).toEqual([]);
  });

  it('senza comandi cablati, o senza uno slash, il testo prosegue', async () => {
    const controlli = controlliPerCorsia(new LaneRegistry(), laneKey('telegram', 1), undefined);
    expect(
      await tryControlCommand({ ...base, principal: owner, esegui: undefined, controlli, rispondi: async () => {} }),
    ).toBe(false);
    expect(
      await tryControlCommand({ ...base, text: 'ciao', principal: owner, controlli, rispondi: async () => {} }),
    ).toBe(false);
  });

  it('un nome che `eseguiComando` non riconosce resta non gestito', async () => {
    const detto: string[] = [];
    const fatto = await tryControlCommand({
      ...base,
      principal: owner,
      esegui: async () => null,
      controlli: controlliPerCorsia(new LaneRegistry(), laneKey('telegram', 1), undefined),
      rispondi: async (testo) => {
        detto.push(testo);
      },
    });
    expect(fatto).toBe(false);
    expect(detto).toEqual([]);
  });
});

describe('nessun nome di piattaforma nel modulo condiviso (invariante 11)', () => {
  it('`lane.ts` non nomina una piattaforma in un identificatore o in un ramo', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./lane.ts', import.meta.url), 'utf8');
    // I docstring spiegano *perché* la chiave porta il prefisso, e per farlo
    // devono nominare le due porte; il codice no. Si guarda ciò che resta
    // tolti i commenti.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((riga) => !riga.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/telegram|discord|slack|whatsapp/i);
  });
});
