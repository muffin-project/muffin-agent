import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { runTurn } from './loop.js';
import type { ChatCall, Provider } from './providers/types.js';
import { buildRuntime } from './runtime.js';

const link = 'https://example.org/calendar.json';
const request = `Consulta il calendario a ${link} e salva la data in supporto.md.`;

it.each([
  {
    label: 'a direct request with a link',
    text: request,
    origin: 'owner',
    available: true,
    visible: true,
  },
  {
    label: 'a link whose concrete call is denied',
    text: request,
    origin: 'owner',
    available: true,
    visible: true,
    deny: true,
  },
  {
    label: 'the same text from an external input',
    text: request,
    origin: 'external',
    available: true,
    visible: false,
  },
  {
    label: 'a short unrelated request',
    text: 'Dimmi il nome del modello',
    origin: 'owner',
    available: true,
    visible: false,
  },
  {
    label: 'a missing reader',
    text: request,
    origin: 'owner',
    available: false,
    visible: false,
  },
  {
    label: 'an invalid URL-shaped token',
    text: 'Notes: https://? is not an address.',
    origin: 'owner',
    available: true,
    visible: false,
  },
] as const)('projects the native reader for $label', async (scene) => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-supplied-link-'));
  const home = join(root, 'home');
  runInit({ home, apiKey: 'sk-synthetic-never-used' });
  const runtime = buildRuntime(home, root);
  try {
    const calls: ChatCall[] = [];
    const checkedUrls: string[] = [];
    const denyCall = 'deny' in scene;
    const provider: Provider = {
      kind: 'openai-compat',
      async chat(call) {
        calls.push(call);
        const firstCall = denyCall && calls.length === 1;
        return {
          text: firstCall ? null : 'fixture',
          toolCalls: firstCall
            ? [{ id: 'supplied-url', name: 'http_get', args: { url: link } }]
            : [],
          stopReason: firstCall ? 'tool_use' : 'end',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'fixture',
        };
      },
    };
    const tools = scene.available
      ? runtime.deps.tools
      : runtime.deps.tools.filter((tool) => tool.spec.name !== 'http_get');
    await runTurn(
      {
        ...runtime.deps,
        tools,
        profile: { ...runtime.deps.profile, maxToolsExposed: 6 },
        provider,
        decide(decision) {
          if (
            denyCall &&
            decision.capability === 'sys.http' &&
            decision.resource.kind === 'url-read'
          ) {
            checkedUrls.push(decision.resource.value);
            return { effect: 'deny', code: 'resource_denied', detail: 'fixture restriction' };
          }
          return runtime.deps.decide(decision);
        },
      },
      {
        principal: { kind: 'owner', connector: 'cli', externalId: 'local' },
        tenant: 'host',
        surface: 'cli',
        session: runtime.deps.sessions.open('supplied-link'),
        text: scene.text,
        inputOrigin: scene.origin,
      },
    );
    expect(calls).toHaveLength(denyCall ? 2 : 1);
    expect(checkedUrls).toEqual(denyCall ? [link] : []);
    if (denyCall) {
      const result = calls[1]?.messages
        .flatMap((message) => message.content)
        .find((block) => block.type === 'tool_result' && block.toolCallId === 'supplied-url');
      expect(result).toMatchObject({ isError: true });
    }
    const names = calls[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(names.includes('http_get')).toBe(scene.visible);
    expect(names).toContain('capability_search');
    expect(
      runtime.db.prepare("SELECT call_id FROM turn_tool_calls WHERE tool = 'http_get'").all(),
    ).toEqual([]);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
