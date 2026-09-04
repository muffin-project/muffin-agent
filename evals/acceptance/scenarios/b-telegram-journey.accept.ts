import DatabaseCtor from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { install, until, type Install } from '../harness.js';
import { callbackQuery, privateMessage, startFakeTelegram, type FakeTelegram } from '../telegram.js';
import { scenario } from '../scenario.js';
import { MemoryStore } from '../../../core/memory/store.js';
import { paths } from '../../../core/config/config.js';

/**
 * B/D · Four DAY-1 rows, all BLOCKER for the same reason: the mechanism is in
 * HEAD, and nobody had driven it over the real Telegram surface.
 *
 * `requirements-status.md` names B1, B13, B14 and D12 as blocked purely on a
 * missing acceptance scenario — each row's own text cites the file and line
 * where the mechanism already lives. This file is that missing proof, against
 * `evals/acceptance/telegram.ts`'s fake Bot API server and a real `muffin
 * gateway`, the same seam `b-telegram-pairing.accept.ts` and
 * `e2e-giro-owner.accept.ts` already use.
 *
 * ## Why B1 is not registered through `scenario()`
 *
 * B1 already has a `verde` manifest entry, proven by `b-continuity.accept.ts`
 * — the CLI half of "CLI and Telegram share session and memory", by that
 * file's own admission ("no real Telegram bot is reachable from here"). A
 * second `scenario('B1', …)` call would register a **second** `it()` whose
 * title is the *same* manifest string (`scenario()` always uses
 * `entry(row).title` verbatim) — and `report.ts#verdictFor` treats two
 * vitest results ending in the same manifest title as `rosso-inatteso`
 * ("titolo ambiguo… un verdetto scelto fra questi sarebbe un lancio di
 * moneta"), which would break the CLI scenario's own reporting for no
 * reason. So the Telegram half below is a plain, unmanifested `describe`/
 * `it()` — the same shape `b-telegram-pairing.accept.ts` already uses for
 * B16's pairing proof: it runs, it must stay green, and `report.ts` counts
 * it as "fuori inventario" rather than against a specific row. B13/B14/D12
 * had no manifest entry at all before this slice, so those three *do* go
 * through `scenario()`, with fresh `verde()` entries in `manifest.ts`.
 *
 * ## Two extensions this file leans on
 *
 *  - `evals/acceptance/telegram.ts` gained a `multipart/form-data` reader
 *    (`sendDocument`, B14 needs the real filename and byte count, which a
 *    naive `JSON.parse` on a multipart body silently turns into `{}`), a
 *    `callbackQuery()` update builder (D12's button presses), and a recorded
 *    `messageId` for every message this server creates (needed to tell "the
 *    status line was edited" apart from "a new message was sent", and to
 *    address a callback press at the right bubble).
 *  - `evals/acceptance/provider.ts` gained `ScriptedReply.delayMs` — a named,
 *    minimal test seam (see its own comment) so a scripted round can take
 *    real wall-clock time without a fake clock inside `progress.ts` itself.
 *    B13 is the only scenario that uses it: `progress.ts`'s own throttle
 *    (`MIN_EDIT_MS` = 3s) never reopens if every round trip here answers in
 *    under a millisecond, and without a real gap the *edit* half of "one
 *    message, throttled, edited" would never fire.
 */

const OWNER_ID = 999;
const IMPOSTOR_ID = 555;

/** The Telegram-visible owner id `config.json` records once pairing lands. */
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

/**
 * The pairing half every scenario below needs, factored out because none of
 * the four rows is *about* pairing (`b-telegram-pairing.accept.ts` already
 * proves that). Sends the right code straight away — a matched pairing code
 * is answered directly by the connector (`connector.ts#tryPair`) and never
 * calls the model, so it does not consume anything off a scenario's own
 * `main` script, unlike a stranger's ordinary text would.
 */
