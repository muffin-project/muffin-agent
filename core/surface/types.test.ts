import { describe, expect, it } from 'vitest';
import {
  assertNegotiable,
  DELIVERED,
  fileModeFor,
  identify,
  MUTA,
  type IncomingIdentity,
  type Negotiation,
  type Place,
  type Surface,
} from './types.js';

/**
 * La chiave di conversazione, provata dove viene decisa.
 *
 * Il failure osservato dall'owner il 03/09 — «non sembra di star parlando allo
 * stesso muffin» — non era un confine di sicurezza: la DM Telegram dell'owner e
 * il terminale sono già lo stesso tenant `host` (`identify` qui sotto). Era una
 * stringa di sessione scritta a mano in due connector, `telegram:<chatId>` e
 * `discord:<channelId>`, che due porte diverse non possono mai far coincidere.
 *
 * Da qui la chiave esce da `identify` e da nessun altro posto, e le proprietà
 * che seguono sono conseguenze della funzione invece che condizioni da
 * ricordare una volta per connector. In particolare la terza: **l'owner dentro
 * un gruppo è un `member` di quel tenant**, quindi non può produrre `owner` —
 * la stessa proprietà che `connectors/telegram/impersonation.test.ts` sorveglia
 * per il principal, letta sulla chiave.
 */

const OWNER = '4242';

function dm(connector: string, authorId: string, conversationId: string): IncomingIdentity {
  return { connector, authorId, conversationId, direct: true };
}

function gruppo(connector: string, authorId: string, conversationId: string): IncomingIdentity {
  return { connector, authorId, conversationId, direct: false };
}

describe('identify · sessionKey', () => {
  it('la DM dell owner produce la stessa chiave su telegram e su discord', () => {
    const tg = identify(dm('telegram', OWNER, '4242'), OWNER);
    const dc = identify(dm('discord', OWNER, '99887766'), OWNER);

    expect(tg.principal.kind).toBe('owner');
    expect(dc.principal.kind).toBe('owner');
    expect(tg.sessionKey).toBe('owner');
    // La riga che chiude il failure: due porte, una conversazione.
    expect(dc.sessionKey).toBe(tg.sessionKey);
  });

  it('un gruppo ha una chiave sua, diversa da quella dell owner e da quella di un altro gruppo', () => {
    const uno = identify(gruppo('telegram', '777', '-100'), OWNER);
    const due = identify(gruppo('telegram', '777', '-200'), OWNER);
    const owner = identify(dm('telegram', OWNER, '4242'), OWNER);

    // Invariata rispetto a prima della fusione: è la stringa che il connector
    // scriveva a mano, quindi per i gruppi non cambia nemmeno il nome del file.
    expect(uno.sessionKey).toBe('telegram:-100');
    expect(due.sessionKey).toBe('telegram:-200');
    expect(uno.sessionKey).not.toBe(due.sessionKey);
    expect(uno.sessionKey).not.toBe(owner.sessionKey);
  });

  it('due connector diversi non condividono la chiave di un gruppo', () => {
    const tg = identify(gruppo('telegram', '777', '5'), OWNER);
    const dc = identify(gruppo('discord', '777', '5'), OWNER);
    expect(tg.sessionKey).not.toBe(dc.sessionKey);
  });

  it('l owner **dentro** un gruppo prende la chiave del gruppo, mai `owner`', () => {
    const dentro = identify(gruppo('telegram', OWNER, '-100'), OWNER);
    expect(dentro.principal.kind).toBe('member');
    expect(dentro.tenant).toBe('group:telegram:-100');
    expect(dentro.sessionKey).toBe('telegram:-100');
    expect(dentro.sessionKey).not.toBe('owner');
  });

  it('senza pairing nessuno è owner, quindi nessuno prende la chiave dell owner', () => {
    const nessuno = identify(dm('telegram', OWNER, '4242'), undefined);
    expect(nessuno.principal.kind).toBe('member');
    expect(nessuno.sessionKey).not.toBe('owner');
  });

  it('un mittente anonimo non prende la chiave dell owner', () => {
    const anonimo = identify(dm('telegram', '', '4242'), OWNER);
    expect(anonimo.principal.kind).toBe('member');
    expect(anonimo.sessionKey).toBe('telegram:4242');
  });
});


/* -------------------------------------------------------------------------- */
/*  La negoziazione per stanza                                                 */
/* -------------------------------------------------------------------------- */

