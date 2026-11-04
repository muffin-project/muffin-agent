# ChatGPT plan provider — 2026-10-12

Claim: a local Muffin installation can explicitly connect a ChatGPT account and
run its existing loop with one pinned model through the public Responses API.
Verification profile: CRITICAL (credentials, identity, rotating sessions).

Observed base: ee9347e7; current production adapters use Anthropic Messages or
Chat Completions. Runtime constructs the provider in agent/runtime.ts; doctor
constructs it separately in agent/providers/verify.ts. Config has a scalar
secret reference and main/light model IDs. No production ChatGPT sign-in exists.

| Candidate | Evidence / benefit | Counter-evidence / consequence |
| --- | --- | --- |
| Independent direct OAuth + Responses adapter | Official public-client protocol; preserves Muffin loop/kernel/effects; existing OpenAI SDK handles SSE and jose verifies OIDC | Requires secure serialized refresh and complete tool/history mapping; preview lacks remote max_output_tokens |
| Official Sign-in DevKit | Implements profiles and token renewal | Its current noncommercial license cannot be imported into this AGPL product; package is private; no general tool adapter |
| Codex app-server | Official supported plan route, already runs tools | Introduces another agent loop and tool authority; does not test Muffin's own loop |
| Keep OpenRouter Free | Existing route and bounded recorder | Router may select different models; does not meet fixed model/account request |

Chosen: independent protocol implementation using existing secret-protected
home storage, OpenAI SDK and MIT-licensed jose; separate provider kind, fixed
public endpoint, explicit account login, no paid fallback. Credential material
must stay under the existing secret read/sandbox denial. No Codex credential
extraction, unofficial backend endpoint, personal memory migration or gateway
change. Login and model verification occur first in an isolated test home.

Falsifiers: invalid state/nonce/signature/audience/returning subject accepted;
refresh races replace another account; tokens reach diagnostics/tools; partial
SSE or model substitution accepted; tool roundtrip loses call IDs/history;
production factory or doctor bypasses the adapter. Test those failures and
compile the real binary before account consent. Account entitlement remains
unverified until a completed live inference. Model pin is the requested/served
API identity, not a promise that provider weights never change.

The preview requires store:false and stream:true, full input history, developer
instructions instead of system items, grouped function tools, and no
previous_response_id or max_output_tokens. Runtime deadlines remain enforceable;
requested output tokens cannot be represented as a remote quota cap. Plan usage
and token counts must not be shown as estimated API dollar charges. Account
limits/credits are managed by ChatGPT, with no automatic paid-provider fallback.

Telegram acceptance follows the owner's revised scope: controlled Bot API
transport exercises the real connector/runtime; official API docs establish the
wire contract. This is connector integration plus real-model runtime E2E, not a
claim of observed Telegram client rendering or human approval. Memory promotion,
restart/recall and composed effects remain observed runtime claims. The shell
callback integration stays separate from any live human authorization claim.

Sources fetched 2026-10-12:
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- https://github.com/openai/sign-in-with-chatgpt-devkit (protocol prior art only; no source imported)
- https://core.telegram.org/bots/api

## Observed continuation

OAuth identity and direct-plan scope were verified in an isolated synthetic
installation. The live account catalog exposes `gpt-6.1-sol`. Two inert real
probes revealed the first broken boundary: `response.output_item.done` carried
the correct completed function call and nonce, while the terminal
`response.completed.response.output` was empty. The initial adapter discarded
those completed stream items and incorrectly reported no tool support. Config
was preserved by the failing probe. The remedy must assemble completed items
without accepting partial events or a stream missing terminal completion.

The first full local suite inside Codex's nested sandbox had 61 failures; host
containment alone passed 86 tests (3 skips). A host run with isolated XDG and npm
cache passed all 414 files: 5336 tests passed, 7 skipped. Missing key tests had
inherited persistent installation state; the isolated run does not. The
existing capability-search description lacked its required usage markers; its
clarification preserves the same discovery and policy behavior.

At that checkpoint, live runtime memory/compound acceptance was NOT_RUN pending
the corrected Responses decoder and a passing exact-model tool probe. No integration or
publication has occurred. The original installed gateway and personal memory
have remained untouched in this continuation.


## Reasoning boundary observed before the third runtime attempt

The completed live probe pinned gpt-6.1-sol successfully. The first synthetic
memory input reached the gateway and durable turn, but its single Responses
request returned HTTP 400: reasoning.effort none is unsupported. No proposal,
canonical memory or tool effect occurred. A second instrumented attempt confirmed
this exact parameter error. Failed synthetic datasets are retained separately.
The live account catalog advertises low/medium/high/xhigh/max (and client-only
ultra on some slugs), without none, for Sol, Luna and Terra. Current catalog
parsing discards this metadata; the provider wrongly claims canDisable=true.

| Candidate | Evidence / consequence |
| --- | --- |
| Change fixed model to Luna/Terra | Catalog shows no disable option there either; does not solve the boundary |
| Translate every off request into low in the adapter | Would lie about an explicit owner control; rejected |
| Keep explicit off strict; choose legal defaults at caller/profile; read live metadata | Preserves owner semantics, supports the chosen model, exposes unsupported choices before inference |
| Drop reasoning settings everywhere | Hides intent and spends at provider default; rejected for explicit off |

