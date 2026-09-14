import { describe, expect, it } from 'vitest';
import { missingSignoffs } from './check-dco.js';

describe('DCO sign-off check', () => {
  it('accepts a Signed-off-by trailer matching the commit author', () => {
    expect(
      missingSignoffs([
        {
          sha: 'a'.repeat(40),
          authorName: 'Ada Lovelace',
          authorEmail: 'ada@example.test',
          body: 'claim\n\nSigned-off-by: Ada Lovelace <ada@example.test>',
        },
      ]),
    ).toEqual([]);
  });

  it('rejects absent and mismatched sign-offs', () => {
    expect(
      missingSignoffs([
        {
          sha: 'a'.repeat(40),
          authorName: 'Ada Lovelace',
          authorEmail: 'ada@example.test',
          body: 'claim',
        },
        {
          sha: 'b'.repeat(40),
          authorName: 'Ada Lovelace',
          authorEmail: 'ada@example.test',
          body: 'Signed-off-by: Grace Hopper <grace@example.test>',
        },
      ]).map((commit) => commit.sha),
    ).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });
});
