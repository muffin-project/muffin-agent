import { describe, expect, it } from 'vitest';
import { isSkippableFile, shouldRunAcceptance } from './acceptance-scope.mjs';

describe('acceptance scope gate', () => {
  it('docs-only skips (prose acceptance never reads)', () => {
    expect(shouldRunAcceptance(['docs/architecture/ARCHITECTURE.md', 'README.md', 'AGENTS.md'])).toBe(false);
  });

  it('DAY-1 ledger runs (report.ts reads it live)', () => {
    expect(shouldRunAcceptance(['docs/status/day1/requirements-status.md'])).toBe(true);
  });

  it('unit-test-only skips (acceptance project runs only *.accept.ts)', () => {
    expect(shouldRunAcceptance(['core/mcp/mcp.test.ts', 'core/policy/matrix.ts'])).toBe(true);
    expect(shouldRunAcceptance(['core/mcp/mcp.test.ts'])).toBe(false);
  });

  it('.claude-only skips (no runtime references)', () => {
    expect(shouldRunAcceptance(['.claude/hooks/guard-new-dep.mjs', '.claude/loop.md'])).toBe(false);
  });

  it('runtime runs (Telegram connector)', () => {
    expect(shouldRunAcceptance(['connectors/telegram/notify.ts'])).toBe(true);
  });

  it('runtime runs (core Work/Effects/Authority)', () => {
    expect(shouldRunAcceptance(['core/policy/matrix.ts', 'core/work/turn.ts'])).toBe(true);
  });

  it('install.sh-only skips (install workflow owns it; acceptance spawns source)', () => {
    expect(shouldRunAcceptance(['install.sh', 'bootstrap.sh'])).toBe(false);
  });

  it('install evals-only skip (install workflow owns them)', () => {
    expect(shouldRunAcceptance(['evals/install/ubuntu.sh'])).toBe(false);
  });

  it('Docker-only skips (docker job owns it)', () => {
    expect(shouldRunAcceptance(['contrib/docker/Dockerfile', 'evals/install/docker.sh'])).toBe(false);
  });

  it('dependency runs', () => {
    expect(shouldRunAcceptance(['package-lock.json'])).toBe(true);
    expect(shouldRunAcceptance(['package.json'])).toBe(true);
  });

  it('ci.yml itself runs (it defines the job)', () => {
    expect(shouldRunAcceptance(['.github/workflows/ci.yml'])).toBe(true);
  });

  it('other workflows skip', () => {
    expect(shouldRunAcceptance(['.github/workflows/install.yml'])).toBe(false);
  });

  it('acceptance harness runs', () => {
    expect(shouldRunAcceptance(['evals/acceptance/manifest.ts'])).toBe(true);
    expect(shouldRunAcceptance(['evals/acceptance/scenarios/b-telegram-journey.accept.ts'])).toBe(true);
  });

  it('mixed change runs (one runtime file is enough)', () => {
    expect(shouldRunAcceptance(['docs/architecture/ARCHITECTURE.md', 'core/mcp/connect.ts'])).toBe(true);
  });

  it('unknown and empty are fail-safe (run)', () => {
    expect(shouldRunAcceptance([])).toBe(true);
    expect(shouldRunAcceptance(undefined)).toBe(true);
    expect(shouldRunAcceptance(['totally/new/path.xyz'])).toBe(true);
    expect(isSkippableFile('')).toBe(false);
  });
});
