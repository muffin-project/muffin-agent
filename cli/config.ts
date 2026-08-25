import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { ConfigError } from '../core/config/config.js';
import { listConfigKnobs, type ConfigKnob } from '../core/config/inventory.js';

/**
 * `muffin config` — read-only, on purpose (ADR-0036).
 *
 * It answers "what can I adjust, and where" completely without building a
 * write surface anything has to guard: every knob, its current value, the
 * file it lives in, and whether that file is sealed. Prior art looked at
 * before choosing the shape (`docs/PRACTICES.md` §3) — `git config --list
 * --show-origin` pairs a value with the file it came from but has no sealed
 * axis to show; `gh config list` is bare key=value with no origin at all;
 * `aws configure list` is the closest match, a table of Name / Value / Type /
 * Location. This is that shape with "Type" replaced by "Sigillato", the one
 * column none of the three needed and this command exists to answer.
 */

export function cmdConfig(home: string, argv: string[]): number {
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

  process.stdout.write(values.json ? `${JSON.stringify(knobs, null, 2)}\n` : `${formatConfigKnobs(knobs, home)}\n`);
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
