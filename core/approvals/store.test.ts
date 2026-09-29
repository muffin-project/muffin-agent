import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ApprovalStore } from './store.js';

/**
 * Il registro delle domande fatte all'owner e non ancora risposte.
 *
 * Le due proprietà che questo file tiene chiuse non sono «funziona»: sono
 * **una risposta, un uso** e **la risposta vale per quello che l'owner ha
 * letto**. Senza la prima, un sì detto una volta diventa un interruttore che
 * l'owner ha girato senza saperlo; senza la seconda, il sì detto per un
 * comando autorizza un comando diverso.
 */

const store = (): ApprovalStore => new ApprovalStore(new DatabaseCtor(':memory:'));
const T0 = new Date('2026-08-28T10:00:00.000Z');
const chiedi = (s: ApprovalStore, over: Partial<Parameters<ApprovalStore['ask']>[0]> = {}): string =>
  s.ask(
    { turnId: 't1', capability: 'sys.shell', resource: 'rm -rf /tmp/x', prompt: 'eseguo?', taint: 0, ...over },
    T0,
  );

describe('una domanda, una risposta', () => {
  it('finché nessuno risponde, la barriera non è soddisfatta', () => {
    const s = store();
    const id = chiedi(s);
    expect(s.answered(id)).toBe(false);
    expect(s.open('t1')?.id).toBe(id);
  });

  it('e quando arriva, la barriera si apre e la domanda non è più aperta', () => {
    const s = store();
    const id = chiedi(s);
    expect(s.decide(id, 'allow', T0)).toBe('ok');
    expect(s.answered(id)).toBe(true);
    expect(s.open('t1')).toBeNull();
  });

  /**
   * Due tocchi sullo stesso pulsante sono la cosa più normale che succeda:
   * Telegram non toglie la tastiera da solo e un tap che sembra non aver fatto
   * niente si ripete. La prima risposta vince, e la seconda è detta come tale.
   */
  it('il secondo tocco non cambia la risposta, e lo dice', () => {
    const s = store();
    const id = chiedi(s);
    expect(s.decide(id, 'deny', T0)).toBe('ok');
    expect(s.decide(id, 'allow', T0)).toBe('already');
    expect(s.get(id)?.decision).toBe('deny');
  });

  it('e un pulsante di cui non sappiamo niente è detto come tale, non ignorato', () => {
    expect(store().decide('deadbeef', 'allow', T0)).toBe('unknown');
  });
});

describe('una risposta, un uso', () => {
  it('la prima chiamata la consuma, la seconda non trova più niente', () => {
    const s = store();
    const id = chiedi(s);
    s.decide(id, 'allow', T0);

    expect(s.take({ turnId: 't1', capability: 'sys.shell', resource: 'rm -rf /tmp/x' }, T0)).toBe('allow');
    // Senza questa riga un sì detto una volta diventa un sì per ogni
    // `sys.shell` di quel turno: un interruttore, non una domanda.
    expect(s.take({ turnId: 't1', capability: 'sys.shell', resource: 'rm -rf /tmp/x' }, T0)).toBeNull();
  });

  it('una domanda senza risposta non si consuma', () => {
    const s = store();
    chiedi(s);
    expect(s.take({ turnId: 't1', capability: 'sys.shell', resource: 'rm -rf /tmp/x' }, T0)).toBeNull();
  });
});

describe('la risposta vale per quello che l owner ha letto', () => {
  /**
   * Il pulsante mostrava *quel* comando. Un sì che valesse per qualunque altro
   * comando della stessa capability sarebbe teatro — che è esattamente ciò che
   * DAY-1 requirement D12 dice di non fare: «un'approvazione il cui soggetto è
   * invisibile».
   */
  it('un altro comando non è quel comando', () => {
    const s = store();
    s.decide(chiedi(s), 'allow', T0);
    expect(s.take({ turnId: 't1', capability: 'sys.shell', resource: 'curl evil.example' }, T0)).toBeNull();
    expect(s.take({ turnId: 't1', capability: 'sys.shell', resource: 'rm -rf /tmp/x' }, T0)).toBe('allow');
  });

  it("un'altra capability non è quella capability", () => {
    const s = store();
    s.decide(chiedi(s), 'allow', T0);
    expect(s.take({ turnId: 't1', capability: 'fs.write', resource: 'rm -rf /tmp/x' }, T0)).toBeNull();
  });

  it('e un altro turno non è quel turno', () => {
    const s = store();
    s.decide(chiedi(s), 'allow', T0);
    expect(s.take({ turnId: 't2', capability: 'sys.shell', resource: 'rm -rf /tmp/x' }, T0)).toBeNull();
  });

  /** Una capability senza risorsa esiste, e `NULL is NULL` deve combaciare. */
  it('una domanda senza risorsa si ritrova senza risorsa', () => {
    const s = store();
    const id = s.ask({ turnId: 't1', capability: 'turn.wait', prompt: 'aspetto?', taint: 0 }, T0);
    s.decide(id, 'allow', T0);
    expect(s.take({ turnId: 't1', capability: 'turn.wait' }, T0)).toBe('allow');
  });
});

