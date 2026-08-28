import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import type { AudioBlock, AudioMediaType } from './providers/types.js';

/**
 * Da byte su disco a blocco audio per il modello.
 *
 * Gemello di `agent/images.ts`, e per la stessa ragione: la parte che si
 * sbaglia è **il media type**, dedurlo dall'estensione vuol dire fidarsi del
 * nome che ha scelto qualcun altro, e su Telegram quel nome lo sceglie
 * letteralmente il mittente.
 *
 * Un blocco di questi serve a un ramo solo dei due che l'owner ha scelto il
 * 28/08/2026: quello in cui il modello accetta audio in ingresso e i byte
 * vanno a lui. Quando non lo accetta — cioè oggi, con `qwen/qwen3.8-27b` che
 * dichiara `text+image+video` — la nota vocale non diventa mai un blocco:
 * diventa testo, trascritto in casa (`core/audio/trascrivi.ts`).
 */

/**
 * Il tetto, sui byte **originali**.
 *
 * È lo stesso che il Bot API pubblico impone in scaricamento
 * (`connectors/telegram/media.ts`), quindi da Telegram non può arrivare nulla
 * di più grande: qui serve per le altre porte — un file passato dalla CLI non
 * ha nessuno che lo limiti a monte. Controllato con `statSync` prima di
 * leggere, come per le immagini: scoprire che erano troppi *dopo* averli
 * caricati costa quei megabyte in memoria.
 */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/**
 * I magic number dei quattro formati che sappiamo produrre.
 *
 * **Si guardano i byte, non l'estensione**, esattamente come per le immagini.
 * Una nota vocale di Telegram si chiama sempre `vocale.ogg` perché quel nome
 * lo scriviamo noi (`attachmentOf`), ma un file audio *inoltrato* porta il
 * nome del mittente, e un `.mp3` che dentro è un m4a farebbe fallire la
 * richiesta con un errore del provider che parla di codifica e non di nome.
 *
 * MP3 ha due incipit legittimi: un tag `ID3` davanti, oppure direttamente il
 * frame sync (`0xFF` seguito da un byte che comincia per `111`). M4A si
 * riconosce da `ftyp` a partire dal quinto byte, non dal primo — i primi
 * quattro sono la lunghezza del box.
 */
function sniff(bytes: Buffer): AudioMediaType | null {
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WAVE'
  ) {
    return 'audio/wav';
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  if (bytes.length >= 8 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  return null;
}

export type AudioLoad = { ok: true; block: AudioBlock } | { ok: false; why: string };

/**
 * Carica un audio dal disco, o dice **perché no**.
 *
 * Non lancia, per la stessa ragione di `loadImage`: ogni fallimento qui è una
 * cosa da raccontare all'owner o al modello, mai uno stack. Dire «ricevuto» di
 * qualcosa che non c'è è il fallimento che questo progetto continua a nominare.
 */
export function loadAudio(path: string): AudioLoad {
  let bytes: Buffer;
  try {
    const size = statSync(path).size;
    if (size > MAX_AUDIO_BYTES) {
      return {
        ok: false,
        why: `${(size / 1e6).toFixed(1)}MB, oltre il limite di ${String(MAX_AUDIO_BYTES / 1024 / 1024)}MB per audio`,
      };
    }
    bytes = readFileSync(path);
  } catch (error) {
    return { ok: false, why: `non leggibile: ${error instanceof Error ? error.message : String(error)}` };
  }
  const mediaType = sniff(bytes);
  if (mediaType === null) {
    return { ok: false, why: 'non è Ogg, WAV, MP3 o MP4/M4A — sono i soli formati audio che sappiamo nominare' };
  }
  return { ok: true, block: { type: 'audio', mediaType, data: bytes.toString('base64') } };
}

/**
 * Che audio è, guardando solo l'intestazione.
 *
 * Il ramo della trascrizione locale non ha nessun bisogno dei byte: li passa a
 * `whisper-cli` per **percorso**. Caricare venti megabyte in memoria per
 * leggerne quattro sarebbe pagare il prezzo del ramo che non stiamo prendendo.
 */
export function tipoAudio(path: string): AudioMediaType | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const testa = Buffer.alloc(12);
    const letti = readSync(fd, testa, 0, 12, 0);
    return sniff(testa.subarray(0, letti));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
