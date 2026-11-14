# Provider and model selection

On a terminal, `muffin init` recommends OpenRouter OAuth: a browser loopback on
this machine, or a one-time code pasted from the browser when SSH is detected.
Pasting an API key is the advanced path. An empty Enter at the key prompt asks
before skipping. Headless `muffin init` still reads the key from stdin.

```sh
muffin auth login openrouter
muffin auth login openrouter --new work
muffin auth login openrouter --code
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

The capability probe runs only after that OpenRouter OAuth login, not after
a pasted API key. The key is saved first. The probe uses the same inference
check as `muffin doctor --online`. Muffin reports the route as working only
after that probe passes.

Anthropic is a Console API key, including Max, Ultra, and Team API credits.
Muffin does not start a claude.ai or Claude Code login and does not read
`~/.claude`. xAI/Grok OAuth is not part of this client.

Groq is an API key (`gsk_`) on the same OpenAI-compatible adapter, at
`https://api.groq.com/openai/v1`. Headless `muffin init` infers it from that
prefix and stores `secret://groq_api_key`. Further accounts are auth profiles
(`groq_api_key_<id>`), listed by `muffin auth status` and chosen with
`muffin auth switch groq <id>`. `muffin auth login groq` refuses: there is no
Groq OAuth. Keys: https://console.groq.com/keys.

Run `muffin config` in a terminal to choose a lane, connect a provider, view its
model catalog, and select a model. Choosing OpenRouter with no key offers OAuth
first. Main and light are independent: changing one preserves the other's
model, endpoint, credentials and routing settings. The menu supports
OpenRouter, Groq, Anthropic API, ChatGPT plan, and custom OpenAI-compatible
endpoints such as a local Ollama server.

Shortcuts use the same selection path:

```sh
muffin model
muffin model main --provider openrouter --list
muffin model main --provider groq --list
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
Muffin never switches to another paid provider automatically. ChatGPT-plan usage
is managed in [ChatGPT Settings](https://chatgpt.com/settings/usage), separately
from Muffin's API-dollar estimates.
