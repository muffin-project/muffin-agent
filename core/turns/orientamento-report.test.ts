import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { TurnStore } from './store.js';
import { formatOrientamentoReport, ORIENTATION_TOOLS, readOrientamentoReport } from './orientamento-report.js';

/**
 * Il numero che `docs/evidence/orizzonte-del-turno-2026-09-03.md` Parte 0 ha
 * dovuto scrivere a mano contro `muffin.db` dell'owner una volta: qui è la
 * stessa query, contro una fixture con conteggi noti, così che il comando
 * `muffin orientamento` non torni a essere un'archeologia da rifare a mano la
 * prossima volta che qualcuno vuole il numero.
 *
 * Scritta con `TurnStore.startToolCall`, la stessa scrittura che
 * `agent/loop.ts` fa a ogni chiamata reale — non un INSERT a mano che
 * potrebbe divergere dallo schema il giorno che `SCHEMA` cambia.
 */
function fixture(rows: readonly { turnId: string; tool: string }[]): DatabaseCtor.Database {
  const db = new DatabaseCtor(':memory:');
  const store = new TurnStore(db);
  rows.forEach((r, i) => {
    store.startToolCall(r.turnId, {
      callId: `c${i}`,
      tool: r.tool,
      capability: 'test.cap',
      rerunnable: true,
      args: { i },
    });
  });
  return db;
}

describe('readOrientamentoReport', () => {
  it('nessuna chiamata: niente NaN, niente divisione per zero', () => {
    const db = fixture([]);
    const r = readOrientamentoReport(db);
    expect(r.totaleChiamate).toBe(0);
    expect(r.perTool).toEqual([]);
    expect(r.orientamento).toEqual({ count: 0, quota: 0, tools: ORIENTATION_TOOLS });
    expect(r.turni).toBeNull();
    expect(formatOrientamentoReport(r)).toBe('nessuna chiamata registrata in turn_tool_calls.');
  });

  it('conta per tool, la quota di orientamento, e la distribuzione per turno', () => {
    const db = fixture([
      // turno 1: 4 chiamate, due di orientamento e due no
      { turnId: 't1', tool: 'fs_list' },
      { turnId: 't1', tool: 'fs_read' },
      { turnId: 't1', tool: 'sys_inspect' },
      { turnId: 't1', tool: 'shell_run' },
      // turno 2: 6 chiamate, quattro di orientamento
      { turnId: 't2', tool: 'shell_run' },
      { turnId: 't2', tool: 'shell_run' },
      { turnId: 't2', tool: 'fs_search' },
      { turnId: 't2', tool: 'memory_search' },
      { turnId: 't2', tool: 'fs_list' },
      { turnId: 't2', tool: 'sys_inspect' },
    ]);

    const r = readOrientamentoReport(db, 5);
    expect(r.totaleChiamate).toBe(10);
    expect(r.perTool).toEqual(
      expect.arrayContaining([
        { tool: 'shell_run', count: 3, quota: 0.3 },
        { tool: 'fs_list', count: 2, quota: 0.2 },
        { tool: 'fs_read', count: 1, quota: 0.1 },
        { tool: 'sys_inspect', count: 2, quota: 0.2 },
        { tool: 'fs_search', count: 1, quota: 0.1 },
        { tool: 'memory_search', count: 1, quota: 0.1 },
      ]),
    );
    // fs_list(2) + fs_read(1) + fs_search(1) + sys_inspect(2) = 6/10
    expect(r.orientamento.count).toBe(6);
    expect(r.orientamento.quota).toBeCloseTo(0.6, 10);
    expect(r.turni).toEqual({ turni: 2, min: 4, max: 6, media: 5, alCap: 1 }); // solo t2 tocca il tetto di 5

    const testo = formatOrientamentoReport(r);
    expect(testo).toContain('10 chiamate registrate.');
    expect(testo).toContain('shell_run 3 (30.0%)');
    expect(testo).toContain('orientamento (fs_list, fs_read, fs_search, sys_inspect): 6/10 — 60.0%');
    expect(testo).toContain('turni: 2 · min 4 · media 5.0 · max 6 · al tetto di 5 o oltre: 1');
  });

  it('il tetto è configurabile: nessun turno lo tocca con una soglia più alta', () => {
    const db = fixture([
      { turnId: 't1', tool: 'fs_list' },
      { turnId: 't1', tool: 'fs_read' },
    ]);
    const r = readOrientamentoReport(db, 15);
    expect(r.turni?.alCap).toBe(0);
  });
});
