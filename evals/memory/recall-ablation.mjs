import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { recall, renderForPrompt } from '../../core/memory/recall.ts';
import { RERANK_MIN_CANDIDATES } from '../../core/memory/rerank.ts';
import { MemoryStore } from '../../core/memory/store.ts';

// Offline retrieval ablation using published turn-level labels. The oracle is
// an upper bound within the candidates the reranker receives, not a model.
const [dataPath] = process.argv.slice(2);
if (!dataPath) {
  process.stderr.write(
    'Usage: node --import tsx evals/memory/recall-ablation.mjs <LongMemEval-S JSON>\n',
  );
  process.exit(64);
}
const rows = JSON.parse(readFileSync(dataPath, 'utf8'));
const hash = (id) =>
  createHash('sha256').update(`muffin-recall-pilot-2026-11-08:${id}`).digest('hex');
const selected = rows.sort((a, b) => hash(a.question_id).localeCompare(hash(b.question_id)));
const quota = new Map();
const samples = selected.filter(({ question_id, question_type }) => {
  const category = question_id.endsWith('_abs') ? 'abstention' : question_type;
  const previous = quota.get(category) ?? 0;
  if (previous >= (category === 'abstention' ? 6 : 8)) return false;
  quota.set(category, previous + 1);
  return true;
});

const timestamp = (value) => {
  const [, y, m, d, h = '00', n = '00'] =
    /^(\d{4})[/-](\d\d)[/-](\d\d)(?:\s+\([^)]*\))?(?:[ T](\d\d):(\d\d))?/.exec(value) ?? [];
  if (!y) throw new Error('Unexpected source date');
  return `${y}-${m}-${d}T${h}:${n}:00.000Z`;
};
const pct = (value) => Math.round(value * 1000) / 10;
const sum = (values) => values.reduce((a, b) => a + b, 0);
const percentile = (values, p) =>
  Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] * 100) / 100;
const results = [];
for (const row of samples) {
  const db = new Database(':memory:');
  try {
    const store = new MemoryStore(db);
    const gold = new Set();
    db.transaction(() => {
      for (const [i, session] of row.haystack_sessions.entries()) {
        for (const message of session) {
          const id = store.addEpisode({
            tenantId: 'host',
            connector: 'cli',
            threadKey: row.haystack_session_ids[i],
            role: message.role === 'user' ? 'user' : 'agent',
            kind: 'message',
            content: message.content,
            trustTier: 0,
            createdAt: timestamp(row.haystack_dates[i]),
          });
          if (message.has_answer === true) gold.add(id);
        }
      }
    })();
    const start = performance.now();
    const baseline = await recall({ store }, 'host', row.question);
    const recallMs = performance.now() - start;
    let candidates;
    const ceiling = await recall(
      {
        store,
        reranker: {
          id: 'label-oracle',
          async rerank(_query, items, topK) {
            candidates = items;
            const sorted = [...items].sort(
              (a, b) => Number(gold.has(b.id)) - Number(gold.has(a.id)),
            );
            return { items: sorted.slice(0, topK), reordered: true };
          },
        },
      },
      'host',
      row.question,
    );
    const count = (items) =>
      items.filter((item) => item.kind === 'episode' && gold.has(item.id)).length;
    const baselineCount = count(baseline.items);
    const ceilingCount = count(ceiling.items);
    results.push({
      id: row.question_id,
      category: row.question_id.endsWith('_abs') ? 'abstention' : row.question_type,
      gold: gold.size,
      baselineCount,
      ceilingCount,
      recallMs,
      candidates: candidates?.length ?? null,
      returnedItems: baseline.items.length,
      memoryChars: renderForPrompt(baseline).length,
    });
  } finally {
    db.close();
  }
}
const scored = results.filter((r) => r.category !== 'abstention' && r.gold > 0);
const summarize = (group) => ({
  n: group.length,
  eligible: group.filter((r) => r.candidates !== null).length,
  allEvidenceBaseline: group.filter((r) => r.baselineCount === r.gold).length,
  allEvidenceCeiling: group.filter((r) => r.ceilingCount === r.gold).length,
  noEvidenceBaseline: group.filter((r) => r.baselineCount === 0).length,
  noEvidenceCeiling: group.filter((r) => r.ceilingCount === 0).length,
  baselineMacroRecall: pct(sum(group.map((r) => r.baselineCount / r.gold)) / group.length),
  oracleMacroRecall: pct(sum(group.map((r) => r.ceilingCount / r.gold)) / group.length),
  gains: group.filter((r) => r.ceilingCount > r.baselineCount).length,
  losses: group.filter((r) => r.ceilingCount < r.baselineCount).length,
});
const categories = [...new Set(scored.map((r) => r.category))].sort();
console.log(
  JSON.stringify(
    {
      thresholds: { rerankMin: RERANK_MIN_CANDIDATES, top: 8 },
      total: rows.length,
      selected: results.length,
      scored: summarize(scored),
      byCategory: Object.fromEntries(
        categories.map((c) => [c, summarize(scored.filter((r) => r.category === c))]),
      ),
      notScored: results
        .filter((r) => r.category !== 'abstention' && r.gold === 0)
        .map((r) => r.id),
      abstentionCases: results
        .filter((r) => r.category === 'abstention')
        .map((r) => ({ id: r.id, returnedItems: r.returnedItems })),
      latencyMs: {
        p50: percentile(
          results.map((r) => r.recallMs),
          0.5,
        ),
        p95: percentile(
          results.map((r) => r.recallMs),
          0.95,
        ),
      },
      renderedChars: {
        p50: percentile(
          results.map((r) => r.memoryChars),
          0.5,
        ),
        p95: percentile(
          results.map((r) => r.memoryChars),
          0.95,
        ),
      },
      selectedIds: results.map((r) => r.id),
    },
    null,
    2,
  ),
);
