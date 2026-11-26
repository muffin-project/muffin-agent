# Provider and model selection

On a terminal, `muffin init` recommends OpenRouter OAuth: a browser loopback on
this machine, or a one-time code pasted from the browser when SSH is detected.
Pasting an API key is the advanced path. An empty Enter at the key prompt asks
before skipping. Headless `muffin init` still reads the key from stdin.

```sh
muffin auth login openrouter
muffin auth login openrouter --new work
muffin auth login openrouter --code
muffin auth login xai
muffin auth status
muffin auth switch openrouter work
muffin chatgpt login
```

`muffin auth login openrouter` writes the user-scoped key into the secret
backend as `secret://openrouter_api_key` (or `secret://openrouter_api_key_<id>`
for another account) and points the main lane at OpenRouter. Light is left
as it is. A second account is another profile, not a second login that also
holds Claude or Grok. ChatGPT plan accounts stay on `muffin chatgpt` profile
ids; `muffin auth status` lists those too. `muffin auth switch` changes only
lanes that already use that provider.

Anthropic is a Console API key, including Max, Ultra, and Team API credits.
Muffin does not start a claude.ai or Claude Code login and does not read
`~/.claude`.

## xAI / Grok

xAI connects with your xAI account (no key to copy) or with a console.x.ai API
key. Both use the same endpoint, `https://api.x.ai/v1`, and the same models.

```sh
muffin auth login xai              # browser on this machine; paste fallback
muffin auth login xai --device     # code to type on any device (default over SSH)
muffin auth login xai --code       # paste the address the browser lands on
muffin fallback add xai grok-4.7   # uses the login when there is one
muffin auth status
muffin auth logout xai             # removes it here and revokes it at xAI
```

The login is OAuth 2.0 with PKCE (or the device code grant) against
`auth.x.ai`. xAI publishes no client registration for third-party agents, so
Muffin uses the Grok CLI's public client id, like OpenCode and Hermes; xAI can
restrict it. The session is stored as `secret://xai_oauth` (mode 0600) and
renewed automatically before it expires; tokens are never printed. Right after
the login Muffin asks `api.x.ai` whether it accepts it. xAI decides per plan
which accounts get API access: a 403 there means use a key instead.

The API key still works and is the explicit choice when you name it:

```sh
muffin secret set xai_api_key
muffin fallback add xai grok-4.7 --account default
```

Spend through either credential counts at xAI list prices against the budget
caps (ADR-0113).

The key is saved before the capability probe. The probe uses the same
inference check as `muffin doctor --online`. Muffin reports the route as
working only after that probe passes.

Run `muffin config` in a terminal to choose a lane, connect a provider, view its
model catalog, and select a model. Choosing OpenRouter with no key offers OAuth
first. Main and light are independent: changing one preserves the other's
model, endpoint, credentials and routing settings. The menu supports
OpenRouter, Anthropic API, ChatGPT plan, and custom OpenAI-compatible
endpoints such as a local Ollama server.

Shortcuts use the same selection path:

```sh
muffin model
muffin model main --provider openrouter --list
muffin model light --provider openrouter openrouter/free
muffin model main --provider chatgpt gpt-6.1-sol
```

Provider keys must already be connected for a headless change. The terminal menu
collects an OpenRouter authorization or a key without echoing the key; ChatGPT
opens the browser for account consent.
Credentials remain outside configuration and Git. A custom endpoint needs its
own credential reference, even when its model name matches another provider:

```sh
muffin secret set local_ollama
muffin model light --endpoint http://localhost:11434/v1 --key-ref local_ollama qwen3:8b
```

For a local server without authentication, enter the inert value `local` at the
secret prompt. Choose a model your server actually serves. `/model light …`
provides the same selection shortcut in conversation; connect credentials and
complete OAuth from a terminal first. `muffin chatgpt use <model>` is a main-lane
shortcut and preserves light.

`muffin config --json` shows configuration; plain `muffin config` also remains
read-only when run without a terminal. `muffin doctor` checks local configuration
and reports missing credentials separately for each lane. `muffin doctor --online`
opts into model probes, which may consume provider quota or API credit.

Model catalogs are availability evidence. Generic endpoints may accept models
absent from their catalog; selections reported as unverified require an online
probe or a real turn. ChatGPT selection verifies its actual model route first.
Muffin never switches to another paid provider unless you listed it as a
fallback. ChatGPT-plan usage is managed in
[ChatGPT Settings](https://chatgpt.com/settings/usage), separately from Muffin's
API-dollar estimates.

## Fallbacks

Each lane can list up to four fallbacks, tried in order when the lane's own
connection is out of quota, signed out, rate limited or down (ADR-0110). Errors
caused by the request itself, including a moderation or guardrail block (a bare
403), never move to another provider and never pause a link.

```sh
muffin fallback                                  # chains, active link, pauses
muffin fallback add xai grok-4.7                 # main lane, second link
muffin fallback add openrouter openrouter/free   # third link
muffin fallback add openrouter some/model --account work --light
muffin fallback remove xai                       # or by position: remove 3
muffin fallback reset                            # lift every pause now
```

A paused link is retried first when the provider's declared reset time (or a
short default) passes, or right away when you save a new key or sign in again
for it (or run `muffin fallback reset`). `muffin doctor` shows which link
answered last and why the lane's own connection is paused.
Spending on a fallback counts against the same budget caps.

## Embedding selection

Run `muffin model embed off` and restart the gateway to pause embedding
requests and use full-text memory search. The stored vectors and selected
embedding route are kept. To resume, run `muffin model embed on` and restart
the gateway after its test succeeds. Selecting a model explicitly also
activates embeddings after verification. `muffin doctor` reports the configured
mode.

To use the OpenAI API as your embedding provider:

```sh
muffin secret set openai_api_key
muffin model embed --openai
muffin gateway restart
muffin doctor
```

Use a platform API key issued by OpenAI. This selects `text-embedding-3-small`
for embeddings. The command sends one synthetic input to verify the key and
measure vector dimensions before saving. After restarting, Muffin sends memory
text for indexing and semantic search queries to the OpenAI API. The local
database keeps its source text and rebuilds vectors for the new model as
consolidation runs. API usage is charged to the key's API organization, including
any eligible [subscription API credits](https://help.openai.com/en/articles/20001626).

## Web search

With ChatGPT selected as the main provider, run `muffin search chatgpt` once to
authorize web search using that connection. Review the network permission if
prompted, then restart the gateway. The ordinary plan connection does not enable
search by itself. `muffin doctor` checks the local setup. An actual search depends on
the model and ChatGPT account's eligibility and uses the connected plan's quota.

Muffin sends the searched phrase to ChatGPT in a separate request. It returns
source links to the turn and uses Muffin's usual web reader to open them.
An existing Tavily or Keenable selection stays in place until you change it.
`muffin search off` disables search without disconnecting ChatGPT. Use it before
rolling back to a build that cannot read the ChatGPT search setting.
