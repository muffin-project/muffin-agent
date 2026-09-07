import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { formatEffects, localDay, readEffects } from './effects.js';
import { type NewTurn, TurnStore } from './store.js';

/**
 * Il registro degli effetti letto dalla stessa scrittura che lo produce.
 *
 * Scritto con `TurnStore.startToolCall` e non con `INSERT` a mano, per la
 * ragione che `orientamento-report.test.ts` si è già data: un test che scrive
 * le righe da sé prova la propria SQL, non il percorso di produzione, e
 * resterebbe verde il giorno che il loop smette di riempire quelle colonne.
 * Il fatto che il *loop* le riempia davvero è una domanda ancora diversa, ed è
 * quella che `evals/acceptance/scenarios/d15-effetti.accept.ts` fa sul binario
 * vero.
 */
function store(at?: string): { s: TurnStore; db: DatabaseCtor.Database } {
  const db = new DatabaseCtor(':memory:');
  // L'orologio iniettato, dove il momento della chiamata è ciò che il test
  // asserisce: `started_at` lo scrive `TurnStore.clock`, non `NewTurn.createdAt`.
  return { s: new TurnStore(db, at === undefined ? undefined : () => new Date(at)), db };
}

function spec(id: string): NewTurn {
  return {
    id,
    principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
    tenant: 'host',
    surface: 'cli',
    sessionId: 's1',
    model: 'm',
    messages: [],
    taint: 0,
    counters: {
      iterations: 0,
      recoveriesUsed: 0,
      transportRetriesLeft: 2,
      toolCallsMade: 0,
      nudgedForCompletion: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      spentUsd: 0,
      resumes: 0,
      contextBuilt: false,
    },
  };
}

