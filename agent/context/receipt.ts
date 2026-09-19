import { createHash } from 'node:crypto';
import type { TrustTier } from '../../core/policy/types.js';
import type { TenantClass } from './assemble.js';

/**
 * Context Receipt (S0): read-only observability over context assembly.
 *
 * For one turn, it explains *why* every important token is in the request:
 * which sources entered, in what size, under which taint, what was excluded,
 * and what is cacheable versus volatile. It never changes what is assembled —
 * it only shapes metadata the caller already measured.
 *
 * ## Not a source of truth
 *
 * This module recomputes nothing: no history slicing, no recall, no todo
 * reads, no tool filtering. The caller passes the exact descriptors of what
 * it assembled (or is about to send) and gets back a fixed-vocabulary
 * rollup. If assembly changes, the receipt changes only because its input
 * changed. There is deliberately no code path here that can disagree with
 * `buildContext`, `recall`, or `visibleTools` about *what* was selected.
 *
 * ## No raw content, by construction
 *
 * No field in this module holds prompt text, memory text, history text,
 * owner text, todo text, file paths, or secrets. Sizes travel as
 * `TextMeasure` (bytes/chars/estimate/sha); everything else travels as
 * counts, names of harness catalogue entries (tool names, block names),
 * tiers, and reasons. A receipt serialized to JSON is safe to paste into a
 * diagnostic log: `receipt.test.ts` asserts a fixture secret appears
 * nowhere in the output.
 *
 * ## Vocabulary note (undecided term)
 *
 * Workspace/file results are reported under the neutral `workspace_files`
 * category. Whether the wider `artifact` term names a real primitive is
 * still open — the knowledge-architecture/community use case is under
 * analysis — and this module takes no position on it: no `artifact`
 * category, no `artifact` verdict, nothing for a later decision to undo.
 */

/** Receipt schema version, bumped only for breaking shape changes. */
export const RECEIPT_VERSION = 1;

/**
 * Size of a text the caller measured, without the text itself.
 *
 * `sha` is the first 12 hex chars of sha256: enough to correlate a receipt
 * line with a block whose bytes the caller still holds, not enough to
 * recover anything.
 */
export type TextMeasure = {
  bytes: number;
  chars: number;
  /** Heuristic, ~4 chars/token. A budgeting aid, never a billing claim. */
  tokenEstimate: number;
  sha: string;
};

/** Measure a text without retaining it. The string never enters the receipt. */
export function measureText(s: string): TextMeasure {
  const bytes = Buffer.byteLength(s, 'utf8');
  const chars = [...s].length;
  return {
    bytes,
    chars,
    tokenEstimate: estimateTokens(chars),
    sha: createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12),
  };
}

/** The shared chars→tokens heuristic. Exported so callers estimate the same way. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** One system-prompt block: name and size, never text. */
export type SystemBlockReceipt = {
  name: string;
  measure: TextMeasure;
};

/** One reinjected history message: role and size, never content. */
export type HistoryMessageReceipt = {
  role: 'user' | 'assistant';
  measure: TextMeasure;
  tier: TrustTier;
  surfaceMarked: boolean;
  undoneMarked: boolean;
};

/** One recalled memory item: provenance and size, never text. */
export type MemoryItemReceipt = {
  id?: string | number;
  source: string;
  origin: string;
  trustTier: TrustTier;
  chars: number;
  tokenEstimate: number;
  /** Why this item entered: ranking slot, pinned core, neighbourhood, gap note. */
  reason: string;
  neighbour?: boolean;
  superseded?: boolean;
};

/** One open plan row: addressing and state, never text or note. */
export type TodoRowReceipt = {
  seq: number;
  state: string;
  tier: TrustTier;
  due: boolean;
};

/** Closed set of harness-written message kinds the loop can inject. */
export type SyntheticKind =
  | 'history-cut'
  | 'completion-nudge'
  | 'recovery'
  | 'tool-result'
  | 'wake-report'
  | 'steer'
  | 'repair';

/** One synthetic (non-owner) message: kind and size, never text. */
export type SyntheticMessageReceipt = {
  kind: SyntheticKind;
  role: 'user' | 'system' | 'assistant';
  measure: TextMeasure;
  trigger?: string;
};

/** Material that did not enter, and the reason it stayed out. */
export type ExcludedReceipt = {
  what: string;
  reason: string;
  count?: number;
};

/** A redaction/compaction action applied before or at send time. Counts only. */
export type RedactionReceipt = {
  kind: string;
  count: number;
  note?: string;
};

