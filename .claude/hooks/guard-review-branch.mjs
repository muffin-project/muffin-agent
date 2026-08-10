#!/usr/bin/env node
/**
 * PreToolUse hook: a review branch does not receive commits by accident.
 *
 * The failure this closes happened exactly once and would have happened again.
 * A review subagent checked out `pr4-sicurezza` to read its diff, left HEAD
 * there, and the next commit — an unrelated blueprint document — landed inside
 * the security PR, silently widening the scope of the one change that most
 * needed a narrow diff. Nothing errored. The commit succeeded, the tests passed,
 * and the PR quietly became about two things.
 *
 * `pr*` branches are snapshots under review: they should only ever receive a
 * deliberate `cherry-pick` of a fix that belongs to that slice. So a bare
 * `git commit` on one is refused, with the two ways forward in the message.
 *
 * The override is an environment variable rather than a flag, for the same
 * reason as the dependency guard: it cannot happen by reflex, and it shows up in
 * the transcript as something someone chose.
 *
 * Practice §6, second rung to fourth in one step — justified because the cost of
 * the mistake is invisible (a correct commit, on the wrong branch) and the cost
 * of the guard is a variable on the rare intentional case.
 *
 * **What this guard does NOT protect against, stated because it caught me the
 * hour after I wrote it.** It lives in the repo, on a branch. Check out an older
 * branch and the file disappears along with its line in `settings.json` — so it
 * is absent in exactly the configuration it exists for. It caught nothing the
 * second time; I noticed by reading the branch name.
 *
 * That is this repository's own characteristic defect, committed by the
 * mechanism built to prevent it, and it is not fixable from inside a
 * branch-local file. The real cure is removing the cause: review agents share
 * this working tree and must never `git checkout` at all (docs/JUDGE.md). This
 * guard stays for the orchestrator's own slips on the current branch, which is
 * a smaller promise than it first appeared to make.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let command = '';
try {
  command = String(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '');
} catch {
  process.exit(0);
}

/**
 * Quoted text is payload, not syntax.
 *
 * The exemption test used to run against the whole command, so
 * `git commit -m "document the --amend flag"` disarmed the guard — in a
 * repository whose commit messages are prose about git practice, which is the
 * one place that sentence is likely to be written. Quoted segments are removed
 * before anything is matched.
 */
const bare = command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

// `git commit` only, and git's own flags may carry values: `git -C <path>` and
// `git -c k=v` used to slip past a pattern that consumed flags but not their
// arguments, which meant the two forms most likely to appear in a script were
// exactly the two that were never checked.
if (!/\bgit(?:\s+-\S+(?:\s+\S+)?)*\s+commit\b/.test(bare)) process.exit(0);
// Amend and cherry-pick name a commit deliberately; rebase moves branches by
// design. Tested on the quote-stripped form, so a message cannot claim them.
if (/\bcherry-pick\b|--amend\b/.test(bare)) process.exit(0);
if (/\bMUFFIN_PR_OK=1\b/.test(command) || process.env['MUFFIN_PR_OK'] === '1') process.exit(0);

let branch = '';
try {
  branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  process.exit(0); // not a repo, or git unavailable: not this hook's day
}

if (!/^pr[0-9-]/.test(branch)) process.exit(0);

process.stderr.write(
  `sei su "${branch}", che è un ramo in review — un commit qui allarga la PR senza che si veda.\n` +
    `Di solito quello che vuoi è:\n` +
    `  git checkout <ramo di lavoro>   # e committare lì\n` +
    `  git cherry-pick <sha>           # se il fix appartiene davvero a questa slice\n` +
    `Se è voluto: MUFFIN_PR_OK=1 <comando>\n`,
);
process.exit(2);
