#!/usr/bin/env node
/**
 * Deterministic fresh-session snapshot for this repository.
 *
 * Usage: scripts/agent/repo-state.mjs
 *
 * Prints a compact current-state snapshot derived from Git/GitHub/toolchain —
 * never from handoff prose or conversation memory. Used by /start.
 * Each section is best-effort: on failure it prints `unknown` rather than
 * failing, so a fresh session always gets something to work from.
 * Exit 0 = snapshot complete, 1 = git unavailable (not a repository checkout).
 */

import { execFileSync } from 'node:child_process';

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

function section(title, lines) {
  console.log(`## ${title}`);
  for (const l of lines) console.log(`- ${l}`);
  console.log('');
}

const git = (cmd) => run('git', cmd.split(' '));
const gh = (args) => run('gh', args);

if (!git('rev-parse --show-toplevel')) {
  console.log('repo-state: not inside a git checkout');
  process.exit(1);
}

const branch = git('branch --show-current') || '(detached)';
const head = git('rev-parse --short HEAD') || 'unknown';
const dirty = git('status --porcelain');
const main = git('rev-parse --short main') || 'unknown';
const dev = git('rev-parse --short dev') || 'unknown';
const div = git('rev-list --left-right --count main...dev');
const worktrees = (git('worktree list --porcelain') || '')
  .split('\n')
  .filter((l) => l.startsWith('worktree '))
  .map((l) => l.slice('worktree '.length));
const worktreeDirty = [];
for (const wt of worktrees.slice(0, 40)) {
  const s = run('git', ['-C', wt, 'status', '--porcelain']);
  if (s === null || s === '') continue;
  worktreeDirty.push(wt);
}

const prRaw = gh([
  'pr',
  'list',
  '--state',
  'open',
  '--limit',
  '50',
  '--json',
  'number,title,isDraft,headRefName,baseRefName',
]);
let prs = [];
try {
  prs = JSON.parse(prRaw || '[]');
} catch {
  prs = [];
}

const issueRaw = gh([
  'issue',
  'list',
  '--state',
  'open',
  '--limit',
  '100',
  '--json',
  'number,title,labels',
]);
let program = [];
try {
  const issues = JSON.parse(issueRaw || '[]');
  program = issues.filter((i) =>
    (i.labels || []).some((l) => l.name === 'program/current'),
  );
} catch {
  program = [];
}

const jevKey = process.env.TYPESAFE_API_KEY ? 'present' : 'absent';
const jevSdk = run('node', ['-e', "require.resolve('@typesafe-ai/sdk')"]) !== null;
const jevCli = run('which', ['jev']) !== null;

section('repository', [
  `checkout branch: ${branch} @ ${head} (${dirty ? 'DIRTY' : 'clean'})`,
  `main: ${main} | dev: ${dev} | divergence main...dev (behind ahead): ${div || 'unknown'}`,
  `worktrees: ${worktrees.length}${worktreeDirty.length ? `; dirty: ${worktreeDirty.join(', ')}` : '; all clean or unchecked'}`,
]);

section('open PRs', [
  prs.length
    ? `${prs.length} open: ` +
      prs.map((p) => `#${p.number}${p.isDraft ? '[draft]' : '[ready]'} ${p.baseRefName}<-${p.headRefName}`).join(' | ')
    : 'none (or gh unavailable)',
]);

section('current program', [
  program.length === 1
    ? `program/current → #${program[0].number} ${program[0].title}`
    : `INCONSISTENT: ${program.length} open issues carry program/current (want exactly 1)`,
]);

const closedRaw = gh([
  'pr',
  'list',
  '--state',
  'closed',
  '--limit',
  '100',
  '--json',
  'number,title,labels',
]);
let parked = [];
let superseded = [];
try {
  const closed = JSON.parse(closedRaw || '[]');
  const names = (p) => (p.labels || []).map((l) => l.name);
  parked = closed.filter((p) => names(p).includes('preview/parked'));
  superseded = closed.filter((p) => names(p).includes('preview/superseded'));
} catch {
  /* leave empty */
}

section('parked / superseded (closed, branch kept)', [
  `parked: ${parked.length ? parked.map((p) => `#${p.number} ${p.title.slice(0, 60)}`).join(' | ') : 'none'}`,
  `superseded: ${superseded.length ? superseded.map((p) => `#${p.number} ${p.title.slice(0, 60)}`).join(' | ') : 'none'}`,
]);

section('judgment availability', [
  `jev: TYPESAFE_API_KEY=${jevKey}, sdk=${jevSdk ? 'installed' : 'absent'}, cli=${jevCli ? 'present' : 'absent'}${jevKey === 'absent' ? ' → deterministic routing only' : ''}`,
]);

section('toolchain', [
  `opencode: ${(run('opencode', ['--version']) || 'unknown').split('\n')[0]}`,
  `node: ${run('node', ['--version']) || 'unknown'} | gh: ${(run('gh', ['--version']) || 'unknown').split('\n')[0]}`,
]);
