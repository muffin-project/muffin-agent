# Onboarding e first-run dei CLI agentici — prior art su fonte primaria

> Scout 2026-08-09 (muffin-scout). Cloni shallow read-only + lettura del sorgente
> primario (non changelog/marketing) + esecuzione diretta di `--help` sui binari
> installati. Fonda ADR-0029. Numeri di traction/CVE volatili — ri-verificare
> alla data di un ADR/pitch che li cita.

## Domanda

Come Goose, Hermes (NousResearch), Ollama, `gh auth login`, aider, Claude Code
gestiscono "0 → prima sessione" quando manca un segreto — per dare evidenza al
disegno di `muffin init`, che oggi (verificato, non a memoria) fallisce con exit
1 e nessun prompt interattivo se manca `MUFFIN_API_KEY`.

## Grounding — stato di `muffin-agent` letto, non ricordato

`cli/init.ts:61-67`: `const apiKey = options.apiKey ?? process.env['MUFFIN_API_KEY']`;
se assente, `step('api key', 'missing …', false)`. Il docstring in testa (`init.ts:25`)
dichiara l'intento — *"Interactive prompts only when stdin is a TTY. Headless, a
missing value is an error"* — ma per l'API key **nessun prompt è implementato**:
solo un check env/flag. `cli/main.ts` conferma l'exit 1 sugli step falliti. Gap
reale, verificato per assenza (file letto per intero).

## Fonti lette

| Repo | Commit | Data |
|---|---|---|
| `block/goose` | `064244e` | 2026-08-08 |
| `cli/cli` (gh) | `9fc0f70` | 2026-08-07 |
| `NousResearch/hermes-agent` | `26b3918` | 2026-08-09 |
| `Aider-AI/aider` | `5dc9490` | 2026-05-22 |
| `ollama/ollama` | `5a173ed` | 2026-08-08 |

Claude Code (closed-source): fetch di `code.claude.com/docs/en/authentication`
(2026-08-09) + `claude --help`/`claude auth --help` sul binario reale (v2.1.219).
Ollama anche `ollama --help`/`ollama signin --help` (v0.31.1).

---

## Q1 — Prompt interattivo del segreto (split 3 vs 3)

**Hanno un vero prompt masked/no-echo:**

- **Goose** [VERIFICATO] `crates/goose-cli/src/commands/configure.rs:759-777`:
  `cliclack::password(&prompt).mask('▪').interact()?` — mask visibile per
  carattere. Prompt: *"Provider {name} requires {key}, please enter a value"*.
  Chiave opzionale → conferma prima (*"Would you like to set {}? (optional)"*).
