import type Database from 'better-sqlite3';

/**
 * The four tools that answer "dove sono / cosa sto guardando" instead of
 * doing the turn's actual work.
 *
 * Named in `docs/evidence/orizzonte-del-turno-2026-09-03.md` Parte 0, after
 * reading the call sites that reach for each one (`agent/tools/fs.ts`,
 * `agent/tools/inspect.ts`) and the acceptance scenarios that exercise a
 * fresh turn — not guessed from the names. Measured on the owner's live
 * installation on 2026-09-03: 123 of 238 rows in `turn_tool_calls`, 51.7%.
 * A fifth orientation-shaped tool belongs here only by the same reading, not
 * by symmetry with this list.
 */
export const ORIENTATION_TOOLS: readonly string[] = ['fs_list', 'fs_read', 'fs_search', 'sys_inspect'];

type ToolShare = { tool: string; count: number; quota: number };

type TurnDistribution = {
  turni: number;
  min: number;
  max: number;
  media: number;
  /** Turns whose call count reached `cap` or more — the ceiling `agent/loop.ts` enforces. */
  alCap: number;
};

export type OrientamentoReport = {
  totaleChiamate: number;
  perTool: readonly ToolShare[];
  orientamento: { count: number; quota: number; tools: readonly string[] };
  /** `null` on a database with no tool calls yet — not a divide-by-zero. */
  turni: TurnDistribution | null;
  cap: number;
};

/**
 * Reads the orientation share straight out of `turn_tool_calls`
 * (`core/turns/store.ts`), the table every tool call already writes to —
 * not a second count kept anywhere else.
 *
 * This is the query `docs/evidence/orizzonte-del-turno-2026-09-03.md` Parte 0
 * had to be hand-written against the owner's live database to produce: two
 * `GROUP BY`s, read-only, repeatable against any `.db` file instead of an
 * archaeology expedition into `~/.muffin` each time someone wants the number
 * again.
 */
export function readOrientamentoReport(db: Database.Database, cap = 15): OrientamentoReport {
  const perToolRows = db
    .prepare(`SELECT tool, COUNT(*) AS n FROM turn_tool_calls GROUP BY tool ORDER BY n DESC, tool ASC`)
    .all() as { tool: string; n: number }[];
  const totaleChiamate = perToolRows.reduce((s, r) => s + r.n, 0);
  const perTool: ToolShare[] = perToolRows.map((r) => ({
    tool: r.tool,
    count: r.n,
    quota: totaleChiamate === 0 ? 0 : r.n / totaleChiamate,
  }));
  const orientCount = perTool.filter((t) => ORIENTATION_TOOLS.includes(t.tool)).reduce((s, t) => s + t.count, 0);

  const perTurnoRows = db.prepare(`SELECT turn_id, COUNT(*) AS n FROM turn_tool_calls GROUP BY turn_id`).all() as {
    turn_id: string;
    n: number;
  }[];
  const turni: TurnDistribution | null =
    perTurnoRows.length === 0
      ? null
      : {
          turni: perTurnoRows.length,
          min: Math.min(...perTurnoRows.map((r) => r.n)),
          max: Math.max(...perTurnoRows.map((r) => r.n)),
          media: perTurnoRows.reduce((s, r) => s + r.n, 0) / perTurnoRows.length,
          alCap: perTurnoRows.filter((r) => r.n >= cap).length,
        };

  return {
    totaleChiamate,
    perTool,
    orientamento: {
      count: orientCount,
      quota: totaleChiamate === 0 ? 0 : orientCount / totaleChiamate,
      tools: ORIENTATION_TOOLS,
    },
    turni,
    cap,
  };
}

/** Percentuale, una cifra decimale — la stessa forma di `cli/trace.ts`/`cli/backup.ts`. */
function pct(q: number): string {
  return `${(q * 100).toFixed(1)}%`;
}

/**
 * The human report. Zero calls says so in words — `nessuna chiamata` — rather
 * than printing `NaN%` from a division the caller has to remember to guard.
 */
export function formatOrientamentoReport(r: OrientamentoReport): string {
  if (r.totaleChiamate === 0) return 'nessuna chiamata registrata in turn_tool_calls.';
  const righe = [
    `${r.totaleChiamate} chiamate registrate.`,
    '',
    'per tool:',
    ...r.perTool.map((t) => `  ${t.tool} ${t.count} (${pct(t.quota)})`),
    '',
    `orientamento (${r.orientamento.tools.join(', ')}): ${r.orientamento.count}/${r.totaleChiamate} — ${pct(r.orientamento.quota)}`,
  ];
  if (r.turni) {
    righe.push(
      '',
      `turni: ${r.turni.turni} · min ${r.turni.min} · media ${r.turni.media.toFixed(1)} · max ${r.turni.max} · ` +
        `al tetto di ${r.cap} o oltre: ${r.turni.alCap}`,
    );
  }
  return righe.join('\n');
}
