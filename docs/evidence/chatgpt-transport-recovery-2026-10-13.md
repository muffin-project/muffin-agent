# ChatGPT transport recovery — 2026-10-13

## Observed failure and claim

Read-only installed-runtime inspection found two distinct failure classes: locally
exhausted active-model leases (240 seconds) and fatal ChatGPT transport failures.
The installed launcher targets release `1a7c6ffa`; the integration base for this
repair is `509249ffd9fe13ee7fb2214d9f97b72920759b36`. No installation, credentials,
owner memory, gateway or execution limits were changed.

This STANDARD mechanical repair claims only that interrupted ChatGPT transport
reaches the existing bounded, persisted retry path. It does not claim that the
provider is always available or that every reported block is fixed.

## Producer → consumer → failure path

`OpenAIChatGPTProvider.chat()` consumes one Responses SSE internally, without a
public `chatStream()` fallback route. A missing `response.completed` previously
escaped as `ProviderStreamError`; `runRounds()` handled that class only in its
streaming fallback branch, so the chat-only invocation ended the turn. An SDK
`APIConnectionError` also previously became a non-retryable HTTP error because
its status is undefined.

Classify these two failures as retryable transport `ProviderError` at the adapter
boundary. Reuse the loop's transport counter, durable checkpoint, progress event,
backoff and model/turn deadlines. Keep SDK retries disabled. An unfinished
response remains rejected: partial text and calls are never accepted as results.
HTTP 400/401/403, explicit semantic failures and aborted calls remain distinct.

## Alternatives and falsifiers

- Accepting partial output would hide failed completion and permit incomplete
  tool effects: rejected.
- Adding adapter retries would duplicate the durable governor: rejected.
- Raising execution budgets would not repair this classification failure:
  deferred pending separate product evidence.
- A second provider invocation after an exhausted counter, owner cancellation,
  or deadline; execution of unfinished tool calls; or retrying authentication
  failures would falsify this repair.

The change repairs an existing contract mechanically; it introduces no new
harness primitive or durable schema. The chat-only adapter still does not expose
stream activity to the loop's progress watchdog. That limitation is separate.

## Verification

Before the repair, both new production-loop regressions failed: missing terminal
SSE and connection reset exited instead of recovering. The tests use the real
ChatGPT adapter and `runRounds`, mocked HTTP only, and independently assert
request counts, final answer, durable reduced counter and retry progress.
Additional tests reject retries after budget exhaustion and on HTTP 400/401/403.
Existing adapter tests cover truncated tool calls, output validation, refusals,
pre-aborted calls and active-stream cancellation. No live provider call was made
for this transport fault injection; no real outage was claimed repaired.

Focused adapter/production-loop verification: **50 PASS, 0 SKIP**. Fresh review
identified a credential-acquisition edge case; repaired before submission and
covered by a zero-request, sanitized non-retryable regression. Credential errors
are not reclassified as inference-stream failures.

The first exact-head CI run passed 5,399 tests and failed two configured-runtime
assertions that encoded terminal failure after one SSE request. Updated these to
require exactly two requests separated by one announced transport retry, a
successful final answer and a durable counter reduced to nine. This preserves
one SSE request per invocation while permitting the existing governor to retry.
Focused configured-runtime/adapter/loop verification: **55 PASS, 0 SKIP**.
