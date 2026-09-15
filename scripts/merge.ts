/**
 * L'unica porta per unire una PR in `dev`: `npm run merge -- <pr>`.
 *
 * Costruisce **il risultato unito** — `origin/dev` più la testa della PR — in
 * un worktree usa-e-getta, ci fa girare `ci:local` (i job veri, nei container
 * veri), e unisce solo su `PASS`. Un `FAIL` resta un fail; un `DISCARDED`
 * (exit 2, host conteso) e' un giro da rifare da soli, non un verdetto.
 *
 * Perche' il risultato unito e non il ramo: una PR verde da sola puo' rompere
 * `dev` quando si somma a un'altra PR verde da sola — e' successo il 04/09 con
 * D7 (verde sul ramo del kernel, rosso appena unita con la riscrittura dello
 * scenario). GitHub calcola il merge-ref per lo stesso motivo.
 *
 * Il verdetto viene scritto in `.ci-local/verdicts/` (per macchina, ignorato
 * da Git) con gli SHA di dev e della PR: cosi' si sa **su cosa** e' stato
 * preso, e un secondo giro sulla stessa coppia puo' essere saltato a mano
 * se lo si vuole — mai in automatico.
 *
 * Il guard `.claude/hooks/guard-merge-gate.mjs` rimanda qui ogni
 * `gh pr merge` scritto direttamente.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function git(args: string[], cwd = REPO_ROOT): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', cwd: REPO_ROOT }).trim();
}

function main(): void {
  const pr = process.argv[2];
  if (pr === undefined || !/^\d+$/.test(pr)) {
    process.stderr.write('uso: npm run merge -- <numero PR>\n');
    process.exit(64);
  }

  const info = JSON.parse(
    gh(['pr', 'view', pr, '--json', 'headRefName,baseRefName,state,headRefOid,title,author']),
  ) as {
    headRefName: string;
    baseRefName: string;
    state: string;
    headRefOid: string;
    title: string;
    author: { login: string };
  };
  if (info.state !== 'OPEN') {
    process.stderr.write(`PR #${pr} e' ${info.state}, non OPEN\n`);
    process.exit(1);
  }
  if (info.baseRefName !== 'dev') {
    // Le promozioni dev→main hanno gia' il gate dietro: dev e' stato unito
    // PR per PR da questa porta. Qui si gestisce solo l'ingresso in dev.
    process.stderr.write(
      `PR #${pr} ha base ${info.baseRefName}: questa porta unisce solo in dev\n`,
    );
    process.exit(1);
  }

  git(['fetch', '--quiet', 'origin', 'dev', info.headRefName]);
  const devSha = git(['rev-parse', 'origin/dev']);
  const headSha = git(['rev-parse', `origin/${info.headRefName}`]);
  process.stdout.write(
    `PR #${pr} «${info.title}»\n  dev  ${devSha.slice(0, 10)}\n  head ${headSha.slice(0, 10)}\n`,
  );

  // Contributor agreement (ADR-0079): current owner branches predate this
  // policy, while every external PR is blocked before build/CI if a commit
  // lacks an author-matching DCO trailer. A maintainer can still choose to
  // sign off an imported external commit; no trust is inferred from a branch.
  if (info.author.login !== 'GiustoPiedimonte') {
    const dco = spawnSync('npx', ['tsx', 'scripts/check-dco.ts', devSha, headSha], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (dco.status !== 0) {
      process.stderr.write(
        `PR #${pr} does not satisfy CONTRIBUTOR_AGREEMENT.md; not entering the merge gate.\n`,
      );
      process.exit(dco.status ?? 1);
    }
  }

  const dir = join(tmpdir(), `muffin-merge-${pr}-${headSha.slice(0, 8)}`);
  rmSync(dir, { recursive: true, force: true });
  git(['worktree', 'add', '--quiet', '--detach', dir, devSha]);
  let esito: 'pass' | 'fail' | 'discarded' | 'conflict' = 'fail';
  try {
    const merge = spawnSync('git', ['-C', dir, 'merge', '--no-edit', headSha], {
      encoding: 'utf8',
    });
    if (merge.status !== 0) {
      esito = 'conflict';
      process.stderr.write(
        `CONFLITTO fra dev e la PR — risolvilo nel ramo, non qui:\n${merge.stdout}${merge.stderr}`,
      );
      return;
    }
    const merged = git(['rev-parse', 'HEAD'], dir);
    process.stdout.write(`  unito ${merged.slice(0, 10)} — npm ci nel worktree…\n`);
    const ci = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (ci.status !== 0) {
      process.stderr.write('npm ci fallito nel worktree del merge\n');
      return;
    }
    process.stdout.write('  ci:local sul risultato unito…\n');
    const gate = spawnSync('npx', ['tsx', 'scripts/ci-local.ts'], { cwd: dir, stdio: 'inherit' });
    esito = gate.status === 0 ? 'pass' : gate.status === 2 ? 'discarded' : 'fail';

    const verdicts = join(REPO_ROOT, '.ci-local', 'verdicts');
    mkdirSync(verdicts, { recursive: true });
    writeFileSync(
      join(verdicts, `${pr}-${headSha.slice(0, 10)}-${devSha.slice(0, 10)}.json`),
      JSON.stringify(
        { pr, headSha, devSha, mergedSha: merged, esito, at: new Date().toISOString() },
        null,
        2,
      ),
    );

    if (esito !== 'pass') {
      process.stderr.write(
        esito === 'discarded'
          ? `\nCI-LOCAL DISCARDED: host conteso, non e' un verdetto. Rifai da solo: npm run merge -- ${pr}\n`
          : `\nCI-LOCAL FAIL sul risultato unito: la PR #${pr} non entra.\n`,
      );
      return;
    }
    process.stdout.write(`\nPASS sul risultato unito — unisco #${pr}\n`);
    gh(['pr', 'merge', pr, '--merge', '--delete-branch=false']);
    process.stdout.write(`${gh(['pr', 'view', pr, '--json', 'state', '-q', '.state'])}\n`);
  } finally {
    if (process.env.MUFFIN_MERGE_KEEP !== '1') {
      spawnSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', dir]);
    }
    process.exitCode = esito === 'pass' ? 0 : esito === 'discarded' ? 2 : 1;
  }
}

main();
