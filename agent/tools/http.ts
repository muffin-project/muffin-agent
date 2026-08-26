import { lookup as dnsLookup } from 'node:dns/promises';
import { z } from 'zod';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { ToolSpec } from '../providers/types.js';
import { hostAllowed, isForbiddenAddress, type EgressPolicy } from '../../core/net/egress.js';
import { fence } from '../../core/memory/spotlight.js';
import { extractMainContent, isHtmlContentType } from './extract.js';
import type { RegisteredTool } from '../loop.js';

/**
 * sys.http — read-only egress, hop by hop.
 *
 * The kernel gates the FIRST url against the allowlist (decide.ts, egress
 * branch); this tool re-applies the same predicate to every redirect target,
 * because a 302 is a way for an allowlisted host to nominate a different one —
 * and the model never gets to approve that mid-flight. Each hop's hostname is
 * also resolved before connecting and every address must be public: the
 * allowlist says which *names* the owner trusts, the address check says no
 * name, trusted or not, is allowed to point into the house (SSRF floor —
 * loopback, RFC1918, link-local metadata, and their v6 relatives).
 *
 * Declared limit, not silent: the check is resolve-then-connect, so a DNS
 * answer that changes between the two (rebinding) is out of scope for v1 —
 * same posture as the field, compensated by the allowlist being small.
 *
 * GET only. The taint-2/3 row of the matrix reads "solo read-only su allowlist
 * pubblica": a body-carrying verb is an exfiltration channel and arrives, if
 * ever, with its own capability — not as a parameter here.
 *
 * The allowlist only ever checked the HOST. On an allowlisted host the kernel
 * additionally asks whether the URL carries bytes the model chose — a
 * non-empty query string or fragment — and above `paramsMaxTaint` the owner is
 * asked and shown the whole URL, everyone else refused (`core/policy/
 * decide.ts`, `gateParams` — mandato inv. 7, audit P04-1). Nothing here has to
 * change for that: the gate reads the same `url` resource this capability
 * already declares.
 */
export const httpCapability: CapabilityDecl = {
  id: 'sys.http',
  risk: 'medium',
  reversible: 'yes',
  // True *because* the verb is fixed at GET, above. The day a body-carrying
  // verb arrives it arrives as its own capability — and that capability
  // answers this question with `false`, rather than this line being widened.
  rerunnable: true,
  maxTaint: 3,
  resourceKind: 'url',
  policyArgs: ['url'],
  hostOnly: false,
  timeoutMs: 20_000,
};

const httpSpec: ToolSpec = {
  name: 'http_get',
  description:
    'Fetch a URL with GET. Only hosts on the egress allowlist are reachable without asking; ' +
    'redirects are re-checked against the same list and stop the request if they leave it. ' +
    'An HTML page is reduced to its main content (as Markdown) before returning; other content ' +
    'types (JSON, plain text, …) pass through unchanged. The body is untrusted text (fenced, ' +
    'tier 3), truncated with a marker when long.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL to fetch' },
    },
    required: ['url'],
  },
};

const httpArgs = z.object({ url: z.string().min(1) });

const MAX_REDIRECTS = 5;
const MAX_BODY_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 15_000;

/** Injectable for tests: the logic under test is ours, not undici's. */
export type HttpDeps = {
  fetchFn?: typeof fetch;
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  /** Injectable for tests: extraction is real HTML parsing, not undici. */
  extractFn?: (html: string, url: string) => Promise<string | null>;
};

