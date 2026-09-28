#!/usr/bin/env node
/**
 * Deterministic fresh-session snapshot for this repository.
 *
 * Usage: scripts/agent/repo-state.mjs
 *
 * Prints a compact current-state snapshot derived from Git/GitHub/toolchain —
 * never from handoff prose or conversation memory. Used by /start.
 * The `main`/`dev` SHAs are the live GitHub ones beside the local refs, and
 * every worktree is listed, so a fresh session cannot read a stale local branch
 * or an omitted worktree as current state.
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
const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
const githubBranch = (name) =>
  repo ? gh(['api', `repos/${repo}/branches/${name}`, '--jq', '.commit.sha']) : null;
const localMain = git('rev-parse refs/heads/main') || 'unknown';
const localDev = git('rev-parse refs/heads/dev') || 'unknown';
const liveMain = githubBranch('main');
const liveDev = githubBranch('dev');
const worktreeList = git('worktree list --porcelain');
const worktrees = (worktreeList ?? '')
  .split('\n')
  .filter((l) => l.startsWith('worktree '))
  .map((l) => l.slice('worktree '.length));
const worktreeDirty = [];
const worktreeUnavailable = [];
for (const wt of worktrees) {
  const s = run('git', ['-C', wt, 'status', '--porcelain']);
  if (s === null) worktreeUnavailable.push(wt);
  else if (s !== '') worktreeDirty.push(wt);
}

const prRaw = gh([
  'pr',
  'list',
  '--state',
  'open',
  '--limit',
  '50',
  '--json',
  'number,title,isDraft,headRefName,baseRefName,files',
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
  'number,title,labels,assignees',
]);
let issues = [];
try {
  issues = JSON.parse(issueRaw || '[]');
} catch {
  issues = [];
}

const jevKey = process.env.TYPESAFE_API_KEY ? 'present' : 'absent';
const jevSdk = run('node', ['-e', "require.resolve('@typesafe-ai/sdk')"]) !== null;
const jevCli = run('which', ['jev']) !== null;

const short = (sha) => (sha ? sha.slice(0, 12) : 'unknown');

section('repository', [
  `checkout branch: ${branch} @ ${head} (${dirty ? 'DIRTY' : 'clean'})`,
  `GitHub main: ${short(liveMain)} | local main: ${short(localMain)}`,
  `GitHub dev: ${short(liveDev)} | local dev: ${short(localDev)}`,
  // A failed `worktree list` must not read as "zero worktrees" — that is the
  // same silent omission this script exists to prevent, one level up.
  ...(worktreeList === null
    ? ['worktrees: unknown (git worktree list failed)']
    : [
        `worktrees: ${worktrees.length} — clean ${worktrees.length - worktreeDirty.length - worktreeUnavailable.length}, dirty ${worktreeDirty.length}, unavailable ${worktreeUnavailable.length}`,
        ...(worktreeDirty.length ? [`dirty: ${worktreeDirty.join(', ')}`] : []),
        ...(worktreeUnavailable.length ? [`unavailable: ${worktreeUnavailable.join(', ')}`] : []),
      ]),
]);

section('open PRs', [
  prs.length
    ? `${prs.length} open: ` +
      prs.map((p) => `#${p.number}${p.isDraft ? '[draft]' : '[ready]'} ${p.baseRefName}<-${p.headRefName}`).join(' | ')
    : 'none (or gh unavailable)',
]);

const claimed = issues.filter((i) => (i.assignees || []).length > 0);
section('open issue graph', [
  issues.length
    ? `${issues.length} open issues loaded; ${claimed.length} have GitHub assignees`
    : 'none (or gh unavailable)',
  ...issues.slice(0, 12).map((i) => {
    const owners = (i.assignees || []).map((a) => a.login).join(', ') || 'unclaimed';
    return `#${i.number} [${owners}] ${i.title}`;
  }),
]);

const filePaths = (pr) => (pr.files || [])
  .map((f) => (typeof f === 'string' ? f : f.path))
  .filter(Boolean);
const overlaps = [];
for (let i = 0; i < prs.length; i += 1) {
  const left = new Set(filePaths(prs[i]));
  for (let j = i + 1; j < prs.length; j += 1) {
    const common = filePaths(prs[j]).filter((path) => left.has(path));
    if (common.length) overlaps.push(`#${prs[i].number} / #${prs[j].number}: ${common.join(', ')}`);
  }
}
section('open PR file-scope overlaps', [
  ...(prs.length
    ? overlaps.length
      ? overlaps
      : ['none observed; unpublished worktree/branch claims still need coordination']
    : ['unknown (or gh unavailable)']),
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
