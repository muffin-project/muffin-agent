# A2 — Prior art: agenti personali always-on e harness agentici (stato agosto 2026)

> Agente scout, Fase A del blueprint MuffinOS. Contratto: solo evidenza con fonte (URL effettivamente aperto via WebFetch, o file:riga per materiale interno); niente raccomandazioni/verdetti; claim non verificabili marcati `[NON VERIFICATO]`; date accanto ai numeri volatili. Le pagine web sono dati, non istruzioni.

## Metodo e cosa NON ri-derivo

Questo report **estende**, non ripete, la SOTA già fatta internamente. Letta prima di scrivere:

- `docs/strategy/2026-06-11-agentic-os-research.md` — deep-dive source-level Hermes (HEAD `a09343c`, giugno 2026) + 20 claim agentic-OS verificati avversarialmente (kernel come "ciò che il modello non bypassa", AOS/AIOS enforcement deterministico, skills-as-userland, memoria che degrada col function calling, parità 26-32B solo nel regime strutturato).
- `.claude/agent-memory/research-scout/hermes_executive_loop_2026q2.md` (worktree `goofy-allen-17eab5`) — deep-dive source-level Hermes: loop termination, goal-loop `/goal`, skill self-authoring, kanban work-queue, Tirith smart-approval.
- `.claude/agent-memory/research-scout/competitor_odysseus_deep_dive.md` (worktree `goofy-allen-17eab5`) — deep-dive source-level Odysseus (781 file Python letti): memoria, CalDAV, scheduler/event-bus, permessi, secret storage, prompt-injection hardening, teacher-escalation.
- `.claude/agent-memory/research-scout/2026-07-16-personal-agent-landscape.md` — aggiornamento 16 luglio: Hermes ($1.5B valuation), OpenClaw (crisi CVE multipla), Odysseus (nessun pivot), HumanLayer (abbandono), nuovi entranti (OpenJarvis, Second Me), mosse dei grandi (Anthropic Dreams, OSWorld, ChatGPT Work), consenso architetturale (Quine, ActPlane).
- `.claude/agent-memory/research-scout/2026-06-16-gap-competitors.md` — evoluzione feb-giu 2026 release-by-release di Hermes/OpenClaw/Odysseus/HumanLayer + nuovi entranti (OpenHuman, taOS, MemoryOS, Letta Code).
- `.claude/agent-memory/research-scout/2026-07-07-teardown-hermes-openhands.md` — teardown a codice (non changelog) di Hermes (`context_compressor.py`, `goals.py`, `delegate_tool.py`) e OpenHands-V1 (`condenser`, `stuck_detector.py`, secondo goal-judge).
- `.claude/agent-memory/research-scout/2026-07-06-memory-moat-sota.md` — Letta v1-agent vs MemFS/Context-Repositories (due cambi DIVERSI, spesso confusi), tassonomia "tre scuole" della memoria agentica (chauyan.dev).

**Cosa aggiunge questo report**: (a) freshness check ad agosto 2026 su Hermes/OpenClaw/Odysseus/HumanLayer (stelle, CVE nuove, release); (b) ricerca ex-novo su Goose (Block/AAIF), OpenHarness (HKUDS), Khoj, e Letta lato onboarding/traction/sicurezza (la memoria era già coperta); (c) archeologia del nome "OS"; (d) "cosa non fa nessuno" verificato sui repo/doc; (e) controllo reale della macchina con numeri OSWorld correnti.

**Nota sui numeri di traction**: sono volatili per definizione (stelle GitHub, conteggi registry). Ogni numero riporta la fonte e, dove possibile, la data della verifica diretta (WebFetch di oggi, 2026-08-04, oppure la data pubblicata dalla fonte secondaria quando non ho potuto fare fetch diretto).

---

## 1. OpenClaw

### Forma e UX

