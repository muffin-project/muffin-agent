import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { dimenticaModalita } from '../agent/providers/modalita.js';
import { buildRuntime } from '../agent/runtime.js';
import { runInit } from './init.js';
import { voceFor } from './surface.js';

it('production voice routing sends real bytes to a model that listens, without touching whisper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'muffin-voce-wiring-'));
  const home = join(root, '.muffin');
  const workspace = join(root, 'workspace');
  const mainUrl = 'https://main.synthetic.test/v1';
  runInit({
    home,
    apiKey: 'main-canary',
    provider: 'openai-compat',
    baseUrl: mainUrl,
    mainModel: 'm/ascolta',
    lightModel: 'm/ascolta-light',
  });
  const audio = join(root, 'vocale.ogg');
  writeFileSync(audio, Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(32)]));
  const requests: string[] = [];
  dimenticaModalita();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    requests.push(req.url);
    if (req.url.endsWith('/models'))
      return Response.json({
        data: [{ id: 'm/ascolta', architecture: { input_modalities: ['text', 'audio'] } }],
      });
    throw new Error(`unexpected request in voice wiring test: ${req.url}`);
  });
  const runtime = buildRuntime(home, workspace);
  try {
    const esito = await voceFor(runtime, home)(audio);
    expect(esito.modo).toBe('ascolta');
    if (esito.modo !== 'ascolta') return;
    expect(esito.blocco).toEqual(
      expect.objectContaining({ type: 'audio', mediaType: 'audio/ogg' }),
    );
    // La misura è passata dal provider reale: una sola domanda ai modelli,
    // nessuna trascrizione, nessun byte oltre l'intestazione annusata.
    expect(requests).toEqual([`${mainUrl}/models`]);
  } finally {
    runtime.close();
    vi.restoreAllMocks();
    dimenticaModalita();
    rmSync(root, { recursive: true, force: true });
  }
});
