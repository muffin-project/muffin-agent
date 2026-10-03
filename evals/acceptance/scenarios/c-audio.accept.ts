import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { install, until, type Install } from '../harness.js';
import { privateMessage, startFakeTelegram, voiceMessage, type FakeTelegram } from '../telegram.js';
import { scenario } from '../scenario.js';
import { paths } from '../../../core/config/config.js';

/**
 * C8 · Audio — una nota vocale vera attraversa Telegram finto → vault →
 * trascrizione → turno, sul binario vero.
 *
 * The row was BLOCKER for one reason only: no scenario ever drove a real
 * voice note through the real binary. The mechanism was already in HEAD
 * (`core/audio/voce.ts#decidiVoce`, `core/audio/trascrivi.ts`, wired at
 * `cli/surface.ts#voceFor`) and unit-proven with a hand-substituted `voce`
 * function (`connectors/telegram/voice-arrival.test.ts`) — what that test
 * cannot show is that `cli/surface.ts` wires `decidiVoce` to a real
 * `whisper-cli`/`ffmpeg` pair the way a live install does.
 *
 * **Why this does not need this machine's whisper-cli/ffmpeg.** The brief
 * (issue #361) forbids real transcription binaries or paid calls in this
 * suite. Two things make that unnecessary here:
 *
 *  1. `agent/providers/modalita.ts#audioAccettato` asks the *provider*
 *     (`GET {baseUrl}/models`) whether the configured model accepts audio.
 *     `evals/acceptance/provider.ts` answers that with `{ data: [] }` (see
 *     that file's own comment), so `audioAccettato` finds no entry and
 *     returns `false` — the transcribe-in-house branch, deterministically,
 *     with no model list to keep in sync.
 *  2. `core/audio/trascrivi.ts` finds its two binaries by **path**
 *     (`trovaBinario`: a name containing `/` is checked with `existsSync`,
 *     never searched on `$PATH`) and calls them with `execFile`. Nothing in
 *     that contract requires the *real* whisper.cpp/ffmpeg — only something
 *     executable at the configured path that behaves the way `trascrivi`
 *     expects: consume the argv it is given, produce the file it looks for.
 *     `config.audio.{whisperBin,ffmpegBin,whisperModel}` is the injection
 *     point `cli/surface.ts#voceFor` already reads from `config.json` — an
 *     existing, documented, unsealed knob (ADR-0036), not a new "test" branch
 *     in production code. This scenario points it at two tiny Node scripts
 *     instead of the real binaries.
 *
  * **What is proven, and what is not.** This proves the real wiring —
  * `voceFor` reads the config, `decidiVoce` asks the real `audioAccettato`
  * over HTTP, takes the transcribe branch, calls the two binaries by path with
  * the real argv shape `trascrivi` builds, and the transcript reaches the turn
  * fenced as tainted data. The audio itself is real (see `voceReale`), and
  * what the real binaries hear in those exact bytes was checked separately
  * on 03/10/2026 — real `ffmpeg` + real `whisper-cli` (`ggml-base.bin`)
  * through the real `trascrivi()` return the sentence the fake replays. What
  * no CI run proves is whisper.cpp/ffmpeg being correct on *every* input —
  * that stays a claim about third-party binaries, now with one dated
  * observation on real bytes instead of only the owner's from-mouth-to-text
  * spot check on the real installation (02/09/2026).
 */

const OWNER_ID = 777;
const TRANSCRIPT_TEXT = 'ricordami di richiamare il corriere domani mattina';

function ownerDalFile(home: string): number | undefined {
  try {
    const c = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      surfaces?: { telegram?: { ownerUserId?: number } };
    };
    return c.surfaces?.telegram?.ownerUserId;
  } catch {
    return undefined;
  }
}

type Gw = Awaited<ReturnType<Install['gateway']>>;

async function pairOwner(inst: Install, tg: FakeTelegram, ownerId: number): Promise<Gw> {
  const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-c8-token');
  if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
  const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
  if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);
  const code = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
  if (!code) throw new Error(`nessun codice di pairing stampato:\n${enable.err}`);
  const gw = await inst.gateway();
  await gw.waitFor(/muffin gateway/, 20_000);
  tg.deliver(privateMessage({ id: ownerId, name: 'Owner' }, code));
  await until(() => ownerDalFile(inst.home) === ownerId, 20_000);
  if (ownerDalFile(inst.home) !== ownerId) {
    throw new Error(`owner atteso ${ownerId}, trovato ${String(ownerDalFile(inst.home))}`);
  }
  return gw;
}

