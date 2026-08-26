import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../core/session/store.js';
import type { TurnRecord } from '../core/turns/store.js';
import { recoveredText } from './recovered-text.js';

const record = (id: string, sessionId: string): TurnRecord =>
  ({ id, sessionId, outcome: 'answered' }) as TurnRecord;

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
});
