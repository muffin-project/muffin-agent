import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const esegui = promisify(execFile);

/**
 * La voce dell'owner, trascritta **in casa**.
 *
 * È metà di una decisione che l'owner ha preso il 28/08/2026: «se il modello
 * supporta audio lo mandiamo al modello direttamente, altrimenti usiamo
 * whisper.cpp». L'altra metà è `agent/providers/modalita.ts`, che decide quale
 * dei due rami prendere chiedendolo al provider invece di indovinarlo.
 *
 * Oggi questo è il ramo che gira: `qwen/qwen3.8-27b` dichiara
 * `["text","image","video"]` — misurato sull'elenco modelli di OpenRouter
 * quello stesso giorno — quindi la voce non esce di casa, e il ramo diretto si
 * accende da solo il giorno in cui il modello cambia.
 *
 * **Due binari, e nessuno dei due lo installiamo noi.** `whisper-cli` legge
 * solo WAV a 16 bit (README di whisper.cpp, letto il 28/08/2026), mentre una
 * nota vocale di Telegram è Ogg/Opus: serve `ffmpeg` in mezzo. Quando manca
 * qualcosa questa funzione **lo dice, con il comando che lo ripara**, come fa
 * `muffin surface enable telegram` quando manca il token. Scaricare 142 MiB di
 * modello sulla macchina di qualcuno senza chiederglielo non è un default, è
 * una decisione presa al posto suo.
 *
 * **Perché è sicuro far girare due processi qui.** Il sandbox
 * (`core/sandbox/`) esiste per i processi che decide il *modello*; questi due
 * li decide Muffin. Gli argomenti sono nostri — il percorso viene dal vault,
 * che i nomi non li pulisce ma li **ricostruisce** da un alfabeto sicuro
 * (`connectors/telegram/media.ts`) — si passa un array e mai una shell, e i
 * byte dell'audio non diventano mai un argomento: viaggiano su disco.
 */

export type Trascrizione =
  | { ok: true; testo: string }
  /**
   * Un comando **vero** da mostrare all'owner, quando ce n'è uno.
   *
   * Verificato prima di scriverlo, il 28/08/2026: la formula Homebrew
   * `whisper-cpp` (1.9.2) installa proprio `whisper-cli` — lo chiama così il
   * suo stesso test — e i suoi caveats dicono che i modelli non li scarica
   * nessuno per te. L'URL del modello risponde 200. Nominare un comando che
   * non esiste è il difetto riparato in #223 e #224: non se ne aggiunge un
   * terzo.
   */
  | { ok: false; why: string; rimedio?: string };

export type TrascriviDeps = {
  /** Il binario di whisper.cpp. Default: `whisper-cli`, cercato nel PATH. */
  whisperBin?: string;
  /** Il modello ggml. Nessun default sensato: senza, non si trascrive. */
  whisperModel?: string | undefined;
  /** Il convertitore. Default: `ffmpeg`, cercato nel PATH. */
  ffmpegBin?: string;
  /**
   * Il tetto di tempo, per processo.
   *
   * Un modello grande su una VPS piccola è lento — `small` fa circa 0,4-0,6×
   * il tempo reale su un Raspberry Pi 5, misura pubblicata da chi lo confronta
   * — quindi il tetto è per **processo** e non per nota vocale, ed è alto: una
   * nota di dieci minuti su una macchina lenta è lecita, un processo appeso no.
   */
  timeoutMs?: number;
  /** Solo per i test. */
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 142 MiB, e li scarica l'owner.
 *
 * `base` e non `small` (466 MiB) né `tiny`: è il compromesso che la
 * documentazione di whisper.cpp descrive come utile davvero, e su un M2 Pro fa
 * 60 secondi di audio in circa 2,8 — misura pubblicata da chi lo confronta,
 * non nostra. Chi vuole `small` cambia una riga di config; chi non vuole
 * scaricare niente non trascrive, e Muffin glielo dice invece di provarci.
 */
export const MODELLO_MANCANTE = [
  'curl -L --create-dirs -o ~/.muffin/models/ggml-base.bin \\',
  '  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
].join('\n');

/**
 * Un rimedio solo per ciascun pezzo, letto da due posti: da `trascrivi`, quando
 * la nota vocale è già arrivata, e da `muffin doctor`, prima che arrivi. Se
 * fossero due stringhe, un giorno direbbero due cose diverse — e quella di
 * `doctor` sarebbe quella non provata.
 */
export const RIMEDIO_FFMPEG = 'brew install ffmpeg   # su Linux: apt install ffmpeg';
export const RIMEDIO_WHISPER = 'brew install whisper-cpp   # su Linux: github.com/ggml-org/whisper.cpp';

/** La frase di `manca()` per un `ENOENT`, e la stessa che `doctor` stampa in anticipo. */
function nonInstallato(nome: string, bin: string): string {
  return `${nome} non è installato (${bin} non è nel PATH)`;
}

/**
 * Un binario, cercato come lo cercherà `execFile`: per nome lungo il PATH, o
 * al suo percorso se ne ha uno. Una passeggiata sul PATH e non `which` — lo
 * stesso motivo di `cli/gateway.ts`: `which` non è garantito su un'immagine
 * minima, ed `existsSync` risponde alla stessa domanda senza un processo.
 */
function trovaBinario(bin: string, path: string): string | null {
  if (bin.includes('/')) return existsSync(bin) ? bin : null;
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidato = join(dir, bin);
    if (existsSync(candidato)) return candidato;
  }
  return null;
}

