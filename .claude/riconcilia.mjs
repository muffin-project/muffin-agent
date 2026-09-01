#!/usr/bin/env node
/**
 * Verify one narrow property: LAVORO.md must not describe already-finished work
 * as live.
 *
 * Product/DAY-1 truth is intentionally out of scope. Requirement status requires evidence
 * and PERCORSO ordering requires reasoning; a regex checker would only create a
 * false second authority for those questions.
 *
 * Usage:
 *   node .claude/riconcilia.mjs
 *   node .claude/riconcilia.mjs --stato <pr-state.json>
 *
 * Exit 0 = coherent, 1 = stale handoff, 2 = state could not be established.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LAVORO = 'docs/work/handoff.md';

export function righeLogiche(testo) {
  const out = [];
  for (const raw of testo.split('\n')) {
    const riga = raw.trimEnd();
    const nuova =
      riga.trim() === '' ||
      /^\s*([-*+]\s|\d+\.\s|\||#{1,6}\s|>)/.test(riga) ||
      out.length === 0;
    if (nuova) out.push(riga);
    else out[out.length - 1] += ` ${riga.trim()}`;
  }
  return out;
}

const LIVE = /\b(?:open|draft|live|wip|in volo|in corso|in giudizio)\b/i;
const DONE = /\b(?:merged?|mergiat[oaie]?|closed|chius[oaie]?|integrat[oaie]?|fatto)\b/i;

/** PR numbers explicitly described as current work in LAVORO. */
export function prDichiarateVive(testo) {
  const out = new Set();
  for (const riga of righeLogiche(testo)) {
    if (!LIVE.test(riga) || DONE.test(riga)) continue;
    for (const m of riga.matchAll(/(?:^|[\s*(«"'`])#(\d{1,4})\b/g)) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/** slice branches explicitly described as current work in LAVORO. */
export function branchDichiaratiVivi(testo) {
  const out = new Set();
  for (const riga of righeLogiche(testo)) {
    if (!LIVE.test(riga) || DONE.test(riga)) continue;
    for (const m of riga.matchAll(/`?(slice\/[a-z0-9][a-z0-9-]*)`?/gi)) out.add(m[1]);
  }
  return [...out].sort();
}

export function riconcilia({ testo, statoPr, branchRemoti, branchLocali = [] }) {
  const reperti = [];

  for (const numero of prDichiarateVive(testo)) {
    const stato = statoPr[numero];
    if (!stato) continue;
    if (stato.state !== 'OPEN') {
      const label = stato.state === 'MERGED' ? 'mergiata' : 'chiusa';
      reperti.push(`#${numero} è ${label} ma LAVORO.md la descrive come lavoro live`);
    }
  }

  const esistenti = new Set([...branchRemoti, ...branchLocali]);
  for (const branch of branchDichiaratiVivi(testo)) {
    if (!esistenti.has(branch)) {
      reperti.push(`\`${branch}\` è descritto come live ma non esiste né su origin né in locale`);
    }
  }

  return reperti;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function statoDaGh() {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,state,headRefName'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const stato = {};
    for (const pr of JSON.parse(out)) stato[pr.number] = { state: pr.state, headRefName: pr.headRefName };
    return stato;
  } catch {
    return null;
  }
}

function main() {
  let radice;
  try {
    radice = git(['rev-parse', '--show-toplevel']);
  } catch {
    process.stderr.write('non riesco a trovare la root Git\n');
    process.exit(2);
  }

  let testo;
  try {
    testo = readFileSync(join(radice, LAVORO), 'utf8');
  } catch {
    process.stderr.write(`non riesco a leggere ${LAVORO}\n`);
    process.exit(2);
  }

  const argIdx = process.argv.indexOf('--stato');
  const statoPr =
    argIdx !== -1
      ? JSON.parse(readFileSync(process.argv[argIdx + 1], 'utf8'))
      : statoDaGh();
  if (statoPr === null) {
    process.stderr.write(
      'non riesco a leggere lo stato PR: usa gh autenticato oppure --stato <file.json>\n',
    );
    process.exit(2);
  }

  let branchRemoti;
  let branchLocali;
  try {
    branchRemoti = git(['ls-remote', '--heads', 'origin'])
      .split('\n')
      .map((r) => r.split('refs/heads/')[1])
      .filter(Boolean);
    branchLocali = git(['branch', '--format=%(refname:short)'])
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean);
  } catch {
    process.stderr.write('non riesco a stabilire i branch locali/remoti\n');
    process.exit(2);
  }

  const reperti = riconcilia({ testo, statoPr, branchRemoti, branchLocali });
  if (reperti.length === 0) {
    process.stdout.write(
      `handoff riconciliato: ${prDichiarateVive(testo).length} PR live, ${branchDichiaratiVivi(testo).length} branch live\n`,
    );
    process.exit(0);
  }

  process.stdout.write(
    `handoff NON riconciliato (${reperti.length}):\n${reperti.map((r) => `  · ${r}`).join('\n')}\n`,
  );
  process.stderr.write(`\n→ aggiorna ${LAVORO}; non correggere i requisiti DAY-1 o il percorso critico per far tacere questo checker\n`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
