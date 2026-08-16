import DatabaseCtor from 'better-sqlite3';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install } from '../harness.js';
import { scenario } from '../scenario.js';

/**
 * B · Runtime continuity.
 *
 * B1 stands in for "CLI and Telegram share session and memory" with the part
 * of that claim the CLI alone can exercise honestly: no real Telegram bot is
 * reachable from here, but the mechanism the claim actually rests on —
 * `SessionStore` persisting a conversation's transcript to disk rather than
 * to process memory — is exactly as testable, and arguably the harder
 * property, since nothing at all survives the process boundary except the
 * files `--session` points at.
 */

describe('acceptance · B · continuità del runtime', () => {
  scenario(
    'B1',
    async () => {
      const inst = await install({
        main: [{ text: 'il tuo colore preferito è il verde, capito' }, { text: 'mi hai detto il verde' }],
      });
      try {
        const first = await inst.muffin(['run', '--session', 'continuity-1', '--timeout', '20', 'il mio colore preferito è il verde']);
        if (first.code !== 0) throw new Error(`primo processo: exit ${first.code}\n${first.err}`);

        // A second, unrelated process — nothing in common with the first but
        // the files under `inst.home` and the `--session` id.
        const second = await inst.muffin(['run', '--session', 'continuity-1', '--timeout', '20', 'che colore ho detto?']);
        if (second.code !== 0) throw new Error(`secondo processo: exit ${second.code}\n${second.err}`);

        const sentToSecondCall = inst.provider.main()[1];
        if (!sentToSecondCall) throw new Error('il secondo processo non ha mai chiamato il modello');

        // The literal transcript, not a recalled summary — and this distinction
        // is not academic: the first run of this scenario asserted only a
        // substring of `.transcript` and stayed green with `SessionStore.append`
        // mutated into a no-op, because `core/memory/recall.ts` independently
        // re-surfaces the same two lines as a "cose che ricordi" block folded
        // into the *new* user message. That is a real, useful property of
        // recall — and a reason this scenario has to check something recall
        // cannot produce: a literal, separate `role: 'assistant'` wire message
        // carrying the model's own prior reply, which only a persisted
        // multi-turn transcript ever assembles. Recall injects into the
        // current turn's user content; it does not fabricate a past assistant
        // turn.
        const assistantTurn = sentToSecondCall.messages.find(
          (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('il tuo colore preferito è il verde, capito'),
        );
        if (!assistantTurn) {
          throw new Error(
            `nessun messaggio role:assistant con la risposta del primo turno — SessionStore non ha ritrovato la sessione:\n${JSON.stringify(sentToSecondCall.messages, null, 2)}`,
          );
        }
        const priorUserTurn = sentToSecondCall.messages.find(
          (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('il mio colore preferito è il verde') && m !== sentToSecondCall.messages[sentToSecondCall.messages.length - 1],
        );
        if (!priorUserTurn) {
          throw new Error(
            `nessun messaggio role:user precedente con il primo turno letterale:\n${JSON.stringify(sentToSecondCall.messages, null, 2)}`,
          );
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );

  scenario(
    'B8',
    async () => {
      const inst = await install({ main: [{ text: 'ecco il tuo brief' }] });
      try {
        // A job addressed to a channel `muffin gateway run` cannot actually
        // reach yet (`cli/gateway.ts`'s own `gatewayDeliver`: only 'cli' is
        // wired — everything else is "consegna remota da cablare" on stderr).
        const added = await inst.muffin([
          'jobs',
          'add',
          '--cron',
          '0 8 * * *',
          '--channel',
          'telegram',
          'manda il brief',
        ]);
        if (added.code !== 0) throw new Error(`jobs add: exit ${added.code}\n${added.err}`);

        // `jobs add` always computes the next fire in the future — the only way
        // to have a due job through the real CLI is to move the fire time back
        // by hand afterwards, exactly like cli/gateway.test.ts's own
        // `overdueJob` fixture does for the same reason.
        const db = new DatabaseCtor(join(inst.home, 'muffin.db'));
        let jobId: string;
        try {
          const row = db.prepare(`SELECT id FROM jobs LIMIT 1`).get() as { id: string } | undefined;
          if (!row) throw new Error('nessun job trovato dopo `jobs add`');
          jobId = row.id;
          db.prepare(`UPDATE jobs SET next_fire_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), jobId);
        } finally {
          db.close();
        }

        // The real gateway process: `serve()` ticks once immediately at boot
        // (core/gateway/service.ts), specifically so a job that came due while
        // nothing was running fires without waiting out a full interval.
        const gw = await inst.gateway();
        try {
          await gw.waitFor(/consegna remota da cablare/, 15_000);
        } finally {
          await gw.stop();
        }

        // The desired invariant a job "said sent" should have to earn: it is
        // only recorded as run if delivery actually reached the channel. Today
        // `Scheduler.run` calls `markRan` unconditionally after the delivery
        // attempt (core/scheduler/scheduler.ts), whether or not the channel
        // exists — so this reads `last_run_at` set even though nothing was
        // delivered anywhere an owner would see it.
        const after = new DatabaseCtor(join(inst.home, 'muffin.db'), { readonly: true });
        let lastRunAt: string | null;
        try {
          lastRunAt = (after.prepare(`SELECT last_run_at FROM jobs WHERE id = ?`).get(jobId) as { last_run_at: string | null })
            .last_run_at;
        } finally {
          after.close();
        }
        if (lastRunAt !== null) {
          throw new Error(
            `il job è marcato eseguito (last_run_at=${lastRunAt}) nonostante la consegna non sia mai arrivata al canale`,
          );
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});

/**
 * B3 · B4 · B5 — the suspendable turn, from outside the process.
 *
 * `slice/turno-sospeso` proves each of these with unit and wiring tests. What
 * those cannot show is the property an owner actually cares about, which is
 * about **processes**: that `muffin run` comes back instead of holding the
 * terminal for an hour, that a plan crosses a process boundary on its own, and
 * that a Muffin killed mid-sentence finishes the sentence after a restart.
 */
describe('acceptance · B · il turno sospendibile', () => {
  scenario(
    'B3',
    async () => {
      const inst = await install({
        // Ask to wait an hour. Nothing else is scripted: if the process held
        // the runtime the way `await sleep()` would, this scenario would time
        // out rather than fail — which is itself the assertion.
        main: [{ tool: { name: 'wait', args: { seconds: 3600, why: 'aspetto il backup' } } }],
      });
      try {
        const started = Date.now();
        const run = await inst.muffin(['run', '--session', 'wait-1', '--timeout', '25', 'controlla fra un’ora']);
        const elapsed = Date.now() - started;

        // Exit 6 is "suspended", and it has its own code precisely so a script
        // cannot mistake an empty answer for a real one.
        if (run.code !== 6) throw new Error(`atteso exit 6 (sospeso), ricevuto ${run.code}\n${run.err}`);
        // The process is back. An hour-long wait that held the runtime would
        // still be here; the boot of a node+tsx child is seconds, so anything
        // under a minute proves the wait is a row and not a stack frame.
        if (elapsed > 60_000) throw new Error(`il processo ha tenuto il runtime per ${elapsed}ms`);
        if (!/sospeso fino a/.test(run.err)) {
          throw new Error(`non ha detto fino a quando aspetta:\n${run.err}`);
        }

        const row = inst.db((db) =>
          db.prepare(`SELECT status, wake_at, claimed_by, turn_outcome FROM turns`).get() as
            | { status: string; wake_at: string | null; claimed_by: number | null; turn_outcome: string | null }
            | undefined,
        );
        if (row?.status !== 'waiting') throw new Error(`la riga dice ${row?.status ?? 'niente'}, non waiting`);
        if (row.wake_at === null) throw new Error('sospeso senza scadenza: non lo sveglierebbe nessuno');
        // The claim is released in the same write. A suspended row that kept a
        // pid would be reclaimed as *interrupted* the moment that process
        // exited — every wait outliving its process reported as a crash.
        if (row.claimed_by !== null) throw new Error(`la riga tiene ancora il pid ${row.claimed_by}`);
        // And it is not an ending: nothing wrote an outcome.
        if (row.turn_outcome !== null) throw new Error(`un turno sospeso non è finito, ma dice ${row.turn_outcome}`);
      } finally {
        await inst.cleanup();
      }
    },
    60_000,
  );

  scenario(
    'B4',
    async () => {
      const inst = await install({
        main: [
          { tool: { name: 'todo', args: { action: 'plan', items: ['leggere il contratto', 'rispondere a Marco'] } } },
          { text: 'ho scritto il piano' },
          { text: 'eccomi' },
        ],
      });
      try {
        const first = await inst.muffin(['run', '--session', 'piano-1', '--timeout', '25', 'organizzati']);
        if (first.code !== 0) throw new Error(`primo processo: exit ${first.code}\n${first.err}`);

        // A second, unrelated process. Nothing survives between them but the
        // files under `inst.home` and the `--session` id — which is the whole
        // claim: a plan that died with the process that wrote it is not a plan.
        const second = await inst.muffin(['run', '--session', 'piano-1', '--timeout', '25', 'a che punto sei?']);
        if (second.code !== 0) throw new Error(`secondo processo: exit ${second.code}\n${second.err}`);

        const sent = inst.provider.main().at(-1);
        if (!sent) throw new Error('il secondo processo non ha mai chiamato il modello');
        // Shown **unasked**: the second process never called `todo list`, and
        // the plan is in front of the model anyway. A plan the model has to
        // remember to ask for is one it forgets the moment its own earlier
        // prose is compacted.
        for (const step of ['leggere il contratto', 'rispondere a Marco']) {
          if (!sent.transcript.includes(step)) {
            throw new Error(`il passo "${step}" non è nel contesto del secondo processo:\n${sent.transcript}`);
          }
        }
        // The deterministic completion criterion travels with it — M5-BIS §2
        // asks for one, and this is the only place the model reads about it.
        if (!/nessun passo/.test(sent.transcript)) {
          throw new Error(`il criterio di completamento non è nel contesto:\n${sent.transcript}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    60_000,
  );

  scenario(
    'B5',
    async () => {
      const inst = await install({
        // Enough round trips that the turn is demonstrably mid-flight while the
        // row says `running`: each `todo` call is a full trip to the provider
        // and back. The kill lands inside that window.
        main: [
          { tool: { name: 'todo', args: { action: 'plan', items: ['passo uno'] } } },
          { tool: { name: 'todo', args: { action: 'list' } } },
          { tool: { name: 'todo', args: { action: 'list' } } },
          { tool: { name: 'todo', args: { action: 'list' } } },
          { text: 'ecco la risposta dopo la ripresa' },
        ],
      });
      try {
        const victim = inst.spawnRaw(['run', '--session', 'crash-1', '--timeout', '60', 'fai il lavoro lungo']);
        // Wait until the row exists and is claimed — that is "the turn really
        // started", written by production code before the first model call.
        const turnId = await pollFor(() =>
          // `turns` is created by the first runtime that opens this home — the
          // victim itself — so the first few polls legitimately race the table
          // into existence. Absent and empty are the same answer here: not yet.
          tolerating(() =>
            inst.db((db) => {
              const row = db.prepare(`SELECT id FROM turns WHERE status = 'running'`).get() as
                | { id: string }
                | undefined;
              return row?.id;
            }),
          ),
        );
        // SIGKILL: no handler, no `finally`, no flush. The row and the intent
        // record have to be enough on their own.
        victim.kill();
        await victim.exited;

        // What the owner does first: open a terminal and ask. `doctor` only
        // **reads** — marking is `reclaim`'s job and belongs to a process that
        // opens the home for work, not to a diagnosis — so the row still says
        // `running` here and is reported as interrupted anyway, because one
        // liveness rule (`heldBy`) answers for both.
        const doctor = await inst.muffin(['doctor']);
        if (!/interrott/.test(doctor.out)) {
          throw new Error(`doctor non nomina il turno interrotto:\n${doctor.out}`);
        }
        if (!doctor.out.includes(turnId.slice(0, 12))) {
          throw new Error(`doctor non dice QUALE turno:\n${doctor.out}`);
        }

        // And the gateway — the process that owns the lane — marks it and
        // finishes it.
        const gw = await inst.gateway();
        try {
          await pollFor(
            () =>
              tolerating(() =>
                inst.db((db) => {
                  const row = db.prepare(`SELECT status FROM turns WHERE id = ?`).get(turnId) as { status: string };
                  return row.status === 'done' ? row.status : undefined;
                }),
              ),
            20_000,
          );
        } finally {
          await gw.stop();
        }
      } finally {
        await inst.cleanup();
      }
    },
    90_000,
  );
});

/**
 * A read that may legitimately be too early. Distinct from `pollFor` because
 * only the *caller* knows whether a missing table means "not yet" or "broken",
 * and swallowing that inside the poller would hide a real schema failure as a
 * timeout.
 */
function tolerating<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Polls a read until it answers, or gives up loudly rather than hanging. */
async function pollFor<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`niente entro ${timeoutMs}ms`);
}
