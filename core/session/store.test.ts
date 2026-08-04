import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore, type SessionMessage } from './store.js';

const home = () => mkdtempSync(join(tmpdir(), 'muffin-session-'));

const msg = (role: SessionMessage['role'], content: string): SessionMessage => ({
  role,
  content,
  surface: 'cli',
  createdAt: '2026-08-04T17:00:00.000Z',
});

describe('session transcript', () => {
  it('survives a restart', () => {
    const dir = home();
    const ref = new SessionStore(dir).open('s1');
    const writer = new SessionStore(dir);
    writer.append(ref, msg('user', 'ciao'));
    writer.append(ref, msg('assistant', 'ciao a te'));

    // A different instance, as after a crash and a systemd restart.
    const reader = new SessionStore(dir);
    expect(reader.read(reader.open('s1')).map((m) => m.content)).toEqual(['ciao', 'ciao a te']);
  });

  it('drops a half-written last line instead of losing the session', () => {
    // The exact shape of a crash mid-append: the tail is torn, everything
    // before it is still good, and that is what must survive.
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('s2');
    store.append(ref, msg('user', 'prima riga'));
    appendFileSync(ref.file, '{"role":"assistant","cont');

    const messages = store.read(ref);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('prima riga');
  });

  it('keeps content verbatim — this is the record memory will be built from', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('s3');
    const awkward = 'riga con "virgolette", \n a capo e un emoji 🥐';
    store.append(ref, msg('user', awkward));
    expect(store.read(ref)[0]?.content).toBe(awkward);
  });

  it('starts empty for a session that never existed', () => {
    const store = new SessionStore(home());
    expect(store.read(store.open('mai-vista'))).toEqual([]);
  });
});
