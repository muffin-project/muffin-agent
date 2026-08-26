import DatabaseCtor from 'better-sqlite3';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install, type Install } from '../harness.js';
import { scenario } from '../scenario.js';

/**
 * B7 · job_fires — the (job_id, scheduled_for) → turn_id identity bridge.
 *
 * A1 (`a-lifecycle.accept.ts`) deliberately keeps a due job and a real
 * `SIGKILL` from ever overlapping — its own comment names the window it stays
 * outside of as *"riga B7, decisione job_fires, owned elsewhere"*. This file
 * is that elsewhere: a real gateway subprocess, killed with `SIGKILL` twice,
 * each time inside the exact window job_fires exists to close.
 *
 * `docs/JUDGE.md`: *"il difetto di casa è la garanzia provata contro un
 * finto"* — so this drives `cli main.ts` as a real child process against a
 * real (temp-file) database, never `makeJobRunner`/`Scheduler` called by hand.
 * The two `MUFFIN_JOB_FIRES_STALL_*` env vars are the one test-only seam
 * (`agent/scheduler-run.ts`, same precedent as `MUFFIN_GATEWAY_TICK_MS`): the
 * windows they widen are real production races, but each is microseconds wide
 * in normal operation — too narrow for an external `SIGKILL` to land on
 * reliably without them.
 */

/** Polls `muffin gateway status` until its exit code matches — A1's own helper, copied rather than exported for one caller. */
async function pollGatewayStatus(inst: Install, wantCode: 0 | 1, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await inst.muffin(['gateway', 'status']);
    if (r.code === wantCode) return;
    if (Date.now() > deadline) {
      throw new Error(`\`gateway status\` non ha mai risposto ${wantCode} (ultimo: ${r.code})\n${r.out}${r.err}`);
    }
    await new Promise((r2) => setTimeout(r2, 150));
  }
}

/** Polls the database until `check` returns non-null, or times out. */
async function waitForDb<T>(
  inst: Install,
  check: (db: DatabaseCtor.Database) => T | null,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = inst.db(check);
    if (result !== null) return result;
    if (Date.now() > deadline) throw new Error('condizione mai raggiunta sul database entro il timeout');
    await new Promise((r) => setTimeout(r, 40));
  }
}

