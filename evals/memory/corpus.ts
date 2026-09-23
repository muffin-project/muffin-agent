import DatabaseCtor from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { OpenAICompatProvider } from '../../agent/providers/openai-compat.js';
import { ingestPending } from '../../core/memory/ingest.js';
import { MemoryStore } from '../../core/memory/store.js';
import { JsonlExporter, SimpleTracer } from '../../core/tracing/tracer.js';

/**
 * The old corpus as an evaluation set.
 *
 * Not a migration. The new install starts cold — onboarding can only be tested
 * honestly once, and the previous corpus is three months in which 68% of the
 * text is the agent talking. What it is genuinely good for is measuring recall
 * against ground truth the owner already holds: he knows what he said in May,
 * so he can ask and check. LoCoMo's answer key is 6.4% wrong; this one is not.
 *
 * Reads the old database strictly read-only and writes to a separate eval
 * database. It never opens the production home of the new system.
 *
 *   tsx evals/memory/corpus.ts --source ~/dev/Muffin/muffin.dev.db --plan
 *   tsx evals/memory/corpus.ts --source ... --out /tmp/eval.db --limit 50
 *   tsx evals/memory/corpus.ts --source ... --out /tmp/eval.db      # the lot
 */

type OldMessage = {
  id: number;
  role: string;
  content: string;
  timestamp: string;
  proactive: number | null;
  chat_id: string | null;
};

const TENANT = 'host';

/** Haiku-class list price, only to put a number on a run before it starts. */
const PRICE_IN_PER_MTOK = 1;
const PRICE_OUT_PER_MTOK = 5;
const EST_TOKENS_IN = 650;
const EST_TOKENS_OUT = 160;

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    out: { type: 'string' },
    limit: { type: 'string' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    plan: { type: 'boolean' },
  },
});

const source = values.source;
if (!source) {
  process.stderr.write('serve --source <percorso del vecchio muffin.db>\n');
  process.exit(78);
}

// Read-only, and stated as such: this database is the only copy of three months.
const old = new DatabaseCtor(source, { readonly: true, fileMustExist: true });

const messages = old
  .prepare(
    `SELECT id, role, content, timestamp, proactive, chat_id
     FROM raw_messages
     WHERE content IS NOT NULL AND trim(content) <> ''
     ORDER BY timestamp`,
  )
  .all() as OldMessage[];

const fromOwner = messages.filter((m) => m.role === 'user');
const fromAgent = messages.filter((m) => m.role !== 'user');

process.stderr.write(
  `corpus: ${messages.length} messaggi · ${fromOwner.length} tuoi · ${fromAgent.length} dell'agente\n` +
    `        ${messages[0]?.timestamp.slice(0, 10)} → ${messages[messages.length - 1]?.timestamp.slice(0, 10)}\n`,
);

if (values.plan) {
  // Only the owner's messages are mined; the agent's are stored as evidence and
  // never become facts, so they cost nothing to extract.
  const toExtract = values.limit ? Math.min(Number(values.limit), fromOwner.length) : fromOwner.length;
  const usd =
    (toExtract * EST_TOKENS_IN * PRICE_IN_PER_MTOK) / 1e6 +
    (toExtract * EST_TOKENS_OUT * PRICE_OUT_PER_MTOK) / 1e6;
  process.stderr.write(
    `\npiano: ${toExtract} estrazioni sulla lane light\n` +
      `stima: ~$${usd.toFixed(2)} (${EST_TOKENS_IN} tok in / ${EST_TOKENS_OUT} out per messaggio, prezzi Haiku)\n` +
      `       il prompt cache riduce la parte in input a ogni chiamata dopo la prima\n\n` +
      `rilancia senza --plan per eseguire, o con --limit N per una prova\n`,
  );
  process.exit(0);
}

