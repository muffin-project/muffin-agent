import DatabaseCtor from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install, until, type Run } from '../harness.js';
import { extraction } from '../provider.js';
import { scenario } from '../scenario.js';

/**
 * E · Economics and observability.
 *
 * E1 covers **both** caps its row asks for — "cap globale e per-job" — since
 * `slice/e1-budget-per-job`. Half (a) is the one that always existed: the
 * global monthly cap stopping an interactive turn before it spends. Half (b)
 * is the one the row called missing: a scheduled job with a ceiling of its
 * own, already past it, that never reaches the model at all.
 *
 * Half (b) runs through the **gateway**, not by calling `makeJobRunner` by
 * hand, and the job is created by the real `muffin jobs add --per-job-usd`.
 * That is the whole point of putting it here rather than leaving it to
 * `agent/scheduler-run.test.ts`: a unit test proves the mechanism, and this
 * repository's recorded failure mode is a mechanism that works and that
 * production never reaches. The evidence is `inst.provider.main()` being
 * empty — the absence of an HTTP request that would have been recorded if
 * there had been one — while the job's own turn row says, durably, why.
 *
 * E5 proves a narrower thing than its own question ("ogni fallimento
 * importante è esplicito e recuperabile?") asks in full, which is why the row
 * stays `?` in requirements-status.md rather than moving to READY on the strength of one
 * scenario — see the PR this landed in. What it does prove, through the real
 * binary and a scripted-broken light model, never a mock of `judge.ts`: when
 * the contradiction judge answers in a shape the schema cannot read, the
 * owner-facing `muffin memory review` names *why* instead of repeating the
 * one sentence ("giudice non disponibile … tengo entrambi i valori") that
 * gave no way to tell three different problems apart on a real install,
 * 2026-08-16.
 */

/**
 * E1, metà (b): il tetto per-job, sul gateway vero.
 *
 * Il giro è quello di un owner: `muffin jobs add --per-job-usd`, una spesa già
 * attribuita a quel job nel registro, l'occorrenza portata a scadenza, il
 * gateway che la raccoglie. Le tre asserzioni che contano, in ordine di forza:
 *
 *  1. **`inst.provider.main()` è vuoto.** Il modello non è stato chiamato. Non
 *     è un'interpretazione: è l'assenza di una richiesta HTTP che sarebbe
 *     stata registrata. Se l'enforcement in `agent/scheduler-run.ts` sparisce,
 *     questa riga diventa rossa con un `1` in mano — ed è la mutazione con cui
 *     questa slice è stata verificata.
 *  2. **La riga del turno è durevole e nomina il tetto**: esito `budget`,
 *     modello `(tetto per-job: nessun modello)`, contatori a zero. Un job
 *     fermato che non lascia traccia è indistinguibile da un job che gira e
 *     non trova niente da dire.
 *  3. **L'owner lo sente** sul canale del job, e `muffin jobs list` lo mostra.
 */
