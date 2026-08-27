import { it } from 'vitest';
import { entry, promoteMarker, type Expectation } from './manifest.js';
import { annunciaSalto } from './non-provabile.js';

/**
 * Registers an M5-BIS row's acceptance scenario as a real vitest test, using
 * the manifest entry as the single source of truth for row, title and the
 * outcome it is expected to have.
 *
 * A `verde` scenario runs as a plain `it`: if it breaks, the suite goes red for
 * a real reason and stays that way until someone looks at it.
 *
 * An `atteso-rosso` scenario asserts the behaviour M5-BIS says is still
 * missing — and used to run under plain `it.fails` ("if the test fails, it is
 * marked as passed"). That primitive only answers "did it throw", and a
 * scenario the manifest calls "red because of X" can go on reading that way
 * long after the code starts throwing for an unrelated reason Y (mandato
 * DAY-1 §4.9 / P39 — the exact shape D10 was caught in by PR #28: its
 * `reason` named a branch that had already merged, and the scenario stayed
 * "passed" under `it.fails` because *something* still threw, just not the
 * thing the manifest described). So this now checks the failure itself
 * against the manifest's own `expectFailure`, inside a plain `it` — see
 * `guardAttesoRosso` for the three outcomes.
 */
/**
 * `nonProvabileQui` è per l'unico caso onesto in cui uno scenario non deve né
 * passare né fallire: quando **l'host** non è attrezzato per esercitare la cosa
 * che lo scenario prova. Non è un interruttore di comodo — la funzione deve
 * interrogare il prerequisito *fuori* da Muffin (vedi `hostContiene`, che
 * chiede a bwrap direttamente), così un difetto di Muffin resta rosso e solo un
 * limite della macchina diventa un salto.
 *
 * Il motivo è misurato: dentro Docker `bwrap` non può montare `/proc`, quindi
 * il job script non parte e lo scenario andava rosso con un messaggio che si
 * legge come «il sandbox di Muffin è rotto su Linux». Non lo era. Un rosso
 * falso costa quanto un verde falso, e insegna a ignorare quel rosso.
 *
 * Il salto **si stampa**: una capability non esercitata che non lascia traccia
 * nell'output è indistinguibile da una provata.
 */
export function scenario(
  row: string,
  fn: () => Promise<void>,
  timeout?: number,
  nonProvabileQui?: () => string | null,
): void {
  const meta = entry(row);
  const motivo = nonProvabileQui?.() ?? null;
  if (motivo !== null) {
    it.skip(annunciaSalto(row, motivo, (s) => process.stderr.write(s)), fn, timeout);
    return;
  }
  if (meta.expectation.kind === 'verde') {
    it(meta.title, fn, timeout);
    return;
  }
  if (meta.expectation.kind === 'provata-dal-meccanismo') {
    // A row filed as `provata-dal-meccanismo` (today only E4) cannot register
    // a real scenario by construction — see manifest.ts's own comment on the
    // kind. A caller reaching this branch is a manifest/scenario-file
    // mismatch, not a legitimate use, so it fails loudly at collection time
    // instead of silently registering a test whose existence would defeat
    // the point of the kind.
    throw new Error(
      `${row} è 'provata dal meccanismo' nel manifest — non può registrare un proprio scenario (sarebbe la ` +
        `suite che prova se stessa). Se serve un test reale, cambia la sua specie in manifest.ts.`,
    );
  }
  const expectation = meta.expectation;
  it(meta.title, () => guardAttesoRosso(row, fn, expectation), timeout);
}

/**
 * The actual guard, pulled out of the `it()` registration so `scenario.test.ts`
 * can drive it directly with a fake `fn` and a synthetic expectation — no
 * vitest suite needs to be running to check which of the three outcomes below
 * a given `fn` produces.
 *
 *  - threw, and matches `expectFailure` → resolves. Still correctly red, for
 *    the declared reason — the caller's `it` passes, unchanged from before.
 *  - threw, but does **not** match → rejects with the original error's message
 *    folded in. The caller's `it` fails, and `report.ts` reads this as
 *    `rosso-inatteso`: the row is not "fine", something changed and nobody
 *    updated the manifest.
 *  - did not throw at all → rejects with `promoteMarker(row)` in the message.
 *    The caller's `it` fails, and `report.ts` recognises the marker as
 *    "promote me": the gap the manifest describes is gone.
 */
export async function guardAttesoRosso(
  row: string,
  fn: () => Promise<void>,
  expectation: Extract<Expectation, { kind: 'atteso-rosso' }>,
): Promise<void> {
  const { expectFailure, reason } = expectation;
  try {
    await fn();
  } catch (error) {
    if (matches(error, expectFailure)) return; // red for the declared reason: expected, done.
    throw new Error(
      `${row} è rosso, ma non per la ragione dichiarata nel manifest ("${reason}"). ` +
        `Errore visto invece: ${describe(error)}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
  // Did not throw: the gap `reason` describes is gone.
  throw new Error(
    `${promoteMarker(row)}: la funzione non ha più lanciato — promuovi lo scenario a \`verde\` in ` +
      `manifest.ts (ragione dichiarata: "${reason}")`,
  );
}

function matches(error: unknown, expectFailure: RegExp | ((error: unknown) => boolean)): boolean {
  if (typeof expectFailure === 'function') return expectFailure(error);
  return expectFailure.test(describe(error));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
