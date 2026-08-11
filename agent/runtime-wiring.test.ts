import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { paths } from '../core/config/config.js';
import { seal } from '../core/rot/verify.js';
import { buildRuntime } from './runtime.js';
import { runTurn, type LoopDeps } from './loop.js';
import type { ChatResult, Provider } from './providers/types.js';
import type { Principal } from '../core/policy/types.js';

/**
 * The joins `buildRuntime` is responsible for, asserted through a real turn.
 *
 * Two lines in `buildRuntime` carry the whole egress guarantee: the one that
 * hands the capability declarations to the loop, and the one that hands the
 * allowlist to the kernel. Delete either and the entire suite stayed green —
 * `sys.http` would be refused for everyone, always, silently, and nothing said
 * so. Both fail closed, so neither was a hole; both were total outages that no
 * test could notice.
 *
 * That is the exact shape of the defect this slice fixes, one level up, and the
 * lesson it adds says it out loud: when two components each defer to the other,
 * the test has to span the join. This file is that test.
 */

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(): Promise<ChatResult> {
    return this.script[this.i++] ?? {
      text: 'fine', toolCalls: [], stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 't',
    };
  }
}

const fetchCall = (url: string): ChatResult => ({
  text: null,
  toolCalls: [{ id: 'c1', name: 'http_get', args: { url } }],
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 't',
});

const member: Principal = {
  kind: 'member', connector: 'telegram', tenantId: 'group:telegram:42', externalId: 'u1',
};

/** A home whose root of trust allows exactly one host. */
function homeAllowing(host: string): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-wiring-'));
  runInit({ home, apiKey: 'sk-never-called' });
  const egress = join(paths(home).rot, 'egress.json');
  const policy = JSON.parse(readFileSync(egress, 'utf8'));
  policy.allow = [host];
  writeFileSync(egress, JSON.stringify(policy, null, 2));
  seal(home, '1', new Date());
  return home;
}

/** The production runtime, with only the model and the socket replaced. */
function turnAgainst(home: string, url: string): { fetched: string[]; deps: LoopDeps } {
  const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-wiring-ws-')));
  const fetched: string[] = [];
  const deps: LoopDeps = {
    ...runtime.deps,
    provider: new Scripted([fetchCall(url)]),
    tools: runtime.deps.tools.map((t) =>
      t.spec.name === 'http_get'
        ? { ...t, handler: (args: unknown) => { fetched.push(String((args as { url: string }).url)); return { content: 'body', tier: 3 as const }; } }
        : t,
    ),
  };
  return { fetched, deps };
}

describe('buildRuntime hands the kernel what it needs', () => {
  it('refuses a host the root of trust does not list', async () => {
    const home = homeAllowing('ok.example.com');
    const { fetched, deps } = turnAgainst(home, 'https://evil.example.com/steal');
    await runTurn(deps, {
      principal: member, tenant: 'group:telegram:42', surface: 'telegram',
      session: deps.sessions.open('w1'), text: 'leggi',
    });
    expect(fetched).toEqual([]);
  });

  it('allows the one it does list — so the gate is a gate, not an outage', async () => {
    // Without this half, unwiring either line would look like a pass: refusing
    // everything satisfies the test above perfectly.
    const home = homeAllowing('ok.example.com');
    const { fetched, deps } = turnAgainst(home, 'https://ok.example.com/page');
    await runTurn(deps, {
      principal: member, tenant: 'group:telegram:42', surface: 'telegram',
      session: deps.sessions.open('w2'), text: 'leggi',
    });
    expect(fetched).toEqual(['https://ok.example.com/page']);
  });
});

describe('the sealed permission matrix reaches the kernel', () => {
  /**
   * P3: the file is load-bearing, proven the only way that counts — an owner
   * edit, a reseal, a restart, and a different answer to the same turn.
   *
   * `memory.read` is the capability that isolates the ceiling: it is low risk,
   * so safe mode cannot be the thing refusing it, and it declares no `maxTaint`
   * of its own, so the class default from `rot/policy.json` is the only number
   * in play. A member starts the turn at taint 2 (`loop.ts`), which the shipped
   * ceiling of 3 admits and a lowered ceiling of 1 does not.
   */
  function homeWithLowCeiling(low: number): string {
    const home = mkdtempSync(join(tmpdir(), 'muffin-matrix-'));
    runInit({ home, apiKey: 'sk-never-called' });
    const file = join(paths(home).rot, 'policy.json');
    const policy = JSON.parse(readFileSync(file, 'utf8'));
    policy.defaultMaxTaint = { ...policy.defaultMaxTaint, low };
    writeFileSync(file, JSON.stringify(policy, null, 2));
    // Reseal, because an edited-but-unsealed root of trust degrades to safe
    // mode and would refuse for a reason that has nothing to do with this test.
    seal(home, '1', new Date());
    return home;
  }

  const recall: ChatResult = {
    text: null,
    toolCalls: [{ id: 'c1', name: 'memory_search', args: { query: 'chi sono' } }],
    stopReason: 'tool_use',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: 't',
  };

  async function searchesIn(home: string, session: string): Promise<string[]> {
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-matrix-ws-')));
    const searched: string[] = [];
    const deps: LoopDeps = {
      ...runtime.deps,
      provider: new Scripted([recall]),
      tools: runtime.deps.tools.map((t) =>
        t.spec.name === 'memory_search'
          ? { ...t, handler: (args: unknown) => { searched.push(String((args as { query: string }).query)); return { content: 'niente' }; } }
          : t,
      ),
    };
    await runTurn(deps, {
      principal: member, tenant: 'group:telegram:42', surface: 'telegram',
      session: deps.sessions.open(session), text: 'ricordi?',
    });
    runtime.close();
    return searched;
  }

  it('admits a taint-2 member at the ceiling the shipped file declares', async () => {
    expect(await searchesIn(homeWithLowCeiling(3), 'm1')).toEqual(['chi sono']);
  });

  it('refuses the same turn once the owner lowers that ceiling and reseals', async () => {
    expect(await searchesIn(homeWithLowCeiling(1), 'm2')).toEqual([]);
  });
});

describe('provider caching is wired by endpoint', () => {
  /**
   * The flag exists only if this join exists: `explicitCache` defaulting off
   * means a runtime that forgets to pass it produces a provider that silently
   * pays full price — the exact invisible state this slice was sent to end.
   * Asserted on the constructed provider, not on a request, because the request
   * shape has its own tests and this file owns the joins.
   */
  const providerOf = (baseUrl?: string) => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-cachewire-'));
    runInit({ home, apiKey: 'sk-never-called', ...(baseUrl ? { baseUrl, provider: 'openai-compat' as const } : {}) });
    const runtime = buildRuntime(home, mkdtempSync(join(tmpdir(), 'muffin-cachewire-ws-')));
    const provider = runtime.deps.provider as { explicitCache?: boolean };
    runtime.close();
    return provider;
  };

  it('asks OpenRouter for the cache, because there it only exists on request', () => {
    expect(providerOf('https://openrouter.ai/api/v1').explicitCache).toBe(true);
  });

  it('leaves every other endpoint on the byte-identical request it always got', () => {
    expect(providerOf('http://localhost:11434/v1').explicitCache).toBe(false);
  });

  it('a hostname that merely contains the name does not flip the request shape', () => {
    expect(providerOf('https://openrouter.ai.evil.tld/v1').explicitCache).toBe(false);
  });
});