async function tettoPerJob(): Promise<void> {
  const inst = await install({
    // Canarino, non copione: se il modello venisse chiamato, questa risposta
    // comparirebbe nell'output del gateway.
    main: [{ text: 'QUESTA RISPOSTA NON DEVE MAI COMPARIRE' }],
    env: { MUFFIN_GATEWAY_TICK_MS: '300' },
  });
  try {
    const gateway = await inst.gateway();
    await gateway.waitFor(/muffin gateway/, 20_000);

    // Un job a obiettivo — quindi uno che il modello *dovrebbe* vedere — con
    // un tetto minuscolo, creato dalla porta vera.
    const creato = await inst.muffin([
      'jobs',
      'add',
      '--cron',
      '0 8 * * *',
      '--channel',
      'cli',
      '--per-job-usd',
      '0.01',
      'riassumi la giornata',
    ]);
    if (creato.code !== 0) throw new Error(`jobs add --per-job-usd: exit ${creato.code}\n${creato.err}`);
    if (!creato.out.includes('tetto $0.01/mese')) {
      throw new Error(`add non conferma il tetto: ${JSON.stringify(creato.out)}`);
    }

    const jobId = inst.db((d) => (d.prepare(`SELECT id FROM jobs`).get() as { id: string }).id);

    // La spesa già fatta da QUESTO job, sopra il suo tetto e ben sotto quello
    // mensile globale ($80): se il job si fermasse, senza questa distinzione,
    // per il tetto globale, lo scenario non proverebbe niente di nuovo.
    const w = new DatabaseCtor(join(inst.home, 'muffin.db'));
    const now = new Date();
    w.prepare(
      `INSERT INTO spend (tenant, capability, model, input_tokens, output_tokens, usd, day, month, job_id, created_at)
       VALUES ('host', 'llm.chat', 'test', 10, 10, 0.5, ?, ?, ?, ?)`,
    ).run(now.toISOString().slice(0, 10), now.toISOString().slice(0, 7), jobId, now.toISOString());
    // E l'occorrenza diventa dovuta.
    w.prepare(`UPDATE jobs SET next_fire_at = ?`).run(new Date(Date.now() - 60_000).toISOString());
    w.close();

    // Si aspetta che l'occorrenza sia **conclusa**, non che il gateway abbia
    // scritto una frase: se l'enforcement sparisse, aspettare la frase
    // scadrebbe in timeout e il rosso direbbe "nessuna riga sullo stderr" —
    // vero ma muto. Un turno `done` c'è in entrambi i mondi, e le asserzioni
    // che seguono possono quindi dire QUALE dei due si sta guardando.
    await until(
      () =>
        inst.db(
          (d) => (d.prepare(`SELECT COUNT(*) AS n FROM turns WHERE status = 'done'`).get() as { n: number }).n,
        ) >= 1,
      60_000,
    );

    // (1) Il modello non è mai stato chiamato. È LA proprietà.
    const chiamate = inst.provider.main();
    if (chiamate.length !== 0) {
      throw new Error(
        `il modello è stato chiamato ${chiamate.length} volte per un job già oltre il proprio tetto ` +
          `— l'enforcement per-job non è sul percorso di produzione`,
      );
    }
    const visto = `${gateway.stdout()}${gateway.stderr()}`;
    if (visto.includes('NON DEVE MAI COMPARIRE')) {
      throw new Error(`la risposta del modello è arrivata all'owner: il job è partito comunque\n${visto}`);
    }

    // (2) La riga durevole, e dice perché.
    const turni = inst.db(
      (d) =>
        d.prepare(`SELECT model, turn_outcome, counters, job_id, messages FROM turns`).all() as Array<{
          model: string;
          turn_outcome: string | null;
          counters: string;
          job_id: string | null;
          messages: string;
        }>,
    );
    if (turni.length !== 1) throw new Error(`atteso un solo turno per l'occorrenza, trovati ${turni.length}`);
    const riga = turni[0]!;
    if (riga.turn_outcome !== 'budget') throw new Error(`esito atteso "budget", trovato ${riga.turn_outcome}`);
    if (!riga.model.includes('tetto per-job')) {
      throw new Error(`la riga non dichiara di non aver visto il modello: model=${JSON.stringify(riga.model)}`);
    }
    if (riga.job_id !== jobId) throw new Error(`la riga non è attribuita al job: job_id=${riga.job_id}`);
    const counters = JSON.parse(riga.counters) as { spentUsd?: number; usage?: { inputTokens: number } };
    if (counters.spentUsd !== 0 || counters.usage?.inputTokens !== 0) {
      throw new Error(`il turno rifiutato dichiara una spesa: ${riga.counters}`);
    }
    if (!riga.messages.includes('tetto per-job')) {
      throw new Error(`il testo durevole non nomina il tetto: ${riga.messages}`);
    }

    // (3) E l'owner lo sente: il rifiuto arriva sul canale del job, e la
    //     lista lo mostra col conto accanto al tetto.
    await gateway.waitFor(/tetto per-job/, 30_000);
    const lista = await inst.muffin(['jobs', 'list']);
    if (!lista.out.includes('tetto $0.01/mese') || !lista.out.includes('raggiunto: non parte')) {
      throw new Error(`jobs list non mostra tetto e spesa: ${JSON.stringify(lista.out)}`);
    }

    await gateway.stop();
  } finally {
    await inst.cleanup();
  }
}

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

      // --- (b) il tetto PER-JOB: un job che ha già speso il suo non parte.
      await tettoPerJob();
    },
    180_000,
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

        // DAY-1 requirement E2 asks "so quanto costa una giornata?", not "so quanto
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
   *
   * Extended (slice/journey-lifecycle): the row's own question is broader
   * than secret redaction ("posso ricostruire cosa è successo?"), and
   * `report.ts`'s manifest is 1:1 with a row (`verdictFor`'s own comment: "one
   * scenario per row today"), so the second half lands in this same function
   * rather than a second `scenario('E3', …)` that would just make `chiaviEsito`
   * ambiguous. Two turns run in the same install, each with a distinct,
   * unambiguous tool call (`fs_read` for the first, `fs_list` for the
   * second), and `muffin trace turn <id>`/`muffin trace grep` are asked to
   * reconstruct the SECOND one by the id it printed for itself. The
   * assertion that actually matters is not "the command found something" —
   * `trace tail` alone would pass that trivially — it is that the
   * reconstruction is scoped to the one turn asked for: the first turn's
   * tool never shows up in it, and the id the turn printed for itself is
   * what the CLI accepts back (dogfood, 26/08/2026: the printed id and the
   * accepted id used to be compared under different rules).
   */
  scenario(
    'E3',
    async () => {
      const SECRET = 'sk-ant-FINTA-CHIAVE-ACCETTAZIONE-1234567890';
      const inst = await install({
        main: [
          { tool: { name: 'fs_read', args: { path: 'appunti.txt' } } },
          { text: 'letto' },
          { tool: { name: 'fs_list', args: { path: 'una-sottocartella' } } },
          { text: 'elencato' },
        ],
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

        // --- reconstruction: an arbitrary (second) turn, found again by its
        //     own printed id, and only that turn's evidence ------------------
        mkdirSync(join(inst.workspace, 'una-sottocartella'), { recursive: true });
        const second = await inst.muffin(['run', '--timeout', '20', 'elenca il contenuto di una-sottocartella']);
        if (second.code !== 0) throw new Error(`il secondo turno non completa: exit ${second.code}\n${second.err}`);

        const traceIdOf = (run: Run): string => {
          const m = /trace ([0-9a-f]+)/.exec(run.err);
          if (!m) throw new Error(`nessun trace id nell'output del turno: ${JSON.stringify(run.err)}`);
          return m[1]!;
        };
        const traceA = traceIdOf(r);
        const traceB = traceIdOf(second);
        if (traceA === traceB) throw new Error('i due turni condividono lo stesso trace id — fixture inutile');

        // `trace turn <id>` — the id the SECOND turn printed for itself.
        const turnB = await inst.muffin(['trace', 'turn', traceB]);
        if (turnB.code !== 0) throw new Error(`muffin trace turn ${traceB}: exit ${turnB.code}\n${turnB.out}${turnB.err}`);
        if (!turnB.out.includes('fs_list')) {
          throw new Error(`\`trace turn\` non ricostruisce la tool call del secondo turno (fs_list): ${turnB.out}`);
        }
        if (turnB.out.includes('fs_read')) {
          throw new Error(`\`trace turn\` del secondo turno include anche lo step del primo (fs_read) — non isola il turno chiesto: ${turnB.out}`);
        }

        // The same isolation, the other direction — proves it is not an
        // accident of which turn happened to run last.
        const turnA = await inst.muffin(['trace', 'turn', traceA]);
        if (turnA.code !== 0) throw new Error(`muffin trace turn ${traceA}: exit ${turnA.code}\n${turnA.out}${turnA.err}`);
        if (!turnA.out.includes('fs_read')) throw new Error(`\`trace turn\` non ricostruisce la tool call del primo turno (fs_read): ${turnA.out}`);
        if (turnA.out.includes('fs_list')) {
          throw new Error(`\`trace turn\` del primo turno include anche lo step del secondo (fs_list): ${turnA.out}`);
        }

        // `trace grep PATTERN` — the other reconstruction path the row names,
        // searched by content rather than by id.
        const grepped = await inst.muffin(['trace', 'grep', 'fs_list']);
        if (grepped.code !== 0) throw new Error(`muffin trace grep fs_list: exit ${grepped.code}\n${grepped.out}${grepped.err}`);
        if (!grepped.out.includes('fs_list')) throw new Error(`\`trace grep fs_list\` non trova lo span atteso: ${grepped.out}`);
        if (grepped.out.includes('fs_read')) {
          throw new Error(`\`trace grep fs_list\` ha trovato anche uno span del primo turno: ${grepped.out}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    20_000,
  );

  /**
   * E7 — self-inspection: distingue architettura/progetto da stato live
   * dell'istanza, o recita design decaduto?
   *
   * `sys_inspect` (`agent/tools/inspect.ts`) è atterrato (#176) e legge dalle
   * stesse fonti autorevoli di `doctor`/`prompt show` — mai una seconda
   * risposta ricalcolata. Il gap che rendeva la riga BLOCKER non era il
   * meccanismo (quello ha 21 chiamate reali nel `muffin.db` dell'owner), era
   * l'assenza di uno scenario di accettazione: nessuno aveva mai chiesto,
   * attraverso il binario reale, "recita ancora lo stato vecchio dopo che una
   * condizione reale è cambiata?" — che è esattamente la domanda con cui la
   * riga stessa chiude l'acceptance criteria.
   *
   * La condizione fatta cambiare qui è il modello main (`muffin model main
   * <slug>`): con un endpoint fuori catalogo (il provider finto lo è sempre)
   * `cmdModel` scrive lo slug senza poterlo verificare — nessuna chiamata di
   * rete, nessuna approvazione, la scelta più economica e deterministica fra
   * le condizioni che il report nomina esplicitamente ("modello ... in uso").
   */
  scenario(
    'E7',
    async () => {
      const inst = await install({
        main: [
          { tool: { name: 'sys_inspect', args: {} } },
          { text: 'ecco lo stato di questa istanza' },
          { tool: { name: 'sys_inspect', args: {} } },
          { text: 'ecco lo stato aggiornato' },
        ],
      });
      try {
        const first = await inst.muffin(['run', '--timeout', '20', 'spiegami tecnicamente come funzioni e cosa stai usando adesso']);
        if (first.code !== 0) throw new Error(`primo turno: exit ${first.code}\n${first.err}`);

        // Il tool_result di sys_inspect viaggia dentro la SECONDA richiesta al
        // modello finto (la prima è quella che ha chiesto sys_inspect).
        const beforeCalls = inst.provider.main();
        if (beforeCalls.length < 2) {
          throw new Error(`atteso un secondo giro dopo sys_inspect, chiamate: ${beforeCalls.length}`);
        }
        const before = beforeCalls[1]!.transcript;
        if (!before.includes('modello: anthropic/claude-sonnet-5 (main)')) {
          throw new Error(`il report non nomina il modello main iniziale, letto dalla config reale:\n${before}`);
        }
        if (!before.includes('root of trust: single-user, integro')) {
          throw new Error(`il report non nomina lo stato live del root of trust:\n${before}`);
        }
        if (!before.includes('sys_inspect')) {
          throw new Error(`il report non elenca sys_inspect fra le capability esposte a questo turno:\n${before}`);
        }

        // La condizione reale cambia: nessuna finzione, `muffin model` scrive
        // davvero config.json (cli/model.ts, ramo "endpoint fuori dal
        // catalogo" — il provider finto non è mai in nessun catalogo noto).
        const cambiato = await inst.muffin(['model', 'main', 'test-model-e7-live']);
        if (cambiato.code !== 0) {
          throw new Error(`muffin model main: exit ${cambiato.code}\nout: ${cambiato.out}\nerr: ${cambiato.err}`);
        }
        if (!cambiato.out.includes('test-model-e7-live')) {
          throw new Error(`muffin model non conferma la scrittura: ${JSON.stringify(cambiato.out)}`);
        }

        const second = await inst.muffin(['run', '--timeout', '20', 'spiegami di nuovo tecnicamente cosa stai usando adesso']);
        if (second.code !== 0) throw new Error(`secondo turno: exit ${second.code}\n${second.err}`);

        const afterCalls = inst.provider.main();
        if (afterCalls.length < 4) {
          throw new Error(`atteso un quarto giro dopo il secondo sys_inspect, chiamate: ${afterCalls.length}`);
        }
        const after = afterCalls[3]!.transcript;
        // Design ≠ stato live è esattamente il punto della riga: se
        // `sys_inspect` leggesse da qualcosa di cacheato o dal system prompt
        // invece che da `sources.config` fresco a ogni chiamata, questa
        // asserzione lo scoprirebbe qui, non a mano sull'installazione
        // dell'owner.
        if (!after.includes('modello: test-model-e7-live (main)')) {
          throw new Error(`il report NON riflette il cambio di modello reale — recita ancora lo stato vecchio:\n${after}`);
        }
        if (after.includes('anthropic/claude-sonnet-5')) {
          throw new Error(`il report ripete ancora il modello iniziale dopo il cambio: BROKEN, non distingue design da live:\n${after}`);
        }
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});
