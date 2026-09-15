import DatabaseCtor from 'better-sqlite3';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install } from '../harness.js';
import { HEADLESS_TURN_TIMEOUT_SECONDS, headlessTestTimeoutMs } from '../turn-budget.js';
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
 *
 * The subject is a **capitalised** name ("Ristorante preferito") on purpose,
 * not styling: a fact written straight through `store.addFact` is never
 * embedded (the backlog indexing in `core/memory/ingest.ts` is what would do
 * that, and this fixture deliberately skips it — see C1's docstring above for
 * why), and `searchEpisodes` (the text half) never returns facts at all — so
 * the one-hop graph expansion is the only path that can reach this fact, and
 * `extractCandidateNames` (`core/memory/recall.ts`) only takes a capitalised
 * word from the query as a candidate. A lower-case query is a real, separate
 * gap (an owner typing "il mio ristorante preferito" would not get this hop
 * today) — this scenario is about C4's own claim, superseded-fact recall on
 * the graph path, not about candidate extraction.
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
        const said = await inst.muffin(['run', '--session', 'c1-a', '--timeout', String(HEADLESS_TURN_TIMEOUT_SECONDS), 'ho un pesce rosso, si chiama Bolla']);
        if (said.code !== 0) throw new Error(`primo turno: exit ${said.code}\n${said.err}`);

        // A brand-new, unrelated session: nothing but the tenant ('host', both
        // CLI turns) connects the two. If this recalls "Bolla" it is memory
        // doing it, not session transcript (that is B1's separate claim).
        const asked = await inst.muffin(['run', '--session', 'c1-b', '--timeout', String(HEADLESS_TURN_TIMEOUT_SECONDS), 'come si chiama il mio pesce?']);
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
    headlessTestTimeoutMs(2),
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
          subjectId = store.upsertEntity('host', 'Ristorante preferito', 'concept', now);
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

        const current = await inst.muffin(['memory', 'search', 'Ristorante preferito']);
        if (current.code !== 0) throw new Error(`ricerca senza --history: exit ${current.code}\n${current.err}`);
        if (!current.out.includes('da Luigi')) {
          throw new Error(`la ricerca ordinaria non trova nemmeno il fatto attivo:\n${current.out}`);
        }

        // The desired property: `--history` surfaces the retired belief too —
        // "da Mario" should appear somewhere in the --history output even
        // though the fact is expired.
        const withHistory = await inst.muffin(['memory', 'search', 'Ristorante preferito', '--history']);
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

  /**
   * C5 · Provenance — "posso capire perché crede una cosa?"
   *
   * The row's own text named the exact gap: `muffin memory why`
   * (`cli/memory.ts`'s `cmdMemoryWhy`) already answered this for the owner at
   * a terminal, but `agent/tools/memory.ts` registered only
   * `memorySearchSpec` — the model asked "why do you think that" mid-turn had
   * no tool that could answer with anything but a narrated guess. This drives
   * the new `memory_why` tool through a real scripted turn, and — same
   * reasoning as C4's fixture above — plants the fact through `MemoryStore`'s
   * own real `addFact`/`addEpisode`, with a capitalised subject
   * ("Colore preferito") so the one-hop graph path `memory_why`'s
   * text lookup rides on (the same path C4/C6 exercise) can actually reach
   * it.
   *
   * What is under test is that the tool's *real* result — not a stub —
   * carries the planted provenance across the process boundary and into the
   * next request the model actually receives: the connector the episode was
   * learned on (`discord`), its real trust tier (`tier 1`), and the
   * original sentence verbatim, character for character, never a
   * paraphrase. The CLI leg proves the other door reads the identical row
   * through the same `describeProvenance` (`core/memory/provenance.ts`) —
   * one renderer behind both, not two that could quietly disagree.
   *
   * The `muffin run` prompt is deliberately worded with **no** word from the
   * planted episode ("colore", "preferito", "verde", "smeraldo") and no
   * capitalised word: `agent/loop.ts` runs its own automatic pre-turn recall
   * against the raw incoming message before the model sees anything, and
   * that recall's text half matches on exactly this kind of keyword overlap
   * (measured while writing this scenario — a prompt that repeated the
   * fact's own words made the assertions pass whether or not `memory_why`
   * ever ran, because the ordinary recall block already carried the
   * connector and the sentence). Keeping the two vocabularies disjoint is
   * what makes `afterTool.transcript` a clean witness of the tool call
   * specifically, not of the recall every turn already gets for free.
   *
   * **Falsifier**: comment out `memory_why`'s registration in
   * `agent/runtime.ts` (keep the tool file) and the tool leg goes red — the
   * model is never offered `memory_why`, so the fake provider's script
   * (which only knows how to answer a `memory_why` call) has nothing to
   * react to and the turn either errors or never reaches a second request.
   */
  scenario(
    'C5',
    async () => {
      const inst = await install({
        main: [
          // No fact_id in hand — the ordinary case, since `memory_search`'s
          // rendered block never prints one either. The model asks by text.
          { tool: { name: 'memory_why', args: { query: 'Colore preferito' } } },
          { text: 'il tuo colore preferito, per quanto mi hai detto, è verde smeraldo' },
        ],
      });
      try {
        let factId: number;
        const db = new DatabaseCtor(join(inst.home, 'muffin.db'));
        try {
          const store = new MemoryStore(db);
          const now = '2026-06-01T10:00:00.000Z';
          const subjectId = store.upsertEntity('host', 'Colore preferito', 'concept', now);
          const episodeId = store.addEpisode({
            tenantId: 'host',
            connector: 'discord',
            threadKey: 'fixture',
            role: 'user',
            kind: 'message',
            content: 'il mio colore preferito è il verde smeraldo',
            trustTier: 1,
            createdAt: now,
          });
          factId = store.addFact({
            tenantId: 'host',
            subjectId,
            predicate: 'è',
            objectValue: 'verde smeraldo',
            episodeId,
            trustTier: 1,
            confidence: 0.9,
            extractionV: 1,
            recordedAt: now,
          });
        } finally {
          db.close();
        }

        // --- (a) the CLI leg: `describeProvenance`'s other door, same rows.
        const why = await inst.muffin(['memory', 'why', String(factId)]);
        if (why.code !== 0) throw new Error(`memory why: exit ${why.code}\n${why.err}`);
        if (!why.out.includes('discord')) {
          throw new Error(`muffin memory why non nomina il connettore reale ("discord"):\n${why.out}`);
        }
        if (!why.out.includes('tier 1')) {
          throw new Error(`muffin memory why non nomina la tier reale ("tier 1"):\n${why.out}`);
        }
        if (!why.out.includes('il mio colore preferito è il verde smeraldo')) {
          throw new Error(`muffin memory why non riporta la frase originale:\n${why.out}`);
        }

        // --- (b) the tool leg: a real scripted turn asks `memory_why` by
        // text, and the model's own next request — built from the tool's
        // real result — carries the planted provenance forward.
        const turn = await inst.muffin([
          'run',
          '--session',
          'c5',
          '--timeout',
          '20',
          'perché sostieni una cosa su di me di cui non ricordo di averti parlato?',
        ]);
        if (turn.code !== 0) throw new Error(`run: exit ${turn.code}\n${turn.err}`);

        const afterTool = inst.provider.main()[1];
        if (!afterTool) throw new Error('il turno non ha mai richiamato il modello dopo il tool memory_why');
        if (!afterTool.transcript.includes('discord')) {
          throw new Error(
            `il risultato di memory_why non porta il connettore ("discord") nel turno successivo:\n${afterTool.transcript}`,
          );
        }
        if (!afterTool.transcript.includes('tier 1')) {
          throw new Error(
            `il risultato di memory_why non porta la tier reale ("tier 1") nel turno successivo:\n${afterTool.transcript}`,
          );
        }
        if (!afterTool.transcript.includes('il mio colore preferito è il verde smeraldo')) {
          throw new Error(
            `il risultato di memory_why non porta la frase originale nel turno successivo:\n${afterTool.transcript}`,
          );
        }
      } finally {
        await inst.cleanup();
      }
    },
    headlessTestTimeoutMs(1),
  );
});
