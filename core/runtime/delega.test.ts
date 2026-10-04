import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../approvals/store.js';
import { JobStore } from '../scheduler/jobs.js';
import type { NewTurn } from '../turns/store.js';
import { TurnStore } from '../turns/store.js';
import type { Principal } from '../policy/types.js';
import { Delega, levaDelega } from './delega.js';

/**
 * La delega dell'owner (issue #740): lo store della postura e la leva dei comandi.
 *
 * Lo store dice quale modalità vale per un lavoro; la leva risolve *quale*
 * lavoro — l'ultimo attivo di questa conversazione — e su `/yolo` decide le
 * domande aperte e risveglia la riga, come il dito sul pulsante.
 */

const owner: Principal = { kind: 'owner', connector: 'telegram', externalId: '4242' };

const riga = (over: Partial<NewTurn> = {}): NewTurn => ({
  id: 'turn-1',
  principal: owner,
  tenant: 'host',
  surface: 'telegram',
  sessionId: 'telegram:4242',
  model: 'm',
  messages: [],
  taint: 0,
  counters: {
    iterations: 0,
    recoveriesUsed: 0,
    transportRetriesLeft: 2,
    truncationsUsed: 0,
    toolCallsMade: 0,
    nudgedForCompletion: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    spentUsd: 0,
    resumes: 0,
    contextBuilt: false,
  },
  ...over,
});

function banchi() {
  const db = new DatabaseCtor(':memory:');
  return { db, delega: new Delega(db), approvals: new ApprovalStore(db), turns: new TurnStore(db) };
}

describe('Delega: la modalità è del lavoro', () => {
  it('assente è manual: il verso che chiede, non quello che esegue', () => {
    const { delega } = banchi();
    expect(delega.modo('mai-visto')).toBe('manual');
    expect(delega.da('mai-visto')).toBeNull();
  });

  it('l ultima scrittura vince, e la storia resta', () => {
    const { db, delega } = banchi();
    delega.metti('t1', 'yolo', 'owner', new Date('2026-10-01T10:00:00Z'));
    delega.metti('t1', 'manual', 'owner', new Date('2026-10-01T10:05:00Z'));
    expect(delega.modo('t1')).toBe('manual');
    expect(delega.da('t1')).toBe('2026-10-01T10:05:00.000Z');
    const righe = db.prepare(`SELECT mode FROM delegation_modes WHERE turn_id = ? ORDER BY id`).all('t1') as {
      mode: string;
    }[];
    expect(righe.map((r) => r.mode)).toEqual(['yolo', 'manual']);
  });

  it('un lavoro non legge la delega di un altro', () => {
    const { delega } = banchi();
    delega.metti('t1', 'yolo', 'owner', new Date());
    expect(delega.modo('t2')).toBe('manual');
  });
});

describe('latestActiveOfSession: il lavoro a cui legarsi', () => {
  it('trova quello vivo e ignora quello finito', () => {
    const { turns } = banchi();
    turns.create(riga({ id: 'vecchio', sessionId: 's' }));
    turns.finish('vecchio', { outcome: 'answered', messages: [], taint: 0, counters: riga().counters }, turns.get('vecchio')!.claimToken);
    expect(turns.latestActiveOfSession('s')).toBeNull();
    turns.enqueue(riga({ id: 'nuovo', sessionId: 's' }));
    expect(turns.latestActiveOfSession('s')?.id).toBe('nuovo');
  });

  it('fra due attivi vince l ultimo creato', () => {
    const { turns } = banchi();
    turns.enqueue(riga({ id: 'primo', sessionId: 's' }));
    turns.enqueue(riga({ id: 'secondo', sessionId: 's' }));
    expect(turns.latestActiveOfSession('s')?.id).toBe('secondo');
  });

  it('non attraversa le sessioni', () => {
    const { turns } = banchi();
    turns.enqueue(riga({ id: 't1', sessionId: 'altra' }));
    expect(turns.latestActiveOfSession('s')).toBeNull();
  });
});

