import { describe, expect, it, vi } from 'vitest';
import type { ImageLoad } from '../../agent/images.js';
import type { ImageBlock } from '../../agent/providers/types.js';
import { decidiVista, type MisuraVista, type VistaDeps } from './vista.js';

/**
 * Il bivio delle immagini, senza rete né modelli né disco: la misura delle
 * modalità e il caricamento sono stub iniettati, `descrivi` è finto.
 *
 * La cosa che questi test tengono chiusa è che non esista un quarto esito
 * silenzioso: un'immagine che il modello non vede deve diventare una
 * descrizione firmata o una riga che lo dice — mai un blocco mandato a un
 * modello che non lo guarda, mai niente.
 *
 * I byte veri restano coperti da `agent/images.test.ts`; il cablaggio di
 * produzione (`carica: loadImage`, `misuraVista: immagineAccettata`) vive in
 * `cli/surface.ts` ed è garantito dal typecheck.
 */

const BLOCCO: ImageBlock = { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' };

const caricaOk = (_percorso: string): ImageLoad => ({ ok: true, block: BLOCCO });
const caricaRotta =
  (why: string): ((_percorso: string) => ImageLoad) =>
  (_percorso) => ({ ok: false, why });

const base: VistaDeps = {
  baseUrl: 'https://openrouter.ai/api/v1',
  mainModel: 'm',
  lightModel: 'm-light',
  carica: caricaOk,
  misuraVista: async () => true,
};

describe('decidiVista', () => {
  it('checks each lane at its own endpoint before selecting the description route', async () => {
    const mainUrl = 'https://main.example/v1';
    const lightUrl = 'https://light.example/v1';
    const domande: { baseUrl: string | undefined; model: string; domanda: unknown }[] = [];
    const misuraVista: MisuraVista = async (baseUrl, model, domanda) => {
      domande.push({ baseUrl, model, domanda });
      return baseUrl !== mainUrl;
    };
    const descrivi = vi.fn(async () => 'description from light');
    const result = await decidiVista('/inesistente/a.png', {
      baseUrl: mainUrl,
      lightBaseUrl: lightUrl,
      apiKey: 'main-canary',
      lightApiKey: 'light-canary',
      mainModel: 'same-model',
      lightModel: 'same-model',
      carica: caricaOk,
      misuraVista,
      descrivi,
    });
    expect(result).toEqual({
      modo: 'descritta',
      testo: 'description from light',
      descrittaDa: 'same-model',
    });
    expect(domande).toEqual([
      { baseUrl: mainUrl, model: 'same-model', domanda: { apiKey: 'main-canary' } },
      { baseUrl: lightUrl, model: 'same-model', domanda: { apiKey: 'light-canary' } },
    ]);
    expect(descrivi).toHaveBeenCalledTimes(1);
  });

  it('mostra quando il modello ci vede, senza chiedere a nessuno di descrivere', async () => {
    const descrivi = vi.fn(async (_b: ImageBlock) => 'mai');
    const esito = await decidiVista('/inesistente/a.png', {
      ...base,
      misuraVista: async () => true,
      descrivi,
    });
    expect(esito).toEqual({ modo: 'mostra', blocco: expect.objectContaining({ type: 'image' }) });
    expect(descrivi).not.toHaveBeenCalled();
  });

  it('descrive col leggero quando il principale non vede, firmando chi ha descritto', async () => {
    const esito = await decidiVista('/inesistente/a.png', {
      ...base,
      mainModel: 'm/cieco',
      lightModel: 'm/vede-light',
      misuraVista: async (_url, model) => model !== 'm/cieco',
      descrivi: async () => 'un gatto sul tavolo',
    });
    expect(esito).toEqual({
      modo: 'descritta',
      testo: 'un gatto sul tavolo',
      descrittaDa: 'm/vede-light',
    });
  });

  it('dice no quando nessuno dei due vede, nominando il rimedio', async () => {
    const esito = await decidiVista('/inesistente/a.png', {
      ...base,
      mainModel: 'm/cieco',
      lightModel: 'm/cieco-light',
      misuraVista: async () => false,
      descrivi: async () => 'mai',
    });
    expect(esito.modo).toBe('no');
    if (esito.modo === 'no') {
      expect(esito.why).toContain('m/cieco-light');
      expect(esito.rimedio).toContain('/model');
    }
  });

  it('tiene la strada di sempre quando non si può misurare (Ollama)', async () => {
    const esito = await decidiVista('/inesistente/a.png', {
      ...base,
      baseUrl: 'http://localhost:11434/v1',
      mainModel: 'llava',
      lightModel: 'llava',
      misuraVista: async () => undefined,
      descrivi: async () => 'mai',
    });
    expect(esito.modo).toBe('mostra');
  });

  it('byte illeggibili: no con il perché, anche se il modello vedrebbe', async () => {
    const esito = await decidiVista('/inesistente/a.zip', {
      ...base,
      misuraVista: async () => true,
      carica: caricaRotta('non è JPEG, PNG, GIF o WebP'),
    });
    expect(esito.modo).toBe('no');
    if (esito.modo === 'no') expect(esito.why.length).toBeGreaterThan(0);
  });

  it('descrizione fallita o vuota: no, non un blocco a metà', async () => {
    const rotta = await decidiVista('/inesistente/a.png', {
      ...base,
      mainModel: 'm/cieco',
      lightModel: 'm/vede-light',
      misuraVista: async (_url, model) => model !== 'm/cieco',
      descrivi: async () => {
        throw new Error('402 chiusa');
      },
    });
    expect(rotta.modo).toBe('no');
    const vuota = await decidiVista('/inesistente/b.png', {
      ...base,
      mainModel: 'm/cieco',
      lightModel: 'm/vede-light',
      misuraVista: async (_url, model) => model !== 'm/cieco',
      descrivi: async () => '   ',
    });
    expect(vuota.modo).toBe('no');
  });
});
