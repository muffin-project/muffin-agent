import { describe, expect, it } from 'vitest';
// @ts-expect-error — modulo .mjs senza dichiarazioni: e uno strumento da riga
// di comando, non una dipendenza del runtime, e resta importato com'e.
import { isStrumentiRelevant, shouldRunStrumenti } from './strumenti-scope.mjs';

describe('strumenti scope gate', () => {
  it('.claude changes run', () => {
    expect(shouldRunStrumenti(['.claude/hooks/guard-new-dep.mjs'])).toBe(true);
    expect(shouldRunStrumenti(['.claude/loop.md'])).toBe(true);
  });

  it('docs changes run (procedure.test resolves skill links against live docs)', () => {
    expect(shouldRunStrumenti(['docs/development/ORCHESTRATION.md'])).toBe(true);
    expect(shouldRunStrumenti(['README.md'])).toBe(true);
  });

  it('DAY-1 ledger runs', () => {
    expect(shouldRunStrumenti(['docs/status/day1/requirements-status.md'])).toBe(true);
  });

  it('shared config runs', () => {
    expect(shouldRunStrumenti(['tsconfig.json'])).toBe(true);
    expect(shouldRunStrumenti(['package-lock.json'])).toBe(true);
  });

  it('pure runtime skips (no .claude test imports runtime)', () => {
    expect(shouldRunStrumenti(['agent/loop/round.ts', 'agent/completion.ts'])).toBe(false);
    expect(shouldRunStrumenti(['core/mcp/connect.ts', 'core/policy/matrix.ts'])).toBe(false);
    expect(shouldRunStrumenti(['connectors/telegram/notify.ts'])).toBe(false);
  });

  it('install/docker evals skip', () => {
    expect(shouldRunStrumenti(['install.sh', 'evals/install/ubuntu.sh'])).toBe(false);
    expect(shouldRunStrumenti(['contrib/docker/Dockerfile'])).toBe(false);
  });

  it('mixed runtime+docs runs', () => {
    expect(shouldRunStrumenti(['core/mcp/connect.ts', 'docs/architecture/SECURITY.md'])).toBe(true);
  });

  it('mixed runtime+.claude runs', () => {
    expect(shouldRunStrumenti(['core/mcp/connect.ts', '.claude/loop.md'])).toBe(true);
  });

  it('other workflows skip, self runs', () => {
    expect(shouldRunStrumenti(['.github/workflows/ci.yml'])).toBe(false);
    expect(shouldRunStrumenti(['.github/workflows/strumenti.yml'])).toBe(true);
  });

  it('unknown and empty are fail-safe (run)', () => {
    expect(shouldRunStrumenti([])).toBe(true);
    expect(shouldRunStrumenti(undefined)).toBe(true);
    expect(shouldRunStrumenti(['totally/new/path.xyz'])).toBe(true);
    expect(isStrumentiRelevant('')).toBe(true);
  });
});
