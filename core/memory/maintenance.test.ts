import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  errorGroups,
  normaliseObject,
  openContradictions,
  readOpenContradictions,
  resolveContradiction,
  reviewBootLine,
  sweepDuplicates,
} from './maintenance.js';
import { MemoryStore } from './store.js';

/**
 * The half of maintenance that spends nothing.
 *
 * Every assertion here is SQL over rows the lane already wrote — no provider,
 * no embedder, no clock. That is not a convenience of the test file: it is the
 * property being asserted. In the old system the dream ran on top of the work
 * queue and was the small half (⬤ 100 reports against 2 438 queue rows over
 * four months), and a maintenance pass that costs more than the lane it
 * maintains is worse than none.
 */

const HOST = 'host';
const GROUP = 'group:telegram:42';
const NOW = new Date('2026-08-14T12:00:00Z');

function harness() {
  const store = new MemoryStore(new DatabaseCtor(':memory:'));
  const episodes = new Map<string, number>();

  const episode = (tenant: string): number => {
    const seen = episodes.get(tenant);
    if (seen !== undefined) return seen;
    const id = store.addEpisode({
      tenantId: tenant,
      connector: 'cli',
      threadKey: 't',
      role: 'user',
      kind: 'message',
      content: 'qualcosa che ho detto',
      trustTier: 0,
      createdAt: '2026-08-01T10:00:00Z',
    });
    episodes.set(tenant, id);
    return id;
  };

  const believe = (
    predicate: string,
    object: string,
    recordedAt: string,
    over: { tenant?: string; subject?: string } = {},
  ): number => {
    const tenant = over.tenant ?? HOST;
    const subjectId = store.upsertEntity(tenant, over.subject ?? 'owner', 'person', recordedAt);
    return store.addFact({
      tenantId: tenant,
      subjectId,
      predicate,
      objectValue: object,
      episodeId: episode(tenant),
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt,
    });
  };

  const active = (id: number): boolean => store.factById(HOST, id)?.expiredAt === null;

  return { store, believe, active };
}

describe('what counts as the same belief', () => {
  it('folds case, surrounding and internal whitespace, and a trailing full stop', () => {
    expect(normaliseObject('  Cagliari  ')).toBe('cagliari');
    expect(normaliseObject('Via  Roma   12')).toBe('via roma 12');
    expect(normaliseObject('Cagliari.')).toBe('cagliari');
  });

  /**
   * The omissions, asserted rather than described — each one is a similarity
   * judgement this sweep refuses to make, and a later edit that "improves" the
   * normalisation would turn every one of these red.
   *
   * "Cagliari" vs "a Cagliari" is the exact drift the research names as what the
   * at-least-once marker produces on a replay. Folding it here would be a
   * threshold with its calibration hidden inside a regex, and the research
   * measured what miscalibration costs: at a naive 0.7 cosine, two common
   * embedders produced **99.00% false positives**.
   */
  it('does not fold accents, articles or anything that would need calibrating', () => {
    expect(normaliseObject('a Cagliari')).not.toBe(normaliseObject('Cagliari'));
    expect(normaliseObject('città')).not.toBe(normaliseObject('citta'));
    expect(normaliseObject('Marco Rossi')).not.toBe(normaliseObject('M. Rossi'));
  });
});

