# Skill-standard-2026-09-04 — Le skill di Muffin contro lo standard letto dalla fonte

> Mandato: *«Le skill per esempio, stiamo seguendo gli standard che troviamo online?»* — e, più in
> generale, il sospetto di usare troppo poco internet per orientarsi. Metodo: WebFetch diretto su
> fonti primarie (agentskills.io, modelcontextprotocol.io, code.claude.com, opencode.ai,
> aaif.io), WebSearch solo per localizzare URL o per interrogare i peer meno documentati
> (OpenClaw, Hermes Agent). Ogni claim riporta dove è stato letto e quando (oggi, 2026-09-04,
> salvo indicazione diversa). Non implementato nulla: nessun file sotto `core/`, `agent/`,
> `cli/`, `defaults/` è stato toccato.

## Verdetto in una riga

**Il formato è già conforme, byte per byte, ai sei campi dello standard** (`core/skills/skills.ts`
replica esattamente i vincoli di `agentskills.io/specification`), e la scommessa dell'ADR-0010
("adottare SKILL.md compra interoperabilità reale") **è verificata, non ipotetica**: i due peer che
l'owner segue per nome — OpenClaw e Hermes Agent — sono entrambi elencati oggi come adopter dello
stesso standard esatto su agentskills.io. Le divergenze che restano sono quasi tutte scelte
difendibili con codice alla mano, non debito. L'unica voce dove "conformarsi" comprerebbe qualcosa
di concreto a basso costo è un validator in CI (§C.6); il resto o è già coperto da meccanismi
esistenti (§C.8) o è deliberatamente rifiutato per ragioni di sicurezza che lo standard stesso
segnala come rischio (§C.2).

---

## Parte A — Cosa fa Muffin oggi (percorso di produzione)

### A.1 Formato e parsing

`core/skills/skills.ts:24-35` (`FrontmatterSchema`, Zod) accetta **esattamente** i sei campi dello
standard — `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` — con gli
stessi vincoli numerici della spec (name ≤64 char, regex minuscolo-trattini; description 1-1024
char; compatibility ≤500 char). Non c'è una sola estensione proprietaria: il file lo dichiara nel
proprio commento di testa (`skills.ts:8-22`), citando la fonte primaria e la data in cui è stata
letta la prima volta (2026-08-08, `docs/evidence/spec-skill-md-e-shell-nei-peer.md`).

`discoverSkills()` (`skills.ts:60-80`) legge `<home>/skills/*/SKILL.md` (una sola radice,
`skillsRoot()` a `skills.ts:54-56`), e `parseSkill()` (`skills.ts:82-118`) impone un vincolo che lo
standard *scrive* ma che, come verificato in Parte B, la reference implementation **non applica
davvero**: `name` deve combaciare con il nome della cartella, pena lo scarto della skill
(`skills.ts:104-106`).

### A.2 Il tool che la porta al modello, e il suo confine

`agent/tools/skill.ts` espone un solo tool, `skill_read` (spec a `skill.ts:34-47`): con solo `name`
restituisce `SKILL.md` (livello 2 di progressive disclosure); con `file` restituisce un file
bundlato sotto la stessa cartella (livello 3 — `references/`, `assets/`, `scripts/`). Il percorso è
sempre risolto con `realpathSync` su entrambi i lati (skill dir e file richiesto,
`skill.ts:90-97`) e rifiutato se esce dalla cartella — simlink compresi — con un tetto di 512 KiB
per file (`MAX_SKILL_FILE_BYTES`, `skill.ts:54,107-114`). Non esiste un secondo tool per scrivere
skill (`grep -rn "skill_write\|createSkill"` su tutto il repo: zero risultati) — l'unico modo per
aggiungere una skill è il filesystem, fuori dal turno del modello.