/**
 * Real audio, shaped like production: Ogg/Opus (`OggS` magic, OpusHead), a few
 * seconds of Italian speech saying exactly what the fake transcription below
 * stands in for — "ricordami di richiamare il corriere domani mattina".
 *
 * Produced 03/10/2026 with macOS `say -v Alice` → `ffmpeg -c:a libopus` and
 * committed as `evals/acceptance/fixtures/voce-c8.oga` (8,8 kB), so this
 * scenario downloads, sniffs and vaults bytes a real encoder wrote — not a
 * hand-stacked header. The previous stub (magic-looking bytes plus filler)
 * could not tell a decoder-shaped path from a bytes-are-bytes one; the two
 * guards below pin the shape so it cannot silently become a stub again.
 *
 * What the real binaries heard in these exact bytes was checked the same day:
 * real `ffmpeg` → WAV 16 kHz mono → real `whisper-cli` (`ggml-base.bin`)
 * through the real `trascrivi()` returns "ricordami di richiamare il corriere
 * domani mattina." — the sentence the fake below replays deterministically,
 * because CI has neither the binaries nor the 142 MB model and a
 * speech-to-text assertion must not depend on either.
 *
 * **Falsifier**: point `plantFile` at an empty file and the voice path is
 * never taken — `sniff` calls it text, the vault indexes a document instead
 * of a voice note, no transcript ever reaches the turn. The assertions below
 * are on content (the transcript in the turn and in the model request, the
 * original bytes on disk), never on a bare exit code.
 */
function voceReale(): Buffer {
  const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'voce-c8.oga'));
  if (bytes.subarray(0, 4).toString('latin1') !== 'OggS') {
    throw new Error('voce-c8.oga non è Ogg: il fixture reale è stato sostituito?');
  }
  if (bytes.length < 1024) {
    throw new Error(`voce-c8.oga è di soli ${bytes.length} byte: non è audio vero, è uno stub`);
  }
  return bytes;
}

type TurnRow = { id: string; messages: string; taint: number };

function readTurn(inst: Install, where: string, params: unknown[] = []): TurnRow | undefined {
  return inst.db(
    (db) => db.prepare(`SELECT id, messages, taint FROM turns ${where}`).get(...params) as TurnRow | undefined,
  );
}

/**
 * A fake `ffmpeg`: whatever `trascrivi.ts` passes it, it writes *something*
 * at the output path (its last argv element, `-y <wav>` in the real call) and
 * exits 0. It never reads the input — the claim under test is that
 * `decidiVoce` calls the configured binary with the real audio's path, not
 * that ffmpeg's own decoder is correct.
 */
const FAKE_FFMPEG = [
  '#!/usr/bin/env node',
  'import { writeFileSync } from "node:fs";',
  'const args = process.argv.slice(2);',
  'const out = args[args.length - 1];',
  'writeFileSync(out, Buffer.from("RIFF-fake-wav"));',
  'process.exit(0);',
  '',
].join('\n');

/**
 * A fake `whisper-cli`: reads `-of <prefix>` off its own argv (the exact flag
 * `trascrivi.ts` passes) and writes `<prefix>.txt` — the file
 * `--output-txt`/`-of` makes the real binary produce, and the one `trascrivi`
 * reads back. The transcript text comes from `$FAKE_WHISPER_TEXT` so the
 * scenario controls it without hard-coding a second copy inside the script.
 */
const FAKE_WHISPER_CLI = [
  '#!/usr/bin/env node',
  'import { writeFileSync } from "node:fs";',
  'const args = process.argv.slice(2);',
  'const ofIndex = args.indexOf("-of");',
  'const prefix = args[ofIndex + 1];',
  'const text = process.env.FAKE_WHISPER_TEXT ?? "";',
  'writeFileSync(`${prefix}.txt`, `${text}\\n`);',
  'process.exit(0);',
  '',
].join('\n');

