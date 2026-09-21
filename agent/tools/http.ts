import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { CapabilityDecl } from '../../core/policy/types.js';
import type { ToolSpec } from '../providers/types.js';
import { isForbiddenAddress } from '../../core/net/egress.js';
import { fence } from '../../core/memory/spotlight.js';
import { extractMainContent, isHtmlContentType } from './extract.js';
import type { RegisteredTool } from '../loop.js';

/**
 * sys.http — reading is open; the allowlist governs acting, not reading.
 *
 * ADR-0066 (owner decision, 2026-09-04): *"tu leggi qualsiasi sito vuoi …
 * viene riportato come fonte esterna e quindi sai che non sono istruzioni"*.
 * Before this the kernel gated the first hop against `rot/egress.json`
 * (`decide.ts`, the `url` branch), which meant Muffin could not open a page
 * the owner had not pre-approved by hostname — measured unworkable the day the
 * owner tried it. This capability now declares `resourceKind: 'url-read'`
 * (`core/policy/types.ts`), a resource the kernel never checks against the
 * allowlist: any public host is reachable by construction, no `ask`, no
 * `rot/egress.json` entry required. The allowlist keeps meaning something —
 * it still gates every `url` resource (reaching a host to **act**: write,
 * execute, send) and it still gates *which third-party endpoints get
 * registered at boot* (`agent/tools/search.ts`'s `api.tavily.com` check).
 * Reading and acting are two different authorities; this is the tool that
 * only ever does the first.
 *
 * What did NOT move, because opening the allowlist and opening the network are
 * two different claims:
 *
 *  - **The SSRF floor.** Every hop resolves its hostname, requires every
 *    returned address to be public (`core/net/egress.ts#isForbiddenAddress`
 *    — loopback, RFC1918, CGNAT, link-local metadata, and their v6 relatives),
 *    and then connects to the validated answer itself — never back to the
 *    hostname. The IP in the request line is the IP that passed the check, so
 *    a DNS answer changing between check and connect (rebinding) has no second
 *    lookup to land in. HTTP `Host` and TLS SNI still carry the original
 *    hostname, so virtual hosting and certificates see exactly what `fetch`
 *    with the hostname would have shown them.
 *  - **`paramsMaxTaint`.** A non-empty query string or fragment is bytes the
 *    model chose, wherever the host came from, and above the ceiling the owner
 *    is asked and shown the whole URL, everyone else refused (`core/policy/
 *    decide.ts`, `gateParams` — mandato inv. 7, audit P04-1). Nothing here had
 *    to change for that: the gate reads the same `url-read` resource this
 *    capability already declares.
 *  - **GET only.** A body-carrying verb is an exfiltration channel and
 *    arrives, if ever, as its own capability declaring `resourceKind: 'url'`
 *    — the allowlisted, acting kind — not as a parameter here.
 *
 * A redirect is no longer re-checked against the allowlist (there is none to
 * check): a public page redirecting to another public page is exactly as much
 * "reading" as the first hop was. What every hop still cannot do is land
 * inside the house — the resolve-validate-pin below runs before every
 * connect, first hop included, and each redirect resolves and pins anew.
 *
 * No new networking dependency: the global `fetch` (undici) exposes no
 * per-connection DNS hook, so pinning through it would need an extra
 * dispatcher package. `node:http`/`node:https` are the same stack Node's
 * fetch is built on, already in the runtime, and connecting to an IP literal
 * performs no second DNS lookup — which is exactly the invariant.
 */
export const httpCapability: CapabilityDecl = {
  id: 'sys.http',
  effect: 'egress',
  risk: 'medium',
  reversible: 'yes',
  // True *because* the verb is fixed at GET, above. The day a body-carrying
  // verb arrives it arrives as its own capability — and that capability
  // answers this question with `false`, rather than this line being widened.
  rerunnable: true,
  // The `maxTaint: 3` that used to sit here is now the `egress` row's: the
  // threat model gives that row's columns to the allowlist/openness and to
  // `paramsMaxTaint`, not to a ceiling, which is what this pin was working
  // around by widening the medium class default one capability at a time.
  resourceKind: 'url-read',
  policyArgs: ['url'],
  hostOnly: false,
  timeoutMs: 20_000,
};

