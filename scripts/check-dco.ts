#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
/**
 * Verifies the contributor agreement's DCO sign-off for every non-merge commit
 * introduced by a contribution PR. Only the canonical same-repository dev to
 * main promotion skips rechecking integrated history, including pre-gate commits.
 *
 * A matching trailer is a mechanical check, not proof of identity or a truthful
 * certification. The human signer remains responsible for the DCO statement.
 */
import { readFileSync } from 'node:fs';

const RECORD = '\x1e';
const FIELD = '\x1f';
const REPOSITORY = 'muffin-project/muffin-agent';

export type Commit = { sha: string; authorName: string; authorEmail: string; body: string };
export type PullRequestEvent = {
  base: { ref: string; sha: string; repository: string };
  head: { ref: string; sha: string; repository: string };
};
export type DcoResult = { kind: 'skip'; reason: string } | { kind: 'check'; missing: string[] };

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
    { encoding: 'utf8' },
  );
  return parseCommitLog(output, base, head);
}

export function parseCommitLog(output: string, base: string, head: string): Commit[] {
  return output
    .split(RECORD)
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha, authorName, authorEmail, ...body] = record.split(FIELD);
      if (!sha || !authorName || !authorEmail)
        throw new Error(`could not parse commit in ${base}..${head}`);
      // Git inserts a newline between records as well as after the last one.
      return { sha: sha.trim(), authorName, authorEmail, body: body.join(FIELD) };
    });
}

export function checkDco(base: string, head: string, cwd = process.cwd()): string[] {
  return missingSignoffs(commitsBetween(base, head, cwd)).map(
    (commit) => `${commit.sha.slice(0, 12)} ${commit.authorName} <${commit.authorEmail}>`,
  );
}

export function parsePullRequestEvent(value: unknown): PullRequestEvent {
  if (typeof value !== 'object' || value === null || !('pull_request' in value))
    throw new Error('DCO: event does not contain a pull_request');
  const pr = value.pull_request;
  if (typeof pr !== 'object' || pr === null) throw new Error('DCO: malformed pull_request event');
  const base = 'base' in pr ? pr.base : undefined;
  const head = 'head' in pr ? pr.head : undefined;
  const stringAt = (value: unknown, key: string): string | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;
    const field = (value as Record<string, unknown>)[key];
    return typeof field === 'string' ? field : undefined;
  };
  const result = {
    base: {
      ref: stringAt(base, 'ref'),
      sha: stringAt(base, 'sha'),
      repository: stringAt(
        typeof base === 'object' && base !== null && 'repo' in base ? base.repo : undefined,
        'full_name',
      ),
    },
    head: {
      ref: stringAt(head, 'ref'),
      sha: stringAt(head, 'sha'),
      repository: stringAt(
        typeof head === 'object' && head !== null && 'repo' in head ? head.repo : undefined,
        'full_name',
      ),
    },
  };
  if (
    Object.values(result.base).some((field) => !field) ||
    Object.values(result.head).some((field) => !field)
  )
    throw new Error('DCO: could not resolve PR base/head repository, branch, or SHA from event');
  if (
    !/^[0-9a-f]{40}$/i.test(result.base.sha ?? '') ||
    !/^[0-9a-f]{40}$/i.test(result.head.sha ?? '')
  )
    throw new Error('DCO: PR base/head must be full commit SHAs');
  return result as PullRequestEvent;
}

export function checkPullRequestDco(event: unknown, cwd = process.cwd()): DcoResult {
  const pr = parsePullRequestEvent(event);
  if (
    pr.base.ref === 'main' &&
    pr.head.ref === 'dev' &&
    pr.base.repository === REPOSITORY &&
    pr.head.repository === REPOSITORY
  ) {
    return {
      kind: 'skip',
      reason: 'canonical dev -> main promotion; preserve inherited pre-gate commits',
    };
  }
  const missing = checkDco(pr.base.sha, pr.head.sha, cwd);
  return { kind: 'check', missing };
}

const isMain = process.argv[1] === new URL(import.meta.url).pathname;
if (isMain) {
  const [mode, value] = process.argv.slice(2);
  if (mode === '--pull-request-event' && value) {
    const event = JSON.parse(readFileSync(value, 'utf8')) as unknown;
    const result = checkPullRequestDco(event);
    if (result.kind === 'skip') {
      process.stdout.write(`DCO: ${result.reason}.\n`);
    } else if (result.missing.length > 0) {
      process.stderr.write(
        `DCO missing or does not match commit author:\n${result.missing.map((line) => `  ${line}`).join('\n')}\n` +
          'For a commit you can truthfully certify, add its sign-off before publication. Ask another author to sign their own commit. Never change another author’s identity or sign on their behalf.\n',
      );
      process.exitCode = 1;
    } else {
      process.stdout.write('DCO: every introduced non-merge commit is signed off.\n');
    }
  } else if (mode && value && mode !== '--pull-request-event') {
    const missing = checkDco(mode, value);
    if (missing.length > 0) {
      process.stderr.write(
        `DCO missing or does not match commit author:\n${missing.map((line) => `  ${line}`).join('\n')}\n` +
          'For a commit you can truthfully certify, add its sign-off before publication. Ask another author to sign their own commit. Never change another author’s identity or sign on their behalf.\n',
      );
      process.exitCode = 1;
    } else {
      process.stdout.write('DCO: every introduced non-merge commit is signed off.\n');
    }
  } else {
    process.stderr.write(
      'usage: check-dco.ts --pull-request-event <event.json> | <base-sha> <head-sha>\n',
    );
    process.exitCode = 64;
  }
}
