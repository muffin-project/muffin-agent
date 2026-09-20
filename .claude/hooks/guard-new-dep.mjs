#!/usr/bin/env node
/**
 * PreToolUse hook: a new dependency does not get installed casually.
 *
 * This is practice §6 made deterministic (docs/development/PRACTICES.md): frontier models
 * hallucinate package names at 4.6-6.1%, attackers register the hallucinated
 * names, and `npm install` is the moment the supply chain opens. Prose saying
 * "check the docs first" is advisory; an exit code is not.
 *
 * Blocks `npm install <pkg>` when <pkg> is not already in package.json, with
 * the way through stated in the message: read the real docs, then re-run with
 * MUFFIN_DEP_OK=1. The override is an environment variable on purpose — it
 * cannot happen by accident, and it shows up in the transcript as a deliberate
 * act. Installs with no package argument (`npm install`, `npm ci`) pass: they
 * only materialise what the lockfile already says.
 */
import { readFileSync } from 'node:fs';

let input = '';
try {
  input = readFileSync(0, 'utf8');
} catch {
  process.exit(0); // no stdin, nothing to judge
}

let command = '';
try {
  command = String(JSON.parse(input)?.tool_input?.command ?? '');
} catch {
  process.exit(0);
}

const match = /\bnpm\s+(?:install|i|add)\s+(.+)/.exec(command);
if (!match) process.exit(0);
if (/\bMUFFIN_DEP_OK=1\b/.test(command)) process.exit(0);

const args = match[1]
  .split(/\s+/)
  .filter((a) => a !== '' && !a.startsWith('-') && !a.startsWith('$'));
if (args.length === 0) process.exit(0); // bare install: lockfile only

let declared = new Set();
try {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
} catch {
  process.exit(0); // no package.json to compare against: not this hook's day
}

// `@scope/name@version` → `@scope/name`; `name@1.2.3` → `name`.
const nameOf = (spec) => {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
};

const unknown = args.map(nameOf).filter((name) => !declared.has(name));
if (unknown.length === 0) process.exit(0);

process.stderr.write(
  `dipendenza nuova: ${unknown.join(', ')} — non è in package.json.\n` +
    `Prima: leggi la doc reale (Context7: resolve-library-id → query-docs), verifica che il\n` +
    `pacchetto esista e sia mantenuto, e motiva la dipendenza nel commit.\n` +
    `Poi, deliberatamente: MUFFIN_DEP_OK=1 npm install ${args.join(' ')}\n`,
);
process.exit(2);
