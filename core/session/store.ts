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
   * through `newConversation()`. When a previous `/new` died mid-transition,
   * `open()` completes that transition first and reports the resolved
   * generation — it never initiates one. Additive and optional, so every
   * literal `{id, file}` built in tests and gateways keeps compiling — a ref
   * without it reads as generation 0 wherever a conversation identity is
   * derived.
   */
  generation?: number;
};

/**
 * Version of the conversation-metadata sidecar. Bumped to 2 when the file
 * became transition-aware (`pending`): a v1 reader validates `version` and
 * ignores unknown fields, so it would accept a v2 file while silently
 * ignoring the recovery semantics — the version bump turns that into a loud
 * rejection instead, which is exactly what the field is for.
 */
export const CONVERSATION_METADATA_VERSION = 2;

/** Last version readable as steady state, without transition semantics. */
const STEADY_METADATA_VERSION = 1;

type PendingTransition = {
  /** The generation this interrupted `/new` was moving to: always exactly current + 1. */
  to: number;
};

type ConversationMetadata = {
  version: number;
  generation: number;
  pending?: PendingTransition;
};

/**
 * Fault seam for the `/new` durability protocol, test-only by convention:
 * production callers pass nothing. Each hook runs immediately after the
 * durable operation it names; a test that throws inside one simulates a
 * process crash at exactly that boundary, and the recovery rule in
 * `generationOf` must then resolve the on-disk state deterministically.
 */
export type NewConversationHooks = {
  /** After the intent sidecar commit, before transcript rotation. */
  afterIntent?: () => void;
  /** After transcript rotation, before the generation commit. */
  afterRotate?: () => void;
};

export class SessionStore {
  private readonly dir: string;

  constructor(homeDir: string) {
    this.dir = join(homeDir, 'sessions');
    mkdirSync(this.dir, { recursive: true });
  }