async function pairOwner(inst: Install, tg: FakeTelegram, ownerId: number): Promise<Gw> {
  const tok = await inst.muffin(['secret', 'set', 'telegram_token'], '123456:fake-journey-token');
  if (tok.code !== 0) throw new Error(`secret set telegram_token: exit ${tok.code}\n${tok.err}`);
  const enable = await inst.muffin(['surface', 'enable', 'telegram', '--api-base', tg.url]);
  if (enable.code !== 0) throw new Error(`surface enable telegram: exit ${enable.code}\n${enable.err}`);
  const code = /\n\s{6}([A-Z0-9-]{4,})\n/.exec(enable.err)?.[1];
  if (!code) throw new Error(`nessun codice di pairing stampato:\n${enable.err}`);

  // The gateway reads config exactly once, at boot (`buildRuntime`) — it must
  // start **after** `secret set`/`surface enable` have already landed on disk,
  // or it boots with `surfaces.enabled` not yet naming `telegram` at all and
  // never connects the connector, silently (`cli/surface.ts#connectSurfaces`
  // only pushes a boot line — "telegram: connessa…" — inside the `if
  // (enabled.includes('telegram'))` branch; nothing else on this path throws).
  const gw = await inst.gateway();
  await gw.waitFor(/muffin gateway/, 20_000);
  tg.deliver(privateMessage({ id: ownerId, name: 'Owner' }, code));
  await until(() => ownerDalFile(inst.home) === ownerId, 20_000);
  if (ownerDalFile(inst.home) !== ownerId) {
    throw new Error(`owner atteso ${ownerId}, trovato ${String(ownerDalFile(inst.home))}`);
  }
  return gw;
}

