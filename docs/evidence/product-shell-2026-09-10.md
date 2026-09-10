# Product shell — evidence and decision

Scope: the owner-facing product shell, classified CRITICAL where it changes a
secret's authority; STANDARD for presentation. The primary outcome is a normal
owner interaction, not fewer internals. A local, reversible repair discovered
on that path belongs here when it preserves semantics and has direct evidence.

## Observed problem and choice

`cli/main.ts` exposed a hand-maintained, operator-sized manual at bare help,
while dispatch, aliases and completion each had separate vocabulary. The chosen
smallest mechanism is `cli/command-surface.ts`: one registry projects compact
help, advanced help, aliases and Bash/Zsh/Fish completion. Existing names are
not removed; `help --all` is their discoverable compatibility route.

| Current verb family | Product treatment |
| --- | --- |
| init, model, surface, search, run, update, doctor, help | KEEP: primary owner help |
| repl | GROUP: conversational default / explicit compatibility alias |
| config, mcp, jobs, gateway, secret, completion | HIDE: operator control plane |
| backup, restore, rot, uninstall, undo, adopt | GROUP: explicit recovery |
| memory, vault, observe, prompt, trace, effects, orientamento | CONVERSATIONALIZE or HIDE: inspection remains compatible |
| all historical names and Italian aliases | KEEP: dispatch compatibility |

We rejected a new CLI framework: it would duplicate dispatch risk and migration
cost without improving the current typed switch. We also rejected deleting
advanced verbs: support and recovery need them, just not as the first screen.

## Secret and first-encounter invariants

Owner-facing acquisition (`init`, `search`, Telegram enable, `secret set`) uses
the persistent store and removes a same-name legacy Home copy only after the
durable write succeeds. Reads still search legacy Home first so an untouched
installation continues to work; the next owner write converges it. `--persist`
is accepted only for scripts already using it, not as a choice a normal owner
must learn.

First encounter is not a wizard nor a new state table. The volatile per-turn
context asks for one human question only when the owner tenant has no active
canonical fact. Once normal memory consolidation has learned a fact, the prompt
no longer contains that instruction across restart or a new conversation.

## Deployment boundary

`docs/INSTALL.md` and current repository wiring establish native installation
as the only verified owner path. There is no current Dockerfile or compose
deployment contract to extend. A Docker home would need a proven owner-data,
supervisor and update boundary; the tool sandbox is unrelated and is not a
deployment option. Therefore this slice documents native-first rather than
advertising an unverified Docker path.