Chosen: the provider reads only safe account model capability fields and refuses
unsupported off/effort settings. The shipped GPT-6 main profile uses adaptive;
an owner override remains authoritative. Internal structured memory callers
choose low explicitly on the ChatGPT route, retaining off on existing routes.
This is a deliberate memory-lane quota tradeoff, not evidence that reasoning off
was applied. Selection/doctor must probe the actual effective main policy and the
light policy before saving a route. No model/provider substitution or credit/API
fallback. Catalog metadata is prior capability evidence; an actual API rejection
still wins. Falsifiers: off issues inference on Sol, main owner off is overridden,
unsupported effort is reported applied, CLI saves despite failed main/light
policy, or live memory cannot promote/restart/recall.

Primary sources checked: the account catalog and structured API rejection;
https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
and https://developers.openai.com/api/docs/guides/reasoning . Existing Muffin
reasoning policy protects exact off semantics, and the light lane intentionally
does not inherit owner main /think settings. No new orchestration layer is needed.


## Canonical recall boundary discovered by the third run

Canonical promotion and restart passed SQL oracles. The live search returned
only episode fragments, including the agent's earlier confirmation, and
memory_why could not find the canonical fact. A value-only oracle falsely
accepted the episode; acceptance now requires the canonical rendered fact line.
The fact is not embedded yet. The existing graph candidate gate accepts only
capitalized tokens although its entity lookup is already case insensitive.

Chosen smallest correction: case-insensitive lexical candidate extraction,
retaining the existing four-candidate limit, tenant-scoped lookup, one-hop graph,
temporal selectors, provenance, and ranking. Reusing searchActiveFacts would
create incompatible as-of/history behavior; adding another retriever or waiting
for embeddings would hide this immediate post-restart failure. A broader
entity-mention resolver remains unjustified by this observation. The lexical
candidate limit remains a recall limitation, not a claim of complete search.
Regression proof must use a lowercase, unembedded canonical fact, another tenant
and temporal selection; live proof must still traverse the real tools/model.

The file effects in attempt3 were independently observed: settled fs_read and
fs_write, exact ciao plus LF, and 8.45 in nested rich content. Its harness query
used an ambiguous content column; the controlled transport's text observer also
dropped nested bold text. Qualify t.content and recurse through rich entity text.
Neither defect proves the original shell approval scene passed.


## Verified delivery candidate

Attempt4 used the compiled CLI, actual gpt-6.1-sol and controlled Bot API HTTP.
The seven memory steps passed: authentic synthetic ingress, one accepted
owner-stated proposal linked to its source, one active canonical fact, settled
memory_propose, process restart, settled memory_search returning the canonical
fact line, and the correlated answer. memory_why independently returned active
fact #1 and its source user episode. No personal memory or gateway was reused.
The later file scene completed its read/write effects but its final fetch failed.
The separate file-scene retry preserved the memory evidence and used fresh
message/update IDs and only new episodes: settled fs_read/fs_write, ciao plus LF,
8.45 in the final rich answer, three actual Responses calls. Both scoped
scenarios pass; authentic Telegram UI and human shell approval remain NOT_RUN.

An independent review found a post-terminal event acceptance hole. The injected
empty terminal followed by a late function_call was RED before repair. The
provider now rejects every event after terminal completion before processing it.
The focused provider/OAuth/factory/oracle suite passes 35 tests; compile passes.
The independent judge's revised technical verdict is MERGE. DCO human
attestation and required exact-head Actions are still separate delivery gates.
The earlier full host suite passed 5343 tests with 7 skips; the latest recall
change has 70 focused recall/tool tests passing. No new broad suite is required
before the final integrated-head CI; local repetitions do not replace that gate.


## Delivery composition after owner-policy integration

The owner approved the internal contribution exception; it integrated through
PR #880 with all required checks and independent review. Delivery of this
candidate now starts from dev f22d40aa, keeping the already measured runtime
changes and independent memory oracle. The unrelated G0 discovery change is
excluded. The ChatGPT runner keeps only its small owned-child cleanup helper,
so it does not depend on the unfinished real-agent harness. Existing candidate
observations above are preserved; fresh composition verification is recorded
separately and is required before integrating this delivery.


Fresh composition on dev f22d40aa: typecheck and compile passed; 120 focused
OAuth/provider/config/CLI/recall/oracle tests and 123 caller/reasoning tests passed.
The actual compiled CLI with gpt-6.1-sol completed both scenes in one run:
one accepted owner-stated proposal linked to real synthetic HTTP ingress, one
active canonical fact, settled memory_propose, a new gateway process using the
same Home, settled memory_search containing the canonical fact/provenance and
the correlated stored-value answer. The file scene observed settled fs_read and
fs_write, exact ciao plus LF and total 8.45. Eight actual Responses requests;
no model/provider substitution. Prior synthetic outcomes were preserved before
this composition run. The external transport was controlled Bot API HTTP;
authentic Telegram UI and human shell authorization remain NOT_RUN.
