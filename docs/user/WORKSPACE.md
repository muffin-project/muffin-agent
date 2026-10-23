# Where Muffin works

A turn reads and writes inside one directory: its **workspace**. The default is
`~/muffin-workspace`, a sibling of `~/.muffin` and never a child of it.

The supervised gateway and `muffin run` cannot choose a workspace by standing in
one: launchd starts the gateway inside the home, and `muffin run` forwards the
turn to the gateway. Declare the project once instead:

```sh
muffin workspace set ~/dev/progetto
muffin gateway restart
```

`muffin workspace` shows the declaration, the directory actually in effect and
where that answer comes from. `muffin workspace clear` returns to the default.

## Precedence

1. The directory the REPL was opened in, when it is a real project.
2. `MUFFIN_WORKSPACE`, for one session.
3. `workspace` in `config.json`, written by `muffin workspace set`.
4. The default, `~/muffin-workspace`.

`muffin workspace set` refuses the install and anything inside it: `~/.muffin`
holds memory, sessions and the seal, and no turn may write there. The command
also refuses a path that does not exist or is not a directory.

## Shell commands still ask

Writing and editing files are reversible and do not prompt. Running a command
with `shell_run` is high-risk and irreversible, so every command asks for
approval (ADR-0091). `muffin run` has no terminal to ask in and exits with code
3; use the REPL or Telegram to approve. This is deliberate, not a bug.
