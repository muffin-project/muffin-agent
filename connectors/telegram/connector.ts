import type { Message, Update } from '@grammyjs/types';
import { runTurn, type LoopDeps, type TurnDelta } from '../../agent/loop.js';
import { checkPairing, type PendingPairing } from '../../core/config/pairing.js';
import type { SessionStore } from '../../core/session/store.js';
import type { TrustTier } from '../../core/policy/types.js';
import { identify, tierOf, type SurfaceIdentity } from '../../core/surface/types.js';
import { TelegramError, type TelegramApiLike } from './api.js';
import { attachmentOf, downloadToVault, type MediaSpec } from './media.js';
import { startPresence } from './presence.js';
import { renderForTelegram } from './render.js';
import { UpdateInbox } from './updates.js';

/**
 * Telegram as an adapter over the one loop, not a second engine.
 *
 * The boundary is the point. The previous system's 2,900-line Telegram file was
 * not caused by its library: the diagnosis names the *absence of a typed
 * boundary* — a gateway that knew Telegram's message length limit and built
 * Telegram-shaped footers. So nothing above this file knows what Telegram is,
 * and nothing in this file knows what the agent decided. It receives text,
 * calls `runTurn`, and renders what comes back.
 *
 * Three properties it is responsible for, in order of how much they cost when
 * wrong:
 *
 *  1. **No message is lost.** Every batch is written to the inbox before the
 *     offset advances, because Telegram never redelivers a confirmed update.
 *  2. **Who is speaking decides the tenant**, and the kernel decides the rest.
 *     A private chat with the owner is `host`; a group is its own tenant; anyone
 *     who is not the owner is a `member` with the taint that comes with it.
 *  3. **Nothing is answered twice**, including across a restart.
 */

export type TelegramConfig = {
  token: string;
  /**
   * Who the owner is. **Absent means nobody is** — no message can arrive as the
   * owner until a pairing code proves it. That is the fail-closed replacement
   * for "whoever wrote first", which was not an attack so much as a race.
   */
  ownerUserId?: number | undefined;
  /** Where to deliver. A room; who is a different question. */
  ownerChatId?: number | undefined;
  /** The outstanding pairing code, hashed. Absent once it has matched. */
  pairing?: PendingPairing | undefined;
};

