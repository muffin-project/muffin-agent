import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, locateSecret, muffinHome, paths, secretsBackend, secretDir, credstoreEncryptedPath } from './config.js';
import { loadSealedBudgets } from '../rot/budgets.js';
import { EgressError, loadEgress } from '../net/egress.js';
import { loadPolicyMatrix } from '../policy/matrix.js';

/**
 * Every knob `muffin config` can show, behind a function instead of a command.
 *
 * ADR-0036 asks for this twice over: once so the owner has a place to ask "what
 * can I adjust", and once so a future guiding tool reads the same list instead
 * of keeping its own copy that ages — *"se il comando la sa produrre, il tool
 * che guida la legge da lì"*. The second reason is why this lives in `core/`
 * and not in `cli/`: an `agent/tools/` module may call `listConfigKnobs`
 * directly, and nothing in `agent/` imports from `cli/` today (`fs.ts`,
 * `http.ts` and the rest only ever reach into `core/`). `cli/config.ts` is the
 * thin formatter on top, the same split `doctor.ts` uses for checks.
 */

export type ConfigKnob = {
  /** Dotted path. Matches the field name in `ConfigSchema` where the knob comes
   *  from there, so grepping the schema for a key finds the row that shows it. */
  readonly key: string;
  /** Rendered for a terminal — never a raw secret (see the `.resolved` rows). */
  readonly value: string;
  /** The file this value is read from, absolute. */
  readonly source: string;
  /** Whether changing it needs `muffin rot reseal` — a fact about which file
   *  holds it, not about whether that file currently parses. */
  readonly sealed: boolean;
};

/**
 * Top-level `ConfigSchema` groups marked `.optional()` that the flattener below
 * would simply skip when unset — leaving the owner unable to find a knob that
 * exists precisely because nothing is there to find.
 *
 * The alternative was walking `ConfigSchema` itself to enumerate every
 * *possible* leaf, set or not. Probed directly against the installed zod
 * 4.4.3 (PRACTICES.md#read-upstream-before-depending-on-upstream): the shape is reachable (`schema.shape`, recursing on
 * `._zod.def.type`), but only through `_zod`, an underscored internal with no
 * precedent anywhere in this codebase (`grep -rn "_zod\\." --include=*.ts`
 * outside this file returns nothing) and no guarantee across a zod patch
 * release. Building the derivation on that trades a hand-written list that
 * ages for a private API that breaks — worse, not better. So: derive from the
 * real `Config` object where it can (every field the schema currently
 * populates, automatically, because that object *is* `z.infer<ConfigSchema>`),
 * and name the small, stable exception once, here, rather than silently.
 */
const OPTIONAL_GROUPS: readonly { prefix: string; note: string }[] = [
  { prefix: 'provider.baseUrl', note: '(non impostato — endpoint di default del provider)' },
  { prefix: 'models.deep', note: '(non configurato)' },
  { prefix: 'thinking', note: '(non impostato — vale il profilo del modello)' },
  { prefix: 'search', note: '(non configurata — nessuna ricerca web registrata)' },
  { prefix: 'surfaces.telegram', note: '(non configurata — muffin surface enable telegram)' },
];

/** Not a setting an owner adjusts — it is metadata about the file's own shape. */
const SKIP_KEYS = new Set(['schemaVersion']);

