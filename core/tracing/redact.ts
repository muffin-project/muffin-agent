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
/**
 * 07/09/2026, trovato da un giudice su D15: `\btoken=` non ha un confine di
 * parola dentro `access_token=`, quindi i due nomi di parametro OAuth più
 * comuni passavano interi. Misurato prima della correzione:
 * `redactText('https://api.x/v1?access_token=abcdef123456')` tornava la
 * stringa intatta. Le due righe sotto nominano i prefissi (`access_`,
 * `refresh_`, `id_`) e accettano anche un `_` prima del nome, che è come
 * arrivano dentro uno snake_case.
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
  /\b(?:api[_-]?key|(?:access[_-]|refresh[_-]|id[_-])?token|password|passwd|secret)\b["']?\s*[:=]\s*"[^"\s]{6,}"/i, // "token": "value" — JSON, optional closing quote on the key, value double-quoted, threshold 6
  /(?:\b|_)(?:api[_-]?key|(?:access[_-]|refresh[_-]|id[_-])?token|password|passwd|secret)=[^\s"&]{6,}/i, // token=value — query string or form, unquoted, threshold 6
];

/**
 * Il valore **ha la forma** di una credenziale? Classe 3 (ADR-0048): non è una
 * garanzia, è un riconoscimento a vista — chi vuole la garanzia usa il backend
 * dei segreti e fa viaggiare `secret://nome`.
 *
 * Esportato perché un secondo posto deve fare la stessa domanda senza
 * ricopiarsi la lista delle forme: lo schema del registro MCP
 * (`core/mcp/registry.ts`), dove un `env` scritto a mano potrebbe contenere un
 * token letterale.
 */
export function looksLikeSecretValue(value: string): boolean {
  if (SECRET_REF.test(value)) return false;
  return SECRET_VALUE_SHAPES.some((shape) => shape.test(value));
}

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

/**
 * The third net, next to value shapes and field names: a **resource's own
 * name**. `isSecretName` above already asks "is this word a secret word" of
 * an attribute key (`apiKeyRef`, `authToken`); this asks the identical
 * question of a file path or URL a tool just read in full — `segreto.txt`,
 * `/vault/credenziali.json`, `.../id_rsa` — because the file's *content*
 * carries none of the shapes `SECRET_VALUE_SHAPES` know to look for. A note
 * that just says "the wifi password is `casa2024`" is not `sk-…`, not a JWT,
 * not `token=…`; the only signal deterministic code has is the name the
 * owner (or whoever created the file) already gave it.
 *
 * Kept as its own word list rather than folded into `SECRET_WORDS`: that set
 * also drives `redactAttributes`, which runs on span attribute *names*
 * (`camelCase` field identifiers, ADR-0020 English) on every trace this
 * process writes — changing its matches would change already-tested,
 * unrelated behaviour. A file path is data the owner or a connector wrote,
 * not a code identifier, and this owner's own files are as likely to be
 * named in Italian as in English — so the two lists diverge on purpose, not
 * by omission.
 */
const SENSITIVE_RESOURCE_WORDS = new Set([
  'secret',
  'secrets',
  'password',
  'passwd',
  'credential',
  'credentials',
  'token',
  'key',
  'segreto',
  'segreti',
  'credenziali',
  'chiave',
]);

/**
 * Does this file path / URL name itself as holding a secret? Reuses `words`
 * unchanged: a path segments on `/` and `.` exactly the way `words` already
 * segments on any non-alphanumeric run, so `/home/owner/vault/segreto.txt`
 * arrives as `['home','owner','vault','segreto','txt']` with no extra code.
 *
 * Exported for `agent/loop.ts`, the one caller that knows, for a given tool
 * call, which argument names the resource (`resourceFor`'s own job on the
 * policy side) — this module has no opinion on tool schemas and must not
 * grow one.
 */
export function isSensitiveResourceName(identifier: string): boolean {
  return words(identifier).some((word) => SENSITIVE_RESOURCE_WORDS.has(word));
}

/** Below this many characters a needle matches too much ordinary prose to be worth flagging. */
const MIN_ECHO_LENGTH = 12;

/**
 * The whole trimmed content is one needle (catches a short note copied
 * whole), and every non-trivial line is a second needle of its own (catches
 * one line lifted out of a longer file) — both exact, both case-sensitive,
 * because a fuzzy match on prose is exactly the false-positive risk this
 * module's own doc-comment above warns against for entropy detectors.
 */
function echoNeedles(content: string): string[] {
  const trimmed = content.trim();
  if (trimmed === '') return [];
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return [trimmed, ...lines];
}

/**
 * The redaction half of the same floor: given the full contents this turn
 * read from resources `isSensitiveResourceName` flagged, strip any verbatim
 * reproduction of them out of `text` — the reply about to reach the owner, or
 * the episode about to reach durable memory (ADR pending, `agent/loop.ts`
 * §"sensitive resource echo").
 *
 * Deliberately **not** "any content this turn read that the owner didn't
 * name" — that axis is `chosenBy` in `evals/security/candidate-b.ts`, and
 * that file's own doc-comment already names why production cannot compute it
 * today: `agent/loop.ts` gets tool arguments already resolved and cannot tell
 * whether the owner's own message named a path or a page read three rounds
 * earlier did. Building that would be the CaMeL-style capability-per-value
 * project the same file describes, not a mechanical fix. What *is*
 * computable today, exactly like a credential's shape, is the resource's own
 * name — so this floor answers a narrower question than "was this
 * requested", and stays silent on every read whose name does not, itself,
 * say "secret".
 */
export function scrubResourceEchoes(text: string, sensitiveContents: readonly string[]): string {
  let out = text;
  for (const content of sensitiveContents) {
    for (const needle of echoNeedles(content)) {
      if (needle.length < MIN_ECHO_LENGTH) continue;
      out = out.split(needle).join(marker(needle.length));
    }
  }
  return out;
}