export type Prerequisito =
  | { cosa: 'ffmpeg' | 'whisper.cpp' | 'modello whisper'; ok: true; dove: string }
  | { cosa: 'ffmpeg' | 'whisper.cpp' | 'modello whisper'; ok: false; why: string; rimedio: string };

/**
 * Ciò che `trascrivi` troverebbe mancante, detto **prima** che una nota vocale
 * arrivi.
 *
 * Misurato il 02/09/2026 sull'installazione dell'owner: il modello non
 * accetta audio, `whisper-cli` e `ffmpeg` non c'erano, il modello ggml
 * nemmeno, e `muffin doctor` era tutto verde — il primo a saperlo sarebbe
 * stato l'owner, dalla prima nota vocale non capita. Stessi default, stessi
 * nomi e stessi rimedi di `trascrivi`, per costruzione: questa funzione non
 * ha una lista sua.
 *
 * Non esegue niente. Un binario che c'è ma non parte lo scopre `trascrivi`,
 * e lo dice con l'errore del comando — qui si risponde alla domanda che si
 * può rispondere senza un processo.
 */
export function prerequisitiTrascrizione(
  deps: Pick<TrascriviDeps, 'whisperBin' | 'whisperModel' | 'ffmpegBin'>,
  path: string = process.env['PATH'] ?? '',
): Prerequisito[] {
  const ffmpegBin = deps.ffmpegBin ?? 'ffmpeg';
  const whisperBin = deps.whisperBin ?? 'whisper-cli';
  const ffmpeg = trovaBinario(ffmpegBin, path);
  const whisper = trovaBinario(whisperBin, path);
  const modello = deps.whisperModel;
  return [
    ffmpeg === null
      ? { cosa: 'ffmpeg', ok: false, why: nonInstallato('ffmpeg', ffmpegBin), rimedio: RIMEDIO_FFMPEG }
      : { cosa: 'ffmpeg', ok: true, dove: ffmpeg },
    whisper === null
      ? { cosa: 'whisper.cpp', ok: false, why: nonInstallato('whisper.cpp', whisperBin), rimedio: RIMEDIO_WHISPER }
      : { cosa: 'whisper.cpp', ok: true, dove: whisper },
    modello === undefined || modello === ''
      ? { cosa: 'modello whisper', ok: false, why: 'nessun modello whisper configurato', rimedio: MODELLO_MANCANTE }
      : existsSync(modello)
        ? { cosa: 'modello whisper', ok: true, dove: modello }
        : { cosa: 'modello whisper', ok: false, why: `il modello whisper configurato non c'è: ${modello}`, rimedio: MODELLO_MANCANTE },
  ];
}

