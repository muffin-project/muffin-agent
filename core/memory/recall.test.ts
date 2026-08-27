import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { Embedder } from './embed.js';
import { sweepDuplicates } from './maintenance.js';
import { checkTemporalWindow, EVERY_INSTANT, MAX_CONTEXT_ITEMS, recall, recallTaint, renderForPrompt } from './recall.js';
import { RERANK_MIN_CANDIDATES, type Reranker } from './rerank.js';
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

  it("asOf:'all' brings the retired belief back, marked as retired, beside the current one", async () => {
    // `RecallOptions.includeHistory` was declared, threaded through
    // `cli/memory.ts` and `cli/main.ts`, and documented in the USAGE — and
    // `recall()` never read it. `--history` answered exactly like the default
    // search: silently. This is the wiring test that fails without it. The
    // option is now a value of `asOf` rather than a boolean beside it; the
    // property it guards did not change.
    const { store, vectors } = harness();
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'cambio commercialista');
    const base = { tenantId: HOST, subjectId: me, predicate: 'accountant', episodeId: ep, trustTier: 0 as const, confidence: 0.9, extractionV: 1, recordedAt: NOW };
    const marco = store.addFact({ ...base, objectValue: 'Marco' });
    const lucia = store.addFact({ ...base, objectValue: 'Lucia' });
    store.supersede(HOST, marco, lucia, NOW);

    const result = await recall({ store, vectors }, HOST, 'Giusto commercialista', { asOf: EVERY_INSTANT });
    const accountants = result.items.filter((i) => i.kind === 'fact' && /accountant/.test(i.text));
    const retired = accountants.find((a) => a.text.includes('Marco'));
    const current = accountants.find((a) => a.text.includes('Lucia'));
    expect(retired).toBeDefined();
    expect(retired?.expired).toBe(true);
    expect(current).toBeDefined();
    expect(current?.expired).toBe(false);
    // And the retired one says what took its place. Returning "Marco, retired"
    // and stopping there answers "who was it" with half the sentence: the other
    // half — who it is now — is the part that makes the first safe to say.
    expect(retired?.replacedBy?.text).toContain('Lucia');
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

  it('answers who X was on a past date, not who X is now — "chi era X a maggio"', async () => {
    // The acceptance scenario C6 exists to close. Anna is recorded in June,
    // replaced by Bruno in August; asked about May, the honest answer is Anna —
    // not because she was already known then, but because nothing had stopped
    // being true of her yet (`factsAsOf`'s own doc comment walks this exact
    // pair). Asked about a date after the change, the answer flips.
    const { store, vectors } = harness();
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'note aziendali');
    const base = {
      tenantId: HOST, subjectId: me, predicate: 'work_contact', episodeId: ep,
      trustTier: 0 as const, confidence: 0.9, extractionV: 1,
    };
    const anna = store.addFact({ ...base, objectValue: 'Anna', recordedAt: '2026-06-01T10:00:00Z' });
    const bruno = store.addFact({ ...base, objectValue: 'Bruno', recordedAt: '2026-08-01T10:00:00Z' });
    store.supersede(HOST, anna, bruno, '2026-08-01T10:00:00Z');

    const may = await recall({ store, vectors }, HOST, 'Giusto contatto lavoro', {
      asOf: '2026-05-15T00:00:00.000Z',
    });
    const mayText = may.items.filter((i) => i.kind === 'fact' && /work_contact/.test(i.text)).map((f) => f.text).join(' ');
    expect(mayText).toContain('Anna');
    expect(mayText).not.toContain('Bruno');

    const august = await recall({ store, vectors }, HOST, 'Giusto contatto lavoro', {
      asOf: '2026-08-15T00:00:00.000Z',
    });
    const augustText = august.items.filter((i) => i.kind === 'fact' && /work_contact/.test(i.text)).map((f) => f.text).join(' ');
    expect(augustText).toContain('Bruno');
    expect(augustText).not.toContain('Anna');
  });

  it('says it does not know, with the nearest thing on record, instead of answering with today', async () => {
    // The failure this exists to stop: an entity the graph knows about, asked
    // about an instant before anything on record — silence here used to mean
    // "today's belief with no mark on it".
    const { store, vectors } = harness();
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'note aziendali');
    store.addFact({
      tenantId: HOST, subjectId: me, predicate: 'work_contact', objectValue: 'Anna',
      episodeId: ep, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: '2026-06-01T10:00:00Z',
    });

    const result = await recall({ store, vectors }, HOST, 'Giusto contatto lavoro', {
      asOf: '2026-01-01T00:00:00.000Z',
    });
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.entity).toBe('Giusto');
    expect(result.gaps[0]?.nearest?.text).toContain('Anna');

    const rendered = renderForPrompt(result);
    expect(rendered).toContain('lacuna');
    expect(rendered).toContain('non rispondere con quello che vale oggi');
  });

  it('filters episodes to a date window', async () => {
    const { store, vectors } = harness();
    const early = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'promemoria vecchio', trustTier: 0, createdAt: '2026-01-01T10:00:00Z',
    });
    const inWindow = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'promemoria giusto', trustTier: 0, createdAt: '2026-06-15T10:00:00Z',
    });
    const late = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'promemoria nuovo', trustTier: 0, createdAt: '2026-12-01T10:00:00Z',
    });

    const result = await recall({ store, vectors }, HOST, 'promemoria', {
      since: '2026-03-01T00:00:00.000Z',
      until: '2026-09-01T00:00:00.000Z',
    });
    const ids = result.items.filter((i) => i.kind === 'episode').map((i) => i.id);
    expect(ids).toContain(inWindow);
    expect(ids).not.toContain(early);
    expect(ids).not.toContain(late);
    expect(result.strategies.some((s) => s.startsWith('filtro('))).toBe(true);
  });

  it('filters the semantic half by surface too, not only full text', async () => {
    // The vector index has no notion of `--surface` on its own; the fix this
    // guards is in `recall()`'s vector branch reading `connector` back from
    // `provenanceOf` and dropping the mismatch, not in the index itself.
    const { store, vectors } = harness();
    const cliEp = episode(store, 'nota', 0);
    const tgEp = store.addEpisode({
      tenantId: HOST, connector: 'telegram', threadKey: 'g', role: 'user',
      kind: 'message', content: 'nota', trustTier: 2, createdAt: NOW,
    });
    // Identical indexed text on both, so only the surface filter — not the
    // embedding itself — can tell them apart; neither episode's own content
    // ("nota") shares a word with the query, so full text cannot find either.
    await vectors!.index(HOST, [{ kind: 'episode', sourceId: cliEp, text: 'il weekend di vela' }], NOW);
    await vectors!.index(HOST, [{ kind: 'episode', sourceId: tgEp, text: 'il weekend di vela' }], NOW);

    const result = await recall({ store, vectors }, HOST, 'vela', { surface: 'telegram' });
    expect(result.strategies).toContain('vector');
    expect(result.items.some((i) => i.id === tgEp)).toBe(true);
    expect(result.items.some((i) => i.id === cliEp)).toBe(false);
  });

  it('U2: gates a retired episode on the semantic half too, not only full text', async () => {
    // Neither `expired`/`old` retirement gate has a test that fails without
    // it: `searchEpisodes` (text) already had one to lean on, so an existing
    // test proving "retired stays out" could pass on the graph/text path
    // alone and never touch this guard.
    const { store, vectors } = harness();
    const id = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'appunto ormai vecchio sulla regata', trustTier: 0, createdAt: NOW,
    });
    await vectors!.index(HOST, [{ kind: 'episode', sourceId: id, text: 'appunto ormai vecchio sulla regata' }], NOW);
    store.supersedeEpisodes(HOST, [id], NOW);

    // No shared word with the episode's own text in either query: only the
    // vector half, matching by meaning, can retrieve this row at all — so a
    // pass here can only be explained by the guard, not by the text half.
    const now = await recall({ store, vectors }, HOST, 'vela barca mare');
    expect(now.items.some((i) => i.kind === 'episode' && i.id === id)).toBe(false);
    // Non-vacuous: the row really is reachable through this half once history
    // is asked for, so the negative above is not just "nothing was indexed".
    const history = await recall({ store, vectors }, HOST, 'vela barca mare', { asOf: EVERY_INSTANT });
    expect(history.items.some((i) => i.kind === 'episode' && i.id === id)).toBe(true);
  });

  it('U2: filters the semantic half by a date window too, not only full text', async () => {
    const { store, vectors } = harness();
    const id = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'nota fuori finestra sulla regata', trustTier: 0, createdAt: '2026-01-01T10:00:00Z',
    });
    await vectors!.index(HOST, [{ kind: 'episode', sourceId: id, text: 'nota fuori finestra sulla regata' }], NOW);

    const result = await recall({ store, vectors }, HOST, 'vela barca mare', {
      since: '2026-06-01T00:00:00.000Z',
      until: '2026-09-01T00:00:00.000Z',
    });
    expect(result.strategies).toContain('vector');
    expect(result.items.some((i) => i.kind === 'episode' && i.id === id)).toBe(false);
  });

  it('U2: does not attach a successor to a fact retired by the duplicate sweep', async () => {
    // Distinct from the rendering test above: this checks `successorOf`'s own
    // output (`replacedBy`) directly, the primitive both the graph hop and the
    // vector half call — not the string `temporalLabel` builds from it.
    const { store, vectors } = harness(false);
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'due letture dello stesso fatto');
    const base = {
      tenantId: HOST, subjectId: me, predicate: 'lives_in', episodeId: ep,
      trustTier: 0 as const, confidence: 0.9, extractionV: 1, recordedAt: NOW,
    };
    const dup = store.addFact({ ...base, objectValue: 'Cagliari' });
    const keep = store.addFact({ ...base, objectValue: 'Cagliari' });
    store.supersede(HOST, dup, keep, NOW, null);

    const result = await recall({ store, vectors }, HOST, 'Giusto', { asOf: EVERY_INSTANT });
    const dupItem = result.items.find((i) => i.kind === 'fact' && i.id === dup);
    expect(dupItem?.expired).toBe(true);
    expect(dupItem?.replacedBy).toBeUndefined();
  });

  it('does not let a superseded fact surface through the semantic half either', async () => {
    // The vector index never re-embeds on supersede, so the retired text stays
    // findable by meaning forever. The text half and the graph hop both gate on
    // `includeSuperseded`; before this fix the semantic half did not, which made
    // it the one door a retired belief could still walk back through unmarked —
    // in the *default* search, not only under `--history`.
    const { store, vectors } = harness();
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'note su Giusto');
    const base = {
      tenantId: HOST, subjectId: me, predicate: 'mood', episodeId: ep,
      trustTier: 0 as const, confidence: 0.9, extractionV: 1, recordedAt: NOW,
    };
    const old = store.addFact({ ...base, objectValue: 'sotto pressione' });
    const current = store.addFact({ ...base, objectValue: 'sereno' });
    await vectors!.index(HOST, [{ kind: 'fact', sourceId: old, text: 'Giusto mood sotto pressione' }], NOW);
    store.supersede(HOST, old, current, NOW);

    // No shared word with "sotto pressione ultimamente" in any episode's own
    // text and no capitalised word for the graph hop to key on: only the vector
    // half, matching by meaning, can retrieve this fact at all.
    const result = await recall({ store, vectors }, HOST, 'sotto pressione ultimamente');
    expect(result.strategies).toContain('vector');
    expect(result.items.some((i) => i.kind === 'fact' && i.id === old)).toBe(false);
  });

  it('brings the same retired fact back through the semantic half, marked, once history is asked for', async () => {
    const { store, vectors } = harness();
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'note su Giusto');
    const base = {
      tenantId: HOST, subjectId: me, predicate: 'mood', episodeId: ep,
      trustTier: 0 as const, confidence: 0.9, extractionV: 1, recordedAt: NOW,
    };
    const old = store.addFact({ ...base, objectValue: 'sotto pressione' });
    const current = store.addFact({ ...base, objectValue: 'sereno' });
    await vectors!.index(HOST, [{ kind: 'fact', sourceId: old, text: 'Giusto mood sotto pressione' }], NOW);
    store.supersede(HOST, old, current, NOW);

    const result = await recall({ store, vectors }, HOST, 'sotto pressione ultimamente', { asOf: EVERY_INSTANT });
    const hit = result.items.find((i) => i.kind === 'fact' && i.id === old);
    expect(hit?.expired).toBe(true);
    expect(hit?.replacedBy?.text).toContain('sereno');
  });

  it('labels a fact retired by the duplicate sweep as a duplicate, never as "was true before"', async () => {
    // D4: `expired_at` alone conflates two different reasons a fact is
    // retired. `supersede` is called from the judge, closing world time
    // (`validTo` set) — and from `sweepDuplicates`, which passes `validTo:
    // null` on purpose, because a duplicate was never a separate truth
    // (`store.ts` supersede's own doc comment). Rendering both the same way
    // tells the owner a dedup merge was a change of mind, and under `as-of`
    // the duplicate row is often the only line left standing.
    const { store, vectors } = harness();
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'due letture dello stesso fatto');
    const base = {
      tenantId: HOST, subjectId: me, predicate: 'lives_in', episodeId: ep,
      trustTier: 0 as const, confidence: 0.9, extractionV: 1, recordedAt: NOW,
    };
    const dup = store.addFact({ ...base, objectValue: 'Cagliari' });
    store.addFact({ ...base, objectValue: 'Cagliari' }); // exact duplicate: the sweep retires one
    sweepDuplicates(store, HOST, new Date(NOW));

    const result = await recall({ store, vectors }, HOST, 'Giusto', { asOf: EVERY_INSTANT });
    // Non-vacuous: the retired row actually reached recall, marked expired,
    // with the `validTo: null` the sweep wrote.
    const dupItem = result.items.find((i) => i.kind === 'fact' && i.id === dup);
    expect(dupItem?.expired).toBe(true);
    expect(dupItem?.validTo ?? null).toBeNull();

    const rendered = renderForPrompt(result);
    expect(rendered).toContain('riga ritirata (duplicato)');
    // The old label is still correct for a real supersede — nothing in this
    // fixture is one, so it must not appear at all here.
    expect(rendered).not.toContain('non più attuale — era vero prima');
  });

  it('carries the K episodes before and after a match, from its own thread and reading order', async () => {
    const { store, vectors } = harness(false);
    const fill = (label: string, minute: number, threadKey = 't') =>
      store.addEpisode({
        tenantId: HOST, connector: 'cli', threadKey, role: 'user',
        kind: 'message', content: label, trustTier: 0, createdAt: `2026-08-01T10:0${minute}:00Z`,
      });
    const twoBefore = fill('due prima', 1);
    const oneBefore = fill('una prima', 2);
    const anchor = fill('il codice segreto è ZK-9', 3);
    const oneAfter = fill('una dopo', 4);
    const twoAfter = fill('due dopo', 5);
    // Same instant, different thread: must never be treated as a neighbour.
    const otherThread = fill('non è vicino', 3, 'other-thread');

    const result = await recall({ store, vectors }, HOST, 'codice segreto', { neighbours: 2 });
    const neighbours = result.items.filter((i) => i.neighbourOf === anchor);
    expect(neighbours.map((i) => i.id)).toEqual([twoBefore, oneBefore, oneAfter, twoAfter]);
    expect(neighbours.map((i) => i.text)).toEqual(['due prima', 'una prima', 'una dopo', 'due dopo']);
    expect(neighbours.some((i) => i.id === otherThread)).toBe(false);
  });

  it('clamps an oversized neighbours request instead of pulling an unbounded slice of a thread', async () => {
    // `RecallOptions.neighbours` is a tool argument the model controls; an
    // unclamped value would let one call pull an unbounded slice of a thread
    // into context. The cap lives in `recall()` itself (`MAX_NEIGHBOURS`), so
    // this is a wiring test for the primitive, not for either boundary.
    const { store, vectors } = harness(false);
    const anchor = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'ancora qui il codice segreto', trustTier: 0, createdAt: '2026-08-01T10:06:00Z',
    });
    for (let i = 0; i < 12; i++) {
      if (i === 6) continue;
      store.addEpisode({
        tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user',
        kind: 'message', content: `riempitivo ${i}`, trustTier: 0,
        createdAt: `2026-08-01T10:${String(i).padStart(2, '0')}:00Z`,
      });
    }

    const result = await recall({ store, vectors }, HOST, 'codice segreto', { neighbours: 1000 });
    expect(result.strategies).toContain('vicinato(5)');
    const neighbourCount = result.items.filter((i) => i.neighbourOf === anchor).length;
    expect(neighbourCount).toBeLessThanOrEqual(10);
  });

  it('clamps the whole result, not only how many messages surround one anchor', async () => {
    // D2: `MAX_NEIGHBOURS` bounds one anchor's own window; nothing bounded how
    // many anchors got one, or the size of `limit` itself, which a CLI caller
    // can set with no cap of its own. `limit:20, around:5` on twenty threads of
    // thirty messages used to be able to append up to 220 rows — about 24k
    // tokens — to a tool result `runtime.ts` marks `keepResult: true`, so it
    // was never compacted, for the rest of the conversation.
    // One matching message per thread, at a fixed mid-thread position, amid
    // filler that does not share the query word — so the twenty ranked hits
    // are spread one-per-thread and their neighbourhoods (the filler either
    // side) are not already part of `kept`, the way a real "sweep of threads"
    // would be. Uniform content across every thread would instead rank as one
    // long tie, and `kept` would silently become "the first twenty rows of
    // thread zero" — whose own neighbours are already in `kept` — which
    // proves nothing about the clamp.
    const { store, vectors } = harness(false);
    for (let t = 0; t < 20; t++) {
      for (let m = 0; m < 30; m++) {
        store.addEpisode({
          tenantId: HOST, connector: 'cli', threadKey: `t${t}`, role: 'user',
          kind: 'message',
          content: m === 15 ? 'regata di stamattina' : `messaggio ${m} senza rilievo`,
          trustTier: 0,
          createdAt: `2026-08-01T10:${String(m).padStart(2, '0')}:00Z`,
        });
      }
    }

    const result = await recall({ store, vectors }, HOST, 'regata', { limit: 20, neighbours: 5 });
    // The declared threshold, not a copy of the number: this fails the moment
    // the constant and the guarantee drift apart.
    expect(result.items.length).toBeLessThanOrEqual(MAX_CONTEXT_ITEMS);
    // Non-vacuous: the clamp actually had a neighbourhood to cut down, not an
    // empty one that would pass regardless of whether the clamp exists.
    expect(result.items.some((i) => i.neighbourOf !== undefined)).toBe(true);
  });

  it('names the cap in strategies when the cut actually fires', async () => {
    // The clamp test above proves the cut with the neighbourhood mechanism;
    // this one proves it on `limit` alone, so the label is not accidentally
    // coupled to `neighbours`. A recall that comes back smaller than what
    // actually matched has to say so — the same rule that already puts
    // `vector-non-configurato` in `strategies` rather than leaving it silent.
    const { store, vectors } = harness(false);
    for (let m = 0; m < 50; m++) {
      store.addEpisode({
        tenantId: HOST, connector: 'cli', threadKey: 't', role: 'user',
        kind: 'message', content: 'regata di stamattina', trustTier: 0,
        createdAt: `2026-08-01T10:${String(m).padStart(2, '0')}:00Z`,
      });
    }

    const result = await recall({ store, vectors }, HOST, 'regata', { limit: 100 });
    expect(result.items.length).toBe(MAX_CONTEXT_ITEMS);
    expect(result.strategies).toContain(`tetto(${MAX_CONTEXT_ITEMS})`);
  });

  it('gives a neighbourhood to only the first few ranked episodes, not every one', async () => {
    // The other half of D2, isolated from the size clamp above: kept sits at
    // 6 items and each neighbourhood adds at most 2, so the total (18) never
    // approaches `MAX_CONTEXT_ITEMS` and cannot be the thing doing the
    // cutting here. Only `MAX_NEIGHBOUR_ANCHORS` can explain fewer than six
    // distinct anchors showing up with context.
    const { store, vectors } = harness(false);
    for (let t = 0; t < 6; t++) {
      for (let m = 0; m < 10; m++) {
        store.addEpisode({
          tenantId: HOST, connector: 'cli', threadKey: `t${t}`, role: 'user',
          kind: 'message',
          content: m === 5 ? 'regata di stamattina' : `messaggio ${m} senza rilievo`,
          trustTier: 0,
          createdAt: `2026-08-01T10:${String(m).padStart(2, '0')}:00Z`,
        });
      }
    }

    const result = await recall({ store, vectors }, HOST, 'regata', { limit: 6, neighbours: 1 });
    const distinctAnchors = new Set(result.items.filter((i) => i.neighbourOf !== undefined).map((i) => i.neighbourOf));
    expect(distinctAnchors.size).toBeGreaterThan(0);
    expect(distinctAnchors.size).toBeLessThanOrEqual(3);
  });

  it('never lets the neighbourhood reach across a tenant boundary', async () => {
    const { store, vectors } = harness(false);
    const mine = episode(store, 'il mio codice è ZK-1');
    // Same connector and thread key by coincidence must not be enough: a
    // different tenant's episode must never be adjacent to this one.
    store.addEpisode({
      tenantId: 'group:telegram:9', connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'vicino di un altro tenant', trustTier: 2, createdAt: NOW,
    });

    const result = await recall({ store, vectors }, HOST, 'il mio codice', { neighbours: 2 });
    expect(result.items.some((i) => i.id === mine)).toBe(true);
    expect(result.items.map((i) => i.text).join(' ')).not.toContain('altro tenant');
  });
});

