import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'inject-state.mjs');
const MAX = 4_000;

function homeWithWork(content: string): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-handoff-'));
  mkdirSync(join(home, 'docs', 'blueprint'), { recursive: true });
  mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
  cpSync(HOOK, join(home, '.claude', 'hooks', 'inject-state.mjs'));
  writeFileSync(join(home, 'docs', 'blueprint', 'LAVORO.md'), content);
  return home;
}

function run(home: string): string {
  return execFileSync('node', [join(home, '.claude', 'hooks', 'inject-state.mjs')], {
    input: '{}',
    encoding: 'utf8',
  });
}

const contextOf = (stdout: string): string =>
  JSON.parse(stdout).hookSpecificOutput.additionalContext as string;

describe('SessionStart operational handoff', () => {
  it('injects LAVORO directly and labels it non-authoritative', () => {
    const stdout = run(homeWithWork('# Lavoro corrente\n\n**Goal:** DAY-1 READY\n'));
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(contextOf(stdout)).toContain('**Goal:** DAY-1 READY');
    expect(contextOf(stdout)).toContain('observed Git/PR state wins');
  });

  it('does not depend on STATE.md existing or carrying a marker', () => {
    const home = homeWithWork('# Lavoro corrente\n\nwork survives without STATE\n');
    expect(contextOf(run(home))).toContain('work survives without STATE');
  });

  it('bounds bootstrap context and says when the handoff was truncated', () => {
    const context = contextOf(run(homeWithWork(`# Lavoro\n\n${'x'.repeat(6_000)}\n`)));
    expect(context.length).toBeLessThanOrEqual(MAX);
    expect(context).toMatch(/handoff truncated/);
  });

  it('injects the real LAVORO whole while it stays inside the local budget', () => {
    const context = contextOf(
      execFileSync('node', [HOOK], { input: '{}', encoding: 'utf8' }),
    );
    expect(context).toContain('# Lavoro corrente');
    expect(context).not.toMatch(/handoff truncated/);
    expect(context.length).toBeLessThanOrEqual(MAX);
  });

  it('stays silent when there is no handoff to inject', () => {
    const bare = mkdtempSync(join(tmpdir(), 'muffin-handoff-bare-'));
    mkdirSync(join(bare, '.claude', 'hooks'), { recursive: true });
    cpSync(HOOK, join(bare, '.claude', 'hooks', 'inject-state.mjs'));
    expect(run(bare)).toBe('');

    expect(run(homeWithWork('   \n'))).toBe('');
  });
});
