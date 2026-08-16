import DatabaseCtor from 'better-sqlite3';
import { join } from 'node:path';
import { describe } from 'vitest';
import { install } from '../harness.js';
import { scenario } from '../scenario.js';

/**
 * E · Economics and observability.
 *
 * Both scenarios prove the mechanism that exists today — the **global**
 * monthly cap and the owner-facing spend readout — not the per-job cap E1's
 * row is actually missing (M5-BIS: "il per-job non esiste"). A green scenario
 * here documents that the cap which does exist really stops a turn before it
 * spends; it does not promote E1 to READY, and this suite does not touch that
 * row's text on the strength of it.
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
      } finally {
        await inst.cleanup();
      }
    },
    30_000,
  );
});