- **gh** [VERIFICATO] `internal/prompter/prompter.go:527-533`: `survey.Password`
  con `survey.Required`, messaggio *"Paste your authentication token:"*. Estetica
  esatta a schermo [PARZIALMENTE VERIFICATO] (widget dedicato certo; non ho letto
  l'interno di `survey`).
- **Hermes** [VERIFICATO], il più elaborato: `hermes_cli/secret_prompt.py` (127
  righe) — raw-terminal fatto in casa: `termios`/`tty.setraw`, un char alla volta,
  scrive `*`, gestisce backspace/Ctrl-C/EOF, **scarta le sequenze di escape**
  (frecce) così non entrano nel segreto, ripristina i termios in `finally`.
  Windows `msvcrt.getwch()`. Fallback `getpass.getpass()` se non-TTY. Pattern
  "get key here": `setup.py:380-381` stampa `"Get your key at: {url}"`.

**Non hanno prompt masked — solo OAuth-browser o env/file:**

- **Claude Code** [VERIFICATO, docs]: la chiave arriva SOLO da env var/`apiKeyHelper`;
  l'interazione è approva/rifiuta (sì/no), non immissione. `claude auth --help`:
  solo `login|logout|status`. Validazione live prima dell'approvazione
  [PARZIALMENTE VERIFICATO] — issue #28176 ("accettata al login, fallisce al primo
  messaggio") coerente con un NO, ma singola/aneddotica.
- **aider** [VERIFICATO PER ASSENZA]: `grep getpass|pwinput|is_password` → zero.
  Unico flusso segreto = OAuth OpenRouter (`aider/onboarding.py`): server HTTP
  locale su porta 8484-8584, PKCE, apre il browser, callback locale, scambia il
  code per la key via `POST openrouter.ai/api/v1/auth/keys`. Il segreto non tocca
  mai il terminale; scritto su `~/.aider/oauth-keys.env` (nessun chmod esplicito).
- **Ollama** [VERIFICATO] `cmd/tui/signin.go`: `OpenBrowser` + TUI con poll
  (`client.Whoami`). Zero prompt di testo. Headless solo `OLLAMA_API_KEY`.
- **npm login** [PARZIALMENTE VERIFICATO]: default `auth-type=web`; fallback
  legacy con prompt user/pass mascherato; genera token, non salva la password.

---

## Q2 — Catena install→configure

- **Goose** [VERIFICATO, correzione avversariale reale]: la prima lettura del solo
  `configure.rs:146-151` (bail se non-TTY) suggeriva "sempre separati". **Falso**:
  `download_cli.sh` ha `CONFIGURE=true` di default e, anche dietro `curl|bash`,
  apre `/dev/tty` e ci reindirizza `configure`. Nel caso comune (terminale reale
  dietro la pipe) **l'installer chiama `configure` da solo**; il bail scatta solo
  in vero headless (Docker/CI). Lezione: un solo file può dare l'immagine sbagliata.
- **Hermes** [VERIFICATO] `tests/test_install_sh_setup_wizard_tty_probe.py`:
  `scripts/install.sh` chiama `run_setup_wizard()` gated su un probe di **apertura**
  di `/dev/tty`. Regressione di un bug reale (#16746): la gate originale usava
  `[ -e /dev/tty ]` (esistenza) → in Docker il device esiste ma non è apribile
  (ENXIO) → crash sul redirect. Fix: probe open-based `(: </dev/tty) 2>/dev/null`.
- **gh** [VERIFICATO PER ASSENZA]: mai chain; solo hint (`help.go:226` *"please
  run: gh auth login"*). Install e auth sempre separati.
- **Claude Code / aider** [VERIFICATO]: nessuno script installer che orchestri —
  è il **binario** a fare first-run detection al primo lancio.

---

## Q3 — First-run detection (3 pattern)

- **A) Auto-lancio silenzioso** — Claude Code: primo `claude` apre il browser da
  solo, nessuna domanda.
- **B) Rilevo + chiedo conferma + lancio** — Hermes (`hermes_cli/main.py` ~2649):
  se nessun provider configurato → *"It looks like Hermes isn't configured yet"* →
  se non-interattivo, guida + `exit 1`; se TTY, `input("Run setup now? [Y/n] ")` →
  sì lancia `cmd_setup`. Distingue TTY-assente (guida copiabile) da utente-dice-no
  (esce con messaggio, non crash). aider fa lo stesso in miniatura.
- **C) Rilevo + solo hint** — gh e Goose (comandi ≠ configure):
  `builder.rs:254` *"No provider configured. Run 'goose configure' first."* —
  errore secco, nessuna domanda. (`goose configure` internamente ha un terzo
  comportamento: branch primo-avvio vs ritorno.)

---

## Q4 — Passi 0→prima sessione, dove sta l'attrito

| Tool | Passi (interattivo, caso comune) | Attrito |
|---|---|---|
| Goose | 1: `curl\|bash` (chiama `configure` da solo) | Il menu provider spinge verso OAuth di terzi (item "(Recommended)") |
| gh | 2: install + `gh auth login` esplicito | `--with-token` vuole una FILE pipe, non un incolla |
| Hermes | 1: `curl\|bash` (chiama `run_setup_wizard`, conferma Y/n) | La LUNGHEZZA del wizard (5 sezioni), non il numero di comandi |
| Claude Code | 1: install + primo `claude` (browser) | Quando il redirect locale non funziona (SSH/WSL2/container) |
| aider | 1 (se si accetta OAuth) o 0 se env già settata | Se rifiuti l'OAuth, esce e devi editare `.env` a mano |
| Ollama (locale) | 0 — nessuna credenziale per modelli locali | Solo se vuoi i cloud model (`ollama signin`) |
| Muffin (prima di ADR-0029) | `init --api-key X` (1, ma nessun prompt: fallisce e basta) | — |