describe('checkTemporalWindow', () => {
  const NOW_ISO = '2026-08-16T12:00:00.000Z';

  it('accepts a normal, past window and an as-of no later than now', () => {
    expect(
      checkTemporalWindow({ since: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' }, NOW_ISO),
    ).toBeNull();
    expect(checkTemporalWindow({ asOf: NOW_ISO }, NOW_ISO)).toBeNull();
  });

  it('rejects since after until — a window that cannot contain anything', () => {
    expect(
      checkTemporalWindow({ since: '2026-06-01T00:00:00.000Z', until: '2026-01-01T00:00:00.000Z' }, NOW_ISO),
    ).toBe('empty-window');
  });

  it('rejects an as-of that has not happened yet', () => {
    expect(checkTemporalWindow({ asOf: '2027-01-01T00:00:00.000Z' }, NOW_ISO)).toBe('future-asof');
  });

  it('never flags EVERY_INSTANT as a future date', () => {
    // 'all' sorts after any ISO date string lexicographically ('a' > '2' in
    // ASCII) — a naive `asOf > now` string comparison would reject `--history`
    // itself, which is exactly the sentinel this exemption exists to protect.
    expect(checkTemporalWindow({ asOf: EVERY_INSTANT }, NOW_ISO)).toBeNull();
  });

  it('does not reject a since/until that simply has not happened yet — that is empty evidence, not a wrong request', () => {
    expect(checkTemporalWindow({ since: '2027-01-01T00:00:00.000Z' }, NOW_ISO)).toBeNull();
  });
});

describe('invariant: a retired fact never comes back looking active', () => {
  it('holds across every combination of asOf, surface, since/until and neighbours', async () => {
    // The minimum measure PRACTICES §5 and the mandate both ask for: not one
    // scenario, but a sweep over the parameter space, on both halves that can
    // return a fact (graph hop and semantic match).
    const { store, vectors } = harness();
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'due episodi su Giusto');
    const base = {
      tenantId: HOST, subjectId: me, predicate: 'accountant', episodeId: ep,
      trustTier: 0 as const, confidence: 0.9, extractionV: 1,
    };
    const retired = store.addFact({ ...base, objectValue: 'Marco', recordedAt: '2026-06-01T10:00:00Z' });
    const active = store.addFact({ ...base, objectValue: 'Lucia', recordedAt: '2026-08-01T10:00:00Z' });
    store.supersede(HOST, retired, active, '2026-08-01T10:00:00Z');
    // N1: episodes too, not only facts — the two are marked by different
    // columns (`superseded_at` vs. `expired_at`) and gated by separate code
    // in `recall()`, so a sweep that only ever seeded a fact could not have
    // caught a regression specific to the episode path.
    const retiredEpisode = store.addEpisode({
      tenantId: HOST, connector: 'cli', threadKey: 'sweep-retired', role: 'user',
      kind: 'message', content: 'vecchia nota: Giusto accountant Marco Lucia', trustTier: 0,
      createdAt: '2026-06-01T10:00:00Z',
    });
    store.supersedeEpisodes(HOST, [retiredEpisode], '2026-08-01T10:00:00Z');
    await vectors!.index(
      HOST,
      [
        { kind: 'fact' as const, sourceId: retired, text: 'Giusto accountant Marco' },
        { kind: 'fact' as const, sourceId: active, text: 'Giusto accountant Lucia' },
        { kind: 'episode' as const, sourceId: retiredEpisode, text: 'vecchia nota: Giusto accountant Marco Lucia' },
      ],
      NOW,
    );

    const asOfValues: (string | undefined)[] = [
      undefined,
      EVERY_INSTANT,
      '2026-05-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    ];
    const surfaces: (string | undefined)[] = [undefined, 'cli', 'telegram'];
    const windows: [string | undefined, string | undefined][] = [
      [undefined, undefined],
      ['2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z'],
    ];
    const neighboursValues = [0, 2];

    let combinations = 0;
    let sawRetiredAsActive = 0;
    let sawRetiredCorrectlyMarked = 0;
    // N1: the sweep used to measure only the *label* on a returned row — a
    // regression that let a retired item back into an ordinary "now" search,
    // correctly marked `expired`, would have counted as a pass here. Presence
    // is its own property: under the default instant (`asOf === undefined`,
    // no history asked for) a retired row must not come back at all, marked
    // or not.
    let sawRetiredWhenNotAsked = 0;
    for (const asOf of asOfValues) {
      for (const surface of surfaces) {
        for (const [since, until] of windows) {
          for (const neighbours of neighboursValues) {
            const result = await recall({ store, vectors }, HOST, 'Giusto accountant Marco Lucia', {
              ...(asOf === undefined ? {} : { asOf }),
              ...(surface === undefined ? {} : { surface }),
              ...(since === undefined ? {} : { since }),
              ...(until === undefined ? {} : { until }),
              ...(neighbours === 0 ? {} : { neighbours }),
            });
            combinations++;
            const retiredFactHit = result.items.find((i) => i.kind === 'fact' && i.id === retired);
            const retiredEpisodeHit = result.items.find((i) => i.kind === 'episode' && i.id === retiredEpisode);
            for (const hit of [retiredFactHit, retiredEpisodeHit]) {
              if (!hit) continue;
              if (hit.expired) sawRetiredCorrectlyMarked++;
              else sawRetiredAsActive++;
              if (asOf === undefined) sawRetiredWhenNotAsked++;
            }
          }
        }
      }
    }

    expect(combinations).toBe(asOfValues.length * surfaces.length * windows.length * neighboursValues.length);
    // The property itself: never once, across every combination, does a
    // retired fact or episode come back looking current.
    expect(sawRetiredAsActive).toBe(0);
    // Nor does either come back at all when history was never asked for.
    expect(sawRetiredWhenNotAsked).toBe(0);
    // And the property was actually exercised — a sweep that never returns
    // either retired row at all would make the assertions above vacuous.
    expect(sawRetiredCorrectlyMarked).toBeGreaterThan(0);
  });
});

describe('the default turn pays no temporal-gate cost', () => {
  it('never calls factsAsOf or episodeNeighbourhood when asOf and neighbours are both absent', async () => {
    // The PR body claims this by hand ("Turno DEFAULT ... zero costo
    // aggiunto"), probed once and never proven by a test that could go red —
    // this is that test. `asOf === undefined` already has its own branch in
    // the graph hop (`activeFacts`, never `factsAsOf`), and `neighbours`
    // defaults to 0, which short-circuits the neighbourhood block before it
    // ever calls the store. An ordinary "now" turn — the one every turn
    // takes — must never pay for either primitive.
    const { store, vectors } = harness();
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'Giusto accountant Lucia');
    store.addFact({
      tenantId: HOST, subjectId: me, predicate: 'accountant', objectValue: 'Lucia',
      episodeId: ep, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: NOW,
    });

    const factsAsOfSpy = vi.spyOn(store, 'factsAsOf');
    const neighbourhoodSpy = vi.spyOn(store, 'episodeNeighbourhood');

    const result = await recall({ store, vectors }, HOST, 'Giusto accountant Lucia', {});

    // The path was actually exercised, not vacuously empty — otherwise zero
    // calls would prove nothing.
    expect(result.items.length).toBeGreaterThan(0);
    expect(factsAsOfSpy).not.toHaveBeenCalled();
    expect(neighbourhoodSpy).not.toHaveBeenCalled();
  });
});

describe('recall — the pinned core (slice/memoria-appuntata)', () => {
  it('reproduces the 2026-08-26 failure: a pinned identity fact reaches the MEMORIA block even when the query matches nothing', async () => {
    // The real failure: the owner typed "Yo!" in a fresh session and Muffin
    // asked for a name it already had, because the fact recall would have
    // needed lived on an episode from weeks earlier that shares no word and
    // no meaning with a two-letter greeting. Pinned facts do not go through
    // that search at all.
    const { store } = harness(false);
    const me = store.upsertEntity(HOST, 'Giusto Piedimonte', 'person', NOW);
    const ep = episode(store, 'lavoro come AI engineer');
    const factId = store.addFact({
      tenantId: HOST, subjectId: me, predicate: 'works_as', objectValue: 'AI engineer',
      episodeId: ep, trustTier: 0, origin: 'said', confidence: 0.9, extractionV: 1,
      recordedAt: NOW, pinned: true,
    });

    const result = await recall({ store }, HOST, 'Yo!');
    expect(result.items.some((i) => i.kind === 'fact' && i.id === factId)).toBe(true);

    const rendered = renderForPrompt(result);
    expect(rendered).toContain('Giusto Piedimonte');
    expect(rendered).toContain('AI engineer');
  });

  it('never lets one tenant\'s pinned facts reach another tenant\'s turn', async () => {
    const { store } = harness(false);
    const GROUP = 'group:telegram:9';
    const me = store.upsertEntity(HOST, 'owner', 'person', NOW);
    const ep = episode(store, 'nota');
    store.addFact({
      tenantId: HOST, subjectId: me, predicate: 'name', objectValue: 'Giusto',
      episodeId: ep, trustTier: 0, origin: 'said', confidence: 0.9, extractionV: 1,
      recordedAt: NOW, pinned: true,
    });

    const result = await recall({ store }, GROUP, 'Yo!');
    expect(result.items).toHaveLength(0);
    expect(renderForPrompt(result)).toBe('');
  });

  it('drops a pinned fact once it is superseded — the block shows the successor, never the retired belief', async () => {
    const { store } = harness(false);
    const me = store.upsertEntity(HOST, 'owner', 'person', NOW);
    const ep = episode(store, 'nota');
    const base = {
      tenantId: HOST, subjectId: me, episodeId: ep, trustTier: 0 as const,
      origin: 'said' as const, confidence: 0.9, extractionV: 1,
    };
    const oldId = store.addFact({ ...base, predicate: 'name', objectValue: 'Giusto', recordedAt: '2026-08-01T10:00:00Z', pinned: true });
    const newId = store.addFact({ ...base, predicate: 'name', objectValue: 'G.', recordedAt: '2026-08-05T10:00:00Z', pinned: true });
    store.supersede(HOST, oldId, newId, '2026-08-05T10:00:00Z');

    const result = await recall({ store }, HOST, 'tuttaltra domanda che non tocca nessuno dei due');
    const factIds = result.items.filter((i) => i.kind === 'fact').map((i) => i.id);
    expect(factIds).toEqual([newId]);
    const rendered = renderForPrompt(result);
    expect(rendered).toContain('G.');
    expect(rendered).not.toContain('Giusto');
  });

  it('does not print a pinned fact twice when ordinary recall already found it', async () => {
    const { store } = harness(false);
    const me = store.upsertEntity(HOST, 'Marco', 'person', NOW);
    const ep = episode(store, 'Marco è il commercialista');
    const factId = store.addFact({
      tenantId: HOST, subjectId: me, predicate: 'accountant', objectValue: 'Marco',
      episodeId: ep, trustTier: 0, origin: 'said', confidence: 0.9, extractionV: 1,
      recordedAt: NOW, pinned: true,
    });

    // Capitalised, so the graph hop finds this entity on its own — the pinned
    // channel must recognise it is already there and not add a second copy.
    const result = await recall({ store }, HOST, 'Marco è ancora il commercialista?');
    expect(result.items.filter((i) => i.kind === 'fact' && i.id === factId)).toHaveLength(1);
  });

  it('keeps only the most recent PINNED_BUDGET facts and says how many did not fit', async () => {
    const { store } = harness(false);
    const me = store.upsertEntity(HOST, 'owner', 'person', NOW);
    const ep = episode(store, 'nota');
    const ids: number[] = [];
    for (let i = 0; i < 14; i++) {
      ids.push(
        store.addFact({
          tenantId: HOST, subjectId: me, predicate: `fact_${i}`, objectValue: `v${i}`,
          episodeId: ep, trustTier: 0, origin: 'said', confidence: 0.9, extractionV: 1,
          recordedAt: `2026-08-${String(i + 1).padStart(2, '0')}T10:00:00Z`, pinned: true,
        }),
      );
    }

    const result = await recall({ store }, HOST, 'query generica che non nomina niente');
    const factIds = result.items.filter((i) => i.kind === 'fact').map((i) => i.id);
    // Newest twelve survive — the same recency-wins rule `selectForExpansion`
    // already uses for the graph hop's own cut.
    expect(factIds).toEqual([...ids].reverse().slice(0, 12));
    expect(result.pinnedOverflow).toBe(2);
    expect(renderForPrompt(result)).toContain('altri 2 fatti appuntati');
  });
});

/**
 * `strategies` promette di nominare «le metà che hanno davvero girato, così un
 * recall degradato non è mai silenzioso». Per il rerank diceva il falso: la
 * riga finiva nell'elenco anche quando l'ordine veniva da RRF, perché un
 * fallimento restituiva gli stessi candidati e nient'altro.
 */
describe('strategies non dice di aver riordinato quando non ha riordinato', () => {
  const reranker = (reordered: boolean, usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }): Reranker => ({
    id: 'finto',
    rerank: async (_q, candidates, topK) => ({
      items: candidates.slice(0, topK),
      reordered,
      ...(reordered ? {} : { why: 'il modello non ha risposto: rete giù' }),
      ...(usage === undefined ? {} : { usage }),
    }),
  });

  /** Abbastanza episodi da superare `RERANK_MIN_CANDIDATES`, tutti sulla stessa parola. */
  function popolata(): { store: MemoryStore } {
    const { store } = harness(false);
    for (let i = 0; i < RERANK_MIN_CANDIDATES + 4; i++) episode(store, `commercialista numero ${i}`);
    return { store };
  }

  it('riordinato: la riga è quella secca di prima', async () => {
    const { store } = popolata();
    const r = await recall({ store, reranker: reranker(true) }, HOST, 'commercialista');
    expect(r.strategies).toContain('rerank(finto)');
  });

  it('non riordinato: la riga porta il motivo, e non finge', async () => {
    const { store } = popolata();
    const r = await recall({ store, reranker: reranker(false) }, HOST, 'commercialista');
    expect(r.strategies).not.toContain('rerank(finto)');
    expect(r.strategies.some((s) => s.startsWith('rerank(finto) non riuscito'))).toBe(true);
    expect(r.strategies.some((s) => s.includes('rete giù'))).toBe(true);
  });
});

