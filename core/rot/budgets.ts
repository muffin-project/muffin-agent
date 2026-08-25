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
 * `rot/budgets.json`, read once and parsed in two halves.
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
 * **Two halves, parsed independently.** Quiet hours and spend caps live in one
 * file and answer to two unrelated features. A single parse would make a
 * mistyped cap open the night, and a mistyped hour remove the spend ceiling —
 * a coupling nobody would choose if the two were in separate files, so the
 * shared file must not create it.
 */

type BudgetsSource = 'sealed' | 'fallback';

export type SealedBudgets = {
  /** The caps that bind `BudgetEngine`. */
  readonly caps: BudgetCaps;
  readonly capsSource: BudgetsSource;
  readonly quietHours: QuietHours;
  readonly quietSource: BudgetsSource;
  /**
   * One line per half that fell back, already phrased for a human. Empty when
   * the sealed file answered for both — never folded into a boolean, because
   * "the fallback answered" is the fact an owner has to be able to read.
   */
  readonly notes: string[];
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
 */
const QuietShape = z.object({
  from: z.string().regex(/^\d{1,2}:\d{2}$/),
  to: z.string().regex(/^\d{1,2}:\d{2}$/),
  timezone: z.string().min(1),
});

const SCHEMA_VERSION = 1;

export function loadSealedBudgets(home: string): SealedBudgets {
  const file = join(paths(home).rot, 'budgets.json');
  const both = (why: string): SealedBudgets => ({
    caps: BUDGET_FLOOR,
    capsSource: 'fallback',
    quietHours: QUIET_FLOOR,
    quietSource: 'fallback',
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
    notes.push(`${file}: quietHours non valide — vale la finestra compilata`);
  }

  return {
    caps: caps.success ? caps.data : BUDGET_FLOOR,
    capsSource: caps.success ? 'sealed' : 'fallback',
    quietHours: quiet.success ? quiet.data : QUIET_FLOOR,
    quietSource: quiet.success ? 'sealed' : 'fallback',
    notes,
  };
}

function issue(error: z.ZodError): string {
  const first = error.issues[0];
  return `${first?.path.join('.') || '(root)'}: ${first?.message ?? 'illeggibile'}`;
}