export type CategoryCacheability = 'stable' | 'profile-stable' | 'volatile';

/**
 * Per-category cacheability, where determinable from assembly order.
 *
 * `system` is the boot-built byte-identical prefix (`assemble.ts`); `tools`
 * is stable within a profile install; everything else is rebuilt per turn
 * and rides the volatile tail (`context.ts`). Unknown stays `volatile`:
 * claiming cacheability without a measured prefix is how warm prefixes go
 * cold silently.
 */
export const CATEGORY_CACHEABILITY: Readonly<Record<string, CategoryCacheability>> = {
  system: 'stable',
  history: 'volatile',
  memory: 'volatile',
  plan: 'volatile',
  runtime: 'volatile',
  owner_input: 'volatile',
  tools: 'profile-stable',
  synthetic: 'volatile',
};

export type ContextReceiptInput = {
  tenantClass: TenantClass;
  promptVersion?: string;
  model?: string;
  profile?: string;
  surface?: string;
  systemBlocks: SystemBlockReceipt[];
  history: { kept: HistoryMessageReceipt[]; dropped: number };
  memory: {
    items: MemoryItemReceipt[];
    gaps: number;
    pinnedOverflow: number;
    strategies: string[];
  };
  plan: { open: TodoRowReceipt[]; planTaint: TrustTier; measure: TextMeasure };
  runtime: {
    measure: TextMeasure;
    /** sha12 of the workspace path, never the path: it can name the owner. */
    cwdHash: string;
    cwdEntries: number;
    cwdShown: number;
    jobCount: number;
    safeMode: boolean;
  };
  ownerInput: { measure: TextMeasure; media: { kind: 'image' | 'audio'; bytes: number }[] };
  tools: {
    profileName: string;
    cap: number;
    exposed: string[];
    cut: string[];
    cutReason?: string;
    toolChoice: 'auto' | 'none' | 'required';
    specMeasure: TextMeasure;
  };
  synthetic: SyntheticMessageReceipt[];
  excluded: ExcludedReceipt[];
  taint: { ceiling: TrustTier; history: TrustTier; memory: TrustTier; plan: TrustTier };
  redactions: RedactionReceipt[];
};

export type CategoryTotals = { bytes: number; tokenEstimate: number };

export type ContextReceipt = ContextReceiptInput & {
  version: number;
  totals: CategoryTotals;
  byCategory: Readonly<Record<string, CategoryTotals>>;
  cacheability: Readonly<Record<string, CategoryCacheability>>;
};

function sum(measures: TextMeasure[]): CategoryTotals {
  return measures.reduce<CategoryTotals>(
    (acc, m) => ({
      bytes: acc.bytes + m.bytes,
      tokenEstimate: acc.tokenEstimate + m.tokenEstimate,
    }),
    { bytes: 0, tokenEstimate: 0 },
  );
}

/**
 * Build the receipt. Pure shaping over caller-measured metadata: no reads,
 * no writes, no selection, no raw text in, no raw text out.
 */
export function buildContextReceipt(input: ContextReceiptInput): ContextReceipt {
  const system = sum(input.systemBlocks.map((b) => b.measure));
  const history = sum(input.history.kept.map((m) => m.measure));
  const memoryItems = input.memory.items.reduce<CategoryTotals>(
    (acc, i) => ({
      bytes: acc.bytes + i.chars,
      tokenEstimate: acc.tokenEstimate + i.tokenEstimate,
    }),
    { bytes: 0, tokenEstimate: 0 },
  );
  const byCategory: Record<string, CategoryTotals> = {
    system,
    history,
    memory: memoryItems,
    plan: { bytes: input.plan.measure.bytes, tokenEstimate: input.plan.measure.tokenEstimate },
    runtime: {
      bytes: input.runtime.measure.bytes,
      tokenEstimate: input.runtime.measure.tokenEstimate,
    },
    owner_input: {
      bytes:
        input.ownerInput.measure.bytes + input.ownerInput.media.reduce((a, m) => a + m.bytes, 0),
      tokenEstimate: input.ownerInput.measure.tokenEstimate,
    },
    tools: {
      bytes: input.tools.specMeasure.bytes,
      tokenEstimate: input.tools.specMeasure.tokenEstimate,
    },
    synthetic: sum(input.synthetic.map((s) => s.measure)),
  };
  const totals = Object.values(byCategory).reduce<CategoryTotals>(
    (acc, c) => ({
      bytes: acc.bytes + c.bytes,
      tokenEstimate: acc.tokenEstimate + c.tokenEstimate,
    }),
    { bytes: 0, tokenEstimate: 0 },
  );
  return {
    ...input,
    version: RECEIPT_VERSION,
    totals,
    byCategory,
    cacheability: CATEGORY_CACHEABILITY,
  };
}

