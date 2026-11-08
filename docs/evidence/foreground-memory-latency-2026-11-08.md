# Foreground recall latency and reranking headroom

## Production baseline

On the Mac test gateway, build `327fdc5fea12`, four recent owner Telegram turns spent 12.6, 14.7, 7.3 and 43.3 seconds from the start of the turn to the main provider span. The corresponding memory-recall spans took 12.6, 14.6, 7.3 and 43.3 seconds. The local vector endpoint refused the connection in all four. The OpenRouter Free reranker returned an order in three and an unusable response in the slowest, where recall fell back to RRF. The first explicit model-status event is emitted after this prelude. GPT-6.1 Sol's adapter consumes SSE internally and returns completed output to the loop, so these calls have no observed first-text timing.

Eleven main-lane Telegram calls in the same trace file reported 12,768–13,945 input tokens each. Two reported cached reads, 17,280 of 146,211 input tokens in total (11.8%). The latest four had no reported cache hit. This sample measures provider-reported reuse. It establishes neither the quota effect of a cached token on the ChatGPT plan nor the cause of individual misses. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) documents prefix reuse and the input usage counter.

## What existing evidence can settle

The [September peer audit](critica-moduli-vs-peer-2026-09-07.md) identified missing retrieval ablations. The previous implementation's six-query trial improved two queries and took 6–12 seconds on its VPS. [Prior reranker trial](lessons.md#a-component-that-is-correct-but-too-slow-is-not-correct)

The November #666 synthetic pilot found equal Recall@3 for local Qwen3-8B and RRF, with a better ranking in one of six scored cases. Warm p50 was 6.9 seconds. [System One pilot](https://github.com/muffin-project/muffin-agent/issues/666)

BEIR found BM25 robust and reranking stronger on average at higher compute cost. Anthropic's document benchmark improved retrieval failure from 2.9% with its contextual hybrid retriever to 1.9% after reranking. Those settings differ from personal memory with eight slots. Hermes' bounded memory plus on-demand session search is a precedent for keeping deeper search off the automatic path. [BEIR](https://arxiv.org/abs/2104.08663) · [Anthropic experiment](https://www.anthropic.com/research/contextual-retrieval) · [Hermes memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)

## Offline ablation on public conversations

On `dev@7b83a0bf`, eight hashed selections from each of six LongMemEval-S categories and six abstention cases ran through Muffin's actual `MemoryStore` and `recall()` in separate in-memory databases. Each message remained an episode, indexed by its original session and timestamp. The text-only arm reproduces the available retrieval channel in the observed Mac traces. No embedding, fact extraction, model or private state was used. The second arm reorders the same candidate set with the dataset labels before the normal eight-item cut. It measures the maximum available ranking improvement under those constraints.

| Result | Text-only recall | Label oracle |
| --- | ---: | ---: |
| Macro recall of labelled turns, 48 cases | 62.2% | 74.5% |
| Cases with all labelled turns returned | 25/48 | 32/48 |
| Cases with no labelled turn returned | 12/48 | 8/48 |
| Temporal subset macro recall, 8 cases | 50.4% | 77.5% |

All 48 scored queries were eligible for the reranker. The oracle improved evidence coverage in 10. In eight cases it still found none. The text-only recall ran at 1.0–1.4 ms p50 and 2.1–3.6 ms p95 across two in-memory Mac runs, excluding dataset import. The rendered memory block was 3,111 characters p50 and 3,616 p95 on this corpus. The metric counts selected labelled turns. It does not check whether the answer-bearing span survives per-item truncation or whether a model uses it correctly. Each abstention case returned eight items, which is not an abstention verdict.

Reproduce with the public [cleaned LongMemEval-S dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned), file `longmemeval_s_cleaned.json`, SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.

```sh
node --import tsx evals/memory/recall-ablation.mjs /path/to/longmemeval_s_cleaned.json
```

## Decision still open

- **Bound the existing remote rerank.** It preserves today's behavior when the provider is fast. The measured 7–43 second prelude makes frequent timeout fallback plausible under an interactive deadline. Verify cancellation, actual cost and quality among completed calls.
- **Compare a compact local reranker.** It can recover some of the oracle headroom without a remote call. Measure cold and warm tail latency, difficult Italian cases and accuracy with vectors available and unavailable. The 8B result rules out using that tested configuration on every turn.
- **Keep automatic retrieval and move slower ranking to explicit recall.** This removes the remote wait on the common path. It risks missing temporal facts and preferences when the model does not realize it needs to search again. Score this arm on end answers, including cases where the user never explicitly asks to recall something.

Run the three arms over the same frozen cases, with a separate Italian sample and explicit multi-turn corrections and contradictions. Report answer correctness, evidence and abstention, p95 foreground delay, input size and calls. Keep taint, provenance, stored memory and authority intact. The present ablation does not justify promoting a new default. [Foreground latency tracker](https://github.com/muffin-project/muffin-agent/issues/942)
