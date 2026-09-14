#!/usr/bin/env node
/**
 * Verifies the contributor agreement's DCO sign-off for every non-merge commit
 * introduced by a PR. The caller supplies the base and head SHA, so this script
 * sees the same range the merge gate is about to integrate.
 *
 * The DCO's legal assertion comes from the human sign-off, not from pretending
 * Git metadata proves identity. Requiring the trailer to match the commit
 * author catches the common accidental `git commit` without `-s` while leaving
 * ownership and identity claims to the DCO itself.
 */
import { execFileSync } from 'node:child_process';

const RECORD = '\x1e';
const FIELD = '\x1f';

export type Commit = { sha: string; authorName: string; authorEmail: string; body: string };

export function missingSignoffs(commits: readonly Commit[]): Commit[] {
  return commits.filter((commit) => {
    const expected = `Signed-off-by: ${commit.authorName} <${commit.authorEmail}>`;
    return !commit.body
      .split(/\r?\n/)
      .some((line) => line.toLowerCase() === expected.toLowerCase());
  });
}

export function commitsBetween(base: string, head: string, cwd = process.cwd()): Commit[] {
  const output = execFileSync(
    'git',
    [
      '-C',
      cwd,
      'log',
      '--no-merges',
      `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%B${RECORD}`,
      `${base}..${head}`,
    ],
    {
      encoding: 'utf8',
    },
  );
  return output
    .split(RECORD)
    .filter(Boolean)
    .map((record) => {
      const [sha, authorName, authorEmail, ...body] = record.split(FIELD);
      if (!sha || !authorName || !authorEmail)
        throw new Error(`could not parse commit in ${base}..${head}`);
      return { sha, authorName, authorEmail, body: body.join(FIELD) };
    });
}

export function checkDco(base: string, head: string, cwd = process.cwd()): string[] {
  const missing = missingSignoffs(commitsBetween(base, head, cwd));
  if (missing.length === 0) return [];
  return missing.map(
    (commit) => `${commit.sha.slice(0, 12)} ${commit.authorName} <${commit.authorEmail}>`,
  );
}

const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    process.stderr.write('usage: npx tsx scripts/check-dco.ts <base-sha> <head-sha>\n');
    process.exitCode = 64;
  } else {
    const missing = checkDco(base, head);
    if (missing.length > 0) {
      process.stderr.write(
        `DCO missing or does not match commit author:\n${missing.map((line) => `  ${line}`).join('\n')}\n` +
          'Amend each listed commit with `git commit --amend -s --no-edit`, then force-push.\n',
      );
      process.exitCode = 1;
    } else {
      process.stdout.write('DCO: every introduced non-merge commit is signed off.\n');
    }
  }
}
