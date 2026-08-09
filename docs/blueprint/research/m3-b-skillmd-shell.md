# M3-B — Spec SKILL.md (2026) + semantica shell tool nei harness (2026-08-08)

> Report scout M3-B, consegnato inline e persistito dall'orchestratore. Metodo: WebFetch diretto su fonti primarie (doc ufficiali, sorgenti raw da GitHub); WebSearch solo per localizzare URL. Non ri-derivato: adozione cross-vendor di SKILL.md e pattern generale "Bash tool sandboxato" (già in agent-memory 2026-07-16 e 2026-07-06).

## PARTE 1 — La spec SKILL.md

### 1.1 Frontmatter: campi e vincoli esatti [VERIFICATO, agentskills.io/specification]

| Campo | Obbligatorio | Vincoli |
|---|---|---|
| `name` | Sì | 1-64 char, lowercase alfanumerico + `-`, non inizia/finisce con `-`, no `--`, **deve combaciare col nome della directory padre** |
| `description` | Sì | 1-1024 char, non vuota, dice cosa fa E quando usarla |
| `license` | No | nome o riferimento a file bundlato |
| `compatibility` | No | max 500 char, requisiti ambiente |
| `metadata` | No | mappa string→string libera |
| `allowed-tools` | No | stringa spazio-separata; **"Experimental. Support may vary between implementations"** |

Body Markdown senza vincoli; raccomandazione: SKILL.md sotto 500 righe, contenuto lungo in file referenziati ("the agent will load this entire file once it's decided to activate a skill").

### 1.2 Progressive disclosure [VERIFICATO, due fonti primarie indipendenti]

| Livello | Quando | Costo | Contenuto |
|---|---|---|---|
| 1. Metadata | Sempre, per tutte le skill installate | ~100 token/skill | `name` + `description` |
| 2. Instructions | Al trigger | <5000 token raccomandati | body di SKILL.md |
| 3. Resources | On-demand | zero finché non acceduto | `scripts/`, `references/`, `assets/` |

Meccanismo concreto in Claude Code: il modello **legge SKILL.md eseguendo `cat` via bash** — non è caricamento magico del framework. Gli script bundlati vengono eseguiti e **solo l'output** entra in context. Lifecycle: il body caricato resta in context per tutta la sessione; in compattazione le skill recenti si ri-agganciano (5k token/skill, 25k totali).

### 1.3 Discovery [VERIFICATO, code.claude.com/docs/en/skills]

Claude Code, precedenza su omonimi: **Enterprise > Personal > Project**. Path: Personal `~/.claude/skills/<nome>/SKILL.md`, Project `.claude/skills/<nome>/SKILL.md` (+ ogni parent fino alla root; sottodirectory → lazy con nome qualificato `apps/web:deploy`), Plugin namespaced `plugin:nome`. File-watching attivo (update senza restart, tranne nuove directory top-level). Agent SDK: discovery dipende da `settingSources` (senza `'user'`/`'project'` **niente skill**); il filtro `skills` è di contesto, **non un sandbox** (le escluse restano leggibili su disco).

### 1.4 Validator

1. **Standard**: `skills-ref` in `github.com/agentskills/agentskills` (`skills-ref validate ./my-skill`) [VERIFICATO, repo ispezionato].
2. **Claude Code CLI: nessun linter**. Frontmatter malformato → **la skill carica con metadata vuoti, senza errore** (diagnosi solo `--debug`). Validazione stretta solo al packaging/upload verso claude.ai/Skills API: solo i 6 campi standard, altri → errore hard (`Unexpected key(s) in SKILL.md frontmatter…`) [VERIFICATO, testo letterale].

### 1.5 Sicurezza [VERIFICATO, platform.claude.com]

- **Claude API**: sandbox hard (container, no rete, no package install runtime).
- **claude.ai**: rete "varying" da impostazioni.
- **Claude Code**: **"Full network access: Skills have the same network access as any other program on the user's computer"** — nessun sandbox skill-specifico; l'unica mitigazione è il Bash sandbox generico opt-in.
- **Nessun vetting pre-installazione su nessuna superficie**: modello dichiarato "audit-it-yourself". Su Claude Code, `allowed-tools` richiede il workspace-trust-dialog e il grant vale **solo per il turno che invoca la skill**.

### 1.6 Divergenze spec ↔ implementazione (tre, con fonte)

1. **Set di campi per canale**: Claude Code CLI accetta ~19 campi (estensioni proprietarie: `when_to_use, argument-hint, disable-model-invocation, user-invocable, model, effort, context, agent, hooks, paths, shell, …`); fuori dalla CLI **solo 6 sono legali** — "compatibile con SKILL.md" va sempre qualificato per canale. [VERIFICATO]
2. **`name` = directory**: obbligo dello standard; la CLI lo tratta come display label con default dal nome directory. [PARZIALMENTE VERIFICATO: non provato che la CLI *rifiuti* il mismatch]
3. **Vincoli extra Anthropic non nello standard**: `name`/`description` "Cannot contain XML tags"; `name` niente reserved words 'anthropic'/'claude' (platform.claude.com). Non chiaro se valgano anche per la CLI. [VERIFICATO come testo presente]

Governance: `anthropics/skills` `spec/` è **stub di redirect** → la spec canonica vive su agentskills.io (org GitHub separata `agentskills/agentskills`). Date [VERIFICATE su anthropic.com/engineering]: feature Claude-only **2025-10-16**; standard aperto **2025-12-18**.

## PARTE 2 — Semantica shell tool

### 2.1 Timeout

