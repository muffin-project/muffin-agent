# Search with an existing ChatGPT connection, 2026-11-24

The DAY-1 installed baseline does not have a usable search credential. It can
open a supplied public URL, but the Telegram journey in #937 also requires
finding a fresh source. #521 owns the onboarding decision and #856 owns the
authority contract for a provider-hosted tool. On dev `d717e038`, the existing
`sys.search` listener registers only the explicitly selected Tavily or
Keenable backend. Its dispatcher checks the query before network execution and
fences its results as external content.

A protocol probe on the Mac used the existing Muffin Sign in with ChatGPT
connection and one public question about the Node.js 24 support calendar.
After an initial HTTP 400 with the forced-tool and additional include fields,
the minimal request with automatic tool choice completed on `gpt-6.2-sol`.
It emitted two completed hosted search items and one official citation in
11.4 seconds. The cited result matched the independent Node.js release
calendar. The probe bypassed Muffin's tool dispatcher and therefore proves
provider eligibility on this account only.

| Option | Benefit | Counter-evidence |
|---|---|---|
| Keep Tavily or Keenable as the only path | No new adapter or authority decisions | Requires a second account and credential on a working ChatGPT install |
| Add hosted search to the ordinary inference turn | Can avoid another inference request | The provider can execute before Muffin sees the concrete query. The turn's conversation, files and memory would be available to the hosted search model |
| Select ChatGPT as the backend of the existing search tool | Removes the separate key and keeps query authorization, source fencing and the existing HTTP reader | Uses the connected plan's quota and adds a bounded inference request per tool call. Hosted search may expand the authorized query into multiple public lookups |

Choose the explicit ChatGPT backend. Keep the existing backends available as
mutually exclusive selections. Send only the approved query with a fixed
instruction to a fresh, unstored Responses request. Return structured HTTP(S)
citation titles and URLs as untrusted tool results. The main turn independently
opens sources through the native HTTP reader. The connection alone does not
activate hosted search. No separate API key, automatic provider fallback,
history forwarding, or widening of the ordinary turn's tool list is required.
The endpoint cannot redirect and its permission is checked again immediately
before dispatch. A live attempt never automatically repeats a request after
transport or parsing failure. Crash recovery retains the existing rerunnable
read semantics of `sys.search`.

Verification profile **CRITICAL**, because this introduces a new destination
for search queries through the existing egress contract. Falsify the choice
with a real owner search-to-file turn on the compiled runtime, a group or
unapproved query that issues no hosted request, a successful-looking response
with no completed search, and a missing/revoked account that fails without
fallback. Check that a tightened search query policy still requires owner confirmation. The default policy allows follow-up searches through an explicitly selected backend after reading external content.
The installed Telegram gate is independent of an isolated runtime trial.

Primary sources checked on 2026-11-24:

- [OpenAI Sign in with ChatGPT preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) make hosted search conditional on account, workspace and model.
- [OpenClaw web search](https://docs.openclaw.ai/tools/web) documents both opt-in ChatGPT hosted search and a bounded hosted search worker behind managed search. The managed and provider-hosted routes do not operate simultaneously.
- [Hermes search](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search) keeps named backend selections stable across newly available credentials. Its native one-turn hosted path also illustrates the trade-off of letting results enter the model before a client boundary.
- [Node.js official release calendar](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)