/**
 * One-line-per-category human rendering. Deterministic field order, no raw
 * content: block names, counts, tiers, reasons, hashes. Fit for stderr or a
 * diagnostics attachment.
 */
export function renderReceiptText(r: ContextReceipt): string {
  const lines = [
    `context-receipt v${r.version} class=${r.tenantClass}` +
      (r.promptVersion ? ` prompt=${r.promptVersion}` : '') +
      (r.model ? ` model=${r.model}` : '') +
      (r.profile ? ` profile=${r.profile}` : '') +
      (r.surface ? ` surface=${r.surface}` : ''),
    `totals: ${r.totals.bytes} bytes ~${r.totals.tokenEstimate} tokens (estimate)`,
  ];
  const cat = (name: string, extra: string) => {
    const t = r.byCategory[name] ?? { bytes: 0, tokenEstimate: 0 };
    lines.push(
      `- ${name} [${r.cacheability[name] ?? 'volatile'}]: ${t.bytes} bytes ~${t.tokenEstimate} tokens — ${extra}`,
    );
  };
  cat('system', r.systemBlocks.map((b) => `${b.name}@${b.measure.sha}`).join(', ') || 'none');
  cat(
    'history',
    `${r.history.kept.length} kept, ${r.history.dropped} dropped` +
      (r.history.kept.length === 0 && r.history.dropped === 0
        ? ''
        : `, max-tier ${maxTier(r.history.kept.map((m) => m.tier))}`),
  );
  cat(
    'memory',
    `${r.memory.items.length} items` +
      (r.memory.gaps > 0 ? `, ${r.memory.gaps} gaps` : '') +
      (r.memory.pinnedOverflow > 0 ? `, ${r.memory.pinnedOverflow} pinned-overflow` : '') +
      (r.memory.strategies.length > 0 ? ` (${r.memory.strategies.join(', ')})` : ''),
  );
  cat(
    'plan',
    r.plan.open.length === 0
      ? 'no open rows (zero cost)'
      : `${r.plan.open.length} open, plan-taint ${r.plan.planTaint}`,
  );
  cat(
    'runtime',
    `cwd#${r.runtime.cwdHash} ${r.runtime.cwdShown}/${r.runtime.cwdEntries} entries, ${r.runtime.jobCount} jobs, safe-mode=${r.runtime.safeMode ? 'yes' : 'no'}`,
  );
  cat(
    'owner_input',
    `${r.ownerInput.measure.bytes} bytes` +
      (r.ownerInput.media.length > 0
        ? ` + ${r.ownerInput.media.length} media (${r.ownerInput.media.map((m) => m.kind).join(', ')})`
        : ''),
  );
  cat(
    'tools',
    `${r.tools.exposed.length} exposed (cap ${r.tools.cap}, choice ${r.tools.toolChoice})` +
      (r.tools.cut.length > 0
        ? `, CUT ${r.tools.cut.length}: ${r.tools.cut.join(', ')}`
        : ', nothing cut'),
  );
  cat(
    'synthetic',
    r.synthetic.length === 0
      ? 'none'
      : r.synthetic
          .map((s) => `${s.kind}(${s.role}${s.trigger ? `:${s.trigger}` : ''})`)
          .join(', '),
  );
  if (r.excluded.length > 0) {
    lines.push(
      `- excluded: ${r.excluded.map((e) => `${e.what} (${e.reason}${e.count !== undefined ? `, n=${e.count}` : ''})`).join('; ')}`,
    );
  } else {
    lines.push('- excluded: none recorded');
  }
  lines.push(
    `taint: ceiling=${r.taint.ceiling} (history=${r.taint.history} memory=${r.taint.memory} plan=${r.taint.plan})`,
  );
  if (r.redactions.length > 0) {
    lines.push(`- redactions: ${r.redactions.map((x) => `${x.kind} x${x.count}`).join(', ')}`);
  } else {
    lines.push('- redactions: none recorded');
  }
  return lines.join('\n');
}

function maxTier(tiers: TrustTier[]): TrustTier {
  return tiers.reduce<TrustTier>((m, t) => (t > m ? t : m), 0);
}
