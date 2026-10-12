import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { dimenticaModalita } from '../agent/providers/modalita.js';
import { buildRuntime } from '../agent/runtime.js';
import { loadConfig, saveConfig, writeSecret } from '../core/config/config.js';
import { runInit } from './init.js';
import { vistaFor } from './surface.js';

it('production image routing checks main and describes through its independent light endpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-vista-wiring-'));
  const home = join(root, '.muffin');
  const workspace = join(root, 'workspace');
  const mainUrl = 'https://main.synthetic.test/v1';
  const lightUrl = 'https://light.synthetic.test/v1';
  runInit({
    home,
    apiKey: 'main-canary',
    provider: 'openai-compat',
    baseUrl: mainUrl,
    mainModel: 'same-model',
    lightModel: 'same-model',
  });
  writeSecret('light_fixture', 'light-canary', home, 'home');
  const config = loadConfig(home);
  saveConfig(
    {
      ...config,
      lightProvider: {
        kind: 'openai-compat',
        baseUrl: lightUrl,
        apiKeyRef: 'secret://light_fixture',
      },
    },
    home,
  );
  const image = join(root, 'fixture.png');
  writeFileSync(
    image,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
    ]),
  );
  const requests: string[] = [];
  dimenticaModalita();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    requests.push(req.url);
    if (req.url.endsWith('/models'))
      return Response.json({
        data: [
          {
            id: 'same-model',
            architecture: {
              input_modalities: req.url.startsWith(mainUrl) ? ['text'] : ['text', 'image'],
            },
          },
        ],
      });
    expect(req.url).toBe(`${lightUrl}/chat/completions`);
    expect(req.headers.get('authorization')).toBe('Bearer light-canary');
    return Response.json({
      model: 'same-model',
      choices: [
        { message: { role: 'assistant', content: 'light description' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  });
  const runtime = buildRuntime(home, workspace);
  try {
    expect(await vistaFor(runtime)(image)).toEqual({
      modo: 'descritta',
      testo: 'light description',
      descrittaDa: 'same-model',
    });
    expect(requests).toEqual([
      `${mainUrl}/models`,
      `${lightUrl}/models`,
      `${lightUrl}/chat/completions`,
    ]);
  } finally {
    runtime.close();
    vi.restoreAllMocks();
    dimenticaModalita();
    rmSync(root, { recursive: true, force: true });
  }
});