describe('acceptance · B7 · job_fires — identità durevole di un\'occorrenza', () => {
  scenario(
    'B7',
    async () => {
      const inst = await install({
        main: [{ text: 'ecco il brief di questa occorrenza' }],
        env: {
          MUFFIN_GATEWAY_TICK_MS: '200',
          // Long enough for a ~40ms DB poll loop to observe the intermediate
          // state and land a SIGKILL inside it; short enough to keep the
          // scenario fast. Active for the whole install — harmless before the
          // job is ever due, and paid only by the two attempts that actually
          // reach `runFresh` (a recovered, already-`done` turn never does).
          MUFFIN_JOB_FIRES_STALL_AFTER_BIND_MS: '2500',
          MUFFIN_JOB_FIRES_STALL_AFTER_DONE_MS: '2500',
        },
      });
      try {
        // --- (a) one job, not due yet — same reasoning as A1: nothing races
        // a real kill by chance if nothing is due while a process is alive to
        // notice it before the deliberate backdate below. -------------------
        const added = await inst.muffin(['jobs', 'add', '--cron', '0 8 * * *', '--channel', 'cli', 'manda il brief']);
        if (added.code !== 0) throw new Error(`jobs add: exit ${added.code}\n${added.err}`);
        const jobId = inst.db((db) => (db.prepare(`SELECT id FROM jobs`).get() as { id: string } | undefined)?.id);
        if (!jobId) throw new Error('nessuna riga jobs dopo `jobs add`');

        // ============================================================
        // Round 1 — SIGKILL between binding the fire and creating its turn
        // (fault point 2: "dopo il fire prima del turno").
        // ============================================================
        const first = inst.spawnRaw(['gateway', 'run']);
        await pollGatewayStatus(inst, 0);

        const past = new Date(Date.now() - 60_000).toISOString();
        const backdate1 = new DatabaseCtor(join(inst.home, 'muffin.db'));
        try {
          backdate1.prepare(`UPDATE jobs SET next_fire_at = ? WHERE id = ?`).run(past, jobId);
        } finally {
          backdate1.close();
        }

        // The fire is bound (turn_id set) but the turn row does not exist yet
        // — exactly the `MUFFIN_JOB_FIRES_STALL_AFTER_BIND_MS` window.
        const boundTurnId = await waitForDb(inst, (db) => {
          const fire = db.prepare(`SELECT turn_id FROM job_fires WHERE job_id = ?`).get(jobId) as
            | { turn_id: string | null }
            | undefined;
          if (!fire?.turn_id) return null;
          const turnRow = db.prepare(`SELECT count(*) AS n FROM turns WHERE id = ?`).get(fire.turn_id) as { n: number };
          return turnRow.n === 0 ? fire.turn_id : null;
        });

        first.kill();
        await first.exited;
        await pollGatewayStatus(inst, 1); // dead pid = claim free immediately (heldBy judges liveness first)

        // Nothing was created yet, and the fire still names the same id.
        const afterFirstKill = inst.db((db) => ({
          turnRows: (db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n,
          fireTurnId: (db.prepare(`SELECT turn_id FROM job_fires WHERE job_id = ?`).get(jobId) as { turn_id: string })
            .turn_id,
        }));
        if (afterFirstKill.turnRows !== 0) {
          throw new Error(`atteso zero righe turns dopo il primo SIGKILL, trovate ${afterFirstKill.turnRows}`);
        }
        if (afterFirstKill.fireTurnId !== boundTurnId) {
          throw new Error(`il fire ha perso l'identità legata prima del kill: era ${boundTurnId}, ora ${afterFirstKill.fireTurnId}`);
        }

        // ============================================================
        // Round 2 — restart completes the interrupted binding (same turn_id,
        // fault point 3), runs the turn to `done`, then a SECOND SIGKILL
        // lands between the turn finishing and `Scheduler` ever settling it
        // (fault point 5: "turno done prima di markRan").
        // ============================================================
        const second = inst.spawnRaw(['gateway', 'run']);
        await pollGatewayStatus(inst, 0);

        const doneUnsettled = await waitForDb(inst, (db) => {
          const turnRow = db.prepare(`SELECT id, status FROM turns WHERE id = ?`).get(boundTurnId) as
            | { id: string; status: string }
            | undefined;
          if (turnRow?.status !== 'done') return null;
          const fire = db.prepare(`SELECT settled_at FROM job_fires WHERE job_id = ?`).get(jobId) as {
            settled_at: string | null;
          };
          return fire.settled_at === null ? turnRow.id : null;
        });
        if (doneUnsettled !== boundTurnId) {
          throw new Error(`il turno completato dopo il riavvio ha un id diverso da quello legato: atteso ${boundTurnId}, trovato ${doneUnsettled}`);
        }

        second.kill();
        await second.exited;
        await pollGatewayStatus(inst, 1);

        // Still exactly one turn — completing the interrupted bind did not
        // create a second one — and it is `done`, undelivered, unsettled.
        const afterSecondKill = inst.db((db) => ({
          turnRows: (db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n,
          turn: db.prepare(`SELECT status, delivery FROM turns WHERE id = ?`).get(boundTurnId) as {
            status: string;
            delivery: string | null;
          },
          job: db.prepare(`SELECT last_run_at FROM jobs WHERE id = ?`).get(jobId) as { last_run_at: string | null },
        }));
        if (afterSecondKill.turnRows !== 1) {
          throw new Error(`atteso esattamente 1 riga turns dopo il secondo SIGKILL, trovate ${afterSecondKill.turnRows}`);
        }
        if (afterSecondKill.turn.status !== 'done' || afterSecondKill.turn.delivery !== 'pending') {
          throw new Error(`stato inatteso dopo il secondo kill: ${JSON.stringify(afterSecondKill.turn)}`);
        }
        if (afterSecondKill.job.last_run_at !== null) {
          throw new Error('markRan è stato chiamato prima del settlement — esattamente il fault point 7 violato');
        }

        // ============================================================
        // Round 3 — final restart: the turn is already `done`, so this pass
        // must recover the text and settle without ever calling the model
        // again.
        // ============================================================
        const gw3 = await inst.gateway();
        try {
          await gw3.waitFor(/⏰ ecco il brief di questa occorrenza/, 15_000);

          // `waitForDb` e non una lettura immediata: la riga su stdout compare
          // quando la **consegna** è registrata, e `markRan` viene dopo il
          // settlement — che è precisamente l'ordine che questa slice
          // garantisce. Leggere subito significa cadere fra i due su una
          // macchina carica: misurato 4 volte su 4 mentre giravano altre suite,
          // sempre con `settled_at` valorizzato e `last_run_at` ancora nullo.
          // Il difetto era nell'attesa del test, non nel prodotto.
          const final = await waitForDb(inst, (db) => {
            const job = db.prepare(`SELECT last_run_at, next_fire_at FROM jobs WHERE id = ?`).get(jobId) as {
              last_run_at: string | null;
              next_fire_at: string;
            };
            return job.last_run_at === null ? null : job;
          }).then((job) => inst.db((db) => ({
            turnRows: (db.prepare(`SELECT count(*) AS n FROM turns`).get() as { n: number }).n,
            turn: db.prepare(`SELECT status, delivery FROM turns WHERE id = ?`).get(boundTurnId) as {
              status: string;
              delivery: string;
            },
            fire: db.prepare(`SELECT turn_id, settled_at FROM job_fires WHERE job_id = ?`).get(jobId) as {
              turn_id: string;
              settled_at: string | null;
            },
            job,
          })));

          // Exactly one identity, start to finish — never a second turn for
          // this occurrence across three process lifetimes and two real kills.
          if (final.turnRows !== 1) throw new Error(`atteso 1 riga turns alla fine, trovate ${final.turnRows}`);
          if (final.turn.status !== 'done' || final.turn.delivery !== 'sent') {
            throw new Error(`il turno non risulta consegnato alla fine: ${JSON.stringify(final.turn)}`);
          }
          if (final.fire.turn_id !== boundTurnId) throw new Error('il fire punta a un turno diverso da quello originale');
          if (final.fire.settled_at === null) throw new Error('il fire non risulta mai marcato settled_at');
          if (final.job.last_run_at === null) throw new Error('il job non risulta eseguito (last_run_at nullo)');
          if (Date.parse(final.job.next_fire_at) <= Date.now()) {
            throw new Error(`next_fire_at non è avanzato oltre ora: ${final.job.next_fire_at}`);
          }

          // The strongest evidence against a duplicate execution: the fake
          // provider's own request log, not an inference from the database.
          // Two real SIGKILLs, three process lifetimes, one model call.
          const mainCalls = inst.provider.main();
          if (mainCalls.length !== 1) {
            throw new Error(`il modello è stato chiamato ${mainCalls.length} volte, non 1 — computazione ripetuta dopo un crash`);
          }

          // The text reached stdout exactly once.
          const deliveries = gw3.stdout().split('⏰ ecco il brief di questa occorrenza').length - 1;
          if (deliveries !== 1) throw new Error(`il testo del job è comparso ${deliveries} volte su stdout, non 1`);
        } finally {
          await gw3.stop();
        }
      } finally {
        await inst.cleanup();
      }
    },
    90_000,
  );
});
