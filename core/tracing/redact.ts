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

/** Shapes of credentials common enough to be worth matching on sight. */
const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/, // Anthropic
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub PAT
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\bAIza[A-Za-z0-9_-]{20,}\b/, // Google API
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM
];

export function redactValue(value: AttributeValue): AttributeValue {
  if (typeof value !== 'string') return value;
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
