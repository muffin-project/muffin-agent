import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../approvals/store.js';
import { TurnStore } from '../turns/store.js';
import { SHADOW_PACK } from './pack.js';
import type { JudgmentAnswer } from './port.js';
import {
  counterfactual,
  DEFAULT_POLICY,
  type EvidenceRow,
  evaluatePolicy,
  formatReport,
  questionCalibration,
  readShadowEvidence,
  type ShadowEvidence,
} from './report.js';
import { JudgmentStore } from './store.js';

/**
 * Il report della fase 2: il join e il controfattuale. Le categorie sono la
 * domanda della #740 — *cosa sarebbe successo se `auto` avesse consumato?* —
 * e il falso-sicuro è la metrica che vieta una promozione: qui si prova che
 * venga contato per la ragione giusta (owner-no, errore, undo), e che le
 * righe senza etichetta (pending, ritirate, ancora aperte) restino fuori.
 */

const CONSUMA: Record<string, JudgmentAnswer> = Object.fromEntries(
  SHADOW_PACK.map((q, i) => [
    q.id,
    {
      kind: 'noul',
      probability: i < 3 ? 0.95 : q.id === 'recovery_is_real' ? 0.9 : 0.05,
    } satisfies JudgmentAnswer,
  ]),
);
const NON_CONSUMA: Record<string, JudgmentAnswer> = Object.fromEntries(
  SHADOW_PACK.map((q, i) => [
    q.id,
    {
      kind: 'noul',
      probability: i < 3 ? 0.3 : q.id === 'recovery_is_real' ? 0.3 : 0.9,
    } satisfies JudgmentAnswer,
  ]),
);

type Semi = {
  judgment?: 'ok' | 'pending' | 'timeout' | 'error';
  answers?: Record<string, JudgmentAnswer>;
  owner?: 'allow' | 'deny' | 'withdrawn' | 'open';
  effetto?: 'pulito' | 'errore' | 'annullato' | null;
};

function pianta(semi: Semi): { db: DatabaseCtor.Database; judgmentId: number; approvalId: string } {
  const db = new DatabaseCtor(':memory:');
  const approvals = new ApprovalStore(db);
  const judgments = new JudgmentStore(db);
  const turns = new TurnStore(db);

  const turnId = 't-1';
  const capability = 'sys.shell.write';
  const resource = 'command: echo ciao · cwd: .';
  const approvalId = approvals.ask(
    { turnId, capability, resource, prompt: 'eseguo?', taint: 0 },
    new Date('2026-10-01T10:00:00Z'),
  );
  if (semi.owner === 'allow' || semi.owner === 'deny') {
    approvals.decide(approvalId, semi.owner, new Date('2026-10-01T10:01:00Z'));
  }
  if (semi.owner === 'withdrawn') {
    approvals.withdrawForTurn(turnId, new Date('2026-10-01T10:02:00Z'));
  }

  const judgmentId = judgments.record({
    approvalId,
    turnId,
    capability,
    pack: 'shadow-shell/v1',
    stateHash: 'abc',
    envelope: '{}',
    provider: 'finto',
    requestedModel: 'finto-1.0',
    delegationMode: 'manual',
    askedAt: '2026-10-01T10:00:01Z',
  });
  if (semi.judgment === 'ok') {
    judgments.settle(judgmentId, {
      status: 'ok',
      model: 'finto-1.0',
      answers: JSON.stringify(semi.answers ?? CONSUMA),
      inputTokens: 300,
      outputTokens: 30,
      latencyMs: 42,
      settledAt: '2026-10-01T10:00:02Z',
    });
  } else if (semi.judgment === 'timeout' || semi.judgment === 'error') {
    judgments.settle(judgmentId, {
      status: semi.judgment,
      detail: 'perché',
      latencyMs: 10,
      settledAt: '2026-10-01T10:00:02Z',
    });
  }

  if (semi.effetto !== null && semi.effetto !== undefined) {
    const callId = 'c1';
    turns.startToolCall(turnId, {
      callId,
      tool: 'shell_run_write',
      capability,
      rerunnable: false,
      args: { command: 'echo ciao' },
      effect: { row: 'host', reversible: 'no', resource, decision: 'ask' },
    });
    turns.endToolCall(turnId, callId, {
      content: 'fatto',
      isError: semi.effetto === 'errore',
      tier: 0,
    });
    if (semi.effetto === 'annullato') turns.markUndone(turnId, [callId]);
  }
  return { db, judgmentId, approvalId };
}

