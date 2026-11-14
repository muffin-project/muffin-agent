import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../../cli/init.js';
import { SYSTEM as EXTRACT_SYSTEM } from '../../core/memory/extract.js';
import { SYSTEM as JUDGE_SYSTEM } from '../../core/memory/judge.js';
import { SYSTEM as RERANK_SYSTEM } from '../../core/memory/rerank.js';
import { buildRuntime } from '../runtime.js';
import {
  buildSystemPromptBlocks,
  estimateTokens,
  MINIMAL_TOKEN_BUDGET,
  PREFIX_TOKEN_BUDGET,
  PROMPT_BLOCK_BUDGETS,
  renderSystemPrompts,
  reportPrefix,
} from './assemble.js';
import { formatPrefixBreakdown } from './tokens.js';

/**
 * The greeting prefix, measured the way `muffin prompt show` measures it.
 *
 * A fresh `muffin init` home, not a stub: the blocks are the ones production
 * ships. The log line is the before/after breakdown. The assertions are the
 * ceilings — identity under 1000, the joined owner prefix under 4000, and no
 * block over its own budget. Pasting the voice examples back into a block
 * fails here.
 */
describe('prefix budgets', () => {
  it('a greeting on a fresh home stays under the ceilings, and prints the breakdown', () => {
    const home = mkdtempSync(join(tmpdir(), 'muffin-prefix-'));
    const workspace = mkdtempSync(join(tmpdir(), 'muffin-prefix-ws-'));
    runInit({ home, apiKey: 'sk-prefix-never-called' });
    const runtime = buildRuntime(home, workspace);
    try {
      const blocks = runtime.promptBlocks.owner;
      const prompt = runtime.deps.systemPrompts.owner;
      const rows = reportPrefix(blocks);
      const tokens = estimateTokens(prompt);
      console.log(formatPrefixBreakdown(rows, tokens, PREFIX_TOKEN_BUDGET));
      console.log(`gruppo: ~${estimateTokens(runtime.deps.systemPrompts.group)} token`);
      console.log(`minimo: ~${estimateTokens(runtime.deps.minimalPrompt ?? '')} token`);

      expect(blocks.map((block) => block.name)).toEqual([
        'identity',
        'skills',
        'work-rules',
        'safe-mode',
      ]);
      expect(prompt).toContain('Il registro segue il momento');
      expect(prompt).toContain('Lavoro resta lavoro');
      expect(prompt).toContain('Lo scherzo si risponde con lo scherzo');
      expect(prompt).toContain('Un momento emotivo chiede sintonia');
      expect(prompt).not.toMatch(/15% dei messaggi/);

      for (const row of rows) {
        expect(row.budget, row.name).not.toBeNull();
        expect(row.tokens, row.name).toBeLessThanOrEqual(row.budget ?? 0);
      }
      expect(tokens).toBeLessThanOrEqual(PREFIX_TOKEN_BUDGET);
      expect(estimateTokens(runtime.deps.minimalPrompt ?? '')).toBeLessThanOrEqual(
        MINIMAL_TOKEN_BUDGET,
      );
      expect(runtime.deps.minimalPrompt).not.toContain('Non mi dai ragione per farmi contento');

      const group = renderSystemPrompts(buildSystemPromptBlocks(home, false, '')).group;
      for (const floor of [
        'Il registro segue il momento',
        'Lavoro resta lavoro',
        'In gruppo occupo meno spazio che in privato',
        'Non sono il filo principale della conversazione',
        "Le informazioni private dell'owner non diventano materiale",
        'La familiarità con il mio owner non si trasferisce',
        '🧁 è ancora più raro in gruppo',
        "non «l'utente»",
        'Rido con te, non di te',
        'Non faccio il terapeuta, il coach o il motivational speaker',
      ]) {
        expect(group, floor).toContain(floor);
      }
      expect(estimateTokens(blocks.find((block) => block.name === 'persona')?.text ?? '')).toBe(0);
      const groupPersona = runtime.promptBlocks.group.find((block) => block.name === 'persona');
      expect(estimateTokens(groupPersona?.text ?? '')).toBeLessThanOrEqual(
        PROMPT_BLOCK_BUDGETS.persona ?? 0,
      );
    } finally {
      runtime.close();
    }
  });

  it('consolidation task prompts stay task prompts', () => {
    // These calls do not go through the interactive assembler. The ceiling is
    // what stops a later edit from pasting the character in front of them.
    for (const [name, text, budget] of [
      ['extract', EXTRACT_SYSTEM, 2000],
      ['judge', JUDGE_SYSTEM, 800],
      ['rerank', RERANK_SYSTEM, 400],
    ] as const) {
      expect(estimateTokens(text), name).toBeLessThanOrEqual(budget);
      expect(text, name).not.toContain('Il registro segue il momento');
    }
  });
});
