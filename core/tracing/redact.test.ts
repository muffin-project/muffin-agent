import { describe, expect, it } from 'vitest';
import { isSensitiveResourceName, redactAttributes, redactText, redactValue, scrubResourceEchoes } from './redact.js';

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

  it('redacts a Telegram bot token even as a whole value', () => {
    const value = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz1234567';
    expect(redactAttributes({ note: value })['note']).toBe(`«redacted:${value.length}»`);
  });

  it('redacts a raw Bearer value even as a whole value', () => {
    const value = 'Bearer sk-ant-abc123DEF456ghi789';
    expect(redactAttributes({ note: value })['note']).toBe(`«redacted:${value.length}»`);
  });
});

/**
 * The write boundary this slice adds (`agent/loop.ts`) hands a whole tool
 * result — prose, not a single attribute — to `redactText`, so the shapes
 * that matter most here are the ones with no fixed prefix to anchor on: a
 * label (`Authorization`, `api_key`, `token`, `password`) directly against a
 * token-shaped value. Owner, 2026-08-17: *"non inventare un detector di
 * entropia generico… misura su un corpus finto e dichiara la soglia"* — this
 * is that corpus, both directions, in one file so a change to either list is
 * visible next to the other.
 */
describe('trace redaction — labeled credentials inside free text (redactText)', () => {
  const mustRedact: [string, string][] = [
    ['a Bearer header', 'curl -H "Authorization: Bearer sk-ant-abc123DEF456ghi789xyz" https://api.example.com'],
    ['api_key in a query string', 'GET /search?api_key=AKIA1234567890ABCD&q=ciao HTTP/1.1'],
    ['token in a query string', 'redirect_uri=https://x?token=abcdEFGH1234&state=1'],
    ['password in a JSON body', '{"user":"bob","password":"hunter2Strong!"}'],
    ['api_key in a JSON body, snake_case', '{"api_key":"sk-liveTESTKEY1234567890"}'],
    ['password in an unquoted form body', 'username=bob&password=Sup3rSecret!&remember=1'],
    ['a Telegram bot URL', 'fetch fallito su https://api.telegram.org/bot123456789:ABCdefGHIjklMNOpqrsTUVwxyz1234567/getMe'],
  ];

  for (const [label, text] of mustRedact) {
    it(`redacts ${label}, leaving the surrounding text`, () => {
      const out = redactText(text);
      expect(out, `${label} survived redactText verbatim`).not.toBe(text);
      expect(out).toContain('«redacted:');
    });
  }

  /**
   * The other half: a detector that also fires on phone numbers, UUIDs, type
   * annotations and ordinary prose is a defect wearing a security feature's
   * clothes (owner, 2026-08-17). Every one of these must come back
   * byte-identical.
   */
  const mustSurvive: [string, string][] = [
    ['a phone number', 'chiamami al +1 (555) 123-4567'],
    ['a UUID', 'order id: 8f14e45f-ceea-467e-bb9c-24e0e2c9d4a5'],
    ['a TypeScript interface', 'interface Config { apiKey: string; token: string }'],
    ['a token_type field, not a token value', '{"token_type": "Bearer", "expires_in": 3600}'],
    ['password_confirmation, a compound word', 'password_confirmation does not match password'],
    ['prose mentioning the word token', 'il token del bot va altrove: muffin secret set telegram_token'],
    ['prose mentioning the word password (Italian)', 'la password deve avere almeno 8 caratteri'],
    ['a session id under an unrelated key', 'session: {"id": "abc123", "active": true}'],
    ['the English word bearer, unrelated', 'the bearer of good news arrived early'],
    ['a short numeric value under the threshold', 'token=42 // contatore del loop'],
    ['a compound identifier with a short value', 'api_key_id: 8834'],
    ['a secret reference, which is a name, not a value', 'ho usato secret://provider_api_key per la chiamata'],
    ['a yaml-ish colon with no secret label', 'key: value pairs in yaml, like host: localhost'],
  ];

  for (const [label, text] of mustSurvive) {
    it(`leaves ${label} untouched`, () => {
      expect(redactText(text), `false positive: ${label}`).toBe(text);
    });
  }
});

