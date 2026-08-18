import type { AttributeValue } from './types.js';

/**
 * Traces are read by the owner and, later, by the agent itself when it looks at
 * its own patterns. Neither is a reason to let a key land in a file that gets
 * grepped, pasted into an issue, or fed back into a prompt.
 *
 * Two independent filters, because either alone leaks: field names catch
 * `apiKey`, value shapes catch a token that arrived in a field called `value`.
 *
 * That first sentence was false for as long as this file has existed, and said
 * so in the one spelling it got wrong. The denylist was a regex requiring its
 * keyword to sit against `_`, `.`, `-`, or an edge — so `api_key` was caught
 * and **`apiKey` was not**, along with `authToken`, `accessToken`,
 * `clientSecret` and ten more. Nothing was watching: `core/tracing/` shipped
 * three modules and no test, and the value-shape net below was the only thing
 * standing between a provider key in a camelCase argument and a JSONL that
 * gets grepped and pasted into issues — a net that only knows seven shapes.
 *
 * The replacement splits the name into words instead of hunting for
 * delimiters, because that is the actual question: *is one of these words a
 * secret word?* Camel humps, snake, kebab and dots all segment; `monkey` and
 * `tokenizer` still do not, which is the half a looser regex would have lost.
 *
 * **This module is no longer only for traces** (owner, 2026-08-17: *"i secret
 * non devono mai essere mostrati o mostrabili, né in logs, né in chat, da
 * nessuna parte"*). `agent/loop.ts` calls `redactText` on a tool's own
 * `content`/error before it reaches `turn_tool_calls.content`, `turns.messages`
 * or the session JSONL — the same net, at the point every one of those sinks
 * shares. It stays under `core/tracing/` because that is where it already
 * lived and a move buys nothing; the name says what it does, not where its
 * first caller was.
 *
 * That said, this file is **not** the guarantee that a backend-known secret
 * (`muffin secret set`, `readSecret`) never leaks — that guarantee is
 * structural: `readSecret` has a fixed, small set of call sites, each a
 * privileged sink (the provider's `Authorization` header, the search
 * backend's key, a connector's bot token) that resolves the value as late as
 * possible and never hands it to anything this module would need to catch.
 * See ADR-0048. What lives here is the second, weaker line: a best-effort
 * scan for text that merely *looks* like a credential — useful when an owner
 * pastes one into a message, or a tool's own output happens to echo one back
 * — and it is declared weaker on purpose, because inflating a pattern match
 * into "the security boundary" is how a false negative gets trusted.
 */

/** One word each, matched whole. `keyboard` is not a key. */
const SECRET_WORDS = new Set([
  'key',
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'credentials',
  'auth',
  'bearer',
  'cookie',
  'session',
]);

/**
 * `apiKeyRef` → `api key ref`. Two passes because the humps are not symmetric:
 * the first splits `aB`, the second splits the tail of a run of capitals off
 * the word it starts (`APIKey` → `API Key`), which is how acronym-prefixed
 * field names actually arrive.
 */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

function isSecretName(name: string): boolean {
  return words(name).some((word) => SECRET_WORDS.has(word));
}

/**
 * `secret://<name>` is a reference, not a value — resolving it is
 * `readSecret`'s job (`core/config/config.ts`), done only inside the
 * provider/search/connector adapters that need it (ADR-0048). A reference is
 * safe to show: it names *which* secret a call used without exposing
 * anything that was ever at risk. Matched whole, because a reference is
 * always the entire value of the field that carries it, never a substring of
 * a longer one.
 */
const SECRET_REF = /^secret:\/\/[A-Za-z0-9_]+$/;

/**
 * Shapes of credentials common enough to be worth matching on sight, plus a
 * second family below: a secret-flavoured *label* directly against a
 * token-shaped value. The label is what makes those safe to redact — entropy
 * alone would also catch a phone number or a UUID, and a false positive that
 * erases real content is a defect, not caution (owner, 2026-08-17: "non
 * inventare un detector di entropia generico… misura su un corpus finto e
 * dichiara la soglia" — the corpus is `redact.test.ts`'s "cose che non sono
 * segreti" block; the threshold is stated on each pattern below).
 *
 * `\b…\b` around the label keeps this out of a longer identifier
 * (`token_type`, `password_confirmation`, `api_key_id` never match — the
 * character right after the label is a word character, so there is no
 * boundary for `\b` to land on) and the quoted-value requirement on the
 * `:`-delimited form keeps it out of a type annotation (`token: string` in a
 * `.ts` file `fs_read` can return has no quotes around `string`, so it does
 * not match; `"token": "abc123xyz"` does).
 */
const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/, // Anthropic
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub PAT
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\bAIza[A-Za-z0-9_-]{20,}\b/, // Google API
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM
  /(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}\b/, // Telegram bot token (id:secret) — always written `bot<id>:<hash>` with no separator, so the id side has no leading `\b` to anchor on
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i, // `Authorization: Bearer <token>` — the value, threshold 8 so "Bearer test" in prose is not enough on its own
  /\b(?:api[_-]?key|token|password|passwd)\b["']?\s*[:=]\s*"[^"\s]{6,}"/i, // "token": "value" — JSON, optional closing quote on the key, value double-quoted, threshold 6
  /\b(?:api[_-]?key|token|password|passwd)=[^\s"&]{6,}/i, // token=value — query string or form, unquoted, threshold 6
];

export function redactValue(value: AttributeValue): AttributeValue {
  if (typeof value !== 'string') return value;
  if (SECRET_REF.test(value)) return value;
  for (const shape of SECRET_VALUE_SHAPES) {
    if (shape.test(value)) return marker(value.length);
  }
  return value;
}

/**
 * The same shapes as `redactValue`, applied to a block of prose instead of a
 * single attribute.
 *
 * `redactValue` answers "is this whole value a secret", which is right for a
 * span attribute — a key either is the value or it is not. `muffin prompt
 * show` (`cli/prompt-show.ts`) needed the other question: a multi-kilobyte
 * system prompt is not itself a secret, but must not carry one *inside* it if
 * an owner ever pastes a key into `persona.md`/`voice.md`/`identity.md`. Every
 * match is replaced in place — collapsing the whole prompt to one marker on a
 * single hit would defeat the command's own point, which is to show what the
 * model actually receives.
 */
export function redactText(text: string): string {
  let out = text;
  for (const shape of SECRET_VALUE_SHAPES) {
    const flags = shape.flags.includes('g') ? shape.flags : `${shape.flags}g`;
    out = out.replace(new RegExp(shape.source, flags), (match) => marker(match.length));
  }
  return out;
}

export function redactAttributes(
  attributes: Readonly<Record<string, AttributeValue>>,
): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value === 'string' && SECRET_REF.test(value)) {
      // A reference, not a value (see `SECRET_REF`) — shown whole even under
      // a field name that would otherwise mark it secret, or
      // `provider.apiKeyRef` would redact to a length and lose the one thing
      // that is both safe and useful to know: which secret a call used.
      out[name] = value;
      continue;
    }
    out[name] = isSecretName(name)
      ? marker(typeof value === 'string' ? value.length : String(value).length)
      : redactValue(value);
  }
  return out;
}

/** Keeps the length so a truncated-vs-missing key stays diagnosable. */
function marker(length: number): string {
  return `«redacted:${length}»`;
}
