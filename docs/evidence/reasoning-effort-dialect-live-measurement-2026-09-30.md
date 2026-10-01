# Reasoning effort and the explicit dialect — live measurement on a self-hosted vLLM

Observed 2026-09-30 for #789 (PR #792). Nothing here governs HEAD: these numbers
are true of the moment, the endpoint and the commits named below, and are not
updated to stay true.

## What was asked

Whether `off` and a reasoning effort can reach a self-hosted `openai-compat`
endpoint, and what that changes on a real install. Before this change the
adapter sent reasoning fields only to `*.openrouter.ai`, and the capability
resolver treated "omit the field" as "reasoning off" for every other host.

## Setup

- Endpoint: one self-hosted vLLM serving `qwen3.8-flash-next` (reasoning
  defaults to `xhigh`). Shared with other users; not a controlled benchmark.
- Direct requests: same prompt, temperature 0, `max_tokens` 3000, non-streaming.
  Run twice, before and after the code change; the two runs agree.
- Install: Raspberry Pi 4 running `dev` plus this branch (`711547f0`), main and
  light lane on the same model. The control is the same build with
  `provider.reasoningDialect` removed from `config.json`.
- Source of the install numbers: `muffin.chat_call` spans in
  `~/.muffin/traces/`, read after the runs.

## Direct requests: what the server accepts

| body field | output tokens | reasoning | time | result |
|---|---|---|---|---|
| none (server default) | 227 | 510 chars | 6.4 s | ok |
| `reasoning_effort: "none"` | 13 | 0 | 1.3 s | accepted |
| `reasoning_effort: "low"` | 396 | 837 chars | 7.2 s | accepted |
| `reasoning_effort: "medium"` | 415 | 785 chars | 7.9 s | accepted |
| `reasoning_effort: "high"` | | | | 400 — "Supported types are xhigh (default), medium, and low" |
| `reasoning: {effort: "none"}` (OpenRouter shape) | 252 | 531 chars | 5.4 s | ignored |
| `chat_template_kwargs.enable_thinking=false` | 13 | 0 | 0.5 s | accepted |
| `bogus_field: 1` | 250 | 532 chars | 5.3 s | ignored, no 400 |

Findings:

1. An unknown top-level field is ignored; a 400 comes only from an unsupported
   value of a recognised field. The "unknown field is a 400" premise behind the
   hostname gate (#167) does not hold on this server.
2. The OpenRouter shape has no effect here, so lifting the hostname gate alone
   would not have helped: the dialect differs per server.
3. Supported levels are per server and model (`xhigh|medium|low|none` here), so
   an effort is passed through and the server is the validator.
4. `none` answered a small arithmetic prompt wrongly (10:45 instead of 10:58).
   One prompt is an anecdote, but it is the regression #498 warns about for the
   conversational lane, and the reason the Qwen profile default stays `adaptive`.

The first run of this table (before the change, 402/670 output tokens for
default/`medium`) showed the same acceptance pattern; output-token counts vary
between runs at this sample size and should not be read as an ordering of
effort levels.

## On the install: same build, dialect removed and restored

| call | without the dialect | with the dialect |
|---|---|---|
| `memory.extract`, output tokens | 4113 | 57 |
| `memory.extract`, duration | 102.6 s | 2.2 s |
| `memory.judge`, output tokens / duration | 928 / 23.0 s | not exercised (one new fact, nothing to judge) |
| turn, resolved reasoning mode (trace) | `adaptive`, source `endpoint-defaults` | `on`, effort `medium`, source `provider-default` |

Reference from the same install before the change (`main`, 83 model calls over
about a day and a half): `memory.extract` averaged 3364 output tokens and 87 s;
`memory.judge` 519 output tokens and 15 s; a turn 8.9k input tokens and 22 s.

A later real task on the same build and configuration (search, several tool
approvals, resume) completed: `memory_search` 0.4 s and 2.4 s against 82 s
before; `memory.extract` 2.5 s and `memory.judge` 4.2 s on average; main-lane
calls 11.3 s on average with prompts averaging 31k input tokens.

## Limits

- One server, one model family. Ollama and llama.cpp were not run; their
  behaviour is taken from public documentation only.
- One sample per arm, with different prompts. The memory-lane comparison
  isolates the dialect (same build, control run); the main-lane one does not: the
  prompt was trivial (19 against 24 reasoning tokens) and `dev` commits landed
  between the `main` baseline and these runs.
- The judge lane was not measured with the dialect on.
- Times include a shared server and a queue behind background memory work; a
  77 s wall time was seen on a control turn whose model call lasted 7.1 s, and
  the cause was not verified.

## Reproduce

1. Send the same chat completion to the endpoint with each body field above.
2. On an install, set `provider.reasoningDialect: "reasoning_effort"` and
   `thinking: "medium"` in `config.json`, run `muffin memory extract` after one
   real turn, and read the `memory.extract` span in `~/.muffin/traces/`; remove
   the field and repeat for the control.
