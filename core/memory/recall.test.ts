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

  it('does not surface a retired belief as if it were current', async () => {
    const { store, vectors } = harness();
    const me = store.upsertEntity(HOST, 'Giusto', 'person', NOW);
    const ep = episode(store, 'cambio commercialista');
    const base = { tenantId: HOST, subjectId: me, predicate: 'accountant', episodeId: ep, trustTier: 0 as const, confidence: 0.9, extractionV: 1, recordedAt: NOW };
    const marco = store.addFact({ ...base, objectValue: 'Marco' });
    const lucia = store.addFact({ ...base, objectValue: 'Lucia' });
    store.supersede(marco, lucia, NOW);

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
    expect(rendered).toContain('MEMORIA_RECUPERATA'); // delimited as data
    expect(rendered).toContain('gruppo/sconosciuto'); // and labelled
  });
});
