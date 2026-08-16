import DatabaseCtor from 'better-sqlite3';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install } from '../harness.js';
import { scenario } from '../scenario.js';
import { MemoryStore } from '../../../core/memory/store.js';

/**
 * C · Memory and acquisition.
 *
 * C1 and C4 are deliberately different mechanisms inside `core/memory/`, not
 * the same assertion twice: C1 is acquisition-and-recall through a live turn
 * (`agent/loop.ts` calling `recall` on every turn — verified by reading the
 * call site, not assumed), and it has to work on episodes alone, because
 * `muffin run` headless never consolidates (`STATE.md`: "il timer è
 * unref'd") — extraction is not on this path. C4 is specifically about a
 * *superseded* fact, which does need the extraction/contradiction machinery
 * that produces one; driving that machinery through two more live turns would
 * make the scenario about the judge instead of about recall, so the two
 * fact rows are written directly with `MemoryStore`'s own real methods — the
 * same production code the judge itself calls, just without needing a second
 * scripted model round-trip to reach it. What is under test here is the read
 * side: whether `--history` surfaces the retired one.
 */

describe('acceptance · C · memoria e acquisizione', () => {
  scenario(
    'C1',
    async () => {
      const inst = await install({
        main: [
          { text: 'capito, hai un pesce rosso di nome Bolla' },
          { text: 'mi avevi detto Bolla' },
        ],
      });
      try {
        const said = await inst.muffin(['run', '--session', 'c1-a', '--timeout', '20', 'ho un pesce rosso, si chiama Bolla']);
        if (said.code !== 0) throw new Error(`primo turno: exit ${said.code}\n${said.err}`);

        // A brand-new, unrelated session: nothing but the tenant ('host', both
        // CLI turns) connects the two. If this recalls "Bolla" it is memory
        // doing it, not session transcript (that is B1's separate claim).
        const asked = await inst.muffin(['run', '--session', 'c1-b', '--timeout', '20', 'come si chiama il mio pesce?']);
        if (asked.code !== 0) throw new Error(`secondo turno: exit ${asked.code}\n${asked.err}`);

        const sentToSecondTurn = inst.provider.main()[1];
        if (!sentToSecondTurn) throw new Error('il secondo turno non ha mai chiamato il modello');
        if (!sentToSecondTurn.transcript.includes('Bolla')) {
          throw new Error(
            `il richiamo di memoria non ha portato "Bolla" nel turno successivo — cosa ha visto il modello:\n${sentToSecondTurn.transcript}`,
          );
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );

  scenario(
    'C4',
    async () => {
      const inst = await install({ main: [{ text: 'ecco cosa so' }] });
      try {
        // Fixture: a fact, then a second one that supersedes it — through
        // MemoryStore's own real insert/supersede methods (the same ones
        // core/memory/consolidator.ts's judge calls), not a hand-written SQL
        // shape that could drift from the real schema.
        const db = new DatabaseCtor(join(inst.home, 'muffin.db'));
        let subjectId: number;
        let oldFactId: number;
        try {
          const store = new MemoryStore(db);
          const now = new Date().toISOString();
          const episodeId = store.addEpisode({
            tenantId: 'host',
            connector: 'cli',
            threadKey: 'fixture',
            role: 'user',
            kind: 'message',
            content: 'fixture per C4',
            trustTier: 0,
            createdAt: now,
          });
          subjectId = store.upsertEntity('host', 'il ristorante preferito', 'concept', now);
          oldFactId = store.addFact({
            tenantId: 'host',
            subjectId,
            predicate: 'è',
            objectValue: 'da Mario',
            episodeId,
            trustTier: 0,
            confidence: 0.9,
            extractionV: 1,
            recordedAt: now,
          });
          const newFactId = store.addFact({
            tenantId: 'host',
            subjectId,
            predicate: 'è',
            objectValue: 'da Luigi',
            episodeId,
            trustTier: 0,
            confidence: 0.9,
            extractionV: 1,
            recordedAt: now,
          });
          store.supersede('host', oldFactId, newFactId, now);
        } finally {
          db.close();
        }

        const current = await inst.muffin(['memory', 'search', 'ristorante preferito']);
        if (current.code !== 0) throw new Error(`ricerca senza --history: exit ${current.code}\n${current.err}`);
        if (!current.out.includes('da Luigi')) {
          throw new Error(`la ricerca ordinaria non trova nemmeno il fatto attivo:\n${current.out}`);
        }

        // The desired property: `--history` surfaces the retired belief too —
        // "da Mario" should appear somewhere in the --history output even
        // though the fact is expired.
        const withHistory = await inst.muffin(['memory', 'search', 'ristorante preferito', '--history']);
        if (withHistory.code !== 0) throw new Error(`ricerca con --history: exit ${withHistory.code}\n${withHistory.err}`);
        if (!withHistory.out.includes('da Mario')) {
          throw new Error(
            `--history non ha ritrovato il fatto superato ("da Mario") — output:\n${withHistory.out}`,
          );
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});