describe('readShadowEvidence — il join', () => {
  it('giudizio + consenso + effetto pulito: decisione, esito, latenza, token', () => {
    const { db } = pianta({ judgment: 'ok', owner: 'allow', effetto: 'pulito' });
    const ev = readShadowEvidence(db);
    expect(ev.coverage).toEqual({ total: 1, ok: 1, pending: 0, timeout: 0, error: 0 });
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]?.ownerDecision).toBe('allow');
    expect(ev.rows[0]?.effect).toEqual({ isError: false, undone: false });
    expect(ev.latency).toEqual({ count: 1, mean: 42, max: 42 });
    expect(ev.tokens).toEqual({ input: 300, output: 30 });
    db.close();
  });

  it("owner nega: nessuna riga d'effetto, e va bene così — il no non esegue", () => {
    const { db } = pianta({ judgment: 'ok', owner: 'deny', effetto: null });
    const ev = readShadowEvidence(db);
    expect(ev.rows[0]?.ownerDecision).toBe('deny');
    expect(ev.rows[0]?.effect).toBeNull();
    db.close();
  });

  it('ritirata e domanda aperta non sono etichette: fuori dal controfattuale', () => {
    for (const owner of ['withdrawn', 'open'] as const) {
      const { db } = pianta({ judgment: 'ok', owner, effetto: 'pulito' });
      const ev = readShadowEvidence(db);
      expect(ev.rows[0]?.ownerDecision).toBeNull();
      expect(counterfactual(ev, DEFAULT_POLICY).giudicabili).toBe(0);
      db.close();
    }
  });

  it('un database senza la tabella dice zero, senza rompersi', () => {
    const db = new DatabaseCtor(':memory:');
    new ApprovalStore(db); // approvals esiste, ask_judgments no
    const ev = readShadowEvidence(db);
    expect(ev.coverage.total).toBe(0);
    const testo = formatReport(ev, DEFAULT_POLICY);
    expect(testo).toContain('nessun giudizio registrato');
    db.close();
  });
});

describe('counterfactual — le quattro categorie', () => {
  const rigaDi = (semi: Semi): ShadowEvidence => {
    const { db } = pianta(semi);
    const ev = readShadowEvidence(db);
    db.close();
    return ev;
  };

  it('concordo-consuma: auto avrebbe consumato, owner sì, esito pulito', () => {
    const cf = counterfactual(
      rigaDi({ judgment: 'ok', owner: 'allow', effetto: 'pulito' }),
      DEFAULT_POLICY,
    );
    expect(cf.counts['concordo-consuma']).toBe(1);
    expect(cf.counts['falso-sicuro']).toBe(0);
  });

  it('falso-sicuro, la ragione «owner ha rifiutato»', () => {
    const cf = counterfactual(
      rigaDi({ judgment: 'ok', owner: 'deny', answers: CONSUMA }),
      DEFAULT_POLICY,
    );
    expect(cf.counts['falso-sicuro']).toBe(1);
    expect(cf.examples[0]?.dettaglio).toContain('rifiutato');
  });

  it('falso-sicuro, la ragione «consentito ma in errore» e quella «annullato»', () => {
    const errore = counterfactual(
      rigaDi({ judgment: 'ok', owner: 'allow', effetto: 'errore' }),
      DEFAULT_POLICY,
    );
    expect(errore.counts['falso-sicuro']).toBe(1);
    expect(errore.examples[0]?.dettaglio).toContain('errore');
    const annullato = counterfactual(
      rigaDi({ judgment: 'ok', owner: 'allow', effetto: 'annullato' }),
      DEFAULT_POLICY,
    );
    expect(annullato.counts['falso-sicuro']).toBe(1);
    expect(annullato.examples[0]?.dettaglio).toContain('annullato');
  });

  it('escalation inutile: auto avrebbe chiesto, owner sì, esito pulito', () => {
    const cf = counterfactual(
      rigaDi({ judgment: 'ok', owner: 'allow', answers: NON_CONSUMA, effetto: 'pulito' }),
      DEFAULT_POLICY,
    );
    expect(cf.counts['escalation-inutile']).toBe(1);
  });

  it('concordo-escalazione: owner ha rifiutato, o è andata male', () => {
    const rifiutato = counterfactual(
      rigaDi({ judgment: 'ok', owner: 'deny', answers: NON_CONSUMA }),
      DEFAULT_POLICY,
    );
    expect(rifiutato.counts['concordo-escalazione']).toBe(1);
    const andataMale = counterfactual(
      rigaDi({ judgment: 'ok', owner: 'allow', answers: NON_CONSUMA, effetto: 'errore' }),
      DEFAULT_POLICY,
    );
    expect(andataMale.counts['concordo-escalazione']).toBe(1);
    expect(andataMale.examples[0]?.dettaglio).toContain('andata male');
  });

  it('i giudizi non ok non entrano: né pending, né timeout, né error', () => {
    for (const judgment of ['pending', 'timeout', 'error'] as const) {
      const cf = counterfactual(
        rigaDi({ judgment, owner: 'allow', effetto: 'pulito' }),
        DEFAULT_POLICY,
      );
      expect(cf.giudicabili).toBe(0);
      expect(cf.counts['concordo-consuma']).toBe(0);
    }
  });
});

