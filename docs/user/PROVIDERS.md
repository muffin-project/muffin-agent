# Provider and model selection

Run `muffin config` in a terminal to choose a lane, connect a provider, view its
model catalog, and select a model. Main and light are independent: changing one
preserves the other's model, endpoint, credentials and routing settings.
The menu supports OpenRouter, Groq, Anthropic API, ChatGPT plan, and custom
OpenAI-compatible endpoints such as a local Ollama server.

Shortcuts use the same selection path:

```sh
muffin model
muffin model main --provider openrouter --list
muffin model light --provider openrouter openrouter/free
muffin model main --provider chatgpt gpt-6.1-sol
```

Provider keys must already be connected for a headless change. The terminal menu
collects keys without echoing them; ChatGPT opens the browser for account consent.
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
