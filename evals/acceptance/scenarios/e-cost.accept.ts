import DatabaseCtor from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install } from '../harness.js';
import { extraction } from '../provider.js';
import { scenario } from '../scenario.js';

/**
 * E · Economics and observability.
 *
 * E1 and E2 prove the mechanism that exists today — the **global** monthly
 * cap and the owner-facing spend readout — not the per-job cap E1's row is
 * actually missing (M5-BIS: "il per-job non esiste"). A green scenario here
 * documents that the cap which does exist really stops a turn before it
 * spends; it does not promote E1 to READY, and this suite does not touch that
 * row's text on the strength of it.
 *
 * E5 proves a narrower thing than its own question ("ogni fallimento
 * importante è esplicito e recuperabile?") asks in full, which is why the row
 * stays `?` in M5-BIS.md rather than moving to READY on the strength of one
 * scenario — see the PR this landed in. What it does prove, through the real
 * binary and a scripted-broken light model, never a mock of `judge.ts`: when
 * the contradiction judge answers in a shape the schema cannot read, the
 * owner-facing `muffin memory review` names *why* instead of repeating the
 * one sentence ("giudice non disponibile … tengo entrambi i valori") that
 * gave no way to tell three different problems apart on a real install,
 * 2026-08-16.
 */

describe('acceptance · E · economia e osservabilità', () => {
  scenario(
    'E1',
    async () => {
      const inst = await install({ main: [{ text: 'non dovrebbe mai arrivare qui' }] });
      try {
        // Push the month straight past the $80 cap (defaults/rot/budgets.json)
        // through BudgetEngine's own table shape, without spending anything
        // real — the property under test is the stop, not how the number got
        // there.
        const db = new DatabaseCtor(join(inst.home, 'muffin.db'));
        try {
          const now = new Date();
          db.prepare(
            `INSERT INTO spend (tenant, capability, model, input_tokens, output_tokens, usd, day, month, created_at)
             VALUES ('host', 'model.call', 'test', 0, 0, 85, ?, ?, ?)`,
          ).run(now.toISOString().slice(0, 10), now.toISOString().slice(0, 7), now.toISOString());
        } finally {
          db.close();
        }

        const r = await inst.muffin(['run', '--timeout', '20', 'qualsiasi cosa']);
        if (r.code !== 4) {
          throw new Error(`atteso exit 4 (budget) con il mese già sopra il tetto, trovato ${r.code}\nout: ${r.out}\nerr: ${r.err}`);
        }
        if (!r.out.includes('Budget esaurito')) {
          throw new Error(`la risposta non dice che si è fermato per il budget: ${JSON.stringify(r.out)}`);
        }
        // Stopped *before* spending, not after: the fake provider must never
        // have been called.
        if (inst.provider.requests.length !== 0) {
          throw new Error(`il modello è stato comunque chiamato ${inst.provider.requests.length} volte dopo il tetto`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );

  scenario(
    'E2',
    async () => {
      const inst = await install({ main: [{ text: 'una spesa da leggere dopo' }] });
      try {
        const said = await inst.muffin(['run', '--timeout', '20', 'ciao']);
        if (said.code !== 0) throw new Error(`turno per generare spesa: exit ${said.code}\n${said.err}`);

        // `/spend` is the one owner-facing surface that answers "how much has
        // today cost" in dollars — `doctor`'s "tetto di spesa" check only ever
        // prints the configured cap, never what has actually been spent.
        //
        // The exit code is not asserted here on purpose, and that is itself a
        // finding worth naming rather than silently working around: piping
        // `/spend\n/exit\n` in one write closes stdin at EOF essentially
        // atomically with delivering `/exit`, and `cli/repl.ts`'s `for (;;)`
        // loop then hits a second `rl.question()` against an already-closed
        // stream — observed as Node's own "Detected unsettled top-level await"
        // warning and a non-zero, non-catalogued exit code, not one of the
        // documented ones in `cli/main.ts`'s USAGE. A real terminal never
        // produces that interleaving, so it does not bear on E2's own claim,
        // but a REPL fed from a pipe (a supervisor's health check, a script)
        // is a real caller and deserves its own scenario another day.
        const repl = await inst.muffin(['repl'], '/spend\n/exit\n');
        if (!/\$\d+(\.\d+)? \/ \$80 questo mese/.test(repl.err)) {
          throw new Error(`/spend non ha stampato una cifra leggibile in dollari: ${JSON.stringify(repl.err)}`);
        }
        if (/\$0(\.0+)? \/ \$80/.test(repl.err)) {
          throw new Error(`/spend mostra $0 dopo un turno che ha speso — non sta leggendo la spesa reale: ${repl.err}`);
        }

        // M5-BIS's E2 asks "so quanto costa una giornata?", not "so quanto
        // costa il mese?" -- tenantTodayUsd('host') existed in
        // core/budget/budget.ts with no caller: the per-tenant-daily gate
        // excludes the owner outright, so nothing ever read the number back.
        // Parsed and compared numerically, not with a second all-zeros regex:
        // `\b` right after an optional `(\.0+)?` already matches a bare "$0"
        // prefix, because the "." that follows is itself a word boundary --
        // the month check above avoids exactly this by anchoring on the
        // literal " / $80" that has to follow.
        const oggi = /oggi: \$(\d+(?:\.\d+)?)/.exec(repl.err);
        if (!oggi) {
          throw new Error(`/spend non stampa una riga "oggi": ${JSON.stringify(repl.err)}`);
        }
        if (Number(oggi[1]) === 0) {
          throw new Error(`/spend mostra "oggi: $0" dopo un turno che ha speso oggi: ${repl.err}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );

  scenario(
    'E5',
    async () => {
      const brokenJudgeAnswer = 'mi dispiace, non sono sicuro di questo caso';
      // Extraction calls, counted rather than matched on the episode content:
      // `extract.ts`'s own SYSTEM prompt quotes "Marco è il mio commercialista"
      // verbatim as its worked example for rule 5, so a content match against
      // the *whole* transcript finds that example on every single extraction
      // call, real episode or not — the exact class of test bug JUDGE.md warns
      // about ("un test asseriva una parola presente nel boilerplate
      // circostante"). `ingestPending` extracts oldest-episode-first in one
      // sequential loop (`core/memory/ingest.ts`), so counting is exact: the
      // first extraction call is always turn one's statement, the second is
      // turn two's correction.
      let extractionCalls = 0;
      const inst = await install({
        main: [{ text: 'capito, Marco è il tuo commercialista' }, { text: 'capito, ora è Lucia' }],
        light: (request) => {
          // Judge calls open with a sentence that exists nowhere in
          // extract.ts, so this one is safe to match on content.
          if (request.transcript.includes('Confronti due affermazioni sullo stesso soggetto')) {
            // Prose, no JSON at all — the exact shape `judge.ts` calls
            // `non_json`, and the one an owner actually hit on 2026-08-16.
            return { text: brokenJudgeAnswer };
          }
          extractionCalls += 1;
          return extractionCalls === 1
            ? extraction([
                { subject: 'owner', predicate: 'accountant', object: 'Marco', subjectKind: 'person', validFrom: null, confidence: 0.9 },
              ])
            : extraction([
                { subject: 'owner', predicate: 'accountant', object: 'Lucia', subjectKind: 'person', validFrom: null, confidence: 0.9 },
              ]);
        },
      });
      try {
        const first = await inst.muffin(['run', '--timeout', '20', 'Marco è il mio commercialista']);
        if (first.code !== 0) throw new Error(`primo turno: exit ${first.code}\n${first.err}`);
        const second = await inst.muffin(['run', '--timeout', '20', 'ho cambiato commercialista, ora è Lucia']);
        if (second.code !== 0) throw new Error(`secondo turno: exit ${second.code}\n${second.err}`);

        // `muffin run` headless never consolidates on its own (the idle timer
        // is unref'd) — the manual drain goes through the identical
        // `Consolidator.runNow()` path `cli/memory.ts` documents, so this is
        // not a second mechanism from the automatic one.
        //
        // Exit 1 here is correct, not a symptom: `cmdMemoryExtract` counts a
        // judge failure as a problem the same way it counts any other
        // (`cli/memory.ts`), and a round with one real problem should say so.
        const extract = await inst.muffin(['memory', 'extract']);
        if (extract.code !== 1) {
          throw new Error(`muffin memory extract: atteso exit 1 (un problema reale), trovato ${extract.code}\nout: ${extract.out}\nerr: ${extract.err}`);
        }
        // The manual drain's own summary line is the grouped one
        // (`formatConsolidationLines`), not the ungrouped `report.errors` —
        // proven here, not assumed, since only one candidate failed and the
        // multiplier only appears above one. Exactly once, not twice: before
        // the fix in this same PR, `cmdMemoryExtract`'s own summary loop and
        // `Consolidator.execute()`'s internal logger both printed it —
        // `Consolidator.execute()` now stays quiet on `trigger: 'manual'`
        // because this caller already holds the report and prints it below.
        const judgeLineHits = extract.err.split('giudice non disponibile su owner/accountant').length - 1;
        if (judgeLineHits !== 1) {
          throw new Error(
            `la riga di consolidamento dovrebbe comparire una volta sola, trovata ${judgeLineHits} volte: ${JSON.stringify(extract.err)}`,
          );
        }
        if (!extract.err.includes('giudice non disponibile su owner/accountant — vedi muffin memory review')) {
          throw new Error(`la riga di consolidamento non è quella attesa: ${JSON.stringify(extract.err)}`);
        }
        if (/×\d/.test(extract.err)) {
          throw new Error(`un solo candidato non dovrebbe portare un moltiplicatore: ${JSON.stringify(extract.err)}`);
        }

        const quiet = await inst.muffin(['memory', 'review']);
        if (quiet.code !== 0) {
          throw new Error(`muffin memory review: exit ${quiet.code}\nout: ${quiet.out}\nerr: ${quiet.err}`);
        }
        if (!quiet.out.includes('giudice non disponibile su owner/accountant')) {
          throw new Error(`la riga non nomina il fallimento del giudice: ${JSON.stringify(quiet.out)}`);
        }
        // The typed reason is on the default view; the model's own words are
        // deliberately not, until asked for them.
        if (!quiet.out.includes('[non-json]')) {
          throw new Error(`la ragione tipizzata non è sulla riga per default: ${JSON.stringify(quiet.out)}`);
        }
        if (quiet.out.includes('risposta grezza')) {
          throw new Error(`la risposta grezza appare senza --verbose: ${JSON.stringify(quiet.out)}`);
        }

        const verbose = await inst.muffin(['memory', 'review', '--verbose']);
        if (verbose.code !== 0) {
          throw new Error(`muffin memory review --verbose: exit ${verbose.code}\nout: ${verbose.out}\nerr: ${verbose.err}`);
        }
        if (!verbose.out.includes('risposta grezza')) {
          throw new Error(`--verbose non aggiunge la risposta grezza: ${JSON.stringify(verbose.out)}`);
        }
        if (!verbose.out.includes(brokenJudgeAnswer)) {
          throw new Error(
            `--verbose non mostra le parole del modello ("${brokenJudgeAnswer}"): ${JSON.stringify(verbose.out)}`,
          );
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );

  /**
   * E3, the P34-2 half: ADR-0048's write-boundary redaction, through the real
   * binary and the real home database — not `runTurn()` with a fake
   * `TurnStore`, which is what `agent/secret-redaction.test.ts` already
   * covers at the unit level. The owner's own file, planted on disk exactly
   * as `fs_read` would find one it did not write, is the realistic case this
   * slice exists for: a key pasted into a note, read back later.
   */
  scenario(
    'E3',
    async () => {
      const SECRET = 'sk-ant-FINTA-CHIAVE-ACCETTAZIONE-1234567890';
      const inst = await install({
        main: [{ tool: { name: 'fs_read', args: { path: 'appunti.txt' } } }, { text: 'letto' }],
      });
      try {
        writeFileSync(join(inst.workspace, 'appunti.txt'), `password: "${SECRET}"\naltro testo innocuo\n`);

        const r = await inst.muffin(['run', '--timeout', '20', 'leggi appunti.txt']);
        if (r.code !== 0) throw new Error(`il turno non completa: exit ${r.code}\n${r.err}`);
        if (r.out.includes(SECRET)) {
          throw new Error(`la chiave finta è arrivata nella risposta finale: ${JSON.stringify(r.out)}`);
        }

        const call = inst.db(
          (db) =>
            db
              .prepare(`SELECT content FROM turn_tool_calls WHERE tool = 'fs_read' ORDER BY started_at DESC LIMIT 1`)
              .get() as { content: string | null } | undefined,
        );
        if (!call) throw new Error('nessuna fs_read registrata');
        if ((call.content ?? '').includes(SECRET)) {
          throw new Error(`turn_tool_calls.content porta la chiave in chiaro: ${JSON.stringify(call.content)}`);
        }
        if (!(call.content ?? '').includes('«redacted:')) {
          throw new Error(`nessun marcatore di redazione nel content registrato: ${JSON.stringify(call.content)}`);
        }

        const turnRow = inst.db(
          (db) => db.prepare(`SELECT messages FROM turns ORDER BY created_at DESC LIMIT 1`).get() as { messages: string },
        );
        if (turnRow.messages.includes(SECRET)) {
          throw new Error('turns.messages porta la chiave in chiaro');
        }
      } finally {
        await inst.cleanup();
      }
    },
    20_000,
  );
});
