import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { RIMEDIO_FFMPEG } from '../audio/trascrivi.js';

const esegui = promisify(execFile);

/**
 * Il primo fotogramma di un video breve (sticker `.webm`, note video), come
 * PNG. Stessa postura di `trascrivi`: non lancia mai, ogni fallimento è una
 * cosa da raccontare. Stesso binario, stessi rimedi — un secondo nome per
 * `ffmpeg` divergerebbe alla prima installazione che ne ha uno solo.
 */

export type Fotogramma = { ok: true } | { ok: false; why: string; rimedio?: string };

export type FotogrammaDeps = {
  /** Default: `ffmpeg`, cercato nel PATH — stessa regola di `trascrivi`. */
  ffmpegBin?: string;
  /** Un fotogramma è veloce; il tetto serve solo contro un processo appeso. */
  timeoutMs?: number;
  /** Solo per i test. */
  run?: (bin: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export async function estraiFotogramma(ingresso: string, uscita: string, deps: FotogrammaDeps = {}): Promise<Fotogramma> {
  const ffmpegBin = deps.ffmpegBin ?? 'ffmpeg';
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run =
    deps.run ??
    (async (bin, args, ms) => {
      const { stdout } = await esegui(bin, args, { timeout: ms, maxBuffer: 32 * 1024 * 1024 });
      return { stdout: String(stdout) };
    });
  try {
    await run(ffmpegBin, ['-nostdin', '-loglevel', 'error', '-i', ingresso, '-vframes', '1', '-q:v', '2', '-y', uscita], timeoutMs);
  } catch (error) {
    const codice = (error as { code?: unknown } | null)?.code;
    if (codice === 'ENOENT') {
      return { ok: false, why: `ffmpeg non è installato (${ffmpegBin} non è nel PATH)`, rimedio: RIMEDIO_FFMPEG };
    }
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, why: `ffmpeg ha fallito: ${why}` };
  }
  if (!existsSync(uscita)) return { ok: false, why: 'ffmpeg non ha scritto il fotogramma' };
  return { ok: true };
}
