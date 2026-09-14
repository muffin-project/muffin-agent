#!/usr/bin/env node
/**
 * Censimento licenze delle dipendenze (ADR-0078).
 *
 * ADR-0019 prometteva questo controllo in CI ma non è mai esistito: nessun
 * file lo implementava. Questo script lo rende reale e gira nel merge gate
 * (via step `licenze delle dipendenze` in `.github/workflows/ci.yml`, che
 * `ci:local` eredita dai workflow).
 *
 * Politica sotto AGPL-3.0-or-later:
 * - FAIL: licenza proprietaria, UNLICENSED, mancante o illeggibile. Una di
 *   queste nel bundle è un publication blocker, non un warning.
 * - INFO (mai fail): copyleft (GPL/AGPL/LGPL and family) — usabile inbound
 *   sotto AGPL, ma va saputo e registrato nel log.
 * - WARN: `SEE LICENSE IN <file>` o forme non SPDX — umano da chiarire, ma non
 *   un blocco: molti pacchetti corretti usano questa forma.
 *
 * Uso: `node scripts/check-dep-licenses.mjs [rootDir]`
 * Il secondo argomento esiste per falsificare lo script contro una fixture
 * senza toccare `node_modules` veri.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? join(import.meta.dirname, '..', 'node_modules');

const FAIL_RE = /proprietary|unlicensed/i;
const COPYLEFT_RE = /\b(a?gpl|lgpl|affero|copyleft)\b/i;
const WARN_RE = /see license/i;

const fail = [];
const warn = [];
const copyleft = [];
let counted = 0;

const readPkg = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
};

for (const entry of readdirSync(root)) {
  if (entry.startsWith('.')) continue;
  const dir = join(root, entry);
  const subs = entry.startsWith('@')
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(dir, e.name))
    : [dir];
  for (const sub of subs) {
    const pkg = readPkg(sub);
    if (!pkg) continue;
    counted += 1;
    const name = `${pkg.name ?? sub}@${pkg.version ?? '?'}`;
    const lic =
      typeof pkg.license === 'string'
        ? pkg.license
        : typeof pkg.license?.type === 'string'
          ? pkg.license.type
          : Array.isArray(pkg.licenses)
            ? pkg.licenses.map((l) => l.type ?? l).join(' AND ')
            : '';
    if (!lic) fail.push(`${name}: licenza mancante`);
    else if (FAIL_RE.test(lic)) fail.push(`${name}: ${lic}`);
    else if (COPYLEFT_RE.test(lic)) copyleft.push(`${name}: ${lic}`);
    else if (WARN_RE.test(lic)) warn.push(`${name}: ${lic}`);
  }
}

console.log(
  `dipendenze censite: ${counted}, copyleft: ${copyleft.length}, warn: ${warn.length}, fail: ${fail.length}`,
);
for (const c of copyleft) console.log(`  copyleft: ${c}`);
for (const w of warn) console.log(`  warn: ${w}`);
for (const f of fail) console.log(`  FAIL: ${f}`);

if (!existsSync(root) || counted === 0) {
  console.log('FAIL: nessuna dipendenza trovata — lanciare dopo `npm ci`');
  process.exit(2);
}
if (fail.length > 0) process.exit(1);