/**
 * Il costo del rerank esce col risultato, perché `recall()` non ha un tracer e
 * chi la chiama ce l'ha già.
 */
describe('recall porta fuori quanto è costato il rerank', () => {
  const usato = { inputTokens: 812, outputTokens: 19, cacheReadTokens: 5 };

  const reranker = (reordered: boolean, usage?: typeof usato): Reranker => ({
    id: 'finto',
    rerank: async (_q, candidates, topK) => ({
      items: candidates.slice(0, topK),
      reordered,
      ...(usage === undefined ? {} : { usage }),
    }),
  });

  function popolata(): { store: MemoryStore } {
    const { store } = harness(false);
    for (let i = 0; i < RERANK_MIN_CANDIDATES + 4; i++) episode(store, `commercialista numero ${i}`);
    return { store };
  }

  it('lo riporta quando la chiamata è avvenuta', async () => {
    const { store } = popolata();
    const r = await recall({ store, reranker: reranker(true, usato) }, HOST, 'commercialista');
    expect(r.rerankUsage).toEqual(usato);
  });

  it('non inventa un costo quando la chiamata non è avvenuta', async () => {
    const { store } = popolata();
    const r = await recall({ store, reranker: reranker(false) }, HOST, 'commercialista');
    expect(r.rerankUsage).toBeUndefined();
  });
});
