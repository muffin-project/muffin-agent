import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SessionMessage, SessionStore } from './store.js';

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

  it('/new avanza g0 -> g1 -> g2, un archivio deterministico per generation', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'uno'));
    const a0 = store.newConversation(ref);
    expect(a0).not.toBeNull();
    expect(a0!).toContain('owner.g0.jsonl');
    expect(store.open('owner').generation).toBe(1);
    store.append(ref, msg('user', 'due'));
    const a1 = store.newConversation(ref);
    expect(a1!).toContain('owner.g1.jsonl');
    expect(store.open('owner').generation).toBe(2);
    // Ogni archivio tiene la sua generation, mai mescolati né saltati.
    expect(readFileSync(a0!, 'utf8')).toContain('uno');
    expect(readFileSync(a0!, 'utf8')).not.toContain('due');
    expect(readFileSync(a1!, 'utf8')).toContain('due');
  });

  it('/new con transcript assente incrementa comunque e non archivia niente', () => {
    // L'intento decide il confine, non il file: un `/new` a conversazione
    // vuota chiude comunque lo stickiness della precedente. Percorso a una
    // sola operazione durevole: i ganci di faglia non scattano proprio.
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    const fired: string[] = [];
    expect(
      store.newConversation(ref, {
        afterIntent: () => void fired.push('intent'),
        afterRotate: () => void fired.push('rotate'),
      }),
    ).toBeNull();
    expect(fired).toEqual([]);
    expect(store.open('owner').generation).toBe(1);
  });

  it('quando il transcript esiste viene archiviato come prima, senza distruzione', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'ciao'));
    const archivio = store.newConversation(ref);
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
    expect(sidecar).toEqual({ version: 2, generation: 1 });
  });

  it('v1 stabile si legge come steady, e il primo /new lo porta a v2', () => {
    // Backward compat: ogni file scritto dalla slice precedente resta valido.
    const dir = home();
    const store = new SessionStore(dir);
    writeFileSync(join(dir, 'sessions', 'owner.conv.json'), '{"version":1,"generation":3}');
    expect(store.open('owner').generation).toBe(3);
    store.append(store.open('owner'), msg('user', 'dopo'));
    store.newConversation(store.open('owner'));
    const sidecar = JSON.parse(readFileSync(join(dir, 'sessions', 'owner.conv.json'), 'utf8'));
    expect(sidecar).toEqual({ version: 2, generation: 4 });
  });

  it('v1 con pending è corrotto: un lettore vecchio lo ignorerebbe e splittrebbe', () => {
    const dir = home();
    const store = new SessionStore(dir);
    writeFileSync(
      join(dir, 'sessions', 'owner.conv.json'),
      '{"version":1,"generation":0,"pending":{"to":1}}',
    );
    expect(() => store.open('owner')).toThrow(/transition state/);
  });

  it('un lettore v1 rifiuta i file v2 invece di ignorarne la semantica', () => {
    // Replica del predicato di accettazione v1 (version === 1, pending
    // ignorato): deve dire no a ciò che scriviamo adesso, ad alta voce.
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'ciao'));
    store.newConversation(ref);
    const raw = readFileSync(join(dir, 'sessions', 'owner.conv.json'), 'utf8');
    const v1Accepts = (JSON.parse(raw) as { version?: unknown }).version === 1;
    expect(v1Accepts).toBe(false);
  });
});

