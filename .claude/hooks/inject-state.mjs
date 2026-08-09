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

/** The documented cap on hook context. Truncating loudly beats being dropped. */
const MAX = 10_000;

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

if (block.length > MAX) {
  // Say it was cut. A silently truncated handoff reads as a complete one.
  block = `${block.slice(0, MAX - 200)}\n\n[…blocco troncato: leggi docs/blueprint/STATE.md]`;
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `Handoff da docs/blueprint/STATE.md (iniettato automaticamente, ` +
        `sopravvive al compact). È la fonte autoritativa sullo stato:\n\n${block}`,
    },
  }),
);
