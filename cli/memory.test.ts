import DatabaseCtor from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../core/config/config.js';
import { MemoryStore } from '../core/memory/store.js';
import { runInit } from './init.js';
import {
  cmdMemoryPin,
  cmdMemoryReview,
  cmdMemoryReviewKeep,
  cmdMemorySearch,
  cmdMemoryStats,
  cmdMemoryUnpin,
  valeUnAltroGiro,
} from './memory.js';

/**
 * `cmdMemoryStats` and `cmdMemoryReview`: `cmdMemoryExtract`'s fix (the batch
 * progress break condition) is proven at the `ingestPending` level in
 * `core/memory/ingest.test.ts`, which is what a scheduler actually calls — this
 * file does not re-derive that through `buildRuntime` and a model.
 *
 * No `runInit`: `openStore` only needs a directory and a sqlite file: config,
 * secrets and the RoT are irrelevant to `MemoryStore`.
 */

function homeWithReview(): string {
  const home = mkdtempSync(join(tmpdir(), 'muffin-memory-cli-'));
  const db = new DatabaseCtor(paths(home).db);
  const store = new MemoryStore(db);
  store.recordReview({
    tenantId: 'host',
    kind: 'error',
    detail: 'giudice non disponibile',
    createdAt: '2026-08-13T10:00:00Z',
  });
  db.close();
  return home;
}

/** A home holding one open contradiction: two current beliefs, one question. */
function homeWithContradiction(): { home: string; existing: number; incoming: number } {
  const home = mkdtempSync(join(tmpdir(), 'muffin-memory-review-'));
  const db = new DatabaseCtor(paths(home).db);
  const store = new MemoryStore(db);
  const episodeId = store.addEpisode({
    tenantId: 'host',
    connector: 'cli',
    threadKey: 't',
    role: 'user',
    kind: 'message',
    content: 'il commercialista ora è Lucia',
    trustTier: 0,
    createdAt: '2026-08-13T10:00:00Z',
  });
  const subjectId = store.upsertEntity('host', 'owner', 'person', '2026-08-13T10:00:00Z');
  const believe = (object: string, at: string) =>
    store.addFact({
      tenantId: 'host',
      subjectId,
      predicate: 'accountant',
      objectValue: object,
      episodeId,
      trustTier: 0,
      confidence: 0.9,
      extractionV: 1,
      recordedAt: at,
    });
  const existing = believe('Marco', '2026-06-01T10:00:00Z');
  const incoming = believe('Lucia', '2026-08-13T10:00:00Z');
  store.recordReview({
    tenantId: 'host',
    kind: 'contradiction',
    subject: 'owner',
    predicate: 'accountant',
    existingFactId: existing,
    incomingFactId: incoming,
    detail: 'nessuna delle due frasi dice quando',
    createdAt: '2026-08-13T10:00:01Z',
  });
  db.close();
  return { home, existing, incoming };
}

/** A home holding one ordinary, unpinned fact — the target for pin/unpin. */
function homeWithFact(): { home: string; factId: number } {
  const home = mkdtempSync(join(tmpdir(), 'muffin-memory-pin-'));
  const db = new DatabaseCtor(paths(home).db);
  const store = new MemoryStore(db);
  const episodeId = store.addEpisode({
    tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
    kind: 'message', content: 'mi chiamo Giusto', trustTier: 0, createdAt: '2026-08-26T10:00:00Z',
  });
  const subjectId = store.upsertEntity('host', 'owner', 'person', '2026-08-26T10:00:00Z');
  const factId = store.addFact({
    tenantId: 'host', subjectId, predicate: 'name', objectValue: 'Giusto',
    episodeId, trustTier: 0, confidence: 0.9, extractionV: 1, recordedAt: '2026-08-26T10:00:00Z',
  });
  db.close();
  return { home, factId };
}

function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

describe('muffin memory stats', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the durable review count, not just facts and episodes', () => {
    // Defect #5's other half: recording is only half the fix if nothing reads
    // it back. Without this line the count is exactly as invisible as the
    // stderr line it replaced, just in a different table.
    const home = homeWithReview();
    const { out } = capture();

    expect(cmdMemoryStats(home)).toBe(0);
    expect(out.join('')).toContain('da rivedere');
    // And it says *what*: a bare total on an append-only register only ever
    // grows, which is how a number stops being read within a week.
    expect(out.join('')).toContain('problemi ricorrenti');
  });

  it('counts what is open, which falls when the question is settled', () => {
    const { home, existing, incoming } = homeWithContradiction();
    const first = capture();
    expect(cmdMemoryStats(home)).toBe(0);
    expect(first.out.join('')).toContain('1 da decidere');
    vi.restoreAllMocks();

    const db = new DatabaseCtor(paths(home).db);
    new MemoryStore(db).supersede('host', existing, incoming, '2026-08-14T10:00:00Z');
    db.close();

    const second = capture();
    expect(cmdMemoryStats(home)).toBe(0);
    expect(second.out.join('')).toContain('niente da decidere');
  });
});