describe('the duplicate sweep', () => {
  /**
   * How the residue gets there: `reconcile` compares an incoming fact against
   * the *most recently recorded* active belief and only against it. With two
   * active values already standing — a set-valued predicate, or a judge
   * `coexist` — a third that duplicates the older one is written as a new row.
   */
  it('retires an exact duplicate in favour of the newest telling', () => {
    const h = harness();
    const first = h.believe('interested_in', 'vela', '2026-06-01T10:00:00Z');
    const other = h.believe('interested_in', 'ceramica', '2026-07-01T10:00:00Z');
    const again = h.believe('interested_in', 'Vela.', '2026-08-01T10:00:00Z');

    const report = sweepDuplicates(h.store, HOST, NOW);

    expect(report.merges).toHaveLength(1);
    expect(report.merges[0]?.keptFactId).toBe(again);
    expect(report.merges[0]?.retiredFactIds).toEqual([first]);
    expect(h.active(again)).toBe(true);
    expect(h.active(first)).toBe(false);
    // The unrelated member of the same set is untouched: this is a duplicate
    // sweep, not a "one value per predicate" rule. `schema.ts` records what the
    // old system's version of that rule cost — 27 of 28 `interest` rows expired
    // by accident.
    expect(h.active(other)).toBe(true);
  });

  /**
   * The invariant that makes the whole thing safe to run unattended. A DELETE
   * here would be the worst possible place for one: bulk, automatic, nobody
   * watching. `AGENTS.md` states the rule; this asserts it against the sweep.
   */
  it('never deletes: the retired row is still there, and still says why', () => {
    const h = harness();
    const first = h.believe('lives_in', 'Cagliari', '2026-06-01T10:00:00Z');
    h.believe('lives_in', 'Milano', '2026-06-15T10:00:00Z');
    const again = h.believe('lives_in', 'cagliari', '2026-08-01T10:00:00Z');

    sweepDuplicates(h.store, HOST, NOW);

    const retired = h.store.factById(HOST, first);
    expect(retired).not.toBeNull();
    expect(retired?.supersededBy).toBe(again);
    expect(retired?.expiredAt).toBe(NOW.toISOString());
    // World time is untouched: a duplicate never stopped being true out there,
    // it was never a separate truth. Inventing a `valid_to` would fabricate a
    // date indistinguishable from a real one a month later.
    expect(retired?.validTo).toBeNull();
  });

  it('leaves a single-valued predicate alone — a group of one cannot hold a duplicate', () => {
    const h = harness();
    const only = h.believe('lives_in', 'Cagliari', '2026-06-01T10:00:00Z');
    const report = sweepDuplicates(h.store, HOST, NOW);
    expect(report.examined).toBe(0);
    expect(report.merges).toEqual([]);
    expect(h.active(only)).toBe(true);
  });

  it('does not merge across subjects or across predicates', () => {
    const h = harness();
    const a = h.believe('lives_in', 'Cagliari', '2026-06-01T10:00:00Z');
    const b = h.believe('born_in', 'Cagliari', '2026-06-02T10:00:00Z');
    const c = h.believe('lives_in', 'Cagliari', '2026-06-03T10:00:00Z', { subject: 'marco' });
    sweepDuplicates(h.store, HOST, NOW);
    expect([h.active(a), h.active(b), h.active(c)]).toEqual([true, true, true]);
  });

  it('never crosses a tenant', () => {
    const h = harness();
    const mine = h.believe('lives_in', 'Cagliari', '2026-06-01T10:00:00Z');
    h.believe('lives_in', 'Cagliari', '2026-06-02T10:00:00Z', { tenant: GROUP });
    h.believe('lives_in', 'Cagliari', '2026-06-03T10:00:00Z', { tenant: GROUP });

    const report = sweepDuplicates(h.store, HOST, NOW);
    expect(report.merges).toEqual([]);
    expect(h.active(mine)).toBe(true);
    // And the group's own duplicates are still its own to sweep.
    expect(sweepDuplicates(h.store, GROUP, NOW).merges).toHaveLength(1);
  });

  /**
   * Two processes run turns at once now (a gateway and a REPL window), and the
   * sweep takes no lock. It does not need one *because* the survivor is a total
   * order over the rows: both processes pick the same keeper and issue the same
   * retirements, and `supersede`'s own `expired_at IS NULL` makes the loser's
   * write a no-op. Running it twice is the cheapest way to assert that.
   */
  it('is idempotent, which is what makes two processes sweeping at once safe', () => {
    const h = harness();
    const first = h.believe('interested_in', 'vela', '2026-06-01T10:00:00Z');
    const again = h.believe('interested_in', 'vela', '2026-08-01T10:00:00Z');

    expect(sweepDuplicates(h.store, HOST, NOW).merges).toHaveLength(1);
    const second = sweepDuplicates(h.store, HOST, new Date('2026-08-15T12:00:00Z'));
    expect(second.merges).toEqual([]);
    // The first sweep's timestamp is still the one on the row: the second pass
    // did not re-retire it under a new date.
    expect(h.store.factById(HOST, first)?.expiredAt).toBe(NOW.toISOString());
    expect(h.active(again)).toBe(true);
  });

  it('breaks a same-timestamp tie by id, so the order is total and not chance', () => {
    const h = harness();
    const older = h.believe('interested_in', 'vela', '2026-06-01T10:00:00Z');
    const newer = h.believe('interested_in', 'vela', '2026-06-01T10:00:00Z');
    sweepDuplicates(h.store, HOST, NOW);
    expect(h.active(newer)).toBe(true);
    expect(h.active(older)).toBe(false);
  });
});

