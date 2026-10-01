# Reasoning control on OpenAI-compatible endpoints — provider docs survey

Read 2026-10-02 for #789 (PR #792). Nothing here governs HEAD: these are
documentation snapshots, true of the pages and the dates named below, and they
are not updated to stay true. Question: on which request field do providers
accept reasoning control, and does Muffin's one declared dialect
(`provider.reasoningDialect: "reasoning_effort"`, top-level field, `none` for
off) line up with the ecosystem?

## Findings

| Provider | Request field for reasoning control | `none` to disable | Source |
|---|---|---|---|
| OpenAI (the reference) | top-level `reasoning_effort` (`minimal`/`low`/`medium`/`high`; `xhigh`/`max` on some models) | model-dependent | OpenRouter's mapping note (a GPT-5 request receives `reasoning_effort` "in its own vocabulary"); platform docs are JS-gated and were not fetched |
| OpenRouter | nested `reasoning: {effort \| max_tokens \| enabled \| exclude}`; effort ladder `max`/`xhigh`/`high`/`medium`/`low`/`minimal`/`none` ("none disables entirely"); per-model `supported_efforts`/`default_effort`/`mandatory` via `GET /models` | yes, `effort: "none"` | https://openrouter.ai/docs/use-cases/reasoning-tokens |
| vLLM | top-level `reasoning_effort`; the model template validates the subset (Qwen3.8: `xhigh`/`medium`/`low`); `chat_template_kwargs` (`enable_thinking`) as escape hatch; `thinking_token_budget` for token budgets | yes, injects `enable_thinking: false` | https://docs.vllm.ai/en/stable/features/reasoning_outputs/ |
| llama.cpp (llama-server) | per-request `reasoning_effort` ("If `none`, reasoning/thinking is disabled. Otherwise, the value is made available to the jinja template"); per-request `chat_template_kwargs`; server flags `--reasoning-effort`, `--reasoning-budget` | yes | server README (tools/server), current `master` |
| Ollama (`/v1/chat/completions`) | top-level `reasoning_effort` AND nested `reasoning.effort` (`high`/`medium`/`low`/`max`/`none`) | yes, `none` | https://docs.ollama.com/api/openai-compatibility, ollama/ollama#14821, #17499 |
| SGLang | per-request top-level `reasoning_effort` ("follows a separate normalization path"); `chat_template_kwargs` (`enable_thinking` for Qwen3, `thinking` for DeepSeek-V3) | values ladder not documented on the page read | https://docs.sglang.io/docs/basic_usage/openai_api_completions.md |
| Groq (hosted) | top-level `reasoning_effort`; qwen3.8: `none`/`default`/`low`/`medium`/`high`; gpt-oss 20b/120b: `low`/`medium`/`high` only | yes, on qwen3.8 | https://console.groq.com/docs/reasoning |
| DeepSeek (hosted) | top-level `reasoning_effort` together with `thinking: {"type": "enabled"}` in the first-call example | disabling not documented on the page read | https://api-docs.deepseek.com/ |
| LM Studio | no reasoning field documented on `/v1/chat/completions` (parameter list has none) | n/a | https://lmstudio.ai/docs/developer/openai-compat/chat-completions |

Not covered in this pass: xAI, Together, Fireworks, Mistral hosted, and any live re-verification beyond vLLM (#789 measured one vLLM/Qwen3.8 server directly).

## What this changes

Nothing in code. The top-level `reasoning_effort` with `none` for off is the
de-facto standard across self-hosted servers (vLLM, llama.cpp, Ollama, SGLang)
and several hosted ones (Groq, DeepSeek), all deriving from OpenAI's field; the
nested `reasoning: {}` object is OpenRouter's extension, which Muffin already
sends on the hostname-inferred path. So the one declared dialect already covers
every surveyed endpoint that exposes per-request reasoning control, and the
open `REASONING_DIALECTS` enum stays open for a server that proves otherwise.
`chat_template_kwargs` stays excluded: vLLM, SGLang and llama.cpp all treat it
as a per-model escape hatch (the accepted keys differ per model family), not a
per-endpoint dialect. LM Studio is the one gap with no documented control, so
there is nothing to declare there. Per-value support still differs per
server and model (gpt-oss has no `xhigh` anywhere it was checked), which is why
efforts are passed through and the server is the validator.
