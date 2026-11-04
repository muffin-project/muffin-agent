import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estraiFotogramma } from './fotogramma.js';

/**
 * Un fotogramma senza ffmpeg vero: `run` è iniettabile, come in `trascrivi`.
 * La cosa che questi test tengono chiusa è che ogni fallimento diventi una
 * riga per l'owner — mai un'eccezione che risale fino al turno, mai silenzio.
 */
describe('estraiFotogramma', () => {
  it('chiama ffmpeg per il primo fotogramma e dice ok quando il file c è', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muffin-frame-'));
    try {
      const viste: { bin: string; args: string[] }[] = [];
      const fuori = join(dir, 'f.png');
      const esito = await estraiFotogramma(join(dir, 'in.webm'), fuori, {
        run: async (bin, args) => {
          viste.push({ bin, args });
          writeFileSync(fuori, Buffer.from([0x89, 0x50]));
          return { stdout: '' };
        },
      });
      expect(esito).toEqual({ ok: true });
      expect(viste).toHaveLength(1);
      expect(viste[0]?.bin).toBe('ffmpeg');
      expect(viste[0]?.args).toContain('-vframes');
      expect(viste[0]?.args).toContain('1');
      expect(viste[0]?.args[viste[0]!.args.length - 1]).toBe(fuori);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ffmpeg assente: lo dice col rimedio, non con lo stack', async () => {
    const esito = await estraiFotogramma('/vault/in.webm', '/vault/f.png', {
      run: async () => {
        throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(esito.ok).toBe(false);
    if (!esito.ok) {
      expect(esito.why).toContain('ffmpeg non è installato');
      expect(esito.rimedio).toContain('ffmpeg');
    }
  });

  it('ffmpeg che fallisce o non scrive: perché, non eccezione', async () => {
    const rotto = await estraiFotogramma('/vault/in.webm', '/vault/f.png', {
      run: async () => {
        throw new Error('Option not found');
      },
    });
    expect(rotto.ok).toBe(false);
    if (!rotto.ok) expect(rotto.why).toContain('ffmpeg ha fallito');

    const muto = await estraiFotogramma('/vault/in.webm', '/vault/mai.png', {
      run: async () => ({ stdout: '' }),
    });
    expect(muto).toEqual({ ok: false, why: 'ffmpeg non ha scritto il fotogramma' });
  });
});
