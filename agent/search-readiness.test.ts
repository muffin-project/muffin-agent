import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { loadConfig, saveConfig } from '../core/config/config.js';
import type { Principal } from '../core/policy/types.js';
import { runTurn } from './loop.js';
import type { ChatCall, Provider } from './providers/types.js';
import { buildRuntime } from './runtime.js';

it.each([
  {
    principal: { kind: 'owner', connector: 'telegram', externalId: 'owner' } satisfies Principal,
    tenant: 'host',
    diagnostic: true,
  },
  {
    principal: {
      kind: 'member',
      connector: 'telegram',
      externalId: 'member',
      tenantId: 'group:telegram:100',
    } satisfies Principal,
    tenant: 'group:telegram:100',
    diagnostic: false,
  },
])('provides search readiness only in its owner context ($tenant)', async (scene) => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-search-readiness-'));
  const home = join(root, 'home');
  runInit({ home, apiKey: 'sk-never-used' });
  saveConfig(
    {
      ...loadConfig(home),
      search: { provider: 'tavily', apiKeyRef: 'secret://unconnected_tavily' },
    },
    home,
  );
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
    expect(messages.includes('Ricerca web indisponibile')).toBe(scene.diagnostic);
    expect(messages.includes('unconnected_tavily')).toBe(scene.diagnostic);
    expect(first?.tools?.map((tool) => tool.name)).not.toContain('web_search');
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
