import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseCtor from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStore } from '../core/approvals/store.js';
import { SHADOW_PACK } from '../core/judgment/pack.js';
import type { JudgmentAnswer } from '../core/judgment/port.js';
import { JudgmentStore } from '../core/judgment/store.js';
import { redactText } from '../core/tracing/redact.js';
import { TurnStore } from '../core/turns/store.js';
import { runInit } from './init.js';
import { cmdJudgments } from './judgments.js';

/**
 * `muffin judgments report` — la porta da operatore sulla calibrazione.
 *
 * Come `cli/effects.test.ts`: si prova ciò che il comando in sé può rompere
 * — l'argomento sbagliato che esce con un codice invece che con uno stack,
 * il `--db` che non c'è, e il report che legge davvero le righe di **quel**
 * database. La logica del controfattuale sta in `core/judgment/report.test.ts`.
 */

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muffin-judgments-cli-'));
  dirs.push(dir);
  runInit({ home: dir, apiKey: 'sk-never-called' });
  return dir;
}

/** Come `cli/effects.test.ts`: la home entra nell'ambiente e ne esce, per prova. */
function conHome(dir: string, corpo: () => void): void {
  const prima = process.env['MUFFIN_HOME'];
  process.env['MUFFIN_HOME'] = dir;
  try {
    corpo();
  } finally {
    if (prima === undefined) delete process.env['MUFFIN_HOME'];
    else process.env['MUFFIN_HOME'] = prima;
  }
}

const CONSUMA: Record<string, JudgmentAnswer> = Object.fromEntries(
  SHADOW_PACK.map((q, i) => [
    q.id,
    { kind: 'noul', probability: i < 3 ? 0.95 : q.id === 'recovery_is_real' ? 0.9 : 0.05 },
  ]),
);

function semina(file: string): void {
  const db = new DatabaseCtor(file);
  const approvals = new ApprovalStore(db);
  const judgments = new JudgmentStore(db);
  const turns = new TurnStore(db);
  const turnId = 't-1';
  // Come produzione: la domanda porta il riassunto **grezzo**, la riga
  // d'effetto lo stesso riassunto **redatto** — con un token dentro, le due
  // stringhe sono diverse, e il join deve passare per la seconda forma.
  const resource =
    'command: curl -s -H "Authorization: Bearer segretonellacomando" https://api.esempio.it/dati · cwd: .';
  const approvalId = approvals.ask(
    { turnId, capability: 'sys.shell.write', resource, prompt: 'eseguo?', taint: 0 },
    new Date(),
  );
  approvals.decide(approvalId, 'allow', new Date());
  const id = judgments.record({
    approvalId,
    turnId,
    capability: 'sys.shell.write',
    pack: 'shadow-shell/v1',
    stateHash: 'abc',
    envelope: '{}',
    provider: 'typesafe',
    requestedModel: 'jev-latest',
    delegationMode: 'manual',
    askedAt: new Date().toISOString(),
  });
  judgments.settle(id, {
    status: 'ok',
    model: 'jev-1.13.0',
    answers: JSON.stringify(CONSUMA),
    inputTokens: 300,
    outputTokens: 30,
    latencyMs: 12,
    settledAt: new Date().toISOString(),
  });
  turns.startToolCall(turnId, {
    callId: 'c1',
    tool: 'shell_run_write',
    capability: 'sys.shell.write',
    rerunnable: false,
    args: { command: 'curl' },
    effect: {
      row: 'host',
      reversible: 'no',
      resource: redactText(resource).slice(0, 300),
      decision: 'ask',
    },
  });
  turns.endToolCall(turnId, 'c1', { content: 'ok', isError: false, tier: 0 });
  db.close();
}

function cattura(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  return { out, err };
}

describe('muffin judgments report', () => {
  it('senza sottocomando dice usage ed esce 78, non con uno stack', () => {
    const dir = home();
    conHome(dir, () => {
      const { err } = cattura();
      expect(cmdJudgments([])).toBe(78);
      expect(err.join('')).toContain('usage: muffin judgments <report>');
    });
  });

  it('soglia fuori range: frase e 78', () => {
    const dir = home();
    conHome(dir, () => {
      const { err } = cattura();
      expect(cmdJudgments(['report', '--match-above', '7'])).toBe(78);
      expect(err.join('')).toContain('fra 0 e 1');
    });
  });

  it('database inesistente: frase e 78', () => {
    const dir = home();
    conHome(dir, () => {
      const { err } = cattura();
      expect(cmdJudgments(['report', '--db', join(dir, 'non-ce.db')])).toBe(78);
      expect(err.join('')).toContain('nessun database');
    });
  });

  it('il report legge le righe di quel database e conta il concordo-consuma', () => {
    const dir = home();
    semina(join(dir, 'muffin.db'));
    conHome(dir, () => {
      const { out } = cattura();
      expect(cmdJudgments(['report'])).toBe(0);
      const testo = out.join('');
      expect(testo).toContain('domande: 1 · ok 1');
      expect(testo).toContain('concordo-consuma (auto consuma: owner sì, esito pulito)      1');
      expect(testo).toContain('falso-sicuro (auto consuma: owner no, o andata male)         0');
      // Se il join dell'effetto manca, questa riga vale 1: è l'asserzione
      // che il join ha davvero trovato la riga, non che il buco sia verde.
      expect(testo).toContain("senza esito visibile (consentito, nessuna riga d'effetto)    0");
      expect(testo).toContain('description_matches_command    allow 0.95 (1)');
    });
  });

  it('le soglie passate valgono per il report soltanto, e il controfattuale cambia', () => {
    const dir = home();
    semina(join(dir, 'muffin.db'));
    conHome(dir, () => {
      const { out } = cattura();
      expect(
        cmdJudgments([
          'report',
          '--danger-below',
          '0',
          '--recovery-above',
          '0',
          '--match-above',
          '0',
        ]),
      ).toBe(0);
      expect(out.join('')).toContain('soglie: match ≥ 0 · danger ≤ 0 · recovery ≥ 0');
    });
  });

  it('su un database senza giudizi: nessun giudizio, exit 0', () => {
    const dir = home();
    // Il db dell'init esiste ma non ha mai girato un giudizio.
    const db = new DatabaseCtor(join(dir, 'muffin.db'));
    db.close();
    conHome(dir, () => {
      const { out } = cattura();
      expect(cmdJudgments(['report'])).toBe(0);
      expect(out.join('')).toContain('nessun giudizio registrato');
    });
  });
});
