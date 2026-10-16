import { describe, expect, it } from 'vitest';
import {
  decideApprovalTier,
  isCriticalShellCommand,
  matchCommandPattern,
  type ApprovalTiers,
} from './tiers.js';

const EMPTY: ApprovalTiers = { autoAllow: [], deny: [] };

describe('matchCommandPattern', () => {
  it('exact matches the trimmed command', () => {
    expect(matchCommandPattern('git status', '  git status ')).toBe(true);
    expect(matchCommandPattern('git status', 'git status --short')).toBe(false);
  });
  it('trailing star is a prefix', () => {
    expect(matchCommandPattern('npm run *', 'npm run build --watch')).toBe(true);
    expect(matchCommandPattern('npm run *', 'npmbuild')).toBe(false);
  });
});

describe('isCriticalShellCommand', () => {
  it.each(['rm -rf /', 'rm -rf ~', 'rm -rf $HOME', 'rm -rf $HOME/x', 'rm -rf /*', 'sudo rm -rf /', 'rm -fr /'])(
    'asks: %s',
    (cmd) => expect(isCriticalShellCommand(cmd)).toBe(true),
  );
  it.each(['rm file.txt', 'rm -rf ./build', 'rm -rf /tmp/x', 'ls /', 'echo hi', 'dd if=/dev/zero of=/tmp/x'])(
    'not critical: %s',
    (cmd) => expect(isCriticalShellCommand(cmd)).toBe(false),
  );
  it('raw disk writes are critical', () => {
    expect(isCriticalShellCommand('dd if=image.iso of=/dev/disk2')).toBe(true);
  });
});

describe('decideApprovalTier — deny wins, sandbox auto-approves, resto chiede', () => {
  it('deny vince su allow anche più largo', () => {
    const tiers: ApprovalTiers = { autoAllow: ['npm *'], deny: ['npm run deploy'] };
    expect(decideApprovalTier({ command: 'npm run deploy', sandboxed: true, tiers })).toBe('deny');
    expect(decideApprovalTier({ command: 'npm run build', sandboxed: true, tiers })).toBe('allow');
  });
  it('critical chiede sempre, anche in allow-list e sandboxed', () => {
    const tiers: ApprovalTiers = { autoAllow: ['rm *'], deny: [] };
    expect(decideApprovalTier({ command: 'rm -rf /', sandboxed: true, tiers })).toBe('ask');
  });
  it('sandboxed senza regole passa, non-sandboxed chiede', () => {
    expect(decideApprovalTier({ command: 'ls -la', sandboxed: true, tiers: EMPTY })).toBe('allow');
    expect(decideApprovalTier({ command: 'ls -la', sandboxed: false, tiers: EMPTY })).toBe('ask');
  });
  it('senza comando conta solo il sandbox', () => {
    expect(decideApprovalTier({ command: undefined, sandboxed: true, tiers: EMPTY })).toBe('allow');
    expect(decideApprovalTier({ command: undefined, sandboxed: false, tiers: EMPTY })).toBe('ask');
  });
});