/**
 * Trascrive un file audio, o dice **perché no**.
 *
 * Non lancia: stessa postura di `loadImage`/`loadAudio`. Ogni fallimento qui è
 * una cosa da raccontare all'owner («questa nota vocale non l'ho capita, ed
 * ecco perché»), mai uno stack — e mai un silenzio, che sarebbe l'unico esito
 * davvero inaccettabile: una nota vocale ricevuta e non trascritta di cui
 * nessuno dice niente è un pezzo di conversazione perso senza traccia.
 */
export async function trascrivi(percorsoAudio: string, deps: TrascriviDeps = {}): Promise<Trascrizione> {
  const whisperBin = deps.whisperBin ?? 'whisper-cli';
  const ffmpegBin = deps.ffmpegBin ?? 'ffmpeg';
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run =
    deps.run ??
    (async (bin, args, ms) => {
      const { stdout } = await esegui(bin, args, { timeout: ms, maxBuffer: 32 * 1024 * 1024 });
      return { stdout: String(stdout) };
    });

  if (deps.whisperModel === undefined || deps.whisperModel === '') {
    return {
      ok: false,
      why: 'nessun modello whisper configurato: non so trascrivere in casa, e il modello a cui parlo non accetta audio',
      rimedio: MODELLO_MANCANTE,
    };
  }
  if (!existsSync(deps.whisperModel)) {
    return {
      ok: false,
      why: `il modello whisper configurato non c'è: ${deps.whisperModel}`,
      rimedio: MODELLO_MANCANTE,
    };
  }

  // Una cartella per chiamata, cancellata comunque vada. Il WAV convertito è
  // la voce dell'owner in chiaro e non deve restare in giro: `finally` la
  // toglie anche quando whisper fallisce, che è proprio il caso in cui
  // qualcuno sarebbe tentato di lasciarla lì «per guardarci».
  const lavoro = mkdtempSync(join(tmpdir(), 'muffin-audio-'));
  const wav = join(lavoro, 'audio.wav');
  try {
    try {
      // 16 kHz, mono, PCM 16 bit: è la forma che `whisper-cli` sa leggere, ed è
      // scritta così nel README di whisper.cpp.
      await run(ffmpegBin, ['-nostdin', '-loglevel', 'error', '-i', percorsoAudio, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wav], timeoutMs);
    } catch (error) {
      return manca(ffmpegBin, error, 'ffmpeg', RIMEDIO_FFMPEG);
    }

    let stdout: string;
    try {
      // `-nt`: niente marcatori temporali, che qui sarebbero rumore dentro una
      // frase. `-l auto`: la lingua la riconosce lui — l'owner parla italiano,
      // ma inchiodarla vorrebbe dire trascrivere male ogni nota in un'altra.
      const res = await run(
        whisperBin,
        ['-m', deps.whisperModel, '-f', wav, '-nt', '-l', 'auto', '--output-txt', '-of', join(lavoro, 'out')],
        timeoutMs,
      );
      stdout = res.stdout;
    } catch (error) {
      return manca(whisperBin, error, 'whisper.cpp', RIMEDIO_WHISPER);
    }

    // Il file, quando c'è: `--output-txt` scrive la trascrizione pulita, mentre
    // stdout porta anche le righe di avanzamento. Si legge il file e si ricade
    // su stdout solo se non è stato scritto.
    const file = `${join(lavoro, 'out')}.txt`;
    const testo = (existsSync(file) ? readFileSync(file, 'utf8') : stdout).trim();
    if (testo === '') return { ok: false, why: 'whisper non ha prodotto testo: forse la nota è silenziosa' };
    return { ok: true, testo };
  } finally {
    rmSync(lavoro, { recursive: true, force: true });
  }
}

/**
 * Un binario che non c'è dice una cosa sola e la dice bene; qualunque altro
 * fallimento resta quello che era.
 *
 * `ENOENT` da `execFile` significa «quel comando non esiste», e confonderlo con
 * un errore del comando stesso manderebbe l'owner a cercare un guasto in
 * whisper invece che a installarlo.
 */
function manca(bin: string, error: unknown, nome: string, rimedio: string): Trascrizione {
  const codice = (error as { code?: unknown } | null)?.code;
  if (codice === 'ENOENT') {
    return { ok: false, why: nonInstallato(nome, bin), rimedio };
  }
  const why = error instanceof Error ? error.message : String(error);
  return { ok: false, why: `${nome} ha fallito: ${why}` };
}
