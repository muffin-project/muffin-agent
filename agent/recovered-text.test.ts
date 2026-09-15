import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../core/session/store.js';
import type { TurnRecord } from '../core/turns/store.js';
import { markProviderErrorReplyForRecovery } from './loop/provider-error-reply.js';
import type { Message } from './providers/types.js';
import { recoveredText } from './recovered-text.js';

const record = (
  id: string,
  sessionId: string,
  outcome: 'answered' | 'error' = 'answered',
  messages: Message[] = [],
): TurnRecord => ({ id, sessionId, outcome, messages }) as unknown as TurnRecord;

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'muffin-recovered-text-'));
  const sessions = new SessionStore(home);
  const ref = sessions.open('telegram:42');
  return { sessions, ref };
}

describe('recoveredText — delivery retry is bound to the Work that produced the answer', () => {
  it('never substitutes a later Work reply from the same session', () => {
    const h = fixture();
    h.sessions.append(h.ref, {
      role: 'assistant',
      content: 'risposta del work A',
      surface: 'telegram',
      createdAt: '2026-08-25T03:00:00Z',
      traceId: 'turn-a',
      tier: 0,
    });
    h.sessions.append(h.ref, {
      role: 'assistant',
      content: 'risposta del work B',
      surface: 'telegram',
      createdAt: '2026-08-25T03:01:00Z',
      traceId: 'turn-b',
      tier: 0,
    });

    expect(recoveredText(h.sessions, record('turn-a', h.ref.id))).toBe('risposta del work A');
    expect(recoveredText(h.sessions, record('turn-b', h.ref.id))).toBe('risposta del work B');
  });

  it('fails honestly rather than borrowing another Work reply when its own answer is absent', () => {
    const h = fixture();
    h.sessions.append(h.ref, {
      role: 'assistant',
      content: 'risposta di un altro work',
      surface: 'telegram',
      createdAt: '2026-08-25T03:01:00Z',
      traceId: 'turn-b',
      tier: 0,
    });

    const recovered = recoveredText(h.sessions, record('turn-a', h.ref.id));
    expect(recovered).toContain('testo originale non è stato recuperato');
    expect(recovered).not.toContain('risposta di un altro work');
  });

  it('recovers the trace-bound terminal provider error reply for an error outcome', () => {
    const h = fixture();
    h.sessions.append(h.ref, {
      role: 'assistant',
      content: 'Il provider non ha completato la richiesta (HTTP 502). Riprova tra poco.',
      surface: 'telegram',
      createdAt: '2026-09-13T14:22:00Z',
      traceId: 'turn-a',
      tier: 0,
    });
    h.sessions.append(h.ref, {
      role: 'assistant',
      content: 'questa risposta appartiene a un altro turno',
      surface: 'telegram',
      createdAt: '2026-09-13T14:23:00Z',
      traceId: 'turn-b',
      tier: 0,
    });

    const terminal = 'Il provider non ha completato la richiesta (HTTP 502). Riprova tra poco.';
    expect(
      recoveredText(
        h.sessions,
        record('turn-a', h.ref.id, 'error', [markProviderErrorReplyForRecovery(terminal)]),
      ),
    ).toBe(terminal);
    expect(
      recoveredText(
        h.sessions,
        record('turn-a', h.ref.id, 'error', [markProviderErrorReplyForRecovery(terminal)]),
      ),
    ).not.toContain('questa risposta appartiene a un altro turno');
  });
});
