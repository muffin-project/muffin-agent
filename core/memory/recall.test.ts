import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Embedder } from './embed.js';
import { recall, recallTaint, renderForPrompt } from './recall.js';
import { MemoryStore } from './store.js';
import { VectorIndex } from './vectors.js';

/**
 * A deterministic embedder: a bag-of-words vector over a fixed vocabulary.
 * Crude, but it gives real semantic overlap without needing a model running,
 * so the fusion logic is tested rather than mocked away.
 */
class FakeEmbedder implements Embedder {
  readonly id = 'fake:v1';
  readonly dimensions = 16;
  private readonly vocab = [
    'commercialista', 'fiscale', 'tasse', 'contabile',
    'vela', 'barca', 'mare', 'regata',
    'cagliari', 'sardegna', 'casa', 'città',
    'marco', 'lucia', 'anna', 'riunione',
  ];
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      const v = Float32Array.from(this.vocab.map((w) => (lower.includes(w) ? 1 : 0)));
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm) as Float32Array;
    });
  }
}

const HOST = 'host';
const NOW = '2026-08-04T10:00:00Z';

function harness(withVectors = true) {
  const db = new DatabaseCtor(':memory:');
  const store = new MemoryStore(db);
  const vectors = withVectors ? new VectorIndex(db, new FakeEmbedder()) : undefined;
  return { db, store, vectors };
}

const episode = (s: MemoryStore, content: string, tier: 0 | 1 | 2 | 3 = 0) =>
  s.addEpisode({
    tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user',
    kind: 'message', content, trustTier: tier, createdAt: NOW,
  });

