import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/config.js';
import type { BudgetCaps } from '../budget/budget.js';
// Type-only, so this module takes no runtime dependency on the scheduler — but
// it does take the *name*. A second `QuietHours` declared here would be a
// second referent for one term, which is how `origin`/`source_kind` happened.
import type { QuietHours } from '../scheduler/proactivity.js';

/**
 * `rot/budgets.json`, read once and parsed in three halves.
 *
 * The file is sealed and its own comment promises *"the agent cannot raise them
 * itself"*. That promise was false for the half that mattered: `BudgetEngine`
 * was built from `config.budget` in `~/.muffin/config.json`, which the manifest
 * does not cover, so anything able to write that file raised the monthly cap and
 * the root of trust never noticed. The two files carried the same numbers by
 * duplication, so the behaviour looked right and the guarantee did not exist
 * (ADR-0028 recorded it, `core/rot/readers.ts` recorded it again at field
 * granularity, ADR-0036 made it a blocking precondition). This module is the
 * single reader; `config.budget` no longer exists.
 *
 * **Why the caps moved here rather than `config.json` moving into the seal.**
 * `config.json` holds the models, the surfaces and the Telegram pairing state —
 * things ADR-0036 wants Muffin itself to change while talking, and things the
 * runtime writes on its own (`muffin surface enable`, a pairing that succeeds).
 * Sealing it would make every model change need `muffin rot reseal`, which is
 * ADR-0003's own stated signal that the boundary is in the wrong place. And
 * hashing a *fragment* of a mutable file is not something the manifest can
 * express. So the cap lives in the sealed file and nowhere else.
 *
  * **Three halves, parsed independently.** Quiet hours, spend caps and the
  * unmetered-endpoint list live in one file and answer to three unrelated
  * features. A single parse would make a mistyped cap open the night, a
  * mistyped hour remove the spend ceiling, and a mistyped endpoint silently
  * bill (or silently zero-bill) — couplings nobody would choose if the three
  * were in separate files, so the shared file must not create them. A missing
  * `unmetered` section is not a broken half: it is how every home sealed
  * before the section existed says "no exceptions", so it parses silently to
  * an empty list. A present-but-malformed section fails safe to metered, with
  * a note, for the same reason a mistyped cap falls back instead of guessing.
  */

type BudgetsSource = 'sealed' | 'fallback';

export type SealedBudgets = {
  /** The caps that bind `BudgetEngine`. */
  readonly caps: BudgetCaps;
  readonly capsSource: BudgetsSource;
  readonly quietHours: QuietHours;
  readonly quietSource: BudgetsSource;
  /** Owner-declared endpoint contracts the meter skips, normalized at parse. */
  readonly unmetered: readonly UnmeteredEndpoint[];
  readonly unmeteredSource: BudgetsSource;
  /**
   * One line per half that fell back, already phrased for a human. Empty when
   * the sealed file answered for all three — never folded into a boolean,
   * because "the fallback answered" is the fact an owner has to be able to
   * read.
   */
  readonly notes: string[];
};

/**
 * One exact endpoint contract the owner funds outside the metered spend
 * (e.g. a LAN GPU box): `host` is an exact hostname or IP, matched
 * case-insensitively with a folded trailing dot; `port`, when present,
 * restricts the match to that port, and when absent any port on the host
 * matches. `note` is owner documentation ("why is this free") and travels
 * nowhere except diagnostics.
 */
export type UnmeteredEndpoint = {
  readonly host: string;
  readonly port?: number | undefined;
  readonly note?: string | undefined;
};

/**
 * The compiled floor for the caps, and why falling back here is the safe
 * direction rather than merely the convenient one.
 *
 * These are the numbers `defaults/rot/budgets.json` ships. The alternative
 * directions are both worse: no cap at all is the original defect verbatim
 * (`0 >= undefined` is `false`, so a missing budget silently meant unlimited —
 * `core/config/config.ts` carries that scar), and refusing to boot bricks a home
 * whose sealed file an upgrade has not yet written. `core/policy/matrix.ts`
 * settled the same question the same way for `policy.json`.
 *
 * **The residual, named.** An owner who *raised* their sealed cap and then broke
 * the file drops back to 80 — tighter, so nothing runs away. An owner who
 * *lowered* it gets 80 back, which is looser than they asked for. That case is
 * covered by the seal rather than by this constant: a file the manifest lists
 * and disk no longer matches diverges, which is safe mode in single-user and a
 * refused boot in hardened, and `doctor` names the fallback in the same breath.
 */
export const BUDGET_FLOOR: BudgetCaps = { monthlyUsd: 80, perTenantDailyUsd: 2 };

/** A window, never an empty one: an unreadable file is not a licence to speak at 3am. */
export const QUIET_FLOOR: QuietHours = { from: '23:00', to: '08:00', timezone: 'UTC' };

// Non-negative rather than positive: zero is a legitimate cap, meaning stop.
const CapsShape = z.object({
  monthlyUsd: z.number().nonnegative(),
  perTenantDailyUsd: z.number().nonnegative(),
});

