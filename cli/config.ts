import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { ConfigError } from '../core/config/config.js';
import { styleFor } from './ui.js';
import { listConfigKnobs, type ConfigKnob } from '../core/config/inventory.js';
import { describeSettableKnobs, formatSetOutcome, setConfigKnob } from '../core/config/settings.js';

/**
 * `muffin config` — read-only by default, on purpose (ADR-0036), plus one
 * narrow door: `muffin config set <chiave> <valore>` (ADR-0070).
 *
 * `muffin config` (senza sotto-comando) answers "what can I adjust, and
 * where" completely without building a write surface anything has to guard:
 * every knob, its current value, the file it lives in, and whether that file
 * is sealed. Prior art looked at before choosing the shape (`docs/PRACTICES.md`
 * §3) — `git config --list --show-origin` pairs a value with the file it came
 * from but has no sealed axis to show; `gh config list` is bare key=value
 * with no origin at all; `aws configure list` is the closest match, a table
 * of Name / Value / Type / Location. This is that shape with "Type" replaced
 * by "Sigillato", the one column none of the three needed and this command
 * exists to answer.
 *
 * `set` is deliberately not "the write surface ADR-0036 refused to build" —
 * that one would be a conversational, kernel-gated capability the model could
 * eventually reach. This is the owner typing a command; `setConfigKnob`
 * (`core/config/settings.ts`) is the one function behind it, behind three
 * doors (this file, `/config` in `agent/comandi.ts`, Telegram through the
 * same comando), and the reasoning for why that is safe without a kernel
 * capability lives in that file's own docstring.
 */

export const CONFIG_USAGE = `usage:
  muffin config                mostra ogni manopola, il valore, dove vive e se è sigillata
  muffin config --json         come sopra, in JSON
  muffin config set <chiave> <valore>
                                cambia una delle poche manopole scrivibili da qui:
${describeSettableKnobs()}
`;

export function cmdConfig(home: string, argv: string[]): number {
  if (argv[0] === 'set') return cmdConfigSet(home, argv.slice(1));

  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' } }, allowPositionals: false });

  let knobs: ConfigKnob[];
  try {
    knobs = listConfigKnobs(home);
  } catch (error) {
    const e = error as ConfigError;
    process.stderr.write(`${e.message ?? String(error)}\n`);
    if (e.remedy) process.stderr.write(`→ ${e.remedy}\n`);
    return 78;
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(knobs, null, 2)}\n`);
  } else {
    const style = styleFor(process.stdout);
    process.stdout.write(`${style.header('muffin config', home)}\n${formatConfigKnobs(knobs, home)}\n`);
  }
  return 0;
}

/**
 * `home` is only for display: every `source` an owner will see is already
 * absolute (`ConfigKnob` promises that, and the `--json` output keeps it that
 * way for a script or a future guiding tool). Shown relative to home instead
 * — `rot/budgets.json`, not the full path repeated on twelve rows — because
 * that is already how this codebase talks about these five files everywhere
 * else (`doctor.ts`'s own remedies say "rot/policy.json", never the full
 * path), and because repeating an absolute path on every row is what made the
 * first real run of this command wider than a terminal.
 */
export function formatConfigKnobs(knobs: ConfigKnob[], home: string): string {
  if (knobs.length === 0) return 'nessuna impostazione trovata.';

  const header = { key: 'CHIAVE', value: 'VALORE', sealed: 'SIGILLATO', source: 'ORIGINE' };
  const rows = knobs.map((k) => ({ ...k, source: relative(home, k.source) }));
  const keyWidth = Math.max(header.key.length, ...rows.map((k) => k.key.length));
  // Capped: a long egress allowlist or a long forbidden-capability set must not
  // drag the origin column off the edge of a normal terminal. Values longer
  // than the cap simply are not padded — misaligned by a few columns beats
  // truncating a value a mutation could hide behind.
  const valueWidth = Math.min(60, Math.max(header.value.length, ...rows.map((k) => k.value.length)));
  const sealedWidth = header.sealed.length;

  const row = (key: string, value: string, sealed: string, source: string): string =>
    `${key.padEnd(keyWidth)}  ${value.padEnd(valueWidth)}  ${sealed.padEnd(sealedWidth)}  ${source}`;

  const lines = [
    row(header.key, header.value, header.sealed, header.source),
    ...rows.map((k) => row(k.key, k.value, k.sealed ? 'sì' : 'no', k.source)),
    '',
    'sigillato = dentro il Root of Trust: per cambiarlo, modifica il file e poi `muffin rot reseal`.',
  ];
  return lines.join('\n');
}

/**
 * `muffin config set <chiave> <valore>` — questa funzione fa solo argv e
 * stampa; la decisione è tutta in `setConfigKnob`. Exit 0 su una scrittura o
 * un "già così" (idempotente, come `cmdSurfaceDefault`), 78 (EX_USAGE) su una
 * chiave o un valore che il comando rifiuta — mai un errore generico: l'owner
 * ha già la lista delle chiavi valide nel messaggio.
 */
export function cmdConfigSet(home: string, argv: string[]): number {
  const [key, ...rest] = argv;
  const value = rest.join(' ');
  if (key === undefined || value === '') {
    process.stderr.write(CONFIG_USAGE);
    return 78;
  }
  const outcome = setConfigKnob(home, key, value);
  const line = formatSetOutcome(outcome);
  if (!outcome.ok) {
    process.stderr.write(`${line}\n`);
    return 78;
  }
  process.stdout.write(`${line}\n`);
  return 0;
}