export function listConfigKnobs(home: string = muffinHome()): ConfigKnob[] {
  const p = paths(home);
  const knobs: ConfigKnob[] = [];

  // config.json — never sealed. This is exactly what ADR-0036 wants Muffin
  // itself able to change while talking, so every row from here carries
  // sealed: false unconditionally.
  const config = loadConfig(home);
  const leaves: { key: string; value: string }[] = [];
  flattenLeaves(config, '', leaves);
  for (const { key, value } of leaves) {
    if (SKIP_KEYS.has(key)) continue;
    knobs.push({ key, value, source: p.config, sealed: false });
    // A config value that is a secret reference (`secret://name`) is never the
    // secret itself — `ConfigSchema` only ever stores the reference — so it is
    // always safe to print. What is worth a second row is *where the chain
    // resolved it*: through `locateSecret` on the file backend (which names
    // the winning copy), or statically on the systemd backend (ciphertext
    // path by construction — presence itself is `doctor`'s live check, not
    // this listing's, because this listing must stay readable outside the
    // service without holding the host key).
    if (value.startsWith('secret://')) {
      if (secretsBackend(home) === 'systemd') {
        knobs.push({
          key: `${key}.resolved`,
          value: `systemd encrypted credential (${value.slice('secret://'.length)}.cred)`,
          source: credstoreEncryptedPath(value.slice('secret://'.length)),
          sealed: false,
        });
      } else {
        const loc = locateSecret(value, home);
        knobs.push({
          key: `${key}.resolved`,
          value: loc ? `presente (${loc.backend})` : 'non impostata',
          source: loc ? loc.path : `${secretDir('home', home)} · ${secretDir('persistent', home)}`,
          sealed: false,
        });
      }
    }
  }
  for (const { prefix, note } of OPTIONAL_GROUPS) {
    if (!leaves.some((l) => l.key === prefix || l.key.startsWith(`${prefix}.`))) {
      knobs.push({ key: prefix, value: note, source: p.config, sealed: false });
    }
  }

  // rot/budgets.json — sealed. `loadSealedBudgets` already resolves the
  // compiled-floor fallback, so "value" is what actually binds whether or not
  // the file parses. "sealed" stays true regardless of that outcome: changing
  // this number legitimately means editing rot/budgets.json and then `muffin
  // rot reseal`, which is a structural fact about *which file* holds it, not
  // about whether today's copy happens to parse.
  const budgetsFile = join(p.rot, 'budgets.json');
  const budgets = loadSealedBudgets(home);
  knobs.push(
    { key: 'budgets.monthlyUsd', value: String(budgets.caps.monthlyUsd), source: budgetsFile, sealed: true },
    {
      key: 'budgets.perTenantDailyUsd',
      value: String(budgets.caps.perTenantDailyUsd),
      source: budgetsFile,
      sealed: true,
    },
    { key: 'budgets.quietHours.from', value: budgets.quietHours.from, source: budgetsFile, sealed: true },
    { key: 'budgets.quietHours.to', value: budgets.quietHours.to, source: budgetsFile, sealed: true },
    { key: 'budgets.quietHours.timezone', value: budgets.quietHours.timezone, source: budgetsFile, sealed: true },
  );

  // rot/egress.json — sealed. Unlike the two loaders above, `loadEgress` throws
  // instead of falling back — an existing asymmetry between the RoT loaders,
  // not this command's to fix — so it is caught here: a missing or corrupt
  // file should degrade one row of a read-only listing, not crash the whole
  // command a nervous owner is running to understand their install.
  const egressFile = join(p.rot, 'egress.json');
  let egressValue: string;
  try {
    const allow = loadEgress(home).allow;
    egressValue = allow.length === 0 ? '(vuoto — fuori allowlist va in ask o deny, mai in allow)' : allow.join(', ');
  } catch (error) {
    egressValue = `fallback — ${error instanceof EgressError ? error.message : String(error)}`;
  }
  knobs.push({ key: 'egress.allow', value: egressValue, source: egressFile, sealed: true });

  // rot/policy.json — sealed.
  const policyFile = join(p.rot, 'policy.json');
  const matrix = loadPolicyMatrix(home);
  // One knob per effect row: since ADR-0053 these are what decide the taint
  // ceiling. The `defaultMaxTaint` entries below stay because they are still
  // literally in the sealed file and this inventory answers "which file holds
  // this value", not "which value won" — but they are listed after the rows,
  // and the rows are the ones an owner should read first.
  for (const [name, row] of Object.entries(matrix.rows)) {
    knobs.push({
      key: `policy.rows.${name}`,
      // ADR-0074: `askAbove` non esiste più — la riga dichiara *se*
      // l'irreversibile chiede, non *sopra quale taint* si chiede.
      value: `${row.asksForIrreversible ? 'chiede se irreversibile' : 'non chiede'}, nega sopra ${row.denyAbove}`,
      source: policyFile,
      sealed: true,
    });
  }
  knobs.push(
    {
      key: 'policy.defaultMaxTaint.low',
      value: String(matrix.defaultMaxTaint.low),
      source: policyFile,
      sealed: true,
    },
    {
      key: 'policy.defaultMaxTaint.medium',
      value: String(matrix.defaultMaxTaint.medium),
      source: policyFile,
      sealed: true,
    },
    {
      key: 'policy.defaultMaxTaint.high',
      value: String(matrix.defaultMaxTaint.high),
      source: policyFile,
      sealed: true,
    },
    { key: 'policy.neverAtRuntime', value: setValue(matrix.neverAtRuntime), source: policyFile, sealed: true },
    {
      key: 'policy.forbiddenForSystem',
      value: setValue(matrix.forbiddenForSystem),
      source: policyFile,
      sealed: true,
    },
  );

  // identity.md and evals/voice.json — the remaining two of ADR-0036's five
  // sealed files. Neither is a scalar setting, so "value" is a summary rather
  // than content: printing the owner's identity pact to a terminal on every
  // `muffin config` is not what a settings listing is for, and the point here
  // is only "this exists, and it is sealed like the other four".
  const identityFile = join(p.rot, 'identity.md');
  knobs.push({
    key: 'identity',
    value: existsSync(identityFile) ? `${readFileSync(identityFile, 'utf8').split('\n').length} righe` : 'assente',
    source: identityFile,
    sealed: true,
  });

  const voiceEvalFile = join(p.rot, 'evals', 'voice.json');
  knobs.push({ key: 'evals.voice', value: voiceEvalSummary(voiceEvalFile), source: voiceEvalFile, sealed: true });

  return knobs;
}

function setValue(set: ReadonlySet<string>): string {
  return set.size === 0 ? '(vuoto)' : [...set].sort().join(', ');
}

function voiceEvalSummary(file: string): string {
  if (!existsSync(file)) return 'assente';
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { cases?: unknown[] };
    return `${parsed.cases?.length ?? 0} casi`;
  } catch {
    return 'illeggibile';
  }
}

/**
 * Walks a plain object into dotted-path leaves. `undefined` is skipped (an
 * absent optional field is not a row — `OPTIONAL_GROUPS` above is what stands
 * in for it), arrays stop the recursion and render as one joined value (an
 * array index is not a name the owner would type to change something), and
 * everything else recurses. This is the actual derivation: the object handed
 * in is `Config`, produced by `ConfigSchema.safeParse`, so every key it
 * currently carries is exactly what the schema currently allows for *this*
 * install — a field added to the schema and populated shows up here with no
 * change to this file.
 */
function flattenLeaves(value: unknown, prefix: string, out: { key: string; value: string }[]): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    out.push({ key: prefix, value: value.length === 0 ? '(vuoto)' : value.map(String).join(', ') });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenLeaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  const rendered =
    value === null ? '(non impostato)' : typeof value === 'boolean' ? (value ? 'sì' : 'no') : String(value);
  out.push({ key: prefix, value: rendered });
}
