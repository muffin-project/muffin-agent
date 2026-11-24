import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { loadConfig, paths, saveConfig, writeSecret } from '../core/config/config.js';
import type { Principal } from '../core/policy/types.js';
import { seal } from '../core/rot/verify.js';
import { runTurn } from './loop.js';
import type { ChatCall, Provider } from './providers/types.js';
import { buildRuntime } from './runtime.js';

const OWNER: Principal = { kind: 'owner', connector: 'telegram', externalId: 'owner' };
const GROUP = 'group:telegram:100';
const MEMBER: Principal = {
  kind: 'member',
  connector: 'telegram',
  externalId: 'member',
  tenantId: GROUP,
};

it.each([
  { principal: OWNER, tenant: 'host', state: 'missing', reason: 'credenziale' },
  { principal: OWNER, tenant: 'host', state: 'egress', reason: 'accesso di rete' },
  { principal: OWNER, tenant: 'host', state: 'ready', reason: null },
  { principal: OWNER, tenant: 'host', state: 'unconfigured', reason: null },
  { principal: MEMBER, tenant: GROUP, state: 'missing', reason: null },
])('reports configured search readiness for $tenant when $state', async (scene) => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-search-readiness-'));
  const home = join(root, 'home');
  runInit({ home, apiKey: 'sk-never-used' });
  if (scene.state !== 'unconfigured') {
    saveConfig(
      {
        ...loadConfig(home),
        search: { provider: 'tavily', apiKeyRef: 'secret://fixture_search_reference' },
      },
      home,
    );
  }
  if (scene.state === 'egress' || scene.state === 'ready') {
    writeSecret('fixture_search_reference', 'fixture-search-key', home);
  }
  if (scene.state === 'ready') {
    writeFileSync(
      join(paths(home).rot, 'egress.json'),
      JSON.stringify({ schemaVersion: 1, allow: ['api.tavily.com'] }),
    );
    seal(home, '1', new Date());
  }
  const runtime = buildRuntime(home, root);
  try {
    const calls: ChatCall[] = [];
    const provider: Provider = {
      kind: 'openai-compat',
      async chat(call) {
        calls.push(call);
        return {
          text: 'fixture',
          toolCalls: [],
          stopReason: 'end',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'fixture',
        };
      },
    };
    await runTurn(
      { ...runtime.deps, provider },
      {
        principal: scene.principal,
        tenant: scene.tenant,
        surface: 'telegram',
        session: runtime.deps.sessions.open('web-search-readiness'),
        text: 'Cerca la documentazione ufficiale aggiornata e mandami una nota con i link.',
      },
    );
    const first = calls[0];
    expect(first).toBeDefined();
    const messages = JSON.stringify(first?.messages);
    expect(messages).not.toContain('fixture_search_reference');
    expect(messages).not.toContain(join(home, 'secrets'));
    expect(messages).not.toContain('fixture-search-key');
    expect(messages.includes('Ricerca web indisponibile')).toBe(scene.reason !== null);
    if (scene.reason !== null) expect(messages).toContain(scene.reason);
    expect(runtime.deps.tools.some((tool) => tool.spec.name === 'web_search')).toBe(
      scene.state === 'ready',
    );
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