Il tiering della risposta è dichiarato esplicitamente e con la sua stessa storia di bug
(`skill.ts:115-127`): il corpo di una skill letta è **tier 1** (istruzioni, non dati fenced) — a
differenza della sezione livello-1 nel prompt, che è **fenced** (v. A.3). Il commento registra che
l'omissione del tier era già successa una volta e cosa rompeva: senza tier alzato, `taint` restava
0, e `core/policy/decide.ts` usa `taint === 0` come condizione per auto-consentire `sys.shell` in
hardened mode — quindi un turno poteva leggere istruzioni scritte da chiunque avesse accesso al
filesystem e arrivare alla shell senza mai chiedere all'owner.

### A.3 Come arriva al modello (livello 1)

`skillsPromptSection()` (`skills.ts:143-157`) produce la lista `name — description` di ogni skill
installata e la passa a `fence()` (`core/memory/spotlight.ts`) con un nonce per-installazione
stabile fra processi — lo stesso meccanismo che rende dati (non istruzioni) la descrizione di un
server MCP di terzi. Il test di accettazione D9 (`evals/acceptance/scenarios/d-skills.accept.ts`)
prova concretamente il buco che questo chiude: pianta una skill con una `description` che contiene
il marcatore di chiusura del recinto seguito da un'istruzione di exfiltrazione
(`d-skills.accept.ts:61-66`) e verifica che il tentativo venga neutralizzato
(`[skills-marker rimosso]`, righe 67-75) invece di rompere il recinto — la descrizione resta dato,
mai promossa a istruzione, anche quando prova ad esserlo.

### A.4 Confine di sicurezza più largo: l'intera casa è denyWrite

`core/rot/guards.ts:87` mette `p.home` — l'intera installazione, `skills/` compreso — nella lista
`denyWrite` di `mandatoryGuards()` (`guards.ts:64`), col commento che racconta *perché* la voce
esiste in questa forma (misurato il 2026-09-03: un `shell_run` ordinario sovrascriveva `.rot-anchor`,
`muffin.db`, `sessions/` quando lo scope di scrittura era la casa). Effetto pratico per le skill: un
turno del modello, anche dentro la sandbox, **non può scrivere né modificare** il proprio
`~/.muffin/skills/`. Read invece **non** è negato — `guards.ts:107-112` mette in `denyRead` solo i
segreti e `.env`, non l'intera home — quindi uno script bundlato sotto `skills/<nome>/scripts/` è
leggibile ed **eseguibile** tramite lo shell tool generico: `agent/tools/shell.ts:135-142` vincola
solo dove il processo *parte* (`cwd` dentro il progetto), non quali percorsi assoluti può invocare.
Questo copre lo stesso terreno che Claude Code copre con la sostituzione `${CLAUDE_SKILL_DIR}` in
`allowed-tools` (Parte B), senza bisogno di un meccanismo nuovo.

### A.5 Distribuzione e migrazione