describe('conversation generation · crash-consistency del confine /new', () => {
  const crash = () => {
    throw new Error('simulated process crash');
  };

  it('B1: crash dopo intent, prima di rotate → vecchia conversazione interamente attiva', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'ciao'));
    expect(() => store.newConversation(ref, { afterIntent: crash })).toThrow(
      'simulated process crash',
    );

    // Restart: un'altra istanza, come dopo un crash vero.
    const restarted = new SessionStore(dir);
    expect(restarted.open('owner').generation).toBe(0);
    // Transcript intatto, intent ritirato, file stabile senza pending.
    expect(restarted.read(restarted.open('owner')).map((m) => m.content)).toEqual(['ciao']);
    expect(JSON.parse(readFileSync(join(dir, 'sessions', 'owner.conv.json'), 'utf8'))).toEqual({
      version: 2,
      generation: 0,
    });
    // Idempotente: riaprire non avanza mai una seconda volta.
    expect(restarted.open('owner').generation).toBe(0);
    expect(restarted.open('owner').generation).toBe(0);
    // E il /new successivo funziona da capo, una sola volta.
    restarted.newConversation(restarted.open('owner'));
    expect(restarted.open('owner').generation).toBe(1);
  });

  it('B2: crash dopo rotate, prima di commit → nuova conversazione interamente attiva', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'ciao'));
    expect(() => store.newConversation(ref, { afterRotate: crash })).toThrow(
      'simulated process crash',
    );

    // Il falsifier originale: MAI vecchia identità + transcript svuotato.
    const restarted = new SessionStore(dir);
    const reopened = restarted.open('owner');
    expect(reopened.generation).toBe(1);
    expect(restarted.read(reopened)).toEqual([]);
    expect(readFileSync(join(dir, 'sessions', 'owner.g0.jsonl'), 'utf8')).toContain('ciao');
    expect(JSON.parse(readFileSync(join(dir, 'sessions', 'owner.conv.json'), 'utf8'))).toEqual({
      version: 2,
      generation: 1,
    });
    // Idempotente: nessun doppio avanzamento al riaprire.
    expect(restarted.open('owner').generation).toBe(1);
    expect(restarted.open('owner').generation).toBe(1);
  });

  it('B3: crash dopo commit → open è no-op, un /new dopo è un nuovo intento', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'ciao'));
    store.newConversation(ref);
    const committed = readFileSync(join(dir, 'sessions', 'owner.conv.json'), 'utf8');

    // Il caller è morto prima di osservare, ma lo stato è intero: reopen non tocca niente.
    const restarted = new SessionStore(dir);
    expect(restarted.open('owner').generation).toBe(1);
    expect(readFileSync(join(dir, 'sessions', 'owner.conv.json'), 'utf8')).toBe(committed);
    // Un /new esplicito dopo è un nuovo confine, non un retry: avanza, non duplica.
    restarted.newConversation(restarted.open('owner'));
    expect(restarted.open('owner').generation).toBe(2);
  });

  it('coppia ambigua attiva+archivio → fail loud, mai un guess', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'ciao'));
    // Stato che il protocollo non può produrre: intent + transcript ancora
    // attivo + archivio già presente (mano esterna o interleave fuori scope).
    writeFileSync(
      join(dir, 'sessions', 'owner.conv.json'),
      '{"version":2,"generation":0,"pending":{"to":1}}',
    );
    writeFileSync(join(dir, 'sessions', 'owner.g0.jsonl'), 'archivio piantato');
    expect(() => store.open('owner')).toThrow(/ambiguous conversation transition/);
    expect(() => store.newConversation(ref)).toThrow(/ambiguous conversation transition/);
    // Loud non distrugge: niente si è mosso.
    expect(store.read(ref).map((m) => m.content)).toEqual(['ciao']);
  });

  it('coppia ambigua né attiva né archivio → fail loud, mai g0 silenzioso', () => {
    const dir = home();
    const store = new SessionStore(dir);
    store.open('owner');
    // Intent senza né transcript né archivio: il transcript è sparito fuori
    // dal protocollo. Tornare g0 in silenzio sarebbe il merge che chiudiamo.
    writeFileSync(
      join(dir, 'sessions', 'owner.conv.json'),
      '{"version":2,"generation":0,"pending":{"to":1}}',
    );
    expect(() => store.open('owner')).toThrow(/ambiguous conversation transition/);
  });

  it('pending diverso da N → N+1 è mano esterna: fail loud', () => {
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    for (const [name, pending] of [
      ['stale (to == g)', '{"to":0}'],
      ['salto (to == g+2)', '{"to":2}'],
      ['negativo', '{"to":-1}'],
      ['non intero', '{"to":"1"}'],
      ['chiavi extra', '{"to":1,"archive":"x"}'],
      ['non oggetto', '[1]'],
      ['null', 'null'],
    ] as const) {
      writeFileSync(
        join(dir, 'sessions', 'owner.conv.json'),
        `{"version":2,"generation":0,"pending":${pending}}`,
      );
      expect(() => store.generationOf(ref), name).toThrow(/conversation metadata/);
      expect(() => store.open('owner'), name).toThrow(/conversation metadata/);
      expect(() => store.newConversation(ref), name).toThrow(/conversation metadata/);
    }
  });

  it('destinazione archivio preesistente → /new rifiuta, niente viene sostituito', () => {
    // POSIX rename rimpiazzerebbe in silenzio: il confine lo vieta.
    const dir = home();
    const store = new SessionStore(dir);
    const ref = store.open('owner');
    store.append(ref, msg('user', 'ciao'));
    writeFileSync(join(dir, 'sessions', 'owner.g0.jsonl'), 'archivio piantato');
    expect(() => store.newConversation(ref)).toThrow(/already exists/);
    // Niente si è mosso: né transcript né sidecar.
    expect(store.read(ref).map((m) => m.content)).toEqual(['ciao']);
    expect(existsSync(join(dir, 'sessions', 'owner.conv.json'))).toBe(false);
    expect(store.open('owner').generation).toBe(0);
  });
});

describe('SessionStore fail-closed sul parent privato (#639)', () => {
  it('il costruttore attraverso un ancestor symlink lancia senza creare fuori', () => {
    const root = mkdtempSync(join(tmpdir(), 'muffin-session-esc-'));
    try {
      const outside = join(root, 'outside');
      mkdirSync(outside, { recursive: true });
      chmodSync(outside, 0o755);
      const before = statSync(outside).mode & 0o777;
      symlinkSync(outside, join(root, 'link'));
      expect(() => new SessionStore(join(root, 'link'))).toThrow(/directory privata/);
      expect(existsSync(join(outside, 'sessions'))).toBe(false);
      expect(statSync(outside).mode & 0o777).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('open: un id esterno non puo diventare un percorso (#638)', () => {
  /**
   * `open(id)` unisce `sessions/<id>.jsonl`: un id con `/` esce dalla
   * directory delle sessioni. Il canale di controllo accetta `sessionId` dal
   * chiamante, quindi questo e il primo confine contro un `run` contenuto che
   * prova a farsi aprire un transcript fuori posto.
   */
  it.each([
    '../../evil',
    '..\\evil',
    '/assoluto',
    'a/b',
    '',
    'con spazio',
    'con\nnewline',
    'x'.repeat(129),
  ])('rifiuta %j', (id) => {
    expect(() => new SessionStore(home()).open(id)).toThrow(/unsafe id/i);
  });

  it('accetta gli id che il runtime usa davvero', () => {
    const store = new SessionStore(home());
    for (const id of [
      'owner',
      's1',
      'sess-1',
      'telegram:123456',
      'telegram:-100950#2',
      'job-ab12cd34-ef5678',
      '2026-09-21-abcdef12',
    ]) {
      expect(store.open(id).id).toBe(id);
    }
  });
});