| Harness | Default | Max | Controllo |
|---|---|---|---|
| Claude Code Bash | 120.000ms | 600.000ms (alzabile via `BASH_MAX_TIMEOUT_MS`) | **modello**, per-call (`timeout`) |
| Codex local shell | n/d | n/d | `timeout_ms` del modello è **"only a hint"** |
| Codex `unified_exec` | `yield_time_ms` 10.000ms (da sorgente) | n/d | modello per-call |
| Gemini `run_shell_command` | 300s **di inattività** | n/d | **solo config** (assente dai parametri del modello) |

Tre semantiche dietro la parola "timeout": kill-timeout (CC), attesa-output prima di restituire il controllo su sessione PTY persistente (Codex `unified_exec`), inattività (Gemini). Discrepanza aperta: issue #7353 riporta clamp a 30s su Codex vs default 10s nel sorgente — non riconciliata.

### 2.2 Troncamento output

- **Claude Code**: kill a 5GB. Risultato valido: inline fino ~30k char (`BASH_MAX_OUTPUT_LENGTH`, tetto 150k), oltre → **path a file** nella session dir + preview; failure: inline fino ~10k, oltre → **head-and-tail**, niente file. `grep/rg/find/diff/test` con exit 1 contano come validi. [VERIFICATO]
- **Codex**: `max_output_tokens` per-call impostabile dal modello + `tool_output_token_limit` globale config. [VERIFICATO i campi]
- **Gemini**: buffer live 100k char (trimming sicuro sulle surrogate pairs); troncamento opzionale "first 20% + last 80% of lines" (asimmetrico verso la coda). [PARZIALMENTE VERIFICATO il 20/80]

### 2.3 Background

- **Claude Code**: `run_in_background: true` + **auto-backgrounding su timeout** ("Command did not complete within its 120s timeout and was moved to the background"); gestione via `/tasks`. [VERIFICATO]
- **Gemini**: `is_background: boolean`, delay fisso 200ms, ritorno con `PID: ${pid}` + "Command is running in background.". [VERIFICATO]
- **Codex**: polling di sessione (`background_terminal_max_timeout` 300s default); nessuna notifica push trovata. [PARZIALMENTE VERIFICATO]

### 2.4 cwd e stato shell

- **Claude Code**: **unico con sessione persistente** — il `cd` sopravvive tra chiamate (dentro project dir/`--add-dir`, altrimenti reset con messaggio `Shell cwd was reset to <dir>`); env **non** persistente (`export` non sopravvive); rc sourced una volta; subagent non ereditano il cwd. [VERIFICATO]
- **Codex local shell**: `working_directory` e `env` **per-call**, nessuna persistenza (semantica one-shot). [VERIFICATO]
- **Gemini**: stateless per costruzione — ogni chiamata risolve `dir_path` contro la target dir fissa; nessuno stato shell. [VERIFICATO]

### 2.5 Sandbox UX: chi decide il retry non sandboxato

- **Claude Code — il modello propone**: *"Claude analyzes the failure and may retry the command with the `dangerouslyDisableSandbox` parameter"* → il retry passa dal **permission flow normale**; disattivabile del tutto (`allowUnsandboxedCommands: false` = strict mode, parametro ignorato); ask-rule forzabile; sandbox non disponibile → **fail-open di default** (warning + esecuzione non sandboxata) salvo `failIfUnavailable: true`. [VERIFICATO]
- **Codex — il modello chiede con motivazione**: campi `sandbox_permissions` (incl. `"require_escalated"`) e `justification` nello schema del tool [VERIFICATO da sorgente]; in default resta un gate umano (prompt "Reason: command failed; retry without sandbox?" con 3 opzioni) [PARZIALMENTE VERIFICATO, issue #19162].
- **Gemini — l'harness decide, MAI il modello**: errore tipizzato `ToolErrorType.SANDBOX_EXPANSION_REQUIRED` da `sandboxManager.parseDenials()` → modal **all'utente** (anche proattivo su comandi noti tipo `npm install`); *"The model doesn't explicitly request expansions; rather, the CLI detects necessity and prompts the user."* Approvazione vale per quella singola esecuzione. [VERIFICATO]

## Claim rigettati in verifica avversariale

- "Bash 600s hard limit non alzabile" (issue #25881) → contraddetto dalla doc (`BASH_MAX_TIMEOUT_MS` alza il tetto). [REJECTED]
- Attribuzione DeepWiki del pattern-matching sandbox-denial a `exec_policy.rs:212-230` → **file fetchato, contenuto assente**. [REJECTED]
- Clamp 30s Codex vs default 10s → conflitto riportato, non risolto.

## Aperto (assente dalla doc pubblica, non lacuna di ricerca)

Messaggio letterale che il modello vede alla negazione sandbox in CC; applicabilità dei vincoli "no XML/reserved words" alla CLI; timeout numerico del tool shell classico Codex; marcatori testuali esatti di troncamento; punto esatto della detection sandbox-denial nel codice Codex.

## Fonti principali

agentskills.io/specification · anthropics/skills (spec redirect) · agentskills/agentskills (skills-ref) · code.claude.com/docs/en/{skills,agent-sdk/skills,sandboxing,tools-reference} · platform.claude.com (agent-skills overview, bash-tool) · anthropic.com/engineering (agent skills, date) · developers.openai.com (local-shell) · learn.chatgpt.com (config-reference, sandboxing, approvals) · openai/codex raw (`unified_exec.rs`, `exec_policy.rs`, issue #19162, #7353) · google-gemini/gemini-cli raw (`shell.ts`, `config.ts`, docs sandbox.md).