const out = values.out;
if (!out) {
  process.stderr.write('serve --out <percorso del db di eval> (mai la home di produzione)\n');
  process.exit(78);
}
const apiKey = process.env['LLM_API_KEY'] ?? process.env['OPENROUTER_API_KEY'] ?? '';
if (apiKey === '') {
  process.stderr.write("serve LLM_API_KEY nell'ambiente\n");
  process.exit(78);
}

mkdirSync(dirname(out), { recursive: true });
const evalDb = new DatabaseCtor(out);
evalDb.pragma('journal_mode = WAL');
const store = new MemoryStore(evalDb);

// Import first, extract second: the evidence lands whole even if extraction is
// interrupted, and a second run resumes instead of restarting.
const limit = values.limit ? Number(values.limit) : Number.POSITIVE_INFINITY;
let imported = 0;
let ownerImported = 0;
const importTx = evalDb.transaction(() => {
  for (const m of messages) {
    const isOwner = m.role === 'user';
    if (isOwner && ownerImported >= limit) continue;
    store.addEpisode({
      tenantId: TENANT,
      connector: 'telegram',
      threadKey: m.chat_id ?? 'legacy',
      role: isOwner ? 'user' : 'agent',
      kind: 'message',
      content: m.content,
      // Retroactive provenance: this is the moment tiers enter data that was
      // born without them. Everything here is the owner's own channel.
      trustTier: 0,
      createdAt: m.timestamp,
    });
    imported += 1;
    if (isOwner) ownerImported += 1;
  }
});
importTx();
process.stderr.write(`importati ${imported} episodi (${ownerImported} da estrarre)\n\n`);

const tracer = new SimpleTracer(new JsonlExporter(dirname(out)));
const provider = new OpenAICompatProvider(apiKey, values['base-url'] ?? 'https://openrouter.ai/api/v1', {
  'HTTP-Referer': 'https://github.com/muffin-project/muffin-agent',
  'X-Title': 'muffin-eval-corpus',
});
const model = values.model ?? 'anthropic/claude-haiku-4.5';

let round = 0;
let totals = { episodes: 0, facts: 0, superseded: 0, skipped: 0, review: 0, errors: 0 };
for (;;) {
  const report = await ingestPending({ store, provider, model, tracer }, TENANT, 25);
  if (report.episodes === 0 && report.skippedAgentOutput === 0 && report.skippedDocuments === 0) break;
  round += 1;
  totals = {
    episodes: totals.episodes + report.episodes,
    facts: totals.facts + report.factsAdded,
    superseded: totals.superseded + report.superseded,
    skipped: totals.skipped + report.skippedAgentOutput,
    review: totals.review + report.needsReview.length,
    errors: totals.errors + report.errors.length,
  };
  process.stderr.write(
    `batch ${String(round).padStart(3)} · ${String(totals.episodes).padStart(5)} estratti ` +
      `${String(totals.facts).padStart(5)} fatti ${String(totals.superseded).padStart(3)} ritirati ` +
      `${String(totals.review).padStart(3)} da rivedere ${String(totals.errors).padStart(3)} errori\n`,
  );
  for (const r of report.needsReview) {
    process.stderr.write(`      ? ${r.subject} ${r.predicate}: "${r.existing}" vs "${r.incoming}"\n`);
  }
}

const entities = evalDb.prepare(`SELECT count(*) AS n FROM entities`).get() as { n: number };
const predicates = evalDb
  .prepare(`SELECT predicate, count(*) AS n FROM facts GROUP BY 1 ORDER BY 2 DESC LIMIT 12`)
  .all() as { predicate: string; n: number }[];

process.stderr.write(
  `\nfatto · ${totals.facts} fatti su ${entities.n} entità · ${totals.skipped} messaggi dell'agente ` +
    `tenuti come evidenza e non minati\n\npredicati più frequenti:\n` +
    predicates.map((p) => `  ${String(p.n).padStart(4)}  ${p.predicate}`).join('\n') +
    `\n\ndb di eval: ${out}\n`,
);

evalDb.close();
old.close();
