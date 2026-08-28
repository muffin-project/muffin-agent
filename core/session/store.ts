import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
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

export type SessionRef = { id: string; file: string };

export class SessionStore {
  private readonly dir: string;

  constructor(homeDir: string) {
    this.dir = join(homeDir, 'sessions');
    mkdirSync(this.dir, { recursive: true });
  }

  open(id?: string): SessionRef {
    const sessionId = id ?? `${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
    return { id: sessionId, file: join(this.dir, `${sessionId}.jsonl`) };
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
