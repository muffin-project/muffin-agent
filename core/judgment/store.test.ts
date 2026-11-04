import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { JudgmentStore } from './store.js';

/**
 * La coda dei giudizi: una riga per ask, `pending` finché il verdetto o il
 * guasto non arriva, mai riscritta. Il falsificatore del contratto è il
 * guard `WHERE status = 'pending'`: una settle su una riga già chiusa deve
 * muovere zero righe, non «vincere».
 */

const banchi = () => new JudgmentStore(new DatabaseCtor(':memory:'));

const riga = (store: JudgmentStore) =>
  store.record({
    approvalId: 'ap-1',
    turnId: 't-1',
    capability: 'sys.shell.write',
    pack: 'shadow-shell/v1',
    stateHash: 'abc',
    envelope: '{"owner_request":"fai"}',
    provider: 'typesafe',
    requestedModel: 'jev-latest',
    delegationMode: 'manual',
    askedAt: '2026-10-01T10:00:00.000Z',
  });

describe('ask_judgments', () => {
  it('nasce pending e si chiude ok con risposte, modello vero e uso', () => {
    const store = banchi();
    const id = riga(store);
    expect(store.forApproval('ap-1')?.status).toBe('pending');
    expect(store.forApproval('ap-1')?.envelope).toContain('fai');

    expect(
      store.settle(id, {
        status: 'ok',
        model: 'jev-1.13.0',
        answers: '{"description_matches_command":{"kind":"noul","probability":0.9}}',
        inputTokens: 320,
        outputTokens: 30,
        latencyMs: 240,
        settledAt: '2026-10-01T10:00:01.000Z',
      }),
    ).toBe(true);

    const chiusa = store.forApproval('ap-1');
    expect(chiusa?.status).toBe('ok');
    expect(chiusa?.model).toBe('jev-1.13.0');
    expect(chiusa?.answers).toContain('description_matches_command');
    expect(chiusa?.usageInputTokens).toBe(320);
    expect(chiusa?.latencyMs).toBe(240);
    expect(chiusa?.settledAt).not.toBeNull();
  });

  it('un guasto chiude in error con il perché — anche quello è un dato', () => {
    const store = banchi();
    const id = riga(store);
    expect(
      store.settle(id, {
        status: 'timeout',
        detail: 'timeout dopo 10s',
        latencyMs: null,
        settledAt: '2026-10-01T10:00:10.000Z',
      }),
    ).toBe(true);
    const chiusa = store.forApproval('ap-1');
    expect(chiusa?.status).toBe('timeout');
    expect(chiusa?.detail).toContain('timeout');
    expect(chiusa?.answers).toBeNull();
  });

  it('una riga chiusa non si richiude: la storia non si riscrive', () => {
    const store = banchi();
    const id = riga(store);
    store.settle(id, {
      status: 'error',
      detail: 'api giù',
      latencyMs: null,
      settledAt: '2026-10-01T10:00:02.000Z',
    });
    expect(
      store.settle(id, {
        status: 'ok',
        model: 'jev-1.13.0',
        answers: '{}',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 5,
        settledAt: '2026-10-01T10:00:03.000Z',
      }),
    ).toBe(false);
    expect(store.forApproval('ap-1')?.status).toBe('error');
  });

  it('l ultima riga per domanda vince, e il conteggio serve al silenzio', () => {
    const store = banchi();
    store.record({ ...rigaBase, approvalId: 'ap-2' });
    const seconda = store.record({ ...rigaBase, approvalId: 'ap-2' });
    expect(store.forApproval('ap-2')?.id).toBe(seconda);
    expect(store.count()).toBe(2);
    expect(store.forApproval('altra')).toBeNull();
  });
});

const rigaBase = {
  turnId: 't-1',
  capability: 'sys.shell.write',
  pack: 'shadow-shell/v1',
  stateHash: 'abc',
  envelope: '{}',
  provider: 'typesafe',
  requestedModel: 'jev-latest',
  delegationMode: 'manual',
  askedAt: '2026-10-01T10:00:00.000Z',
};