/**
 * La decisione dell'owner del 06/09/2026 provata dove vive: una superficie
 * che dichiara qualcosa di impossibile non deve arrivare a esistere.
 *
 * `makeIngressPort` chiama `assertNegotiable`, quindi il rifiuto e' alla
 * costruzione della porta e non davanti all'owner a meta' turno. Le regole
 * qui sotto non nominano nessuna piattaforma: valgono anche per la porta che
 * non e' ancora stata scritta.
 */
function superficie(over: {
  places?: readonly Place[];
  negotiate?: (p: Place) => Negotiation;
  maxUploadBytes?: number;
  transport?: 'stdout' | 'edit' | 'off';
}): Surface {
  return {
    id: 'prova',
    limits: { maxMessageChars: 100, maxUploadBytes: over.maxUploadBytes ?? 10, maxDownloadBytes: 0 },
    streaming: { transport: over.transport ?? 'off' },
    places: over.places ?? ['direct'],
    negotiate: over.negotiate ?? ((): Negotiation => MUTA),
    handles: () => true,
    deliver: async () => DELIVERED,
    deliverFile: async () => DELIVERED,
  };
}

const VIVA = (over: Partial<Negotiation> = {}): Negotiation => ({
  stream: ['edit', 'off'],
  editEveryMs: 1_000,
  maxEditsPerMinute: 20,
  draftTtlMs: 0,
  files: ['say'],
  ...over,
});

describe('assertNegotiable rifiuta una dichiarazione impossibile', () => {
  it("un'anteprima in una stanza condivisa e' rifiutata: non esiste una riga di composizione di tutti", () => {
    expect(() =>
      assertNegotiable(
        superficie({
          places: ['group'],
          transport: 'edit',
          negotiate: (p) => (p === 'group' ? VIVA({ stream: ['draft', 'edit', 'off'], draftTtlMs: 30_000 }) : MUTA),
        }),
      ),
    ).toThrow(/draft/);
  });

  it("un'anteprima uno-a-uno senza scadenza e' rifiutata: senza ttl non si sa quando rinnovarla", () => {
    expect(() =>
      assertNegotiable(
        superficie({
          places: ['direct'],
          transport: 'edit',
          negotiate: (p) => (p === 'direct' ? VIVA({ stream: ['draft', 'edit', 'off'] }) : MUTA),
        }),
      ),
    ).toThrow(/draftTtlMs/);
  });

  it('un allegato nativo su una superficie che non muove byte e\' rifiutato', () => {
    expect(() =>
      assertNegotiable(
        superficie({
          places: ['direct'],
          maxUploadBytes: 0,
          transport: 'edit',
          negotiate: (p) => (p === 'direct' ? VIVA({ files: ['native', 'say'] }) : MUTA),
        }),
      ),
    ).toThrow(/native/);
  });

  it('un tetto oltre quello che il pavimento lascia passare e\' rifiutato: uno dei due numeri sarebbe decorazione', () => {
    expect(() =>
      assertNegotiable(
        superficie({
          places: ['direct'],
          transport: 'edit',
          negotiate: (p) => (p === 'direct' ? VIVA({ editEveryMs: 1_000, maxEditsPerMinute: 120 }) : MUTA),
        }),
      ),
    ).toThrow(/maxEditsPerMinute/);
  });

  it('una catena senza fondo e\' rifiutata: promette che qualcosa funzionera\' sempre', () => {
    expect(() =>
      assertNegotiable(
        superficie({ places: ['direct'], transport: 'edit', negotiate: (p) => (p === 'direct' ? VIVA({ stream: ['edit'] }) : MUTA) }),
      ),
    ).toThrow(/off/);
  });

  it('una promessa in una stanza non dichiarata e\' rifiutata', () => {
    expect(() => assertNegotiable(superficie({ places: ['direct'], transport: 'edit', negotiate: () => VIVA() }))).toThrow(
      /non e\u0300 fra le stanze dichiarate|non è fra le stanze dichiarate/,
    );
  });

  it('streaming.transport e le stanze non possono discordare', () => {
    expect(() =>
      assertNegotiable(superficie({ places: ['direct'], transport: 'off', negotiate: (p) => (p === 'direct' ? VIVA() : MUTA) })),
    ).toThrow(/streaming.transport/);
  });
});

describe('fileModeFor scende la catena finche\' un modo regge questi byte', () => {
  const limits = { maxMessageChars: 100, maxUploadBytes: 1_000, maxDownloadBytes: 0 };
  const catena = VIVA({ files: ['native', 'say'] });

  it("sotto il tetto e' un allegato vero", () => {
    expect(fileModeFor(catena, limits, 999)).toBe('native');
  });

  it("sopra il tetto non e' un fallimento, e' un percorso detto a parole", () => {
    expect(fileModeFor(catena, limits, 1_001)).toBe('say');
  });
});
