import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProfiles, selectProfile } from './profile.js';

/**
 * The shipped JSON profiles, pinned verbatim.
 *
 * Nothing referenced them: every cascade test builds its own profile object, so
 * the judge reverted frontier to the exact behaviour the recovery slice exists
 * to end — four identical nudges' little sibling, nudge-nudge — and 563 tests
 * stayed green. Emptying consumer-local's cascade entirely also stayed green.
 * The reachability chain of that slice STARTS at these files, and step one was
 * the unpinned one.
 *
 * Verbatim, not shape-only: the cascade's order is behaviour now (attempt N is
 * strategy N), so a reorder is as real a change as a removal, and a JSON edit
 * must fail something before it silently changes what a weak model gets.
 */

describe('shipped profiles', () => {
  const profiles = loadProfiles();

  it('both load, through the same parser production uses', () => {
    expect(profiles.map((p) => p.name).sort()).toEqual(['consumer-local', 'frontier']);
  });

  it('frontier: a nudge and one retry, in that order', () => {
    const frontier = profiles.find((p) => p.name === 'frontier');
    expect(frontier?.recovery).toEqual(['nudge', 'retryOnce']);
    expect(frontier?.thinking).toBe('allowed');
  });

  it('consumer-local: the full cascade, in the declared order', () => {
    const consumer = profiles.find((p) => p.name === 'consumer-local');
    expect(consumer?.recovery).toEqual(['nudge', 'reinjectTools', 'retryOnce', 'strictJson']);
    expect(consumer?.thinking).toBe('off');
  });

  it('the models the owner actually runs select the profiles meant for them', () => {
    // The join between the JSON's glob and the configured model id: a rename on
    // either side breaks selection silently, and selection decides everything
    // downstream — cap, thinking, cascade.
    expect(selectProfile('anthropic/claude-sonnet-5', profiles).name).toBe('frontier');
    expect(selectProfile('qwen/qwen3-max', profiles).name).toBe('consumer-local');
    expect(selectProfile('some-model-nobody-knows', profiles).name).toBe('conservative');
  });

  it('a profile with an unknown recovery name is refused at the boundary, out loud', () => {
    // Pre-slice a typo here was inert (it only padded a counter). Once the
    // cascade executes as declared, an unknown name was a TypeError thrown
    // mid-recovery — armed exactly when the recovery it names was needed. The
    // boundary now drops the profile and says so; selection falls through to
    // the conservative floor instead of detonating later.
    const problems: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'muffin-profiles-'));
    writeFileSync(
      join(tmp, 'typo.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'typo',
        match: ['*'],
        maxToolsExposed: 10,
        maxToolCallsPerTurn: 15,
        thinking: 'off',
        recovery: ['reinject_tools'],
        notes: '',
      }),
    );
    const loaded = loadProfiles(tmp, (line) => problems.push(line));

    expect(loaded).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('typo.json');
  });
});
