#!/usr/bin/env node
/**
 * SessionStart hook: the handoff is in context, not merely pointed at.
 *
 * The failure this closes is specific and had happened repeatedly: work would
 * survive a compact as a *reference* to `docs/blueprint/STATE.md` while the
 * content itself was gone, and the next turn would rebuild a wrong picture from
 * the router alone. Claude Code re-injects the project-root `CLAUDE.md` from
 * disk after a compact, but only that file — a nested doc it points to is not
 * covered. STATE.md is nested, so without this hook the START HERE block is
 * exactly the thing that does not come back.
 *
 * This runs on every SessionStart source, which includes `compact`. That is the
 * documented mechanism for re-injecting context after compaction, and it is why
 * no matcher is declared: startup, resume, clear and compact should all ground
 * the session in the same block.
 *
 * Practice §6 again (docs/PRACTICES.md): "read STATE.md first" as prose is
 * advisory and was skipped; as a hook it is not skippable.
 *
 * Deliberately fail-soft. A session that starts without its handoff is a bad
 * day; a session that will not start because a doc was mid-edit is a worse one.
 * Every failure path here exits 0 silently — SessionStart cannot block anyway,
 * so noise would be the only thing a hard failure bought.
 */
import { readFileSync } from 'node:fs';

/**
 * Resolved from this file's own location, never from the cwd and never from
 * $CLAUDE_PROJECT_DIR. The cwd resets between turns (that bug cost us two
 * npm installs in the wrong worktree), and whether CLAUDE_PROJECT_DIR points at
 * a worktree or at the main checkout is undocumented — so neither is load-
 * bearing here. `import.meta.url` is correct in both, by construction.
 */
const STATE = new URL('../../docs/blueprint/STATE.md', import.meta.url);

/**
 * The *work* state, as opposed to the *project* state.
 *
 * STATE.md says where the project is. This says where whoever is driving it is:
 * current objective, open decisions, PRs, delegations in flight. It exists
 * because its absence had a measured symptom — the owner's words, after a day
 * of it: *"ogni cosa non sembra considerare tutto il resto"*.
 *
 * The mechanism of the failure is worth naming, because it is not carelessness.
 * A long conversation does not lose the list of open work gradually; it reduces
 * it to "the last thing we discussed". From there every message reads as an
 * isolated imperative and gets executed on its own — the task loop that
 * `docs/ORCHESTRATION.md` §1 forbids, arrived at by memory decay rather than by
 * choice. `ORCHESTRATION.md` §5 asked for this file and the file did not exist:
 * declared and not connected, the defect this repo keeps finding elsewhere.
 */
const WORK = new URL('../../docs/blueprint/LAVORO.md', import.meta.url);

/**
 * Reserved for the work block, and reserved rather than left over on purpose:
 * it is the half that kept being lost, so it does not get to be the half that
 * gets squeezed. STATE.md keeps its own truncation marker for the remainder.
 */
const WORK_RESERVE = 1_200;

const WORK_START = '<!-- INIZIO BLOCCO -->';
const WORK_END = '<!-- FINE BLOCCO -->';

/**
 * The documented cap on hook output. Past it, Claude Code replaces the whole
 * string with a preview and a file path — which turns the handoff back into a
 * pointer to STATE.md, the exact failure this hook exists to close.
 *
 * The cap applies to what is EMITTED, not to the block: the preamble below is
 * part of the string that gets measured. Capping the block alone left a ~125
 * character window (block 9,876-10,000) where the output silently exceeded the
 * limit with no truncation marker — verified by sweeping a crafted STATE.md
 * through this script.
 */
const MAX = 10_000;

const PREAMBLE =
  'Handoff da docs/blueprint/STATE.md (iniettato automaticamente, ' +
  'sopravvive al compact). È la fonte autoritativa sullo stato:\n\n';

const CUT_MARKER = '\n\n[…blocco troncato: leggi docs/blueprint/STATE.md]';

const WORK_PREAMBLE =
  'Stato del lavoro in corso (docs/blueprint/LAVORO.md). Va aggiornato a ogni ' +
  'iterazione, PRIMA di scegliere il prossimo obiettivo:\n\n';

let text;
try {
  text = readFileSync(STATE, 'utf8');
} catch {
  process.exit(0); // no STATE.md here: not this repo, not this hook's business
}

// The block runs from the START HERE marker to the first horizontal rule, which
// is where the detailed chronicle begins. Anchored on the ⭐ marker rather than
// on a line number so that editing STATE.md cannot silently shift the window.
const start = text.indexOf('⭐');
if (start === -1) process.exit(0);
const rule = text.indexOf('\n---', start);
let block = (rule === -1 ? text.slice(start) : text.slice(start, rule)).trim();

// The work block, read the same fail-soft way: a missing or malformed LAVORO.md
// costs the work state, never the handoff.
let work = '';
try {
  const raw = readFileSync(WORK, 'utf8');
  const from = raw.indexOf(WORK_START);
  const to = raw.indexOf(WORK_END, from);
  if (from !== -1 && to !== -1) work = raw.slice(from + WORK_START.length, to).trim();
} catch {
  work = '';
}
if (work.length > WORK_RESERVE) work = work.slice(0, WORK_RESERVE - CUT_MARKER.length) + CUT_MARKER;

const workOut = work.length > 0 ? `${WORK_PREAMBLE}${work}\n\n` : '';

// Measured against the emitted string, which is what the cap applies to. The
// work block is subtracted first: it is reserved, not leftover.
const budget = MAX - PREAMBLE.length - workOut.length;
if (block.length > budget) {
  block = block.slice(0, budget - CUT_MARKER.length) + CUT_MARKER;
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: workOut + PREAMBLE + block,
    },
  }),
);
