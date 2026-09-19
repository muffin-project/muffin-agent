import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { TrustTier } from '../policy/types.js';

/**
 * Session transcripts.
 *
 * Append-only JSONL, one file per session, flushed on every completed message.
 * The whole point is the failure mode: a crash mid-turn loses the turn in
 * progress and nothing else. Keeping the transcript only in memory would mean
 * a restart costs you the conversation — and restarts happen precisely when
 * something interesting was going on.
 *
 * This is not memory (that is M2). It is the raw record of what was said, which
 * memory will later be built from — so it stores messages verbatim, never
 * summaries: a lossy write here would be unrecoverable later.
 */

type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export type SessionMessage = {
  role: MessageRole;
  content: string;
  /** Set on tool messages, so a result can be tied back to its call. */
  toolCallId?: string;
  toolName?: string;
  surface: string;
  createdAt: string;
  /** Ties the message to the span that produced it — "why did it do that" is a join. */
  traceId?: string;
  /**
   * The trust tier of this message's content, at the moment it was written.
   *
   * Additive (ADR-0044 §Revisione — "la history non lava la provenienza"): a
   * row written before this field existed has none, on disk, forever — JSONL
   * is append-only and nothing here rewrites a past line. `owner` user text is
   * 0 (2 for a `member`, the same rule `runTurn`/`enqueueTurn` init with);
   * `assistant` and `tool` carry the turn's own taint at the instant they were
   * appended (`PermissionSnapshot.currentTaint()` for assistant, `outcome.tier`
   * for tool), never a literal — the reason is 03 §2's own sentence, applied
   * here instead of to the memory episode it was first found missing from:
   * *"un riassunto di contenuto tier-3 è tier-3, sempre — altrimenti la
   * sintesi diventa una lavanderia del taint."*
   *
   * `agent/context/history-taint.ts` reads this field to raise a **later**
   * turn's taint before the kernel decides anything, and resolves its absence
   * (an old row) from `traceId` instead of guessing — see that module.
   */
  tier?: TrustTier;
};

export type SessionRef = {
  id: string;
  file: string;
  /**
   * Which conversation of this session the ref was opened in.
   *
   * Resolved by the store, never invented by callers: `open()` reads it from
   * the sidecar (absent sidecar means 0, the legacy default), `/new` bumps it
   * through `newConversation()`. Additive and optional, so every literal
   * `{id, file}` built in tests and gateways keeps compiling — a ref without
   * it reads as generation 0 wherever a conversation identity is derived.
   */
  generation?: number;
};

/** Version of the conversation-metadata sidecar. Bumped only for breaking shape changes. */
export const CONVERSATION_METADATA_VERSION = 1;

export class SessionStore {
  private readonly dir: string;

  constructor(homeDir: string) {
    this.dir = join(homeDir, 'sessions');
    mkdirSync(this.dir, { recursive: true });
  }