/**
 * #742 — una domanda non resta aperta dopo la fine del turno.
 *
 * Il turno può chiudersi mentre una domanda è ancora aperta (la scadenza lo
 * sveglia e il modello prosegue): senza una chiusura terminale la riga resta
 * `decision IS NULL` per sempre, `open` la vede ancora, e un tocco tardivo
 * decide un'approvazione per un turno che non esiste più — il pattern delle
 * tre righe orfane del 2026-09-14.
 */
describe('#742 — la fine del turno ritira le domande aperte', () => {
  it('la chiusura ritira la domanda: `open` la ignora e un tocco tardivo non decide', () => {
    const s = store();
    const id = chiedi(s);

    expect(s.withdrawForTurn('t1', T0)).toBe(1);

    expect(s.open('t1')).toBeNull();
    expect(s.get(id)?.withdrawnAt).not.toBeNull();
    // «Ritirata», non «già risposto»: nessuno ha risposto.
    expect(s.get(id)?.decision).toBeNull();
    expect(s.decide(id, 'allow', T0)).toBe('withdrawn');
  });

  it('ritira solo le domande aperte: una già decisa non si tocca', () => {
    const s = store();
    const id = chiedi(s);
    expect(s.decide(id, 'deny', T0)).toBe('ok');

    expect(s.withdrawForTurn('t1', T0)).toBe(0);

    expect(s.get(id)?.withdrawnAt).toBeNull();
    expect(s.get(id)?.decision).toBe('deny');
  });

  it('un database installato prima della colonna la riceve, senza perdere righe', () => {
    const db = new DatabaseCtor(':memory:');
    // Lo schema esatto di prima, senza `withdrawn_at`.
    db.exec(`CREATE TABLE approvals (
      id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, capability TEXT NOT NULL, resource TEXT,
      prompt TEXT NOT NULL, taint INTEGER NOT NULL CHECK (taint BETWEEN 0 AND 3), asked_at TEXT NOT NULL,
      decision TEXT CHECK (decision IN ('allow','deny')), decided_at TEXT, consumed_at TEXT);`);
    db.prepare(
      `INSERT INTO approvals (id, turn_id, capability, prompt, taint, asked_at) VALUES ('a1', 't1', 'sys.shell', 'p', 0, ?)`,
    ).run(T0.toISOString());

    const s = new ApprovalStore(db);

    expect(s.open('t1')?.id).toBe('a1');
    expect(s.withdrawForTurn('t1', T0)).toBe(1);
    expect(s.open('t1')).toBeNull();
    expect(s.get('a1')?.withdrawnAt).not.toBeNull();
  });
});

/**
 * #745 — la stessa domanda aperta non si duplica.
 *
 * Un re-ask della stessa capability sulla stessa risorsa mentre la prima è
 * ancora aperta è la **stessa** domanda: due righe aperte farebbero divergere
 * la tastiera (che mostra l'ultima) e la barriera di ripresa (che vede la
 * prima) — e la prima, senza pulsanti, resterebbe lì fino alla scadenza.
 */
describe('#745 — un re-ask a domanda aperta riusa la riga', () => {
  it('stessa capability e risorsa: riusa; dopo la decisione ne apre una nuova', () => {
    const s = store();
    const primo = chiedi(s);

    expect(chiedi(s)).toBe(primo);

    expect(s.decide(primo, 'allow', T0)).toBe('ok');
    expect(chiedi(s)).not.toBe(primo);
  });

  it('capability o risorsa diversa restano domande diverse', () => {
    const s = store();
    const primo = chiedi(s);
    expect(chiedi(s, { capability: 'sys.http' })).not.toBe(primo);
    expect(chiedi(s, { resource: 'altro' })).not.toBe(primo);
  });
});
