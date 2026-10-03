import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlExporter } from '../tracing/tracer.js';

/**
 * #766 (A8) — retention at the tick, on a populated traces directory.
 *
 * The recorded residue is "retention/cron": the trace-retention policy
 * (`traces.retentionDays`) was never proven against real files. The production
 * mechanism is `JsonlExporter.pruneOlderThan` — the exact function
 * `agent/runtime.ts` calls at boot — driven here the way a tick would drive
 * it: a populated `traces/` dir (expired days, the boundary day, fresh days,
 * plus files that do not look like days) and one retention pass.
 *
 * Stated plainly, because the row must not silently downgrade: in production
 * this function is invoked at boot only. No gateway or scheduler tick calls
 * it, and the "day rollover" half of `tracer.ts`'s own comment has no
 * implementation (already flagged in
 * `docs/history/rebuild-2026/validazione-contratti.md`). What this test
 * proves is that the mechanism removes exactly what the policy says is
 * expired when it runs — so the remaining gap is the wiring (a tick that
 * calls it), not the mechanism. That gap is recorded in the A8 row as an
 * explicit FOLLOW-UP, not claimed.
 *
 * The fixture home lives under a dot directory because the real one does
 * (`~/.muffin` — the 03/09 lesson in `docs/development/ORCHESTRATION.md`).
 *
 * What would falsify it: with retention disabled (the prune neutralised) the
 * tick keeps everything — the removed-list assertion below goes red.
 */
describe('retention at the tick — the production prune on a populated traces dir (#766)', () => {
  // A Saturday noon, fixed so the boundary is a date, not a moving target.
  const NOW = new Date('2026-09-20T12:00:00.000Z');
  const RETENTION_DAYS = 90;
  // cutoff = 2026-06-22: strictly older days go, the cutoff day itself stays
  // (`day < cutoff` in the implementation).
  const EXPIRED = ['2026-03-01.jsonl', '2026-06-21.jsonl'];
  const KEPT = ['2026-06-22.jsonl', '2026-09-19.jsonl', '2026-09-20.jsonl'];
  const JUNK = ['README.md', 'notes.txt', '2026-6-2.jsonl', '2026-13-99.jsonl'];

  function populatedHome(): { home: string; traces: string } {
    const home = mkdtempSync(join(tmpdir(), '.muffin-766-retention-'));
    const exporter = new JsonlExporter(home);
    const traces = join(home, 'traces');
    for (const file of [...EXPIRED, ...KEPT]) {
      writeFileSync(join(traces, file), `{"day":${JSON.stringify(file)}}\n`);
    }
    for (const file of JUNK) {
      writeFileSync(join(traces, file), 'not a day file\n');
    }
    // The exporter is the production constructor; the files above are what a
    // home that has lived for months looks like. Silence the unused warning
    // by construction: `exporter` did the private-dir work.
    void exporter;
    return { home, traces };
  }

  it('one retention pass removes exactly the expired days and nothing else', () => {
    const { home, traces } = populatedHome();
    try {
      const exporter = new JsonlExporter(home);

      const removed = exporter.pruneOlderThan(RETENTION_DAYS, NOW);

      expect([...removed].sort()).toEqual([...EXPIRED].sort());
      const remaining = readdirSync(traces).sort();
      expect(remaining).toEqual([...KEPT, ...JUNK].sort());
      // Kept files are untouched, byte for byte — a prune that rewrites or
      // truncates neighbours would pass the name assertion and fail here.
      for (const file of [...KEPT, ...JUNK]) {
        const content = readFileSync(join(traces, file), 'utf8');
        expect(content.length, `${file} intact`).toBeGreaterThan(0);
      }
      expect(readFileSync(join(traces, KEPT[0]!), 'utf8')).toContain(KEPT[0]!);

      // A second tick right away is a no-op: retention is idempotent, not a
      // shrinking window that eats the boundary on the next pass.
      expect(exporter.pruneOlderThan(RETENTION_DAYS, NOW)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a shorter retention removes more, an infinite one removes nothing', () => {
    const { home, traces } = populatedHome();
    try {
      const exporter = new JsonlExporter(home);

      // 7 days from 2026-09-20: everything dated June or earlier is expired.
      const removed = exporter.pruneOlderThan(7, NOW);
      expect([...removed].sort()).toEqual([...EXPIRED, '2026-06-22.jsonl'].sort());
      expect(readdirSync(traces).sort()).toEqual(['2026-09-19.jsonl', '2026-09-20.jsonl', ...JUNK].sort());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