  open(id?: string): SessionRef {
    const sessionId = id ?? `${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
    const ref: SessionRef = { id: sessionId, file: join(this.dir, `${sessionId}.jsonl`) };
    // Completes an interrupted `/new` when one is on disk, never starts one:
    // opening a session must not create identity. A missing sidecar is
    // generation 0 (every session that predates it); a corrupt one throws —
    // collapsing two conversations into one without saying so would be the
    // silent direction.
    ref.generation = this.generationOf(ref);
    return ref;
  }

  /**
   * Which conversation generation this session is in, from the sidecar —
   * and the single recovery point for an interrupted `/new`.
   *
   * Missing metadata is 0, never an error: that is every legacy session and
   * every fresh one. Present-but-unreadable metadata is an ERROR, never 0 —
   * `missing` and `corrupt` are different facts, and treating a torn write
   * as "no history" would merge two conversations' provider stickiness
   * without a word.
   *
   * Compatibility: a stable v1 `{version:1,generation:N}` (no `pending`)
   * reads as steady N — every file the previous slice wrote keeps working,
   * and new steady writes go out as v2. A v1 file carrying `pending` is
   * corrupt: no writer this repo ever had produced one, and a v1 reader
   * would ignore the field and reproduce the split this protocol exists to
   * close.
   *
   * Recovery (process-crash/restart consistency — no fsync/power-loss claim)
   * decides from the active-transcript/archive PAIR, never from one side
   * alone, and only ever touches the sidecar, never transcript or archive:
   *
   * - active present + archive absent → rotation never committed → roll
   *   back: clear `pending`, stay N (old conversation wholly active);
   * - active absent + archive present → rotation committed → roll forward:
   *   commit N+1 (new conversation wholly active);
   * - both present or both absent → impossible/ambiguous under the protocol
   *   (rotation is one atomic rename of a bound name) → fail loud, no guess.
   *
   * `pending` is valid only as exactly `to == generation + 1`: the protocol
   * cannot produce anything else (commit clears it atomically), so anything
   * else is hand-edit/corruption and fails loud rather than being
   * normalised. Recovery is idempotent — resolving twice cannot advance
   * twice — but it is NOT command-level exactly-once: a later explicit `/new`
   * is a new intent and advances again. Cross-process concurrent `/new` on
   * one session is out of scope (see `newConversation`).
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
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(
        `session ${session.id}: corrupt conversation metadata at ${file}: expected {"version":${CONVERSATION_METADATA_VERSION},"generation":<non-negative int>}`,
      );
    }
    const record = parsed as { version?: unknown; generation?: unknown; pending?: unknown };
    if (
      (record.version !== STEADY_METADATA_VERSION &&
        record.version !== CONVERSATION_METADATA_VERSION) ||
      !Number.isInteger(record.generation) ||
      ((record.generation as number) as number) < 0
    ) {
      throw new Error(
        `session ${session.id}: corrupt conversation metadata at ${file}: expected {"version":${CONVERSATION_METADATA_VERSION},"generation":<non-negative int>}`,
      );
    }
    const generation = record.generation as number;
    if (record.pending === undefined) return generation;
    // A stable v1 file must not carry transition state: no writer ever
    // produced one, and an old reader would ignore it and split.
    if (record.version !== CONVERSATION_METADATA_VERSION) {
      throw new Error(
        `session ${session.id}: corrupt conversation metadata at ${file}: version ${String(record.version)} carries transition state it cannot describe`,
      );
    }
    // Pending means exactly N → N+1: the only transition the protocol writes.
    if (
      typeof record.pending !== 'object' ||
      record.pending === null ||
      Array.isArray(record.pending) ||
      Object.keys(record.pending).join() !== 'to' ||
      (record.pending as { to?: unknown }).to !== generation + 1
    ) {
      throw new Error(
        `session ${session.id}: corrupt conversation metadata at ${file}: pending must be exactly {"to":${generation + 1}}`,
      );
    }
    const active = existsSync(session.file);
    const archived = existsSync(this.archiveFile(session.id, generation));
    if (active && !archived) {
      // Rotation never committed: clear the intent, old conversation stands.
      this.writeMetadata(session.id, { version: CONVERSATION_METADATA_VERSION, generation });
      return generation;
    }
    if (!active && archived) {
      // Rotation committed: complete the bump the crash interrupted.
      this.writeMetadata(session.id, {
        version: CONVERSATION_METADATA_VERSION,
        generation: generation + 1,
      });
      return generation + 1;
    }
    throw new Error(
      `session ${session.id}: ambiguous conversation transition at ${file}: active transcript ${active ? 'present' : 'absent'} with archive ${archived ? 'present' : 'absent'} — refusing to guess which conversation is live`,
    );
  }

  /**
   * `/new` accettato: chiude la conversazione corrente e ne apre la successiva.
   *
   * Crash-consistent transition (process-crash/restart scope): with a
   * transcript present the boundary crosses two durable files, so the intent
   * is committed BEFORE the rotation and the generation AFTER it — three
   * atomic whole-file operations, recoverable in `generationOf` from the
   * active/archive pair:
   *
   * 1. sidecar ← `{v2, g:N, pending:{to:N+1}}` (INTENT);
   * 2. transcript renamed to the generation-bound archive `<id>.gN.jsonl`
   *    (ROTATE — one atomic rename of a pre-bound name; refuses if the
   *    destination already exists instead of silently replacing it);
   * 3. sidecar ← `{v2, g:N+1}` (COMMIT — pending cleared in the same op).
   *
   * With no transcript there is only step 3 (single op, no partial state):
   * a bare `/new` still ends the previous conversation's provider stickiness
   * — the `/new` intent draws the boundary, not the physical transcript.
   *
   * The first read resolves any interrupted transition, so retrying after a
   * crash completes rather than duplicates: recovery is idempotent, while a
   * later explicit `/new` stays a new intent and advances again (no
   * command-level exactly-once — the surface carries no dedupe id, and this
   * slice does not invent one).
   *
   * Same-process serialization holds by construction (fully synchronous, no
   * await points — concurrent async callers cannot interleave). Concurrent
   * `/new` from separate processes on one session is NOT safe (pre-existing
   * rotation race; CLI and gateway share one home) — documented limitation,
   * unchanged by this protocol.
   *
   * Corrupt metadata aborts BEFORE any state changes: neither the transcript
   * nor the generation moves when the current generation cannot be stated.
   */
  newConversation(session: SessionRef, hooks?: NewConversationHooks): string | null {
    const generation = this.generationOf(session);
    if (!existsSync(session.file)) {
      this.writeMetadata(session.id, {
        version: CONVERSATION_METADATA_VERSION,
        generation: generation + 1,
      });
      return null;
    }
    const archivio = this.archiveFile(session.id, generation);
    if (existsSync(archivio)) {
      throw new Error(
        `session ${session.id}: conversation archive already exists at ${archivio} — refusing to replace generation ${generation}'s transcript`,
      );
    }
    this.writeMetadata(session.id, {
      version: CONVERSATION_METADATA_VERSION,
      generation,
      pending: { to: generation + 1 },
    });
    hooks?.afterIntent?.();
    renameSync(session.file, archivio);
    hooks?.afterRotate?.();
    this.writeMetadata(session.id, {
      version: CONVERSATION_METADATA_VERSION,
      generation: generation + 1,
    });
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
   * group/topic key carries its own. Never `.jsonl`-suffixed as the active
   * transcript, so transcript readers never see it; the generation-bound
   * archives below share the suffix but are addressed by exact derived
   * names, never globbed.
   */
  private generationFile(sessionId: string): string {
    return join(this.dir, `${sessionId}.conv.json`);
  }

  /**
   * Where generation N's transcript rests after the N → N+1 rotation.
   *
   * Deterministic per generation and derived — never persisted, never
   * accepted from outside: recovery decides from the active/archive pair,
   * and a persisted path would let a hand-edited sidecar point the decision
   * at an arbitrary file under (or outside) the session directory. Rotation
   * refuses a pre-existing destination, so POSIX rename can never silently
   * replace one generation's archive with another's.
   */
  private archiveFile(sessionId: string, generation: number): string {
    return join(this.dir, `${sessionId}.g${generation}.jsonl`);
  }

  /**
   * Durable sidecar write, atomic: temporary file on the same filesystem,
   * then rename. A torn write leaves either the old object or the new one
   * behind — never a half file that `generationOf` would then have to
   * interpret (and a half file would fail its JSON parse loudly anyway).
   */
  private writeMetadata(sessionId: string, metadata: ConversationMetadata): void {
    const dest = this.generationFile(sessionId);
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(metadata), 'utf8');
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
