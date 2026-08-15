import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../cli/init.js';
import { paths, secretDir, writeSecret } from '../core/config/config.js';
import { seal } from '../core/rot/verify.js';
import { buildRuntime } from './runtime.js';
import { runTurn, type LoopDeps } from './loop.js';
import type { ChatResult, Provider } from './providers/types.js';
import type { Principal } from '../core/policy/types.js';

/**
 * The owner's API key, against the tool that could read it.
 *
 * The path was open and nothing in the suite could see it, because each half was
 * correct on its own. `denyRead` listed one directory — `~/.muffin/secrets` —
 * while ADR-0030 required the working directory to be the repo, because that is
 * where the gitignored `.env` holding the model key lives. `fs.read` is low risk
 * and declares no `maxTaint`, so its ceiling is `defaultMaxTaint.low`, which
 * `rot/policy.json` sets to 3. One tier-3 tool result — the fetch-then-act
 * pattern the threat model calls *"il più comune, e va chiuso"* — and
 * `fs_read(".env")` returned the key in plaintext to the model.
 *
 * So the test refuses to call `fsRead` directly. It runs a turn, lets a real
 * tool result raise the taint the way production does, and asks the only
 * question that matters: **did the key's bytes reach the model.**
 *
 * The persistent store sits *inside* the working directory here on purpose.
 * That is not contrived — it is the shape the docstring in `agent/tools/fs.ts`
 * already names ("the default working directory is `$HOME`, which contains
 * `~/.muffin`"), and it is the only arrangement in which the deny entry, rather
 * than the scope root, is what refuses. Put the key outside `root` and the test
 * would pass with `denyRead` deleted.
 */

const KEY = 'sk-or-v1-QUESTA-CHIAVE-NON-DEVE-MAI-USCIRE';

class Scripted implements Provider {
  readonly kind = 'openai-compat' as const;
  /** Every tool result the model was handed — where a leak would actually land. */
  seen: string[] = [];
  private i = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(call: {
    messages: { content: { type: string; content?: string }[] }[];
  }): Promise<ChatResult> {
    for (const m of call.messages) {
      for (const b of m.content) {
        if (b.type === 'tool_result' && b.content) this.seen.push(b.content);
      }
    }
    return this.script[this.i++] ?? {
      text: 'fine', toolCalls: [], stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: 't',
    };
  }
}

const call = (id: string, name: string, args: unknown): ChatResult => ({
  text: null,
  toolCalls: [{ id, name, args }],
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  model: 't',
});

const owner: Principal = { kind: 'owner', connector: 'cli', externalId: 'local' };

type Bench = {
  home: string;
  cwd: string;
  /** Absolute path of the persistent key, relative to `cwd` for the tool call. */
  keyRelative: string;
};

function bench(): Bench {
  const cwd = mkdtempSync(join(tmpdir(), 'muffin-secret-ws-'));
  // Set before anything resolves `secretDir('persistent')` — including
  // `buildRuntime`, which builds the deny list from it.
  vi.stubEnv('XDG_CONFIG_HOME', join(cwd, '.config'));

  const home = mkdtempSync(join(tmpdir(), 'muffin-secret-'));
  runInit({ home, apiKey: KEY });
  // One host on the allowlist, so the tier-3 fetch below is an `allow` and not
  // an `ask`: the point of this turn is what happens *after* the taint rises.
  const egressFile = join(paths(home).rot, 'egress.json');
  writeFileSync(egressFile, JSON.stringify({ schemaVersion: 1, allow: ['ok.example.com'] }, null, 2));
  seal(home, '1', new Date());

  // The key in its new home — outside MUFFIN_HOME so `uninstall` cannot reach
  // it, and (here) inside the working directory so only `denyRead` stands
  // between it and the tool.
  writeSecret('provider_api_key', KEY, home, 'persistent');
  // And the old home ADR-0030 gave it, still honoured for anyone who has not
  // moved: `MUFFIN_API_KEY` out of a `.env` in the working directory.
  writeFileSync(join(cwd, '.env'), `MUFFIN_API_KEY=${KEY}\n`);
  writeFileSync(join(cwd, 'appunti.md'), 'niente di segreto\n');
  mkdirSync(join(cwd, 'vuota'), { recursive: true });

  const keyRelative = join(secretDir('persistent', home), 'provider_api_key').slice(cwd.length + 1);
  return { home, cwd, keyRelative };
}