/** Same shape as `d-capability.accept.ts`'s `plantTier3Episode`, at tier 2 — D12 needs an ask whose taint is shown but not exceeded (`sys.shell`'s `maxTaint: 2`). */
function plantTier2Episode(home: string, threadKey: string): void {
  const db = new DatabaseCtor(join(home, 'muffin.db'));
  try {
    new MemoryStore(db).addEpisode({
      tenantId: 'host',
      connector: 'cli',
      threadKey,
      role: 'user',
      kind: 'message',
      content: 'nota interna: promemoria di gruppo su una faccenda qualsiasi',
      trustTier: 2,
      createdAt: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
}

describe('acceptance · B1 telegram · un fatto detto su Telegram torna a un `run` usa e getta per memoria, non per sessione', () => {
  /**
   * **Aggiornato da ADR-0056 (03/09).** Questo scenario asseriva
   * `session_id === 'telegram:<chatId>'` anche per la DM dell'owner, e quella
   * frase è ora falsa: la chiave la decide `identify`, e per il principal owner
   * è `owner` su ogni porta — è il fix del failure «non sembra lo stesso
   * muffin» (`b-una-conversazione.accept.ts` lo prova). La claim che questo file
   * porta **non cambia**: un processo che apre una sessione *diversa* non vede
   * il trascritto dell'altra, e ciò che attraversa quel confine è la memoria
   * scopata sul tenant, mai la sessione.
   *
   * Cambia solo quale porta incarna quel confine. Non più «Telegram contro la
   * CLI» (che oggi condividono la conversazione dell'owner, di proposito) ma
   * `muffin run` **senza `--session`**, che tiene un id per invocazione perché
   * «a script run in a loop should not silently accumulate a conversation»
   * (`cli/run.ts`) — l'unica porta che ADR-0056 lascia deliberatamente fuori
   * dalla conversazione dell'owner.
   *
   * Falsifier: comment out `session: this.deps.sessions.open(…)` in
   * `connector.ts` (or point it at a constant id) and the `session_id`
   * assertion below breaks immediately. Comment out the tenant-scoped recall in
   * `core/memory/recall.ts` and the *second* half breaks instead: the `run`
   * process would ask about the fact and get nothing back, because nothing but
   * memory carries it across this boundary.
   */
  it(
    'la sessione della DM dell owner è "owner"; un `muffin run` usa e getta non la vede, ma la memoria del tenant sì',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({
        main: [
          { text: 'certo, il tuo animale preferito da oggi è il tasso' },
          { text: 'sì, il tasso, me lo avevi detto tu su Telegram' },
        ],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        const gw = await pairOwner(inst, tg, OWNER_ID);
        try {
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'il mio animale preferito è il tasso'));
          await until(() => tg.messages().some((m) => m.text.includes('tasso')), 20_000);

          // The construction claim, checked directly rather than inferred:
          // `connectors/telegram/connector.ts` opens the session with the key
          // `identify` computed, which for the owner's DM is exactly `owner`
          // — never a literal written in the connector (ADR-0056).
          const turnRow = inst.db(
            (db) =>
              db.prepare(`SELECT session_id, tenant, surface FROM turns ORDER BY created_at DESC LIMIT 1`).get() as
                | { session_id: string; tenant: string; surface: string }
                | undefined,
          );
          if (!turnRow) throw new Error('nessun turno dopo il messaggio Telegram');
          if (turnRow.session_id !== 'owner') {
            throw new Error(`session_id atteso "owner", trovato ${JSON.stringify(turnRow.session_id)}`);
          }
          if (turnRow.tenant !== 'host' || turnRow.surface !== 'telegram') {
            throw new Error(`tenant/surface inattesi sul turno Telegram: ${JSON.stringify(turnRow)}`);
          }
        } finally {
          await gw.stop();
        }

        // A second, unrelated CLI process — its own fresh session id
        // (`cli/run.ts`'s default, `run-<data>-<hex>`, never the owner's
        // shared conversation), nothing shared with the Telegram chat but this
        // tenant's memory. Dopo ADR-0056 è **questa** la porta che isola, ed è
        // isolata di proposito: `--session owner` sarebbe la scelta esplicita
        // di entrare nella conversazione.
        const second = await inst.muffin(['run', '--timeout', '20', 'qual è il mio animale preferito?']);
        if (second.code !== 0) throw new Error(`secondo processo CLI: exit ${second.code}\n${second.err}`);
        const sent = inst.provider.main().at(-1);
        if (!sent) throw new Error('il secondo processo CLI non ha mai chiamato il modello');

        // Sessions are distinct by construction: no literal `role: 'assistant'`
        // turn from the Telegram exchange appears in this `run` process's own
        // wire messages — the same shape `b-continuity.accept.ts`'s B1 checks
        // for the CLI-only case, checked here for its absence instead.
        const literalTelegramTurn = sent.messages.find(
          (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('tasso'),
        );
        if (literalTelegramTurn) {
          throw new Error(
            `un \`muffin run\` senza \`--session\` ha visto la trascrizione letterale della conversazione ` +
              `dell'owner: la sessione usa e getta di \`cli/run.ts\` non isola più niente:\n${JSON.stringify(sent.messages, null, 2)}`,
          );
        }
        // And yet the fact crossed the boundary — through tenant-scoped
        // memory, never through the session.
        if (!sent.transcript.includes('tasso')) {
          throw new Error(`il fatto detto su Telegram non è arrivato al secondo processo CLI via memoria:\n${sent.transcript}`);
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    60_000,
  );
});

describe('acceptance · B13 · la trascrizione del turno su Telegram', () => {
  /**
   * Since 03/09/2026 the steps live in one message per segment, never
   * deleted (`docs/evidence/dogfood-superfici-2026-09-03.md` §5.1). Since
   * 04/09/2026 (`docs/evidence/turno-sospendibile.md`) the real answer joins
   * that **same** message instead of arriving as a second `sendMessage`
   * beside it — the two-bubble defect measured on the owner's own chat: a
   * stray message id sitting between the question and the answer on every
   * turn that used a tool.
   *
   * Falsifier: delete the `seg.messageId === null` branch in
   * `transcript.ts#sendSegment` (always call `sendMessage`) and the "exactly
   * one create" assertion below breaks. Delete the `await transcript.stop()`
   * in `connector.ts` and the "no live counter left" assertion breaks. Put a
   * `deleteMessage` back into `stop()` and the "never deleted" one does.
   * Drop the `handoff` branch of `deliverTo`'s plan in `connector.ts` and the
   * "exactly one sendMessage total" / "the answer is the transcript's own
   * last edit" assertions below break — the answer goes back to being a
   * second, separate `sendMessage`.
   */
  scenario(
    'B13',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({
        main: [
          { tool: { name: 'memory_search', args: { query: 'appunti di ieri' } } },
          // Delayed on purpose — see this file's own docstring on
          // `ScriptedReply.delayMs`: without a real gap, every `TurnEvent`
          // here fires inside the *first* MIN_EDIT_MS window and coalesces
          // into one send, and the edit this scenario exists to prove would
          // never happen.
          { tool: { name: 'memory_search', args: { query: 'appunti di oggi' } }, delayMs: 3_500 },
          { text: 'fatto, ecco il resoconto: niente di nuovo da ieri a oggi', delayMs: 3_500 },
        ],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        const gw = await pairOwner(inst, tg, OWNER_ID);
        try {
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'fammi un resoconto dei miei appunti'));
          // The answer now lands as an edit, not a fresh `sendMessage` —
          // `tg.messages()` only ever sees genuinely new messages
          // (`evals/acceptance/telegram.ts`'s own contract), so this scenario
          // waits on `tg.sent()` directly instead.
          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes('niente di nuovo da ieri a oggi'),
                ),
            30_000,
          );

          // A transcript message carries the steps in the owner's own words
          // (`agent/tool-phrase.ts`) — distinct from the pairing confirmation.
          const sent = tg.sent();
          const creates = sent.filter(
            (c) => c.method === 'sendMessage' && String(c.payload['text'] ?? '').includes('cerco in memoria'),
          );
          if (creates.length !== 1) {
            throw new Error(
              `atteso esattamente 1 sendMessage di trascrizione (due tool senza parole in mezzo = un segmento), trovati ${creates.length}:\n` +
                JSON.stringify(creates, null, 2),
            );
          }
          const transcriptId = creates[0]!.messageId;
          if (transcriptId === undefined) throw new Error('il sendMessage di trascrizione non ha un id registrato');

          // Exactly one message a person would ever have read reached this
          // chat for the whole turn — the pairing confirmation plus this one
          // create, nothing else. The answer is not a second one.
          const allCreates = sent.filter((c) => c.method === 'sendMessage');
          if (allCreates.length !== 2) {
            throw new Error(
              `attesi esattamente 2 sendMessage in tutto lo scenario (pairing + trascrizione), trovati ${allCreates.length}:\n` +
                JSON.stringify(allCreates, null, 2),
            );
          }

          const edits = sent.filter((c) => c.method === 'editMessageText' && Number(c.payload['message_id']) === transcriptId);
          if (edits.length === 0) {
            throw new Error(
              `nessun editMessageText sulla trascrizione (id ${transcriptId}) — il turno non è durato ` +
                `abbastanza da riaprire la finestra, o il secondo passo non è mai stato appeso:\n${JSON.stringify(sent, null, 2)}`,
            );
          }
          if (String(edits[0]!.payload['text'] ?? '') === String(creates[0]!.payload['text'] ?? '')) {
            throw new Error('editMessageText ha ripetuto lo stesso testo del create — non è un aggiornamento reale');
          }
          const finale = String(edits[edits.length - 1]!.payload['text'] ?? '');
          if (!finale.includes('✓ cerco in memoria: appunti di ieri') || !finale.includes('✓ cerco in memoria: appunti di oggi')) {
            throw new Error(`la trascrizione finale non tiene entrambi i passi:\n${finale}`);
          }
          if (/⏳|· \d+s/.test(finale)) {
            throw new Error(`la trascrizione finale ha ancora un contatore vivo — transcript.stop() non ha chiuso:\n${finale}`);
          }

          // Never deleted: the record of what happened stays above the answer.
          if (sent.some((c) => c.method === 'deleteMessage')) {
            throw new Error(`qualcosa è stato cancellato — la trascrizione deve restare:\n${JSON.stringify(sent, null, 2)}`);
          }

          // The real answer is the transcript's OWN last edit — one visible
          // response, not a message beside it — and it carries the steps
          // above it, not just the bare answer text.
          if (!finale.includes('niente di nuovo da ieri a oggi')) {
            throw new Error(`l'ultimo edit della trascrizione non porta la risposta:\n${finale}`);
          }
        } finally {
          await gw.stop();
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    90_000,
  );
});

describe('acceptance · B14 · un allegato reale su Telegram', () => {
  /**
   * Falsifier: change `agent/tools/deliver.ts`'s handler to report
   * `outcome.delivered` unconditionally as success without ever calling
   * `deps.deliverFile`, and the `sendDocument` assertion below breaks — no
   * call would ever reach the fake server, `tg.documents()` would stay empty.
   */
  scenario(
    'B14',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({
        main: [
          { tool: { name: 'send_file', args: { path: 'report.txt', caption: 'ecco il report' } } },
          { text: "fatto, te l'ho mandato come allegato" },
        ],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        // A file that already exists — `send_file`'s scope is the vault root
        // (`cli/surface.ts#attachSendFile`), never the project working
        // directory `fs_write` uses, so this is placed directly rather than
        // routed through a first tool round that could not reach it anyway.
        const vaultRoot = paths(inst.home).vault;
        mkdirSync(vaultRoot, { recursive: true });
        const content = 'resoconto acceptance B14 — '.repeat(50);
        writeFileSync(join(vaultRoot, 'report.txt'), content, 'utf8');
        const expectedBytes = Buffer.byteLength(content, 'utf8');

        const gw = await pairOwner(inst, tg, OWNER_ID);
        try {
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'mandami il report.txt come allegato'));
          // The text answer follows a tool call (`send_file`), so it lands as
          // an edit of that tool's own transcript message, not a fresh
          // `sendMessage` (B13's merge, `connector.ts#deliverTo`) — wait on
          // `tg.sent()` directly rather than `tg.messages()`.
          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes("l'ho mandato come allegato"),
                ),
            30_000,
          );

          const docs = tg.documents();
          if (docs.length !== 1) {
            throw new Error(`atteso esattamente 1 sendDocument, trovati ${docs.length}: ${JSON.stringify(tg.sent(), null, 2)}`);
          }
          const doc = docs[0]!;
          if (doc.chatId !== OWNER_ID) throw new Error(`sendDocument sulla chat sbagliata: ${JSON.stringify(doc)}`);
          if (doc.filename !== 'report.txt') throw new Error(`filename atteso "report.txt", trovato ${JSON.stringify(doc.filename)}`);
          if (doc.bytes !== expectedBytes) {
            throw new Error(`byte attesi ${expectedBytes}, arrivati ${doc.bytes} — il file non è arrivato per intero`);
          }
          if (doc.caption !== 'ecco il report') throw new Error(`caption attesa "ecco il report", trovata ${JSON.stringify(doc.caption)}`);

          // And the durable record agrees: the tool itself reported success,
          // never "inviato" on a delivery that failed (`deliver.ts`'s own point).
          const turnRow = inst.db(
            (db) =>
              db.prepare(`SELECT messages FROM turns ORDER BY created_at DESC LIMIT 1`).get() as { messages: string } | undefined,
          );
          if (!turnRow || !turnRow.messages.includes('inviato: report.txt')) {
            throw new Error(`il turno non registra "inviato: report.txt": ${turnRow?.messages}`);
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

describe('acceptance · D12 · ASK su Telegram, dai pulsanti alla riga consumata', () => {
  /**
   * Falsifier: in `agent/loop.ts`'s `ask` branch, change `summarizeCallArgs`
   * to be called only for a `path`/`url`/`query` resource (i.e. never for
   * `resourceKind: 'none'`) and the "shows command+cwd" assertion breaks —
   * that is exactly the D12-min gap RETURN S3 closed. Change
   * `core/approvals/store.ts#take`'s `WHERE … AND consumed_at IS NULL` to
   * drop the `consumed_at IS NULL` guard and the "consumed exactly once"
   * assertion would still pass today (nothing here re-consumes it twice on
   * purpose) — the real falsifier for that half is a second `decide()`/`take()`
   * on the same id, checked directly below via the impostor's click.
   */
  scenario(
    'D12',
    async () => {
      const tg = await startFakeTelegram();
      const inst = await install({
        main: [
          { tool: { name: 'memory_search', args: { query: 'nota interna' } } },
          { tool: { name: 'shell_run', args: { command: 'echo ciao', cwd: '.', description: 'stampa la parola ciao' } } },
          // The same call again: a resumed turn re-asks the model, and the
          // model is scripted here to retry exactly the call it made before
          // suspending (`cli/surface.ts#approvatoreTelegram`'s own docstring:
          // "il turno si sospende qui e riprende da solo quando arriva la
          // risposta" — the retry is real production behaviour, not a test
          // artefact).
          { tool: { name: 'shell_run', args: { command: 'echo ciao', cwd: '.', description: 'stampa la parola ciao' } } },
          { text: 'fatto, il comando ha risposto ciao' },
        ],
        env: { MUFFIN_GATEWAY_TICK_MS: '200' },
      });
      try {
        // Taint 2 ("gruppo/sconosciuto"), inside `sys.shell`'s `maxTaint: 2` —
        // enough to make the ASK show a taint reason without tripping
        // `taint_exceeded` into an outright deny.
        plantTier2Episode(inst.home, 'fixture-d12');

        const gw = await pairOwner(inst, tg, OWNER_ID);
        try {
          tg.deliver(privateMessage({ id: OWNER_ID, name: 'Owner' }, 'leggi le mie note e poi esegui echo ciao'));

          // The ASK: a sendMessage with an inline keyboard, distinct from the
          // pairing confirmation already sitting in `tg.sent()`.
          await until(
            () => tg.sent().some((c) => c.method === 'sendMessage' && c.payload['reply_markup'] !== undefined),
            20_000,
          );
          const askCall = tg.sent().find((c) => c.method === 'sendMessage' && c.payload['reply_markup'] !== undefined);
          if (!askCall) throw new Error('nessun messaggio ASK con tastiera trovato');
          const askText = String(askCall.payload['text'] ?? '');
          if (!askText.includes('sys.shell')) throw new Error(`l'ASK non nomina la capability:\n${askText}`);
          if (!askText.includes('command: echo ciao') || !askText.includes('cwd: .')) {
            throw new Error(`l'ASK non mostra comando e cwd insieme:\n${askText}`);
          }
          // 03/09: the model's own account of the command, above it — and
          // never *inside* the argument line, where it would read as a
          // parameter of the command rather than a sentence about it.
          if (!askText.includes('stampa la parola ciao')) throw new Error(`l'ASK non mostra cosa fa il comando:\n${askText}`);
          if (askText.includes('description:')) throw new Error(`la description è finita fra gli argomenti:\n${askText}`);
          if (!askText.includes('taint 2')) throw new Error(`l'ASK non mostra il taint del turno:\n${askText}`);
          const askMessageId = askCall.messageId;
          if (askMessageId === undefined) throw new Error('il messaggio ASK non ha un id registrato');

          type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
          const keyboard = askCall.payload['reply_markup'] as Keyboard;
          const okButton = keyboard.inline_keyboard.flat().find((b) => b.callback_data.startsWith('ok:'));
          if (!okButton) throw new Error(`nessun pulsante "ok:" nella tastiera:\n${JSON.stringify(keyboard)}`);
          const approvalId = okButton.callback_data.slice('ok:'.length);

          // === the negative first: an impostor's press decides nothing =====
          tg.deliver(
            callbackQuery(
              { id: IMPOSTOR_ID, name: 'Impostore' },
              `ok:${approvalId}`,
              { messageId: askMessageId, chatId: OWNER_ID, text: askText },
            ),
          );
          // No durable signal an impostor's press *should* move — poll a fixed
          // window instead of a condition, then check the row never moved.
          await new Promise((r) => setTimeout(r, 1_500));
          const afterImpostor = inst.db(
            (db) =>
              db.prepare(`SELECT decision, consumed_at FROM approvals WHERE id = ?`).get(approvalId) as
                | { decision: string | null; consumed_at: string | null }
                | undefined,
          );
          if (!afterImpostor) throw new Error(`nessuna riga approvals per ${approvalId}`);
          if (afterImpostor.decision !== null) {
            throw new Error(`il click dell'impostore ha deciso l'approvazione: ${JSON.stringify(afterImpostor)}`);
          }

          // === now the owner's press ========================================
          tg.deliver(callbackQuery({ id: OWNER_ID, name: 'Owner' }, `ok:${approvalId}`, { messageId: askMessageId, chatId: OWNER_ID, text: askText }));

          // The resumed turn's answer follows a tool call, so it joins that
          // tool's own transcript message as an edit (B13's merge,
          // `connector.ts#deliverTo`) rather than arriving as a fresh
          // `sendMessage` — wait on `tg.sent()` directly.
          await until(
            () =>
              tg
                .sent()
                .some(
                  (c) =>
                    (c.method === 'sendMessage' || c.method === 'editMessageText') &&
                    String(c.payload['text'] ?? '').includes('ha risposto ciao'),
                ),
            30_000,
          );

          const finalRow = inst.db(
            (db) =>
              db.prepare(`SELECT decision, consumed_at FROM approvals WHERE id = ?`).get(approvalId) as
                | { decision: string | null; consumed_at: string | null }
                | undefined,
          );
          if (!finalRow) throw new Error(`nessuna riga approvals per ${approvalId} dopo l'approvazione`);
          if (finalRow.decision !== 'allow') throw new Error(`decision attesa "allow", trovata ${JSON.stringify(finalRow.decision)}`);
          if (finalRow.consumed_at === null) throw new Error('la riga approvals non risulta mai consumata dopo la ripresa del turno');

          // The button press itself got answered (`answerCallbackQuery`) —
          // the client is never left with a spinner.
          if (!tg.sent().some((c) => c.method === 'answerCallbackQuery')) {
            throw new Error('nessun answerCallbackQuery registrato dopo il click');
          }

          // === docs/evidence/forma-delle-superfici-2026-09-03.md §7, esteso ===
          //
          // Il resto dello scenario si fermava qui, prima di questa slice: mai
          // un'asserzione su cosa appare **fra** l'approvazione risolta e la
          // risposta finale, perché prima non appariva niente da asserire. Le
          // due righe sotto sono lo STAND-IN dichiarato dal brief: `tg` è il
          // fake Bot API dell'harness di accettazione, non un client reale —
          // vedi `docs/ORCHESTRATION.md` §"A stand-in cannot close a row the
          // owner can see" e il report di questa slice.
          //
          // (a) La tastiera del messaggio ASK sparisce per costruzione, non
          // per omissione: una chiamata esplicita a `editMessageReplyMarkup`
          // con `reply_markup: { inline_keyboard: [] } — mai un'assunzione sul
          // comportamento (non documentato) di `editMessageText` senza
          // `reply_markup` (§4.4 della memo).
          const tastieraTolta = tg
            .sent()
            .find((c) => c.method === 'editMessageReplyMarkup' && Number(c.payload['message_id']) === askMessageId);
          if (!tastieraTolta) {
            throw new Error('nessun editMessageReplyMarkup esplicito sul messaggio ASK dopo la decisione');
          }
          const tastieraVuota = tastieraTolta.payload['reply_markup'] as Keyboard | undefined;
          if (!Array.isArray(tastieraVuota?.inline_keyboard) || tastieraVuota.inline_keyboard.length !== 0) {
            throw new Error(`reply_markup non è una tastiera esplicitamente vuota: ${JSON.stringify(tastieraTolta.payload)}`);
          }

          // (b) Il passo `⏸ … aspetto la tua approvazione` dentro il segmento
          // della trascrizione (un messaggio diverso da quello con la
          // tastiera) si è risolto: l'ultimo edit su quel messaggio non porta
          // più la riga di attesa, e porta il verdetto nello stesso
          // vocabolario di ogni altro passo (`transcript.ts`'s `resolveAsk`).
          const editSullaTrascrizione = tg
            .sent()
            .filter((c) => c.method === 'editMessageText' && Number(c.payload['message_id']) !== askMessageId);
          if (editSullaTrascrizione.length === 0) {
            throw new Error('nessun edit sul messaggio della trascrizione (diverso da quello ASK)');
          }
          const ultimoTestoTrascrizione = String(
            editSullaTrascrizione[editSullaTrascrizione.length - 1]?.payload['text'] ?? '',
          );
          if (ultimoTestoTrascrizione.includes('aspetto la tua approvazione')) {
            throw new Error(
              `la riga di attesa resta congelata a turno concluso:\n${ultimoTestoTrascrizione}`,
            );
          }
          if (!ultimoTestoTrascrizione.includes('sys.shell: consentito')) {
            throw new Error(`il verdetto non compare, risolto, nella trascrizione:\n${ultimoTestoTrascrizione}`);
          }
          // E il tool rieseguito dopo la ripresa è arrivato nello stesso
          // segmento — non un messaggio nuovo — a riprova che
          // `resumeStream` ha riusato la trascrizione tenuta aperta invece
          // di aprirne una fresca.
          if (!ultimoTestoTrascrizione.includes('eseguo un comando: echo ciao')) {
            throw new Error(
              `il passo del tool rieseguito dopo l'approvazione non è nello stesso segmento risolto:\n${ultimoTestoTrascrizione}`,
            );
          }
          // (c) La risposta finale è proprio quest'ultimo edit — un turno,
          // una risposta visibile come una cosa sola — non un `sendMessage`
          // a parte accanto alla trascrizione.
          if (!ultimoTestoTrascrizione.includes('ha risposto ciao')) {
            throw new Error(`la risposta finale non è finita nell'ultimo edit della trascrizione:\n${ultimoTestoTrascrizione}`);
          }
          if (tg.sent().some((c) => c.method === 'sendMessage' && String(c.payload['text'] ?? '').includes('ha risposto ciao'))) {
            throw new Error('la risposta finale è arrivata anche come sendMessage a parte, non solo come edit della trascrizione');
          }
        } finally {
          await gw.stop();
        }
      } finally {
        await inst.cleanup();
        await tg.close();
      }
    },
    90_000,
  );
});
