import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, loadImage } from './images.js';

function scrivi(nome: string, bytes: Buffer): string {
  const p = join(mkdtempSync(join(tmpdir(), 'muffin-img-')), nome);
  writeFileSync(p, bytes);
  return p;
}

/** Intestazioni vere, non finte: sono i byte che `sniff` deve riconoscere. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(20)]);

describe('il tipo lo dicono i byte, non il nome', () => {
  it('riconosce i quattro formati che entrambi i provider accettano', () => {
    for (const [bytes, atteso] of [
      [JPEG, 'image/jpeg'],
      [PNG, 'image/png'],
      [GIF, 'image/gif'],
      [WEBP, 'image/webp'],
    ] as const) {
      const r = loadImage(scrivi('x.bin', bytes));
      expect(r.ok && r.block.mediaType).toBe(atteso);
    }
  });

  /**
   * **Il caso che conta.** Un `.png` che dentro è un JPEG fa fallire la
   * richiesta con un errore del provider che parla di codifica e non di nome
   * del file, e chi lo legge non ha nessun motivo di sospettare l'estensione.
   * Su Telegram non è un caso di scuola: il nome del file lo sceglie il
   * mittente.
   */
  it("un'estensione che mente non decide niente", () => {
    const r = loadImage(scrivi('foto.png', JPEG));
    expect(r.ok && r.block.mediaType).toBe('image/jpeg');
  });

  it('e un file che non è nessuno dei quattro viene rifiutato, non indovinato', () => {
    const r = loadImage(scrivi('finta.jpg', Buffer.from('questo è testo, non una foto')));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain('JPEG, PNG, GIF o WebP');
  });
});

describe('cosa non entra', () => {
  /**
   * Il tetto è sui byte del file e non sul base64 perché è quello che si può
   * controllare **prima** di leggere: uno `statSync` costa niente, caricare
   * 40MB in memoria per scoprire che erano troppi costa 40MB.
   */
  it("un'immagine oltre il tetto viene rifiutata dicendo quanto pesa", () => {
    const grande = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const r = loadImage(scrivi('enorme.png', grande));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain('oltre il limite');
  });

  /** Non lancia mai: ogni fallimento qui è una frase da dire, non uno stack. */
  it('un percorso che non esiste è una frase, non un errore lanciato', () => {
    const r = loadImage('/non/esiste/da/nessuna/parte.png');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain('non leggibile');
  });
});

describe('cosa arriva al modello', () => {
  /**
   * base64 **nudo**, senza prefisso `data:`: è ciò che vuole Anthropic, mentre
   * il lato openai-compat lo avvolge nel suo adattatore. Tenere la forma nuda
   * e avvolgere in un posto solo è meglio del contrario — spacchettare un data
   * URL vuol dire parsarlo, e un parser in più è un modo in più di sbagliare.
   */
  it('il blocco porta base64 nudo, non un data URL', () => {
    const r = loadImage(scrivi('x.png', PNG));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.block.data.startsWith('data:')).toBe(false);
    expect(Buffer.from(r.block.data, 'base64').equals(PNG)).toBe(true);
  });
});
