# Automatic recall without the model reranker

Follows [foreground-memory-latency-2026-11-08.md](foreground-memory-latency-2026-11-08.md)
and [#942](https://github.com/muffin-project/muffin-agent/issues/942).

## What the installed gateway showed

The owner reported a greeting that waited about 20 seconds before the answer
started. The trace of that turn on the installed Mac build `53c7eb57`:

| Span | Duration |
| --- | ---: |
| `muffin.turn` (whole turn) | 30.3 s |
| `memory.recall` (automatic, before the model) | 18.6 s |
| main `chat_call` | 8.6 s |

The recall span contained one light-lane call to `openrouter/free` that
returned 1,376 output tokens to order 16 candidates. The greeting itself was
answered with 20 output tokens. Earlier witnesses on the same install
(#942, #598): 38.9 s of a 60.3 s arming turn, 19.0 s of a 30.3 s scheduler
turn, and 40.7 s on a public-RFC turn where the free model returned no usable
order and recall fell back to the fused text order anyway.

## Decision

Automatic recall before a turn no longer calls the model reranker. It keeps
the fused full-text and vector order and the same cut, taint and provenance.
The reranker stays on the deliberate `memory_search` tool, where the model
chose to search and the cost is visible as a tool call.

Of the three arms listed in the 2026-11-08 note, this is the third ("keep
automatic retrieval and move slower ranking to explicit recall"). Reasons:

- The cost is paid on every owner message, greetings included, and on the
  owner's route it dominated time to first answer.
- The realised gain on that route is small or negative: in the four-case paired
  replay of 2026-11-24 the reranker kept the two explicit targets at rank 1 and
  dropped an implicit preference out of the top eight; two production calls
  returned no usable order.
- A deadline-bounded rerank would keep the call, the quota use and the
  cancellation plumbing, and at the measured latencies it would mostly time out.

## What this does not establish

The label-oracle ablation shows up to 12 points of macro recall headroom from
better ordering, larger on temporal questions. That headroom is not recovered
here. The answer-level comparison across the three arms is still the evidence
that would justify bringing a ranker back on the automatic path, for example a
compact local one with a measured tail latency.
