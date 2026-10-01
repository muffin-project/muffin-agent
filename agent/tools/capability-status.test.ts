import { describe, expect, it } from 'vitest';
import { profileEditPath, truncationGap } from './capability-status.js';

/**
 * Where the remedy points for a tool cut by `maxToolsExposed` (#764): the
 * file that actually owns the ceiling — never the compiled copy, never a
 * file that does not exist.
 */
describe('profile ceiling remedy paths', () => {
  it('names the absolute home file for an owner profile', () => {
    expect(profileEditPath('owner-lan', 'owner', '/home/muffin/profiles/owner-lan.json')).toBe(
      '/home/muffin/profiles/owner-lan.json',
    );
    const gap = truncationGap({
      tool: 'shell_run',
      profileName: 'owner-lan',
      maxToolsExposed: 5,
      profileOrigin: 'owner',
      profileFile: '/home/muffin/profiles/owner-lan.json',
    });
    expect(gap.remedy).toContain('/home/muffin/profiles/owner-lan.json');
  });

  it('names the conventional source path for a shipped profile', () => {
    expect(profileEditPath('frontier', 'shipped', '/repo/dist/agent/profiles/frontier.json')).toBe(
      'agent/profiles/frontier.json',
    );
  });

  it('says the conservative floor has no file instead of pointing at one', () => {
    expect(profileEditPath('conservative', 'conservative', undefined)).toBeNull();
    const gap = truncationGap({
      tool: 'shell_run',
      profileName: 'conservative',
      maxToolsExposed: 10,
      profileOrigin: 'conservative',
      profileFile: undefined,
    });
    expect(gap.remedy).toContain('non ha un file');
  });

  it('keeps the historical shipped layout when the origin is unknown', () => {
    expect(profileEditPath('frontier', undefined, undefined)).toBe('agent/profiles/frontier.json');
  });
});