describe('levaDelega: i comandi si legano al lavoro in flight', () => {
  function leva(b: ReturnType<typeof banchi>, sessione: string, spinta?: { volte: number }) {
    return levaDelega({
      delega: b.delega,
      approvals: b.approvals,
      turns: b.turns,
      sessionId: () => sessione,
      ...(spinta === undefined ? {} : { onWork: () => { spinta.volte += 1; } }),
    });
  }

  it('senza lavoro attivo dice null — mai una delega al vento', () => {
    const b = banchi();
    expect(leva(b, 'telegram:4242').metti('yolo')).toBeNull();
    expect(leva(b, 'telegram:4242').modo()).toBe('manual');
  });

  it('un lavoro done non è delegabile', () => {
    const b = banchi();
    b.turns.create(riga({ id: 't1', sessionId: 's' }));
    b.turns.finish('t1', { outcome: 'answered', messages: [], taint: 0, counters: riga().counters }, b.turns.get('t1')!.claimToken);
    expect(leva(b, 's').metti('yolo')).toBeNull();
  });

  it('/yolo decide le domande aperte, risveglia e spinge la corsia', () => {
    const b = banchi();
    b.turns.create(riga({ id: 't1', sessionId: 's' }));
    // Domanda aperta e riga sospesa, come dopo un ask su Telegram.
    const id = b.approvals.ask({ turnId: 't1', capability: 'probe.act', resource: 'rm -rf /tmp/x', prompt: 'eseguo?', taint: 0 }, new Date());
    // Sospensione manuale della riga: basta lo stato waiting.
    b.db.prepare(`UPDATE turns SET status = 'waiting', wait_for = 'approval:' || ? WHERE id = 't1'`).run(id);
    const spinta = { volte: 0 };

    const esito = leva(b, 's', spinta).metti('yolo');
    expect(esito).toEqual({ turnId: 't1', cambiato: true, risposteDate: 1 });
    expect(b.approvals.get(id)?.decision).toBe('allow');
    expect(b.approvals.get(id)?.decidedBy).toBe('delegation');
    expect(b.turns.get('t1')?.status).toBe('runnable');
    expect(spinta.volte).toBe(1);
    expect(b.delega.modo('t1')).toBe('yolo');
  });

  it('la risposta dell owner vince sulla delega: decide una volta sola', () => {
    const b = banchi();
    b.turns.create(riga({ id: 't1', sessionId: 's' }));
    const id = b.approvals.ask({ turnId: 't1', capability: 'probe.act', prompt: 'eseguo?', taint: 0 }, new Date());
    expect(b.approvals.decide(id, 'deny', new Date())).toBe('ok');
    b.db.prepare(`UPDATE turns SET status = 'waiting', wait_for = 'approval:' || ? WHERE id = 't1'`).run(id);

    const esito = leva(b, 's').metti('yolo');
    // Niente deciso per delega: c'era già la risposta dell'owner.
    expect(esito).toEqual({ turnId: 't1', cambiato: true, risposteDate: 0 });
    expect(b.approvals.get(id)?.decision).toBe('deny');
    expect(b.approvals.get(id)?.decidedBy).toBe('owner');
  });

  it('/manual e /auto non decidono e non risvegliano', () => {
    for (const [modo, cambiato] of [['manual', false], ['auto', true]] as const) {
      const b = banchi();
      b.turns.create(riga({ id: 't1', sessionId: 's' }));
      const id = b.approvals.ask({ turnId: 't1', capability: 'probe.act', prompt: 'eseguo?', taint: 0 }, new Date());
      b.db.prepare(`UPDATE turns SET status = 'waiting', wait_for = 'approval:' || ? WHERE id = 't1'`).run(id);

      const esito = leva(b, 's').metti(modo);
      expect(esito).toEqual({ turnId: 't1', cambiato, risposteDate: 0 });
      expect(b.approvals.get(id)?.decision).toBeNull();
      expect(b.turns.get('t1')?.status).toBe('waiting');
      expect(b.delega.modo('t1')).toBe(modo);
    }
  });

  it('un comando ridetto non riscrive la storia', () => {
    const b = banchi();
    b.turns.create(riga({ id: 't1', sessionId: 's' }));
    const l = leva(b, 's');
    expect(l.metti('yolo')).toEqual({ turnId: 't1', cambiato: true, risposteDate: 0 });
    expect(l.metti('yolo')).toEqual({ turnId: 't1', cambiato: false, risposteDate: 0 });
    const righe = b.db.prepare(`SELECT count(*) AS n FROM delegation_modes WHERE turn_id = 't1'`).get() as { n: number };
    expect(righe.n).toBe(1);
  });

  it('modo legge la postura del lavoro attivo', () => {
    const b = banchi();
    b.turns.create(riga({ id: 't1', sessionId: 's' }));
    const l = leva(b, 's');
    expect(l.modo()).toBe('manual');
    l.metti('yolo');
    expect(l.modo()).toBe('yolo');
  });
});