describe('muffin memory review', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * The read side the register never had. `store.pendingReview` was called by
   * tests and by nothing in production, so the judge's deliberate *"a human
   * should decide"* outcome accumulated rows nobody could see — which matters
   * more now than when it was written, because the lane that produces them runs
   * unattended.
   */
  it('shows both beliefs with their ids, the judge’s reason, and the command to answer', () => {
    const { home, existing, incoming } = homeWithContradiction();
    const { out } = capture();

    expect(cmdMemoryReview(home)).toBe(1);
    const text = out.join('');
    expect(text).toContain(`#${existing}`);
    expect(text).toContain(`#${incoming}`);
    expect(text).toContain('Marco');
    expect(text).toContain('Lucia');
    expect(text).toContain('nessuna delle due frasi dice quando');
    // A question printed with no way to answer it is not a read side.
    expect(text).toContain(`muffin memory review keep ${incoming}`);
  });

  it('answers one by keeping a side — and never deletes the other', () => {
    const { home, existing, incoming } = homeWithContradiction();
    const { out } = capture();

    expect(cmdMemoryReviewKeep(home, incoming)).toBe(0);
    expect(out.join('')).toContain(`ritiro #${existing}`);

    const db = new DatabaseCtor(paths(home).db);
    const store = new MemoryStore(db);
    const retired = store.factById('host', existing);
    expect(retired).not.toBeNull();
    expect(retired?.supersededBy).toBe(incoming);
    expect(store.factById('host', incoming)?.expiredAt).toBeNull();
    // The register row stays too: append-only, so what the judge asked survives
    // the question being settled.
    expect(store.pendingReview('host')).toHaveLength(1);
    db.close();

    vi.restoreAllMocks();
    const after = capture();
    // And the question is gone from the list, without a status column anywhere:
    // "open" is a join over the two facts.
    expect(cmdMemoryReview(home)).toBe(0);
    expect(after.out.join('')).toContain('niente da decidere');
  });

  it('refuses an id that is not one of the two, instead of reporting success', () => {
    const { home } = homeWithContradiction();
    const { err } = capture();
    expect(cmdMemoryReviewKeep(home, 9999)).toBe(1);
    expect(err.join('')).toContain('contraddizione aperta');
  });

  it('tells an empty register apart from one whose questions are all answered', () => {
    const empty = mkdtempSync(join(tmpdir(), 'muffin-memory-empty-'));
    const db = new DatabaseCtor(paths(empty).db);
    new MemoryStore(db);
    db.close();

    const { out } = capture();
    expect(cmdMemoryReview(empty)).toBe(0);
    expect(out.join('')).toContain('non ha mai dovuto chiedere');
  });

  it('folds a repeating pipeline failure instead of printing it once per fire', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-memory-errors-'));
    const db = new DatabaseCtor(paths(home).db);
    const store = new MemoryStore(db);
    for (const day of ['11', '12', '13']) {
      store.recordReview({
        tenantId: 'host',
        kind: 'error',
        detail: 'estrazione fallita su episodio 7: risposta non parsabile',
        createdAt: `2026-08-${day}T10:00:00Z`,
      });
    }
    db.close();

    const { out } = capture();
    expect(cmdMemoryReview(home)).toBe(0);
    const text = out.join('');
    // One line, with the count and the span — an episode that fails extraction
    // permanently is retried on every fire and would otherwise bury the
    // contradictions this register exists for.
    expect(text.split('estrazione fallita')).toHaveLength(2);
    expect(text).toContain('3×');
  });

  /** Three judge failures on the same (subject, predicate), each with its own raw response. */
  function homeWithJudgeFailures(): string {
    const home = mkdtempSync(join(tmpdir(), 'muffin-memory-judge-errors-'));
    const db = new DatabaseCtor(paths(home).db);
    const store = new MemoryStore(db);
    const responses = ['', 'non è JSON e non lo sarà mai', '{"confidence":"alta"}'];
    const reasons = ['vuota', 'non-json', 'schema: verdict — Invalid option'];
    responses.forEach((raw, i) => {
      store.recordReview({
        tenantId: 'host',
        kind: 'error',
        subject: 'owner',
        predicate: 'interest',
        detail:
          `giudice non disponibile su owner/interest: tengo entrambi i valori [${reasons[i]}]\n` +
          `risposta grezza: ${raw || '(vuota)'}`,
        createdAt: `2026-08-16T10:0${i}:00Z`,
      });
    });
    db.close();
    return home;
  }

  it('folds three judge failures on the same pair even though each raw response differs', () => {
    // The tension this proves is resolved: a judge-unavailable row's `detail`
    // carries the model's own words (`ingest.ts`), which are free to differ
    // call to call even for the exact same recurring failure. Folding on the
    // literal text — correct for "estrazione fallita", above — would stop
    // grouping this kind of row at all. `errorGroups` (`maintenance.ts`) folds
    // on the `subject`/`predicate` columns instead when they are present.
    const { out } = capture();
    expect(cmdMemoryReview(homeWithJudgeFailures())).toBe(0);
    const text = out.join('');
    // One grouped line, not three — and the default view names the typed
    // reason but never shows the raw response.
    expect(text.split('giudice non disponibile su owner/interest')).toHaveLength(2);
    expect(text).toContain('3×');
    expect(text).not.toContain('risposta grezza');
  });

  it('--verbose adds the raw response the default view leaves out', () => {
    const { out } = capture();
    expect(cmdMemoryReview(homeWithJudgeFailures(), true)).toBe(0);
    expect(out.join('')).toContain('risposta grezza');
  });

  it('lists the pinned facts, and their presence alone does not make the exit code non-zero', () => {
    // Pinned is informational, not a question awaiting a decision: `review`'s
    // exit code stays keyed on open contradictions/errors, none of which this
    // home has.
    const { home, factId } = homeWithFact();
    expect(cmdMemoryPin(home, factId)).toBe(0);

    vi.restoreAllMocks();
    const { out } = capture();
    expect(cmdMemoryReview(home)).toBe(0);
    const text = out.join('');
    expect(text).toContain('appuntati');
    expect(text).toContain(`#${factId}`);
  });
});