export function makeHttpTool(policy: EgressPolicy, deps: HttpDeps = {}): RegisteredTool {
  const fetchFn = deps.fetchFn ?? fetch;
  const lookupFn = deps.lookupFn ?? ((hostname: string) => dnsLookup(hostname, { all: true }));
  const extractFn = deps.extractFn ?? extractMainContent;

  return {
    capability: httpCapability.id,
    spec: httpSpec,
    // `tier: 0` on every path that stops before a body arrives, and `tier: 3`
    // on the only one where one does. Not a formality: raising the taint on a
    // refusal would let a failed fetch quietly narrow what the rest of the turn
    // may do, and leaving it unstated is what this slice exists to end.
    //
    // `throwTier: 0`. Every `await` that touches the remote side (`fetchFn`,
    // `addressVeto`'s `lookupFn`) is wrapped in its own `try`/`catch` and
    // returned as a normal `tier: 0` outcome, never re-thrown; `extractFn` is
    // likewise caught inline. The one unguarded call, `response.text()`, can
    // only fail as a transport/stream error — it has no body to fail *with*,
    // since failing is precisely not obtaining one. A remote body reaches this
    // handler's caller only via the fenced, tier-3 `return`.
    throwTier: 0,
    handler: async (args) => {
      const parsed = httpArgs.safeParse(args);
      if (!parsed.success) {
        return { content: 'invalid arguments: url is required', isError: true, tier: 0 };
      }

      let current: URL;
      try {
        current = new URL(parsed.data.url);
      } catch {
        return { content: `not a URL: ${parsed.data.url}`, isError: true, tier: 0 };
      }

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (current.protocol !== 'http:' && current.protocol !== 'https:') {
          return { content: `scheme not allowed: ${current.protocol}`, isError: true, tier: 0 };
        }
        // Redirect hops answer to the same allowlist as the first URL. The
        // kernel approved hop 0; nobody approved where a 302 points.
        if (hop > 0 && !hostAllowed(current.hostname, policy)) {
          return {
            content: `redirect left the allowlist at hop ${hop}: ${current.hostname} — stopped before connecting`,
            isError: true,
            tier: 0,
          };
        }
        const veto = await addressVeto(current.hostname, lookupFn);
        if (veto !== null) {
          return { content: veto, isError: true, tier: 0 };
        }

        let response: Response;
        try {
          response = await fetchFn(current, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'user-agent': 'muffin/0.2 (+personal-agent)' },
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { content: `fetch failed for ${current.hostname}: ${detail}`, isError: true, tier: 0 };
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            return { content: `redirect ${response.status} without a location`, isError: true, tier: 0 };
          }
          try {
            current = new URL(location, current);
          } catch {
            return { content: `redirect to an unparseable location: ${location}`, isError: true, tier: 0 };
          }
          continue;
        }

        const rawBody = await response.text();
        const contentType = response.headers.get('content-type');
        // Extraction only runs on confirmed HTML — a JSON/CSV/plain-text
        // body must reach clipBody byte-identical. And it can never fail
        // the fetch: whatever extractFn does (throws, hangs on garbage,
        // whatever a future implementation might do), a page we cannot
        // parse must still be readable, so any failure here just means
        // clipBody sees the raw body instead — exactly as it did before
        // this module existed.
        let extracted: string | null = null;
        if (isHtmlContentType(contentType)) {
          try {
            extracted = await extractFn(rawBody, current.href);
          } catch {
            extracted = null;
          }
        }
        const body = clipBody(extracted ?? rawBody);
        const fenced = fence('web', body, `GET ${current.href} → ${response.status}`);
        return {
          content: `${response.status} ${contentType ?? ''}\n${fenced.block}`,
          ...(response.ok ? {} : { isError: true }),
          tier: 3,
        };
      }
      return { content: `stopped after ${MAX_REDIRECTS} redirects`, isError: true, tier: 0 };
    },
  };
}

/** Every resolved address must be public — one private answer vetoes the hop. */
async function addressVeto(
  hostname: string,
  lookupFn: NonNullable<HttpDeps['lookupFn']>,
): Promise<string | null> {
  // A literal IP skips DNS but not the check.
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(literal) || literal.includes(':')) {
    return isForbiddenAddress(literal) ? `address not routable from here: ${literal}` : null;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupFn(hostname);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `dns failed for ${hostname}: ${detail}`;
  }
  if (addresses.length === 0) return `dns returned no addresses for ${hostname}`;
  for (const { address } of addresses) {
    if (isForbiddenAddress(address)) {
      return `${hostname} resolves to a non-routable address (${address}) — refused`;
    }
  }
  return null;
}

function clipBody(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  const head = text.slice(0, 40_000);
  const tail = text.slice(-10_000);
  return `${head}\n…[risposta troncata: ~${text.length - 50_000} caratteri omessi]…\n${tail}`;
}