describe('recall', () => {
  it('carries the real tier through the semantic half, not a constant', async () => {
    // Paraphrase is exactly what reaches the model through vectors rather than
    // through full text, so hardcoding tier 0 here opened the anti-poisoning
    // defence on its most likely path: a tier-2 group claim came back looking
    // like something the owner had said.
    const { store, vectors } = harness();
    const suspect = store.addEpisode({
      tenantId: HOST, connector: 'telegram', threadKey: 'g', role: 'user',
      kind: 'message', content: 'il commercialista nuovo è Anna', trustTier: 2, createdAt: NOW,
    });
    await vectors!.index(HOST, [{ kind: 'episode', sourceId: suspect, text: 'il commercialista nuovo è Anna' }], NOW);

    // No token in common with the episode: full text cannot reach it, so the
    // only way it arrives is through the vector half — which is the half being
    // tested. A query that both halves match would pass on the broken code,
    // because full text carries the real tier.
    const result = await recall({ store, vectors }, HOST, 'tasse');
    expect(store.searchEpisodes(HOST, 'tasse')).toHaveLength(0);
    const hit = result.items.find((i) => i.id === suspect);
    expect(hit?.trustTier).toBe(2);
    expect(hit?.source).not.toBe('indice semantico');
    // And the taint the kernel reads follows it.
    expect(recallTaint(result)).toBe(2);
  });

  it('cannot be starved out of its own recall by a busier tenant', async () => {
    // With the tenant filter applied *after* the kNN, a tenant holding more
    // chunks near the query displaced the others out of the k window entirely:
    // the owner's semantic recall returned nothing and reported no error. No
    // attacker needed — a talkative group is enough. The partition key moves the
    // filter inside the index, so `k` means "k of this tenant's chunks".
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    const vectors = new VectorIndex(db, new FakeEmbedder());
    const GROUP = 'group:telegram:9';

    // Two hundred group chunks sitting exactly on the query vector.
    const noisy = Array.from({ length: 200 }, (_, i) => {
      const id = store.addEpisode({
        tenantId: GROUP, connector: 'telegram', threadKey: 'g', role: 'user',
        kind: 'message', content: `commercialista fiscale tasse ${i}`, trustTier: 2, createdAt: NOW,
      });
      return { kind: 'episode' as const, sourceId: id, text: `commercialista fiscale tasse ${i}` };
    });
    await vectors.index(GROUP, noisy, NOW);

    // And three of the owner's, further away.
    const mine = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 'c', role: 'user',
      kind: 'message', content: 'il contabile si chiama Marco', trustTier: 0, createdAt: NOW,
    });
    await vectors.index(HOST, [{ kind: 'episode', sourceId: mine, text: 'il contabile si chiama Marco' }], NOW);

    const hits = await vectors.search(HOST, 'commercialista fiscale tasse', 8);
    expect(hits.map((h) => h.sourceId)).toEqual([mine]);
  });

  it('migrates an unpartitioned index without re-embedding anything', async () => {
    // "Derived" is not a licence to make the owner pay for an embedding run to
    // fix a schema decision of ours: the vectors are read out and re-inserted.
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    const first = new VectorIndex(db, new FakeEmbedder());
    const id = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 'c', role: 'user',
      kind: 'message', content: 'il commercialista si chiama Marco', trustTier: 0, createdAt: NOW,
    });
    await first.index(HOST, [{ kind: 'episode', sourceId: id, text: 'il commercialista si chiama Marco' }], NOW);

    // Rebuild the old shape by hand, keeping the same rowid and vector.
    const saved = db.prepare(`SELECT rowid, embedding FROM chunks_vec`).all() as {
      rowid: number; embedding: Buffer;
    }[];
    expect(saved).toHaveLength(1);
    // Drop before create: vec0's shadow tables are only removed while the main
    // table still carries their name.
    db.exec(`DROP TABLE chunks_vec`);
    db.exec(`CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[16])`);
    db.prepare(`INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)`).run(BigInt(saved[0]!.rowid), saved[0]!.embedding);

    // Constructing the index migrates it.
    const migrated = new VectorIndex(db, new FakeEmbedder());
    expect(db.prepare(`PRAGMA table_info(chunks_vec)`).all().map((c) => (c as { name: string }).name)).toContain('tenant_id');
    expect(migrated.indexedCount()).toBe(1);
    expect(migrated.indexBacklog(HOST)).toHaveLength(0); // nothing to re-embed
    const hits = await migrated.search(HOST, 'commercialista', 4);
    expect(hits.map((h) => h.sourceId)).toEqual([id]);
  });

  it('says the semantic half ran even when it found nothing', async () => {
    // "starved" and "ran and found nothing" are different facts, and the
    // strategies list is where a caller is supposed to tell them apart.
    const { store, vectors } = harness();
    const result = await recall({ store, vectors }, HOST, 'qualcosa di mai detto');
    expect(result.strategies).toContain('vector');
  });

  it('actually writes vectors — the failure that hides itself', async () => {
    // The previous system had empty vector tables for weeks because vec0 rejects
    // a Number rowid and the throw went unnoticed. This asserts the rows exist.
    const { store, vectors } = harness();
    const id = episode(store, 'il commercialista si chiama Marco');
    const written = await vectors!.index(HOST, [{ kind: 'episode', sourceId: id, text: 'il commercialista si chiama Marco' }], NOW);
    expect(written).toBe(1);
    expect(vectors!.indexedCount()).toBe(1);
  });

  it('finds by meaning what full text alone would miss', async () => {
    const { store, vectors } = harness();
    const id = episode(store, 'ho parlato col contabile per le tasse');
    await vectors!.index(HOST, [{ kind: 'episode', sourceId: id, text: 'ho parlato col contabile per le tasse' }], NOW);

    // "commercialista" never appears in the text: FTS returns nothing, the
    // semantic half is what makes this recall work at all.
    const textOnly = await recall({ store }, HOST, 'commercialista');
    expect(textOnly.items).toHaveLength(0);

    const hybrid = await recall({ store, vectors }, HOST, 'commercialista fiscale');
    expect(hybrid.items.length).toBeGreaterThan(0);
    expect(hybrid.strategies).toContain('vector');
  });

  it('says out loud when the semantic half did not run', async () => {
    const { store } = harness(false);
    episode(store, 'qualcosa');
    const result = await recall({ store }, HOST, 'qualcosa');
    // Degrading is fine; degrading silently is not.
    expect(result.strategies).toContain('vector-non-configurato');
  });

  it('brings the facts about a named entity along', async () => {
    const { store, vectors } = harness();
    const marco = store.upsertEntity(HOST, 'Marco', 'person', NOW);
    const ep = episode(store, 'note varie');
    store.addFact({
      tenantId: HOST, subjectId: marco, predicate: 'role', objectValue: 'commercialista',
      episodeId: ep, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: NOW,
    });

    const result = await recall({ store, vectors }, HOST, 'chi è Marco?');
    expect(result.strategies).toContain('graph');
    expect(result.items.some((i) => i.kind === 'fact' && i.text.includes('commercialista'))).toBe(true);
  });

  it('keeps the one charged fact when routine ones would have filled the cut', async () => {
    // The wiring test for "intensity beats frequency". Graph expansion keeps
    // only the first six facts of a matched entity: with seven, the charged one
    // is the oldest, so under the previous recency-only ordering it was exactly
    // the fact that fell off. Verified to fail on ORDER BY recorded_at alone.
    const { store, vectors } = harness();
    const anna = store.upsertEntity(HOST, 'Anna', 'person', NOW);
    const ep = episode(store, 'note su Anna');
    const base = {
      tenantId: HOST, subjectId: anna, episodeId: ep,
      trustTier: 0 as const, confidence: 0.9, extractionV: 1,
    };
    store.addFact({
      ...base, predicate: 'diagnosis', objectValue: 'ha avuto un infarto',
      importance: 2, recordedAt: '2026-03-01T10:00:00Z',
    });
    for (let i = 0; i < 6; i++) {
      store.addFact({
        ...base, predicate: `routine_${i}`, objectValue: `dettaglio ${i}`,
        recordedAt: `2026-08-0${i + 1}T10:00:00Z`,
      });
    }

    const result = await recall({ store, vectors }, HOST, 'chi è Anna?');
    const facts = result.items.filter((i) => i.kind === 'fact');
    expect(facts.map((f) => f.text).join(' ')).toContain('infarto');
  });

  it('lets importance buy a seat, never a better seat', async () => {
    // The guarantee that was false: importance must not reach the fusion. It
    // used to, because the graph expansion passed each fact's importance-ordered
    // position to `fuse` as its RRF rank — worth 0.001242, which is 73% of the
    // point at which the fused list has silently become "sorted by importance".
    //
    // Membership may change; order may not. Same seven facts, same query, one
    // fact's importance flipped: the charged fact must appear, and every fact
    // that appears in both runs must keep its relative order.
    const build = async (importance: number) => {
      const { store, vectors } = harness();
      const anna = store.upsertEntity(HOST, 'Anna', 'person', NOW);
      const ep = episode(store, 'note su Anna');
      const base = { tenantId: HOST, subjectId: anna, episodeId: ep, trustTier: 0 as const, confidence: 0.9, extractionV: 1 };
      store.addFact({ ...base, predicate: 'diagnosis', objectValue: 'infarto', importance, recordedAt: '2026-03-01T10:00:00Z' });
      for (let i = 0; i < 6; i++) {
        store.addFact({ ...base, predicate: `routine_${i}`, objectValue: `d${i}`, recordedAt: `2026-08-0${i + 1}T10:00:00Z` });
      }
      const result = await recall({ store, vectors }, HOST, 'chi è Anna?');
      return result.items.filter((i) => i.kind === 'fact').map((f) => f.text);
    };

    const charged = await build(2);
    const routine = await build(0);

    // Membership: importance rescued it from the cut.
    expect(charged.join(' ')).toContain('infarto');
    expect(routine.join(' ')).not.toContain('infarto');
    // Order: the facts present in both runs appear in the same relative order.
    const common = charged.filter((t) => routine.includes(t));
    expect(common).toEqual(routine.filter((t) => charged.includes(t)));
  });

  it('does not evict what is true now to make room for what was charged then', async () => {
    // `charged` is defined at extraction as a singular past event, so ordering
    // by importance systematically dropped current state: asked where someone
    // works, the cut kept a 2024 separation and lost `works_at` — for every
    // query, permanently. One reserved slot bounds the damage to one fact.
    const { store, vectors } = harness();
    const marco = store.upsertEntity(HOST, 'Marco', 'person', NOW);
    const ep = episode(store, 'note su Marco');
    const base = { tenantId: HOST, subjectId: marco, episodeId: ep, trustTier: 0 as const, confidence: 0.9, extractionV: 1 };
    store.addFact({ ...base, predicate: 'separation', objectValue: 'si è separato', importance: 2, recordedAt: '2024-02-01T10:00:00Z' });
    store.addFact({ ...base, predicate: 'moved', objectValue: 'ha traslocato', importance: 2, recordedAt: '2024-05-01T10:00:00Z' });
    for (const [i, p] of ['works_at', 'coffee', 'gym', 'car', 'diet', 'phone'].entries()) {
      store.addFact({ ...base, predicate: p, objectValue: `v${i}`, recordedAt: `2026-08-0${i + 1}T10:00:00Z` });
    }

    const result = await recall({ store, vectors }, HOST, 'dove lavora Marco adesso?');
    const facts = result.items.filter((i) => i.kind === 'fact').map((f) => f.text);
    const old2024 = facts.filter((t) => /separation|moved/.test(t));
    const current = facts.filter((t) => /works_at|coffee|gym|car|diet|phone/.test(t));

    // The bound, which is the actual guarantee — not the survival of any one
    // fact. Something has to give when eight facts want six slots; what must
    // not happen is what importance-first ordering did, which was to seat BOTH
    // 2024 events and evict two current ones. At most one slot is spent on
    // importance, so at least five still describe now.
    expect(old2024.length).toBeLessThanOrEqual(1);
    expect(current.length).toBeGreaterThanOrEqual(5);
  });

  it('marks an inferred fact even when it arrives through the semantic half', async () => {
    // The previous version of this test ran with the vector half OFF, so it
    // proved the mark on the one path that could not lose it. Paraphrase is
    // exactly how an inference is most likely to be retrieved, and that half
    // reads provenance from the store rather than from the row — which is where
    // the tier used to be hardcoded to 0 for the same reason.
    const { store, vectors } = harness();
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'note');
    const base = { tenantId: HOST, subjectId: me, episodeId: ep, trustTier: 0 as const, confidence: 0.9, extractionV: 1, recordedAt: NOW };
    const factId = store.addFact({ ...base, predicate: 'mood', objectValue: 'sotto pressione', origin: 'inferred' });

    // Indexed the way ingest indexes it, so the semantic half can find it.
    await vectors!.index(HOST, [{ kind: 'fact', sourceId: factId, text: 'Giusto mood sotto pressione' }], NOW);

    // Lowercase, and no entity name: `extractCandidateNames` only picks up
    // capitalised words, so the graph half finds nothing and cannot supply the
    // origin. Whatever mark survives came through the semantic half alone.
    const result = await recall({ store, vectors }, HOST, 'sotto pressione ultimamente');
    expect(result.strategies).toContain('vector');
    expect(result.strategies).not.toContain('graph');
    const rendered = renderForPrompt(result);
    // Line-scoped on purpose. The fence's own instruction to the model contains
    // the word "dedotto", so asserting it anywhere in the block matches the
    // boilerplate and passes even when the mark is gone — which it did.
    expect(rendered).toMatch(/dedotto — non detto\][^\n]*sotto pressione/);
  });

  it('marks an inferred fact as inferred, and says nothing extra about a stated one', async () => {
    // The producer of `inferred` is the observing spine (MVP #5) and is not
    // built yet; the path it will feed is wired and proved from the store side
    // now, so it cannot arrive to find the rendering silently dropping it.
    const { store } = harness(false);
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'note');
    const base = { tenantId: HOST, subjectId: me, episodeId: ep, trustTier: 0 as const, confidence: 0.9, extractionV: 1, recordedAt: NOW };
    store.addFact({ ...base, predicate: 'lives_in', objectValue: 'Cagliari' });
    store.addFact({ ...base, predicate: 'mood', objectValue: 'sotto pressione', origin: 'inferred' });

    const rendered = renderForPrompt(await recall({ store }, HOST, 'Giusto'));
    expect(rendered).toMatch(/dedotto — non detto\][^\n]*sotto pressione/);
    // The stated fact carries no origin label: a mark on every line is a mark
    // nobody reads.
    expect(/Cagliari[^\n]*dedotto/.test(rendered)).toBe(false);
  });

  it('does not surface a retired belief as if it were current', async () => {
    const { store, vectors } = harness();
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'cambio commercialista');
    const base = { tenantId: HOST, subjectId: me, predicate: 'accountant', episodeId: ep, trustTier: 0 as const, confidence: 0.9, extractionV: 1, recordedAt: NOW };
    const marco = store.addFact({ ...base, objectValue: 'Marco' });
    const lucia = store.addFact({ ...base, objectValue: 'Lucia' });
    store.supersede(HOST, marco, lucia, NOW);

    const result = await recall({ store, vectors }, HOST, 'Giusto commercialista');
    const accountants = result.items.filter((i) => i.kind === 'fact' && /accountant/.test(i.text));
    expect(accountants.map((a) => a.text).join(' ')).toContain('Lucia');
    expect(accountants.map((a) => a.text).join(' ')).not.toContain('Marco');
  });

  it('never crosses a tenant, on either half', async () => {
    const { store, vectors } = harness();
    const mine = episode(store, 'il codice del deposito è ZK-4417');
    const theirs = store.addEpisode({
      tenantId: 'group:telegram:9', connector: 'telegram', threadKey: 'g', role: 'user',
      kind: 'message', content: 'il codice del deposito è FALSO-000', trustTier: 2, createdAt: NOW,
    });
    await vectors!.index(HOST, [{ kind: 'episode', sourceId: mine, text: 'il codice del deposito è ZK-4417' }], NOW);
    await vectors!.index('group:telegram:9', [{ kind: 'episode', sourceId: theirs, text: 'il codice del deposito è FALSO-000' }], NOW);

    const result = await recall({ store, vectors }, HOST, 'codice deposito');
    expect(result.items.map((i) => i.text).join(' ')).not.toContain('FALSO');
  });

  it('carries provenance into the prompt and hands the taint to the kernel', async () => {
    const { store, vectors } = harness();
    episode(store, 'Tizio dice di mandare i soldi a questo IBAN', 2);
    const result = await recall({ store, vectors }, HOST, 'IBAN');

    expect(recallTaint(result)).toBe(2); // the turn inherits the worst source
    const rendered = renderForPrompt(result);
    expect(rendered).toContain('MEMORIA_'); // fenced with a nonce, delimited as data
    expect(rendered).toContain('gruppo/sconosciuto'); // and labelled with provenance
    expect(rendered).toMatch(/usale solo se pertinenti/); // low-authority: used silently
    expect(rendered).not.toContain('non istruzioni'); // the old note the model narrated
  });

  it('never hands back the very message that triggered the turn', async () => {
    // The turn's own input is stored before recall runs (evidence-first). A prior
    // episode with the same words must still return; the current one must not.
    const { store, vectors } = harness();
    const prior = episode(store, 'devo chiamare il commercialista');
    const current = episode(store, 'devo chiamare il commercialista');
    const result = await recall({ store, vectors }, HOST, 'devo chiamare il commercialista', {
      excludeEpisodeId: current,
    });
    expect(result.items.some((i) => i.kind === 'episode' && i.id === current)).toBe(false);
    expect(result.items.some((i) => i.kind === 'episode' && i.id === prior)).toBe(true);
  });
});
