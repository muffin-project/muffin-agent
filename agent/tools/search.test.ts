import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { buildRuntime } from '../runtime.js';
import { paths, writeSecret } from '../../core/config/config.js';
import { seal } from '../../core/rot/verify.js';
import { makeSearchTool, searchCapability, tavilyBackend, type SearchBackend } from './search.js';

/**
 * What has to stay true about web search.
 *
 * The logic here is thin on purpose — the risky parts are all decisions that
 * would drift silently if nobody asserted them: that results are fenced and
 * tainted, that we never ask the provider for whole pages, and that a failure
 * does not quietly narrow the rest of the turn.
 */

const ctx = { tenant: 'host', principal: { kind: 'owner' as const, connector: 'cli', externalId: 'local' } };
const call = (tool: ReturnType<typeof makeSearchTool>, args: unknown) =>
  tool.handler(args as Record<string, unknown>, ctx as never);

const fakeBackend = (hits: Awaited<ReturnType<SearchBackend['search']>>): SearchBackend => ({
  id: 'fake',
  endpoint: 'https://example.invalid/search',
  search: async () => hits,
});

describe('web_search', () => {
  it('fences the results and marks them tier 3', async () => {
    // Whoever ranks well gets to put text in this context. A July 2026 campaign
    // planted agent-directed instructions in off-screen CSS and got 4 of 26
    // models to send money — so results are data behind a boundary, exactly
    // like an http_get body, and the turn's taint rises to match.
    const tool = makeSearchTool(
      fakeBackend([{ title: 'Titolo', url: 'https://example.com/a', snippet: 'un frammento' }]),
    );
    const out = await call(tool, { query: 'qualcosa' });

    expect(out.tier).toBe(3);
    expect(out.content).toContain('un frammento');
    // The fence, not a bare paste.
    expect(out.content).not.toBe('un frammento');
    expect(out.content.length).toBeGreaterThan('un frammento'.length);
  });

  it('never asks the provider for whole pages', async () => {
    // include_raw_content would hand this context entire attacker-controlled
    // pages for a capability whose only job is to find the page. Reading one is
    // http_get, which answers to the owner's allowlist. Asserted because it is
    // a one-word change away from being wrong and nothing else would notice.
    let sentBody: unknown;
    const backend = tavilyBackend({
      apiKey: 'tvly-test',
      fetchFn: (async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await backend.search('domanda', AbortSignal.timeout(1000));

    expect(sentBody).not.toHaveProperty('include_raw_content', true);
    expect(sentBody).not.toHaveProperty('include_answer', true);
    expect(sentBody).toMatchObject({ query: 'domanda' });
  });

  it('sends the key as a bearer header and never in the query', async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    const backend = tavilyBackend({
      apiKey: 'tvly-secret',
      fetchFn: (async (url: string, init: RequestInit) => {
        seenUrl = String(url);
        seenAuth = new Headers(init.headers).get('authorization');
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await backend.search('domanda', AbortSignal.timeout(1000));

    expect(seenAuth).toBe('Bearer tvly-secret');
    expect(seenUrl).not.toContain('tvly-secret');
  });

  it('turns a provider error into a failed call, without tainting the turn', async () => {
    // Nothing from the provider arrived, so there is nothing to be tainted by.
    // Raising taint on a failure would silently narrow what the rest of the turn
    // is allowed to do, for no evidence at all.
    //
    // The assertion below moved from `toBeUndefined()` to `toBe(0)` and that is
    // the whole slice in one line: "clean" and "unstated" used to be the same
    // value, and the loop could not tell a tool that had answered from one that
    // had never been asked (ADR-0044).
    const tool = makeSearchTool({
      id: 'fake',
      endpoint: 'https://example.invalid/search',
      search: async () => {
        throw new Error('tavily 401 — chiave non valida');
      },
    });
    const out = await call(tool, { query: 'x' });

    expect(out.isError).toBe(true);
    expect(out.tier).toBe(0);
    expect(out.content).toContain('401');
  });

  it('refuses a response whose shape it does not recognise', async () => {
    // Parse at the boundary: a provider changing its field names must read as
    // "I do not recognise this", not as the word "undefined" reaching the prompt.
    const backend = tavilyBackend({
      apiKey: 'tvly-test',
      fetchFn: (async () =>
        new Response(JSON.stringify({ results: [{ titolo: 'sbagliato' }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    // The optional fields default, so a wholly wrong element still parses to
    // empty strings rather than throwing — what must not happen is `undefined`.
    const hits = await backend.search('x', AbortSignal.timeout(1000));
    expect(hits[0]).toEqual({ title: '', url: '', snippet: '' });
  });

  it('is absent from a runtime that was never given a search key, and present once it is', () => {
    // The wiring test. An unconfigured install must have no web_search in its
    // tool list rather than one that fails at the first call — the same posture
    // as the shell without a working sandbox. And the capability has to arrive
    // with the tool: a tool the kernel has never heard of is refused outright,
    // so registering them apart is how a working tool becomes a dead one.
    const home = mkdtempSync(join(tmpdir(), 'muffin-search-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-search-ws-'));
    runInit({ home, apiKey: 'sk-never-called' });

    const before = buildRuntime(home, workspace);
    expect(before.deps.tools.map((t) => t.spec.name)).not.toContain('web_search');
    expect(before.deps.decide({
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      capability: 'sys.search',
      resource: { kind: 'none' },
      args: {},
      taint: 0,
    })).toMatchObject({ effect: 'deny', code: 'no_capability' });

    const configPath = paths(home).config;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.search = { provider: 'tavily', apiKeyRef: 'secret://tavily' };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    writeSecret('tavily', 'tvly-test-key', home);

    // A key alone is not enough, and that is the point: the endpoint is a host
    // this process will talk to, so it has to be in egress.json like any other.
    const keyOnly = buildRuntime(home, workspace);
    expect(keyOnly.deps.tools.map((t) => t.spec.name)).not.toContain('web_search');
    expect(keyOnly.bootLines.join(' ')).toMatch(/api\.tavily\.com.*egress/);

    // The owner's real workflow: allowlist the host, then reseal so the change
    // reads as theirs rather than as tampering.
    const egressPath = join(paths(home).rot, 'egress.json');
    const egress = JSON.parse(readFileSync(egressPath, 'utf8'));
    egress.allow = ['api.tavily.com'];
    writeFileSync(egressPath, JSON.stringify(egress, null, 2));
    seal(home, '1', new Date());

    const after = buildRuntime(home, workspace);
    expect(after.deps.tools.map((t) => t.spec.name)).toContain('web_search');
    // `resource: { kind: 'query', ... }`, not `{ kind: 'none' }`: since
    // `slice/egress-params`, `sys.search` declares `resourceKind: 'query'`
    // (was `'none'`), and the kernel now refuses a query capability handed
    // anything else — the same fail-closed check `sys.http` already had for
    // `url` (`core/policy/decide.ts`). A hand-built request still has to
    // match what `resourceFor` (`agent/loop.ts`) would actually produce.
    expect(after.deps.decide({
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
      tenant: 'host',
      capability: 'sys.search',
      resource: { kind: 'query', value: 'qualcosa' },
      args: { query: 'qualcosa' },
      taint: 0,
    }).effect).not.toBe('deny');
  });

  it('is declared host-only, so a group member cannot spend the owner credits', () => {
    // Narrower than sys.http on purpose: reading an allowlisted public page
    // costs nothing, a search costs money per call.
    expect(searchCapability.hostOnly).toBe(true);
    // And the ceiling matches sys.http, because a tier-3 result taints the turn
    // to 3 — a lower ceiling would allow exactly one search per turn and make
    // search → read → search impossible. Since ADR-0053 that is the `egress`
    // row's doing rather than a number pinned here: the row leaves its columns
    // to the allowlist and to `paramsMaxTaint`, which are the gates that read
    // the bytes actually leaving.
    expect(searchCapability.effect).toBe('egress');
    expect(searchCapability.maxTaint).toBeUndefined();
  });
});