describe('muffin memory pin / unpin', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pins a fact, and review/why read the change back', () => {
    const { home, factId } = homeWithFact();
    const { out } = capture();

    expect(cmdMemoryPin(home, factId)).toBe(0);
    expect(out.join('')).toContain(`#${factId}`);

    const db = new DatabaseCtor(paths(home).db);
    const store = new MemoryStore(db);
    expect(store.factById('host', factId)?.pinned).toBe(1);
    expect(store.pinnedFacts('host').map((f) => f.id)).toEqual([factId]);
    db.close();
  });

  it('unpins a fact back out of the unconditional core', () => {
    const { home, factId } = homeWithFact();
    expect(cmdMemoryPin(home, factId)).toBe(0);
    vi.restoreAllMocks();
    const { out } = capture();

    expect(cmdMemoryUnpin(home, factId)).toBe(0);
    expect(out.join('')).toContain(`#${factId}`);

    const db = new DatabaseCtor(paths(home).db);
    const store = new MemoryStore(db);
    expect(store.factById('host', factId)?.pinned).toBe(0);
    db.close();
  });

  it('refuses an id that names no fact, for both pin and unpin', () => {
    const { home } = homeWithFact();
    const { err } = capture();
    expect(cmdMemoryPin(home, 999999)).toBe(1);
    expect(cmdMemoryUnpin(home, 999999)).toBe(1);
    expect(err.join('')).toContain('nessun fatto #999999');
  });
});

