import { readFileSync, statSync } from 'node:fs';
import type { ImageBlock, ImageMediaType } from './providers/types.js';

/**
 * Da byte su disco a blocco immagine per il modello.
 *
 * Un modulo a parte e non due righe dentro `cli/run.ts`, perché i produttori
 * saranno almeno due — la CLI e il connettore Telegram, che salva già la foto
 * nel vault — e la parte che si sbaglia è sempre la stessa: **il media type**.
 * Dedurlo dall'estensione vuol dire fidarsi del nome che ha scelto qualcun
 * altro; su Telegram quel nome lo sceglie letteralmente il mittente.
 */

/**
 * Il tetto per una singola immagine, sui byte **originali**.
 *
 * Anthropic rifiuta oltre 10MB di base64, che sono circa 7.5MB di file; 5MB
 * lascia margine e resta sopra qualunque foto di telefono. Il tetto è sui byte
 * del file e non sul base64 perché è quello che si può controllare **prima** di
 * leggere: un `statSync` costa niente, caricare 40MB in memoria per poi
 * scoprire che erano troppi costa 40MB.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * I magic number dei quattro formati che entrambi i provider accettano.
 *
 * **Si guardano i byte, non l'estensione.** Un `.png` che dentro è un JPEG fa
 * fallire la richiesta con un errore del provider che parla di codifica e non
 * di nome del file — e chi legge quell'errore non ha nessun motivo di sospettare
 * l'estensione. Su Telegram è peggio che un caso di scuola: il nome del file
 * arriva dal mittente.
 *
 * WebP e GIF condividono il prefisso `RIFF`/`GIF8` con altre cose, quindi si
 * controlla anche il marcatore che viene dopo.
 */
function sniff(bytes: Buffer): ImageMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' || bytes.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export type ImageLoad = { ok: true; block: ImageBlock } | { ok: false; why: string };

/**
 * Carica un'immagine dal disco, o dice **perché no**.
 *
 * Non lancia: ogni fallimento qui è una cosa da raccontare all'owner o al
 * modello («questa foto non te la posso mostrare, ed ecco perché»), mai uno
 * stack. È la stessa postura di `ingest` nel connettore Telegram — dire
 * «ricevuto» di qualcosa che non c'è è il fallimento che questo progetto
 * continua a nominare.
 */
export function loadImage(path: string): ImageLoad {
  let bytes: Buffer;
  try {
    const size = statSync(path).size;
    if (size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        why: `${(size / 1e6).toFixed(1)}MB, oltre il limite di ${String(MAX_IMAGE_BYTES / 1024 / 1024)}MB per immagine`,
      };
    }
    bytes = readFileSync(path);
  } catch (error) {
    return { ok: false, why: `non leggibile: ${error instanceof Error ? error.message : String(error)}` };
  }
  const mediaType = sniff(bytes);
  if (mediaType === null) {
    return { ok: false, why: 'non è JPEG, PNG, GIF o WebP — sono i soli formati che i provider accettano' };
  }
  return { ok: true, block: { type: 'image', mediaType, data: bytes.toString('base64') } };
}
