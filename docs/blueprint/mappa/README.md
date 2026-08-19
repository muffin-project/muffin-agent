# Architecture map — derived view

This directory contains Muffin's visual architecture map and the scripts/data
used to build it.

**Role: DERIVED VIEW. It is never an independent source of truth.**

For current authority start at `docs/README.md`:

- literal mechanics → code/schema/shipped config;
- current semantic architecture → `docs/ARCHITECTURE.md`;
- current security boundaries → `docs/SECURITY.md`;
- DAY-1 status → `docs/blueprint/M5-BIS.md`.

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
3. run `node docs/blueprint/mappa/ancore.mjs`;
4. review any **changed-text** warning instead of blindly re-anchoring;
5. run `node docs/blueprint/mappa/build.mjs` and the map tests.

A successful anchor regeneration does not certify the prose around the anchor.

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
