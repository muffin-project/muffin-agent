import DatabaseCtor from 'better-sqlite3';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install, until } from '../harness.js';
import { extraction } from '../provider.js';
import { scenario } from '../scenario.js';
import { MemoryStore } from '../../../core/memory/store.js';

/**
 * C2/C3 · Consolidation runs on its own, and drains what it finds.
 *
 * Both rows share one fact that made them BLOCKER for the same reason: the
 * mechanism (`core/memory/consolidator.ts`, ADR-0038) has unit tests and a
 * caller (`agent/runtime.ts`'s `onTurnEnd`), and nobody had ever driven it
 * through the real binary end to end.
 *
 * ## Why C2 needs a live gateway, not `muffin run`
 *
 * `Consolidator.rearm` calls `this.timer.unref?.()` on purpose — see its own
 * comment: "a headless `muffin run` that finished its turn should exit, not
 * linger 20s waiting to extract". And `runHeadless` (`cli/run.ts`) calls
 * `runtime.close()` — which calls `consolidation.stop()` — in the same tick
 * the turn finishes, before the process is even done writing its reply to
 * stdout. So a headless turn's trailing-edge timer is armed and disarmed
 * without ever getting a turn on the event loop: `muffin run` structurally
 * cannot demonstrate C2, at any debounce length. `c-memory.accept.ts`'s C1
 * docstring already names this ("muffin run headless never consolidates")
 * for why its own fixture skips extraction. The one process that stays alive
 * for a reason unrelated to the timer is the gateway, so that is what this
 * scenario drives — a real job, fired through a real gateway subprocess,
 * with nothing here ever calling `muffin memory extract`.
 *
 * `MUFFIN_MEMORY_IDLE_MS` (`agent/runtime.ts`) is the one seam this adds: the
 * real debounce is 20s (`CONSOLIDATION_IDLE_MS`), correct for a conversation
 * and too long for a scenario to either sleep through or leave unproven. Same
 * precedent as `MUFFIN_GATEWAY_TICK_MS` (`cli/gateway.ts`) and
 * `MUFFIN_JOB_FIRES_STALL_*` (`agent/scheduler-run.ts`): a no-op unless a
 * scenario sets it, never set outside `evals/acceptance`.
 *
 * **Falsifier**: comment out `onTurnEnd: ({ tenant }) => consolidation.notify(tenant)`
 * in `agent/runtime.ts` (or widen `MUFFIN_MEMORY_IDLE_MS` back to the real
 * 20s default) and C2 goes red — no fact ever appears, because nothing else
 * in this scenario ever triggers extraction.
 *
 * ## Why C3 seeds a database fixture instead of scripting three live turns
 *
 * "drain a pagina piena" needs a backlog bigger than one round (25 episodes,
 * `cmdMemoryExtract`'s own page size) — driving that many real turns through
 * the fake provider would make the scenario about turn plumbing, not about
 * the drain. "dedup a chiave esatta" needs the residue `core/memory/
 * maintenance.ts`'s own comment names: `reconcile` only ever compares an
 * incoming fact to the single most-recently-recorded active belief, so two
 * duplicate rows that are not each other's immediate neighbour survive until
 * something else looks at the *whole* active set — which is exactly what
 * `sweepDuplicates` is for, and exactly the case a live conversation would
 * take three separate turns and a judge round-trip to construct by accident.
 * `MemoryStore.addFact`/`addEpisode` are the same production methods
 * `consolidator.ts`'s own pipeline calls (see C4's fixture in
 * `c-memory.accept.ts` for the precedent) — writing the residue directly
 * proves the sweep, not the fixture.
 */

/** Episode fields this scenario never varies, name once so the 27 calls below read as data. */
function episode(store: MemoryStore, content: string, createdAt: string): number {
  return store.addEpisode({
    tenantId: 'host',
    connector: 'cli',
    threadKey: 'fixture',
    role: 'user',
    kind: 'message',
    content,
    trustTier: 0,
    createdAt,
  });
}