`defaults/skills/` contiene oggi due skill reali: `studia-un-documento` (SKILL.md con `metadata`,
niente `license`/`compatibility`) e `collega-telegram`. `cli/init.ts:88-89,124` le installa in una
casa nuova copiandole in `<home>/skills/`; `cli/adopt.ts:51-54,231` fa lo stesso per una casa
esistente creata prima che le skill esistessero (altrimenti `skillsPromptSection` resterebbe vuota
per sempre su quell'installazione). `cli/prompt-show.ts:152` tratta un catalogo skill vuoto come
caso normale (non un errore).

### A.6 Cosa NON c'è, verificato per assenza

- Nessuna radice per-progetto o per-plugin: `skillsRoot()` è sempre e solo `<home>/skills`
  (`skills.ts:54-56`). Non esiste l'equivalente di `.opencode/skills/` o `.claude/skills/` dentro un
  workspace, né un namespace `plugin:nome`.
- `allowed-tools` è parsato (`skills.ts:109`, campo `allowedTools` sul tipo `SkillInfo`,
  `skills.ts:43`) ma il commento lo dichiara esplicitamente («Present but NOT enforced in v1») e
  nessun chiamante lo legge per modificare una decisione di policy (`grep -rn "allowedTools"` fuori
  da `skills.ts`/`skill.ts`: zero risultati in `core/policy/`).
- Nessun validator canonico in CI: `grep -rln "skills-ref"` nel repo trova solo le due voci di
  evidence che *ne parlano*, non un uso reale. La conformità oggi si fida solo dello schema Zod
  interno.
- Nessuna capacità di auto-scrittura di skill da parte del modello (nessun `skill_write`, nessun
  equivalente della "automated skill creation" che Hermes Agent pubblicizza).

### A.7 La decisione già presa

`docs/decisions/0010-standard-esterni.md` ha già scelto: **ADOTTA** per Agent Skills/SKILL.md,
motivato con "divergere con 2 skill in casa sarebbe ingiustificabile" e "la governance debole
(nessuna foundation) è un rischio accettato: il formato è banale da forkare se deriva." Questo
report **non riapre** quella decisione (nessuna evidenza nuova la contraddice — anzi, Parte B la
rinforza); verifica se l'*implementazione* la rispetta e dove smette di farlo.

---

## Parte B — Cosa dice lo standard, letto dalla fonte oggi (2026-09-04)

### B.1 La specifica canonica — [agentskills.io/specification](https://agentskills.io/specification), letto 2026-09-04

Confermato verbatim, immutato rispetto alla lettura dell'08/08: sei campi, stessi vincoli esatti
riportati in A.1 (`name` 1-64 char lowercase-trattini, deve combaciare con la cartella padre;
`description` 1-1024 char; `license`/`compatibility`≤500/`metadata`/`allowed-tools` opzionali,
quest'ultimo marcato "Experimental. Support may vary between implementations"). Directory
opzionali: `scripts/`, `references/`, `assets/`. Validator canonico: `skills-ref validate ./my-skill`
dal repo `agentskills/agentskills`.

### B.2 Progressive disclosure — stessa fonte

Tre livelli, identici a quanto già in uso in Muffin: (1) metadata sempre in contesto (~100
token/skill); (2) corpo di `SKILL.md` caricato all'attivazione (<5000 token raccomandati); (3)
risorse (`scripts/`, `references/`, `assets/`) caricate solo quando servono. `core/skills/skills.ts`
implementa esattamente questa gerarchia — non un'approssimazione.

### B.3 Governance — correzione a una fonte secondaria, verificata alla primaria

Una prima ricerca (WebSearch) riportava "AGENTS.md, Agent Skills, and MCP are all under AAIF
governance" — falso, o comunque non confermato dalla fonte primaria. **Fetch diretto di
[aaif.io/projects](https://aaif.io/projects) (2026-09-04)**: i cinque progetti ospitati dalla
Agentic AI Foundation sono MCP, Goose, AGENTS.md, agentgateway, Agent2Agent (A2A). **Agent
Skills/SKILL.md non compare.** Lo standard resta governato da `agentskills.io` / org GitHub
`agentskills/agentskills`, "open to contributions from the broader ecosystem" ma senza una
foundation dietro — esattamente come registrato da ADR-0010 il mese scorso, e ancora vero oggi.
Questo è un rischio reale (nessun processo di governance formale, nessun member vote), non un
rischio superato: **l'accettazione del rischio in ADR-0010 resta corretta e non va aggiornata**.

### B.4 Adopter — 46 client mostrati oggi su agentskills.io, **inclusi i due peer nominati dall'owner**

Fetch diretto della homepage (`agentskills.io`, 2026-09-04): il carosello client elenca 46 prodotti,
fra cui — rilevante per questo mandato — **OpenClaw** (`docs.openclaw.ai/tools/skills`,
`github.com/openclaw/openclaw`) e **Hermes Agent** di Nous Research
(`hermes-agent.nousresearch.com/docs/user-guide/features/skills`,
`github.com/NousResearch/hermes-agent`), oltre a Claude Code, Claude, ChatGPT & Codex, Gemini CLI,
OpenCode, Cursor, GitHub Copilot, VS Code, Goose, e altri 36. La domanda dell'owner — "conformarsi
permetterebbe a Muffin di usare skill scritte per altri agenti, e di far usare le sue altrove?" — ha
quindi una risposta verificata: **sì, con almeno due agenti che l'owner segue per nome**, non un
"sì in teoria" da leggere nello spec.

### B.5 Claude Code — la reference implementation, riletta oggi (non solo la lettura di agosto)

Fetch diretto di [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)
(2026-09-04), con tre aggiornamenti rispetto alla lettura precedente che vale la pena registrare
perché cambiano un verdetto:

1. **`allowed-tools` è ORA applicato**, e non solo dichiarato: "Claude Code honors the frontmatter
   in every kind of session, so an `allowed-tools` grant goes through the normal permission flow."
   Il meccanismo è una pre-approvazione *per il turno che invoca la skill* (si azzera al messaggio
   successivo), non un sandbox permanente. La stessa pagina però avverte esplicitamente del
   rischio: **"Workspace trust doesn't gate this field... A skill can grant itself broad tool
   access, so review the `allowed-tools` of skills checked into a repository before you run Claude
   Code there."** — cioè la reference implementation stessa segnala che questo campo è un canale
   di privilege escalation testuale, non solo una comodità UX.
2. **`name` ≠ cartella non è bloccante in Claude Code.** Per skill personali/di progetto, `name` è
   "solo l'etichetta mostrata negli elenchi"; il comando invocato viene sempre dal nome della
   cartella. **Muffin, rifiutando la skill quando `name` non combacia (`skills.ts:104-106`), è più
   aderente al testo letterale dello standard della sua stessa reference implementation** — non è
   un gap, è un punto dove Muffin è più stretto.
3. **Frontmatter malformato → ancora silenzioso, confermato oggi**: "If the frontmatter YAML is
   malformed, Claude Code loads the skill body with empty metadata... Run with `--debug` to see the
   parse error." Il comportamento di Muffin (skip esplicito + riga in `problems[]`, riportata a
   boot e in doctor) resta una divergenza dichiarata e difendibile, non un allineamento mancato.

Nota anche una precisazione sui percorsi doppi: Claude Code ha fuso `.claude/commands/` dentro le
skill (un file lì e uno skill sono ora la stessa cosa), e la strict-validation a 6 campi
("Unexpected key(s) in SKILL.md frontmatter…") si applica **solo** al path di packaging/upload
verso claude.ai/Skills API — mai alla CLI stessa, che accetta ~19 campi propri senza errore. Questo
conferma quanto già scritto nell'evidence dell'08/08 (§1.6 lì): "compatibile con SKILL.md" va
sempre qualificato per canale.

### B.6 MCP — prompts e resources, un meccanismo diverso non un sostituto

Letti oggi `modelcontextprotocol.io/specification/2025-06-18/server/{prompts,resources}`:

- **Prompts**: template "user-controlled", tipicamente esposti come slash-command
  (`prompts/list`/`prompts/get`, risposta come lista di `PromptMessage` con `role`+`content`, che
  può includere risorse embedded). È un meccanismo *client-server via JSON-RPC*, non un file
  scaricabile su disco: il contenuto arriva a runtime da un processo server, tipicamente per
  invocazione esplicita dell'utente.
- **Resources**: esposizione di dati (`resources/list`/`resources/read`, URI-addressed,
  sottoscrivibili) — pensati per iniettare contesto (file, schema, output applicativo), non
  procedure. "Application-driven": è l'host a decidere come includerli, non un'attivazione a
  descrizione come le skill.

**Non sono equivalenti a SKILL.md, e non competono sullo stesso terreno**: un prompt/resource MCP
vive dietro un server che qualcuno deve gestire e far girare (rete, autenticazione, lifecycle);
SKILL.md è un formato-file portabile, senza server, pensato per essere versionato in Git e
condiviso come cartella. Muffin usa già MCP per estensioni-di-terzi con stato/azioni (`agent/tools/mcp.ts`,
fuori scope qui) e SKILL.md per procedure-senza-stato: la separazione dei due standard per due
problemi diversi, già presente in ADR-0010, è coerente con come li descrive la fonte primaria
stessa.

### B.7 OpenCode — stesso formato, discovery più larga, nessun enforcement nativo di `allowed-tools`

Letto `opencode.ai/docs/skills/` (2026-09-04): stesso `SKILL.md`, ma sei radici possibili con
precedenza esplicita — progetto (`.opencode/skills/`, `.claude/skills/`, `.agents/skills/`) e
globale (le stesse tre sotto `~/.config/opencode/`, `~/.claude/`, `~/.agents/`) — con **retro-
compatibilità intenzionale verso il layout di Claude Code**. Un solo tool dedicato `skill({name})`.
Nessuna menzione di enforcement di `allowed-tools`: i permessi passano da un sistema separato
(`allow`/`deny`/`ask` per pattern in `opencode.json`), non dal frontmatter della skill — la stessa
scelta architetturale di Muffin (capacità nel nodo/policy, non nel testo).

### B.8 OpenAI (ChatGPT, Codex) — stesso standard esatto, non un formato parallelo

`developers.openai.com/blog/skills-agents-sdk` e la voce di OpenAI su `agentskills.io` (ChatGPT &
Codex, `developers.openai.com/codex/skills/`): OpenAI ha adottato **lo stesso SKILL.md**, non un
proprio formato. Un bundle di skill scaricato da un canale è dichiaratamente installabile
sull'altro. Questo è precedente diretto e concreto per la parte "interoperabilità" della domanda
dell'owner — non serve immaginare un futuro in cui vale, vale già oggi fra i due maggiori vendor.

### B.9 aider — non un controesempio, solo un adottante più indietro

Ricerca (WebSearch) confermata da fonti secondarie multiple e coerenti fra loro: aider non ha una
directory di skill nativa scansionata automaticamente; una skill vi si carica manualmente come
contesto di sola lettura (`/read-only`). **Non ho aperto la documentazione ufficiale di aider come
fonte primaria** — qui la verifica è debole (fonti secondarie concordanti, non il repo/doc
ufficiale) e va segnalata come tale: non cambia il verdetto (aider resta un dato debole, non
contrario), ma non è verificata alla fonte primaria come il resto di questo documento.

---

## Parte C — Tabella divergenza → verdetto

| # | Divergenza osservata | Verdetto | Perché (codice/fonte) |
|---|---|---|---|
| 1 | Muffin implementa solo i 6 campi standard; nessuna delle ~13 estensioni proprietarie di Claude Code (`disable-model-invocation`, `context: fork`, `hooks`, `paths`, `model`, `effort`, `arguments`, ecc.) | **Scelta legittima** | `docs/decisions/0010-standard-esterni.md` — l'obiettivo dichiarato è la portabilità; ogni campo extra sarebbe una biforcazione dal formato scaricabile/condivisibile. Nessuna di queste estensioni è nello standard letto in B.1. |
| 2 | `allowed-tools` è parsato (`skills.ts:109`) ma mai applicato a una decisione di policy | **Scelta legittima, con motivazione di sicurezza** | La reference implementation stessa (B.5) avverte che questo campo, se applicato, è un canale con cui *un testo* concede a se stesso l'uso di strumenti — esattamente il pattern che le note di sicurezza del repo (capacità-nel-nodo, non nel testo) rifiutano per principio. `core/policy/decide.ts` decide sulla base di capability/rischio/taint calcolati dal kernel, non da un frontmatter. |
| 3 | `name` deve combaciare esattamente con la cartella, pena scarto (`skills.ts:104-106`) | **Più conforme allo standard della sua reference implementation** | B.5 punto 2: Claude Code stessa non impone questo vincolo malgrado lo standard lo richieda testualmente. Muffin lo applica alla lettera. |
| 4 | Frontmatter malformato → skip esplicito + riga in `problems[]`, mai silenzioso | **Divergenza dichiarata e difendibile** | B.5 punto 3: Claude Code carica comunque con metadata vuoti (silenzioso salvo `--debug`), comportamento confermato ancora oggi. Il commento in `skills.ts:17-21` la motiva esplicitamente come scelta di design, non oversight. |
| 5 | Una sola radice (`<home>/skills`), niente project/plugin/enterprise | **Scelta legittima per l'architettura attuale** | Muffin è un agente singolo-owner continuo con una home unica (ADR-0059, "la casa non è uno spazio di lavoro"); non esiste oggi un concetto di "progetto" persistente paragonabile al workspace-per-repo di Claude Code/OpenCode. Diventerebbe un difetto reale **solo se** Muffin acquisisse un tale concetto. |
| 6 | Nessun uso del validator canonico `skills-ref` in CI | **Occasione, basso costo** | Lo schema Zod interno replica i vincoli ma non è mai stato confrontato col validator di riferimento — nessuna prova che la replica sia perfetta oltre alla lettura manuale fatta qui. |
| 7 | Nessuna capacità del modello di creare/scrivere skill (`skill_write` assente) | **Occasione con trade-off esplicito, non implementarla senza disegno** | Hermes Agent (B.4) la pubblicizza come feature ("automated skill creation"). In Muffin, `denyWrite` copre l'intera home (`guards.ts:87`) per una ragione misurata (A.4): un canale che scrive skill dovrebbe uscire dal sandbox e passare da revisione owner esplicita, altrimenti è la classe di guasto "un'istruzione tier-0/3 che si auto-promuove a tier-1 al prossimo boot" — precisamente il tipo di problema che il tiering di `skill.ts:115-127` esiste per prevenire. |
| 8 | Nessun meccanismo dedicato per eseguire script bundlati (l'equivalente di `${CLAUDE_SKILL_DIR}` in `allowed-tools`) | **Non è un gap: già coperto** | A.4: `denyRead` non include la home (`guards.ts:107-112`), e `shell.ts:135-142` vincola solo il cwd di partenza, non i path assoluti invocabili — uno script sotto `skills/<nome>/scripts/` è già leggibile ed eseguibile con gli strumenti esistenti. |
| 9 | Interoperabilità con l'ecosistema esterno (skill altrui importabili, skill di Muffin esportabili) | **Confermata, non ipotetica** | B.4, B.8: 46 adopter oggi su agentskills.io, inclusi OpenClaw, Hermes Agent, OpenAI/Codex, Gemini CLI — non serve altro lavoro per essere vera, l'ADR-0010 l'ha già comprata adottando il formato letterale. |

---

## Raccomandazione

**Non toccare il formato.** È già conforme; il rischio di drift è nella governance dello standard
(B.3, già accettato in ADR-0010), non nell'implementazione.

Tre azioni concrete, a basso costo, proposte come ADR (nessuna implementata qui):

1. **Aggiungere `skills-ref` come controllo, non come dipendenza runtime.** Un job CI (o uno
   script in `scripts/`) che gira `skills-ref validate` su `defaults/skills/*` e su una skill di
   prova generata dal test esistente chiuderebbe l'unico punto dove la conformità oggi si fida solo
   di se stessa. Costo: una dev-dependency e poche righe di CI.
2. **Chiudere esplicitamente l'ambiguità "v1" su `allowed-tools`.** Il commento in `skills.ts:42`
   dice "Present but NOT enforced in v1", che implica un piano d'azione futuro implicito. Un ADR
   che registra *perché* non va applicato (capacità-nel-nodo, non nel testo — punto 2 della
   tabella) evita che qualcuno lo implementi un giorno come "completamento" senza aver letto perché
   non lo è.
3. **Non introdurre project/plugin skill roots ora.** Il segnale che ribalterebbe questo: Muffin
   acquisisce un concetto di progetto/repo persistente (multi-tenant per repository, non solo
   multi-tenant per owner) — a quel punto il punto 5 della tabella diventa un difetto reale e va
   riaperto con evidenza nuova.

## Domande poste senza reperto

- **La documentazione ufficiale di aider non è stata aperta alla fonte primaria** (B.9): il
  giudizio "non è un controesempio" si fonda su fonti secondarie concordanti, non sul repo/doc
  ufficiale di aider. Se questo dettaglio diventasse rilevante per una decisione, va riletto alla
  fonte prima di usarlo come base.
- **Quanti "adopter" di agentskills.io hanno un'implementazione realmente testata dell'enforcement
  di `allowed-tools`, oltre a Claude Code?** Non verificato: la lista di B.4/B.7 dice chi supporta
  il *formato*, non chi applica quel campo specifico a una decisione di sicurezza reale.
- **`skills-ref` valida davvero byte-per-byte quello che fa `FrontmatterSchema`?** Non eseguito in
  questo mandato (nessuna implementazione permessa) — è esattamente il gap che la raccomandazione
  1 chiude.

## Fonti primarie (lette 2026-09-04 salvo indicazione diversa)

- [agentskills.io/specification](https://agentskills.io/specification) — spec dei sei campi
- [agentskills.io](https://agentskills.io) — carosello adopter (46 client), governance ("open to
  contributions from the broader ecosystem")
- [aaif.io/projects](https://aaif.io/projects) — i cinque progetti AAIF (MCP, Goose, AGENTS.md,
  agentgateway, A2A); Agent Skills **non** compare
- [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills) — reference
  implementation, frontmatter completo, `allowed-tools` enforcement, comportamento su malformed
  YAML, fusione comandi/skill
- [opencode.ai/docs/skills/](https://opencode.ai/docs/skills/) — discovery multi-root, tool
  dedicato, permessi separati dal frontmatter
- [modelcontextprotocol.io/specification/2025-06-18/server/prompts](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts)
  e [.../server/resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
  — meccanismo prompts/resources, per confronto
- [developers.openai.com/blog/skills-agents-sdk](https://developers.openai.com/blog/skills-agents-sdk),
  [developers.openai.com/codex/skills/](https://developers.openai.com/codex/skills/) — adozione
  OpenAI dello stesso standard
- `docs.openclaw.ai/tools/skills`, `github.com/openclaw/openclaw` — OpenClaw
- `hermes-agent.nousresearch.com/docs/user-guide/features/skills`,
  `github.com/NousResearch/hermes-agent` — Hermes Agent
- Riuso non ri-derivato: `docs/evidence/spec-skill-md-e-shell-nei-peer.md` (2026-08-08) per i punti
  non ricontrollati qui perché già verificati e non cambiati (progressive disclosure, sicurezza
  Claude API/claude.ai/Claude Code).

## Percorso di produzione ispezionato (Muffin, questo mandato)

`core/skills/skills.ts`, `agent/tools/skill.ts`, `core/rot/guards.ts`, `core/config/workspace.ts`,
`core/policy/decide.ts`, `agent/tools/shell.ts`, `cli/init.ts`, `cli/adopt.ts`, `cli/prompt-show.ts`,
`defaults/skills/studia-un-documento/SKILL.md`, `defaults/skills/collega-telegram/SKILL.md`,
`evals/acceptance/scenarios/d-skills.accept.ts`, `core/skills/skills.test.ts`,
`docs/decisions/0010-standard-esterni.md`.