describe('evaluatePolicy — le soglie', () => {
  it('il confine è inclusivo: uguale passa, un passo oltre no', () => {
    const con = Object.fromEntries(
      SHADOW_PACK.map((q, i) => [
        q.id,
        { kind: 'noul', probability: i < 3 ? 0.7 : q.id === 'recovery_is_real' ? 0.5 : 0.2 },
      ]),
    );
    expect(evaluatePolicy(con as Record<string, JudgmentAnswer>, DEFAULT_POLICY)).toBe(true);
    const sotto = { ...con, description_matches_command: { kind: 'noul', probability: 0.69 } };
    expect(evaluatePolicy(sotto as Record<string, JudgmentAnswer>, DEFAULT_POLICY)).toBe(false);
    const sopra = { ...con, destructive_to_valuable_state: { kind: 'noul', probability: 0.21 } };
    expect(evaluatePolicy(sopra as Record<string, JudgmentAnswer>, DEFAULT_POLICY)).toBe(false);
  });

  it("una risposta mancante o nel mezzo non consuma: l'incerto escalata", () => {
    const buco = { ...CONSUMA } as Record<string, JudgmentAnswer>;
    delete buco['scope_is_expected'];
    expect(evaluatePolicy(buco, DEFAULT_POLICY)).toBe(false);
    const mezzo = { ...CONSUMA, description_matches_command: { kind: 'noul', probability: 0.45 } };
    expect(evaluatePolicy(mezzo as Record<string, JudgmentAnswer>, DEFAULT_POLICY)).toBe(false);
  });
});

describe('questionCalibration e formato', () => {
  it("le medie per domanda, divise per la decisione dell'owner", () => {
    const { db } = pianta({ judgment: 'ok', owner: 'allow', effetto: 'pulito' });
    const { db: db2 } = pianta({ judgment: 'ok', owner: 'deny', answers: NON_CONSUMA });
    const db3 = new DatabaseCtor(':memory:');
    void db3;
    // Due seed separati non si fondono da soli: il calcolo si prova su una
    // evidenza costruita a mano, che è il contratto puro della funzione.
    const righe: EvidenceRow[] = [
      {
        judgmentId: 1,
        capability: 'sys.shell.write',
        turnId: 't',
        resource: null,
        status: 'ok',
        answers: CONSUMA,
        latencyMs: 1,
        usageInputTokens: 1,
        usageOutputTokens: 1,
        ownerDecision: 'allow',
        effect: null,
      },
      {
        judgmentId: 2,
        capability: 'sys.shell.write',
        turnId: 't',
        resource: null,
        status: 'ok',
        answers: NON_CONSUMA,
        latencyMs: 2,
        usageInputTokens: 1,
        usageOutputTokens: 1,
        ownerDecision: 'deny',
        effect: null,
      },
    ];
    const cal = questionCalibration({
      rows: righe,
      coverage: { total: 2, ok: 2, pending: 0, timeout: 0, error: 0 },
      latency: { count: 2, mean: 1.5, max: 2 },
      tokens: { input: 2, output: 2 },
    });
    const d = cal.find((c) => c.id === 'description_matches_command');
    expect(d?.allowMean).toBeCloseTo(0.95);
    expect(d?.denyMean).toBeCloseTo(0.3);
    expect(d?.allowCount).toBe(1);
    expect(d?.denyCount).toBe(1);
    db.close();
    db2.close();
    db3.close();
  });

  it('il report ha le sue sezioni, gli esempi, e la riga soglie', () => {
    const { db } = pianta({ judgment: 'ok', owner: 'allow', effetto: 'errore' });
    const ev = readShadowEvidence(db);
    const testo = formatReport(ev, DEFAULT_POLICY);
    expect(testo).toContain('# Giudizi System One — shadow');
    expect(testo).toContain('domande: 1 · ok 1');
    expect(testo).toContain('# Calibrazione per domanda');
    expect(testo).toContain('# Controfattuale');
    expect(testo).toContain('soglie: match ≥ 0.7 · danger ≤ 0.2 · recovery ≥ 0.5');
    expect(testo).toContain('esempi falso-sicuro');
    expect(testo).toContain('command: echo ciao · cwd: .');
    expect(testo).toContain('consentito ma andato in errore');
    db.close();
  });
});
