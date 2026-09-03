# Architecture map — derived view

This directory contains Muffin's visual architecture map and the scripts/data
used to build it.

**Role: DERIVED VIEW. It is never an independent source of truth.**

For current authority start at `docs/README.md`:

- literal mechanics → code/schema/shipped config;
- current semantic architecture → `docs/ARCHITECTURE.md`;
- current security boundaries → `docs/SECURITY.md`;
- DAY-1 status → `docs/work/day1/requirements-status.md`.

## What is actually verified here

`ancore.mjs` and `mappa.test.ts` provide a useful but deliberately limited
property:

> every `file:line` citation used by the map still resolves to the same source
> text, or the test asks for review.

That catches renamed/moved/changed code and prevents a citation from silently
pointing at unrelated text.

It does **not** prove that the surrounding editorial sentence in a
`data-*.json` file is still semantically true.

This distinction matters. A map entry can cite a valid policy function while
still carrying an old default value in its prose. The repository has already
observed exactly that failure with `paramsMaxTaint`: shipped
`defaults/rot/policy.json` moved to `2` while map prose still said `1`.

## File roles

```text
data-*.json   editorial input/snapshot for the visual map
ancore.mjs    citation drift checker/generator
ancore.json   generated citation baseline
build.mjs     assembles the visual artifact
mappa.html    generated visual artifact
template.html renderer input
mappa.test.ts verifies citation integrity, not every semantic statement
```

Do not use `data-*.json` as an API/schema/config reference. If exact current
mechanics matter, follow the cited source and verify the executable authority.

## Editing discipline

When a change intentionally alters something represented in the map:

1. update the authoritative source first;
2. update the relevant editorial map entry only if the visual explanation still
   adds value;
3. run `npm run mappa:regen` (equivalent to `ancore.mjs` then `build.mjs`,
   plus `git add` on the two generated files — never hand-edit them);
4. review any **changed-text** warning instead of blindly re-anchoring (rerun
   `ancore.mjs --riancora` only after confirming the new text is what the map
   should now say);
5. run the map tests (`npx vitest run docs/derived/architecture-map`).

A successful anchor regeneration does not certify the prose around the anchor.

## Conflicts between concurrent branches

`ancore.json` and `mappa.html` are pure functions of the cited code plus
`data-*.json`, so two branches that each move a cited line collide on these
two generated files even when their real changes never overlap — and
`mappa.html` in particular is one giant inlined JSON blob, so Git's textual
merge on it conflicts on nearly any concurrent change, not just an
overlapping one. Two defences, both registered locally by `npm run prepare`
(so every `npm ci` sets them up without a separate step):

- **A `merge=mappa-regen` git attribute** (`.gitattributes`), configured by
  `setup-merge-driver.mjs` as the builtin `true` driver: a conflict on either
  file just keeps "ours", so `git merge`/`git rebase` never stops to show a
  human 289 KB of generated JSON/HTML to merge by hand. This does **not**
  compute correct content — it can't, reliably: mid-merge, Git does not
  guarantee that every other path this map cites is already on disk (or even
  in the index) yet. A driver that tried anyway, during development of this
  mechanism, silently wrote a wrong line number into a merge that reported
  success. A clone that never ran `npm install` gets Git's normal 3-way text
  merge instead: today's behaviour, not a silent wrong merge.
- **`post-merge-regen.mjs`**, run by `.githooks/post-merge` and
  `.githooks/post-rewrite` (`git rebase`; `core.hooksPath` also registered by
  `setup-merge-driver.mjs`) immediately after the merge/rebase has actually
  finished, when the working tree is guaranteed complete: it reruns
  `ancore.mjs` then `build.mjs` and, if anything changed, commits the result
  as `chore(docs): regenerate architecture map after merge [auto]`. It
  refuses to commit anything — same as `ancore.mjs` always has — when the
  rerun reports a broken reference or genuine drift, leaving that for a human
  instead of inventing a resolution the drift check itself wouldn't produce.
- **`.githooks/pre-commit`** independently refuses a plain commit when
  `ancore.mjs --check` reports the working tree stale, catching a manual
  resolution that forgot to regenerate before it reaches CI.

All three are conveniences on top of the real guarantee, which is unchanged:
`mappa.test.ts` in CI (`ci.yml` and `collegamenti.yml`) fails whenever a
committed anchor no longer matches the code it cites, regardless of how the
map got that way.

## Future direction

Do not turn this directory into a second introspection framework merely to make
it "fully generated".

Where a volatile field has one cheap executable source — for example a shipped
policy literal, schema field or registered capability — a future map checker may
derive or compare that field mechanically. Add such checks only with a real
consumer and a concrete drift failure they prevent.

If a value cannot be derived reliably, it is better for the map to omit it than
to maintain a confident manual copy.

This follows the same rule as the rest of the repository: **one guarantee, one
authoritative owner; views may project it but do not own it.**