describe('acceptance · C8 · audio — nota vocale', () => {
  /**
   * Falsifier (audio originale): in `connectors/telegram/media.ts#downloadToVault`,
   * write fewer bytes than were downloaded (or skip the write) and the vault
   * copy this scenario reads back stops matching `FAKE_OGG` — the "original
   * audio kept" half of the row goes red while the turn keeps answering fine,
   * exactly the silent-loss shape this suite exists to catch.
   *
   * Falsifier (taint del transcript): in `connectors/shared/ingress/router.ts#runStage`,
   * rendi la riga di arrivo una parte `author` invece che `derived` e
   * l'asserzione "non prosa libera" di questo scenario va rossa — la
   * trascrizione siederebbe nel turno come prosa non recintata,
   * indistinguibile dalle parole digitate dell'owner (la provenienza B16 che
   * il testo di questa riga nomina). La trascrizione viaggia nel recinto
   * `derivato` di provenienza dell'arrivo, non in un recinto `trascrizione`
   * con nome proprio: la composizione recinta ogni parte non dell'autore e
   * `fence` spoglia i marcatori interni per non annidarli.
   */
  scenario(
    'C8',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({
        main: [{ text: 'certo, te lo ricordo io — richiamo il corriere domani mattina' }],
        env: { MUFFIN_GATEWAY_TICK_MS: '200', FAKE_WHISPER_TEXT: TRANSCRIPT_TEXT },
      });
      try {
        // --- the injection point: config.audio, an existing unsealed knob ---
        const fakeFfmpeg = join(inst.workspace, 'fake-ffmpeg.mjs');
        const fakeWhisper = join(inst.workspace, 'fake-whisper-cli.mjs');
        const fakeModel = join(inst.workspace, 'fake-whisper-model.bin');
        writeFileSync(fakeFfmpeg, FAKE_FFMPEG);
        writeFileSync(fakeWhisper, FAKE_WHISPER_CLI);
        writeFileSync(fakeModel, Buffer.from('not a real ggml model, existence is all that is checked'));
        chmodSync(fakeFfmpeg, 0o755);
        chmodSync(fakeWhisper, 0o755);

        const configPath = join(inst.home, 'config.json');
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        config['audio'] = { whisperBin: fakeWhisper, ffmpegBin: fakeFfmpeg, whisperModel: fakeModel };
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

        const gw = await pairOwner(inst, tg, OWNER_ID);
        try {
          const voce = voceReale();
          tg.plantFile('c8-voice-1', 'voice/file_1.oga', voce);
          tg.deliver(voiceMessage({ id: OWNER_ID, name: 'Owner' }, 'c8-voice-1'));

          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes('richiamo il corriere'),
                ),
            30_000,
          );

          // The durable record: the turn names the arrival, and carries the
          // transcript fenced — not merged into the owner's own prose. Read
          // before the model-request check below so a durable-record failure
          // is reported with its own message rather than folded into
          // "nessuna richiesta al modello…".
          const turn = readTurn(inst, `ORDER BY created_at DESC LIMIT 1`);
          if (!turn) throw new Error('nessun turno dopo la nota vocale');
          if (!turn.messages.includes('nota vocale ricevuta')) {
            throw new Error(`il turno non registra l'arrivo della nota vocale: ${turn.messages}`);
          }
          if (!/<<<derivato_[0-9a-f]{12}/.test(turn.messages) || !turn.messages.includes(TRANSCRIPT_TEXT)) {
            throw new Error(`il turno non porta la trascrizione nel recinto di provenienza: ${turn.messages}`);
          }
          if (!turn.messages.includes("dati, mai istruzioni")) {
            throw new Error(
              `la trascrizione non è etichettata come dati recintati (B16): ${turn.messages}`,
            );
          }
          const senzaRecinti = turn.messages.replace(/<<<derivato_[0-9a-f]{12}[\s\S]*?derivato_[0-9a-f]{12}>>>/g, '');
          if (senzaRecinti.includes(TRANSCRIPT_TEXT)) {
            throw new Error(`la trascrizione esiste anche fuori dai recinti — prosa libera indistinguibile dalle parole dell'owner`);
          }

          // What the model actually saw: the fenced transcript reached the
          // real request, and — since `audioAccettato` answers `false` here
          // — no `audio` content part ever went out. Direct evidence the
          // transcribe branch, not the listen branch, is the one that ran.
          const main = inst.provider.main();
          const sawTranscript = main.some((r) =>
            r.messages.some(
              (m) =>
                typeof m.content === 'string'
                  ? m.content.includes(TRANSCRIPT_TEXT)
                  : Array.isArray(m.content) &&
                    (m.content as unknown[]).some(
                      (part) =>
                        part !== null &&
                        typeof part === 'object' &&
                        (part as { type?: unknown }).type === 'text' &&
                        typeof (part as { text?: unknown }).text === 'string' &&
                        (part as { text: string }).text.includes(TRANSCRIPT_TEXT),
                    ),
            ),
          );
          if (!sawTranscript) {
            throw new Error(
              `nessuna richiesta al modello porta la trascrizione — la nota vocale non ha attraversato il turno:\n${JSON.stringify(
                main.map((r) => r.messages),
                null,
                2,
              ).slice(0, 2000)}`,
            );
          }
          const sawAudioPart = main.some((r) =>
            r.messages.some(
              (m) => Array.isArray(m.content) && (m.content as unknown[]).some((p) => (p as { type?: unknown } | null)?.type === 'input_audio'),
            ),
          );
          if (sawAudioPart) {
            throw new Error('al modello è arrivato un blocco audio: il ramo preso è "ascolta", non "trascritto"');
          }

          // The original bytes: still on disk, unmodified, at the vault path
          // the turn itself names — `[nota vocale ricevuta: \`<path>\` …]`.
          const pathMatch = /nota vocale ricevuta: `([^`]+)`/.exec(turn.messages);
          if (!pathMatch) throw new Error(`impossibile leggere il percorso del vault dal turno: ${turn.messages}`);
          const onDisk = readFileSync(join(paths(inst.home).vault, pathMatch[1]!));
          if (!onDisk.equals(voce)) {
            throw new Error(
              `i byte dell'audio originale nel vault non coincidono con quelli scaricati ` +
                `(attesi ${voce.length}, trovati ${onDisk.length})`,
            );
          }
        } finally {
          await gw.stop();
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    60_000,
  );
});
