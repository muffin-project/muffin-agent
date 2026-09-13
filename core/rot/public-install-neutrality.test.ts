import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QUIET_FLOOR } from './budgets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../defaults');

function shippedTextFiles(dir = ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return shippedTextFiles(path);
    if (entry.name.endsWith('.test.ts')) return [];
    return ['.md', '.json'].includes(extname(entry.name)) ? [path] : [];
  });
}

describe('a fresh public install belongs to whoever installs it', () => {
  it('ships no founder name inside owner-facing defaults', () => {
    const findings = shippedTextFiles().flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return /\b(?:Giusto|Piedimonte)\b/i.test(text) ? [relative(ROOT, path)] : [];
    });

    expect(findings).toEqual([]);
  });

  it('ships the neutral quiet-hours timezone rather than the founder timezone', () => {
    const budgets = JSON.parse(readFileSync(join(ROOT, 'rot', 'budgets.json'), 'utf8')) as {
      quietHours?: { timezone?: string };
    };

    // First-run/setup may replace this with the machine/owner timezone before
    // declaring the install configured. The package default itself must stay a
    // neutral fallback, and `core/rot/budgets.ts` already owns that fallback.
    expect(budgets.quietHours?.timezone).toBe(QUIET_FLOOR.timezone);
  });
});
