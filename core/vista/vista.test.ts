import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dimenticaModalita } from '../../agent/providers/modalita.js';
import type { ImageBlock } from '../../agent/providers/types.js';
import { decidiVista } from './vista.js';

/**
 * Il bivio delle immagini, senza rete né modelli: la domanda sulle modalità
 * è finta, `descrivi` è finto, i byte sono veri (loadImage annusa davvero).
 *
 * La cosa che questi test tengono chiusa è che non esista un quarto esito
 * silenzioso: un'immagine che il modello non vede deve diventare una
 * descrizione firmata o una riga che lo dice — mai un blocco mandato a un
 * modello che non lo guarda, mai niente.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const URL = 'https://openrouter.ai/api/v1';

const elenco = (modelli: unknown[]): typeof globalThis.fetch =>
  (async () =>
    new Response(JSON.stringify({ data: modelli }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

const immagine = (dir: string, nome: string, bytes: Buffer = PNG): string => {
  const percorso = join(dir, nome);
  writeFileSync(percorso, bytes);
  return percorso;
};

const VEDENTE = (id: string) => ({ id, architecture: { input_modalities: ['text', 'image'] } });
const CIECO = (id: string) => ({ id, architecture: { input_modalities: ['text'] } });

beforeEach(() => {
  dimenticaModalita();
  vi.restoreAllMocks();
});

describe('decidiVista', () => {
  it('mostra quando il modello ci vede, senza chiedere a nessuno di descrivere', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-vista-'));
    try {
      const descrivi = vi.fn(async (_b: ImageBlock) => 'mai');
      const esito = await decidiVista(immagine(dir, 'a.png'), {
        baseUrl: URL,
        mainModel: 'm/vede',
        lightModel: 'm/vede-light',
        fetch: elenco([VEDENTE('m/vede')]),
        descrivi,
      });
      expect(esito).toEqual({ modo: 'mostra', blocco: expect.objectContaining({ type: 'image' }) });
      expect(descrivi).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('descrive col leggero quando il principale non vede, firmando chi ha descritto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-vista-'));
    try {
      const esito = await decidiVista(immagine(dir, 'a.png'), {
        baseUrl: URL,
        mainModel: 'm/cieco',
        lightModel: 'm/vede-light',
        fetch: elenco([CIECO('m/cieco'), VEDENTE('m/vede-light')]),
        descrivi: async () => 'un gatto sul tavolo',
      });
      expect(esito).toEqual({ modo: 'descritta', testo: 'un gatto sul tavolo', descrittaDa: 'm/vede-light' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dice no quando nessuno dei due vede, nominando il rimedio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-vista-'));
    try {
      const esito = await decidiVista(immagine(dir, 'a.png'), {
        baseUrl: URL,
        mainModel: 'm/cieco',
        lightModel: 'm/cieco-light',
        fetch: elenco([CIECO('m/cieco'), CIECO('m/cieco-light')]),
        descrivi: async () => 'mai',
      });
      expect(esito.modo).toBe('no');
      if (esito.modo === 'no') {
        expect(esito.why).toContain('m/cieco-light');
        expect(esito.rimedio).toContain('/model');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tiene la strada di sempre quando non si può misurare (Ollama)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-vista-'));
    try {
      const f = elenco([{ id: 'llava', object: 'model', owned_by: 'library' }]);
      const esito = await decidiVista(immagine(dir, 'a.png'), {
        baseUrl: 'http://localhost:11434/v1',
        mainModel: 'llava',
        lightModel: 'llava',
        fetch: f,
        descrivi: async () => 'mai',
      });
      expect(esito.modo).toBe('mostra');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('byte illeggibili: no con il perché, anche se il modello vedrebbe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-vista-'));
    try {
      const esito = await decidiVista(immagine(dir, 'a.zip', Buffer.from('PK\x03\x04')), {
        baseUrl: URL,
        mainModel: 'm/vede',
        lightModel: 'm/vede-light',
        fetch: elenco([VEDENTE('m/vede')]),
      });
      expect(esito.modo).toBe('no');
      if (esito.modo === 'no') expect(esito.why.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('descrizione fallita o vuota: no, non un blocco a metà', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-vista-'));
    try {
      const base = {
        baseUrl: URL,
        mainModel: 'm/cieco',
        lightModel: 'm/vede-light',
        fetch: elenco([CIECO('m/cieco'), VEDENTE('m/vede-light')]),
      };
      const rotta = await decidiVista(immagine(dir, 'a.png'), {
        ...base,
        descrivi: async () => {
          throw new Error('402 chiusa');
        },
      });
      expect(rotta.modo).toBe('no');
      const vuota = await decidiVista(immagine(dir, 'b.png'), { ...base, descrivi: async () => '   ' });
      expect(vuota.modo).toBe('no');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