describe('muffin memory search — cmdMemorySearch reached beyond the argv rejections', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * U1: `cli/main.test.ts` proves the three argv-level rejections (bad date,
   * empty window, future as-of) — all short-circuit *before* `cmdMemorySearch`
   * ever calls `buildRuntime`. Nothing exercised the function past that point,
   * so `--surface`/`--around` reaching `recall()` (`cli/memory.ts:165-169`) had
   * no test that could fail if the wiring were removed. `runInit` gives
   * `buildRuntime` a real, isolated `MUFFIN_HOME` — no key is ever used since
   * `cmdMemorySearch` only calls `recall()`, never the provider directly.
   */
  it('renders RITIRATO, an open-ended validity window, and the successor line, under --as-of', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-memory-search-cli-'));
    runInit({ home, apiKey: 'sk-memory-search-cli-never-called' });

    const db = new DatabaseCtor(paths(home).db);
    const store = new MemoryStore(db);
    const me = store.upsertEntity('host', 'Giusto', 'person', '2026-06-01T10:00:00Z');
    const ep = store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'note sul commercialista', trustTier: 0, createdAt: '2026-06-01T10:00:00Z',
    });
    const base = { tenantId: 'host', subjectId: me, episodeId: ep, trustTier: 0 as const, confidence: 0.9, extractionV: 1 };
    const marco = store.addFact({ ...base, predicate: 'accountant', objectValue: 'Marco', recordedAt: '2026-06-01T10:00:00Z' });
    const lucia = store.addFact({ ...base, predicate: 'accountant', objectValue: 'Lucia', recordedAt: '2026-08-01T10:00:00Z' });
    store.supersede('host', marco, lucia, '2026-08-01T10:00:00Z');
    // A live fact with a stated start and no end, so "valido X → oggi" has a
    // row to come from — Marco/Lucia's own validTo is always a real date.
    store.addFact({
      ...base, predicate: 'lives_in', objectValue: 'Cagliari',
      validFrom: '2020-01-01T00:00:00Z', recordedAt: '2020-01-01T00:00:00Z',
    });
    db.close();

    const { out } = capture();
    // `history: true` (`--history`) rather than a specific `as_of`: it is the
    // mode that must surface the retired Marco row at all, which is the row
    // M17's mutation (`asOf` not passed to `recall`) would silently drop.
    const code = await cmdMemorySearch(home, 'Giusto', { history: true });
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('RITIRATO');
    expect(text).toContain('valido 2020-01-01 → oggi');
    expect(text).toContain('↳ sostituito da');
  });

  it('filters by surface, from the same options object cli/main.ts builds from argv', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-memory-search-surface-'));
    runInit({ home, apiKey: 'sk-memory-search-cli-never-called' });

    const db = new DatabaseCtor(paths(home).db);
    const store = new MemoryStore(db);
    store.addEpisode({
      tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
      kind: 'message', content: 'promemoria dal terminale', trustTier: 0, createdAt: '2026-08-01T10:00:00Z',
    });
    store.addEpisode({
      tenantId: 'host', connector: 'telegram', threadKey: 'g', role: 'user',
      kind: 'message', content: 'promemoria da telegram', trustTier: 0, createdAt: '2026-08-01T10:00:00Z',
    });
    db.close();

    const { out } = capture();
    expect(await cmdMemorySearch(home, 'promemoria', { surface: 'telegram' })).toBe(0);
    const text = out.join('');
    expect(text).toContain('da telegram');
    expect(text).not.toContain('dal terminale');
  });

  it('attaches the surrounding messages when --around is set', async () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-memory-search-around-'));
    runInit({ home, apiKey: 'sk-memory-search-cli-never-called' });

    const db = new DatabaseCtor(paths(home).db);
    const store = new MemoryStore(db);
    const fill = (content: string, minute: number) =>
      store.addEpisode({
        tenantId: 'host', connector: 'cli', threadKey: 't', role: 'user',
        kind: 'message', content, trustTier: 0, createdAt: `2026-08-01T10:0${minute}:00Z`,
      });
    fill('un messaggio prima', 1);
    const anchor = fill('il codice segreto è ZK-9', 2);
    fill('un messaggio dopo', 3);
    db.close();

    const { out } = capture();
    expect(await cmdMemorySearch(home, 'codice segreto', { around: 1 })).toBe(0);
    const text = out.join('');
    expect(text).toContain(`intorno a #${anchor}`);
    expect(text).toContain('un messaggio prima');
    expect(text).toContain('un messaggio dopo');
  });
});

/**
 * La condizione d'uscita del drenaggio a mano.
 *
 * Contava solo il progresso dell'**estrazione**, e dopo un cambio di embedder
 * quello e' zero per costruzione: un wipe dell'indice non lascia episodi
 * pending. Misurato prima di ripararlo, su 250 episodi: un giro scriveva 200
 * chunk (il `limit` di `indexBacklog`), il comando usciva li', e 50 sorgenti
 * restavano fuori dal recall semantico mentre `doctor` diceva «200 chunks, 200
 * vectors, in sync» — cioe' alla lettera il difetto da cui nasce la slice.
 */
describe('drenare l indice e progresso quanto estrarre', () => {
  const giro = (marked: number, indexed: number, fetched: number) => ({ marked, indexed, fetched });

  it('continua quando l estrazione e ferma ma l indice si sta drenando', () => {
    // Il caso del dopo-cambio: niente da estrarre, 200 chunk scritti.
    expect(valeUnAltroGiro(giro(0, 200, 0), 1, 200)).toBe(true);
  });

  it('si ferma quando ne l estrazione ne l indice hanno prodotto niente', () => {
    expect(valeUnAltroGiro(giro(0, 0, 0), 1, 200)).toBe(false);
  });

  it('si ferma su una pagina di estrazione non piena, come prima', () => {
    // La condizione originale resta intatta quando e' l estrazione a lavorare.
    expect(valeUnAltroGiro(giro(3, 0, 3), 1, 200)).toBe(false);
    expect(valeUnAltroGiro(giro(25, 0, 25), 1, 200)).toBe(true);
  });

  it('il tetto sui giri vale comunque, anche mentre l indice si drena', () => {
    // Senza, un indice enorme trasformerebbe il comando in una nottata.
    expect(valeUnAltroGiro(giro(0, 200, 0), 8, 200)).toBe(false);
  });
});