describe('the review register, read at last', () => {
  const contradiction = (h: ReturnType<typeof harness>) => {
    const existing = h.believe('accountant', 'Marco', '2026-06-01T10:00:00Z');
    const incoming = h.believe('accountant', 'Lucia', '2026-08-01T10:00:00Z');
    const reviewId = h.store.recordReview({
      tenantId: HOST,
      kind: 'contradiction',
      subject: 'owner',
      predicate: 'accountant',
      existingFactId: existing,
      incomingFactId: incoming,
      detail: 'nessuna delle due frasi dice quando',
      createdAt: '2026-08-01T10:00:01Z',
    });
    return { existing, incoming, reviewId };
  };

  it('shows a contradiction whose two beliefs are both still current', () => {
    const h = harness();
    const { existing, incoming, reviewId } = contradiction(h);
    const open = openContradictions(h.store, HOST);
    expect(open).toHaveLength(1);
    expect(open[0]?.reviewId).toBe(reviewId);
    expect(open[0]?.existing.id).toBe(existing);
    expect(open[0]?.incoming.id).toBe(incoming);
    expect(open[0]?.why).toBe('nessuna delle due frasi dice quando');
  });

  /**
   * The design decision this asserts: **no status column, ever.** `schema.ts`
   * says a register tracking whether a human had looked yet would be the
   * workflow engine this was asked not to become. So "open" is a join, and a
   * question the conversation answers on its own stops being a question with
   * nothing written anywhere.
   */
  it('drops out on its own when the conversation supersedes either side', () => {
    const h = harness();
    const { existing, incoming } = contradiction(h);
    h.store.supersede(HOST, existing, incoming, '2026-08-02T10:00:00Z');
    expect(openContradictions(h.store, HOST)).toEqual([]);
    // And the row is still there — the register is append-only, so the history
    // of what the judge asked survives the question being settled.
    expect(h.store.pendingReview(HOST)).toHaveLength(1);
  });

  it('answers one by keeping a side, and the retired belief points at the survivor', () => {
    const h = harness();
    const { existing, incoming } = contradiction(h);

    const answered = resolveContradiction(h.store, HOST, incoming, NOW);

    expect(answered).toHaveLength(1);
    expect(h.active(incoming)).toBe(true);
    expect(h.active(existing)).toBe(false);
    expect(h.store.factById(HOST, existing)?.supersededBy).toBe(incoming);
    expect(openContradictions(h.store, HOST)).toEqual([]);
  });

  it('refuses an id that is not one of the two — silence would look like success', () => {
    const h = harness();
    contradiction(h);
    const stranger = h.believe('lives_in', 'Cagliari', '2026-08-02T10:00:00Z');
    expect(resolveContradiction(h.store, HOST, stranger, NOW)).toEqual([]);
    expect(openContradictions(h.store, HOST)).toHaveLength(1);
  });

  it('never shows another tenant a contradiction of the owner’s', () => {
    const h = harness();
    contradiction(h);
    expect(openContradictions(h.store, GROUP)).toEqual([]);
  });

  /**
   * The repeat this register makes possible, and the reason the read side folds
   * instead of listing. An episode whose extraction fails permanently is left
   * unmarked on purpose so it is retried, and it writes one `error` row on every
   * fire that reaches it — which would bury the contradictions the register
   * exists for under a wall of the same sentence.
   */
  it('folds a repeating pipeline failure into one line with a count and a span', () => {
    const h = harness();
    for (const day of ['01', '02', '03']) {
      h.store.recordReview({
        tenantId: HOST,
        kind: 'error',
        detail: 'estrazione fallita su episodio 7: risposta non parsabile',
        createdAt: `2026-08-${day}T10:00:00Z`,
      });
    }
    h.store.recordReview({
      tenantId: HOST,
      kind: 'error',
      detail: 'indice vettoriale: connessione rifiutata — il recall resta testuale',
      createdAt: '2026-08-04T10:00:00Z',
    });

    const groups = errorGroups(h.store, HOST);
    expect(groups).toHaveLength(2);
    const repeated = groups.find((g) => g.detail.startsWith('estrazione fallita'));
    expect(repeated?.count).toBe(3);
    expect(repeated?.firstAt).toBe('2026-08-01T10:00:00Z');
    expect(repeated?.lastAt).toBe('2026-08-03T10:00:00Z');
  });

  /**
   * The readonly reader `doctor` uses. Null and zero are different findings and
   * the distinction is the same one `readConsolidation` makes: on a home written
   * before the register existed, the table is simply not there, and reporting
   * that as "nothing to decide" would be an answer where there is silence.
   */
  it('reads null — not zero — on a home from before the register existed', () => {
    const bare = new DatabaseCtor(':memory:');
    expect(readOpenContradictions(bare, HOST)).toBeNull();
    bare.close();
  });
});

describe('the boot line', () => {
  /**
   * Printed only when it is a request for the owner's attention. ADR-0028
   * exists because the old system's proactivity was a firehose of *"ho notato
   * X"*; a banner that fires on the empty case is the same mistake smaller.
   */
  it('is silent with nothing open, and names the count otherwise', () => {
    const db = new DatabaseCtor(':memory:');
    const store = new MemoryStore(db);
    expect(reviewBootLine(db, HOST)).toBeNull();

    const episodeId = store.addEpisode({
      tenantId: HOST,
      connector: 'cli',
      threadKey: 't',
      role: 'user',
      kind: 'message',
      content: 'detto',
      trustTier: 0,
      createdAt: '2026-08-01T10:00:00Z',
    });
    const subjectId = store.upsertEntity(HOST, 'owner', 'person', '2026-08-01T10:00:00Z');
    const mk = (object: string, at: string) =>
      store.addFact({
        tenantId: HOST,
        subjectId,
        predicate: 'accountant',
        objectValue: object,
        episodeId,
        trustTier: 0,
        confidence: 0.9,
        extractionV: 1,
        recordedAt: at,
      });
    store.recordReview({
      tenantId: HOST,
      kind: 'contradiction',
      existingFactId: mk('Marco', '2026-06-01T10:00:00Z'),
      incomingFactId: mk('Lucia', '2026-08-01T10:00:00Z'),
      detail: 'nessuna dice quando',
      createdAt: '2026-08-01T10:00:01Z',
    });

    expect(reviewBootLine(db, HOST)).toContain('muffin memory review');
    expect(reviewBootLine(db, HOST)).toContain('1 contraddizione');
    db.close();
  });
});