const httpSpec: ToolSpec = {
  name: 'http_get',
  description:
    'Fetch a URL with GET. Use it when you already have a URL and need its content — this is the tool for ' +
    '`curl`/`wget`, not shell_run. Not for finding a URL when you only have a topic — use web_search first. ' +
    'Any public host is reachable — reading is open (ADR-0066) — but the ' +
    'request never reaches loopback, private, or link-local/metadata addresses, on the first hop ' +
    'or after a redirect. A query string or fragment carrying bytes the model chose may still ask ' +
    'the owner at higher taint. An HTML page is reduced to its main content (as Markdown) before ' +
    'returning; other content types (JSON, plain text, …) pass through unchanged. Returns the body as ' +
    'untrusted text (fenced, tier 3), truncated with a marker when long. e.g. http_get({url: "https://example.com/status"}).',
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

/**
 * Uno stato HTTP che un secondo tentativo puo' davvero cambiare.
 *
 * **429** e' il caso per cui il retry esiste: dice letteralmente «riprova piu'
 * tardi». **5xx** e' il server che sta avendo un problema suo, non la
 * richiesta. Tutto il resto — 401, 403, 404, 422 — e' una risposta *sulla
 * richiesta*, e ripeterla identica ottiene identicamente la stessa cosa:
 * riprovarla e' tempo speso per arrivare allo stesso errore tre volte, con in
 * piu' il rischio di far arrabbiare un rate limiter che ci aveva gia' detto
 * di no.
 *
 * `408` e `425` stanno dentro per la stessa ragione del 429: sono il server
 * che chiede di rifare, non che rifiuta.
 */
function isTransient(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Injectable for tests: the logic under test is ours, not undici's. */
export type HttpDeps = {
  fetchFn?: typeof fetch;
  lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  /** Injectable for tests: extraction is real HTML parsing, not undici. */
  extractFn?: (html: string, url: string) => Promise<string | null>;
};

export function makeHttpTool(deps: HttpDeps = {}): RegisteredTool {
  const fetchFn = deps.fetchFn ?? defaultPinnedFetch;
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
    // `resolvePinnedIp`'s `lookupFn`) is wrapped in its own `try`/`catch` and
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
        // Reading is open (ADR-0066): there is no allowlist left for a redirect
        // hop to leave. What every hop still cannot do — first or Nth — is
        // resolve into the house. Resolve, require every answer to be public,
        // and fetch the validated IP itself (never the hostname back): the
        // address on the wire is the address that passed `isForbiddenAddress`,
        // so there is no second hostname lookup for a rebinding to land in.
        // `Host` and TLS SNI still carry the original hostname.
        const pinned = await resolvePinnedIp(current.hostname, lookupFn);
        if (pinned.error !== null) {
          return { content: pinned.error, isError: true, tier: 0 };
        }
        const pinnedUrl = buildPinnedUrl(current, pinned.address);
        const hostHeader = current.host;

        let response: Response;
        try {
          response = await fetchFn(pinnedUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: {
              'user-agent': 'muffin/0.2 (+personal-agent)',
              host: hostHeader,
              'accept-encoding': 'gzip, deflate',
            },
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          // Transitorio: DNS che non risolve per un attimo, connessione che
          // cade, timeout. Nessuna di queste dice niente sulla richiesta —
          // dicono qualcosa sulla rete, ed e' esattamente il caso che un
          // secondo tentativo risolve. `sys.http.get` e' `rerunnable`, quindi
          // il loop puo' davvero riprovare (`eseguiConRitentativi`).
          return {
            content: `fetch failed for ${current.hostname}: ${detail}`,
            isError: true,
            retryable: true,
            tier: 0,
          };
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
          ...(response.ok ? {} : { isError: true, ...(isTransient(response.status) ? { retryable: true } : {}) }),
          tier: 3,
        };
      }
      return { content: `stopped after ${MAX_REDIRECTS} redirects`, isError: true, tier: 0 };
    },
  };
}

/**
 * Resolve, validate every candidate, and pin the address the hop will
 * connect to. The returned `address` is the exact IP the caller must place
 * on the wire (via {@link buildPinnedUrl}); the caller must never fetch the
 * hostname back, otherwise a second lookup re-opens the rebinding window
 * this exists to close. One private answer vetoes the whole hop — picking
 * "a good one" out of a mixed set would let the hostile answer stay live
 * for the next resolution.
 */
export async function resolvePinnedIp(
  hostname: string,
  lookupFn: NonNullable<HttpDeps['lookupFn']>,
): Promise<{ address: string; error: null } | { address: null; error: string }> {
  // A literal IP skips DNS but not the check.
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) !== 0) {
    return isForbiddenAddress(literal)
      ? { address: null, error: `address not routable from here: ${literal}` }
      : { address: literal, error: null };
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupFn(hostname);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { address: null, error: `dns failed for ${hostname}: ${detail}` };
  }
  if (addresses.length === 0) return { address: null, error: `dns returned no addresses for ${hostname}` };
  for (const { address } of addresses) {
    if (isForbiddenAddress(address)) {
      return { address: null, error: `${hostname} resolves to a non-routable address (${address}) — refused` };
    }
  }
  return { address: addresses[0]!.address, error: null };
}

