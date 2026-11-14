/**
 * The repository's deterministic token estimator.
 *
 * `cli/prompt-show.ts` and the acceptance harness already bill a request as
 * `ceil(chars / 4)`. It is not a model tokenizer. The prefix budgets use the
 * same function so a test and `muffin prompt show` cannot disagree about the
 * number they are both calling "tokens".
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export type PrefixBlockReport = {
  name: string;
  chars: number;
  tokens: number;
  /** Absent when the block has no budget (an empty optional block, a name the table does not know). */
  budget: number | null;
};

export function prefixBreakdown(
  blocks: readonly { name: string; text: string }[],
  budgets: Readonly<Record<string, number>>,
): PrefixBlockReport[] {
  return blocks
    .filter((block) => block.text.length > 0)
    .map((block) => ({
      name: block.name,
      chars: block.text.length,
      tokens: estimateTokens(block.text),
      budget: budgets[block.name] ?? null,
    }));
}

/** One line per block, for stderr and for the test log. */
export function formatPrefixBreakdown(
  rows: readonly PrefixBlockReport[],
  totalTokens: number,
  totalBudget: number,
): string {
  const lines = rows.map((row) => {
    const cap = row.budget === null ? '' : ` / tetto ${row.budget}`;
    return `  ${row.name}: ${row.chars} caratteri, ~${row.tokens} token${cap}`;
  });
  lines.push(`prefisso: ~${totalTokens} token / tetto ${totalBudget}`);
  return lines.join('\n');
}
