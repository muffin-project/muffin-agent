import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-model profiles.
 *
 * The harness is built for the weakest model we intend to support, not for the
 * strongest one available — otherwise every capability quietly assumes a
 * frontier model and the local option becomes a label. Each model's tool
 * visibility, bounded or count-unbounded task horizon, retries and output
 * constraints live here as data, never as `if (model === ...)` in the loop.
 *
 * That is what makes it scaffolding you can remove: when a model stops needing
 * the crutches, you delete a profile, not a code path. See
 * docs/decisions/0022-un-processo-con-priorita-foreground.md and
 * the durable-vs-scaffolding split in the blueprint.
 */

/**
 * The vocabulary of the cascade. What each step *does* is in `./recovery.ts`,
 * beside this file and inside the same removable boundary.
 *
 * The list is **executed as declared, in order**: attempt N runs strategy N.
 * It used to be a length — `recoveriesLeft` counted down from `recovery.length`
 * while the loop consulted only `includes('nudge')`, so `consumer-local`'s four
 * declared steps ran as four identical nudges and the other three names bought
 * attempts they never spent.
 */
export type RecoveryStrategy =
  /** Empty or narrated turn: an open corrective, the gentlest rung. */
  | 'nudge'
  /** Lost track of the menu: the tool names restated inline, at the tail. */
  | 'reinjectTools'
  /** Transient garbage from the model: ask again, adding nothing. */
  | 'retryOnce'
  /** Prose where a call was needed: a two-option contract, no third shape. */
  | 'strictJson'
  /**
   * Stall after gentler rungs: the next attempt sends `tool_choice: required`
   * at the wire (ADR-0082) plus a message saying a call is due. Last resort
   * before the turn fails — never first, because forcing a call manufactures
   * an action the model never chose.
   */
  | 'requireTool';

export type ProfileExecution = {
  modelCallDeadlineMs: number;
  turnWallDeadlineMs: number;
  activeModelBudgetMs: number;
  firstActivityTimeoutMs: number;
  stallTimeoutMs: number;
  heartbeatIntervalMs: number;
};

/**
 * The bounded interactive floor for a profile that predates execution policy.
 *
 * One exported value because this is compatibility behavior, not a model
 * preset: the profile parser and the runtime fallback must never grow two
 * almost-identical literals where one silently forgets a fuse. Shipped model
 * profiles may override it explicitly; old schema-v1 files inherit all six
 * bounds rather than only the two that existed in the first P0 draft.
 */
export const DEFAULT_EXECUTION: ProfileExecution = {
  modelCallDeadlineMs: 90_000,
  turnWallDeadlineMs: 180_000,
  activeModelBudgetMs: 120_000,
  firstActivityTimeoutMs: 30_000,
  stallTimeoutMs: 25_000,
  heartbeatIntervalMs: 15_000,
};

/**
 * What the loop asks the provider for. Two fields, both of them corrections.
 *
 * `thinking` was `'allowed' | 'off'` — a permission with no unit, and a wrong
 * one for every model this file's shipped profiles match. There is nothing to
 * permit: on the 5-series thinking is **on unless you disable it**, so `'off'`
 * that sends no field is a declaration the request contradicts, and `'allowed'`
 * described a budget the API deleted. `'adaptive'`, `'off'` and `'unset'` are
 * the three modes that exist now (ADR-0037, and its correction the same day):
 *
 * - `'adaptive'` → `{type:'adaptive'}`.
 * - `'off'` → `{type:'disabled'}` — **only where the model actually has a
 *   disable switch.** Claude Sonnet 5 and Claude Opus 5 (at `effort` high or
 *   below — nothing here sends `effort`, so this holds today, but the coupling
 *   is not enforced) do; Claude Fable 5 and Claude Mythos 5 do not — thinking
 *   is always on there and the API 400s on `{type:"enabled"}` **and**
 *   `{type:"disabled"}` alike (per-model table, read 2026-08-13). Sending
 *   `'off'` to one of those is not a degradation, it is a 400 every turn.
 * - `'unset'` → the field is **omitted**, not sent as `undefined`. The one
 *   value proven safe on every model, because it is what every model accepted
 *   before this field existed at all: for a model with a disable switch it
 *   behaves however that model defaults (usually thinking on, on current
 *   models); for one without, it is the only legal way to ask for "no
 *   configuration" instead of a request the model rejects outright. This is
 *   also ADR-0037's own reversibility plan ("`thinking` assente resta una
 *   forma valida") — before this value existed, no profile could reach that
 *   branch, because the loop passed the field unconditionally.
 *
 * `sampling` exists because `temperature: 0` was hardcoded in the loop and is a
 * **400** on Opus 4.7 and later — including `claude-sonnet-5`, which is what
 * `muffin init` writes on a default install. It is per-model data, so it lives
 * here for the same reason `thinking` does: never as `if (model === ...)` in
 * the loop.
 */
