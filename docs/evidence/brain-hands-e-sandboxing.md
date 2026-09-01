# A6 — Brain/Hands, Sandboxing dell'Esecuzione e Good Practice AI Engineering (Fase A, integrazione) — agosto 2026

> Report dello scout A6, consegnato inline e persistito dall'orchestratore (lo scout non dispone di tool di scrittura). Contratto: solo evidenza con fonte (URL effettivamente aperto via WebFetch, o file:riga per materiale interno Muffin); niente raccomandazioni/verdetti — decide l'orchestratore; claim non verificabili marcati **[NON VERIFICATO]**; date accanto ai numeri. Convenzione: **[VERIFICATO]** = fonte primaria aperta con estrazione diretta; **[PARZIALMENTE VERIFICATO]** = fonte aperta ma sintesi/mirror di terzi o dettaglio parziale; **[NON VERIFICATO]** = solo da sintesi WebSearch; **[TENSIONE/DISCREPANZA]** = fonti in disaccordo, non risolta.

**Nota preliminare — Muffin non parte da zero.** `package.json` conferma `@anthropic-ai/sandbox-runtime@0.0.52` già installato; `src/security/sandbox_wrapper.ts` (letto per intero) lo usa come **terzo layer di defense-in-depth** dietro `validatePath` (S.0.2) e lo zone classifier (yellow/red), con profilo di allowlist domini/fs derivato da `MUFFIN_HOME` (`src/security/sandbox_wrapper.ts:37-82`). `SANDBOX_ENABLED = true` di default dal 2026-06-11 (`src/flags.ts:105`), ma **no-op se la piattaforma non supporta Seatbelt/bubblewrap** (`initializeSandbox`, `sandbox_wrapper.ts:114-156`) — su Linux richiede `bubblewrap` installato sul VPS. Questo report verifica quindi un meccanismo che Muffin ha già scelto, non ne propone uno nuovo da zero; il gap che l'owner ha segnalato (kernel di policy decide QUALE azione, manca evidenza su COME si contiene l'esecuzione) è quindi anche "quanto bene stiamo usando ciò che già abbiamo" oltre che "cosa manca".

---

## Mandato 1 — Come i coding harness reali sandboxano l'esecuzione

### 1.1 Claude Code / `@anthropic-ai/sandbox-runtime` — il caso più documentato