  open(id?: string): SessionRef {
    const sessionId = id ?? `${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
    const ref: SessionRef = { id: sessionId, file: join(this.dir, `${sessionId}.jsonl`) };
    // Read only, never a write: opening a session must not create identity.
    // A missing sidecar is generation 0 (every session that predates it);
    // a corrupt one throws — collapsing two conversations into one without
    // saying so would be the silent direction.
    ref.generation = this.generationOf(ref);
    return ref;
  }

  /**
   * Which conversation generation this session is in, from the sidecar.
   *
   * Missing metadata is 0, never an error: that is every legacy session and
   * every fresh one. Present-but-unreadable metadata is an ERROR, never 0 —
   * `missing` and `corrupt` are different facts, and treating a torn write
   * as "no history" would merge two conversations' provider stickiness
   * without a word. Loud here so `/new` and `open` both refuse to proceed
   * on an identity nobody can state.
   */
  generationOf(session: SessionRef): number {
    const file = this.generationFile(session.id);
    if (!existsSync(file)) return 0;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`session ${session.id}: cannot read conversation metadata at ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`session ${session.id}: corrupt conversation metadata at ${file}: not JSON`);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== CONVERSATION_METADATA_VERSION ||
      !Number.isInteger((parsed as { generation?: unknown }).generation) ||
      ((parsed as { generation?: number }).generation as number) < 0
    ) {
      throw new Error(
        `session ${session.id}: corrupt conversation metadata at ${file}: expected {"version":${CONVERSATION_METADATA_VERSION},"generation":<non-negative int>}`,
      );
    }
    return (parsed as { generation: number }).generation;
  }

  /**
   * `/new` accettato: chiude la conversazione corrente e ne apre la successiva.
   *
   * Transcript rotation keeps its current semantics (archive when there is
   * one, destroy nothing, same session id) AND the generation always moves —
   * even when no `.jsonl` exists to archive. The `/new` intent draws the
   * conversation boundary, not the physical transcript: a bare `/new`
   * (`rotate` returning null) still ends the provider stickiness of the
   * previous conversation.
   *
   * Corrupt metadata aborts BEFORE any state changes: neither the transcript
   * nor the generation moves when the current generation cannot be stated.
   */
  newConversation(session: SessionRef, now: Date = new Date()): string | null {
    const generation = this.generationOf(session);
    const archivio = this.rotate(session, now);
    this.writeGeneration(session, generation + 1);
    return archivio;
  }

  /**
   * Chiude la conversazione di prima senza cambiare id.
   *
   * Serve a `/new` su una superficie il cui id di sessione **non è libero**:
   * Telegram lo deriva dalla chat (`telegram:<chatId>`), quindi «una sessione
   * nuova» non può essere un id nuovo — sarebbe una chat diversa. Il file
   * viene messo da parte con la data, e da lì la stessa conversazione riparte
   * vuota.
   *
   * Messo da parte e non cancellato: `/new` è una cosa che si dice di fretta,
   * e buttare la storia di una conversazione perché qualcuno ha scritto tre
   * lettere è il tipo di irreversibilità che questo progetto rifiuta altrove
   * (cfr. `muffin undo`, che mette da parte pure sé stesso).
   *
   * Restituisce il nome dell'archivio, o `null` se non c'era niente da
   * archiviare — che non è un errore: una conversazione mai cominciata è già
   * nuova.
   */
  rotate(session: SessionRef, now: Date = new Date()): string | null {
    if (!existsSync(session.file)) return null;
    const marca = now.toISOString().replace(/[:.]/g, '-');
    const archivio = session.file.replace(/\.jsonl$/, `.${marca}.jsonl`);
    renameSync(session.file, archivio);
    return archivio;
  }

  /**
   * Where this session's conversation generation lives.
   *
   * A sibling of the transcript, keyed by session id — so the private owner
   * scope (`owner` on every surface) shares one generation, while every
   * group/topic key carries its own. Never `.jsonl`, so `rotate()`'s suffix
   * replacement can never touch it, and transcript readers never see it.
   */
  private generationFile(sessionId: string): string {
    return join(this.dir, `${sessionId}.conv.json`);
  }

  /**
   * Durable bump, atomic: temporary file on the same filesystem, then rename.
   * A torn write must leave either the old generation or the new one behind —
   * never a half file that `generationOf` would then have to interpret.
   */
  private writeGeneration(session: SessionRef, generation: number): void {
    const dest = this.generationFile(session.id);
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: CONVERSATION_METADATA_VERSION, generation }), 'utf8');
    renameSync(tmp, dest);
  }

  append(session: SessionRef, message: SessionMessage): void {
    appendFileSync(session.file, `${JSON.stringify(message)}\n`, 'utf8');
  }

  /**
   * Tolerates a truncated last line: if the process died mid-write, the partial
   * record is dropped rather than taking the whole session down with it.
   */
  read(session: SessionRef): SessionMessage[] {
    if (!existsSync(session.file)) return [];
    const out: SessionMessage[] = [];
    for (const line of readFileSync(session.file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as SessionMessage);
      } catch {
        /* truncated tail from an interrupted write */
      }
    }
    return out;
  }
}