export type Profile = {
  schemaVersion: 1;
  name: string;
  /** Glob patterns on the model id. First match wins. */
  match: string[];
  maxToolsExposed: number;
  /** `null` leaves call count unbounded; execution time and spend budgets still apply. */
  maxToolCallsPerTurn: number | null;
  thinking: 'adaptive' | 'off' | 'unset';
  /**
   * `'deterministic'` sends `temperature: 0`; `'model-default'` sends no
   * sampling parameter at all, because the model rejects one.
   */
  sampling: 'deterministic' | 'model-default';
  recovery: RecoveryStrategy[];
  /** Optional only for programmatic/backward-compatible callers; loadProfiles materializes DEFAULT_EXECUTION. */
  execution?: ProfileExecution | undefined;
  notes: string;
};

/** Applies when nothing matches. Deliberately the cautious one. */
export const CONSERVATIVE: Profile = {
  schemaVersion: 1,
  name: 'conservative',
  match: ['*'],
  maxToolsExposed: 10,
  maxToolCallsPerTurn: 15,
  // Not 'unset': the same "loud failure names the parameter" argument the
  // sampling comment below makes applies here too, and symmetrically — an
  // unrecognised id is still more likely to be an old or local model (which
  // 'off' has always suited: before ADR-0037 it sent nothing, which is legal
  // everywhere) than one of the two named models that reject a disable switch
  // outright. 'unset' exists for a profile author who *knows* their model is
  // one of those (Claude Fable 5, Claude Mythos 5 — always-on thinking, 400 on
  // both `"enabled"` and `"disabled"`); CONSERVATIVE does not get to guess it.
  thinking: 'off',
  // Cautious means "what every model before 4.7 accepted", not "what the newest
  // one wants": an unknown model is far more likely to be a local one that
  // wanders without temperature 0 than a frontier one that refuses it. A model
  // that refuses it fails loudly with a 400 naming the parameter, which is the
  // right kind of wrong for an unrecognised id.
  sampling: 'deterministic',
  recovery: ['nudge', 'reinjectTools', 'retryOnce', 'strictJson'],
  execution: DEFAULT_EXECUTION,
  notes: 'Unknown model: the capability floor, with every crutch enabled.',
};

/**
 * Parsed, not cast (PRACTICES.md#parse-at-boundaries-preserve-provenance) — and the history is why. `recovery` used to
 * be inert data: a typo added 1 to a counter and nothing else. Once the cascade
 * executed as declared, an unknown name became a TypeError thrown at the one
 * moment a turn was already failing — a latent bomb armed precisely when the
 * recovery it names was needed. Profiles are a documented extension point, so
 * the boundary has to refuse what the switch cannot honor, out loud.
 */
const ExecutionSchema = z.object({
  modelCallDeadlineMs: z.number().int().positive().default(DEFAULT_EXECUTION.modelCallDeadlineMs),
  turnWallDeadlineMs: z.number().int().positive().default(DEFAULT_EXECUTION.turnWallDeadlineMs),
  activeModelBudgetMs: z.number().int().positive().default(DEFAULT_EXECUTION.activeModelBudgetMs),
  firstActivityTimeoutMs: z.number().int().positive().default(DEFAULT_EXECUTION.firstActivityTimeoutMs),
  stallTimeoutMs: z.number().int().positive().default(DEFAULT_EXECUTION.stallTimeoutMs),
  heartbeatIntervalMs: z.number().int().positive().default(DEFAULT_EXECUTION.heartbeatIntervalMs),
});

const ProfileSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  match: z.array(z.string().min(1)).min(1),
  maxToolsExposed: z.number().int().positive(),
  maxToolCallsPerTurn: z.number().int().positive().nullable(),
  // No `'allowed'` alias. A third-party profile still saying it is dropped at
  // the boundary and named in `doctor`, which is the point: the word described
  // a budget that no longer exists, and keeping it working would keep it true.
  // 'unset' added alongside 'off': the wire mapping for "off" — {type:
  // 'disabled'} — is a 400 on a model with no disable switch (Fable 5, Mythos
  // 5), so a profile targeting one needs a value that omits the field instead
  // of guessing wrong (ADR-0037's correction, same day).
  thinking: z.enum(['off', 'adaptive', 'unset']),
  // Defaulted, not required, and the default is what the loop hardcoded before
  // this field existed — so a profile written against the old schema keeps
  // exactly the behaviour it had instead of silently acquiring a new one.
  sampling: z.enum(['deterministic', 'model-default']).default('deterministic'),
  recovery: z.array(z.enum(['nudge', 'reinjectTools', 'retryOnce', 'strictJson', 'requireTool'])),
  // Whole-field default closes the upgrade path: a schema-v1 profile from
  // before P0 gets the same six bounded values as the conservative runtime
  // floor. Per-field defaults also make a partially migrated profile converge
  // instead of silently losing whichever fuse it omitted.
  execution: ExecutionSchema.default(DEFAULT_EXECUTION),
  notes: z.string().default(''),
});

export function loadProfiles(dir?: string, onProblem?: (line: string) => void): Profile[] {
  const base = dir ?? join(dirname(fileURLToPath(import.meta.url)));
  if (!existsSync(base)) return [];
  const out: Profile[] = [];
  for (const f of readdirSync(base).filter((n) => n.endsWith('.json')).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(base, f), 'utf8'));
    } catch (error) {
      onProblem?.(`profilo ${f} illeggibile: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = ProfileSchema.safeParse(raw);
    if (!parsed.success) {
      // Dropped and said, never half-loaded: a profile with one bad strategy
      // name would otherwise select normally and detonate mid-recovery.
      //
      // D4 (judge, 2026-08-13): this used to say only the zod message —
      // `Invalid option: expected one of "off"|"adaptive"` — which names
      // neither the field nor the file well enough to act on at 2am. The
      // issue carries its own path; not reading it was the whole defect.
      const issue = parsed.error.issues[0];
      const path = issue?.path.join('.');
      onProblem?.(
        `profilo ${f} scartato${path ? ` (campo "${path}")` : ''}: ${issue?.message ?? 'schema non valido'}`,
      );
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

export function selectProfile(model: string, profiles: Profile[]): Profile {
  for (const profile of profiles) {
    if (profile.match.some((pattern) => globMatch(pattern, model))) return profile;
  }
  return CONSERVATIVE;
}

/** Enough glob for model ids: `*` stands for any run of characters. */
function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

/**
 * Il profilo del modello, con la scelta dell'installazione sopra.
 *
 * Una funzione e non un `??` sparso: i posti che scelgono un profilo sono più
 * di uno (`agent/runtime.ts` ne sceglie due, main e light) e solo **uno** deve
 * ricevere l'override — la corsia di conversazione. Scritto qui, accanto a
 * `selectProfile`, perché la domanda «quale profilo vale davvero» ha una
 * risposta sola e questo file è dove sta.
 *
 * Copia **sempre**, anche quando non c'è niente da sovrascrivere, e questa è la
 * riga che conta: `loadProfiles` restituisce un oggetto per profilo, e su questa
 * installazione main e light matchano lo stesso glob (`*qwen3*`), quindi sono
 * lo **stesso** oggetto. Restituire l'originale quando l'override è assente
 * darebbe alla corsia principale un profilo condiviso, e la mutazione di
 * `/think` spegnerebbe il reasoning anche alla corsia della memoria — per
 * riferimento, in silenzio, solo quando i due modelli sono della stessa
 * famiglia. Un ramo che sbaglia solo a volte è peggio di uno che sbaglia sempre.
 */
export function withThinking(profile: Profile, override?: Profile['thinking']): Profile {
  return override === undefined ? { ...profile } : { ...profile, thinking: override };
}