describe('il registro degli effetti', () => {
  it('per turno: capability, risorsa, riga della matrice e chi ha autorizzato', () => {
    const { s, db } = store();
    s.create(spec('t1'));
    s.startToolCall('t1', {
      callId: 'c1',
      tool: 'fs_write',
      capability: 'fs.write',
      rerunnable: true,
      args: { path: 'nota.md' },
      effect: { row: 'host', reversible: 'undoable', resource: '/ws/nota.md', decision: 'draft' },
    });
    s.endToolCall('t1', 'c1', { content: 'scritto', isError: false, tier: 0 });

    const r = s.effects({ turnId: 't1' });
    expect(r.calls).toHaveLength(1);
    const [c] = r.calls;
    // I quattro campi che il criterio D15 punto 2 nomina, uno per uno: una
    // asserzione sull'oggetto intero passerebbe anche se uno di loro tornasse
    // `undefined` per un errore di alias nella SELECT.
    expect(c?.capability).toBe('fs.write');
    expect(c?.resource).toBe('/ws/nota.md');
    expect(c?.reversible).toBe('undoable');
    expect(c?.row).toBe('host');
    expect(c?.decision).toBe('draft');
    // `draft` esegue senza chiedere niente a nessuno: sta fra ciò che è
    // passato senza domanda, ed è precisamente il caso che D15 rende visibile.
    expect(r.senzaDomanda).toBe(1);
    expect(r.conDomanda).toBe(0);
    db.close();
  });

  it('separa ciò che è passato senza domanda da ciò che è stato chiesto', () => {
    const { s, db } = store();
    s.create(spec('t1'));
    s.startToolCall('t1', {
      callId: 'c1',
      tool: 'shell_run',
      capability: 'sys.shell',
      rerunnable: true,
      args: {},
      effect: { row: 'host', reversible: 'yes', resource: null, decision: 'allow' },
    });
    s.startToolCall('t1', {
      callId: 'c2',
      tool: 'shell_run_write',
      capability: 'sys.shell.write',
      rerunnable: false,
      args: {},
      effect: { row: 'host', reversible: 'no', resource: null, decision: 'ask' },
    });

    const r = s.effects({ turnId: 't1' });
    expect(r.senzaDomanda).toBe(1);
    expect(r.conDomanda).toBe(1);
    expect(formatEffects(r)).toContain('senza chiedere');
    expect(formatEffects(r)).toContain('dopo averlo chiesto');
    db.close();
  });

  it('per giornata: la mezzanotte è quella locale, non quella di Greenwich', () => {
    const { s, db } = store('2026-09-06T23:30:00.000Z');
    s.create(spec('t1'));
    // 23:30 UTC del 6 settembre è già l'1:30 del 7 a Roma (UTC+2). Una lettura
    // che tagliasse la giornata sull'UTC non troverebbe questa riga chiedendo
    // «cosa hai fatto oggi» il 7 — il guasto che `dayBounds` esiste per non
    // avere, e che una fixture tutta a mezzogiorno non vedrebbe mai.
    s.startToolCall('t1', {
      callId: 'c1',
      tool: 'fs_write',
      capability: 'fs.write',
      rerunnable: true,
      args: {},
      effect: { row: 'host', reversible: 'undoable', resource: '/ws/a', decision: 'allow' },
    });

    // -120 = `getTimezoneOffset()` a Roma d'estate.
    expect(readEffects(db, { day: '2026-09-07', tzOffsetMinutes: -120 }).calls).toHaveLength(1);
    expect(readEffects(db, { day: '2026-09-06', tzOffsetMinutes: -120 }).calls).toHaveLength(0);
    // E in UTC la stessa riga appartiene al giorno prima: le due letture
    // devono disagreere, o l'offset non sta facendo niente.
    expect(readEffects(db, { day: '2026-09-06', tzOffsetMinutes: 0 }).calls).toHaveLength(1);
    db.close();
  });

  it('una riga scritta prima del registro si dichiara, invece di fingere una classe', () => {
    const { s, db } = store();
    s.create(spec('t1'));
    s.startToolCall('t1', {
      callId: 'c1',
      tool: 'fs_read',
      capability: 'fs.read',
      rerunnable: true,
      args: {},
      effect: { row: 'host', reversible: 'yes', resource: '/ws/a', decision: 'allow' },
    });
    // Il database di ieri: le colonne esistono (ensureColumn le ha aggiunte)
    // ma la riga è stata scritta quando nessuno le riempiva.
    db.prepare(
      `UPDATE turn_tool_calls SET effect_row = NULL, reversible = NULL, decision = NULL`,
    ).run();

    const r = s.effects({ turnId: 't1' });
    expect(r.nonRegistrate).toBe(1);
    expect(r.senzaDomanda).toBe(0);
    const testo = formatEffects(r);
    expect(testo).toContain('riga non registrata');
    expect(testo).toContain('prima che il registro degli effetti esistesse');
    db.close();
  });

  it('un valore che non è una classe conosciuta non diventa una classe conosciuta', () => {
    const { s, db } = store();
    s.create(spec('t1'));
    s.startToolCall('t1', {
      callId: 'c1',
      tool: 'fs_read',
      capability: 'fs.read',
      rerunnable: true,
      args: {},
      effect: { row: 'host', reversible: 'yes', resource: null, decision: 'allow' },
    });
    // Non è paranoia teorica: `decision` è TEXT, e qualunque cosa scriva su
    // questo database una versione futura arriva qui. Un lettore che
    // accettasse la stringa così com'è conterebbe `denied` fra ciò che è
    // passato senza domanda.
    db.prepare(`UPDATE turn_tool_calls SET decision = 'denied', reversible = 'forse'`).run();
    const r = s.effects({ turnId: 't1' });
    expect(r.calls[0]?.decision).toBeNull();
    expect(r.calls[0]?.reversible).toBeNull();
    expect(r.senzaDomanda).toBe(0);
    db.close();
  });

  it('un giorno senza chiamate lo dice a parole, non con una lista vuota', () => {
    const { db } = store();
    expect(formatEffects(readEffects(db, { day: '2026-09-07' }))).toBe(
      'giornata 2026-09-07: nessuna chiamata registrata.',
    );
    db.close();
  });

  it('localDay legge il fuso locale, non UTC', () => {
    // Costruita con i componenti locali, quindi il giorno locale è per
    // definizione quello: se `localDay` usasse `toISOString` questa
    // asserzione fallirebbe ovunque a est di Londra dopo le 22.
    const d = new Date(2026, 8, 7, 23, 30);
    expect(localDay(d)).toBe('2026-09-07');
  });
});
