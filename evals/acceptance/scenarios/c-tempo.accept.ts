import DatabaseCtor from 'better-sqlite3';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install } from '../harness.js';
import { HEADLESS_TURN_TIMEOUT_SECONDS, headlessTestTimeoutMs } from '../turn-budget.js';
import { scenario } from '../scenario.js';
import { MemoryStore } from '../../../core/memory/store.js';

/**
 * C6 · The temporal graph — "who was X in May".
 *
 * `core/memory/store.ts`'s own `factsAsOf` docstring already carries the
 * worked example this fixture mirrors almost exactly: Anna is the contact
 * from June, Bruno replaces her in August, and asking about May has to
 * return Anna precisely because her world-time window (unknown start, closed
 * at August) contains May while her belief window (recorded June, superseded
 * August) does not — the second disjunct `factsAsOf` needs "at least one
 * stated bound" to fire. Reusing the documented example rather than
 * inventing a fresh one is deliberate: it is the shape the mechanism's own
 * author reasoned through, so a fixture that matches it is evidence the
 * documented reasoning holds against the real database, not just against
 * the prose describing it.
 *
 * Two legs, both through the real binary, matching what the row asks for
 * ("through the CLI ... and/or the `memory_search` tool"):
 *
 *  - the CLI (`muffin memory search ... --as-of`), which is `cli/memory.ts`'s
 *    `cmdMemorySearch` calling `core/memory/recall.ts`'s `recall` with
 *    `asOf`.
 *  - the tool (`agent/tools/memory.ts`'s `memory_search`, `as_of` argument),
 *    driven through a real scripted turn — the consumer `agent/tools/
 *    memory.ts`'s own docstring names as the actual point of the slice that
 *    added it: *"the consumer that decides whether Muffin can answer
 *    'who was my contact in May' is the model, mid-turn"*.
 *
 * **Falsifier**: break either `factsAsOf`'s world-time disjunct (e.g. drop
 * the `f.valid_from IS NOT NULL OR f.valid_to IS NOT NULL` guard, or the
 * `expired_at > at` / `valid_to > at` comparisons) or disconnect `asOf` from
 * `cmdMemorySearch`/`memory_search`'s tool handler, and this goes red: May
 * would return nothing, or would return whoever is current (Bruno) instead
 * of who was there at the time.
 */

describe('acceptance · C6 · il grafo temporale — "chi era X a maggio"', () => {
  scenario(
    'C6',
    async () => {
      const inst = await install({
        main: [
          // The tool leg: the model asks `memory_search` for May, then
          // answers from whatever came back.
          { tool: { name: 'memory_search', args: { query: 'Capo progetto', as_of: '2024-05-15' } } },
          { text: 'a maggio 2024 il capo progetto era Anna' },
        ],
      });
      try {
        let annaId: number;
        let brunoId: number;
        const db = new DatabaseCtor(join(inst.home, 'muffin.db'));
        try {
          const store = new MemoryStore(db);
          const subjectId = store.upsertEntity('host', 'Capo progetto', 'concept', '2024-01-15T00:00:00.000Z');
          const episodeId = store.addEpisode({
            tenantId: 'host',
            connector: 'cli',
            threadKey: 'fixture',
            role: 'user',
            kind: 'message',
            content: 'fixture per C6',
            trustTier: 0,
            createdAt: '2024-01-15T00:00:00.000Z',
          });
          // Nobody said when Anna started (`validFrom: null`) — the exact
          // "one bound unknown" case `factsAsOf`'s docstring reasons about.
          annaId = store.addFact({
            tenantId: 'host',
            subjectId,
            predicate: 'è',
            objectValue: 'Anna',
            episodeId,
            trustTier: 0,
            confidence: 0.9,
            extractionV: 1,
            recordedAt: '2024-01-15T00:00:00.000Z',
          });
          brunoId = store.addFact({
            tenantId: 'host',
            subjectId,
            predicate: 'è',
            objectValue: 'Bruno',
            episodeId,
            trustTier: 0,
            confidence: 0.9,
            extractionV: 1,
            recordedAt: '2024-08-20T00:00:00.000Z',
          });
          // `temporal_scope`-shaped: closes Anna's world at the instant
          // Bruno's begins, the same call `ingest.ts`'s `case 'temporal_scope'`
          // makes when the judge says so.
          store.supersede('host', annaId, brunoId, '2024-08-20T00:00:00.000Z', '2024-08-20T00:00:00.000Z');
        } finally {
          db.close();
        }

        // --- (a) the CLI leg: May returns exactly one result, Anna's — the
        // successor annotation legitimately names Bruno on a second line
        // ("↳ sostituito da"), so the check is on the primary line and on
        // there being exactly one item, not on "Bruno" being absent from the
        // output altogether.
        const may = await inst.muffin(['memory', 'search', 'Capo progetto', '--as-of', '2024-05-15']);
        if (may.code !== 0) throw new Error(`memory search --as-of maggio: exit ${may.code}\n${may.err}`);
        if (!may.out.includes('— è — Anna')) {
          throw new Error(`--as-of 2024-05-15 non ha trovato Anna come credenza primaria:\n${may.out}`);
        }
        if (!/\n1 risultati/.test(may.err)) {
          throw new Error(`--as-of 2024-05-15 non ha restituito esattamente un risultato:\n${may.err}`);
        }

        // --- (b) the CLI leg, after both: October returns Bruno alone —
        // never superseded, so no successor annotation, and no mention of
        // Anna at all.
        const october = await inst.muffin(['memory', 'search', 'Capo progetto', '--as-of', '2024-10-01']);
        if (october.code !== 0) throw new Error(`memory search --as-of ottobre: exit ${october.code}\n${october.err}`);
        if (!october.out.includes('— è — Bruno')) {
          throw new Error(`--as-of 2024-10-01 non ha trovato Bruno:\n${october.out}`);
        }
        if (october.out.includes('Anna')) {
          throw new Error(`--as-of 2024-10-01 ha restituito anche Anna, che a ottobre era già stata sostituita:\n${october.out}`);
        }
        if (!/\n1 risultati/.test(october.err)) {
          throw new Error(`--as-of 2024-10-01 non ha restituito esattamente un risultato:\n${october.err}`);
        }

        // --- (c) the tool leg: a real scripted turn asks `memory_search`
        // with `as_of` for May, and the model's own next request — built
        // from the tool's real result, not a stub — carries Anna into the
        // reply.
        const turn = await inst.muffin(['run', '--session', 'c6', '--timeout', String(HEADLESS_TURN_TIMEOUT_SECONDS), 'chi era il capo progetto a maggio 2024?']);
        if (turn.code !== 0) throw new Error(`run: exit ${turn.code}\n${turn.err}`);

        const afterTool = inst.provider.main()[1];
        if (!afterTool) throw new Error('il turno non ha mai richiamato il modello dopo il tool memory_search');
        if (!afterTool.transcript.includes('Anna')) {
          throw new Error(`il risultato di memory_search(as_of=2024-05-15) non porta "Anna" nel turno successivo:\n${afterTool.transcript}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(1),
  );
});
