import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostAllowed, isForbiddenAddress, loadEgress } from './egress.js';

describe('hostAllowed', () => {
  const policy = { allow: ['api.example.com', '*.wiki.org'] };

  it('matches exactly, case-insensitively, ignoring a trailing dot', () => {
    expect(hostAllowed('api.example.com', policy)).toBe(true);
    expect(hostAllowed('API.Example.COM', policy)).toBe(true);
    expect(hostAllowed('api.example.com.', policy)).toBe(true);
  });

  it('a suffix is not a match — evil-example.com stays out', () => {
    expect(hostAllowed('evil-api.example.com.attacker.net', policy)).toBe(false);
    expect(hostAllowed('notapi.example.com', policy)).toBe(false);
    expect(hostAllowed('example.com', policy)).toBe(false);
  });

  it('a wildcard covers exactly one label', () => {
    expect(hostAllowed('en.wiki.org', policy)).toBe(true);
    expect(hostAllowed('wiki.org', policy)).toBe(false);
    expect(hostAllowed('deep.en.wiki.org', policy)).toBe(false);
  });

  it('the empty policy allows nothing', () => {
    expect(hostAllowed('api.example.com', { allow: [] })).toBe(false);
  });
});

describe('isForbiddenAddress — the SSRF floor', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::1234',
    '::ffff:10.0.0.1', // v4-mapped: the classic laundering
    '64:ff9b::a00:1',
  ])('refuses %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1', '11.0.0.1'])(
    'allows public %s',
    (address) => {
      expect(isForbiddenAddress(address)).toBe(false);
    },
  );

  it('refuses what is not an address at all', () => {
    expect(isForbiddenAddress('not-an-ip')).toBe(true);
  });
});

describe('loadEgress', () => {
  function homeWith(content: string | null): string {
    const home = mkdtempSync(join(tmpdir(), 'muffin-egress-'));
    mkdirSync(join(home, 'rot'), { recursive: true });
    if (content !== null) writeFileSync(join(home, 'rot', 'egress.json'), content);
    return home;
  }

  it('reads the allowlist, lowercased', () => {
    const home = homeWith('{"schemaVersion":1,"allow":["API.Example.com"]}');
    expect(loadEgress(home).allow).toEqual(['api.example.com']);
  });

  it('a missing file names the remedy', () => {
    const home = homeWith(null);
    // The remedy travels in its own field, not squeezed into the message.
    try {
      loadEgress(home);
      expect.unreachable('loadEgress should have thrown');
    } catch (error) {
      expect(String(error)).toContain('no egress policy');
      expect((error as { remedy?: string }).remedy).toContain('rot reinstall');
    }
  });

  it('a wrong field names the field, not "invalid config"', () => {
    const home = homeWith('{"schemaVersion":1,"allow":"api.example.com"}');
    expect(() => loadEgress(home)).toThrow(/allow/);
  });
});
