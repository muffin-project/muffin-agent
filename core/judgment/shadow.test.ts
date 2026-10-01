import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { JsonlExporter, SimpleTracer } from '../tracing/tracer.js';
import type { AskFacts } from './envelope.js';
import { SHADOW_PACK, SHADOW_PACK_CAPABILITIES, SHADOW_PACK_VERSION } from './pack.js';
import type { JudgmentAnswer, JudgmentQuestion, SystemOneVerdict } from './port.js';
import { makeShadowJudge } from './shadow.js';
import { JudgmentStore } from './store.js';

/**
 * Il runtime shadow: la riga parte pending anche quando il giudizio è
 * istantaneo (il crash a metà si deve *vedere*), si chiude col verdetto o
 * col guasto, e `shadow()` non trattiene il chiamante — la proprietà che
 * l'ask non deve mai aspettare il sensore.
 */

const fatti: AskFacts = {
  intent: 'esegui echo ciao',
  capability: 'sys.shell.write',
  effectRow: 'host',
  risk: 'high',
  reversible: 'no',
  rerunnable: false,
  resource: 'command: echo ciao · cwd: .',
  description: 'stampa la parola ciao',
  taint: 0,
  taintOrigin: null,
  principal: 'owner',
  tenant: 'host',
  delegationMode: 'manual',
  askPrompt: 'non si torna indietro',
};

const verdetto = (probability: number): SystemOneVerdict => ({
  provider: 'finto',
  model: 'finto-1.0',
  answers: Object.fromEntries(
    SHADOW_PACK.map((q) => [q.id, { kind: 'noul', probability } as JudgmentAnswer]),
  ),
  usage: { inputTokens: 300, outputTokens: 30 },
  latencyMs: 12,
});

const porta = (esito: () => Promise<SystemOneVerdict>) => ({
  provider: 'finto',
  model: 'finto-1.0',
  judge: (_input: { state: object; questions: readonly JudgmentQuestion[] }) => esito(),
});

const attesa = async (condizione: () => boolean, ms = 2000): Promise<void> => {
  const scadenza = Date.now() + ms;
  while (!condizione()) {
    if (Date.now() > scadenza) throw new Error('attesa scaduta');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function ambiente(esito: () => Promise<SystemOneVerdict>) {
  const db = new DatabaseCtor(':memory:');
  const store = new JudgmentStore(db);
  const log: string[] = [];
  const judge = makeShadowJudge({
    port: porta(esito),
    store,
    tracer: new SimpleTracer(new JsonlExporter(mkdtempSync(join(tmpdir(), 'muffin-shadow-')))),
    now: () => new Date('2026-10-01T10:00:00Z'),
    log: (riga) => log.push(riga),
  });
  return { db, store, judge, log };
}

describe('makeShadowJudge', () => {
  it('shadow non trattiene: la riga parte e il verdetto la chiude dopo', async () => {
    const { store, judge } = ambiente(async () => verdetto(0.9));
    const prima = Date.now();
    judge.shadow(fatti, { approvalId: 'ap-9', turnId: 't-9' });
    expect(Date.now() - prima).toBeLessThan(50);

    await attesa(() => store.forApproval('ap-9')?.status === 'ok');
    const riga = store.forApproval('ap-9');
    expect(riga?.pack).toBe(SHADOW_PACK_VERSION);
    expect(riga?.provider).toBe('finto');
    expect(riga?.delegationMode).toBe('manual');
    const risposte = JSON.parse(riga?.answers ?? '{}') as Record<string, JudgmentAnswer>;
    expect(risposte.description_matches_command).toEqual({ kind: 'noul', probability: 0.9 });
    // L'envelope persiste: la calibrazione potrà rigiocarlo.
    expect(riga?.envelope).toContain('echo ciao');
  });

  it('un provider che fallisce chiude la riga in error e lo dice nel log', async () => {
    const { store, judge, log } = ambiente(async () => {
      throw new Error('provider giù');
    });
    judge.shadow(fatti, { approvalId: 'ap-10', turnId: 't-10' });
    await attesa(() => store.forApproval('ap-10')?.status === 'error');
    expect(store.forApproval('ap-10')?.detail).toContain('provider giù');
    expect(log.some((l) => l.includes('fallito'))).toBe(true);
  });

  it('solo le capability del pacchetto partono: le altre non generano riga', () => {
    const { store, judge } = ambiente(async () => verdetto(0.5));
    expect(judge.capabilities.has('sys.shell.write')).toBe(true);
    expect(SHADOW_PACK_CAPABILITIES).toContain('sys.shell');
    expect(judge.capabilities.has('fs.write')).toBe(false);
    // Il filtro vero sta nel chiamante (tool-call); qui il contratto del set.
    expect(store.count()).toBe(0);
  });

  it('drain aspetta i giudizi in volo', async () => {
    let libera: (() => void) | null = null;
    const { store, judge } = ambiente(
      () =>
        new Promise<SystemOneVerdict>((resolve) => {
          libera = () => resolve(verdetto(0.7));
        }),
    );
    judge.shadow(fatti, { approvalId: 'ap-11', turnId: 't-11' });
    expect(store.forApproval('ap-11')?.status).toBe('pending');
    setTimeout(() => libera?.(), 30);
    await judge.drain();
    expect(store.forApproval('ap-11')?.status).toBe('ok');
  });

  it('un sync throw dentro shadow resta nel log e non esce', () => {
    const db = new DatabaseCtor(':memory:');
    // Uno store chiuso: record() throws sync — il sensore muore, l'ask no.
    const store = new JudgmentStore(db);
    db.close();
    const log: string[] = [];
    const judge = makeShadowJudge({
      port: porta(async () => verdetto(0.5)),
      store,
      tracer: new SimpleTracer(new JsonlExporter(mkdtempSync(join(tmpdir(), 'muffin-shadow-')))),
      log: (riga) => log.push(riga),
    });
    expect(() => judge.shadow(fatti, { approvalId: 'x', turnId: 'y' })).not.toThrow();
    expect(log.some((l) => l.includes('non partito'))).toBe(true);
  });
});
