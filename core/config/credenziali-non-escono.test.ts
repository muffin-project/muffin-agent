import DatabaseCtor from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../memory/store.js';
import { mandatoryGuards } from '../rot/guards.js';
import { SurfaceRegistry } from '../surface/registry.js';
import type { Surface } from '../surface/types.js';
import { TurnStore, type NewTurn } from '../turns/store.js';
import type { Principal } from '../policy/types.js';

/**
 * Una credenziale non esce da nessuna porta.
 *
 * `redactText` esisteva dal 17/08, prendeva cinque forme su cinque, ed era
 * cablata a **una** frontiera di scrittura su sei: `agent/loop.ts` la chiamava
 * sul risultato di un tool e su nient'altro. Misurato il 04/09: una
 * `sk-ant-…` digitata dall'**owner** arrivava intatta al modello e atterrava in
 * `episodes.content`. Un meccanismo che esiste e che la produzione non
 * raggiunge — la forma di guasto che `AGENTS.md` nomina per prima.
 *
 * Un test per porta, e ognuno deve fallire da solo: due difese che si coprono a
 * vicenda sono una difesa sola con due nomi, e quando una salta la suite resta
 * verde.
 *
 * **Il limite, scritto qui perché non venga dimenticato**: un filtro a forma non
 * sopravvive a una Base64. Questo chiude l'eco *accidentale* di una
 * credenziale, mai un'esfiltrazione deliberata. Per quella la difesa è la
 * provenienza, che è un'altra cosa e vive altrove.
 */

/** Una forma che `redactText` riconosce, mai una chiave vera. */
const CHIAVE = `sk-ant-api03-${'A'.repeat(40)}`;

describe('la porta della memoria durevole', () => {
  it('un episodio non conserva una credenziale, nemmeno se a scriverla è l owner', () => {
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    const id = store.addEpisode({
      tenantId: 'host',
      connector: 'cli',
      threadKey: 't',
      role: 'user',
      kind: 'message',
      // Il caso misurato: non un tool, l'owner stesso che incolla la chiave.
      content: `la mia chiave è ${CHIAVE}, tienila da parte`,
      trustTier: 0,
      createdAt: new Date().toISOString(),
    });
    const riga = db.prepare(`SELECT content FROM episodes WHERE id = ?`).get(id) as { content: string };
    expect(riga.content).not.toContain(CHIAVE);
    expect(riga.content).toContain('«redacted:');
    // Il resto della frase sopravvive: si redige il segreto, non il ricordo.
    expect(riga.content).toContain('tienila da parte');
  });
});

describe('la porta della risposta — s6 del corpus', () => {
  it('quello che Muffin dice a chiunque non porta fuori una credenziale', async () => {
    const detto: string[] = [];
    const finta = {
      id: 'prova',
      handles: (c: string) => c === 'prova',
      deliver: async (_c: string, text: string) => {
        detto.push(text);
        return { delivered: true as const };
      },
    } as unknown as Surface;
    const registry = new SurfaceRegistry([finta]);

    const esito = await registry.deliver('prova', `ecco la chiave: ${CHIAVE}`);

    expect(esito.delivered).toBe(true);
    expect(detto).toHaveLength(1);
    expect(detto[0]).not.toContain(CHIAVE);
    expect(detto[0]).toContain('«redacted:');
  });
});

describe('la porta dei turni', () => {
  it('i messaggi salvati non conservano una credenziale, e restano JSON valido', () => {
    const db = new DatabaseCtor(':memory:');
    const store = new TurnStore(db);
    const spec: NewTurn = {
      id: 't1',
      principal: { kind: 'owner', connector: 'cli', externalId: 'local' } as Principal,
      tenant: 'host',
      surface: 'cli',
      sessionId: 's1',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: `usa ${CHIAVE} per favore` }] }],
      taint: 0,
      counters: {
        iterations: 0,
        recoveriesUsed: 0,
        transportRetriesLeft: 2,
        toolCallsMade: 0,
        nudgedForCompletion: false,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        spentUsd: 0,
        resumes: 0,
        contextBuilt: false,
      },
    };
    store.create(spec);

    const riga = db.prepare(`SELECT messages FROM turns WHERE id = ?`).get('t1') as { messages: string };
    expect(riga.messages).not.toContain(CHIAVE);
    expect(riga.messages).toContain('«redacted:');
    // Il marcatore non ha virgolette né backslash: la riga deve restare
    // rileggibile, o la redazione avrebbe rotto ogni turno ripreso.
    expect(() => JSON.parse(riga.messages)).not.toThrow();
    const riletti = JSON.parse(riga.messages) as Array<{ content: Array<{ text: string }> }>;
    expect(riletti[0]!.content[0]!.text).toContain('per favore');
  });
});

describe('le credenziali che questa macchina tiene per altri sistemi', () => {
  /**
   * Misurato il 04/09 sulla macchina dell'owner, con questi stessi guards e il
   * `SandboxExecutor` di produzione: `~/.ssh/id_ed25519` LEGGIBILE 444 byte,
   * `~/.config/gh/hosts.yml` LEGGIBILE 100 byte, `~/.muffin/secrets` negato.
   * La sandbox è allow-by-default in lettura e questa lista era lunga tre voci:
   * proteggeva i segreti che Muffin sa di avere e niente di quelli dell'host.
   */
  it('stanno nella denyRead, non solo quelle di Muffin', () => {
    const g = mandatoryGuards('/casa/.muffin', '/spazio', '/utente');
    for (const atteso of [
      '/utente/.ssh',
      '/utente/.aws',
      '/utente/.gnupg',
      '/utente/.netrc',
      '/utente/.npmrc',
      '/utente/.kube',
      '/utente/.config/gh',
      '/utente/.git-credentials',
    ]) {
      expect(g.denyRead).toContain(atteso);
    }
  });

  it('e quelle di Muffin ci sono ancora — non è una sostituzione', () => {
    const g = mandatoryGuards('/casa/.muffin', '/spazio', '/utente');
    expect(g.denyRead.some((p) => p.includes('secrets'))).toBe(true);
    expect(g.denyRead).toContain(join('/spazio', '.env'));
  });

  it('la lista è ancorata alla home passata, non a quella vera', () => {
    // Un test che leggesse `homedir()` proverebbe la macchina di chi lo esegue
    // — il difetto che `test-che-provano-il-mio-computer` nomina.
    const g = mandatoryGuards('/casa/.muffin', '/spazio', '/utente');
    expect(g.denyRead.every((p) => !p.startsWith(join(homedir(), '.ssh')))).toBe(true);
    expect(g.denyRead).toContain('/utente/.ssh');
  });
});
