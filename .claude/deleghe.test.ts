import { cpSync, chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'deleghe.mjs');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function fixture(): { repo: string; env: NodeJS.ProcessEnv } {
  const repo = mkdtempSync(join(tmpdir(), 'muffin-deleghe-'));
  mkdirSync(join(repo, '.claude', 'deleghe'), { recursive: true });
  cpSync(SCRIPT, join(repo, '.claude', 'deleghe.mjs'));

  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-m', 'base');

  git(repo, 'switch', '-c', 'slice/documenti');
  writeFileSync(join(repo, 'documenti.txt'), 'done\n');
  git(repo, 'add', 'documenti.txt');
  git(repo, 'commit', '-m', 'documents');
  const documents = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'switch', '-c', 'dev', 'main');
  git(repo, 'merge', '--no-ff', 'slice/documenti', '-m', 'Merge pull request #27 from owner/slice/documenti');
  git(repo, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(repo, 'update-ref', 'refs/remotes/origin/slice/documenti', documents);

  git(repo, 'switch', '-c', 'slice/aperta');
  writeFileSync(join(repo, 'aperta.txt'), 'open\n');
  git(repo, 'add', 'aperta.txt');
  git(repo, 'commit', '-m', 'open work');
  git(repo, 'update-ref', 'refs/remotes/origin/slice/aperta', 'HEAD');
  git(repo, 'switch', 'dev');

  writeFileSync(
    join(repo, '.claude', 'deleghe', 'registro.jsonl'),
    [
      { id: 'done', slug: 'documenti', branch: 'slice/documenti', cosa: 'C7' },
      { id: 'open', slug: 'aperta', branch: 'slice/aperta', cosa: 'B2' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n',
  );

  const bin = join(repo, 'bin');
  mkdirSync(bin);
  const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  symlinkSync(gitPath, join(bin, 'git'));
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'gh'), 0o755);
  return { repo, env: { ...process.env, PATH: bin } };
}

describe('delegation handoff without GitHub', () => {
  it('keeps locally integrated work closed and uncertain work non-actionable', () => {
    const f = fixture();
    const output = execFileSync(process.execPath, [join(f.repo, '.claude', 'deleghe.mjs'), 'riprendi'], {
      cwd: f.repo,
      env: f.env,
      encoding: 'utf8',
    });

    expect(output).toContain('GitHub non disponibile');
    expect(output).toContain('CHIUSE (1)');
    expect(output).toContain('documenti');
    expect(output).toContain('ancestry Git locale');
    expect(output).toContain('APERTE (0)');
    expect(output).toContain('SCONOSCIUTE (1)');
    expect(output).toContain('aperta');
    expect(output).toContain('non riprendere senza verifica');
  });
});