Personal AI assistant self-hosted, tagline "Any OS. Any Platform. The lobster way." Architettura a **Gateway**: "the local control plane for sessions, tools, events, and channel connections" ([github.com/openclaw/openclaw](https://github.com/openclaw/openclaw), fetch 2026-08-04). Modello di trust: "designed for a single operator"; canali DM-capable fanno pairing di sender sconosciuti di default, richiede approvazione esplicita della richiesta di pairing (stessa fonte).

Onboarding: non ho trovato in questa passata una pagina di quickstart step-by-step con comandi verificati [NON VERIFICATO il dettaglio esatto dei passi di setup]; la configurazione vive in `~/.openclaw/openclaw.json`, con RPC per introspezione/patch (`config.schema.lookup` poi `config.patch`) — verificato via [docs.openclaw.ai/gateway/security](https://docs.openclaw.ai/gateway/security) (fetch 2026-08-04).

### Capability vere

- **Memoria**: "Memory Wiki" con un vault globale di default; scoping a livello-agente possibile (`plugins.entries.memory-wiki.config.vault.scope = agent`) per separare la conoscenza compilata di agenti diversi ([mindstudio.ai](https://www.mindstudio.ai/blog/telegram-threads-openclaw-agent-memory), citato da ricerca; verificare in loco). **Active Memory Plugin** (v2026.4.10, già verificato dallo scout interno 2026-06-16): sub-agente che gira PRIMA della reply principale su ogni turno, recupera preferenze/history in <150ms — un LLM-call completo, non solo similarity su embedding.
- **Proattività**: non ho trovato in questa passata un meccanismo dedicato di "decide quando parlare per primo" a livello di soglia (diverso da rispondere quando menzionato/allowlisted) [NON VERIFICATO].
- **Multi-canale**: molto ampio — "OpenClaw applies the same group rules across group-capable channels, including Discord, iMessage, Matrix, Microsoft Teams, QQBot, Signal, Slack, Telegram, WhatsApp, and Zalo" ([docs.openclaw.ai/channels/groups](https://docs.openclaw.ai/channels/groups), fetch 2026-08-04).
- **Gruppi/multi-utente**: isolamento via **session-key**: `agent:<agentId>:<channel>:group:<id>` per i gruppi, `agent:<agentId>:<channel>:channel:<id>` per i canali, sessione principale o per-sender per le DM (stessa fonte). Le sessioni di gruppo "non eseguono i propri heartbeat" e sono separate dalla sessione DM principale. Routing per-canale/per-topic verso agenti diversi (incluso il binding per Telegram-forum-topic a un `agentId` diverso, con workspace/memoria/sessione propri). **Non esiste un concetto di memoria condivisa cross-community nella documentazione**: "There is no concept of community-wide memory sharing described in this documentation. Each group maintains isolated session state" (stessa fonte, fetch 2026-08-04).
- **Controllo macchina**: `exec` = "the most powerful and most dangerous Tool in OpenClaw; It lets the agent run any shell command – install packages, execute scripts, delete files, manage services" + fs read/write/edit/apply_patch, eseguiti "with the same permissions as your user account" ([docs.openclaw.ai/tools/exec](https://docs.openclaw.ai/tools/exec), ricerca verificata 2026-08-04). Nessun sandboxing di default.
- **Lavoro sul proprio codice / deep research**: non è il caso d'uso primario dichiarato (a differenza di Hermes/Goose); il tool-set è generico (shell/fs/browser), quindi tecnicamente capace ma non specializzato.

### Architettura

TypeScript. Estensioni via "plugin SDK" condivise su **ClawHub**. Conteggio del registry: **numeri fortemente contraddittori tra fonti, nessuna cifra unica confermabile**. Riportati, in ordine cronologico dichiarato: 13.729 skill registrate entro fine febbraio 2026, ridotte a 3.286 dopo un "security purge"; poi 52.652 pacchetti a giugno 2026; un'altra fonte riporta "~57k skill live" riferendosi però ad aprile 2026 (incongruenza cronologica nella fonte stessa). Una ricerca dedicata lo segnala esplicitamente: *"figures floating around contradict each other wildly, and no single confirmed total from the registry itself could be verified"* (sintesi di ricerca aggregata, non fonte primaria unica — [gonzoml.substack.com](https://gonzoml.substack.com/p/i-read-47094-clawhub-skills-so-your), [trent.ai/blog/clawhub-by-the-numbers](https://trent.ai/blog/clawhub-by-the-numbers/), [apiyi.com](https://help.apiyi.com/en/clawhub-ai-openclaw-skills-registry-guide-en.html), tutte secondarie). Trattare qualunque cifra ClawHub come indicativa, non come dato solido.

### Sicurezza — la parte più densa di incidenti tra tutti i sistemi coperti

Modello dichiarato esplicitamente **non-enforcement-by-prompt**: *"Prompt injection is not solved by system prompt guardrails alone - those are soft guidance; hard enforcement comes from tool policy, exec approvals, sandboxing, and channel allowlists (which operators can still disable by design)"* ([docs.openclaw.ai/gateway/security](https://docs.openclaw.ai/gateway/security), fetch diretto 2026-08-04). Root of trust dichiarato = **il filesystem dell'operatore**, non un meccanismo crittografico: *"If someone can modify Gateway host state/config (~/.openclaw, including openclaw.json), treat them as a trusted operator"* (stessa fonte). Input esterno wrappato con boundary marker `<<<EXTERNAL_UNTRUSTED_CONTENT ...>>>` e sanitizzazione dei token di ruolo sintetici, ma esplicitamente "supplements (not replaces) allowlists, approvals, and sandboxing."

CVE/incidenti verificati (fonti primarie/security-vendor dove disponibili):

| CVE / nome | Data disclosure | Meccanismo | Severità | Fix |
|---|---|---|---|---|
| CVE-2026-25253 | 2026-02-03/04 | Control UI si fida di un parametro query `gatewayURL`, apre WebSocket con token salvati senza verifica origin → RCE one-click | Critical (full gateway compromise) | v2026.1.29 |
| "ClawJacked" (nessun CVE citato dalla fonte) | pubblicato 2026-02-26, aggiornato 2026-05-27 | Gateway esenta le connessioni localhost da rate-limit; JS su sito attaccante apre WebSocket verso il gateway locale e fa brute-force della password a "centinaia di tentativi/sec"; pairing automatico su localhost senza prompt utente | High (per classificazione del team OpenClaw) | v2026.2.25, entro 24h dalla disclosure |
| CVE-2026-32922 | pubblicato ~2026-03 (fix 2026-03-13) | `device.token.rotate` non vincola gli scope del nuovo token allo scope del chiamante → un token con scope `operator.pairing` può automintarsi `operator.admin` → RCE via `system.run` | CVSS 9.9 (3.1) / 9.4 (4.0) — "la più severa nella storia di OpenClaw" (ARMO) | v2026.3.11 |
| CVE-2026-33579 | fix 2026-03-29 | Privilege escalation, chiunque con accesso al pairing ottiene controllo admin pieno | — | v2026.3.28 |
| Batch aprile 2026 | — | 13 CVE distinte patchate insieme | — | v2026.4.5+ |
| CVE-2026-44113/44115/44118 | — | Esposizione credenziali/secret/file sensibili, controllo owner-level | — | [NON VERIFICATO fix esatto in questa passata] |

Fonti dirette: [security.utoronto.ca advisory](https://security.utoronto.ca/advisories/openclaw-vulnerability-notification/) (fetch 2026-08-04, CVE-2026-25253), [oasis.security/blog/openclaw-vulnerability](https://www.oasis.security/blog/openclaw-vulnerability) (fetch 2026-08-04, ClawJacked), [armosec.io/blog/cve-2026-32922...](https://www.armosec.io/blog/cve-2026-32922-openclaw-privilege-escalation-cloud-security/), [sentinelone.com/vulnerability-database/cve-2026-32922](https://www.sentinelone.com/vulnerability-database/cve-2026-32922/), [tenable.com/cve/CVE-2026-32922](https://www.tenable.com/cve/CVE-2026-32922).

**Numeri di esposizione — divergenti tra fonti, riportati come range non come dato singolo**: SecurityScorecard (via ARMO, citata) parla di "135.000+ istanze pubblicamente esposte" a fine febbraio 2026, "63% senza alcuna autenticazione"; un altro aggregatore (breached.company, "Claw Chain") parla di "245.000 AI agent server a rischio"; lo scout interno di luglio (già in memoria, non ri-derivato) riportava "21-42K istanze esposte, 5.194 verificate vulnerabili, 93,4% con auth-bypass" per un batch CVE diverso. **Nessuna fonte primaria unificata trovata**: trattare come "centinaia di migliaia di istanze storicamente esposte in più ondate", non come cifra puntuale. Aggregati non-primari (`betterclaw.io`, "138 CVE totali... 15 CVSS≥8.0") citati solo come indicazione di scala, non verificati alla fonte.

### I tre conflitti

- **(a) Self-mod vs root-of-trust**: nessun meccanismo crittografico o immutabile a runtime. Il confine è "chi può scrivere sul filesystem dell'host" = trusted operator per definizione. Nessuna distinzione tra "config" e "root of trust" — sono la stessa cosa, protetta solo da permessi OS.
- **(b) Capability host vs input remoto non fidato**: è la storia stessa del progetto. Tre catene CVE indipendenti (WebSocket-gatewayURL, localhost-trust, token-scope-escalation) hanno tutte trasformato "un messaggio/richiesta non fidata" in "controllo amministrativo pieno o RCE". Enforcement kernel-level arrivato da **terzi** (ClawArmor, eBPF — già verificato dallo scout 07-16, non ri-derivato), non dal progetto stesso.
- **(c) Isolamento tenant/gruppi**: session-key namespacing per gruppo/canale/topic, allowlist-gated per sender sconosciuti, **nessuna condivisione cross-community di memoria documentata**.

### Traction (fetch diretto 2026-08-04, salvo indicato)

Stelle: **385.000**, fork: **80.900**, contributor: **700+** (visibili sulla pagina), linguaggio: TypeScript, licenza: MIT ([github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)). Progetto più stellato su GitHub in assoluto: ha superato React a 250.829 stelle il **2026-03-03** ([star-history.com/blog/openclaw-surpasses-linux-14th-most-starred](https://www.star-history.com/blog/openclaw-surpasses-linux-14th-most-starred/), citato). Numeri MAU/istanze (3,2M MAU, 500K+ istanze, dallo scout interno 07-16) non ri-verificati in questa passata — riportati con quella data.

---

## 2. Hermes Agent (Nous Research)

### Forma e UX

Tagline "the agent that grows with you." Lanciato **2026-02-25** ([startupfortune.com](https://startupfortune.com/hermes-agent-crosses-214000-github-stars-as-developers-abandon-commercial-ai-agent-frameworks/), citato — data di lancio), licenza MIT. Interfacce: CLI (riscritta React/Ink dalla v0.11 "Interface Release", 2026-04-23), Desktop nativo macOS/Linux/Windows dalla v0.16 "Surface Release" (2026-06-05), dashboard admin web, PyPI (`pip install`) dalla v0.14 (2026-05-16) — tutte date già verificate dallo scout interno 2026-06-16 (`2026-06-16-gap-competitors.md`), non ri-derivate. Config in `~/.hermes/config.yaml`; **scrittura protetta by design**: *"By default, the read-only run is the default mode; only an explicit --apply flag writes to config.yaml"* (ricerca su documentazione ufficiale, verificata incrociando con l'issue tracker ufficiale — [github.com/NousResearch/hermes-agent/issues/4775](https://github.com/NousResearch/hermes-agent/issues/4775)).

### Capability vere

- **Memoria**: `session_search` con speedup dichiarato 4500× (v0.15, già verificato scout interno). "Honcho" come concetto di "peer" con profili multipli condividono lo stesso workspace (ricerca, non fonte primaria diretta in questa passata — [NON VERIFICATO in profondità]).
- **Proattività/scheduling**: `tools/cronjob_tools.py` + `hermes_cli/cron.py` — schedule in linguaggio naturale o cron expr, `deliver` instrada l'output a un canale ("home channel" di default via `/sethome`), modalità `script` senza LLM (esegue e consegna stdout verbatim). Nota di auto-limitazione nel codice stesso: *"cron-run sessions should not recursively schedule more cron jobs"* + un revert esplicito (`revert(cron): remove per-job profile support #28124`) — il progetto ha **arretrato** complessità sul cron di recente (fonte: teardown interno `hermes_executive_loop_2026q2.md`, non ri-derivato).
- **Multi-canale**: `send_message` verso Telegram/Discord/Slack/Feishu, per nome o ID canale, sia in modo reattivo sia da cron `deliver`. Nessun reply-in-old-thread / conversation-reference (confermato invariato dal teardown interno).
- **Gruppi/multi-tenant**: il costrutto trovato è **"Profiles: Running Multiple Agents"** ([hermes-agent.nousresearch.com/docs/user-guide/profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles), citato da ricerca) — profili = configurazioni-agente separate, non scoping di gruppo/tenant nel senso di "un gruppo Telegram con membri non fidati isolato da un altro". **Non ho trovato in questa passata un equivalente del modello a session-key-per-gruppo di OpenClaw** [NON VERIFICATO se esista un meccanismo dedicato per "gruppo con sconosciuti"].
- **Controllo macchina**: terminal+process, fs read/write/patch/search, **12 primitive browser** incluse `browser_cdp` (deterministico, Chrome DevTools Protocol), `browser_vision`, `browser_dialog`, e `computer_use` — Hermes offre esplicitamente sia un percorso deterministico (CDP) sia uno vision-based, lasciando il secondo opt-in (fonte: teardown interno source-level, `toolsets.py`).
- **Lavoro sul proprio codice**: sì, capability nativa — `agent/coding_context.py` (PR #43316) espone un `RuntimeMode`/`ContextProfile` che collassa il toolset a un set coding-specifico, con snapshot git "baked once" nel prompt cache-stabile.
- **Deep research**: via `delegate_task` (fan-out a sub-agenti) + browser primitives + web search; non un modulo dedicato a sé come in Odysseus/Khoj.

### Architettura

Python. **Goal-loop** (`hermes_cli/goals.py`, giudice LLM ausiliario, fail-open su parse-failure, continuation iniettata come messaggio utente normale per non rompere il prompt-cache) e **kanban work-queue** (`~/.hermes/kanban.db`, 9 stati, claim CAS con TTL 15 min) — entrambi già deep-dived a livello di codice dagli scout interni, non ri-derivati qui. **Context compaction**: `agent/context_compressor.py` (3082 righe), trigger a soglia-token (50%, floor all'85% su finestre piccole), modello ausiliario separato per il summary, protezione head/tail, fail-abort esplicito su 401/403/errore-di-rete (mai un placeholder silenzioso in quel caso). **Formato skill = `SKILL.md`** con progressive disclosure (solo `description` nel prompt, corpo on-demand via `skill_view`).

**Conteggio skill/estensioni — due fonti in disaccordo, entrambe con data**:
- Catalogo **ufficiale** (fetch diretto 2026-08-04, [hermes-agent.nousresearch.com/docs/reference/skills-catalog](https://hermes-agent.nousresearch.com/docs/reference/skills-catalog)): **71 skill** in 13 categorie (Creative 16, Productivity 11, Software-development 10, GitHub 6, Research 6, Autonomous-AI-Agents 5, MLOps 5, Apple 4, Media 3, Email/Note-taking/Smart-home/Social-media 1 ciascuna). Nessuna data di release sulla pagina oltre "2026" nel copyright.
- Catalogo **community-curato** taggato v0.17.0 ([github.com/ZeroPointRepo/awesome-hermes-skills](https://github.com/ZeroPointRepo/awesome-hermes-skills)): "72 built-in + 101 optional bundled skills + 85 community skills" ≈ 258 totali, più l'integrazione con browse.sh (200+ file SKILL.md per browser-automation sito-specifica di Browserbase).
La discrepanza (71 ufficiali vs ~258 nel tracker community) non è riconciliata in questa passata.

### Sicurezza

**CVE-2026-9368** — sandbox escape → RCE in `tools/code_execution_tool.py` (`execute_code`): l'implementazione originale usava "a temporary directory and the system's Python executable" come sandbox, giudicata insicura; permetteva l'escape dall'ambiente isolato. Colpisce versioni **precedenti alla 0.11.0**; pubblicata **2026-05-24** (aggiornata 2026-07-23), CVSS 4.0 base, EPSS 30,55%, **PoC pubblico disponibile**. Fix: due modalità `strict` (legacy, comportamento insicuro mantenuto per retrocompatibilità) e `project` (nuovo default, esegue nella directory di progetto con l'ambiente Python configurato dall'utente) — **fix già shippato con la 0.11.0 (2026-04-23), la CVE è stata assegnata/pubblicata un mese DOPO** (fonte: [miggo.io/vulnerability-database/cve/CVE-2026-9368](https://www.miggo.io/vulnerability-database/cve/CVE-2026-9368), fetch diretto 2026-08-04). Questo colloca la "onestà preliminare: zero P0/P1 al rilascio v0.18" dello scout interno di luglio come corretta PER quella release specifica, ma non significa che il progetto sia stato esente da CVE nella sua storia — lo è stato, prima, e patchato.

**Bug di root-of-trust documentato (non malevolo, ma rilevante)**: issue ufficiale *"Hermes rewrites raw config.yaml with expanded defaults and resolved env secrets"* ([github.com/NousResearch/hermes-agent/issues/4775](https://github.com/NousResearch/hermes-agent/issues/4775)) — comandi che cambiano la config possono silenziosamente riscrivere l'intero file invece di aggiornare solo le chiavi di competenza, esponendo secret risolti in chiaro nel file riscritto.

**Approval (Tirith)**, già deep-dived internamente: comandi puliti non richiedono mai conferma; comandi flaggati passano a un classificatore LLM ausiliario (temp 0, 16 token, APPROVE/DENY/ESCALATE) con auto-grant a livello sessione sul pattern esatto; `write_file`/`patch` controllati contro denylist+sandbox PRIMA di toccare il disco, blocco senza prompt di conferma e "no way to override from the chat UI" (ricerca su documentazione, coerente col teardown interno). `DELEGATE_BLOCKED_TOOLS` impedisce ai sub-agenti la delega ricorsiva, la modifica di memoria, l'invio messaggi, l'esecuzione di codice; `max_spawn_depth=2` esplicito.

### I tre conflitti

- **(a) Self-mod vs root-of-trust**: config.yaml è **read-only by default**, richiede `--apply` esplicito per essere scritto da comando CLI; le approvazioni "always" persistono nel config.yaml e da quel momento si **auto-approvano silenziosamente per sempre** (nessuna scadenza/ri-conferma trovata — potenziale rischio di deriva). Nessun file "immutabile" separato dal config mutabile: il confine è procedurale (serve un flag o un'approvazione umana una tantum), non strutturale.
- **(b) Capability host vs input remoto**: `DELEGATE_BLOCKED_TOOLS` + `max_spawn_depth` sono barriere concrete lato sub-agente; la CVE-2026-9368 mostra però che la barriera "sandbox" può essere insufficiente per il tool più diretto (`execute_code`) fino a quando non è stata rinforzata.
- **(c) Isolamento tenant/gruppi**: nessun equivalente trovato del modello a session-key di OpenClaw; "Profiles" sono agenti-configurazione separati, non tenant di uno stesso agente condiviso.

### Traction (dati con fonte e data)

**~214.000-220.000 stelle** a fine luglio 2026 (TechCrunch [2026-07-13](https://techcrunch.com/2026/07/13/hermes-agent-maker-nous-research-in-talks-for-new-funding-at-1-5b-valuation/) parla di ~214K; altra fonte aggregata riporta ~220K "late July 2026"), **~39.700-40.000 fork**, **321 contributor** (al rilascio del 2026-05-28, per ricerca aggregata su GitHub contributors graph). Round di funding **in chiusura a valutazione $1,5B** (Robot Ventures + USV capofila, raccolta ≥$75M — TechCrunch 2026-07-13, stessa fonte). Cadenza release: 8+ release nominate tra aprile e luglio 2026 (v0.10→v0.18+), circa bisettimanale (già verificato dettagliatamente dallo scout interno 06-16, tabella non ripetuta qui).

---

## 3. Goose (Block → Agentic AI Foundation)

### Forma e UX

Nato come "codename goose" dentro Block (Square/Cash App). Data di lancio pubblico **non univoca tra le fonti, sempre nel 2025**: l'annuncio ufficiale Block ("Block Open Source Introduces 'codename goose'") è datato da una fonte secondaria **2025-01-28**, con un'altra fonte che colloca l'inizio del progetto interno a fine 2024 — in ogni caso NON 2026. Correggo qui esplicitamente perché una bozza precedente di questa sezione riportava erroneamente "2026-01-25": il lancio è del **2025**, non del 2026. Donato alla neonata **Agentic AI Foundation (AAIF)** sotto Linux Foundation, annuncio **2025-12-09** ([linuxfoundation.org/press/...](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation), citato), insieme a MCP (Anthropic) e AGENTS.md (OpenAI); membri platinum: AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI. Post ufficiale del passaggio: "goose has a new home - the Agentic AI Foundation (AAIF)", **2026-04-07** ([goose-docs.ai/blog/2026/04/07/goose-moves-to-aaif](https://goose-docs.ai/blog/2026/04/07/goose-moves-to-aaif/)). Repository ora sotto `github.com/aaif-goose/goose` (era `block/goose`).

Onboarding: script one-liner `curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash`, oppure app desktop nativa (macOS/Linux/Windows), oppure wizard `goose configure` per aggiungere provider/estensioni (fetch diretto [github.com/aaif-goose/goose](https://github.com/aaif-goose/goose), 2026-08-04).

### Capability vere — e una distinzione di categoria importante

**Goose non è, nella sua forma dominante, un "agente personale che vive nelle chat app e parla per primo"** — è un harness di coding/task general-purpose (si posiziona esplicitamente contro Claude Code e Aider), invocato per sessione come un CLI tool, non un servizio always-on che notifica.

> **[SUPERATO IN PARTE — 2026-08-27]** Vero al fetch del 2026-08-04, non più intero oggi. Il listing di `crates/goose/src/` contiene ora un modulo `gateway/` con dentro `handler.rs`, `manager.rs`, `pairing.rs` e **`telegram.rs`**: cioè la forma di un agente personale, connettore di chat e pairing compresi. Il verso del movimento conta più della singola frase — è verso di noi. Prove e listing in [`gateway-e-client-2026-08-27.md`](gateway-e-client-2026-08-27.md) §2.

- **Memoria**: esiste come **estensione opt-in** ("Memory" tra le estensioni built-in elencate in `goose configure`), non come architettura core cablata — diversa impostazione rispetto a Letta/Muffin dove la memoria è sostrato. [NON VERIFICATO in profondità il meccanismo interno dell'estensione Memory in questa passata].
- **Proattività**: **scheduler + recipes** — le recipes sono file YAML che impacchettano istruzioni+tool+goal in un'unità riusabile, eseguite via cron ("automated sessions that run recipes at specified intervals without user interaction" — [deepwiki.com/aaif-goose/goose/4-recipes-and-scheduling](https://deepwiki.com/aaif-goose/goose/4-recipes-and-scheduling), citato). Questo è **automazione a schedule fisso**, non una soglia appresa di "quando interrompere l'utente" — categoria diversa dalla proattività di Muffin/Khoj. Il daemon **`goosed`** usa un Agent condiviso per le sessioni interattive e un Agent fresco per ogni run schedulato (stessa fonte) — la persistenza di processo esiste, l'iniziativa comportamentale no. **[DA RIVERIFICARE — 2026-08-27]**: nel listing di `crates/` di oggi **non esiste un crate `goose-server`**, e `goosed` non compare come crate. Non è una prova di rimozione — il binario può essersi spostato — e la ricerca codice di GitHub che direbbe di no è inaffidabile su questo repo (misurato: risponde `0` anche per `AgentManager`, che il 04/08 era stato verificato da codice). Vedi [`gateway-e-client-2026-08-27.md`](gateway-e-client-2026-08-27.md) §0 e §2.
- **Multi-canale**: nativamente CLI + Desktop + API. Integrazione **Slack**: esiste un crate dedicato `goose-slackbot` (Socket Mode, nessun URL pubblico richiesto) descritto in una **Discussion** GitHub ([github.com/aaif-goose/goose/discussions/7075](https://github.com/aaif-goose/goose/discussions/7075)) e un issue collegato (`#3125` "Slack Extension for Goose") — **stato di merge non confermato in questa passata** [NON VERIFICATO se sia una feature shippata di default o un contributo community in corso].
- **Gruppi/multi-tenant**: nessuna evidenza trovata di un concetto di "gruppo/community" — il modello è single-operator/per-sessione.
- **Controllo macchina**: due percorsi distinti — (1) estensione **"Developer"** (attiva di default): shell+fs, il nucleo dell'harness di coding; (2) estensione **"Computer Controller"**, ricostruita su **Peekaboo** (tool CLI macOS per screen-capture e GUI-automation via API di accessibilità di macOS): "goose takes an annotated screenshot of an app where every clickable element gets a labeled ID like B1, B2, T1; goose clicks on an element by its ID" ([goose-docs.ai/blog/2026/04/29/computer-controller-peekaboo](https://goose-docs.ai/blog/2026/04/29/computer-controller-peekaboo/), citato) — **esplicitamente solo macOS**.
- **Lavoro sul proprio codice**: è il caso d'uso primario e dichiarato del progetto.
- **Deep research**: non un modulo dedicato nominato; capability generica via estensioni web-search.

### Architettura

**Rust** (motivazione dichiarata: performance/portabilità). Modello di estensione: **Model Context Protocol nativo** — qualunque server MCP è collegabile; "70+ extensions" è la cifra ricorrente in fonti secondarie multiple ma **non ho trovato una pagina di registry primaria con conteggio esatto e data** — la doc ufficiale (`/docs/getting-started/using-extensions/`, fetch 2026-08-04) rimanda a "a central directory of extensions" senza mostrare un totale sulla pagina stessa. Trattare "70+" come approssimativo, non contato. **15+ provider di modelli** (Anthropic, OpenAI, Google, Ollama, Azure, Bedrock) più supporto **ACP** per usare un abbonamento consumer esistente invece di una chiave API a consumo.

### Sicurezza

**Nessuna CVE con numero verificato per Goose in questa passata.** Trovati solo: (a) un'affermazione secondaria isolata su "Goose 1-Click RCE" (Veria Labs, non fetchata a fondo in questo budget — [NON VERIFICATO]); (b) una policy CORS wildcard (`Access-Control-Allow-Origin: *`) segnalata da fonte secondaria come rischio; (c) un fatto confermato dalla **documentazione ufficiale stessa**: *"The agent runs directly on the host with the user's full permissions"* — nessun sandbox di default; Goose Desktop offre un **sandbox macOS opzionale** che l'utente deve abilitare esplicitamente ([goose-docs.ai/docs/guides/sandbox/](https://goose-docs.ai/docs/guides/sandbox/), citato).

### I tre conflitti

- **(a) Self-mod vs root-of-trust**: nessuna evidenza trovata di auto-modifica del proprio prompt/config a runtime — le recipes sono autorate dall'utente, non dall'agente durante l'esecuzione [NON VERIFICATO oltre questo].
- **(b) Capability host vs input remoto**: largamente **non ancora un problema live** per Goose, perché il canale multi-utente non fidato (Slack) non è confermato come shippato di default; il modello resta single-operator/locale.
- **(c) Isolamento tenant/gruppi**: non applicabile — nessun concetto di gruppo trovato.

### Traction (fetch diretto 2026-08-04)

Stelle: **52.200**, fork: **5.900**, linguaggio: Rust, licenza: Apache-2.0 ([github.com/aaif-goose/goose](https://github.com/aaif-goose/goose)). "500+ contributor" riportato da fonte secondaria aggregata, non ri-verificato sulla pagina stessa in questo fetch [NON VERIFICATO il numero esatto]. Età: ~1 anno e mezzo (lancio inizio 2025) alla data di questo report.

---

## 4. OpenHarness (HKUDS) + ohmo

### Forma e UX

Harness agentico Python, dichiarato per "clarity, hackability, and compatibility with Claude-style workflows" — esplicitamente concepito perché ricercatori/builder capiscano come funzionano gli agenti di produzione "under the hood". **ohmo** è l'agente personale costruito sopra: "chats in Feishu / Slack / Telegram / Discord, and can fork branches, write code, run tests, and open PRs on its own", e — dato notevole — **"runs on your existing Claude Code or Codex subscription — no extra API key needed"** ([github.com/HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness), fetch 2026-08-04). Questo significa che ohmo non chiama direttamente un'API a consumo: si appoggia a un abbonamento consumer di un altro harness (Claude Code / Codex) — una scelta economica/di-ToS distinta da tutti gli altri sistemi coperti in questo report [implicazioni ToS non verificate in questa passata, segnalo solo il design].

Onboarding: script bash one-liner (`curl -fsSL .../scripts/install.sh | bash`), PowerShell su Windows, o `pip install openharness-ai` (fetch diretto, stessa fonte).

### Capability vere

- **Memoria**: esplicitamente allineata alle convenzioni Claude Code — **"CLAUDE.md Discovery & Injection"**, **"MEMORY.md Persistent Memory"**, **"Context Compression (Auto-Compact)"**, **"Session Resume & History"** (README, fetch diretto). Architettura interna del meccanismo di compressione non approfondita in questa passata [NON VERIFICATO oltre l'elenco delle feature dichiarate].
- **Proattività**: nessun meccanismo di "decide quando parlare per primo" documentato distintamente dall'essere invocato in chat [NON VERIFICATO].
- **Multi-canale**: Feishu, Slack, Telegram, Discord (per ohmo specificamente).
- **Gruppi/multi-tenant**: [NON VERIFICATO — nessuna documentazione trovata su isolamento multi-tenant per i bridge di ohmo; il framing "your existing subscription" suggerisce design single-operator, come Hermes/OpenClaw/Goose].
- **Controllo macchina / lavoro sul proprio codice**: ohmo "forks branches, write code, run tests, and open PRs on its own" — capability nativa e dichiarata come il caso d'uso centrale (non periferico).
- **Deep research**: [NON VERIFICATO — non trovato un modulo dedicato nominato in questa passata].

### Architettura

Python, MIT. **10 sottosistemi dichiarati**: engine (agent loop), tools (**43+**), skills, plugins, permissions, hooks (lifecycle events), commands (**54** totali), MCP (client protocollo), memory, tasks, coordinator (multi-agente), prompts, config, UI (README, fetch diretto 2026-08-04). Nessun conteggio di un "registry" pubblico di skill/plugin di terze parti trovato in questa passata (a differenza di ClawHub/Hermes-catalog) [NON VERIFICATO se esista un marketplace pubblico con conteggio].

### Sicurezza

Permission model dichiarato: **"Multi-Level Permission Modes"**, **"Path-Level & Command Rules"**, hooks, **"Interactive Approval Dialogs"** (README, fetch diretto) — vocabolario analogo a quello di Claude Code stesso, ma la meccanica di enforcement esatta non è stata verificata a livello di codice in questa passata. **Nessun CVE o incidente pubblico trovato** in questa ricerca [NON VERIFICATO se il progetto sia genuinamente senza incidenti o semplicemente meno scrutinato di OpenClaw/Hermes/Khoj, dato il profilo pubblico più basso — 15,2K stelle contro le centinaia di migliaia degli altri].

### I tre conflitti

- **(a) Self-mod vs root-of-trust**: [NON VERIFICATO in questa passata].
- **(b) Capability host vs input remoto**: multi-canale (Feishu/Slack/Telegram/Discord) implica superficie di input non fidato paragonabile a OpenClaw/Hermes, ma senza una documentazione equivalente trovata sul come viene contenuta [NON VERIFICATO].
- **(c) Isolamento tenant/gruppi**: [NON VERIFICATO].

### Traction (fetch diretto 2026-08-04)

Stelle: **15.200**, fork: **2.500**, watcher: **86**, licenza: MIT, linguaggio: Python ([github.com/HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness)). Età/data di creazione del repo: [NON VERIFICATO in questa passata — non reperita].

---

## 5. Odysseus (pewdiepie-archdaemon)

> Deep-dive source-level già fatto internamente (781 file Python letti, giugno 2026): `.claude/agent-memory/research-scout/competitor_odysseus_deep_dive.md`. Qui: freshness update + sintesi per il confronto, non ri-derivazione.

### Forma e UX

"Self-hosted AI workspace for chat, agents, research, documents, email, notes, calendar, and local model workflows" — costruito da Felix Kjellberg ("PewDiePie") sotto l'handle `pewdiepie-archdaemon`, shippato **2026-05-31** (README, fetch diretto 2026-08-04). Deploy via Docker, installazione nativa anche per Windows/macOS. Interfaccia = web UI + PWA (non un bot di chat come primaria).

### Capability vere (sintesi da deep-dive interno)

- **Memoria — punto debole dichiarato**: `services/memory/memory_extractor.py` usa ChromaDB+fastembed ONNX, **massimo 2 fatti per conversazione**, 6 categorie, dedup Jaccard(0.6)+vettoriale(0.72). **Nessun evidence count, nessun decadimento di confidenza, nessun modello temporale/bitemporale, nessuna memoria episodica.** Il codice stesso ammette il dolore: una collection ChromaDB condivisa **senza metadata di owner** ha causato leak di memoria cross-tenant, patchati con fallback a predicati-owner.
- **CalDAV read+write — punto di forza**: `caldav_sync.py`+`caldav_writeback.py`, hardening SSRF esplicito (blocco loopback/link-local/IP privati, ri-validazione DNS ad ogni A/AAAA contro DNS-rebinding, `max_redirects=0`), idempotenza via UID VEVENT, "prune-on-clean-read" (non cancella eventi locali se una qualunque lettura remota è fallita), core a funzioni pure testabili senza rete.
- **Scheduler + event-bus**: `task_scheduler.py`+`event_bus.py` — due tipi di trigger (cron via croniter, o evento con soglia: `fire_event("memory_added")` incrementa un contatore che allo scatto della soglia lancia una task di consolidamento), persistente a restart, esecuzione seriale (Semaphore(1)), recovery di worker "zombie" all'avvio. **L'astrazione generica più vicina a un "dream-cycle" trovata in tutto questo survey** — un bus dichiarativo invece di demoni cablati a mano.
- **Outward/HITL**: le risposte email auto-generate restano **draft** (mai inviate senza intervento umano) — allineato al pattern draft-by-default; MA per l'utente admin/primario, `send_email`/`manage_calendar` sono **auto-fire** (bloccati solo per i non-admin via `NON_ADMIN_BLOCKED_TOOLS`) — nessuna conferma umana per-azione sulle azioni outward dell'utente primario.
- **Deep research**: modalità dedicata e nominata (plan→search→synthesize→self-terminate), costruita su Tongyi DeepResearch (deep-dive interno).

### Architettura

Monolite modulare: un solo processo FastAPI (`app.py`, 1145 righe) con 54 router in `routes/`; **781 file .py**; un solo DB SQLite (SQLAlchemy) + ChromaDB come servizio HTTP separato per i vettori. Loop agente = protocollo a blocchi di codice fenced (stile CodeAct), non native tool-calling OpenAI. Routing multi-modello via catene di fallback role-based.

### Sicurezza

`THREAT_MODEL.md` **nel repository stesso** — confine di trust esplicito ("trattalo come una console admin"), gap noti elencati (incluso "no shell sandbox", issue #1058, al momento della lettura interna). Secret at-rest cifrati (Fernet, prefisso `enc:`, idempotente su re-encrypt). **Untrusted-context wrapper**: ogni contenuto esterno — inclusi le **proprie memorie e skill** — è wrappato come untrusted con escape anti-breakout del delimitatore. Plan-mode fail-closed: l'allowlist è calcolata come `(tutti i tool noti ∪ mutator noti) − allowlist`, così un import di schema fallito non può lasciare un mutator abilitato per errore. **Nessun CVE pubblico trovato per Odysseus in questa passata** — dato il profilo (progetto guidato da una singola figura pubblica, non un'azienda con un programma di disclosure formale come Nous Research), l'assenza di CVE registrate non equivale necessariamente ad assenza di vulnerabilità: significa assenza di un processo di disclosure osservato dall'esterno [segnalo la distinzione esplicitamente].

### I tre conflitti

- **(a) Self-mod vs root-of-trust**: **teacher-escalation loop** (`teacher_escalation.py`) — quando un modello "studente" self-hosted fallisce un turno, un endpoint "teacher" più forte produce sia una risposta correttiva sia un nuovo `SKILL.md`, **persistito solo se la risposta del teacher supera lo stesso eval di regex** usato per rilevare il fallimento originale; guardia esplicita anti-injection-di-secondo-ordine sul trace del fallimento (per evitare che un'iniezione in un tool output venga distillata in una skill che lo studente poi obbedisce). È un meccanismo di auto-estensione **gated**, non un self-mod libero del codice/config core.
- **(b) Capability host vs input remoto**: l'untrusted-context wrapper copre esplicitamente anche memoria/skill proprie, non solo input esterno diretto — postura più esplicita di molti peer su questo fronte specifico, ma il gap dichiarato dal progetto stesso (`no shell sandbox`) resta un varco aperto se un input non fidato riuscisse a far emettere un comando shell.
- **(c) Isolamento tenant/gruppi**: esiste uno scoping owner/admin vs non-admin nel codice, ma il deep-dive interno lo classifica esplicitamente come "pure overhead" per il caso d'uso a singolo-proprietario che il progetto sembra realmente servire — presente ma non il centro del design.

### Traction

**Fetch diretto 2026-08-04** ([github.com/pewdiepie-archdaemon/odysseus](https://github.com/pewdiepie-archdaemon/odysseus)): **84.600 stelle**, 292 fork, 931 issue aperte, licenza **AGPL-3.0-or-later**, Python, 1.975 commit sul branch `dev`. Crescita: shippato 2026-05-31, ~62K stelle nella prima settimana (fonte secondaria, [ossinsight.io](https://ossinsight.io/analyze/pewdiepie-archdaemon/odysseus) + descrizione YouTube citata). **Nota di incongruenza**: il deep-dive interno datato 2026-06-11 riportava "~22K stelle" — un numero nettamente inferiore sia al "~62K alla prima settimana" di fonti esterne sia agli 84,6K di oggi. Non posso riconciliare la discrepanza in questa passata: la segnalo invece di sovrascriverla silenziosamente.

---

## 6. HumanLayer / CodeLayer

### Stato

Repository principale (`github.com/humanlayer/humanlayer`) con descrizione che recita **"pretty much all deprecated"**, rimanda a un rebuild su `humanlayer.com` (ricerca aggregata, fetch non diretto in questa passata). Attività commit fino al **2026-06-30**, issue/PR aperte fino a fine luglio 2026 — **non è un repository morto**, ma è stato esplicitamente superato/redirected, non più il punto d'ingresso raccomandato. Conferma la diagnosi già fatta dallo scout interno 07-16 ("abbandono di fatto del personal-agent space, pivot a CodeLayer IDE").

Il manifesto **12-Factor Agents** ([github.com/humanlayer/12-factor-agents](https://github.com/humanlayer/12-factor-agents)) resta citato indipendentemente nel 2026 — indicizzato da DeepWiki il **2026-03-22**, citato in un framework "AI-DLC 2026" più recente. Fattore 7 ("contact humans with tool calls: HITL as just another async tool") e Fattore 6 (launch/pause/resume via API semplici) restano i più ripresi. Non è più un prodotto attivamente sviluppato per il caso d'uso "personal agent" — è un documento di pattern, non un competitor vivo in questo spazio.

---

## 7. Letta (ex-MemGPT)

> Architettura di memoria (v1-agent loop change vs MemFS/Context-Repositories, tassonomia "tre scuole") già deep-dived internamente in `.claude/agent-memory/research-scout/2026-07-06-memory-moat-sota.md` — non ri-derivata. Qui: onboarding/traction/sicurezza/multi-tenant, non coperti prima.

### Forma e UX

"Platform for stateful agents: AI with advanced memory that can learn and self-improve over time" ([github.com/letta-ai/letta](https://github.com/letta-ai/letta), fetch 2026-08-04). Due prodotti distinti sotto lo stesso brand: **Letta** (server/ADE, piattaforma agenti stateful generici) e **`letta-code`** (CLI Node.js, agente coding-first che "can take actions on your local computer").

Onboarding server: `docker run -d --name letta-server -v ~/.letta/.persist/pgdata:/var/lib/postgresql/data -p 8283:8283 -e ANTHROPIC_API_KEY="sk-ant-..." letta/letta:latest`, poi connessione via **ADE** (Agent Development Environment, GUI web) puntata a `http://localhost:8283` (ricerca su documentazione ufficiale docs.letta.com). Variante Docker Compose con 3 servizi (`letta_db`/`letta_server`/`letta_nginx`). **Vincolo di sicurezza del browser documentato esplicitamente**: l'ADE accetta `http` solo per `localhost`; per host remoti richiede `https` obbligatoriamente, bloccato del tutto su Safari e Chrome recenti se non-localhost-http. Onboarding CLI: `npm install -g @letta-ai/letta-code` (richiede Node.js 22.19+), poi `letta`.

### Capability vere

- **Memoria**: il differenziatore storico del progetto (da MemGPT). Tre livelli — core (RAM, sempre nel prompt), recall (cronologia conversazionale ricercabile), archival (storage a lungo termine via tool-call). Self-editing tramite tool (`core_memory_replace`/`core_memory_append`). **Flag `read_only` sui blocchi di memoria** — un operatore può marcare un blocco come non-modificabile-dall'agente: è il **primitivo di immutabilità parziale più pulito trovato in tutto questo survey**, anche se limitato al livello memoria (non al system-prompt/config generale). **MemFS/"Context Repositories"** (2026-03-16, già verificato internamente): la memoria proiettata come file markdown in un repo git, modificata con tool fs/bash generici invece di un tool di memoria dedicato, commit obbligatorio per rendere effettiva una modifica — esplicitamente pensato per **agenti di coding** (merge multi-subagente via git), non per un modello-di-persona generico.
- **Proattività/scheduling**: [NON VERIFICATO — nessun meccanismo "decide di parlare per primo" trovato distinto dall'essere invocato].
- **Multi-canale**: l'agente Letta gira "locally, via desktop app, or through channels like Slack" (ricerca su doc ufficiale, non approfondito oltre) [NON VERIFICATO il dettaglio dei connector].
- **Gruppi/multi-tenant**: **"Conversations"** — più sessioni utente concorrenti possono condividere la memoria che accumula un unico agente ("Conversations make it much simpler to support many end-users without having to create individual agents for every user"); l'alternativa dichiarata per isolamento è **creare un agente separato per tenant** ([letta.com/blog/conversations](https://www.letta.com/blog/conversations/), citato da ricerca). **Granularità binaria**: o un agente per tenant (isolamento pieno) o Conversations condivise sullo stesso agente (nessun isolamento) — non ho trovato una via di mezzo documentata (es. memoria condivisa con redazione per-tenant).
- **Controllo macchina**: solo nel prodotto **`letta-code`** (framing coding-agent); il server/ADE core non è descritto come agente di controllo macchina generico.
- **Multi-agente**: tool nativi di cross-agent messaging + blocchi di memoria condivisibili tra agenti.

### Architettura

Python (server), Node.js (CLI `letta-code`), Apache-2.0. Storage: PostgreSQL (vista nel comando docker run). Modello-agnostico dichiarato, con leaderboard di modelli proprio (`leaderboard.letta.com`, non verificato in questa passata).

### Sicurezza

**Nessun CVE trovato per Letta in questa ricerca** [NON VERIFICATO se assenza reale o sotto-scrutinio]. Chiarimento importante (già in memoria interna, ribadito): il cambio **`letta_v1_agent`** (2025-10-14) — deprecazione di heartbeat e del tool `send_message` a favore di reasoning nativo — è un **cambio di loop**, non di sicurezza né di memoria; va tenuto distinto da MemFS (cambio di memoria, marzo 2026), perché fonti secondarie li confondono.

### I tre conflitti

- **(a) Self-mod vs root-of-trust**: `read_only` sui blocchi di memoria è l'unico meccanismo di immutabilità-parziale pulito trovato in questo survey — ma è opt-in (l'operatore deve marcarlo) e scoped alla sola memoria, non a un concetto più ampio di "config core" o "system prompt".
- **(b) Capability host vs input remoto**: non centrale per il prodotto Letta core (non è un agente di controllo macchina); diventa rilevante specificamente per `letta-code` (coding-agent), dove non ho trovato in questa passata un modello di permessi dedicato paragonabile a quello di Hermes/OpenClaw [NON VERIFICATO].
- **(c) Isolamento tenant/gruppi**: granularità binaria (agente-per-tenant vs Conversations-condivise-senza-isolamento) — nessuna via di mezzo trovata.

### Traction (fetch diretto 2026-08-04)

Stelle: **24.100**, fork: **2.600**, watcher: **138**, issue aperte: 26, PR aperte: 23, licenza Apache-2.0, Python ([github.com/letta-ai/letta](https://github.com/letta-ai/letta)). Fonti secondarie aggregate riportano "23K+ stelle, 2.400+ fork, 100+ contributor" a metà 2026 — ordine di grandezza coerente col fetch diretto, contributor-count non ri-verificato sulla pagina primaria.

---

## 8. Khoj

### Forma e UX

"Your AI second brain. Self-hostable." Backend **FastAPI + Django**, storage **PostgreSQL + pgvector** per gli embedding (ricerca aggregata su architettura, non un unico documento primario) ([github.com/khoj-ai/khoj](https://github.com/khoj-ai/khoj), fetch 2026-08-04). Licenza **AGPL-3.0** (non GPL-3 come riportato da una fonte secondaria di ricerca iniziale — corretto sul fetch diretto).

Onboarding: self-host via Docker/macOS/Linux/Windows (`docs.khoj.dev/get-started/setup/`), oppure cloud hosted (`app.khoj.dev`). **Default a singolo utente**: la modalità self-hosted parte in `--anonymous-mode` (nessun login richiesto) — comportamento di default per setup locali single-user. Per multi-utente: **si deve rimuovere esplicitamente `--anonymous-mode`** e configurare autenticazione via **Magic Links** (via integrazione Resend, o invio manuale del link) o **Google OAuth**; pannello admin a `/server/admin` per generare manualmente un link di login per un utente (ricerca su documentazione ufficiale docs.khoj.dev, fetch non diretto in questa passata ma incrociata su più pagine coerenti). Alla prima esecuzione del comando di setup viene richiesto di creare un account admin.

### Capability vere

- **Memoria**: storico conversazionale per personalizzazione + **agenti custom** (persona+conoscenza+tool+modello, uno per ruolo) creabili dall'utente; una directory pubblica di agenti condivisi è dichiarata "in arrivo" con revisione manuale pre-pubblicazione — **non ancora quantificabile** [NON VERIFICATO conteggio, feature non ancora lanciata al momento della ricerca].
- **Proattività**: la più esplicitamente "proattiva" tra i sistemi coperti nel senso di iniziativa schedulata — **"personal newsletters"** (ricerca schedulata su un argomento + consegna di un riassunto) e **"smart notifications"** (trigger configurati dall'utente); resta però configurazione esplicita dell'utente (schedule/trigger dichiarati), non una soglia appresa di "quando interrompere".
- **Multi-canale**: browser, plugin Obsidian, Emacs, desktop, telefono, **WhatsApp**.
- **Gruppi/multi-tenant**: sì, autenticazione multi-utente reale (Magic Links/OAuth) — ma il modello è "molti utenti indipendenti di UNA istanza" (tipo SaaS single-tenant-per-utente), **non** "un gruppo Telegram/Discord con una sotto-memoria condivisa isolata" nel senso in cui lo intende OpenClaw o il modello community del brief MuffinOS — forma di multi-tenancy materialmente diversa.
- **Controllo macchina**: **nessuna evidenza trovata** di shell/fs/process-tool in nessuna fonte controllata in questa passata — Khoj è un assistente di retrieval+chat+automazione, non un agente di controllo macchina.
- **Deep research**: modulo esplicitamente nominato ("Scheduled Research"/deep research) tra le feature core.
- **Lavoro sul proprio codice**: non un caso d'uso descritto.

### Architettura

Python (FastAPI+Django), PostgreSQL+pgvector, containerizzato Docker (deploy Kubernetes menzionato per scala). Nessun registry di skill/plugin di terze parti con conteggio trovato — gli "agenti" sono creati dall'utente/community, non un ecosistema di estensioni installabili in senso MCP/ClawHub.

### Sicurezza

Due CVE verificate su database di vulnerabilità primari:

- **CVE-2025-69207**: IDOR/auth-bypass — l'endpoint di callback OAuth Notion accetta qualunque UUID utente senza verificare che il flusso OAuth sia stato avviato da quell'utente → un attaccante può dirottare l'integrazione Notion di una vittima, sostituendo la sua configurazione con la propria, con conseguente **data poisoning dell'indice di ricerca della vittima**. Fix in **2.0.0-beta.23** ([sentinelone.com/vulnerability-database/cve-2025-69207](https://www.sentinelone.com/vulnerability-database/cve-2025-69207/), [tenable.com/cve/CVE-2025-69207](https://www.tenable.com/cve/CVE-2025-69207)).
- **CVE-2026-13508**: incorrect authorization via manipolazione dell'argomento `conversation.agent` nel Conversation Sharing Handler, fino alla versione **2.0.0-beta.28**, severità **medium**, fix in una PR pendente al momento della disclosure, nessuna versione patchata confermata in questa passata ([radar.offseq.com/threat/cve-2026-13508...](https://radar.offseq.com/threat/cve-2026-13508-incorrect-authorization-in-khoj-ai--2f830a8514282fd0), citato).

**Osservazione**: entrambe le CVE trovate per Khoj sono fallimenti di **isolamento tra account/tenant** (l'esatto conflitto (c) di questo report), non fallimenti di "input non fidato che raggiunge un'azione di sistema" — coerente col fatto che Khoj non ha una superficie di controllo macchina da compromettere.

### I tre conflitti

- **(a) Self-mod vs root-of-trust**: [NON VERIFICATO — nessuna evidenza di auto-modifica a runtime; gli agenti custom sono autorati dall'utente].
- **(b) Capability host vs input remoto**: largamente non applicabile — nessuna superficie di controllo macchina trovata da compromettere.
- **(c) Isolamento tenant/gruppi**: le due CVE trovate sono ENTRAMBE su questo asse specifico — autenticazione multi-utente reale ma con bug di boundary-tra-account già shippati e patchati due volte.

### Traction (fetch diretto 2026-08-04)

Stelle: **36.200**, fork: **2.300**, licenza AGPL-3.0 ([github.com/khoj-ai/khoj](https://github.com/khoj-ai/khoj)). Età del progetto: [NON VERIFICATO in questa passata — non reperita la data di creazione del repo; Khoj è tra i progetti pre-esistenti alla "ondata" di agenti personali 2026, a giudicare dal fatto che ha già raggiunto beta 2.0.0 con più decine di release beta].

---

## 9. Archeologia del nome "OS" in ambito AI/agentico

### La linea genealogica verificata

1. **Karpathy, "LLM OS" (informale, mai un paper)** — prima formulazione **settembre 2023** (tweet virale, [x.com/karpathy/status/1707437820045062561](https://x.com/karpathy/status/1707437820045062561)), poi versione dettagliata con "specifiche" mock **novembre 2023**: *"LLM OS. Bear with me I'm still cooking. Specs: - LLM: OpenAI GPT-4 Turbo 256 core (batch size) processor @ 20Hz (tok/s) - RAM: 128Ktok - Filesystem: Ada002"* ([x.com/karpathy/status/1723140519554105733](https://x.com/karpathy/status/1723140519554105733)). Framing esplicitamente informale ("bear with me, I'm still cooking") — mai proposto come architettura tecnica formale, ma diventato il riferimento più citato per l'inquadramento "agente-come-OS" negli anni successivi.
2. **MemGPT, "Towards LLMs as Operating Systems" (arXiv 2310.08560, ottobre 2023)** — la prima formalizzazione **peer-reviewed** e tecnicamente specifica dell'analogia, ma **scoped a UN meccanismo**: la memoria virtuale. Context window = RAM; due store esterni (recall/archival) = disco; funzioni per spostare dati tra i due, ispirate esplicitamente alla virtual memory dei sistemi operativi classici. **Non** una rivendicazione che l'intero sistema sia un OS — solo che UN suo componente (la gestione della memoria) lo è per analogia. Il progetto discendente, **Letta**, ha abbandonato "OS" dal proprio nome/posizionamento dopo il rebrand (fatto già noto, coerente con l'assenza di "OS" in tutta la documentazione Letta consultata in questo report).
3. **AIOS, "LLM as OS, Agents as Apps" (arXiv 2312.03815, dicembre 2023; poi accettato COLM 2025)** — il tentativo più letterale e completo: LLM-come-kernel, agenti-come-processi, con componenti espliciti di scheduling/context-switching/gestione-memoria ([agiresearch/AIOS](https://github.com/agiresearch/AIOS)). **Ricezione su Hacker News** (thread [news.ycombinator.com/item?id=39964084](https://news.ycombinator.com/item?id=39964084), verificato via fetch diretto 2026-08-04): scetticismo tecnico puntuale, non un attacco frontale — un commento: *"I'm not sold this 'needs' OS level integration"*, pur riconoscendo che il problema sottostante (tool-calling affidabile, gestione errori) è reale; un secondo commento liquida in una riga elementi di marketing del progetto non tecnici (*"You lost me at 'with soul'"*). Volume di discussione basso — non ha generato un thread di smontaggio tecnico sostenuto, più uno scrollare-le-spalle collettivo.
4. **Un secondo "Show HN: Agentic OS"** ([news.ycombinator.com/item?id=48741277](https://news.ycombinator.com/item?id=48741277), ~2026, autore `nickpismenkov`, descritto come "your proactive AI assistant that seamlessly automates tasks, scheduling, and files") ha ricevuto **2 punti** in totale (fetch diretto 2026-08-04) — evidenza che l'etichetta "Agentic OS" viene ormai riusata da progetti hobby/piccoli con zero trazione e zero scrutinio, cioè l'etichetta si è **diluita per riuso casuale**, non (solo) contestata da critica seria.
5. **OpenDAN, "Personal AI OS"** ([fiatrete/OpenDAN-Personal-AI-OS](https://github.com/fiatrete/OpenDAN-Personal-AI-OS)) — branding "OS" esplicito nel nome fin dal 2023. Stato riportato (fonte secondaria aggregata, ultimo aggiornamento dichiarato 2026-03-28): **2.032 stelle**, ancora descritto come "very early stages" — tre anni dopo aver messo "OS" nel nome dal primo giorno, la scala e la maturità non hanno tenuto il passo della rivendicazione nominale.
6. **rabbit r1 / "rabbit OS"** — l'unico caso, tra quelli trovati, di **falsificazione pubblica e rapida** della rivendicazione "OS": dispositivo hardware (non un framework agentico, ma il precedente più citabile sul "costo specifico dell'overclaim" nominale). Chiamava il proprio software "rabbit OS"; è stato mostrato essere sostanzialmente **un'app Android** in un contenitore (TechRadar/Android Authority, riportato da ricerca aggregata), XDA Developers ha dato un giudizio 2/10, funzioni base dichiarate (sveglie, promemoria, navigazione) non funzionavano al lancio, e un ricercatore di sicurezza ha esposto API key che avrebbero potuto "brickare tutti i dispositivi" ([xda-developers.com](https://www.xda-developers.com/major-security-flaw-rabbit-r1-code-hackers-customer-data-brick-devices/), citato). Il CEO Jesse Lyu ha ammesso pubblicamente le carenze.

### Lettura d'insieme (fatti, non giudizio)

Ogni istanza di rivendicazione "OS" letterale-tecnica trovata in questo survey rientra in una di queste categorie verificabili: (a) esplicitamente informale/metaforica fin dall'origine (Karpathy); (b) scoped a UN meccanismo specifico, non all'intero sistema, e il progetto discendente ha poi **abbandonato** la parola "OS" dal proprio branding (MemGPT→Letta); (c) rigorosa a livello accademico su una claim circoscritta (AIOS, paper accettato a COLM 2025) ma accolta con lo scetticismo puntuale "perché ti serve l'integrazione OS" quando proposta come prodotto/framework più ampio; (d) un prodotto hardware-consumer dove l'overclaim "OS" è stato falsificato pubblicamente entro settimane dal lancio (rabbit).

**Buco onesto**: non ho trovato in questa passata un thread HN/Reddit ad alto engagement che discuta specificamente il tagline "Any OS" di OpenClaw o le implicazioni-OS di Hermes/Goose — la contestazione pubblica in questo spazio si è concentrata sulla **sicurezza** (la crisi CVE di OpenClaw, sezione 1) più che sulla legittimità semantica della parola "OS" in sé. Questo potrebbe indicare che il pubblico developer ha smesso di litigare sulla metafora e litiga invece sul raggio di danno — ma è una lettura, non un fatto verificato [NON VERIFICATO oltre l'assenza di riscontro trovata].

---

## 10. Densità della famiglia di nomi "Open…" in ambito agentico

Elenco verificato di progetti "Open…" agentici esistenti (con fonte):

| Progetto | Cosa fa | Fonte |
|---|---|---|
| **OpenClaw** | Personal agent self-hosted multi-canale (sezione 1) | [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw) |
| **OpenHands** (ex-OpenDevin) | Piattaforma coding agent autonomo; repo monorepo storico (~79.650 stelle, dato da scout interno precedente) vs il vero repo del paper OpenHands-V1 (`OpenHands/software-agent-sdk`, 874 stelle — correzione già fatta da uno scout interno, non ri-derivata qui) | [openhands.dev](https://www.openhands.dev/), correzione interna in `2026-07-07-teardown-hermes-openhands.md` |
| **OpenInterpreter** | "A coding agent for open models like Kimi K3" (riposizionato da progetto più generico "fai eseguire codice a un LLM sul tuo computer") | [github.com/openinterpreter/openinterpreter](https://github.com/openinterpreter/openinterpreter) |
| **OpenManus** | Replica delle capability dell'agente "Manus", general-purpose, comunità adiacente a MetaGPT | [github.com/FoundationAgents/OpenManus](https://github.com/FoundationAgents/OpenManus) |
| **OpenHarness** (HKUDS) | Harness agentico + ohmo (sezione 4) | [github.com/HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness) |
| **OpenDAN** | "Personal AI OS", branding OS esplicito, piccolo (sezione 9) | [github.com/fiatrete/OpenDAN-Personal-AI-OS](https://github.com/fiatrete/OpenDAN-Personal-AI-OS) |
| **OpenHuman** | Personal AI desktop, sync passiva da 118+ servizi, già coperto dallo scout interno 06-16 | `2026-06-16-gap-competitors.md` §5.1 (non ri-derivato) |
| **OpenCognit Community Edition** | Agent OS con orchestratore CEO, ora congelato/commerciale | `2026-06-16-gap-competitors.md` §5.4 (non ri-derivato) |

**Osservazione per il brief**: la candidatura "OpenMuffin" entrerebbe in una categoria affollata di almeno 8 progetti verificati con prefisso "Open" nello stesso spazio (agenti/harness agentici), di cui almeno due (OpenHands, OpenClaw) hanno traction a sei cifre di stelle — il costo di "suona derivato e mi mette in confronto diretto" che il brief stesso anticipa è confermato empiricamente dalla densità del namespace, non solo intuito.

---

## 11. Cosa non fa nessuno — assenze verificate

Formulate come fatti su ciò che è stato cercato e non trovato, non come opinioni:

1. **Introspezione bidirezionale come feature di prodotto (l'agente riflette sui PROPRI pattern comportamentali, non solo sui pattern dell'utente).** Verificato per assenza in questa passata su OpenClaw (nessun concetto trovato oltre la Memory Wiki, che è memoria-su-fatti non auto-riflessione), Hermes (il curator/skill-review riflette sull'USO delle skill, non su pattern comportamentali/emotivi propri dell'agente), Letta (nessuna feature "l'agente introspetta la propria deriva" trovata in `docs.letta.com/guides/agents/memory-blocks`), Khoj (nessuna). Coerente con — ed esteso da — il finding già verificato internamente (scout 07-16, non ri-derivato) che **Second Me** va nella direzione opposta (predice/completa l'utente invece di osservarlo con contrappunto) e che nessun personal agent deployato implementa un modello utente di 2° ordine validato.
2. **Memoria con provenienza/trust esplicito come primitiva del modello dati** (non solo come euristica di accuratezza). Verificato: survey arXiv 2606.04990 ("From Agent Traces to Trust", giugno 2026, già trovato indipendentemente dallo scout interno memory-moat-sota) afferma esplicitamente che *"none of the major managed memory systems implement [provenance-with-human-review] natively"* — la provenienza rimane "a distinct open problem". Confermato concretamente in questa passata: i memory-block di Letta (`docs.letta.com/guides/agents/memory-blocks`) non descrivono un campo sorgente/provenienza; il memory-extractor di Odysseus (deep-dive interno) non ha evidence-count né confidence-decay; la Memory Wiki di OpenClaw scopa CHI vede un fatto (vault-scope) ma non DA DOVE viene o quanto fidarsene.
3. **Community cross-connector** (una community che condivide stato tra connector DIVERSI — es. un gruppo Telegram + un gruppo Discord nella stessa community — non solo multi-canale sullo stesso tipo). Verificato per assenza: il routing per-canale/per-topic di OpenClaw è esplicitamente isolato per session-key, con *"no concept of community-wide memory sharing"* (fetch diretto di `docs.openclaw.ai/channels/groups`, 2026-08-04); i "Profiles" di Hermes sono configurazioni-agente separate, non una community cross-connector; nessuno degli 8 sistemi di questo report descrive un primitivo "communities attraversano connector eterogenei e condividono un sottoinsieme di memoria" nel senso in cui lo propone il modello community del brief MuffinOS.

---

## 12. Controllo reale della macchina

### Il benchmark di riferimento — numeri correnti, con data

**OSWorld-Verified** (short-horizon, tempo umano mediano ~2 minuti per task secondo il paper OSWorld 2.0 stesso) — leaderboard **fetchato 2026-08-04**: **Qwen3.8 Max in testa con 86,1%**, Claude Mythos 5 e Claude Fable 5 a ridosso (~85%), **21 modelli valutati, media 0,7** ([llm-stats.com/benchmarks/osworld-verified](https://llm-stats.com/benchmarks/osworld-verified), [benchlm.ai/benchmarks/osworld-verified](https://benchlm.ai/benchmarks/osworld-verified), entrambi fetchati/ricercati 2026-08-04). Questo è **sopra** il baseline umano di 72,36% già verificato in precedenza dallo scout interno (07-16, fonte primaria `leaderboard.steel.dev/osworld`, dato Feb-2026, non ri-derivato qui) — sul benchmark short-horizon, il computer-use è oggi sovraumano.

**OSWorld 2.0** (long-horizon, workflow professionali reali, tempo umano mediano **~1,6 ore**, arXiv 2606.29537, **fetch diretto 2026-08-04**): il modello migliore, **Claude Opus 4.8 con thinking massimo e tool-call in batch, raggiunge 20,6% di completamento binario e 54,8% di punteggio parziale**; GPT-5.5 raggiunge 13,0% binario / 49,5% parziale. **Il crollo per durata del task è netto**: 20-24% di completamento binario sotto i 45 minuti, sotto il 10% nella fascia 137-163 minuti, **zero per OGNI modello valutato oltre i 163 minuti**. Citazione diretta dal paper: *"Current agents therefore make substantial partial progress, but under strict completion criteria they leave most professional workflows unsolved."*

### Classificazione per affidabilità, per sistema (evidenza raccolta in questo report)

**Affidabile (shell/fs/processo via API deterministiche, non basato su visione)**:
- OpenClaw: `exec`+`read`/`write`/`edit`/`apply_patch` — shell diretta con i permessi pieni dell'utente (`docs.openclaw.ai/tools/exec`).
- Hermes: terminal+process+fs, più `browser_cdp` (Chrome DevTools Protocol, deterministico) come alternativa esplicita al ramo vision-based.
- Goose: estensione "Developer" (default-on), shell/fs — il nucleo del suo caso d'uso di coding-agent.
- Odysseus: shell execution presente ma **segnalata dal progetto stesso, nel proprio `THREAT_MODEL.md`, come gap noto** ("no shell sandbox #1058") — cioè anche il livello "affidabile" qui è dichiarato dal vendor come non contenuto.

**Fragile (basato su visione / UI automation — il vero "computer use" nel senso OSWorld)**:
- Goose: estensione **"Computer Controller"**, ricostruita su **Peekaboo** (API di accessibilità macOS): screenshot annotato → elementi cliccabili etichettati (B1, B2, T1...) → click per etichetta. **Esplicitamente solo macOS**, latenza legata allo screenshot.
- Hermes: `browser_vision`/`computer_use` esistono tra le 12 primitive browser, ma **come opzione accanto a** (non sostituto di) CDP deterministico — il sistema lascia il ramo fragile opt-in.

**Non fatto affatto (nessuna evidenza di controllo macchina)**:
- Khoj: nessun tool shell/fs/processo trovato in nessuna fonte di questa ricerca — assistente di retrieval/chat/automazione puro.
- Letta (prodotto core/ADE): il controllo macchina esiste solo nel prodotto separato `letta-code` (coding-agent), non nella piattaforma memoria-agente generica.

### Lettura sintetica dei fatti raccolti

Nei sistemi coperti, "controllare la macchina" nella pratica corrente significa quasi sempre **eseguire shell + leggere/scrivere filesystem** — primitivo maturo, deterministico, e implementato in modo sostanzialmente identico (con permessi pieni dell'utente, spesso senza sandboxing di default) da quattro sistemi su otto. Il "vedere lo schermo e cliccare come un umano" (computer-use/UI-automation in senso stretto) è offerto come feature dedicata e nominata da **un solo sistema** in questo set (Goose "Computer Controller"), è **esplicitamente limitato a una singola piattaforma** (macOS), e nessuno degli otto sistemi rivendica o dimostra API OS-level native e cross-platform per "apri questa app" che non siano o (a) l'esecuzione di un comando shell che incidentalmente apre un'app, o (b) un click su dove l'icona appare in uno screenshot.

---

## 13. Tabella comparativa

| Sistema | Memoria | Proattività | Multi-canale | Multi-tenant | System control | Self-mod | Permessi | Estensioni | Traction (data) |
|---|---|---|---|---|---|---|---|---|---|
| **OpenClaw** | Memory Wiki, vault-scope o agent-scope | [NON VERIFICATO meccanismo di soglia] | 10 canali (Discord/iMessage/Matrix/Teams/QQBot/Signal/Slack/Telegram/WhatsApp/Zalo) | session-key per gruppo/canale/topic; **no cross-community sharing** (verificato) | `exec` shell + fs, permessi pieni utente, no sandbox default | root-of-trust = filesystem operatore, nessun'immutabilità crittografica | 3+ livelli enforcement dichiarati (tool policy/exec approvals/sandboxing/allowlist), guardrail prompt = "soft" | ClawHub, conteggio **contraddittorio tra fonti** (13,7K→3,3K→52,6K, date incongruenti) | 385.000★, 80.900 fork, 700+ contributor (fetch 2026-08-04); ≥5 famiglie CVE critiche/high 2026-02→04 |
| **Hermes** | session_search 4500×, "Honcho" peers | cron NL + `deliver`, modalità script no-LLM | Telegram/Discord/Slack/Feishu via `send_message` | "Profiles" = agenti separati, non session-key di gruppo [NON VERIFICATO isolamento gruppo-sconosciuti] | terminal/fs/12 browser primitive (CDP deterministico + vision opt-in)/execute_code | config.yaml read-only by default, `--apply` esplicito; approvazioni "always" persistono senza scadenza | Tirith: comandi puliti mai chiesti, classifier LLM temp0 su flaggati, `DELEGATE_BLOCKED_TOOLS`+depth-limit sub-agenti | Catalogo ufficiale **71** skill/13 categorie (fetch 2026-08-04) vs tracker community ~258 (v0.17.0) | 214-220K★, ~40K fork, 321 contributor (2026-05-28); $1,5B valuation round (TechCrunch 2026-07-13); CVE-2026-9368 sandbox-escape, patchata mesi prima della pubblicazione CVE |
| **Goose** | estensione opt-in "Memory", non sostrato core | scheduler+recipes = **cron su task**, non soglia di interruzione | CLI/Desktop/API nativi; Slack (`goose-slackbot`) **stato merge non confermato** | nessun concetto di gruppo trovato | "Developer" (shell/fs default-on) + "Computer Controller" (Peekaboo, **solo macOS**, screenshot+click) | [NON VERIFICATO self-mod a runtime] | nessun sandbox di default ("runs directly on the host with the user's full permissions"); sandbox macOS opzionale | MCP nativo, "70+" (approssimativo, nessun registry con conteggio primario trovato) | 52.200★, 5.900 fork (fetch 2026-08-04); AAIF/Linux-Foundation dal 2025-12-09; nessuna CVE numerata verificata |
| **OpenHarness/ohmo** | CLAUDE.md discovery, MEMORY.md persistente, auto-compact | [NON VERIFICATO] | Feishu/Slack/Telegram/Discord (ohmo) | [NON VERIFICATO] | fork branch/scrive codice/PR autonome; gira su abbonamento Claude Code/Codex esistente (non API diretta) | [NON VERIFICATO] | "Multi-Level Permission Modes"+path-rules+hook+approval dialog (dichiarati, non verificata la meccanica) | 43+ tool, 54 comandi, nessun registry pubblico di terze parti trovato | 15.200★, 2.500 fork, 86 watcher (fetch 2026-08-04); nessuna CVE trovata |
| **Odysseus** | **debole**: max 2 fatti/conversazione, no evidence/decay/temporale | scheduler+event-bus a soglia (`fire_event`), il più vicino a un "dream-cycle" generico trovato | web UI/PWA; email IMAP/SMTP; CalDAV | scoping admin/non-admin nel codice, "pure overhead" per il target dichiarato | shell presente ma **THREAT_MODEL.md proprio** segnala "no shell sandbox" come gap noto | teacher-escalation gated (persist solo se il teacher passa il proprio eval) | plan-mode fail-closed (denylist = tutti-noti − allowlist); untrusted-wrapper anche su proprie memorie/skill | nessun registry di estensioni terze trovato | 84.600★, 292 fork, 931 issue aperte (fetch 2026-08-04); nessuna CVE pubblica trovata |
| **HumanLayer** | n/a (pivotato) | n/a | n/a | n/a | n/a | n/a | 12-Factor-Agents manifesto ancora citato (indicizzato 2026-03-22) | n/a | repo "pretty much all deprecated"; commit fino 2026-06-30 |
| **Letta** | 3 livelli (core/recall/archival) + MemFS git-backed (coding-oriented); `read_only` block flag | [NON VERIFICATO] | locale/desktop/"channels like Slack" [NON VERIFICATO dettaglio] | binario: agente-per-tenant O Conversations condivise senza isolamento intermedio | solo nel prodotto separato `letta-code`; ADE/server core non è agente di controllo macchina | `read_only` su blocchi di memoria = unico primitivo di immutabilità-parziale pulito nel survey | [NON VERIFICATO modello permessi dedicato per letta-code] | skills&subagents, nessun conteggio registry trovato | 24.100★, 2.600 fork, 138 watcher (fetch 2026-08-04); nessuna CVE trovata |
| **Khoj** | storico conversazionale + agenti custom persona/knowledge/tool | **la più esplicita**: newsletter+notifiche schedulate (ma configurate dall'utente, non soglia appresa) | browser/Obsidian/Emacs/desktop/telefono/WhatsApp | multi-utente reale (Magic Links/OAuth) ma "molti utenti indipendenti", non gruppi con sotto-memoria condivisa | **nessuna evidenza trovata** di shell/fs/processo | [NON VERIFICATO] | default `--anonymous-mode` single-user; multi-user richiede rimozione esplicita + auth | agenti pubblici "in arrivo", non ancora quantificabili | 36.200★, 2.300 fork (fetch 2026-08-04); 2 CVE (IDOR OAuth Notion, incorrect-authz conversation-sharing) — **entrambe su isolamento tenant** |

---

## Sintesi per orchestratore (incollabile in pitch/ADR)

Otto sistemi mappati (più HumanLayer come manifesto ormai non-vivo): tre "personal agent" chat-native multi-canale ad alta traction (OpenClaw 385K★, Hermes 214-220K★+$1,5B, Odysseus 84,6K★ — tutti e tre single-operator-first, nessuno con un modello community cross-connector), tre harness/coding-agent generalisti (Goose 52K★ ora AAIF/Linux-Foundation, OpenHarness 15K★ con ohmo che gira su abbonamento Claude-Code/Codex esistente invece di API diretta, Letta 24K★ con `letta-code` separato dal prodotto memoria), un knowledge/second-brain con automazioni (Khoj 36K★, unico con multi-user reale ma entrambe le sue CVE sono proprio su isolamento-tenant). **Sicurezza è il dato più denso e più prezioso**: OpenClaw ha subito almeno 5 famiglie di CVE critiche/high concentrate in 3 mesi (gennaio-aprile 2026), tutte riconducibili allo stesso pattern — trust implicito su localhost/pairing/scope-token, mai risolto con un redesign ma patchato reattivamente release-per-release, con enforcement kernel-level arrivato da terzi; Hermes ha avuto una sandbox-escape RCE (CVE-2026-9368) già patchata quando la CVE è stata pubblicata; Khoj ha 2 CVE, entrambe su boundary multi-tenant. Nessuno degli otto sistemi ha un root-of-trust immutabile a livello di config/system-prompt: il più vicino è il flag `read_only` sui memory-block di Letta, scoped alla sola memoria. Il "controllo macchina" affidabile in pratica = shell+fs (4/8 sistemi, quasi sempre senza sandbox di default); il "computer use" vision-based vero è offerto da un solo sistema (Goose, solo macOS). Sull'archeologia "OS": ogni rivendicazione tecnica letterale trovata (MemGPT, AIOS) o era scoped a un solo meccanismo (e il discendente ha abbandonato la parola) o ha ricevuto scetticismo puntuale ("perché ti serve l'integrazione OS") senza mai una confutazione tecnica sostenuta — l'unico caso di falsificazione pubblica netta è un dispositivo hardware (rabbit r1), non un framework agentico. Tre assenze verificate su tutti gli otto: nessuna introspezione bidirezionale (l'agente riflette su di sé, non solo sull'utente), nessuna provenienza/trust esplicita nel modello-dati della memoria (confermato "open problem" da survey 2026-06), nessuna community che condivida stato tra connector eterogenei.

---

*Report chiuso 2026-08-04. Numeri di traction/CVE volatili per natura — ri-verificare alla data dell'ADR/pitch che li cita.*