/**
 * The regex is the part that does the work. Measured on `proactivity.ts`, on the
 * two ways a hand-edit goes wrong:
 *
 *  - `from: "11pm"` — no crash, and at 23:30 Rome `inQuietHours` answers false
 *    where `"23:00"` answers true. That is the night quietly opening: an hour
 *    the owner declared closed, with nothing said about it anywhere.
 *  - `to: "8am"` — `decideProactive` computes the end of the window before it
 *    checks anything, so the run dies inside cron-parser with
 *    "Invalid characters, got value: NaN" instead of deferring.
 *
 * The third way was left open until ADR-0060, and it was the same failure with
 * a different spelling: `timezone: "Europe/Roma"` passed `min(1)` and then
 * exploded downstream — `Intl.DateTimeFormat` throws `RangeError` on an unknown
 * zone, and `nextTimeOfDay` hands it to cron-parser, which dies with
 * "CronDate: unhandled timestamp". Before this validation existed that typo
 * broke `muffin observe --send`, a command the owner types and watches; from
 * ADR-0060 the same window is read on the gateway's 30-second beat, so a
 * one-letter typo in a sealed file became a process that dies at every start.
 * The zone is therefore checked against the runtime's own tz database here,
 * where it is parsed — not guarded at each of the places that use it.
 */
function isRealTimezone(tz: string): boolean {
  try {
    // The cheapest question that actually consults the tz database. A zone the
    // runtime does not know throws `RangeError` here, which is exactly the
    // throw we are moving from three call sites to one.
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const QuietShape = z.object({
  from: z.string().regex(/^\d{1,2}:\d{2}$/),
  to: z.string().regex(/^\d{1,2}:\d{2}$/),
  timezone: z.string().min(1).refine(isRealTimezone, { message: 'fuso orario IANA sconosciuto' }),
});

/**
 * One declared exception to metering. Hostnames normalize here — lowercase,
 * folded trailing dot — so the price seam compares exact strings and never
 * re-interprets owner input. Ports are validated for the same reason a bad
 * timezone is: a typo must fail here, loudly, not bill somewhere unexpected.
 */
const UnmeteredShape = z.array(
  z.object({
    host: z
      .string()
      .min(1)
      .transform((h) => h.toLowerCase().replace(/\.$/, '')),
    port: z.number().int().min(1).max(65535).optional(),
    note: z.string().optional(),
  }),
);

const SCHEMA_VERSION = 1;

export function loadSealedBudgets(home: string): SealedBudgets {
  const file = join(paths(home).rot, 'budgets.json');
  const both = (why: string): SealedBudgets => ({
    caps: BUDGET_FLOOR,
    capsSource: 'fallback',
    quietHours: QUIET_FLOOR,
    quietSource: 'fallback',
    unmetered: [],
    unmeteredSource: 'fallback',
    notes: [`tetto di spesa e quiet hours dai valori compilati — ${why}`],
  });

  if (!existsSync(file)) return both(`${file} assente`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return both(`${file} illeggibile`);
  }

  // Version before schema, like the config loader and the policy matrix: a file
  // from a future build fails validation for reasons that have nothing to do
  // with the real problem, and half-reading it would be worse than not reading
  // it — this is the file that says how much money the agent may spend.
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version !== SCHEMA_VERSION) {
    return both(`${file}: schemaVersion ${String(version)}, questa build ne capisce ${SCHEMA_VERSION}`);
  }

  const notes: string[] = [];
  const caps = CapsShape.safeParse(raw);
  if (!caps.success) {
    notes.push(`${file}: tetto di spesa non valido (${issue(caps.error)}) — valgono i valori compilati`);
  }
  const quiet = QuietShape.safeParse((raw as { quietHours?: unknown }).quietHours);
  if (!quiet.success) {
    // Il motivo, non solo il verdetto: `"Europe/Roma"` e `"11pm"` sono lo
    // stesso esito con due cause diverse, e una riga che non le distingue
    // manda l'owner a rileggere il file invece che a correggere un carattere.
    // E il fuso, non solo la finestra: `QUIET_FLOOR` è in UTC, e da questo
    // stesso campo la corsia degli impegni rende «era per giovedì alle 11:00».
    // Un giudice l'ha misurato — con `"Europe/Roma"` sigillato l'orario usciva
    // in UTC e la riga di avviso non lo diceva, quindi l'owner leggeva un'ora
    // sbagliata senza nessun modo di sapere perché.
    notes.push(
      `${file}: quietHours non valide (${issue(quiet.error)}) — vale la finestra compilata ` +
        `(${QUIET_FLOOR.from}–${QUIET_FLOOR.to} ${QUIET_FLOOR.timezone}, e gli orari che Muffin dice escono in ${QUIET_FLOOR.timezone})`,
    );
  }
  const unmetered = parseUnmetered(raw, file, notes);

  return {
    caps: caps.success ? caps.data : BUDGET_FLOOR,
    capsSource: caps.success ? 'sealed' : 'fallback',
    quietHours: quiet.success ? quiet.data : QUIET_FLOOR,
    quietSource: quiet.success ? 'sealed' : 'fallback',
    unmetered: unmetered.list,
    unmeteredSource: unmetered.source,
    notes,
  };
}

function parseUnmetered(raw: unknown, file: string, notes: string[]): { list: UnmeteredEndpoint[]; source: BudgetsSource } {
  const value = (raw as { unmetered?: unknown }).unmetered;
  // Absent is not broken: every home sealed before this section existed says
  // "no exceptions" by omission, and warning on all of them would be noise.
  if (value === undefined) return { list: [], source: 'sealed' };
  const parsed = UnmeteredShape.safeParse(value);
  if (!parsed.success) {
    // Present but malformed fails safe to metered, with the reason: a typo
    // must cost the owner visibility into the typo, never a silent zero-bill.
    notes.push(`${file}: unmetered non valido (${issue(parsed.error)}) — tutto resta a consumo`);
    return { list: [], source: 'fallback' };
  }
  return { list: parsed.data, source: 'sealed' };
}

function issue(error: z.ZodError): string {
  const first = error.issues[0];
  return `${first?.path.join('.') || '(root)'}: ${first?.message ?? 'illeggibile'}`;
}