**Fonte primaria diretta**: [code.claude.com/docs/en/sandboxing](https://code.claude.com/docs/en/sandboxing) (fetch integrale 2026-08-04) + README del pacchetto realmente installato in Muffin ([`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime), v0.0.52) + blog ufficiali.

**Meccanica esatta [VERIFICATO]**:
- **macOS**: `sandbox-exec` con profili Seatbelt generati dinamicamente. Nessuna dipendenza aggiuntiva.
- **Linux e WSL2**: `bubblewrap` (bwrap) per l'isolamento filesystem+namespace + `socat` come relay per il proxy di rete. Filtro **seccomp opzionale** (blocca la creazione di Unix domain socket).
- **Windows nativo NON supportato** — solo dentro WSL2 (WSL1 esplicitamente rifiutato: "Sandboxing requires WSL2").
- **Cosa isola**: due layer **indipendenti** — filesystem (deny-then-allow in lettura, allow-only in scrittura; write di default = solo cwd + temp-dir di sessione) e rete (**allow-only, nessun dominio pre-allowlisted di default**, prompt alla prima richiesta di un dominio nuovo). La combinazione dei due è dichiarata esplicitamente **necessaria**: "Without network isolation, a compromised agent could exfiltrate sensitive files... Without filesystem isolation... a compromised agent could backdoor system resources to gain network access" (quote diretta dalla doc).
- **Egress**: proxy HTTP + SOCKS5 in esecuzione **fuori** dal sandbox, sul host. Su Linux il traffico passa per Unix domain socket bind-mountati dentro il sandbox (namespace di rete del processo sandboxato **rimosso del tutto**); su macOS il profilo Seatbelt permette comunicazione **solo** verso una porta localhost specifica dove i proxy ascoltano.
- **Escape hatch [VERIFICATO, dettaglio esatto]**: quando un comando fallisce per restrizioni sandbox, Claude Code **stesso** (il modello) può ritentare con parametro `dangerouslyDisableSandbox: true` — il retry passa dal flusso di permessi normale (prompt in default mode, classifier in "auto mode"). Disattivabile del tutto (`allowUnsandboxedCommands: false`, "Strict sandbox mode") — a quel punto il parametro è ignorato e il comando deve girare sandboxato o essere in `excludedCommands`.
- **Mandatory deny paths**: file sensibili (`.bashrc`, `.gitconfig`, `.git/hooks/`, `.claude/commands/`, `.mcp.json` ecc.) sono **sempre** bloccati in scrittura anche dentro un `allowWrite` ampio — difesa esplicita contro sandbox-escape via config tampering.
- **Maturità dichiarata**: sandbox-runtime standalone è **"Beta Research Preview"** (quote: *"As this is an early research preview, APIs and configuration formats may evolve"*), MA il sandbox **integrato in Claude Code** è già enforcement di produzione con settings gestibili a livello organizzativo (`managed settings`, `failIfUnavailable`, `allowManagedDomainsOnly`).

**Riduzione permission-prompt — [VERIFICATO CON DISCREPANZA DI FONTE]**: "**84% di riduzione dei prompt di permesso**" citato in due punti — digest del post *"Beyond permission prompts…"* (Anthropic, 2025-10-08) e, **confermato da estrazione diretta**, *"How we contain Claude across products"* ([anthropic.com/engineering/how-we-contain-claude](https://www.anthropic.com/engineering/how-we-contain-claude), **2026-05-25**) nella sezione Claude Code. Trattato come **[PARZIALMENTE VERIFICATO]**: reale e attribuito ad Anthropic, ma metodologia ("internal usage") non ispezionata parola-per-parola.

**Egress control avanzato — MITM esplicito [VERIFICATO]**: `network.tlsTerminate` (sperimentale, dalla v2.1.199) fa terminare la TLS al proxy — richiesto per il **credential masking** (`sandbox.credentials` con `mode:"mask"`): il comando sandboxato vede solo un sentinel value; il proxy sostituisce il sentinel col valore vero **solo** per gli host in `injectHosts`. Di **default il proxy non ispeziona il TLS** — quote: *"code running inside the sandbox can potentially use domain fronting... to reach hosts outside the allowlist"*. Per garanzie più forti la doc raccomanda un **proxy custom** che termina TLS (supporto via `httpProxyPort`/`socksProxyPort`). "How we contain Claude" **conferma un caso reale**: per **Claude Cowork** (VM sigillata) Anthropic ha costruito un **MITM proxy interno alla VM** dopo aver scoperto che l'allowlist per-dominio non bastava (`api.anthropic.com` permetteva upload su un account attaccante tramite chiavi embedded) — mitigazione: proxy che accetta solo un session-token provisionato.

**Architettura a tre prodotti, tre livelli di isolamento [VERIFICATO]** (da "How we contain Claude"): **claude.ai** = container **gVisor** effimero per sessione; **Claude Code** = sandbox OS-level (Seatbelt/bubblewrap) sulla macchina dell'utente, human-in-the-loop; **Claude Cowork** = **VM completa** su hypervisor (Apple Virtualization / Hyper-V), credenziali nel keychain host con token scoped-per-sessione. Principio dichiarato: *"match isolamento alla capacità di oversight dell'utente"* — tre threat model, tre soluzioni diverse.

### 1.2 OpenAI Codex CLI

**Fonte primaria diretta**: [learn.chatgpt.com/docs/sandboxing](https://learn.chatgpt.com/docs/sandboxing) (redirect da developers.openai.com/codex/sandboxing, fetch 2026-08-04).

**[TENSIONE/DISCREPANZA non risolta]**: l'estrazione diretta descrive per Linux/WSL2 **bubblewrap** come meccanismo primario, con fallback a user namespace unprivileged; una fonte secondaria attribuisce a Codex **Landlock + seccomp-bpf**. Non necessariamente incompatibili (layer diversi o doc cambiata tra le date) — [NON RICONCILIATO].

**Dati [VERIFICATO da estrazione diretta]**: macOS = Seatbelt; Windows = sandbox nativa PowerShell, WSL2 = stack Linux; l'isolamento copre **i comandi spawned, non solo i tool interni**; policy default `workspace-write`; oltre i confini → approval flow (una-volta/sessione/mai); un "automatic review" può delegare a un agente reviewer senza modificare i confini sandbox (separazione tra "chi approva" e "cosa il comando può toccare"). Le tre policy (`read-only`/`workspace-write`/`danger-full-access`) [NON VERIFICATO coi nomi esatti su pagina primaria].

### 1.3 Gemini CLI

**Fonte primaria diretta**: [docs/cli/sandbox.md del repo gemini-cli](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md) (fetch 2026-08-04).

**[VERIFICATO]**: due percorsi — (a) **macOS Seatbelt con sei profili nominati** (`permissive-open` default: "Write restrictions, network allowed" → `strict-proxied`); il default nega scrittura fuori dal progetto ma **permette rete diretta**; (b) **Docker/Podman** su qualunque piattaforma (mount della cwd, immagine personalizzabile). **"Sandbox Expansion"**: quando un comando fallisce per restrizioni, dialogo che mostra **quali permessi aggiuntivi servono**, approvazione **per quella esecuzione** (escalation granulare, non flag disable-tutto). Gap: i profili "-proxied" non documentano il meccanismo di allowlist di dominio.

### 1.4 Goose (Block → AAIF)

**[PARZIALMENTE VERIFICATO — sintesi WebSearch della doc ufficiale]**: `sandbox-exec` (Seatbelt) **solo macOS**, **opt-in** (`GOOSE_SANDBOX=true`, non persistente). Rete: **nega ogni accesso diretto**, tutto via proxy locale, uniche connessioni dirette = localhost; blocca esplicitamente tool di tunneling (`nc`, `ncat`, `netcat`, `socat`, `telnet`) e `SOCK_RAW` — difesa contro bypass del proxy. **Nessun equivalente Linux documentato** — coerente con a2 §3.

### 1.5 OpenHands

**[PARZIALMENTE VERIFICATO]**: (a) **Docker Runtime** (default) — controller separato + container per task; (b) **Local Runtime** — zero isolamento, dichiarato non-sicuro dalla doc stessa. Proposta 2026 (issue #13203): **`exec-sandbox`**, microVM QEMU dedicata per esecuzione (KVM su Linux, **HVF su macOS**), motivata dal non richiedere docker daemon — **proposta, non shippata**.

### 1.6 Sintesi cross-harness

| Asse | Claude Code | Codex CLI | Gemini CLI | Goose | OpenHands |
|---|---|---|---|---|---|
| macOS | Seatbelt, integrato | Seatbelt | Seatbelt, 6 profili | Seatbelt, **opt-in env var** | nessuno nativo (Docker/QEMU) |
| Linux | bubblewrap + seccomp opz. | bubblewrap (diretto) vs Landlock+seccomp (secondaria) — **non risolto** | Docker/Podman | **nessuno documentato** | Docker (default) o Local (zero) |
| Windows | no nativo, solo WSL2 | sandbox nativa PowerShell + WSL2 | via Docker | non documentato | via Docker |
| Default ON | **no** (opt-in, enforceable via managed settings) | sì implicito (workspace-write) | opt-in | **opt-in** | Docker sì, Local selezionabile |
| Escape hatch | `dangerouslyDisableSandbox` per-comando → permission flow | approval flow | "Sandbox Expansion" per-esecuzione | disattivazione intera app | switch runtime |

---

## Mandato 2 — Menu tecnologico sandbox

### 2.1 OS-level
- **macOS Seatbelt (`sandbox-exec`)** [VERIFICATO stato]: non deprecato nell'uso (Claude Code, Codex, Gemini CLI, Goose lo usano nel 2026); zero dipendenze; enforcement kernel via TrustedBSD MAC.
- **Linux bubblewrap**: maturo; richiede `bubblewrap`+`socat` (+seccomp opz.). **Nota hardening [VERIFICATO]**: Ubuntu 24.04+ con AppArmor `kernel.apparmor_restrict_unprivileged_userns` blocca gli user namespace → serve profilo AppArmor dedicato per `bwrap` (documentato sia in sandbox-runtime sia in Claude Code).
- **Landlock/seccomp/namespaces/cgroups**: primitive kernel unprivileged (Landlock ≥5.13). Paper dedicato: *"Sandlock: Confining AI Agent Code with Unprivileged Linux Primitives"* ([arxiv.org/pdf/2605.26298](https://arxiv.org/pdf/2605.26298), 2026-05-27) — Landlock(fs)+seccomp(syscall)+ns/cgroups(risorse)+pidfd+overlayfs; overhead quantitativo [NON VERIFICATO].

### 2.2-2.6 Container, microVM, gVisor, WASM, remote

| Tecnologia | Isola cosa | Startup | Overhead | Piattaforme | Chi la usa (verificato) |
|---|---|---|---|---|---|
| Seatbelt | fs r/w + rete (porta proxy locale) | ~istantaneo | minimo | macOS | Claude Code, Codex, Gemini CLI, Goose |
| bubblewrap | fs (bind-mount) + netns rimosso | ~istantaneo | minimo | Linux/WSL2 | Claude Code/sandbox-runtime, Codex |
| Landlock+seccomp | fs + syscall + risorse | n.q. | n.q. [NV] | Linux ≥5.13 | Sandlock (ricerca) |
| Docker/Podman rootless | container, kernel condiviso | centinaia ms–s | basso CPU-bound | ovunque | OpenHands (default), Gemini CLI, Daytona, base Cloudflare SDK |
| **Firecracker** | kernel dedicato per microVM (KVM) | **≤125ms** boot; 150 microVM/s per host | **<5MiB**/microVM; snapshot-restore 5-30ms [NV] | Linux (KVM) | E2B (usato da Manus, ~150-200ms) |
| **gVisor** | syscall intercettate da kernel user-space | n.q. | CPU-bound trascurabile; **syscall-heavy 10-30%**; prod Ant: 70% app <1%, 25% <3% | Linux | claude.ai, Modal |
| WASM/wasmtime | bytecode/capability, non OS-level | 2-5ms [NV] | mem-access fino a +156,6% in un caso | cross | nessun coding-harness coperto — adatto a tool JS/TS fidato |
| Cloudflare isolates V8 | JS/TS context | µs [NV] | ~5MB/isolate | edge | NON usato dal Sandbox SDK per shell (usa Containers) |
| E2B (Firecracker) | microVM dedicata | ~150-200ms; p50 78ms [parziale] | Hobby free/$100; Pro $150/mese | remoto | Manus (27 tool; output 50+ pagine ≈ $6-7 di sandbox-time) |
| Daytona | Docker default, Kata/Sysbox opz. | claim sub-90ms (creazione); 197ms ciclo completo (terzi) | enterprise-only pricing | remoto | — |
| Modal | gVisor | sub-second dichiarato, **1-5s osservato sotto carico** | Sandbox CPU ≈ 3× tariffa Function | remoto | piattaforma ML |
| Cloudflare Sandbox SDK | Container Linux completo | n.d. | pricing Containers | edge | GA 2026-04-13; credential-proxy pattern |

---

## Mandato 3 — Egress control a livello esecuzione

- **Modello dominante (4/5 harness)**: network namespace rimosso/ristretto + **proxy locale con allowlist di dominio, allow-only** (nessun dominio pre-concesso). Linux: traffico via Unix socket bind-mountati (netns rimosso); macOS: Seatbelt permette solo la porta proxy localhost.
- **MITM/TLS-inspection**: **nessuno di default, da nessuno**. Claude Code `tlsTerminate` sperimentale (per credential masking: sentinel values sostituiti dal proxy solo per host dichiarati); Cowork ha un MITM custom nato da un caso reale di exfiltration (allowlist per-hostname insufficiente); sandbox-runtime dichiara "Bring Your Own Proxy" (mitmproxy come esempio) ma non implementato nativamente.
- **Limite dichiarato da Anthropic**: senza ispezione TLS, l'allowlist decide sull'hostname dichiarato dal client — un dominio ampio consentito (es. `github.com`) resta un canale di esfiltrazione legittimo; domain fronting possibile (warning esplicito in doc).
- **DNS pinning**: non documentato come pattern nominato in nessun sandbox coperto. (Distinto dal guard **applicativo** anti-DNS-rebinding che Muffin ha già in `src/utils/ssrf.ts` per `fetch_url`.)
- **eBPF egress (kernel-level)**: un solo caso concreto — ClawArmor per OpenClaw (Mandato 6): egress allowlist a provider modello + destinazioni skill dichiarate, enforcement syscall via KubeArmor/eBPF, nessuna ispezione TLS.

---

## Mandato 4 — Pattern architetturali brain/hands

### 4.1 Implementazioni reali di plan-then-execute / separazione
- **Devin "Outposts" [VERIFICATO]** ([devin.ai/blog/introducing-devin-outposts](https://devin.ai/blog/introducing-devin-outposts), 2026-07-21): brain/hands **in produzione** — *"Devin's agent loop stays in Devin's cloud; sessions execute on machines you operate"*; worker **solo outbound** (*"Your machines only dial out — no inbound connectivity required"*); esecuzione come utente non privilegiato (meccanismo OS-level non specificato).
- **CODA (Cerebrum/Cerebellum) [VERIFICATO parziale]** ([arxiv.org/abs/2508.20096](https://arxiv.org/abs/2508.20096)): planner generalista + executor specialista per GUI-agent scientifici; SOTA open su ScienceBoard; **ricerca**, non prodotto.

### 4.2 CodeAct vs tool-call diretti
- Paper CodeAct ([arxiv.org/abs/2402.01030](https://arxiv.org/abs/2402.01030)) [PARZIALMENTE VERIFICATO]: azioni = codice Python eseguibile; fino a **+20% success** su 17 LLM. smolagents (HF): `CodeAgent` con **-30% step** dichiarato vs tool-calling; esecuzione "locally or in a secure sandbox".
- **Implicazione di sicurezza diretta**: CodeAct **aumenta** il bisogno di sandbox OS-level — con codice libero la validazione applicativa pre-esecuzione (whitelist nome-tool+argomenti) non si applica più; il contenimento OS diventa **il** meccanismo residuo. Odysseus = caso concreto di CodeAct-style **senza** sandbox (gap auto-dichiarato #1058).

### 4.3 Planner grande / executor piccolo
- Manus: 3 agenti coordinati (Planner/Executor/Knowledge) [NON VERIFICATO primaria]. Devin: planning-mode sub-agent [NV].
- **Caveat empirico [esistenza VERIFICATA]** (*"Efficient LLM Collaboration via Planning"*, [arxiv.org/pdf/2506.11578](https://arxiv.org/pdf/2506.11578)): un planner **piccolo** che pianifica per un executor grande spesso **peggiora** il baseline — la direzione della separazione conta.

### 4.4 Sub-agent come isolamento
- **Claude Code subagents [VERIFICATO]** ([code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents)): context window fresco, tool-access list propria, l'unico input = prompt string; torna solo il riassunto; **no nesting**. Il sandbox Bash si applica identico — è isolamento di **contesto**, non di esecuzione.
- **Hermes `DELEGATE_BLOCKED_TOOLS` + `max_spawn_depth=2`** (già verificato in a2): isolamento **per-capability** (il sub-agente ha meno poteri, non solo meno storia). Complementare al precedente.
- **Odysseus untrusted-wrapper anche su memorie/skill proprie**: principio adiacente — output di qualunque componente interno = dato non fidato.

---

## Mandato 5 — Catalogo good practice AI engineering 2026

### 5.1 Anthropic [VERIFICATO, fetch diretti]
- **"Building Effective Agents"** (2024-12-19): workflow (percorsi predefiniti: economico, predicibile) vs agent (LLM dirige); 6 pattern (Prompt Chaining, Routing, Parallelization, **Orchestrator-Workers**, Evaluator-Optimizer, Autonomous); *"add complexity only when it demonstrably improves outcomes"*; sandbox testing + guardrail + checkpoint umani + **condizioni di arresto esplicite**; *"la revisione umana rimane fondamentale"*.
- **"Effective context engineering for AI agents"** (set-2025): tool *"self-contained, robust to error, extremely clear"*; antipattern nominato: **"bloated tool sets... ambiguous decision points"**; tre strategie long-horizon: (1) **compaction**, (2) **structured note-taking**, (3) **sub-agent architecture** (i sub tornano riassunti 1-2K token); "context come risorsa finita". Nota: Muffin implementa già (1) come tool-result clearing (-48% picco token) e (2) come ledger/recitation; (3) è il pezzo non ancora cablato.

### 5.2 OpenAI [PARZIALMENTE VERIFICATO — PDF via trascrizione terzi coerente con landing]
"A practical guide to building agents": quando un agente (3 scenari); orchestrazione **Manager** vs **Decentralizzato**; **guardrail a strati, 6 tipi** (rilevanza, safety/injection, PII, moderation, tool-risk rating, rule-based + validazione output); **HITL, 2 trigger** (soglia di fallimento; azioni ad alto rischio).

### 5.3 12-Factor Agents (HumanLayer) [VERIFICATO]
Fattori rilevanti qui: **F5** unify execution/business state; **F6** launch/pause/resume via API semplici; **F7** contact humans **with tool calls**; **F8** own your control flow; **F10** small, focused agents.

### 5.4 OWASP MCP [VERIFICATO landing; PDF completi non aperti]
- *"Secure MCP Server Development"* (2026-02-16): architettura sicura, authN/Z forte, input validation, session isolation, hardened deployment; **sandboxing raccomandato esplicitamente** ("containers with filesystem isolation, network restrictions and minimal privileges"); token **short-lived, minimamente scoped**.
- *"CheatSheet third-party MCP servers 1.0"* (2025-10-23): minacce nominate — tool poisoning, prompt injection, memory poisoning, tool interference; mitigazioni: sandbox lato client, privilegio minimo, HITL.

### 5.5 Pattern operativi
- **Idempotenza/undo**: idempotency-key pre-call (pattern consolidato [NV primaria]); Muffin lo implementa già (outbox `idempotencyKey` sha256, tier-2 undo_log).
- **Dry-run mode** [NV primaria]; **structured output come contratto** [pattern ricorrente]; **secrets**: l'agente non vede mai il secret raw (token scoped, scadenza); Muffin già: `SANDBOX_CHILD_ENV_ALLOWLIST` = solo `{PATH,HOME,LANG,LC_ALL,TZ}` + guard `isSecretLikeEnvName`.
- **Shadow/canary per cambi prompt/config** [pattern coerente su più fonti]: shadow su traffico reale → canary 5-10% con **valutazione semantica automatizzata** (LLM-judge), non solo metriche infra — le regressioni sono semantiche, non di sistema.

### 5.6 Benchmark "sandbox on vs off" — **gap dichiarato**
Nessun benchmark indipendente "stesso agent, stesso task, sandbox ON vs OFF". Dati adiacenti: 84% meno permission-prompt (UX, Anthropic); gVisor 10-30% syscall-heavy; stima Daytona (30-100s→1,3s su 10-20 tool-call passando a sandbox remoto) = marketing vendor. Nessuna misura dell'overhead bubblewrap/Seatbelt in un loop bash-tool ripetuto.

---

## Mandato 6 — Peer post-CVE

- **OpenClaw**: invariato — nessun sandbox OS-level nativo shippato; ClawArmor ([accuknox.com blog](https://www.accuknox.com/blog/introducing-clawarmor-for-openclaw-instances), 2026-04-27) resta terze parti: KubeArmor+eBPF, 3 policy (fs: workspace-only, nega `/etc`,`~/.ssh`,`.aws`,`.kube`, Docker socket; process: allowlist binari, blocca `nmap`/`curl`/`wget`/`bash`; egress: provider+skill+webhook dichiarati). Changelog 2026 = hardening fail-closed su timeout/errore, non redesign. Ultima stable citata v2026.6.1.
- **Hermes**: **seconda** vulnerabilità di sandbox-escape trovata oltre CVE-2026-9368 — [issue #4146](https://github.com/NousResearch/hermes-agent/issues/4146) (2026-03-31, Critical/P1, **fixata**): `terminal` era in `SANDBOX_ALLOWED_TOOLS` → codice dentro il sandbox invocava `terminal()` via stub RPC **bypassando** `check_dangerous_command()` (78 pattern). Root cause: l'approvazione vive fuori dal sandbox ma un canale RPC interno raggiungeva la funzione non protetta. Lezione: "defense-in-depth con un canale RPC dimenticato" — nessun side-channel dal sandbox verso tool privilegiati.

---

## Tabella harness (brain/hands · sandbox default · egress)

| Harness | Brain/hands | Sandbox default | Egress control |
|---|---|---|---|
| Claude Code | no (loop unico); subagent = isolamento contesto; Cowork = VM | **no** (opt-in, org-enforceable), doppio layer fs+net | proxy allow-only; no TLS-inspect default; `tlsTerminate` sperimentale + credential masking |
| Codex CLI | no; "automatic review" separato | sì implicito (workspace-write) | isolamento rete dichiarato, proxy non dettagliato |
| Gemini CLI | no | opt-in; default macOS rete diretta | solo profili "-proxied", non dettagliato |
| Goose | no | **no** (opt-in macOS) | nel sandbox opt-in: proxy forzato + blocco tool tunneling |
| OpenHands | no nel core; exec-sandbox microVM = proposta | Docker sì / Local zero | non documentato |
| Devin | **sì, in produzione** (cloud-brain / Outpost-hands, solo outbound) | utente non privilegiato sul worker | outbound-only; dettagli non pubblici |
| OpenClaw | no | **no** (ClawArmor = terze parti eBPF) | solo via ClawArmor |
| Hermes | delega con capability ridotte (non separazione di esecuzione) | sandbox execute_code con 2 escape trovate e fixate | non documentato |

---

## Sintesi per l'orchestratore

Muffin ha **già** `@anthropic-ai/sandbox-runtime` wired come terzo layer (default ON dal 2026-06-11) ma **inerte senza bubblewrap sull'host Linux** — primo controllo concreto: verificare il VPS. Il modello più documentato e più vicino a quanto già scelto è quello di Claude Code: Seatbelt/bubblewrap, doppio layer fs+network indipendente, rete allow-only via proxy locale, mandatory deny paths, escape-hatch per-comando dentro il permission flow. **Nessun harness ha TLS-inspection di default** e Anthropic stessa dichiara l'allowlist per-hostname insufficiente da sola (caso Cowork). **Devin Outposts** è l'unica separazione brain/hands letterale in produzione (cloud-brain, worker solo-outbound). **CodeAct aumenta il bisogno di sandbox** (Odysseus lo dimostra al negativo). I sub-agent isolano il **contesto** (Claude Code) e le **capability** (Hermes) — assi complementari, nessuno dei due isola l'**esecuzione**. Peer: OpenClaw ancora senza sandbox nativo; Hermes ha avuto una seconda escape (canale RPC interno verso tool privilegiato) — lezione strutturale: il confine sandbox è anche un confine di capability, nessun side-channel. Gap onesto: nessuna misura indipendente dell'overhead sandbox in un loop agentico reale.
