import type { AttributeValue } from './types.js';

/**
 * Traces are read by the owner and, later, by the agent itself when it looks at
 * its own patterns. Neither is a reason to let a key land in a file that gets
 * grepped, pasted into an issue, or fed back into a prompt.
 *
 * Two independent filters, because either alone leaks: field names catch
 * `apiKey`, value shapes catch a token that arrived in a field called `value`.
 */

const SECRET_NAME = /(^|[_.-])(key|token|secret|password|passwd|credential|auth|bearer|cookie|session)([_.-]|$)/i;

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

export function redactAttributes(
  attributes: Readonly<Record<string, AttributeValue>>,
): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [name, value] of Object.entries(attributes)) {
    out[name] = SECRET_NAME.test(name)
      ? marker(typeof value === 'string' ? value.length : String(value).length)
      : redactValue(value);
  }
  return out;
}

/** Keeps the length so a truncated-vs-missing key stays diagnosable. */
function marker(length: number): string {
  return `«redacted:${length}»`;
}
