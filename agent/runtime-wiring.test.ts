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
