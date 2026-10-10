import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPullRequestDco, parseCommitLog } from './check-dco.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'muffin-dco-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'base');
  git(root, 'config', 'user.name', 'Fixture Maintainer');
  git(root, 'config', 'user.email', 'maintainer@example.test');
  execFileSync('node', ['-e', "require('node:fs').writeFileSync('base.txt', 'base')"], {
    cwd: root,
  });
  git(root, 'add', 'base.txt');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function addCommit(
  root: string,
  { name, email, signedOff }: { name: string; email: string; signedOff: boolean },
): string {
  const file = `${name.replaceAll(' ', '-')}.txt`;
  execFileSync(
    'node',
    ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'change')`],
    { cwd: root },
  );
  git(root, 'add', file);
  const message = signedOff ? `change\n\nSigned-off-by: ${name} <${email}>` : 'change';
  execFileSync('git', [
    '-C',
    root,
    '-c',
    `user.name=${name}`,
    '-c',
    `user.email=${email}`,
    'commit',
    '-q',
    '-m',
    message,
  ]);
  return git(root, 'rev-parse', 'HEAD');
}

function event(
  base: string,
  head: string,
  baseRef = 'dev',
  headRef = 'codex/change',
  baseRepo = 'muffin-project/muffin-agent',
  headRepo = baseRepo,
) {
  return {
    pull_request: {
      base: { ref: baseRef, sha: base, repo: { full_name: baseRepo } },
      head: { ref: headRef, sha: head, repo: { full_name: headRepo } },
    },
  };
}

describe('DCO contribution gate', () => {
  it('accepts a human-signed contribution commit in the exact base/head range', () => {
    const root = repository();
    const base = git(root, 'rev-parse', 'HEAD');
    const head = addCommit(root, {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      signedOff: true,
    });

    expect(checkPullRequestDco(event(base, head), root)).toEqual({ kind: 'check', missing: [] });
    expect(
      checkPullRequestDco(
        event(
          base,
          head,
          'dev',
          'contribution',
          'muffin-project/muffin-agent',
          'outside/contribution',
        ),
        root,
      ),
    ).toEqual({
      kind: 'check',
      missing: [],
    });
  });

  it('rejects an imported unsigned external author commit even when the PR is internal', () => {
    const root = repository();
    const base = git(root, 'rev-parse', 'HEAD');
    const unsigned = addCommit(root, {
      name: 'External Author',
      email: 'external@example.test',
      signedOff: false,
    });
    const head = addCommit(root, {
      name: 'Fixture Maintainer',
      email: 'maintainer@example.test',
      signedOff: true,
    });

    expect(checkPullRequestDco(event(base, head), root)).toEqual({
      kind: 'check',
      missing: [`${unsigned.slice(0, 12)} External Author <external@example.test>`],
    });
  });

  it('rejects a missing or mismatched sign-off instead of treating it as certification', () => {
    const root = repository();
    const base = git(root, 'rev-parse', 'HEAD');
    const head = addCommit(root, {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      signedOff: false,
    });
    const range = event(base, head);
    // A trailer signed by someone else does not satisfy the commit author's DCO gate.
    git(
      root,
      'commit',
      '--amend',
      '-q',
      '-m',
      'change\n\nSigned-off-by: Grace Hopper <grace@example.test>',
    );
    const amended = git(root, 'rev-parse', 'HEAD');
    expect(
      checkPullRequestDco(
        {
          ...range,
          pull_request: {
            ...range.pull_request,
            head: { ...range.pull_request.head, sha: amended },
          },
        },
        root,
      ),
    ).toMatchObject({
      kind: 'check',
      missing: [`${amended.slice(0, 12)} Ada Lovelace <ada@example.test>`],
    });
  });

  it('skips only the canonical same-repository dev to main promotion', () => {
    const root = repository();
    const base = git(root, 'rev-parse', 'HEAD');
    const head = addCommit(root, {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      signedOff: false,
    });
    expect(checkPullRequestDco(event('a'.repeat(40), 'b'.repeat(40), 'main', 'dev'))).toEqual({
      kind: 'skip',
      reason: 'canonical dev -> main promotion; preserve inherited pre-gate commits',
    });
    expect(
      checkPullRequestDco(
        event(base, head, 'main', 'dev', 'muffin-project/muffin-agent', 'fork/muffin-agent'),
        root,
      ),
    ).toEqual({
      kind: 'check',
      missing: [`${head.slice(0, 12)} Ada Lovelace <ada@example.test>`],
    });
    expect(
      checkPullRequestDco(
        event(
          base,
          head,
          'main',
          'feature',
          'muffin-project/muffin-agent',
          'muffin-project/muffin-agent',
        ),
        root,
      ),
    ).toEqual({
      kind: 'check',
      missing: [`${head.slice(0, 12)} Ada Lovelace <ada@example.test>`],
    });
  });

  it('fails closed when the event omits PR metadata or supplies abbreviated SHAs', () => {
    expect(() => checkPullRequestDco({})).toThrow('event does not contain a pull_request');
    expect(() => checkPullRequestDco(event('abc', 'def'))).toThrow('must be full commit SHAs');
  });

  it("ignores Git's trailing newline after the final record separator", () => {
    const output = `a${'a'.repeat(39)}\x1fAda\x1fada@example.test\x1fSigned-off-by: Ada <ada@example.test>\x1e\n`;
    expect(parseCommitLog(output, 'base', 'head')).toHaveLength(1);
  });

  it('runs the same gate through the CI event and two-SHA command interfaces', () => {
    const root = repository();
    const base = git(root, 'rev-parse', 'HEAD');
    const head = addCommit(root, {
      name: 'Fixture Maintainer',
      email: 'maintainer@example.test',
      signedOff: true,
    });
    const checker = fileURLToPath(new URL('./check-dco.ts', import.meta.url));
    const loader = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [loader, checker, ...args], { cwd: root, encoding: 'utf8' });
    const eventPath = join(root, 'event.json');
    writeFileSync(eventPath, JSON.stringify(event(base, head)));
    expect(run('--pull-request-event', eventPath)).toContain(
      'every introduced non-merge commit is signed off',
    );
    expect(run(base, head)).toContain('every introduced non-merge commit is signed off');
    const unsigned = addCommit(root, {
      name: 'External Author',
      email: 'external@example.test',
      signedOff: false,
    });
    writeFileSync(eventPath, JSON.stringify(event(base, unsigned)));
    expect(() => run('--pull-request-event', eventPath)).toThrow();
    expect(() => run(base, unsigned)).toThrow();
  });
});