export type ConnectorDeps = {
  loop: LoopDeps;
  /**
   * Persists the outcome of a pairing attempt. Injected rather than reached for
   * so the connector stays testable without a config file, and so the write is
   * one named place instead of scattered through the drain loop.
   *
   * Absent means pairing is disabled — the surface simply never becomes owned,
   * which is the safe direction.
   */
  savePairing?: ((next: {
    ownerUserId?: number;
    ownerChatId?: number;
    pairing: PendingPairing | null;
  }) => void) | undefined;
  sessions: SessionStore;
  inbox: UpdateInbox;
  api: TelegramApiLike;
  /**
   * Where attachments land. Absent means the connector still answers, and says
   * plainly that it cannot keep files — a degradation the owner can see rather
   * than a silent one.
   */
  vault?: {
    root: string;
    reindexPath: (tenantId: string, vaultPath: string, defaultTier: TrustTier) => Promise<{
      skipped: { path: string; why: string }[];
      /** What went in, and the compact view of each. See `core/vault/vault.ts`. */
      documents: { path: string; outline: string }[];
    }>;
  };
  config: TelegramConfig;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * Injectable so a test never waits for real. Same seam as
   * `connectors/discord/gateway.ts`'s own `sleep`, deliberately not shared
   * across the two connectors — three lines is not yet worth a module.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** What one update turns into, or null when it is not ours to handle. */
export type Incoming = {
  updateId: number;
  chatId: number;
  text: string;
  isPrivate: boolean;
  /** Who sent it. The person, never the room. 0 when Telegram did not say. */
  fromId: number;
  messageId: number;
  attachment?: MediaSpec;
};

/**
 * Reads an update defensively.
 *
 * The types say `message.chat.id` is always there. The types are generated from
 * a schema, not from what a live server does under an edge case, and this is the
 * one place where being wrong means a crash in a long-running process. So every
 * field is checked, and anything unrecognised is skipped rather than guessed at.
 *
 * **It no longer decides who the owner is**, and that separation is the repair
 * of the bug this function used to carry. Reading a message and authorising its
 * sender are two jobs; doing both here is how `message.chat.id` — the room —
 * ended up being compared against the owner, because it was the field already in
 * scope. Parsing now produces facts, `principalFor` applies the rule, and the
 * rule lives in `core/surface/types.ts` where every surface reads the same one.
 */
export function parseUpdate(update: Update): Incoming | null {
  const message: Message | undefined = update.message ?? update.edited_message;
  if (!message || typeof message.chat?.id !== 'number') return null;

  const attachment = attachmentOf(message);
  const text = message.text ?? message.caption;

  // A file with no caption is still a message: "here, keep this" is a complete
  // thought. Requiring text would have made a photo silently disappear.
  if ((typeof text !== 'string' || text.trim() === '') && attachment === null) return null;

  return {
    updateId: update.update_id,
    chatId: message.chat.id,
    text: typeof text === 'string' ? text : '',
    isPrivate: message.chat.type === 'private',
    // `from` is absent on channel posts and anonymous admins. Zero rather than
    // undefined so the field is always there to read, and zero is never a real
    // Telegram user id — `principalFor` maps it to "the platform did not say".
    fromId: message.from?.id ?? 0,
    messageId: message.message_id,
    ...(attachment ? { attachment } : {}),
  };
}

/**
 * The tenant and the principal, from who is speaking — via the rule every
 * surface shares.
 *
 * This function used to *be* the rule. It is now an adapter onto `identify`
 * (`core/surface/types.ts`), and that change is the point of the surfaces slice
 * rather than a tidy-up: a rule written once per connector is a rule that will
 * eventually be written differently once per connector. Discord calls the same
 * `identify` with its own snowflakes, so "who is the owner" cannot answer
 * differently on two surfaces without the compiler routing both through this one
 * function first.
 *
 * The properties `connectors/telegram/impersonation.test.ts` has always guarded
 * are unchanged and are now guarded for both surfaces at once: the room is not
 * the person, unpaired means nobody is the owner, and the owner speaking in a
 * group is a member of that group's tenant.
 */
export function principalFor(incoming: Incoming, ownerUserId: number | undefined): SurfaceIdentity {
  return identify(
    {
      connector: 'telegram',
      authorId: incoming.fromId === 0 ? '' : String(incoming.fromId),
      conversationId: String(incoming.chatId),
      direct: incoming.isPrivate,
    },
    ownerUserId === undefined ? undefined : String(ownerUserId),
  );
}

export class TelegramConnector {
  private running = false;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly deps: ConnectorDeps) {
    this.sleep = deps.sleep ?? sleep;
  }

  /**
   * Polls until stopped.
   *
   * The order inside the loop is the load-bearing part: fetch, **store**,
   * confirm, then process. Processing after confirmation is safe because the
   * evidence is already on disk; processing before storing would lose it.
   *
   * **`getMe()` used to run once, outside any retry** — a plain `await` before
   * `this.running` was even set. At boot, before the network or DNS is ready
   * (`Wants=network-online.target` does not guarantee it; a laptop's Wi-Fi
   * regularly comes up after the unit does), it threw, and the throw escaped
   * this whole function. `connectSurfaces` (`cli/surface.ts`) only `.catch`es
   * the returned promise into a log line ("telegram: caduta"): the surface was
   * dead for the rest of the process's life while the gateway stayed up — lock
   * held, scheduler ticking, `doctor` reporting a healthy gateway with nobody
   * reachable on it. Found proving ADR-0035's "continuity belongs to Muffin,
   * not the pid" for real Telegram reconnection, not only for the gateway's
   * own process.
   */
  async run(signal?: AbortSignal): Promise<void> {
    const log = this.deps.log ?? (() => {});
    // Set before the first `getMe()`, not after: `stop()` has to be observable
    // by the retry loop below even if it is called while still connecting.
    this.running = true;
    // A function, not the inline comparison repeated at each call site: `tsc`
    // narrows `signal.aborted` from the first check and (wrongly — an abort
    // can land during the `await` in between) treats it as still narrowed at
    // the second, which is a real `--strict` false positive on this exact
    // shape. A call is opaque to that narrowing; the property is re-read live
    // either way.
    const shouldStop = (): boolean => !this.running || signal?.aborted === true;

    let me: Awaited<ReturnType<TelegramApiLike['getMe']>> | undefined;
    for (let attempt = 0; me === undefined; attempt++) {
      if (shouldStop()) return;
      try {
        me = await this.deps.api.getMe();
      } catch (error) {
        if (shouldStop()) return;
        const wait = backoffMs(attempt);
        log(
          `telegram: connessione fallita (${error instanceof Error ? error.message : String(error)}) — riprovo fra ${Math.round(wait / 1000)}s`,
        );
        await this.sleep(wait, signal);
      }
    }
    log(`telegram: connesso come @${me.username ?? me.id}`);

    // Anything left pending from a previous life comes first, before new work.
    await this.drain();

    while (this.running && signal?.aborted !== true) {
      // Everything the beat does lives in one `try`, not only the network call:
      // `inbox.accept`/`drain()` throwing used to escape uncaught too, and a
      // bookkeeping error is exactly as unfit to kill the poller as a network
      // one. Same rule as `drain`'s own per-update `try` — report, continue.
      try {
        const updates = await this.deps.api.getUpdates(this.deps.inbox.nextOffset());
        if (updates.length > 0) {
          const { stored, duplicates } = this.deps.inbox.accept(updates, this.now());
          if (duplicates > 0) log(`telegram: ${duplicates} update già visti, ignorati`);
          if (stored > 0) await this.drain();
        }
      } catch (error) {
        if (error instanceof TelegramError && error.status === 409) {
          // Another poller holds the token — usually the previous process not
          // yet gone. Waiting is the correct move; racing it is not.
          log('telegram: 409, un altro getUpdates è attivo — attendo');
        } else {
          log(`telegram: polling fallito (${error instanceof Error ? error.message : String(error)})`);
        }
        await this.sleep(5000, signal);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  /**
   * Send an answer for a turn **this call did not run** — the lane's door.
   *
   * A turn that suspended, or that a crash interrupted, comes back in a process
   * whose stack has none of `handle`'s context: no presence placeholder, no
   * `Incoming`, no open `try`. All it has is the `replyTo` written onto the row
   * when the turn started, which is why that field was made durable in the
   * record slice with a comment naming this exact day.
   *
   * **This surface validates its own shape**, and that is the boundary rather
   * than a nicety: `replyTo` is `Record<string, unknown>` everywhere above here
   * on purpose — the loop must not learn what a chat id is, which is precisely
   * what the previous system lost when its gateway started building
   * Telegram-shaped footers. A row whose address is unreadable throws, and the
   * caller records `failed:` on it instead of silently dropping the answer.
   *
   * Deliberately additive and separate from `handle`'s own send: the in-band
   * path is being rewritten by another slice, and two slices editing one send
   * is a merge war rather than a suture.
   */
  async deliverTo(replyTo: Record<string, unknown>, text: string): Promise<void> {
    const chatId = replyTo['chatId'];
    if (typeof chatId !== 'number') {
      throw new Error(`replyTo senza chatId numerico: ${JSON.stringify(replyTo)}`);
    }
    const replyToMessage = typeof replyTo['messageId'] === 'number' ? replyTo['messageId'] : undefined;
    const editMessageId = typeof replyTo['editMessageId'] === 'number' ? replyTo['editMessageId'] : undefined;

    for (const [i, part] of renderForTelegram(text).entries()) {
      // The placeholder from the original turn is reused when it is still
      // there: a suspended turn that left "sto guardando…" in the chat should
      // replace it, not answer underneath it hours later.
      if (i === 0 && editMessageId !== undefined) {
        await this.deps.api.editMessageText(chatId, editMessageId, part);
      } else {
        await this.deps.api.sendMessage(chatId, part, {
          ...(i === 0 && replyToMessage !== undefined ? { replyTo: replyToMessage } : {}),
        });
      }
    }
  }

  /** Everything not yet answered, oldest first. Also the crash-recovery path. */
  private async drain(): Promise<void> {
    for (const stored of this.deps.inbox.pending()) {
      const update = JSON.parse(stored.payload) as Update;
      const incoming = parseUpdate(update);

      if (!incoming) {
        // Nothing to do with it, and saying so is better than leaving it pending
        // for ever: a queue that never empties hides the ones that matter.
        this.deps.inbox.markProcessed(stored.updateId, this.now());
        continue;
      }

      try {
        await this.handle(incoming);
        this.deps.inbox.markProcessed(stored.updateId, this.now());
      } catch (error) {
        // Stays pending: it may well work after a restart, and dropping it is
        // the data loss the inbox exists to prevent, arriving by another road.
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.inbox.markFailed(stored.updateId, reason);
        (this.deps.log ?? (() => {}))(`telegram: update ${stored.updateId} fallito — ${reason}`);
      }
    }
  }

  /**
   * The pairing gate.
   *
   * Runs before a message is treated as conversation, and only while unpaired.
   * Returns true when the message was consumed by pairing — matched or not —
   * so the drain loop stops rather than handing a code to the model.
   *
   * A code arrives as an ordinary private message, so this must not answer with
   * a turn: an unpaired stranger typing anything gets the normal member path,
   * but the one who types the right eight characters becomes the owner and
   * nothing else does.
   */
  private async tryPair(incoming: Incoming): Promise<boolean> {
    const { ownerUserId, pairing } = this.deps.config;
    if (ownerUserId !== undefined || !pairing || !this.deps.savePairing) return false;
    if (!incoming.isPrivate || incoming.fromId === 0) return false;

    const { outcome, next } = checkPairing(pairing, incoming.text, new Date(this.now()));
    const say = (text: string) => this.deps.api.sendMessage(incoming.chatId, text);

    if (outcome.status === 'matched') {
      // Persisted before the reply: if the send fails, the pairing still
      // happened, and the alternative — confirming something we did not store —
      // is the worse of the two.
      this.deps.savePairing({
        ownerUserId: incoming.fromId,
        ownerChatId: incoming.chatId,
        pairing: null,
      });
      this.deps.config.ownerUserId = incoming.fromId;
      this.deps.config.ownerChatId = incoming.chatId;
      this.deps.config.pairing = undefined;
      await say('Sei tu. Da adesso questa è la nostra chat.');
      return true;
    }

    // Anything else only counts as an attempt if it looked like a code; a
    // stranger saying "ciao" must not burn the owner's tries.
    if (!/^[\s0-9A-Za-z-]{8,12}$/.test(incoming.text.trim())) return false;

    this.deps.savePairing({ pairing: next });
    this.deps.config.pairing = next ?? undefined;
    if (outcome.status === 'wrong') await say(`Non è quello. Tentativi rimasti: ${outcome.remaining}.`);
    else await say('Quel codice non vale più. Rigenerane uno dalla CLI.');
    return true;
  }

  private async handle(incoming: Incoming): Promise<void> {
    if (await this.tryPair(incoming)) return;
    const { principal, tenant } = principalFor(incoming, this.deps.config.ownerUserId);
    const presence = await startPresence(this.deps.api, incoming.chatId, {
      isPrivate: incoming.isPrivate,
      placeholder: 'sto guardando…',
    });

    try {
      // The file lands and is indexed **before** the turn runs, so the agent
      // finds it in memory rather than being told about a path it cannot read.
      // A failed download does not fail the turn: the message still deserves an
      // answer, and an honest one says the file did not arrive.
      const arrival = incoming.attachment
        ? await this.ingest(incoming, incoming.attachment, tenant, tierOf(principal))
        : null;

      // M5-BIS B11: fed to `presence.streamText`, which owns the rate limit,
      // the coalescing and the transport choice (draft vs. edit) — this
      // closure only accumulates, exactly like the REPL's own `onDelta` does
      // for `process.stdout` (`cli/repl.ts`). `deltaText` grows to
      // `result.text` byte for byte (`agent/loop.ts`'s `trimChunkEdges`),
      // which is what lets the finalisation below compare the two directly.
      let deltaText = '';
      const onDelta = (delta: TurnDelta): void => {
        deltaText += delta.text;
        presence.streamText(deltaText);
      };

      const result = await runTurn(this.deps.loop, {
        principal,
        tenant,
        surface: 'telegram',
        // One session per chat, so a conversation continues where it left off
        // and two chats never share one.
        session: this.deps.sessions.open(`telegram:${incoming.chatId}`),
        text: arrival ? `${arrival}\n\n${incoming.text}`.trim() : incoming.text,
        // Where the answer goes, on the record rather than only on this stack.
        // Nothing reads it yet — the turn is still delivered from right here,
        // below — and that is the point of writing it now: the day the lane
        // delivers instead of this function, the address is already durable and
        // this call site does not have to be reopened to put it there.
        // `channel` is that address in `SurfaceRegistry` terms — added for
        // #41's lane (turno sospeso), the same field `makeJobRunner`
        // (`agent/scheduler-run.ts`) already writes for a scheduled job.
        replyTo: {
          chatId: incoming.chatId,
          messageId: incoming.messageId,
          channel: `telegram:${incoming.chatId}`,
          ...(presence.editMessageId === undefined ? {} : { editMessageId: presence.editMessageId }),
        },
        // The registry address for *this* conversation — always the fully
        // qualified `telegram:<chatId>`, even for the owner's own private
        // chat: a mid-turn tool addressing a follow-up delivery needs the
        // exact room the turn came from, not the surface's default (which
        // `telegram` alone would mean, and which is the owner's chat
        // regardless of which group this turn is actually in).
        replyChannel: `telegram:${incoming.chatId}`,
        onDelta,
      });

      // B11: no more live updates once the turn itself is over. Called here,
      // explicitly, before any finalisation network call below — not only in
      // the `finally` — because `stop()` is idempotent and this is what
      // cancels a coalesced, still-pending live update before it can race
      // the final edit and land after it with stale, mid-turn text.
      await presence.stop();

      // A suspended turn has produced nothing to deliver. Rendering `''` would
      // send an empty message (`renderForTelegram('')` is `['']`) and record
      // `sent` on a turn that has not answered — the owner would read it as the
      // answer. The placeholder stays as the truth of the moment, and the lane's
      // `deliverTo` replaces it when the turn resumes: the mirror of the guard
      // `agent/turn-lane.ts` already has on the resume path. Found by the
      // integrated judge of the dev→main promotion (#44), between #41 and #42.
      if (result.stopped === 'suspended') return;

      try {
        const parts = renderForTelegram(result.text);
        for (const [i, part] of parts.entries()) {
          // The placeholder becomes the first part rather than sitting above it.
          if (i === 0 && presence.editMessageId !== undefined) {
            // B11: if live streaming already left this message showing
            // exactly the finished answer, skip the edit rather than send a
            // knowably-redundant one. Whether Telegram treats an edit with
            // unchanged content as a harmless no-op or an error is not
            // something this environment can verify (no token to probe
            // with — PRACTICES §2) — dropping the call removes the
            // dependency on the answer instead of assuming either one.
            if (presence.lastStreamedRaw() !== result.text) {
              await this.deps.api.editMessageText(incoming.chatId, presence.editMessageId, part);
            }
          } else {
            await this.deps.api.sendMessage(incoming.chatId, part, {
              ...(i === 0 ? { replyTo: incoming.messageId } : {}),
            });
          }
        }
        this.recordDelivery(result.turnId, 'sent');
      } catch (error) {
        // The second outcome, kept apart from the first: the *turn* answered,
        // the *delivery* did not. `core/scheduler/scheduler.ts:166-171` already
        // paid for merging these — a failed delivery must never make work run
        // again, because that doubles it. Rethrown unchanged, so the update
        // stays pending exactly as before.
        this.recordDelivery(result.turnId, `failed:${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    } finally {
      await presence.stop();
    }
  }

  /**
   * Writes how the delivery went, and is not allowed to fail the delivery.
   *
   * The precedent is literal: `Scheduler.run` wraps `markRan` for exactly this,
   * after a bookkeeping write against a closed database took the gateway down
   * through an unhandled rejection. Here the stake is higher — throwing after a
   * successful send would mark the update failed and send the whole answer a
   * second time on the next drain.
   */
  private recordDelivery(turnId: string, delivery: 'sent' | `failed:${string}`): void {
    try {
      this.deps.loop.turns.delivered(turnId, delivery);
    } catch (error) {
      (this.deps.log ?? (() => {}))(
        `telegram: consegna non registrata per il turno ${turnId.slice(0, 12)} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Downloads an attachment into the vault and indexes it.
   *
   * Returns the line prepended to the turn's text — the agent is told a file
   * arrived and what it is called, in the same message, rather than having to
   * infer it from a memory hit. Failure is reported the same way: the turn still
   * runs, and the agent knows it does not have the file. Saying "ricevuto" about
   * something that is not there is the failure this project keeps naming.
   *
   * For a document the line is not a line, it is the **compact view**: what the
   * document is, that all of it is in memory, an index of its pages, and the
   * call that reads one of them back. Handing over eighty pages of a PDF to
   * answer "quanto è l'affitto?" is the cost this avoids; handing over a
   * summary instead of the document is the failure it avoids. The vault builds
   * it — this file renders what it is given and knows nothing about PDFs.
   *
   * The tier is the sender's: a document from a group member is tier-2 evidence
   * and stays tier-2 through reindexing, which the vault enforces by content
   * hash rather than by path.
   */
  private async ingest(
    incoming: Incoming,
    spec: MediaSpec,
    tenantId: string,
    tier: TrustTier,
  ): Promise<string> {
    if (!this.deps.vault) return `[allegato ricevuto ma il vault non è configurato: ${spec.originalName}]`;
    try {
      const saved = await downloadToVault(
        this.deps.api,
        this.deps.vault.root,
        spec,
        incoming.updateId,
        this.now(),
      );
      // The tenant resolved from the authenticated sender travels with the
      // bytes. Using a surface-wide `host` here indexed group documents into
      // the owner's private memory, then made document_read fail in the group.
      const report = await this.deps.vault.reindexPath(tenantId, saved.vaultPath, tier);
      const skipped = report.skipped.find((s) => s.path === saved.vaultPath);
      if (skipped) {
        return `[ricevuto \`${saved.vaultPath}\` (${Math.round(saved.bytes / 1024)}KB) ma non indicizzato: ${skipped.why}]`;
      }
      const document = report.documents.find((d) => d.path === saved.vaultPath);
      if (document) {
        return `[documento acquisito]\n${document.outline}`;
      }
      return `[ricevuto e indicizzato: \`${saved.vaultPath}\`, ${Math.round(saved.bytes / 1024)}KB]`;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      (this.deps.log ?? (() => {}))(`telegram: allegato non scaricato — ${why}`);
      return `[allegato NON ricevuto: ${why}. Dillo, non fingere di averlo.]`;
    }
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Backoff for the `getMe()` reconnect loop. Capped, with jitter so a shared
 * outage (the owner's router rebooting, a DNS blip) does not make every retry
 * land in the same instant. Same shape as `connectors/discord/gateway.ts`'s
 * own `backoffMs`, kept local rather than shared: two three-line functions
 * across two connectors is not yet a module.
 */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return base + Math.floor(Math.random() * 1000);
}