afterEach(() => vi.unstubAllEnvs());

describe('a tainted owner turn cannot read the key', () => {
  it('refuses both places the key lives, and still reads an ordinary file', async () => {
    const b = bench();
    const runtime = buildRuntime(b.home, b.cwd);
    const provider = new Scripted([
      // Taint 0 → 3. A real tool result, through the real kernel decision.
      call('c1', 'http_get', { url: 'https://ok.example.com/page' }),
      call('c2', 'fs_read', { path: '.env' }),
      call('c3', 'fs_read', { path: b.keyRelative }),
      call('c4', 'fs_read', { path: 'appunti.md' }),
    ]);
    const deps: LoopDeps = {
      ...runtime.deps,
      provider,
      tools: runtime.deps.tools.map((t) =>
        t.spec.name === 'http_get' ? { ...t, handler: () => ({ content: 'una pagina web', tier: 3 as const }) } : t,
      ),
    };

    await runTurn(deps, {
      principal: owner, tenant: 'host', surface: 'cli',
      session: deps.sessions.open('s-secret'), text: 'leggi la pagina e poi i miei file',
    });
    runtime.close();

    const transcript = provider.seen.join('\n');
    // The assertion the whole file exists for.
    expect(transcript).not.toContain(KEY);
    // Two refusals, and both from the deny list rather than from the kernel:
    // at taint 3 `fs.read` is *allowed* — the ceiling for a low-risk capability
    // is 3 — so what holds is the path guard. If a later change pins a lower
    // `maxTaint`, this line goes red on purpose: the guarantee would then be
    // resting on a different mechanism and this test would no longer be
    // exercising the one it claims to.
    expect(transcript).toContain('read denied by the root of trust: .env');
    expect(transcript).toContain(`read denied by the root of trust: ${b.keyRelative}`);
    expect(transcript).not.toContain('Rifiutato dal kernel');
    // The gate is a gate, not a wall: an ordinary file in the same tree, in the
    // same tainted turn, still reads.
    expect(transcript).toContain('niente di segreto');
  });

  it('a directory listing does not walk around the read refusal', async () => {
    // `fs_list` is the sibling capability with the same ceiling, and a listing
    // that walks into the secrets directory leaks the *names* — which for a
    // secret store is the whole map. Cheap to check, and the kind of second door
    // that has been left open here before.
    const b = bench();
    const runtime = buildRuntime(b.home, b.cwd);
    const provider = new Scripted([
      call('c1', 'http_get', { url: 'https://ok.example.com/page' }),
      call('c2', 'fs_list', { path: join(secretDir('persistent', b.home)).slice(b.cwd.length + 1) }),
      call('c3', 'fs_list', { path: 'vuota' }),
    ]);
    const deps: LoopDeps = {
      ...runtime.deps,
      provider,
      tools: runtime.deps.tools.map((t) =>
        t.spec.name === 'http_get' ? { ...t, handler: () => ({ content: 'una pagina web', tier: 3 as const }) } : t,
      ),
    };
    await runTurn(deps, {
      principal: owner, tenant: 'host', surface: 'cli',
      session: deps.sessions.open('s-list'), text: 'guarda cosa c\'è',
    });
    runtime.close();

    const transcript = provider.seen.join('\n');
    expect(transcript).toContain('read denied by the root of trust');
    expect(transcript).not.toContain('provider_api_key');
  });
});
