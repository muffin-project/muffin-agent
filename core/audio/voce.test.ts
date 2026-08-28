import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dimenticaModalita } from '../../agent/providers/modalita.js';
import { decidiVoce } from './voce.js';

/**
 * Il bivio che l'owner ha disegnato il 28/08/2026: «se il modello supporta
 * audio lo mandiamo al modello direttamente, altrimenti usiamo whisper.cpp,
 * quindi facciamo entrambe le cose, ma scegliamo quale fare in base al modello
 * a cui stiamo mandando».
 *
 * Questi test provano che la scelta la fa il **modello** e non una manopola, e
 * soprattutto che non esiste un terzo esito silenzioso: una nota vocale
 * ricevuta di cui nessuno dice niente è un pezzo di conversazione perso senza
 * traccia.
 */

let dir: string;
let audio: string;
beforeEach(() => {
  dimenticaModalita();
  dir = mkdtempSync(join(tmpdir(), 'muffin-voce-test-'));
  audio = join(dir, 'vocale.ogg');
  writeFileSync(audio, Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(32)]));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const elenco = (modalita: string[]): typeof globalThis.fetch =>
  (async () =>
    new Response(JSON.stringify({ data: [{ id: 'm', architecture: { input_modalities: modalita } }] }), {
      status: 200,
    })) as unknown as typeof globalThis.fetch;

/** Un modello whisper che esiste, e un `run` che finge di trascrivere. */
const conWhisper = (): { whisperModel: string; run: (b: string, a: string[]) => Promise<{ stdout: string }> } => {
  const m = join(dir, 'ggml-base.bin');
  writeFileSync(m, 'esiste');
  return {
    whisperModel: m,
    run: async (bin, args) => {
      if (bin === 'whisper-cli') {
        writeFileSync(`${args[args.indexOf('-of') + 1]!}.txt`, 'ciao, è una nota vocale');
      }
      return { stdout: '' };
    },
  };
};

describe('chi ascolta, ascolta', () => {
  it('un modello con audio in ingresso riceve i byte, e whisper non gira nemmeno', async () => {
    let girato = false;
    const esito = await decidiVoce(audio, {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'm',
      fetch: elenco(['text', 'audio']),
      ...conWhisper(),
      run: async () => {
        girato = true;
        return { stdout: '' };
      },
    });
    expect(esito.modo).toBe('ascolta');
    if (esito.modo !== 'ascolta') return;
    expect(esito.blocco.mediaType).toBe('audio/ogg');
    expect(girato).toBe(false);
  });
});

describe('chi non ascolta, legge', () => {
  /**
   * È il caso dell'owner oggi: `qwen/qwen3.8-27b` dichiara
   * `["text","image","video"]`, misurato il 28/08/2026. La voce non esce di
   * casa, e nessun byte audio parte.
   */
  it('un modello senza audio in ingresso fa trascrivere in casa', async () => {
    const esito = await decidiVoce(audio, {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'm',
      fetch: elenco(['text', 'image', 'video']),
      ...conWhisper(),
    });
    expect(esito).toEqual({ modo: 'trascritto', testo: 'ciao, è una nota vocale' });
  });

  it('e Anthropic pure, senza chiedere niente a nessuno', async () => {
    const esito = await decidiVoce(audio, { model: 'claude-opus-5', ...conWhisper() });
    expect(esito.modo).toBe('trascritto');
  });
});

describe('e quando non si può fare né l uno né l altro', () => {
  it("lo dice, con il rimedio, invece di tacere", async () => {
    const esito = await decidiVoce(audio, {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'm',
      fetch: elenco(['text']),
      run: async () => ({ stdout: '' }),
    });
    expect(esito.modo).toBe('no');
    if (esito.modo !== 'no') return;
    expect(esito.why).toContain('non accetta audio');
    expect(esito.rimedio).toContain('huggingface.co');
  });

  /**
   * Il modello ascolterebbe, ma questi byte non glieli possiamo dare: il file
   * non è un audio riconoscibile. Non è la fine — la trascrizione locale non ha
   * quel limite, e provarla è meglio che chiudere lì.
   */
  it('un modello che ascolta ma byte che non sappiamo nominare ricade sulla trascrizione', async () => {
    const nonAudio = join(dir, 'roba.ogg');
    writeFileSync(nonAudio, 'questo non è audio');
    const esito = await decidiVoce(nonAudio, {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'm',
      fetch: elenco(['text', 'audio']),
      ...conWhisper(),
    });
    expect(esito.modo).toBe('trascritto');
  });
});
