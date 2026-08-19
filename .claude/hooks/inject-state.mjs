#!/usr/bin/env node
/**
 * SessionStart hook: inject the current operational handoff, and nothing else.
 *
 * Repository/product knowledge is discovered through the root routers and
 * `docs/README.md`. SessionStart only needs the small piece that is otherwise
 * easiest to lose across a fresh session or compaction: what work is live now.
 *
 * `docs/blueprint/LAVORO.md` is deliberately non-authoritative and disposable.
 * Observed Git/PR state wins when the two disagree.
 *
 * Fail-soft by design. SessionStart cannot usefully block because a handoff is
 * temporarily absent or malformed.
 */
import { readFileSync } from 'node:fs';

const WORK = new URL('../../docs/blueprint/LAVORO.md', import.meta.url);

// Claude Code permits a larger hook payload, but the repository chooses a much
// smaller local budget so bootstrap context cannot quietly become a manual.
const MAX_CONTEXT = 4_000;
const PREAMBLE =
  'Operational handoff from docs/blueprint/LAVORO.md. It is not product ' +
  'authority; observed Git/PR state wins. Use docs/README.md to discover ' +
  'deeper context only when the task requires it.\n\n';
const CUT_MARKER =
  '\n\n[…handoff truncated: read docs/blueprint/LAVORO.md before choosing work]';

let work;
try {
  work = readFileSync(WORK, 'utf8').trim();
} catch {
  process.exit(0);
}

if (!work) process.exit(0);

const budget = MAX_CONTEXT - PREAMBLE.length;
if (budget <= CUT_MARKER.length) process.exit(0);
if (work.length > budget) {
  work = work.slice(0, budget - CUT_MARKER.length) + CUT_MARKER;
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: PREAMBLE + work,
    },
  }),
);
