/** Tipi per `gate-evidence.mjs` (vedi quel file per il contratto reale). */
export interface GateCheckRun {
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly completed_at?: string;
  readonly started_at?: string;
}

export type CheckEvaluation =
  | { readonly ok: true; readonly kind: 'pass'; readonly names: readonly string[] }
  | { readonly ok: false; readonly kind: 'empty' | 'pending' | 'red' | 'missing'; readonly names: readonly string[] };

export type DocsClassification =
  | { readonly ok: true; readonly reason: 'exempt'; readonly count: number }
  | { readonly ok: false; readonly reason: 'incomplete'; readonly got: number | null; readonly want: number | null }
  | { readonly ok: false; readonly reason: 'outside'; readonly offending: readonly string[] };

export function isExemptPath(path: string): boolean;
export function nudeName(name: string): string;
export function latestPerName(runs: readonly GateCheckRun[]): Map<string, { at: number; run: GateCheckRun }>;
export function evaluateChecks(runs: readonly GateCheckRun[], required: readonly string[]): CheckEvaluation;
export function classifyDocsOnly(files: unknown, changedFiles: unknown): DocsClassification;