---

## Q5 — Anti-pattern (issue onboarding/UX)

- **gh #10922** [issue letta]: "mai un flag, solo stdin/file-pipe" è sicuro ma
  confonde chi si aspetta di incollare. Stessa forma del nostro `secret set`
  (`readFileSync(0)`). #12925: il flusso non fa poll finché non premi Invio.
- **Hermes** [primaria, commento nel codice] `setup.py:398-402`: *"Previously a
  user could cancel the API-key prompt mid-wizard … and exit 'successfully' with
  NO working model … Say so loudly instead (consumer-onboarding audit finding
  #7)."* — il team documenta nel proprio codice un wizard che "riesce" a vuoto.
- **Claude Code** [titoli]: #66332 (OAuth redirect rotto Android/Codespaces),
  #48048 (rotto su SSH), #28176 (chiave accettata al login, fallisce al primo
  messaggio), #33122 (VS Code ri-forza onboarding).
- **Ollama** [titoli]: #13515 (sign-in errors); utenti cercano "ollama login"
  (inesistente) invece di "ollama signin" — friction di naming.
- **rustup #3429** [issue letta]: il pulsante dice ancora "Proceed (default)" dopo
  che l'utente ha personalizzato — testo che mente sullo stato (bug di label).

---

## Claim corretti/rigettati in corso

- RIGETTATO: "Goose separa sempre install e configure" — vero solo in headless;
  nel caso comune l'installer incatena. Causa: avevo letto solo `configure.rs`.
- PRECISATO: "widget Password ⇒ mascheramento carattere-per-carattere" — vero per
  Goose/Hermes (esplicito nel codice), non confermato per gh (non letto l'interno
  di `survey`).
- WEAK: un commit "temporarily disable OpenRouter OAuth" di aider visto solo su un
  mirror terzo; l'HEAD primario attuale lo smentisce (OAuth cablato). Non citarlo.

## Aperto / non verificato

- Keypair Ed25519 di Ollama (`~/.ollama/id_ed25519`): solo fonte secondaria.
- Bit di permesso esatti del fallback plaintext di Goose (`secrets.yaml`).
- Se il probe TTY di Goose soffra della stessa classe di bug di Hermes #16746
  (ipotesi per analogia, non verificata su issue Goose).

## Sintesi

Split 3 vs 3 sul prompt del segreto: i CLI-native (Goose/gh/Hermes) hanno un vero
masked-input; Claude Code/aider/Ollama no (OAuth-browser o env). Install→configure:
Goose e Hermes incatenano (installer apre `/dev/tty`); gh mai (hint); Claude
Code/aider fanno first-run detection nel binario. Sul "nessun provider configurato"
Hermes è l'unico che *chiede conferma* prima del wizard (Y/n) — terzo pattern tra
lancio-silenzioso e solo-hint. Anti-pattern più riusabile: un wizard può
"completare con successo" senza un provider funzionante se nessuno step lo controlla.

## Sources

- goose: configure.rs, download_cli.sh (block/goose@064244e)
- gh: prompter.go, login_flow.go, authflow/flow.go (cli/cli@9fc0f70)
- hermes: setup.py, secret_prompt.py, test_install_sh_setup_wizard_tty_probe.py (NousResearch/hermes-agent@26b3918)
- aider: onboarding.py (Aider-AI/aider@5dc9490)
- ollama: cmd/tui/signin.go (ollama/ollama@5a173ed)
- Claude Code — code.claude.com/docs/en/authentication
- Issues: cli/cli#10922, #12925; block/goose#2582, #6047; anthropics/claude-code#66332, #48048, #28176, #33122; ollama/ollama#13515; rust-lang/rustup#3429