describe('approvals: chi ha deciso resta scritto', () => {
  it('il default è owner; la delega si nomina', () => {
    const { approvals } = banchi();
    const a = approvals.ask({ turnId: 't', capability: 'c', prompt: 'p', taint: 0 }, new Date());
    expect(approvals.decide(a, 'allow', new Date())).toBe('ok');
    expect(approvals.get(a)?.decidedBy).toBe('owner');
    const d = approvals.ask({ turnId: 't', capability: 'c2', prompt: 'p', taint: 0 }, new Date());
    expect(approvals.decide(d, 'allow', new Date(), 'delegation')).toBe('ok');
    expect(approvals.get(d)?.decidedBy).toBe('delegation');
  });

  it('openRows elenca tutte le aperte, dalla più vecchia', () => {
    const { approvals } = banchi();
    const a = approvals.ask({ turnId: 't', capability: 'c', resource: 'x', prompt: 'p', taint: 0 }, new Date());
    const c = approvals.ask({ turnId: 't', capability: 'c', resource: 'y', prompt: 'p', taint: 0 }, new Date());
    expect(approvals.openRows('t').map((r) => r.id)).toEqual([a, c]);
    expect(approvals.openRows('altro')).toEqual([]);
  });

  it('righe decise prima della colonna leggono owner', () => {
    const { db, approvals } = banchi();
    const a = approvals.ask({ turnId: 't', capability: 'c', prompt: 'p', taint: 0 }, new Date());
    db.prepare(`UPDATE approvals SET decided_by = NULL, decision = 'allow', decided_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      a,
    );
    expect(approvals.get(a)?.decidedBy).toBe('owner');
  });
});

describe('Delega carry sul fire futuro (#598 S3)', () => {
  it('un fire senza riga propria eredita la postura del job', () => {
    const db = new DatabaseCtor(':memory:');
    try {
      const delega = new Delega(db);
      const turns = new TurnStore(db);
      const jobs = new JobStore(db, () => new Date('2026-06-15T05:00:00Z'));

      const yolo = jobs.addOnce({ timezone: 'Europe/Rome', channel: 'cli', goal: 'una sola', delegation: 'yolo' });
      const manuale = jobs.addOnce({ timezone: 'Europe/Rome', channel: 'cli', goal: 'una sola' });
      const auto = jobs.addOnce({ timezone: 'Europe/Rome', channel: 'cli', goal: 'una sola', delegation: 'auto' });

      turns.create(riga({ id: 'fire-yolo', sessionId: 'job-sess', jobId: yolo.id }));
      turns.create(riga({ id: 'fire-manuale', sessionId: 'job-sess', jobId: manuale.id }));
      turns.create(riga({ id: 'fire-auto', sessionId: 'job-sess', jobId: auto.id }));
      turns.create(riga({ id: 'senza-job', sessionId: 'job-sess' }));

      expect(delega.modo('fire-yolo')).toBe('yolo');
      expect(delega.modo('fire-manuale')).toBe('manual');
      expect(delega.modo('fire-auto')).toBe('auto');
      expect(delega.modo('senza-job')).toBe('manual');
      expect(delega.modo('mai-visto')).toBe('manual');
    } finally {
      db.close();
    }
  });

  it('una riga esplicita sul turno vince sul job: /manual revoca un fire yolo', () => {
    const db = new DatabaseCtor(':memory:');
    try {
      const delega = new Delega(db);
      const turns = new TurnStore(db);
      const jobs = new JobStore(db, () => new Date('2026-06-15T05:00:00Z'));
      const job = jobs.addOnce({ timezone: 'Europe/Rome', channel: 'cli', goal: 'una sola', delegation: 'yolo' });
      turns.create(riga({ id: 'fire', sessionId: 'job-sess', jobId: job.id }));
      expect(delega.modo('fire')).toBe('yolo');
      delega.metti('fire', 'manual', 'owner', new Date());
      expect(delega.modo('fire')).toBe('manual');
    } finally {
      db.close();
    }
  });

  it('la delega non trapela a un altro lavoro con un altro job', () => {
    const db = new DatabaseCtor(':memory:');
    try {
      const delega = new Delega(db);
      const turns = new TurnStore(db);
      const jobs = new JobStore(db, () => new Date('2026-06-15T05:00:00Z'));
      const yolo = jobs.addOnce({ timezone: 'Europe/Rome', channel: 'cli', goal: 'una sola', delegation: 'yolo' });
      const manuale = jobs.addOnce({ timezone: 'Europe/Rome', channel: 'cli', goal: 'un altra' });
      turns.create(riga({ id: 'fire-yolo', sessionId: 'job-sess', jobId: yolo.id }));
      turns.create(riga({ id: 'fire-manuale', sessionId: 'job-sess', jobId: manuale.id }));
      expect(delega.modo('fire-manuale')).toBe('manual');
      expect(delega.modo('fire-yolo')).toBe('yolo');
    } finally {
      db.close();
    }
  });
});

