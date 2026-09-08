/**
 * «Dimentica X» — `memory_forget` retires a belief through the one writer.
 *
 * The property the 08/09 cutover measured as missing: after the owner asks to
 * forget, normal recall (facts and episodes, FTS and vectors) no longer uses
 * it, while history and `why` still show it as retired with provenance.
 * Mutation that must turn this red: removing `store.retireFacts` or
 * `store.supersedeEpisodes` from `retireBeliefs`.
 */
import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Embedder } from '../../core/memory/embed.js';
import { retireBeliefs } from '../../core/memory/ingest.js';
import { describeProvenance } from '../../core/memory/provenance.js';
import { recall, type RecallDeps } from '../../core/memory/recall.js';
import { MemoryStore } from '../../core/memory/store.js';
import { VectorIndex } from '../../core/memory/vectors.js';
import { forgetMemory } from './memory-forget.js';

/** Deterministic, like `recall.test.ts`'s: same text → same vector. */
class FakeEmbedder implements Embedder {
  readonly dimensions = 8;
  readonly id = 'fake';
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(8);
      for (let i = 0; i < t.length; i++) v[i % 8] = (v[i % 8] ?? 0) + t.charCodeAt(i) / 1000;
      return v;
    });
  }
}

const NOW = '2026-09-08T10:00:00Z';
const CTX = { tenant: 'host', turnId: 'turn-forget-1' };

function seed() {
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  const vectors = new VectorIndex(db, new FakeEmbedder());
  const deps: RecallDeps = { store, vectors };
  const me = store.upsertEntity('host', 'Giusto', 'person', NOW);
  const ep = store.addEpisode({
    tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
    content: 'Ricorda che il mio dentista si chiama Dott. Ferrante', trustTier: 0, createdAt: NOW,
  });
  const fact = store.addFact({
    tenantId: 'host', subjectId: me, predicate: 'dentist', objectValue: 'Dott. Ferrante',
    episodeId: ep, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: NOW,
  });
  const other = store.addFact({
    tenantId: 'host', subjectId: me, predicate: 'accountant', objectValue: 'Marco',
    episodeId: ep, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: NOW,
  });
  return { db, store, deps, me, ep, fact, other };
}

describe('memory_forget — «dimentica X» ritira la belief attraverso il writer unico', () => {
  it('senza id elenca i candidati attivi con i loro id, senza toccare nulla', async () => {
    const h = seed();
    const out = await forgetMemory(h.deps, CTX, { query: 'dentista' });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain(`#${h.fact}`);
    expect(out.content).toContain('memory_forget con gli id');
    expect(h.store.activeFacts('host', h.me, 'dentist')).toHaveLength(1);
  });

  it('elenca anche un fatto che il recall non vede: senza vettore e con un episodio che non lo nomina', async () => {
    const h = seed();
    // A fact whose source episode says nothing recall could match on, and no
    // vector for either: the 08/09 case on the owner's install.
    const ep = h.store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user', kind: 'message',
      content: 'ok segnato', trustTier: 0, createdAt: NOW,
    });
    const orphan = h.store.addFact({
      tenantId: 'host', subjectId: h.me, predicate: 'claims', objectValue: 'il codice di prova della sessione viva è ciliegia',
      episodeId: ep, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: NOW,
    });
    const out = await forgetMemory(h.deps, CTX, { query: 'codice di prova della sessione viva' });
    expect(out.content).toContain(`[fact #${orphan}]`);
    expect(out.content).not.toContain(`#${h.other}]`);
  });

  it('con gli id ritira fatto ed episodio: il recall normale non li usa più, la storia sì', async () => {
    const h = seed();
    const out = await forgetMemory(h.deps, CTX, { facts: [h.fact], episodes: [h.ep] }, () => new Date(NOW));
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain(`ritirati 1 fatti: #${h.fact}`);
    expect(out.content).toContain(`ritirati 1 episodi dal recall: #${h.ep}`);

    // The belief is gone from the active set, the other one is untouched.
    expect(h.store.activeFacts('host', h.me, 'dentist')).toHaveLength(0);
    expect(h.store.activeFacts('host', h.me, 'accountant')).toHaveLength(1);
    // Normal recall (FTS over episodes + facts) no longer returns it…
    const now = await recall(h.deps, 'host', 'dentista Ferrante');
    expect(now.items.filter((i) => i.expired !== true && /Ferrante/.test(i.text))).toHaveLength(0);
    // …the episode is excluded, not deleted…
    expect(h.store.searchEpisodes('host', 'Ferrante', 5)).toHaveLength(0);
    expect(h.store.searchEpisodes('host', 'Ferrante', 5, { includeSuperseded: true })).toHaveLength(1);
    // …and provenance says who retired it.
    const retired = h.store.factById('host', h.fact);
    expect(retired?.expiredAt).toBe(new Date(NOW).toISOString());
    expect(retired?.supersededBy).toBeNull();
    expect(retired?.retiredReason).toContain('turno turn-forget-1');
    expect(describeProvenance(h.store, 'host', retired!).lines.join('\n')).toContain('ritirato senza successore');
  });

  it('ritira solo ciò che esiste, è attivo ed è del tenant — e lo dice', async () => {
    const h = seed();
    const guest = h.store.upsertEntity('guest-1', 'Ospite', 'person', NOW);
    const guestEp = h.store.addEpisode({
      tenantId: 'guest-1', connector: 'telegram', threadKey: 'g', role: 'user', kind: 'message',
      content: 'segreto dell\'ospite', trustTier: 2, createdAt: NOW,
    });
    const guestFact = h.store.addFact({
      tenantId: 'guest-1', subjectId: guest, predicate: 'likes', objectValue: 'tè',
      episodeId: guestEp, trustTier: 2, confidence: 0.9, extractionV: 1, recordedAt: NOW,
    });
    const out = await forgetMemory(h.deps, CTX, { facts: [guestFact, 9999], episodes: [guestEp] });
    expect(out.content).toContain('nessun fatto ritirato');
    expect(out.content).toContain('nessun episodio ritirato');
    expect(out.content).toContain(`#${guestFact}`);
    expect(h.store.activeFacts('guest-1', guest, 'likes')).toHaveLength(1);
    expect(h.store.searchEpisodes('guest-1', 'segreto', 5)).toHaveLength(1);
  });

  it('rifiuta argomenti malformati senza scrivere', async () => {
    const h = seed();
    const bad = await forgetMemory(h.deps, CTX, { facts: ['x'] });
    expect(bad.isError).toBe(true);
    const none = await forgetMemory(h.deps, CTX, {});
    expect(none.isError).toBe(true);
    expect(h.store.activeFacts('host', h.me, 'dentist')).toHaveLength(1);
  });

  it('il writer rifiuta mentre l\'estrazione tiene il lock, invece di interfogliarsi', () => {
    const h = seed();
    // A holder that is alive — the parent process — not a dead pid the lock would reap.
    const claim = h.store.acquireIngestLock(new Date(NOW), process.ppid);
    expect('release' in claim).toBe(true);
    expect(() =>
      retireBeliefs(h.store, 'host', { factIds: [h.fact], episodeIds: [], at: new Date(NOW), reason: 'test' }),
    ).toThrow(/memoria occupata/);
    if ('release' in claim) h.store.releaseIngestLock(process.ppid);
    expect(h.store.activeFacts('host', h.me, 'dentist')).toHaveLength(1);
  });
});