describe('acceptance · C2/C3 · il consolidamento parte da solo e drena', () => {
  scenario(
    'C2',
    async () => {
      const inst = await install({
        main: [{ text: 'capito, hai un gatto di nome Tappo' }],
        light: (request) =>
          request.transcript.includes('un gatto di nome Tappo')
            ? extraction([
                {
                  subject: 'owner',
                  predicate: 'ha un animale di nome',
                  object: 'Tappo',
                  subjectKind: 'person',
                  validFrom: null,
                  confidence: 0.9,
                },
              ])
            : extraction([]),
        env: {
          MUFFIN_GATEWAY_TICK_MS: '200',
          MUFFIN_MEMORY_IDLE_MS: '300',
        },
      });
      try {
        const gateway = await inst.gateway();
        await gateway.waitFor(/muffin gateway/, 20_000);

        const added = await inst.muffin([
          'jobs',
          'add',
          '--cron',
          '0 8 * * *',
          '--channel',
          'cli',
          'ho un gatto di nome Tappo',
        ]);
        if (added.code !== 0) throw new Error(`jobs add: exit ${added.code}\n${added.err}`);

        const w = new DatabaseCtor(join(inst.home, 'muffin.db'));
        w.prepare(`UPDATE jobs SET next_fire_at = ?`).run(new Date(Date.now() - 60_000).toISOString());
        w.close();

        // The turn actually finished and delivered — proof the gateway ran
        // it, not this scenario reaching in by hand.
        await gateway.waitFor(/capito, hai un gatto di nome Tappo/, 30_000);

        // Nobody calls `muffin memory extract`, or anything else, from here
        // on. If the fact shows up, only the trailing-edge debounce put it
        // there — the gateway is the only thing that stayed alive long
        // enough for it to fire.
        let sawFact = false;
        try {
          await until(
            () =>
              inst.db(
                (db) =>
                  (
                    db.prepare(`SELECT count(*) AS n FROM facts WHERE object_value = 'Tappo'`).get() as {
                      n: number;
                    }
                  ).n,
              ) > 0,
            15_000,
            250,
          );
          sawFact = true;
        } catch {
          sawFact = false;
        }
        if (!sawFact) {
          throw new Error(
            'nessun fatto "Tappo" comparso senza che nulla chiamasse `muffin memory extract` — ' +
              'il consolidamento automatico non ha mai girato entro il debounce',
          );
        }

        const lightCalls = inst.provider.requests.filter((r) => /haiku|light/i.test(r.model));
        if (lightCalls.length === 0) {
          throw new Error('il fatto è comparso ma nessuna chiamata al modello leggero è stata registrata');
        }

        await gateway.stop();
      } finally {
        await inst.cleanup();
      }
    },
    45_000,
  );

  scenario(
    'C3',
    async () => {
      const inst = await install({
        main: [{ text: 'ok' }],
        light: (request) => {
          // The judge's own system prompt (`core/memory/judge.ts`), checked
          // first — the same content-matching precedent `e-cost.accept.ts`
          // uses to tell a judge call from an extraction call.
          if (request.transcript.includes('Confronti due affermazioni sullo stesso soggetto')) {
            return {
              text: JSON.stringify({
                reasoning: 'due locali diversi per lo stesso ruolo, non è chiaro se sia un cambio o un elenco',
                verdict: 'review',
                confidence: 0.4,
              }),
            };
          }
          if (request.transcript.includes('è da Mario')) {
            return extraction([
              {
                subject: 'Ristorante preferito',
                predicate: 'è',
                object: 'da Mario',
                subjectKind: 'concept',
                validFrom: null,
                confidence: 0.9,
              },
            ]);
          }
          if (request.transcript.includes('è da Luigi')) {
            return extraction([
              {
                subject: 'Ristorante preferito',
                predicate: 'è',
                object: 'da Luigi',
                subjectKind: 'concept',
                validFrom: null,
                confidence: 0.9,
              },
            ]);
          }
          return extraction([]);
        },
      });
      try {
        let dupOldId: number;
        let dupKeepId: number;
        const db = new DatabaseCtor(join(inst.home, 'muffin.db'));
        try {
          const store = new MemoryStore(db);
          const now = new Date();

          // 25 padding episodes — exactly one full round (`cmdMemoryExtract`'s
          // page is `Math.min(limit, 25)`) — plus the two below, so the
          // backlog spans two rounds and `muffin memory extract` has to loop
          // to actually finish it.
          for (let i = 0; i < 25; i++) {
            episode(store, `giorno ${i}, niente di notevole`, new Date(now.getTime() + i * 1000).toISOString());
          }
          episode(store, 'il mio ristorante preferito è da Mario', new Date(now.getTime() + 25_000).toISOString());
          episode(store, 'il mio ristorante preferito è da Luigi', new Date(now.getTime() + 26_000).toISOString());

          // The dedup residue: two exact duplicates on a subject the two
          // episodes above never touch, written straight through the store —
          // `reconcile` only ever compares an incoming fact to the most
          // recent candidate, so two pre-existing duplicates are never in its
          // view at all. Only `sweepDuplicates`, riding on the batch above
          // adding a fact of its own (`consolidator.ts`'s `factsAdded > 0`
          // gate), ever looks at the whole active set.
          const subjectId = store.upsertEntity('host', 'Bevanda preferita', 'concept', now.toISOString());
          const dupEpisodeId = episode(store, 'fixture dedup', now.toISOString());
          dupOldId = store.addFact({
            tenantId: 'host',
            subjectId,
            predicate: 'è',
            objectValue: 'aranciata',
            episodeId: dupEpisodeId,
            trustTier: 0,
            confidence: 0.9,
            extractionV: 1,
            recordedAt: new Date(now.getTime() - 2000).toISOString(),
          });
          dupKeepId = store.addFact({
            tenantId: 'host',
            subjectId,
            predicate: 'è',
            objectValue: 'aranciata',
            episodeId: dupEpisodeId,
            trustTier: 0,
            confidence: 0.9,
            extractionV: 1,
            recordedAt: new Date(now.getTime() - 1000).toISOString(),
          });
        } finally {
          db.close();
        }

        const extract = await inst.muffin(['memory', 'extract']);
        if (extract.code !== 0) {
          throw new Error(`muffin memory extract: exit ${extract.code}\n${extract.out}\n${extract.err}`);
        }

        // (1) drain a pagina piena: 27 episodi pendenti — più di un giro — e
        // nessuno resta indietro dopo un solo comando.
        const pending = inst.db(
          (d) => (d.prepare(`SELECT count(*) AS n FROM episodes WHERE extraction_v = 0`).get() as { n: number }).n,
        );
        if (pending !== 0) {
          throw new Error(`${pending} episodi ancora pendenti dopo un solo \`memory extract\` — il drenaggio si è fermato al primo giro`);
        }

        // (2) dedup a chiave esatta: dei due fatti "aranciata" identici, ne
        // resta uno solo attivo — l'altro superseded dallo sweep.
        const dup = inst.db(
          (d) =>
            d
              .prepare(`SELECT id, expired_at AS expiredAt, superseded_by AS supersededBy FROM facts WHERE id IN (?, ?)`)
              .all(dupOldId, dupKeepId) as Array<{ id: number; expiredAt: string | null; supersededBy: number | null }>,
        );
        const stillActive = dup.filter((f) => f.expiredAt === null);
        if (stillActive.length !== 1) {
          throw new Error(
            `atteso un solo fatto "aranciata" attivo dopo il drenaggio, trovati ${stillActive.length}: ${JSON.stringify(dup)}`,
          );
        }

        // (3) `muffin memory review`: la contraddizione Mario/Luigi resta
        // aperta (verdetto "review" — nessuna delle due sostituita) e la
        // riga la mostra.
        const review = await inst.muffin(['memory', 'review']);
        if (review.code !== 1) {
          throw new Error(`muffin memory review: atteso exit 1 (una domanda aperta), letto ${review.code}\n${review.out}`);
        }
        if (!review.out.includes('da Mario') || !review.out.includes('da Luigi')) {
          throw new Error(`\`muffin memory review\` non mostra la contraddizione Mario/Luigi:\n${review.out}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});