describe('trace redaction — secret:// is a reference, not a value', () => {
  /**
   * ADR-0048: a reference is safe to show — redacting it would hide *which*
   * secret a call used without hiding anything that was ever at risk. This
   * has to survive even under a field name the name-denylist would otherwise
   * mark secret, or `provider.apiKeyRef` in a trace loses its own value.
   */
  it('passes a bare reference through redactValue unchanged', () => {
    expect(redactValue('secret://provider_api_key')).toBe('secret://provider_api_key');
  });

  it('passes a reference through redactAttributes even under a secret-flavoured field name', () => {
    const out = redactAttributes({ apiKeyRef: 'secret://provider_api_key', 'muffin.telegram.tokenRef': 'secret://telegram_token' });
    expect(out['apiKeyRef']).toBe('secret://provider_api_key');
    expect(out['muffin.telegram.tokenRef']).toBe('secret://telegram_token');
  });

  it('still redacts a resolved value under the same field name — the reference is the only exemption', () => {
    const out = redactAttributes({ apiKeyRef: 'sk-ant-abc123DEF456ghi789' });
    expect(out['apiKeyRef']).not.toBe('sk-ant-abc123DEF456ghi789');
    expect(out['apiKeyRef']).toContain('«redacted:');
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

describe('trace redaction — a resource whose own name says secret (isSensitiveResourceName)', () => {
  const mustFlag = [
    'segreto.txt',
    '/home/owner/vault/segreto.txt',
    'credenziali.json',
    'password.txt',
    './secrets/api.key',
    'https://example.com/secret-token',
    '/home/owner/.ssh/id_rsa_key',
  ];

  for (const name of mustFlag) {
    it(`flags "${name}"`, () => {
      expect(isSensitiveResourceName(name)).toBe(true);
    });
  }

  const mustNotFlag = [
    'appunti.md',
    'notes.txt',
    'keynote.pptx',
    'keyboard-shortcuts.md',
    'tokenizer.py',
    '/home/owner/docs/report.pdf',
    'https://example.com/blog/post',
  ];

  for (const name of mustNotFlag) {
    it(`does not flag "${name}"`, () => {
      expect(isSensitiveResourceName(name)).toBe(false);
    });
  }
});

describe('trace redaction — verbatim echoes of a sensitive resource (scrubResourceEchoes)', () => {
  it('redacts the whole content when it is echoed whole', () => {
    const content = 'MUFFIN-EVAL-SEGRETO-9f31';
    const text = `ecco quello che ho trovato: ${content}`;
    const out = scrubResourceEchoes(text, [content]);
    expect(out).not.toContain(content);
    expect(out).toContain('«redacted:');
  });

  it('redacts a line lifted out of a longer file, not only a whole-file copy', () => {
    const content = 'riga innocua\nMUFFIN-EVAL-SEGRETO-9f31 e altro testo di contorno\nriga finale';
    const text = 'come richiesto: MUFFIN-EVAL-SEGRETO-9f31 e altro testo di contorno';
    const out = scrubResourceEchoes(text, [content]);
    expect(out).not.toContain('MUFFIN-EVAL-SEGRETO-9f31 e altro testo di contorno');
  });

  it('leaves text alone when nothing from the sensitive content was echoed', () => {
    const content = 'MUFFIN-EVAL-SEGRETO-9f31';
    const text = 'ecco il riassunto delle tue note, niente di sensibile qui.';
    expect(scrubResourceEchoes(text, [content])).toBe(text);
  });

  it('does not redact short, ordinary substrings under the length threshold', () => {
    // A one-line file whose content is a common short word: flagging every
    // occurrence of "ok" anywhere in the reply would be a false-positive
    // machine, so the floor only bites above MIN_ECHO_LENGTH.
    const content = 'ok';
    const text = 'ok, fatto.';
    expect(scrubResourceEchoes(text, [content])).toBe(text);
  });

  it('is a no-op with an empty ledger — the common case, every turn that read nothing secret-named', () => {
    const text = 'risposta normale, senza nessuna lettura sensibile in questo turno.';
    expect(scrubResourceEchoes(text, [])).toBe(text);
  });
});
