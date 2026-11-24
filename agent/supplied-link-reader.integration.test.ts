import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runInit } from '../cli/init.js';
import { composeTurnText } from '../connectors/shared/ingress/compose.js';
import { runTurn } from './loop.js';
import type { ChatCall, Provider } from './providers/types.js';
import { buildRuntime } from './runtime.js';

const link = 'https://example.org/calendar.json';
// Strong lexical candidates make it observable whether the reader displaces one
// ordinary candidate or replaces the whole selection.
const work = 'fs_edit supporto.md; todo promemoria.';
const request = `Consulta il calendario a ${link}. ${work}`;
const quote = { source: 'quoted', tier: 2, text: link } as const;
const author = { source: 'author', tier: 0, text: work } as const;

it.each([
  { label: 'a direct request with a link', text: request, first: 'http_get' },
  { label: 'a link whose concrete call is denied', text: request, first: 'http_get', deny: true },
  {
    label: 'the same text from an external input',
    text: request,
    first: 'fs_edit',
    external: true,
  },
  { label: 'a short unrelated request', text: work, first: 'fs_edit' },
  { label: 'a missing reader', text: request, first: 'fs_edit', missing: true },
  { label: 'a denied reader', text: request, first: 'fs_edit', safeMode: true },
  { label: 'an invalid URL-shaped token', text: `https://? ${work}`, first: 'fs_edit' },
  {
    label: 'a Markdown link with a port',
    text: `[calendario](https://example.org:8443) ${work}`,
    first: 'http_get',
  },
  {
    label: 'a link only in a quote',
    text: composeTurnText([author, quote]),
    first: 'fs_edit',
    quoted: true,
  },
  {
    label: 'a link only in a forward',
    text: composeTurnText([author, { ...quote, source: 'forwarded' }]),
    first: 'fs_edit',
    quoted: true,
  },
  {
    label: 'an authored link alongside a quote',
    text: composeTurnText([{ ...author, text: request }, quote]),
    first: 'http_get',
    quoted: true,
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
    const tools =
      'missing' in scene
        ? runtime.deps.tools.filter((tool) => tool.spec.name !== 'http_get')
        : runtime.deps.tools;
    await runTurn(
      {
        ...runtime.deps,
        tools,
        profile: { ...runtime.deps.profile, maxToolsExposed: 8 },
        provider,
        decide(decision) {
          if ('safeMode' in scene && decision.capability === 'sys.http') {
            return { effect: 'deny', code: 'safe_mode' };
          }
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
        principal: { kind: 'owner', connector: 'telegram', externalId: 'local' },
        tenant: 'host',
        surface: 'telegram',
        session: runtime.deps.sessions.open('supplied-link'),
        text: scene.text,
        inputOrigin: 'external' in scene ? 'external' : 'owner',
        contentTaint: 'quoted' in scene ? 2 : 0,
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
    expect(names).toContain('capability_search');
    expect(names[names.indexOf('capability_search') + 1]).toBe(scene.first);
    expect(names).toContain('fs_edit');
    expect(
      runtime.db.prepare("SELECT call_id FROM turn_tool_calls WHERE tool = 'http_get'").all(),
    ).toEqual([]);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
