import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

describe('rotate: la conversazione di prima si chiude senza cambiare id', () => {
  /**
   * Serve a `/new` dove l'id non è libero — Telegram lo deriva dalla chat.
   * Quello che deve valere è che l'id resti lo stesso (altrimenti sarebbe
   * un'altra chat) e che la storia non venga distrutta: `/new` si scrive di
   * fretta, e tre lettere non possono cancellare una conversazione.
   */
  it('mette il file da parte e riparte vuota, stesso id', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const s = store.open('telegram:123');
    store.append(s, msg('user', 'ciao'));
    expect(store.read(s)).toHaveLength(1);

    const archivio = store.rotate(s, new Date('2026-08-28T10:00:00.000Z'));

    expect(archivio).not.toBeNull();
    expect(existsSync(archivio!)).toBe(true);
    // Stesso id, stesso file: è la stessa chat che riparte, non un'altra.
    expect(store.open('telegram:123').file).toBe(s.file);
    expect(store.read(s)).toEqual([]);
    // La storia esiste ancora, nel file messo da parte.
    expect(readFileSync(archivio!, 'utf8')).toContain('ciao');
  });

  /** Una conversazione mai cominciata è già nuova: non è un errore, è `null`. */
  it('e su una conversazione mai cominciata non archivia niente', () => {
    const store = new SessionStore(home());
    expect(store.rotate(store.open('telegram:123'))).toBeNull();
  });
});

describe('conversation generation · principal != session != conversation != turn', () => {
  it('legacy senza sidecar: generation 0, e open() non scrive niente', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    expect(ref.generation).toBe(0);
    expect(store.generationOf(ref)).toBe(0);
    // Aprire non crea identità: nessun sidecar nasce da una read.
    expect(readdirSync(join(dir, 'sessions'))).toEqual([]);
  });

  it('sopravvive al restart: una seconda istanza rilegge la stessa generation', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'ciao'));
    expect(store.newConversation(ref)).not.toBeNull();

    const restarted = new SessionStore(dir);
    expect(restarted.open('owner').generation).toBe(1);
  });

  it('/new avanza g0 -> g1 -> g2', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'uno'));
    store.newConversation(ref);
    expect(store.open('owner').generation).toBe(1);
    store.append(ref, msg('user', 'due'));
    store.newConversation(ref);
    expect(store.open('owner').generation).toBe(2);
  });

  it('/new con transcript assente incrementa comunque e non archivia niente', () => {
    // L'intento decide il confine, non il file: un `/new` a conversazione
    // vuota chiude comunque lo stickiness della precedente.
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    expect(store.newConversation(ref)).toBeNull();
    expect(store.open('owner').generation).toBe(1);
  });

  it('quando il transcript esiste viene archiviato come prima, senza distruzione', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'ciao'));
    const archivio = store.newConversation(ref, new Date('2026-09-19T10:00:00.000Z'));
    expect(archivio).not.toBeNull();
    expect(readFileSync(archivio!, 'utf8')).toContain('ciao');
    expect(store.read(ref)).toEqual([]);
    expect(store.open('owner').generation).toBe(1);
  });

  it('sessioni diverse hanno generation indipendenti', () => {
    const dir = home();
    const store = new SessionStore(dir);
    store.newConversation(store.open('owner'));
    store.newConversation(store.open('owner'));
    store.newConversation(store.open('telegram:-100'));
    expect(store.open('owner').generation).toBe(2);
    expect(store.open('telegram:-100').generation).toBe(1);
    expect(store.open('telegram:-200').generation).toBe(0);
  });

  it('metadata corrotto non degrada a g0: fallisce loud, su read e su open', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    for (const [name, body] of [
      ['non-json', '{von'],
      ['forma sbagliata', '{"version":1}'],
      ['versione futura', '{"version":999,"generation":2}'],
      ['generation negativa', '{"version":1,"generation":-1}'],
      ['generation non intera', '{"version":1,"generation":"molte"}'],
    ] as const) {
      writeFileSync(join(dir, 'sessions', 'owner.conv.json'), body);
      expect(() => store.generationOf(ref), name).toThrow(/conversation metadata/);
      expect(() => store.open('owner'), name).toThrow(/conversation metadata/);
      // E nemmeno `/new` avanza alla cieca sopra un'identità che non sa leggere.
      expect(() => store.newConversation(ref), name).toThrow(/conversation metadata/);
    }
  });

  it('il sidecar è versionato e non è un transcript', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'ciao'));
    store.newConversation(ref);
    const sidecar = JSON.parse(readFileSync(join(dir, 'sessions', 'owner.conv.json'), 'utf8'));
    expect(sidecar).toEqual({ version: 1, generation: 1 });
  });
});
