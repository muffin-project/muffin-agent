import DatabaseCtor from 'better-sqlite3';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { install, until } from '../harness.js';

/**
 * D1 (judge round 2) — the model lane, proven on the real path.
 *
 * Not a DAY-1 requirement: this is not a product capability, it is the engineering
 * guarantee ADR-0047 §6 states in prose — *"un token non può essere collegato
 * a metà"* — and that prose was false until this slice. `core/turns/lane.ts`
 * and `core/scheduler/scheduler.ts` unit-test their own serialisation with a
 * fake runner; what neither can show is `cli/gateway.ts` actually handing the
 * *same* token to both. A mutation proved the gap: give the turn lane its own
 * `new ModelLane()` in `cli/gateway.ts` instead of the shared one, and `tsc`
 * stayed green, all 1192 tests stayed green, and two lanes ran against one
 * provider at once. `scenario()` requires a manifest row and this defect has
 * none, so this is a plain `it()` against the same harness B3/B4/B5 use.
 *
 * ## Why this needs no artificial delay to be deterministic
 *
 * `Gateway.tick()` calls `scheduler.tick()` then `turnLane.tick()`
 * **synchronously**, back to back, in the same call. `Scheduler.tick()` calls
 * `this.modelLane.take(LANE_JOBS)` — also synchronous — *before* it starts the
 * job's async `run()`. So by the time `turnLane.tick()` runs a moment later in
 * the same call stack, the shared lane is already held or it never will be
 * this beat: there is no race window to fall into by accident, in either
 * direction. Wired correctly, the turn's request physically cannot leave this
 * process before the next beat (`TICK_MS`, 30s later); wired with two lanes,
 * both requests leave within milliseconds of each other. A short real-time
 * checkpoint after the first request lands is enough to tell the two apart —
 * it does not have to win a race, because there is not one.
 */

describe('acceptance · D1 · una sola corsia del modello', () => {
  it(
    'un job scaduto e un turno waiting scaduto non chiamano mai il modello insieme',
    async () => {
      const inst = await install({
        main: [
          // Consumed by the first `muffin run`, arming the wait.
          { tool: { name: 'wait', args: { seconds: 3600, why: 'aspetto qualcosa' } } },
          // Consumed by whichever of {job, resumed turn} the gateway reaches
          // first — the scheduler, per `Gateway.tick`'s own ordering.
          { text: 'ecco il brief' },
          // Consumed by the turn lane, one beat later.
          { text: 'ripreso dopo la corsia' },
        ],
      });
      try {
        // Arm a suspended turn — a real `waiting` row, the way B3 gets one.
        const armed = await inst.muffin(['run', '--session', 'lane-race-1', '--timeout', '25', 'controlla fra un’ora']);
        if (armed.code !== 6) throw new Error(`atteso exit 6 (sospeso), ricevuto ${armed.code}\n${armed.err}`);

        // Add a job — a real `jobs` row, the way B8 gets one.
        const added = await inst.muffin(['jobs', 'add', '--cron', '0 8 * * *', '--channel', 'cli', 'manda il brief']);
        if (added.code !== 0) throw new Error(`jobs add: exit ${added.code}\n${added.err}`);

        // Force both into the past by hand — the only way to have either
        // already due through the real CLI (`jobs add` always computes a
        // future fire; a wait's `wake_at` is always in the future too).
        const dbPath = join(inst.home, 'muffin.db');
        const db = new DatabaseCtor(dbPath);
        let turnId: string;
        try {
          const job = db.prepare(`SELECT id FROM jobs LIMIT 1`).get() as { id: string } | undefined;
          if (!job) throw new Error('nessun job trovato dopo `jobs add`');
          db.prepare(`UPDATE jobs SET next_fire_at = ? WHERE id = ?`).run(
            new Date(Date.now() - 60_000).toISOString(),
            job.id,
          );

          const turn = db.prepare(`SELECT id FROM turns WHERE status = 'waiting'`).get() as { id: string } | undefined;
          if (!turn) throw new Error('nessun turno waiting trovato dopo il wait');
          turnId = turn.id;
          db.prepare(`UPDATE turns SET wake_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), turnId);
        } finally {
          db.close();
        }

        // The baseline: the wait-arming `muffin run` above already made one
        // call, and `provider.main()` accumulates across every process this
        // `inst` spawns — the gateway's own contribution is what happens
        // *after* this point.
        const before = inst.provider.main().length;

        const gw = await inst.gateway();
        try {
          // At least one of {job, turn} has reached the model.
          await until(() => inst.provider.main().length - before >= 1, 15_000);

          // The checkpoint. No sleep-and-hope: see the module docstring for why
          // this window does not have to win a race to be conclusive. Generous
          // anyway, since a slow CI host is still well under one heartbeat.
          await new Promise((r) => setTimeout(r, 2_000));
          const afterFirstBeat = inst.provider.main().length - before;
          if (afterFirstBeat !== 1) {
            throw new Error(
              `${afterFirstBeat} chiamate al modello entro il primo giro — le due corsie hanno girato insieme, ` +
                `non in sequenza (modelli chiamati: ${inst.provider
                  .main()
                  .slice(before)
                  .map((r) => r.transcript.slice(-40).replace(/\n/g, ' '))
                  .join(' | ')})`,
            );
          }

          // And the deferred one is not starved — it runs at the next beat.
          await until(() => inst.provider.main().length - before >= 2, 40_000);
          expect(inst.provider.main().length - before).toBe(2);

          // Never more than once each: two calls total, not two-plus-retries.
          const db2 = new DatabaseCtor(dbPath, { readonly: true });
          try {
            const turnRow = db2.prepare(`SELECT status FROM turns WHERE id = ?`).get(turnId) as { status: string };
            expect(turnRow.status).toBe('done');
          } finally {
            db2.close();
          }
        } finally {
          await gw.stop();
        }
      } finally {
        await inst.cleanup();
      }
    },
    75_000,
  );
});
