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
