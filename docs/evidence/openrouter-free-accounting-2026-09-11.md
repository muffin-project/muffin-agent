# OpenRouter free router: requested model != served model != billing identity — 2026-09-11

## Question

Why did the owner see:

```text
main  openrouter/free — fatturato $15/$75 per MTok
light openrouter/free — fatturato $15/$75 per MTok
```

while the actual request was being served by Qwen, and which identity should Muffin use for display, tracing and spend accounting?

## Observed Muffin path

At `ef87196`:

- `cli/model.ts` renders the configured model through `priceOf(config.models.main, baseUrl)`.
- `core/budget/pricing.ts` has no row for `openrouter/free`; unknown slugs fall through to `UNKNOWN = $15/$75`.
- the OpenAI-compatible adapter preserves the provider response's actual `response.model` in `ChatResult.model`.
- the main loop passes that **resolved response model** into `recordSpend`.
- the light-lane wrapper does the same: it records `result.model || call.model`.
- therefore fixing the CLI lookup alone is insufficient for end-to-end accounting: a request whose configured model is `openrouter/free` may be served by Qwen and internally billed using Muffin's conservative Qwen family ceiling even though the route itself is free.

This is one semantic value represented by three different identities:

```text
requested model / route   openrouter/free
resolved response model   e.g. qwen/...
billing contract          free route => $0/$0
```

They must not be collapsed.

## Provider evidence

OpenRouter's current Free Models Router documentation describes `openrouter/free` as a router that selects a compatible free model and states that prompt and completion pricing are both zero:

- https://openrouter.ai/openrouter/free

OpenRouter's fallback/routing documentation separately states that routed/fallback requests expose the model ultimately used in the response and, for non-free routing, pricing follows the model that actually served the request:

- https://openrouter.ai/docs/features/model-routing
- https://openrouter.ai/docs/features/model-fallbacks

So `response.model` is the right identity for observability, but it is **not sufficient by itself** to recover the billing contract of `openrouter/free`.

## Smallest safe correction

The current slice makes `priceOf()` recognize only explicit OpenRouter zero-price contracts (`openrouter/free` and `:free` variants), scoped to the exact OpenRouter hostname. This fixes `muffin model` without weakening the conservative UNKNOWN fallback for arbitrary endpoints.

## Residual accounting claim

Do not declare spend accounting fixed until a call carries both requested and resolved model identity to the billing seam.

Candidate shape:

```text
requestedModel  what Muffin asked for (may be a router)
responseModel   what the provider says actually served it
billingIdentity provider-specific contract used for cost
```

For `openrouter/free`, billing identity is the requested zero-price route even when `responseModel` is Qwen. For ordinary exact-model routing, the response model can remain the pricing identity. `openrouter/auto` must **not** inherit the free rule.

Persisting `requestedModel` in the spend ledger would improve later diagnosis, but that is a durable-schema change and should not be smuggled into this CLI correction.

## Falsification / verification

The fix is wrong if any of these fail:

1. `muffin model` on an OpenRouter install configured with `openrouter/free` still prints a non-zero tariff.
2. an explicit `:free` OpenRouter variant is assigned UNKNOWN pricing.
3. an unrelated OpenAI-compatible endpoint using the same slug is silently treated as free.
4. `openrouter/auto` is treated as free.
5. after the later spend-seam fix, a real free-router call writes non-zero USD to the spend ledger.

Until item 5 is measured on the production path, the accounting residual remains open.