/**
 * Rewrite a validated hop to its pinned IP, preserving everything else
 * (port, userinfo, path, query). The caller sends {@link hostHeaderFor} as
 * the `Host` header and {@link serverNameFor} as TLS SNI so the origin
 * server sees the same hostname it would have seen for a hostname fetch.
 */
export function buildPinnedUrl(original: URL, pinnedIp: string): URL {
  const pinned = new URL(original.href);
  if (isIP(pinnedIp) === 6) pinned.hostname = `[${pinnedIp}]`;
  else pinned.hostname = pinnedIp;
  return pinned;
}

/** Value for the `Host` header: the original host, port included when non-default. */
export function hostHeaderFor(original: URL): string {
  return original.host;
}

/**
 * TLS SNI for the pinned hop: the original hostname, or `undefined` for a
 * literal-IP origin (SNI must not carry an IP address — RFC 6066 — and the
 * certificate check then correctly runs against the IP itself).
 */
export function serverNameFor(originalHostname: string): string | undefined {
  const bare = originalHostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(bare) !== 0) return undefined;
  return bare;
}

/**
 * Default transport: connect to the pinned IP literal — which performs no
 * DNS lookup of its own — while presenting the original hostname via `Host`
 * and TLS SNI. Only `node:http`/`node:https` are used: the same stack the
 * global fetch is built on, no new dependency. Fails closed when handed a
 * hostname instead of an IP literal, since that would mean the caller
 * skipped {@link resolvePinnedIp}.
 */
export async function defaultPinnedFetch(input: URL | string, init?: RequestInit): Promise<Response> {
  const url = input instanceof URL ? new URL(input.href) : new URL(String(input));
  const rawHost = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(rawHost) === 0) {
    throw new Error(`pinned fetch requires an IP literal, got ${url.hostname}`);
  }
  if (isForbiddenAddress(rawHost)) {
    throw new Error(`address not routable from here: ${rawHost}`);
  }
  const isHttps = url.protocol === 'https:';
  if (!isHttps && url.protocol !== 'http:') {
    throw new Error(`scheme not allowed: ${url.protocol}`);
  }
  const headers = new Headers(init?.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', 'muffin/0.2 (+personal-agent)');
  const hostHeader = headers.get('host') ?? url.host;
  headers.set('host', hostHeader);
  const servername = (() => {
    const fromHost = hostHeader.split(':')[0]!.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (isIP(fromHost) !== 0) return undefined;
    return fromHost.length > 0 ? fromHost : undefined;
  })();

  const port = url.port !== '' ? Number(url.port) : isHttps ? 443 : 80;
  const path = `${url.pathname}${url.search}`;
  const plainHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    plainHeaders[key] = value;
  });
  const baseOptions = {
    hostname: rawHost,
    port,
    path,
    method: init?.method ?? 'GET',
    headers: plainHeaders,
    signal: init?.signal as AbortSignal | undefined,
    auth:
      url.username !== '' ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined,
  };

  return new Promise<Response>((resolve, reject) => {
    const onResponse = (res: import('node:http').IncomingMessage) => {
      const outHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) outHeaders.append(key, v);
        } else {
          outHeaders.set(key, value);
        }
      }
      // 204/304 must not carry a body for the Response constructor.
      if (res.statusCode === 204 || res.statusCode === 304) {
        res.resume();
        resolve(new Response(null, { status: res.statusCode, statusText: res.statusMessage ?? '', headers: outHeaders }));
        return;
      }
      try {
        const webBody = Readable.toWeb(res);
        resolve(
          new Response(webBody as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 500,
            statusText: res.statusMessage ?? '',
            headers: outHeaders,
          }),
        );
      } catch (error) {
        res.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const req = isHttps
      ? httpsRequest({ ...baseOptions, servername }, onResponse)
      : httpRequest(baseOptions, onResponse);
    req.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))));
    req.end();
  });
}

function clipBody(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  const head = text.slice(0, 40_000);
  const tail = text.slice(-10_000);
  return `${head}\n…[risposta troncata: ~${text.length - 50_000} caratteri omessi]…\n${tail}`;
}
