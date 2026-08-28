import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trascrivi } from './trascrivi.js';

/**
 * La voce dell'owner trascritta in casa, e cosa succede quando non si può.
 *
 * Il ramo che gira oggi: `qwen/qwen3.8-27b` non accetta audio in ingresso —
 * misurato sull'elenco modelli di OpenRouter il 28/08/2026 — quindi una nota
 * vocale passa di qui e non esce di casa.
 *
 * Nessuno di questi test lancia whisper davvero: il seam `run` esiste per
 * questo. Ciò che viene provato è tutto il resto, che è dove stanno i difetti
 * veri — i rimedi, la pulizia del temporaneo, e la differenza fra «non
 * installato» e «ha fallito».
 */

let dir: string;
let audio: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muffin-trascrivi-test-'));
  audio = join(dir, 'vocale.ogg');
  writeFileSync(audio, 'OggS finto');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Un modello che c'è per davvero, perché `trascrivi` guarda che esista. */
const modelloFinto = (): string => {
  const m = join(dir, 'ggml-base.bin');
  writeFileSync(m, 'non è un modello, ma esiste');
  return m;
};

describe('quando manca un pezzo, lo dice con il comando che lo ripara', () => {
  /**
   * Il difetto che questo chiude è quello riparato in #223 e #224: un rimedio
   * stampato che non funziona più. I comandi qui dentro sono stati verificati
   * il 28/08/2026 — la formula Homebrew `whisper-cpp` (1.9.2) installa
   * `whisper-cli`, lo chiama così il suo stesso test, e l'URL del modello
   * risponde 200.
   */
  it('nessun modello configurato: dice come scaricarlo, e non prova a girare', async () => {
    let girato = false;
    const esito = await trascrivi(audio, {
      run: async () => {
        girato = true;
        return { stdout: '' };
      },
    });
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.rimedio).toContain('ggml-base.bin');
    expect(esito.rimedio).toContain('huggingface.co');
    // Non si converte niente per poi scoprire che non c'è chi lo legga.
    expect(girato).toBe(false);
  });

  it('modello configurato ma non sul disco: stesso rimedio, e lo nomina', async () => {
    const esito = await trascrivi(audio, { whisperModel: join(dir, 'mai-scaricato.bin'), run: async () => ({ stdout: '' }) });
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.why).toContain('mai-scaricato.bin');
    expect(esito.rimedio).toContain('huggingface.co');
  });

  /**
   * `ENOENT` da `execFile` significa «quel comando non esiste». Confonderlo con
   * un errore del comando manderebbe l'owner a cercare un guasto in whisper
   * invece che a installarlo.
   */
  it('ffmpeg non installato è una cosa diversa da ffmpeg che fallisce', async () => {
    const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    const assente = await trascrivi(audio, {
      whisperModel: modelloFinto(),
      run: async () => {
        throw enoent;
      },
    });
    expect(assente.ok).toBe(false);
    if (assente.ok) return;
    expect(assente.why).toContain('non è installato');
    expect(assente.rimedio).toContain('ffmpeg');

    const rotto = await trascrivi(audio, {
      whisperModel: modelloFinto(),
      run: async () => {
        throw new Error('Invalid data found when processing input');
      },
    });
    expect(rotto.ok).toBe(false);
    if (rotto.ok) return;
    expect(rotto.why).toContain('ha fallito');
    expect(rotto.rimedio).toBeUndefined();
  });

  it('e whisper non installato manda a installare whisper, non ffmpeg', async () => {
    const esito = await trascrivi(audio, {
      whisperModel: modelloFinto(),
      run: async (bin) => {
        if (bin === 'whisper-cli') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { stdout: '' };
      },
    });
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.rimedio).toContain('whisper-cpp');
  });
});

describe('quando gira', () => {
  it('converte a 16 kHz mono PCM 16 e poi legge il file che whisper scrive', async () => {
    const visti: { bin: string; args: string[] }[] = [];
    const esito = await trascrivi(audio, {
      whisperModel: modelloFinto(),
      run: async (bin, args) => {
        visti.push({ bin, args });
        // whisper scrive `<-of>.txt`: lo simuliamo, perché è proprio quel file
        // che `trascrivi` deve preferire a stdout.
        if (bin === 'whisper-cli') {
          const of = args[args.indexOf('-of') + 1]!;
          writeFileSync(`${of}.txt`, '  ciao, ti mando una nota vocale  \n');
          return { stdout: 'whisper_print_progress: 100%' };
        }
        return { stdout: '' };
      },
    });
    expect(esito).toEqual({ ok: true, testo: 'ciao, ti mando una nota vocale' });

    // La forma che `whisper-cli` sa leggere, scritta com'è nel suo README.
    const ff = visti[0]!;
    expect(ff.bin).toBe('ffmpeg');
    expect(ff.args).toContain('16000');
    expect(ff.args).toContain('pcm_s16le');
    expect(ff.args).toContain(audio);
    // I byte dell'audio non diventano mai un argomento: viaggiano su disco.
    expect(ff.args.some((a) => a.includes('OggS'))).toBe(false);
  });

  it('e una nota muta è un fallimento detto, non una stringa vuota spacciata per risposta', async () => {
    const esito = await trascrivi(audio, {
      whisperModel: modelloFinto(),
      run: async () => ({ stdout: '   \n  ' }),
    });
    expect(esito.ok).toBe(false);
    if (esito.ok) return;
    expect(esito.why).toContain('silenziosa');
  });
});

describe('il WAV convertito non resta in giro', () => {
  /**
   * È la voce dell'owner in chiaro. `finally` la cancella anche quando whisper
   * fallisce — che è proprio il caso in cui qualcuno sarebbe tentato di
   * lasciarla lì «per guardarci».
   */
  it('nemmeno quando whisper fallisce', async () => {
    const primaDelle = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('muffin-audio-')));
    await trascrivi(audio, {
      whisperModel: modelloFinto(),
      run: async (bin, args) => {
        if (bin === 'whisper-cli') throw new Error('crash');
        writeFileSync(args[args.length - 1]!, 'wav finto');
        return { stdout: '' };
      },
    });
    const dopo = readdirSync(tmpdir()).filter((n) => n.startsWith('muffin-audio-') && !primaDelle.has(n));
    expect(dopo).toEqual([]);
  });

  it('né quando è andato tutto bene', async () => {
    let cartella = '';
    await trascrivi(audio, {
      whisperModel: modelloFinto(),
      run: async (bin, args) => {
        if (bin === 'whisper-cli') {
          const of = args[args.indexOf('-of') + 1]!;
          cartella = join(of, '..');
          writeFileSync(`${of}.txt`, 'detto');
          return { stdout: '' };
        }
        return { stdout: '' };
      },
    });
    expect(cartella).not.toBe('');
    expect(existsSync(cartella)).toBe(false);
  });
});
