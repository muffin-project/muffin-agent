import { describe, expect, it } from 'vitest';
import { redactAttributes, redactValue } from './redact.js';

/**
 * The threat model's §8 commitment — *"Secrets: mai nel repo, **mai in chiaro
 * nei trace** (redaction nel layer di logging)"* — executes here.
 *
 * It had no test at all. `core/tracing/` shipped three modules and zero
 * `*.test.ts`, so every promise in 09 §9 (the denylist, the value shapes, the
 * `«redacted:<len>»` format) rested on reading the code and believing it. The
 * first thing written here found the hole: the name denylist required its
 * keyword to sit against `_`, `.`, `-`, or an edge, so `api_key` was caught and
 * **`apiKey` was not** — while the module's own docstring said, in as many
 * words, *"field names catch `apiKey`"*. Prose asserting what the code does not
 * do, in the file that holds the last line between a provider key and a
 * grep-able JSONL.
 *
 * Measured before the fix: `api_key` → redacted, `apiKey` → exported verbatim.
 */

describe('trace redaction — the field-name denylist', () => {
  /**
   * The six names 09 §9 names, in both spellings this codebase actually
   * produces. Every one of these is a real shape: `apiKeyRef` is a config field
   * in `core/config/config.ts`, and tool arguments arrive named however the
   * model's schema spelled them.
   */
  const mustRedact = [
    'key',
    'api_key',
    'apiKey',
    'anthropic_api_key',
    'apiKeyRef',
    'x-api-key',
    'token',
    'authToken',
    'accessToken',
    'refresh_token',
    'secret',
    'apiSecret',
    'clientSecret',
    'password',
    'userPassword',
    'passwd',
    'credential',
    'awsCredentials',
    'auth',
    'authHeader',
    'bearer',
    'bearerToken',
    'cookie',
    'sessionCookie',
    'session',
    'sessionId',
    'muffin.apiKey',
  ];

  for (const name of mustRedact) {
    it(`redacts a field called "${name}"`, () => {
      const out = redactAttributes({ [name]: 'hunter2hunter2' });
      expect(out[name], `"${name}" reached the trace in clear text`).toBe('«redacted:14»');
    });
  }

  /**
   * The other half of a denylist worth having: it has to be possible to write a
   * trace. A rule that redacts everything is the same as no trace at all, and
   * the attributes below are the ones the loop emits on every single span.
   */
  const mustSurvive = [
    'muffin.capability',
    'muffin.taint',
    'muffin.tenant',
    'muffin.principal.kind',
    'muffin.policy.effect',
    'gen_ai.request.model',
    'monkey', // contains "key", and is not a secret
    'turkey',
    'keyboard',
    'tokenizer',
    'authority',
    'author',
  ];

  for (const name of mustSurvive) {
    it(`leaves a field called "${name}" alone`, () => {
      const out = redactAttributes({ [name]: 'plain' });
      expect(out[name], `"${name}" was redacted and should not have been`).toBe('plain');
    });
  }
});

describe('trace redaction — the value-shape net', () => {
  /**
   * The second filter, for a secret that arrived in a field called `value`.
   * One per shape the module claims to know, so deleting a line of
   * `SECRET_VALUE_SHAPES` turns exactly one of these red.
   */
  const shapes: [string, string][] = [
    ['OpenAI', 'sk-abcdefghijklmnop0123456789'],
    ['Anthropic', 'sk-ant-abcdefghijklmnop0123456789'],
    ['GitHub PAT', 'ghp_abcdefghijklmnopqrstuvwxyz01'],
    ['Slack', 'xoxb-1234567890-abcdefghij'],
    ['Google', 'AIzaSyAbcdefghijklmnopqrstuvwxyz01234'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig'],
    ['PEM', '-----BEGIN RSA PRIVATE KEY-----'],
  ];

  for (const [label, value] of shapes) {
    it(`redacts a ${label} key even in an innocent field`, () => {
      const out = redactAttributes({ note: value });
      expect(out['note'], `a ${label} key rode out in a field called "note"`).toBe(
        `«redacted:${value.length}»`,
      );
    });
  }

  it('leaves ordinary prose alone', () => {
    expect(redactValue('ho letto il file e non ho trovato la chiave')).toBe(
      'ho letto il file e non ho trovato la chiave',
    );
  });

  it('passes non-strings through untouched, so numbers stay queryable', () => {
    expect(redactValue(3)).toBe(3);
    expect(redactValue(true)).toBe(true);
  });
});

describe('trace redaction — the marker format', () => {
  /**
   * 09 §9 fixes the literal: `«redacted:<len>»`. The length is not decoration —
   * it is how a truncated key is told apart from a missing one when someone is
   * debugging why the provider returned 401.
   */
  it('is exactly «redacted:<len>», guillemets and all', () => {
    expect(redactAttributes({ api_key: 'abcdefghij' })['api_key']).toBe('«redacted:10»');
  });

  it('reports the length of a non-string secret rather than dropping it', () => {
    expect(redactAttributes({ token: 12345 })['token']).toBe('«redacted:5»');
  });
});
