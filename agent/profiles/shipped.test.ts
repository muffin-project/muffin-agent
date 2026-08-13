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
    expect(frontier?.thinking).toBe('adaptive');
  });

  /**
   * Changed deliberately, and this is the note the next reader needs: it used to
   * pin `thinking: 'allowed'` and `frontier` used to declare it.
   *
   * `'allowed'` was a permission for a thinking *budget*, and the budget shape
   * (`{type:'enabled', budget_tokens}`) is a 400 on every model the globs above
   * match. So the old pin was not protecting behaviour — it was protecting a
   * word for a request we could never legally send. The pin stays verbatim
   * (ADR-0037); the vocabulary under it is the thing that moved.
   */
  it('frontier: the two request knobs the 5-series actually has', () => {
    const frontier = profiles.find((p) => p.name === 'frontier');
    // Not 'allowed', and not absent: on these models thinking is on unless
    // disabled, so the declaration has to name a mode the wire understands.
    expect(frontier?.thinking).toBe('adaptive');
    // temperature is a 400 on Opus 4.7 and later. The default install
    // (`muffin init` → claude-sonnet-5 → this profile) depends on this value.
    expect(frontier?.sampling).toBe('model-default');
  });

  it('consumer-local: the full cascade, in the declared order', () => {
    const consumer = profiles.find((p) => p.name === 'consumer-local');
    expect(consumer?.recovery).toEqual(['nudge', 'reinjectTools', 'retryOnce', 'strictJson']);
    expect(consumer?.thinking).toBe('off');
    // Small local models wander without it, and every server they run on takes it.
    expect(consumer?.sampling).toBe('deterministic');
  });

  it('a profile from before `sampling` existed keeps the behaviour it had', () => {
    // The field is defaulted rather than required precisely so a third-party
    // profile does not silently acquire a new request shape on upgrade.
    // `deterministic` is what the loop hardcoded before the field existed.
    const problems: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'muffin-profiles-'));
    writeFileSync(
      join(tmp, 'old.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'old',
        match: ['*'],
        maxToolsExposed: 10,
        maxToolCallsPerTurn: 15,
        thinking: 'off',
        recovery: [],
        notes: '',
      }),
    );
    const loaded = loadProfiles(tmp, (line) => problems.push(line));

    expect(problems).toEqual([]);
    expect(loaded[0]?.sampling).toBe('deterministic');
  });

  it('a profile still saying `allowed` is refused, not quietly reinterpreted', () => {
    // The alternative was an alias mapping 'allowed' → 'adaptive'. Rejected: it
    // would keep a word alive that names a budget the API deleted, and this
    // repo's failure mode is exactly the mechanism that keeps appearing to work.
    const problems: string[] = [];
    const tmp = mkdtempSync(join(tmpdir(), 'muffin-profiles-'));
    writeFileSync(
      join(tmp, 'legacy.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'legacy',
        match: ['*'],
        maxToolsExposed: 10,
        maxToolCallsPerTurn: 15,
        thinking: 'allowed',
        recovery: [],
        notes: '',
      }),
    );
    const loaded = loadProfiles(tmp, (line) => problems.push(line));

    expect(loaded).toEqual([]);
    expect(problems[0]).toContain('legacy.json');
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
