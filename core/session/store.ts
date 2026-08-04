import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

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

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

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
