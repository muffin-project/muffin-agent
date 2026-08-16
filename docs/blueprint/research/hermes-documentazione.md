# Hermes Agent — la documentazione intera, letta contro il nostro codice

```
scritto: 2026-08-15
verificato: 2026-08-16
verificato-contro: origin/dev @ ca29d14 (slice/hermes ne è un merge diretto: stesso tree per ogni file:riga citato) · corpus Hermes via llms.txt/llms-full.txt letto 2026-08-15, non ri-scaricato oggi
modello-strumenti: sito Hermes letto via HTTP pubblico (llms.txt/llms-full.txt), non eseguito; repo letto in loco nel worktree per verificare ogni file:riga. Modello che ha scritto il documento: non registrato.
invaliderebbe: una release di Hermes che cambia i meccanismi qui confrontati (goal-judge/wait, quality gate, checkpoint/rollback, tool-search, deliverable mode, streaming) o una modifica nostra alle righe di M5-BIS.md elencate in §5.
estende: m3-connector-timing-hermes-openclaw-goose.md (2026-08-09) · confronto-harness.md (2026-08-11) — entrambi toccano Hermes di striscio, dentro un confronto più ampio; questo documento lo approfondisce da solo, sull'intera documentazione.
```

> Direttiva owner, 2026-08-15: *«inglobiamo TUTTA questa documentazione cosi da
> poter prendere ispirazione per risolvere varie cose nostre»* →
> `https://hermes-agent.nousresearch.com/docs/getting-started/quickstart`.
>
> **Perché esiste questo documento, e non è un riassunto.** `ORCHESTRATION.md`
> §13 dice che i nostri audit confrontano il codice **coi nostri stessi
> documenti**, e sono quindi strutturalmente ciechi a ciò che non abbiamo mai
> pensato. Lo streaming ci è sfuggito così: B11 e B12 le ha trovate l'owner
> poche ore dopo che `M5-BIS.md` era stato scritto per rendere impossibile
> esattamente quello. Hermes è l'agente personale di Nous Research — **lo stesso
> problema nostro**, risolto da altri, con anni di uso reale sotto. È uno dei
> pochi posti dove guardare **fuori**.
>
> Quindi ogni voce ha tre parti e un verdetto: cosa fanno (con URL e data), cosa
> facciamo noi (con `file:riga` **letto**, non ricordato), e uno di quattro
> giudizi. La categoria che paga il lavoro è `NON CI AVEVAMO PENSATO`, ed è la
> prima sezione.

**Indice.**

- [1 · Cosa ho letto davvero](#1--cosa-ho-letto-davvero) — copertura reale: 21/202 pagine intere, 181/202 cercate, cosa resta fuori e perché
- [2 · NON CI AVEVAMO PENSATO](#2--non-ci-avevamo-pensato) — otto cose che non erano in nessuna nostra lista (§2.1–2.8)
- [3 · Confronto per area](#3--confronto-per-area) — verdetto per area, LORO/NOI/scelta diversa (§3.1–3.11)
- [4 · Cosa NON prendiamo, e perché](#4--cosa-non-prendiamo-e-perché) — nove rifiuti scritti, coi vincoli che li motivano
- [5 · Le righe di M5-BIS.md che questo documento tocca](#5--le-righe-di-m5-bismd-che-questo-documento-tocca) — impatto riga per riga (tabella in Parte II)
- [6 · Le tre cose da adottare per prime](#6--le-tre-cose-da-adottare-per-prime) — ordine di rapporto valore/costo

Chi cerca **«cosa cambia per noi»** va dritto a **§5** (impatto su ogni riga di
M5-BIS.md, con la tabella tecnica in **Parte II**) o a **§6** (le tre priorità
per rapporto valore/costo). Il resto è il ragionamento che ci arriva.

---

## 1 · Cosa ho letto davvero

**Data di lettura: 2026-08-15.** Tutte le citazioni sotto sono a quella data.

Il sito è una SPA Next.js: `sitemap.xml` contiene **due sole URL** (`/` e
`/docs`) e non serve a niente, e le pagine renderizzano server-side ma sono
scomode da raccogliere una a una. La pagina `/docs` però pubblica due endpoint
che risolvono il problema alla radice:

| URL | Esito |
|---|---|
| `https://hermes-agent.nousresearch.com/docs/llms.txt` | HTTP 200 · 17.308 byte · **indice di 100 pagine** con titolo, URL e una riga di descrizione ciascuna |
| `https://hermes-agent.nousresearch.com/docs/llms-full.txt` | HTTP 200 · **3.770.642 byte · 76.225 righe · 202 pagine sorgente** concatenate, ciascuna delimitata da `<!-- source: website/docs/… -->` |

`llms-full.txt` **è** la documentazione intera: 202 pagine contro le 100
dell'indice navigabile, perché include un secondo strato di pagine che la
sidebar non espande (24 pagine `developer-guide/` aggiuntive, 24 guide, 30
adattatori di messaggistica, 20 feature). Le ho raccolte tutte in un colpo, e
questo è il motivo per cui il conteggio qui sotto è onesto: **avere il corpus
non è averlo letto.**

### Letto per intero, in contesto — 21 pagine

`getting-started/quickstart` · `user-guide/security` ·
`user-guide/checkpoints-and-rollback` · `user-guide/features/memory` ·
`user-guide/features/goals` · `user-guide/features/loops` ·
`user-guide/features/heartbeat` · `user-guide/features/deliverable-mode` ·
`user-guide/features/document-extraction` · `user-guide/features/tool-search` ·
`user-guide/features/tool-gateway` · `user-guide/features/kanban-worker-lanes` ·
`user-guide/managed-scope` · `user-guide/which-file-does-what` ·
`user-guide/messaging/index` · `developer-guide/agent-loop` ·
`developer-guide/gateway-internals` · `developer-guide/tools-runtime` ·
`reference/slash-commands` · `reference/cli-commands` · e le sezioni di
`user-guide/configuration` che contano (troncamento dei context file, sicurezza
di `read_file`, **caps di output dei tool**, compressione del contesto, modelli
ausiliari, streaming, guardrail del tool-loop).

### Cercato in modo mirato su tutto il corpus, non letto riga per riga — 181 pagine

Le restanti 181 pagine le ho interrogate con ricerche mirate sul corpus
completo (troncamento, streaming, spesa, systemd/launchd, budget, cost cap,
allegati, overflow) invece di leggerle. **Non affermo nulla su una pagina che
non ho aperto.** In particolare **non** ho letto: i 30 adattatori di
messaggistica uno per uno (Telegram, Discord, Slack e l'indice sì; DingTalk,
Feishu, WeCom, Weixin, LINE, QQ, Yuanbao, SimpleX, Photon, Raft, ntfy,
BlueBubbles, IRC, Teams no), le guide per-provider (Bedrock, Azure Foundry,
Vertex, Gemini, Ollama, MiniMax, xAI), i 15 documenti `developer-guide/*-plugin`,
`nix-setup`, `termux`, `windows-native`, i cataloghi di skill (~90 bundled +
~60 opzionali), `pets`, `skins`, `spotify`, `wake-word`.

### Cosa non sono riuscito a raggiungere

Niente di sostanziale, e lo dico con precisione invece che con sollievo:
`/llms.txt` alla radice, `/docs/llms` e `/docs/llms-full` (senza `.txt`)
rispondono **404** — sono stati tentativi miei sbagliati, non pagine mancanti.
Il `sitemap.xml` è inutile ma esiste. Non ho trovato nessuna pagina citata
dall'indice e assente dal corpus.

### Una nota sul nostro lato

`docs/blueprint/mappa/data-surfaces.json` **non esisteva** sul branch da cui
sono partito (`verifica-23`): vive su `dev`, aggiunto da `2eb7f7e`. Questo
documento è scritto su un branch `slice/hermes` creato **da `origin/dev`**
(`7301e77`), e ogni `file:riga` qui sotto è verificato lì. I numeri di riga di
`agent/loop.ts` in particolare **differiscono** fra i due branch (`runTurn` è a
`:252` su `verifica-23` e a `:285` su `dev`): sono stati ricontrollati uno per
uno sulla base giusta.

### La tensione con «TUTTA», dichiarata

La direttiva diceva «TUTTA la documentazione». Sono state lette per intero
21/202 pagine e raggiunte per ricerca mirata 181/202; sono rimaste fuori da
ogni lettura individuale gli adattatori di messaggistica oltre ai quattro
citati, le guide per-provider, i documenti `developer-guide/*-plugin`, le
guide di installazione per piattaforma e i cataloghi di skill — le categorie
già elencate sopra — perché la loro riga d'indice non tocca la roadmap di
Muffin. È una scelta fatta e dichiarata qui, non un mandato subito a metà.

---

## 2 · `NON CI AVEVAMO PENSATO`

Otto voci. Sono in cima perché sono il motivo per cui questo documento esiste:
non «loro lo fanno meglio», ma «questa cosa non era in nessuna nostra lista».

### 2.1 · Il `wait` non lo chiede il modello: lo decide un giudice che guarda i processi

Noi abbiamo scritto `wait` come primitiva del runtime (`M5-BIS.md` §2:
`WAIT → persisti lo stato → rilascia l'esecuzione → scheduler/evento → riprendi`)
e abbiamo implicitamente assunto che a chiederlo sia **il modello, dentro il
turno**. Hermes lo fa al contrario, e la differenza è architetturale.

Dopo ogni turno un giudice ausiliario riceve tre cose: l'obiettivo, l'ultima
risposta dell'agente, **e il registro dei processi in background dell'agente**
— pid, session id, comando, uptime, output recente, e gli eventuali
`watch_patterns` / `notify_on_complete`. Il giudice risponde con un JSON di una
riga: `{"verdict": "done" | "continue" | "wait", "reason": …}`, e il verdetto
`wait` porta con sé quale attesa: `wait_on_session <id>` (si sblocca quando il
processo esce **o** quando il suo pattern combacia — per un watcher che segnala
a metà corsa e non esce mai), `wait_on_pid <pid>` (solo all'uscita),
`wait_for_seconds <n>` (backoff). Dalla documentazione:

> *«You don't type anything for this — it's the judge's decision, made from the
> process context the loop hands it.»*
> — `https://hermes-agent.nousresearch.com/docs/user-guide/features/goals`, letto 2026-08-15

**Perché a noi manca, e non è la primitiva.** Noi la primitiva `wait` non ce
l'abbiamo (M5-BIS B3, BLOCKER, e il substrato di ADR-0042 la rende costruibile).
Ma quello che manca **oltre** la primitiva è il *decisore*: chi stabilisce che
un turno deve parcheggiare. Se lo lasciamo al modello dentro il turno, la
decisione è tainted come tutto il resto del turno ed è soggetta a
prompt-injection; se la mettiamo in un giudice che legge il registro dei
processi — che è **fatto nostro**, non testo di un terzo — la decisione esce dal
turno e diventa osservabile. Noi il registro dei processi ce l'abbiamo già
(`agent/tools/process.ts:47-48,60-61` — `process_list` / `process_kill`); non l'abbiamo
mai collegato a una decisione di controllo.

**Cosa costa.** Il pezzo di controllo, non il pezzo cognitivo. Un modulo che,
alla fine di un turno, legge `turns` (ADR-0042) + i processi vivi e produce un
verdetto in tre valori. Il giudice LLM è opzionale e va sulla corsia `light`
(`agent/runtime.ts:473-474`): loro dicono ~200 token di output per chiamata. **La
regola che ci serve di più non costa niente**: *fail-open*. Se il giudice
sbaglia o è irraggiungibile il verdetto è `continue`, e il vero freno resta il
budget di turni — un giudice rotto non deve mai incastrare il lavoro.

### 2.2 · Una barriera scaduta non può mai incastrare il loop

Corollario della precedente, e vale da sola. La barriera è persistita
(`SessionDB.state_meta`, sopravvive a `/resume`), ma:

> *«If the PID is already dead when the barrier is set (or dies while parked),
> or the time deadline passes, the barrier clears on the next check — a stale
> barrier can never wedge the loop.»* — stessa pagina, stessa data.

Questa è una **proprietà di sicurezza scritta come invariante**, non una
gestione d'errore. Noi abbiamo esattamente lo stesso pattern altrove e non
l'avevamo generalizzato: il lock del gateway diventa stale dopo 10 battiti
mancati *qualunque sia il pid* (`core/gateway/lock.ts`, e il claim porta
`pid+taken_at`). Il principio — **ogni stato di attesa deve avere una condizione
di rilascio che non dipende da chi l'ha creata** — non è scritto da nessuna
parte nei nostri contratti, e `wait` è precisamente il posto dove ci
morderebbe.

**Cosa costa.** Una riga in `09-contratti-m0-m1.md` e un test. Zero codice
nuovo se `wait` nasce con la regola addosso.

### 2.3 · Il gate deterministico gira **prima** del giudice, e non si rifà se niente è cambiato

Un *quality gate* è un comando di shell che deve uscire 0 prima che l'obiettivo
possa essere dichiarato finito. Tre dettagli, tutti e tre non nostri:

1. **Se un gate fallisce, il giudice LLM non viene nemmeno chiamato** — un gate
   rosso è evidenza deterministica che il lavoro non è finito. L'exit code e la
   coda dell'output (~3 KB) diventano il prompt di continuazione, «so the agent
   iterates against the actual failure instead of a vibe».
2. **Se il workspace non è cambiato dall'ultimo fallimento** — tracciato con un
   *fingerprint git* di HEAD + stato del working tree — il gate **non si
   rilancia**: il fallimento registrato viene rigiocato e il contatore avanza.
   «A stuck agent can't burn wall-clock re-running an identical red suite.»
3. **I retry sono limitati** (3 di default, timeout 5 minuti), e all'esaurimento
   l'obiettivo si auto-mette in pausa.

— `https://hermes-agent.nousresearch.com/docs/user-guide/features/goals`, letto 2026-08-15

**Perché a noi manca.** Il nostro completion-gate è deterministico (aggiunto
nell'audit del 2026-08-06, −31pp nell'ablation GAIA quando manca) ma è *dentro*
il turno e non ha né il fingerprint né il concetto di «l'ambiente non è
cambiato, non riprovare». È lo stesso vuoto di `E4` (acceptance test reali):
non abbiamo un modo per far verificare a Muffin il proprio lavoro con un
comando invece che con un giudizio.

**Cosa costa.** Il fingerprint è `git rev-parse HEAD` + `git status
--porcelain` hashati; fuori da un repo, si rilancia sempre. Il resto è ordine
di esecuzione. È la cosa più economica in tutto questo documento rispetto a
quanto vale.

### 2.4 · Il ritmo si autoregola sul fatto che la risposta sia cambiata

`/loop` ha due cadenze. Con un intervallo esplicito fa quello che fa il nostro
cron. **Senza intervallo**, si auto-ritma: parte da un pavimento (60 s), e
*finché le risposte dell'agente smettono di cambiare* rallenta
esponenzialmente — 2m, 4m, 8m, fino a un soffitto (900 s). Nel momento in cui
una risposta differisce dalla precedente, la cadenza **torna di scatto al
pavimento**. Il confronto è *un digest locale con i timestamp ignorati*: niente
chiamata al modello, «so idle waits cost nothing extra».

— `https://hermes-agent.nousresearch.com/docs/user-guide/features/loops`, letto 2026-08-15

**Perché a noi manca.** Il nostro scheduler ha un tick fisso di 30 s
(`core/gateway/service.ts:57` → `core/gateway/lock.ts` — `TICK_MS =
HEARTBEAT_MS = 30_000`) e i job hanno un cron esplicito
(`core/scheduler/jobs.ts:21-33`). Non abbiamo **nessun** meccanismo in cui la
frequenza di un lavoro dipende da quanto il mondo sta cambiando. E la variante
che conta per noi è la proattività: `muffin observe` decide *se* parlare, mai
*quanto spesso guardare*.

**Cosa costa.** Un digest (hash del testo normalizzato) per job e due numeri in
config. Nessun costo di modello — è il punto. Vale soprattutto per B9, dove 4
dei 5 `ProactiveKind` non hanno produttore: un produttore che si auto-ritma
costa molto meno di uno che gira ogni 30 s.

### 2.5 · Le tick mancate si fondono in una sola

> *«Missed ticks coalesce. If the session was busy (or the process wasn't
> running) through several intervals, you get **one** heartbeat turn, not a
> backlog. The timer re-anchors on every fire.»*
> — `https://hermes-agent.nousresearch.com/docs/user-guide/features/heartbeat`, letto 2026-08-15

**Noi lo facciamo già per il cron, e non lo sapevamo di stare facendo.**
`markRan` ricalcola `nextFire` da *adesso* (`core/scheduler/jobs.ts:195-199`), e
`core/scheduler/scheduler.ts:183` lo chiama **dopo** la consegna — quindi un
processo ucciso non perde lavoro e un processo spento tre giorni non produce
tre giorni di arretrato. È una proprietà giusta, costruita per ragionamento e
mai **nominata**.

**Perché conta che sia nominata.** Perché la stessa proprietà va decisa
esplicitamente per ogni cosa nuova che si sveglia da sola — `wait`, il loop
auto-ritmato, i produttori proattivi — e finché non ha un nome viene ridecisa
da capo ogni volta, a volte male. È il difetto di famiglia di questo repo
(*dichiarato e non collegato*) al contrario: *costruito e non dichiarato*.

**Cosa costa.** Una riga in `09-contratti-m0-m1.md`. Zero codice.

### 2.6 · L'output enorme non si tronca: si versa su file e si consegna la chiamata per rileggerlo

Questa è la risposta a **B12**, ed è più precisa di come l'avevamo formulata.
Quando uno snapshot del browser supera 15.000 caratteri:

> *«…the complete snapshot is saved to `~/.hermes/cache/web/` and the tool output
> includes the file path plus a ready-to-use `read_file` call, so the agent can
> page through the full accessibility tree — including element refs beyond the
> cut — without re-snapshotting.»*
> — `https://hermes-agent.nousresearch.com/docs/user-guide/features/browser`, letto 2026-08-15 (via corpus)

Il dettaglio che fa funzionare la cosa **non è il path**: è la *chiamata già
formata*. Un modello a cui dai un percorso lo ignora o lo sbaglia; un modello a
cui dai `read_file(path="…", offset=…, limit=…)` pronta la esegue.

E c'è un secondo pezzo che ci mancava del tutto: `read_file` con
`file_read_max_chars: 100000` **rifiuta** la lettura invece di troncarla, e nel
rifiuto dice all'agente di usare `offset`/`limit`. Noi facciamo la stessa cosa
per i file >2MB (`agent/tools/fs.ts:235-236`, `PathDenied` con la dimensione
nel messaggio) — quindi la forma la conosciamo — ma non l'abbiamo mai estesa al
caso «il file entra ma inonda il contesto».

**Perché a noi manca, e un difetto che questa lettura ha scoperto.** Il nostro
tetto sui risultati dei tool è `TOOL_RESULT_BUDGET_CHARS = 60_000`
(`agent/loop.ts:57`), applicato prima di ogni richiesta
(`agent/loop.ts:446-447`). Ma `agent/context/compact.ts:90` è
`if (chars <= budget)`: **la cancellazione è per-payload intero, mai parziale**.
Il loop scorre dal più recente, quindi un singolo risultato più grande di 60.000
caratteri fallisce il test alla prima passata e viene sostituito in blocco dal
segnaposto di `compact.ts:55` — *«[risultato di … rimosso dal contesto (N
caratteri) per fare spazio — richiamalo se ti serve ancora]»*. Il modello quel
risultato **non lo vede mai**, nemmeno la testa.

Questo **contraddice ogni cap che abbiamo scritto un livello più sotto**, dove
la forma è sempre testa+coda: `agent/tools/http.ts:197-200` tiene 40k di testa e
la coda con un marcatore; `core/sandbox/executor.ts:51,248-253` tiene testa e
coda intorno a `EXEC_MAX_OUTPUT_CHARS = 30_000`. Il livello del loop butta via
tutto. E `agent/tools/mcp.ts:111-114` **non ha nessun cap**: il risultato MCP
entra intero, quindi è precisamente il tool che più facilmente supera i 60k ed è
quello che sparisce del tutto.

**Cosa costa.** Tre cose separate, tutte piccole: (a) rendere `compact.ts`
testa+coda invece di tutto-o-niente, coerente col resto; (b) un cap su MCP; (c)
il versamento su file — che per noi è **il vault**, che già esiste
(`core/vault/`, con `muffin vault add|reindex`), e questo chiude il cerchio con
la formulazione dell'owner: *«magari quando le cose sono troppo grandi le manda
come file del vault?»*. Sì, e la chiamata per rileggerlo va consegnata insieme.

### 2.7 · Il file prodotto arriva come allegato, e il path sparisce dal messaggio

*Deliverable mode.* Il gateway scandisce la risposta dell'agente per percorsi
assoluti (`/tmp/…`) o home-relativi (`~/…`) con un'estensione supportata, **li
toglie dal messaggio visibile**, e carica il file come allegato nativo. I
percorsi dentro blocchi di codice e code inline sono ignorati, così gli esempi
di codice non vengono mutilati. L'agente non deve fare niente di speciale: genera
il file e nomina il percorso.

Il dettaglio che rivela il pensiero: l'allowlist di estensioni **esclude
deliberatamente** `.py`, `.log` e i sorgenti — *«so the agent doesn't auto-ship
arbitrary source files; if you want to send code to the user, use a code
block.»*

— `https://hermes-agent.nousresearch.com/docs/user-guide/features/deliverable-mode`, letto 2026-08-15

**Perché a noi manca.** `sendDocument` è **scritto e testato e non ha un
chiamante** (`connectors/telegram/media.ts:154-161`, e la stessa cosa è già
registrata come gap in `docs/blueprint/mappa/data-surfaces.json`). L'ingresso
dei media lo abbiamo fatto per bene — allegato → `vault/inbox/` → indicizzato
*prima* che il turno giri, col tier del mittente. **L'uscita no.** È l'altra
metà di B8 e non era in nessuna riga.

**Cosa costa.** Il chiamante esiste già a metà. Ma qui c'è un vincolo nostro che
loro non hanno e va rispettato scrivendolo: mandare è **outward**, e outward ha
il suo gate — `muffin telegram send` è deliberatamente un comando dell'owner e
non un tool del modello. Quindi da noi lo scanner dei path **non può** essere
una scorciatoia che aggira `outward.send`: deve passare dal kernel come
qualunque altra azione verso l'esterno, con la capability dichiarata. E
l'esclusione dei sorgenti dall'allowlist è una regola di *exfiltration* prima
che di eleganza — con `denyRead` che già copre i due store di segreti e la
`.env` (ADR-0039), un canale che spedisce file per riconoscimento di path è
esattamente il posto dove quella difesa va riverificata.

### 2.8 · Una potatura che si impegna solo se recupera abbastanza, perché rompere la cache costa

`proactive_prune_tokens` è una potatura **deterministica, senza LLM**, dei
vecchi payload dei tool, che gira indipendentemente dalla soglia di
compressione. La ragione dichiarata: sui modelli a finestra grande la
compattazione a ~50% non scatta quasi mai, quindi i dump dei tool viaggiano
nella storia e **vengono rispediti a ogni turno**. Ma il pezzo che ci mancava è
il freno:

> *«`proactive_prune_min_reclaim_tokens` (default `4096`) prevents a prune from
> committing unless it reclaims at least that many tokens — a committed prune
> rewrites already-sent history and invalidates the provider's prompt-cache
> prefix, so this gate keeps those cache breaks episodic and amortized (one
> meaningful break, like a compression boundary) instead of firing on every tool
> iteration.»*
> — `https://hermes-agent.nousresearch.com/docs/user-guide/configuration`, letto 2026-08-15

**Perché a noi manca.** `compactToolResults` gira **prima di ogni richiesta**
(`agent/loop.ts:446`), senza soglia di guadagno. Ogni iterazione che attraversa
i 60.000 caratteri riscrive la storia già mandata e **invalida il prefisso di
cache**. Il nostro system prompt è marcato `cache: 'stable'`
(`agent/loop.ts:459` — `system: [{ type: 'text', text:
deps.systemPrompts[turnClass], cache: 'stable' }]`), quindi la cache la stiamo
usando e la stiamo rompendo dal lato dei messaggi senza mai averlo contato. Su un turno con molti tool questo è denaro vero e non compare in
nessuna riga di `E2` («so quanto costa una giornata?»): la risposta oggi è no,
e questa è una delle ragioni.

**Cosa costa.** Un `if` e una costante. È il rapporto costo/beneficio migliore
di tutto il documento.

---

## 3 · Confronto per area

### 3.1 · Superfici — `LORO MEGLIO` (sull'astrazione, non sul numero)

**Loro.** 21+ piattaforme, 19 native al gateway più IRC e Teams via plugin. Gli
adattatori sono plugin sotto `plugins/platforms/<nome>/adapter.py` con
**caricamento differito**: gli SDK si importano solo quando il gateway parte o
consegna, non su un semplice `hermes chat`. Tutti estendono
`BasePlatformAdapter`. La chiave di sessione codifica l'instradamento completo —
`agent:main:{platform}:{chat_type}:{chat_id}` — e la documentazione dice
esplicitamente **«Never construct session keys manually»**. Le piattaforme
sperimentali passano da un adattatore *relay* generico su WebSocket in cui il
connettore **annuncia un `CapabilityDescriptor`**.
(`https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals`,
letto 2026-08-15.)

**Noi.** Due superfici. Non esiste **nessun tipo `Surface`**: è una `string` nuda
sul turno (`agent/loop.ts:252` — `surface: string;`), e l'elenco delle possibili
è letteralmente un array nel sorgente della CLI (`cli/surface.ts:43` — `for
(const id of ['cli', 'telegram'])`). Il default e l'abilitato stanno in config
(`core/config/config.ts:102` — `surfaces: { default: 'cli', enabled: ['cli'] }`),
il cablaggio ha un solo ramo (`cli/surface.ts:191`). La consegna verso un canale
diverso da `cli` **non è cablata**, e diverge: il REPL e `observe` *lanciano*
(`cli/repl.ts:56`, `cli/observe.ts:68` — *«consegna su "…" non è cablata»*), il
gateway *logga soltanto* (`cli/gateway.ts:402`).

**Verdetto: `LORO MEGLIO`.** Non per le 21 piattaforme — quelle sono 21
superfici di attacco e non le vogliamo. Per il fatto che una superficie **è un
tipo con delle capacità dichiarate** invece di una stringa. Da noi
`job.channel` finisce dritto in `surface` (`agent/scheduler-run.ts:48`) senza
che nessuno lo validi — ed è esattamente il gap già registrato in
`data-surfaces.json`: *«`jobs add --channel` accetta qualsiasi stringa senza
validarla contro le superfici abilitate»*.

**Cosa costa adottarlo.** Un `SurfaceId` unione chiusa + un
`SurfaceCapabilities` (può editare un messaggio? può allegare file? qual è il
limite per messaggio? supporta i pulsanti?) + un `Deliver` che dispatcha sul
descrittore. Una giornata, e cancella tre gap già scritti (canale non validato,
consegna non cablata, divergenza REPL/gateway) invece di aggiungere una feature.

### 3.2 · Turno lungo su superficie non-terminale — `LORO MEGLIO`

**Loro.** Tre meccanismi distinti, e la distinzione è il contributo: **indicatori
di digitazione** (attivi di default, configurabili per piattaforma);
**heartbeat visivi** — bolle `⏳ Working — N min` aggiornate ogni pochi minuti;
**progresso dei tool** con visibilità configurabile e default `off` su Telegram
«for mobile-friendliness». Più lo streaming per editing progressivo, sotto.
(`https://hermes-agent.nousresearch.com/docs/user-guide/messaging/`, letto
2026-08-15.)

**Noi.** `runTurn` è sincrono (`agent/loop.ts:285`) e il connettore lo aspetta.
Il pezzo cosmetico c'è (`connectors/telegram/presence.ts`, keepalive dal primo
giorno); quello strutturale no. È M5-BIS **B2**, BLOCKER.

**Verdetto: `LORO MEGLIO`**, e la lettura **cambia la forma del rimedio**. Il
criterio d'uscita che ci eravamo dati (ADR-0035 §revisione: *un turno lungo
torna entro ~500 ms e consegna dopo*) suggerisce un `runTurn` asincrono. Hermes
mostra che non serve: il loro `AIAgent` è anch'esso una chiamata bloccante
(`https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop`, letto
2026-08-15). Quello che hanno è **un canale di progresso ortogonale al turno** —
otto callback (`tool_progress_callback`, `thinking_callback`,
`step_callback`, `stream_delta_callback`, …) — e **una consegna che può
scrivere più di una volta per turno**. È molto meno invasivo che riscrivere il
loop.

**Cosa costa.** Un `onProgress` opzionale in `LoopDeps` e una `Deliver` che
ammette più invii. Non tocca la forma del turno, che è la cosa che M5-BIS dice
di decidere adesso — quindi si può fare **dopo** la forma senza pagare due
volte.

### 3.3 · `wait` e i goal — `SCELTA DIVERSA, ENTRAMBE VALIDE`, e il vincolo che la decide

Il meccanismo l'ho descritto in §2.1–2.3. Qui la domanda dell'owner: **cosa
succede se il processo muore mentre aspetta?**

**La risposta onesta dalla loro documentazione è: lo stato sopravvive, il
risveglio no.** La barriera è persistita in `SessionDB.state_meta` e sopravvive a
`/resume`. Ma per `/heartbeat` scrivono, testualmente:

> *«Firing requires the owning process (CLI session or gateway) to be running;
> for schedules that must survive anything, use cron.»*
> — `https://hermes-agent.nousresearch.com/docs/user-guide/features/heartbeat`, letto 2026-08-15

E la tabella di confronto lo mette in chiaro: `/heartbeat` «State survives
(SessionDB); firing resumes next time the session is driven», cron «Yes — fully
durable scheduler».

**Quindi Hermes ha fatto una scelta a due livelli, deliberata:** ciò che è
legato a una sessione (`/goal`, `/loop`, `/heartbeat`, la barriera di `wait`)
persiste il proprio *stato* ma ha bisogno di un processo vivo per *scattare*;
ciò che deve sopravvivere a tutto va nel cron, che vive fuori da ogni sessione.

**Noi abbiamo solo la metà durevole**, e la abbiamo fatta bene: i job stanno in
SQLite (`core/scheduler/jobs.ts:21-33`), `markRan` è l'unico scrittore di
`next_fire_at` e gira **dopo** la consegna (`core/scheduler/scheduler.ts:183`) —
quindi un processo ucciso non perde lavoro — e al boot c'è un tick immediato,
non uno dopo un intervallo (`cli/repl.ts:253`, `core/gateway/service.ts:377`).
Non abbiamo la metà legata alla sessione.

**Verdetto: `SCELTA DIVERSA, ENTRAMBE VALIDE`. Il vincolo che decide è ADR-0035:
noi abbiamo già stabilito che esiste un processo che vive** (`muffin gateway
run`, che possiede lo scheduler e il lock singleton). Per noi la divisione a due
livelli è **più economica** che per loro, perché il processo lungo esiste per
costruzione. Quindi: `wait` può essere session-scoped e appoggiarsi al gateway,
**a patto che il turno-record di ADR-0042 renda visibile un `waiting` orfano al
boot** — che è esattamente quello che la riga `interrupted` già fa per i turni
morti a metà. La riga da scrivere è: *un `wait` che sopravvive al processo è un
job, e va nello scheduler; un `wait` dentro una sessione muore con la sessione e
lo deve dire*.

### 3.4 · Comandi — `SCELTA DIVERSA, ENTRAMBE VALIDE`, con tre buchi veri

**Loro.** ~60 comandi CLI di primo livello e circa 90 slash command, divisi su
due superfici (CLI interattiva e messaggistica) da un `COMMAND_REGISTRY`
centrale.
(`https://hermes-agent.nousresearch.com/docs/reference/cli-commands` e
`/docs/reference/slash-commands`, letti 2026-08-15.)

**Noi.** 18 voci CLI (16 verbi in un unico `switch` a `cli/main.ts:158-190`, più
`--help` e `--version`), tre alias italiani (`memoria`, `lavori`, `segreto` —
`cli/main.ts:101-103`), e **4 slash command nel solo REPL**: `/new`, `/session`,
`/spend`, `/exit` (`cli/repl.ts:23-32`, gestiti a `:260-280`).

**Cosa hanno loro che manca a noi e conta davvero** — tre, non trenta:

1. **`/context`** — una scomposizione della finestra di contesto per categoria
   (system prompt, definizioni dei tool, regole, indice skill, MCP, subagent,
   memoria, conversazione) contro lo spazio libero. Calcolata **localmente,
   nessuna chiamata al modello, nessun impatto sulla cache**. Noi contiamo i
   caratteri con l'assunzione ~4 char/token dichiarata in un commento
   (`agent/loop.ts:47-52`) e non abbiamo modo di dire *dove* va il contesto.
   Tocca `E2` e `E3`.
2. **`/usage`** — costo, durata, e quando il provider lo espone, **i limiti
   residui dell'account letti dal vivo**. Noi abbiamo `/spend`
   (`cli/repl.ts:276` → `runtime.budget.status()`), che dà il mese e il cap: è
   la metà globale, manca la giornata e manca il residuo lato provider.
3. **`hermes update`** — e questo è un **buco nostro, non una preferenza**: vedi
   §3.9.

**Cosa abbiamo noi che loro non hanno** — e va scritto perché è il nostro
carattere: `muffin memory why` (la provenienza di una credenza; loro hanno
`session_search` e `/journey`, che rispondono «dove l'hai detto», non «perché ci
credi»); `muffin rot verify|reseal` (una radice di fiducia sigillata: loro il
*managed scope* lo difendono con i permessi del filesystem e lo ammettono —
«enforcement is filesystem permissions only»); `muffin config` che deriva le
manopole dall'oggetto `Config` reale e **dice quali sono sigillate**; `muffin
observe` senza `--send`, che è un dry-run del gate di proattività a costo zero;
`muffin trace grep`.

**Verdetto: `SCELTA DIVERSA, ENTRAMBE VALIDE`.** 60 comandi sono un prodotto
diverso, e l'inventario del vecchio Muffin ci ha già insegnato la lezione al
contrario (dei 47 tool, 16 mai invocati, 28 sotto le cinque chiamate in quattro
mesi, sei tool hanno fatto il lavoro). Non inseguiamo il numero. Ma `/context`
e `/usage` sono due comandi, non trenta, e rispondono a due `?` dell'inventario.

### 3.5 · `USER.md` e la memoria dell'utente — `SCELTA DIVERSA`, con due cose che si trasferiscono

**Loro.** Due file in `~/.hermes/memories/`: `MEMORY.md` (2.200 caratteri, note
dell'agente) e `USER.md` (1.375 caratteri, profilo dell'utente). **Li scrive
l'agente**, con un tool `memory` a tre azioni (`add`, `replace`, `remove` — e
**nessuna `read`**, perché il contenuto è già nel system prompt). Iniettati come
**istantanea congelata** a inizio sessione e mai aggiornati a metà, di
proposito, per non invalidare il prefisso di cache. Voci separate da `§`.
Quando il limite è raggiunto il tool **ritorna un errore invece di scartare in
silenzio**, e l'errore contiene le voci attuali e l'istruzione a consolidare
*nello stesso turno*.

Il dettaglio che vale: **l'intestazione nel prompt dichiara la capienza** —
`MEMORY (your personal notes) [67% — 1,474/2,200 chars]`.

Cosa **non** ci mettono, esplicitamente: banalità, fatti facilmente
riscopribili, dump di dati grezzi, effimero di sessione, e **tutto ciò che sta
già nei context file**.
(`https://hermes-agent.nousresearch.com/docs/user-guide/features/memory` e
`/docs/user-guide/which-file-does-what`, letti 2026-08-15.)

**Noi.** Tre file freeform, **tutti scritti dall'owner, nessuno dall'agente**:
`persona.md` (4.803 byte), `rot/identity.md` (dentro la radice di fiducia),
`voice.md` (9.084 byte). Assemblati una volta al boot
(`agent/runtime.ts:543` → `agent/context/assemble.ts`), in quest'ordine per il
turno owner: `persona, identity, voice, skillsSection, WORK_RULES, [safe mode]`
(`agent/context/assemble.ts:154-161`); per il turno di gruppo: `GROUP_PERSONA,
voice, WORK_RULES, [safe mode]` — **senza `identity.md` e senza skill**
(`assemble.ts:189`). Quello che l'agente impara vive in SQLite (fatti, episodi,
entità), non in un file.

**Verdetto: `SCELTA DIVERSA, ENTRAMBE VALIDE`, e il vincolo che la decide è
`chi scrive`.** La loro è scritta dall'agente, e per questo *ha bisogno* di un
tetto, di un gate di approvazione, di una scansione anti-injection e di un
rifiuto dei duplicati. La nostra è scritta dall'owner e non ha bisogno di
nessuna delle quattro. Non è un ritardo: è la stessa scelta che fa `identity.md`
stare **dentro** la RoT.

Ma **due cose si trasferiscono, e una terza scioglie una decisione aperta**:

- **L'intestazione di capienza.** Dire all'agente `[67% — 1.474/2.200]` dentro
  il prompt è ciò che fa avvenire il consolidamento *senza uno scheduler*. Il
  nostro consolidamento è un processo di fondo (ADR-0038 coda d'inattività 20 s
  tetto 12; ADR-0040 drenaggio dello stock); il loro è **un segnale di pressione
  nel prompt**. `LAVORO.md` usa già il loro numero (1.375) come giustificazione
  del proprio budget — questa è la stessa idea, applicata dove il tetto esiste.
- **La regola dell'istantanea congelata, detta a voce.** Loro le dedicano una
  pagina intera (`which-file-does-what`, con la domanda vera dell'utente: *«I
  told it my name mid-session and it acted like it never heard it»*). Noi
  costruiamo il prompt una volta al boot e non lo diciamo da nessuna parte.
- **`memory.write_approval`.** In `LAVORO.md` c'è una decisione owner aperta:
  *«`ricorda` scrive o propone»* — e sappiamo che nel vecchio Muffin quel
  percorso ha fatto il 9,7% dei fatti **decadendo a zero in quattro mesi**.
  Hermes **spedisce entrambe**, come flag di config: `false` scrive libero,
  `true` mette in staging e si rivede con `/memory pending|approve|reject`. Nel
  CLI interattivo le scritture di primo piano chiedono inline (le voci sono
  abbastanza corte da leggersi); ovunque altro — messaggistica, script, e **la
  revisione di fondo** — vengono messe in coda. **Questo non risolve la
  decisione: la ridimensiona.** Non è «scrive o propone», è «scrive, e il gate è
  una manopola», il che è compatibile col nostro `muffin config` sola-lettura
  purché la manopola sia una manopola e non un'API conversazionale.

### 3.6 · Permessi e sicurezza — `NOI MEGLIO` sul kernel, `LORO MEGLIO` sull'interazione

**Loro.** Otto strati. `approvals.mode` con tre valori, e il default è `smart`:

> *«Use an auxiliary LLM to assess risk. Low-risk commands … are auto-approved
> for that command only. Genuinely dangerous commands are auto-denied. Uncertain
> cases escalate to a manual prompt.»*
> — `https://hermes-agent.nousresearch.com/docs/user-guide/security`, letto 2026-08-15

Sotto c'è una *hardline blocklist* che scatta **prima** dello strato di
approvazione e non ha nessun override — né `--yolo`, né `approvals.mode: off`,
né «allow always». Sopra c'è `approvals.deny`, glob definiti dall'utente,
valutati anch'essi prima di yolo. Il prompt CLI ha quattro scelte —
`once / session / always / deny` — con `deny` come default e `always` che
persiste in `config.yaml`. Il timeout è **fail-closed** a 300 s. Le scritture su
percorsi di credenziali (`~/.ssh/`, `~/.aws/`, `auth.json`, `.env` ovunque) sono
**bloccate senza nessun percorso di approvazione**; `~/.ssh/config` è
l'eccezione dichiarata, approval-gated invece che bloccata, perché non contiene
chiavi e modificarla è routine. E ammettono il perimetro:

> *«Write guards apply to `write_file` and `patch` only. The `terminal` tool runs
> as the same OS user and can still `cat` or overwrite denied paths… it does not
> sandbox a hostile or compromised agent.»* — stessa pagina, stessa data.

**Noi.** Un kernel **puro e sincrono**, e il tipo lo dice:
`core/policy/types.ts:117-120` — *«Synchronous and pure: no I/O, no network, no
await»*, `Decide = (req: DecisionRequest) => Decision`. Quattro effetti
(`types.ts:56-60`: `allow` / `ask` / `draft` / `deny`), otto codici di rifiuto
(`types.ts:46-54`), una procedura ordinata di dieci passi
(`core/policy/decide.ts:91-212`) che finisce in uno switch sul rischio:
`low → allow`, `medium → draft` se `reversible === 'undoable'` altrimenti
`allow`, `high → allow` solo se `hardened && owner && taint === 0`, altrimenti
`ask`. Il taint è monotono per costruzione (lo snapshot alza e mai abbassa, e
alzarlo invalida le decisioni memoizzate), i tetti della matrice possono solo
stringersi (`core/policy/matrix.ts:163`, `tighter`).

**Verdetto sul kernel: `NOI MEGLIO`, e va scritto qui perché la questione non
si riapra.** Il loro `smart` mette **un LLM dentro la decisione di permesso**.
Il nostro non può, *per tipo*. E la ragione non è purismo: un LLM nel kernel
significa una decisione di permesso attaccabile per prompt-injection, e la loro
stessa documentazione delimita il modello di minaccia a *«an honest-but-wrong
agent… not a sandbox against a deliberately adversarial process»*. Il nostro
(`03-threat-model.md`) è quello avversariale. Non si baratta.

**Verdetto sull'interazione: `LORO MEGLIO`.** Il nostro `ask` esiste **solo nel
REPL** (trappola già registrata in `LAVORO.md`: «`approve` solo nel REPL»);
headless esce 3. Non abbiamo `once/session/always`, non abbiamo un timeout
fail-closed, non abbiamo un'allowlist che si accumuli. Quattro scelte invece di
due è la differenza fra un gate che si usa e uno che si spegne — ed è
letteralmente la preoccupazione dell'owner in M5-BIS §1: *«se ogni operazione
potenzialmente distruttiva diventa "vuoi che scriva questo file?" ogni cinque
minuti, l'agente diventa inutilizzabile»*.

**Su owner-vs-altri: `NOI MEGLIO`.** Loro lo fanno con allowlist di user id in
`.env` più un sistema di pairing (codici a 8 caratteri, TTL 1 ora, rate limit,
lockout dopo 5 tentativi, `chmod 0600`) — solido, ma è una lista. Da noi la
distinzione è **nel sistema di tipi**: `Principal` è un'unione
(`core/policy/types.ts:11-24`: `owner` / `member` / `system` / `agent`), il
kernel la interroga a `decide.ts:128` (`hostOnly && member` → `principal_forbidden`)
e a `:184`/`:211`, il taint parte da 2 per un `member` e da 0 altrimenti
(`agent/loop.ts` — seed dello snapshot), e il prompt di gruppo **non contiene
`identity.md`** (`agent/context/assemble.ts:189`). Il pairing di Telegram
(`core/config/pairing.ts`, codice a 10 minuti) copre lo stesso terreno del loro.

### 3.7 · Reversibilità — `LORO MEGLIO`, ed è la risposta a §1

Questa è la sezione che sposta più lavoro, perché M5-BIS §1 chiede un modello e
questo è un modello funzionante.

**Loro.** *Checkpoint*: un **unico repo git ombra condiviso** in
`~/.hermes/checkpoints/store/`, con un ref per progetto
(`refs/hermes/<project-hash>`) — il `.git` reale del progetto non viene mai
toccato, e il database di oggetti di git deduplica fra progetti e fra turni. Lo
snapshot si prende **prima** di `write_file`/`patch` e prima dei comandi di
shell distruttivi (`rm`, `mv`, `sed -i`, `dd`, `shred`, i redirect `>`,
`git reset`/`clean`/`checkout`), **al massimo uno per directory per turno**.

E il pezzo che rende il modello coerente con una *conversazione* invece che con
un filesystem: `/rollback N` ripristina i file **e disfa l'ultimo turno di
conversazione**, «so the agent's context matches the restored filesystem
state».

Le guardie, tutte dichiarate: niente git sul `PATH` → checkpoint
trasparentemente disattivati; directory troppo larghe (`/`, `$HOME`) saltate;
oltre 50.000 file saltata; cap per-file 10 MB (per non ingoiare dataset o pesi
di modelli); cap totale 500 MB con caduta round-robin del commit più vecchio;
potatura vera (riscrittura del ref + `git gc --prune=now`); nessuna modifica →
nessuno snapshot; **ogni errore del Checkpoint Manager è non fatale**. Dalla v2
è **opt-in**, perché lo storage nel tempo non è banale.
(`https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback`,
letto 2026-08-15.)

**Noi.** L'effetto `draft` esiste nel tipo — `core/policy/types.ts:59`,
`{ effect: 'draft'; undo: { capability, windowSeconds } }` — e il kernel lo
emette (`decide.ts:205-207`, `windowSeconds: 300`). **Non è eseguibile da
nessun percorso.** M5-BIS **D2** e **D3** sono BLOCKER.

**Verdetto: `LORO MEGLIO`, decisamente,** e la forma risponde alla domanda che
§1 pone. Il modello di §1 è scritto come
`READ → IL MODELLO DECIDE → WRITE → UNDO RECORD → EXECUTE → TRACE`. Hermes
mostra che l'ordine giusto è più semplice: **non chiedere, fotografare.** Un
`draft` non è «proponi e aspetta» — è «esegui, avendo registrato come tornare
indietro». Le quattro classi di §1 sopravvivono intatte: *reversibile* → esegui;
*reversibile ma distruttivo* → **snapshot poi esegui**; *irreversibile* → ASK;
*irreversibile verso l'esterno* → ASK o vietato. Il checkpoint riempie
esattamente la seconda riga, che è quella che oggi collassa su `allow`.

E c'è un collegamento che non avevamo fatto: il nostro `undo` è elencato fra i
comandi del protocollo socket mai costruito (`queue`/`steer`/`heartbeat`/`undo`
— `data-surfaces.json`, `socket.protocol: "not built"`), cioè come un comando di
*controllo del processo*. Hermes lo lega al **filesystem e alla conversazione
insieme**. Sono due cose diverse con lo stesso nome, e la seconda è quella che
D3 chiede.

**Cosa costa adottarlo, e i vincoli nostri che vanno rispettati.**
Meccanicamente è una slice: `git init --bare` in `~/.muffin/checkpoints/store/`,
`git add`/`commit-tree`/`update-ref` per progetto, un hook prima di `fs_write` e
prima dei comandi shell distruttivi. Ma tre vincoli nostri vanno scritti prima:

- **Dati solo in `~/.muffin/`** — rispettato per costruzione (`~/.muffin/checkpoints/`).
- **Non si cancellano mai le righe** — il loro store *lascia cadere* i commit più
  vecchi sotto il cap di dimensione. Non sono righe di database, quindi la regola
  non è violata; ma il cap va **dichiarato** e la caduta va tracciata, altrimenti
  è una perdita silenziosa e ricadiamo nella lezione «i dati ingeriti non devono
  mai sparire per troncamento».
- **Il kernel resta puro** — il checkpoint è un *effetto* di `draft`, non un
  ingresso della decisione. `Decide` non deve sapere che esiste.

### 3.8 · Streaming, output lunghi, allegati — `LORO MEGLIO` su tutti e tre

**Streaming.** Loro hanno due strati separati. Sul CLI, `display.streaming: true`
e opzionalmente i token di ragionamento; se il provider non supporta lo
streaming, **fallback automatico** al display normale. Sul gateway,
`streaming.enabled` (default `false`) + `transport: auto|edit|off`,
`edit_interval: 0.8`, `buffer_threshold: 24`: il bot manda un messaggio al primo
token e poi **lo modifica progressivamente**. Le piattaforme che non sanno
modificare un messaggio (Signal, Email, Home Assistant) sono **rilevate al primo
tentativo** e lo streaming si disabilita per quella sessione «with no flood of
messages». E l'overflow: *«If the streamed text exceeds the platform's message
length limit (~4096 chars), the current message is finalized and a new one
starts automatically.»* I default sono **per piattaforma**: acceso lo switch
generale, Telegram streamma e Discord no, di fabbrica.
(`https://hermes-agent.nousresearch.com/docs/user-guide/configuration`, letto
2026-08-15.)

**Noi.** `stream: false` letterale a `agent/loop.ts:485`. Il campo esiste sul
contratto (`agent/providers/types.ts:107` — `stream: boolean;`) e **nessun
adattatore lo legge**: né `agent/providers/anthropic.ts` né
`agent/providers/openai-compat.ts` referenziano mai `call.stream`. È inerte. Gli
altri tre `stream: false` sono sulla corsia light
(`core/memory/{extract,judge,rerank}.ts`). M5-BIS **B11**, `?`.

**Verdetto: `LORO MEGLIO`,** e la lezione che portiamo via non è «accendiamo lo
streaming»: è che **lo streaming è una capacità della superficie, non
un'impostazione globale**. Il che è la stessa conclusione di §3.1 arrivata da
un'altra strada — due aree indipendenti chiedono lo stesso `SurfaceCapabilities`,
il che è di solito il segnale che l'astrazione è quella giusta.

**Output lunghi.** Loro hanno tre cap dichiarati e configurabili:
`tool_output.max_bytes: 50000` (per il terminale: **tiene il primo 40% e
l'ultimo 60%** con un `[OUTPUT TRUNCATED]` in mezzo), `max_lines: 2000`,
`max_line_length: 2000`. Più `file_read_max_chars: 100000` che **rifiuta** e
istruisce a usare `offset`/`limit`, e una **deduplica delle letture** (stessa
regione, file immutato → uno stub invece del contenuto, azzerata dalla
compressione così l'agente può rileggere). Più `proactive_prune_tokens` (§2.8).
Più il versamento su file (§2.6).

**Noi.** I cap per-tool ci sono e hanno la forma giusta —
`agent/tools/http.ts:65,197-200` (50k, testa 40k + coda),
`core/sandbox/executor.ts:51,248-253` (30k, testa + coda),
`agent/tools/fs.ts:235-242` (rifiuta oltre 2 MB),
`agent/tools/search.ts` (600 caratteri per snippet),
`agent/tools/process.ts` (200 righe). **Ma il livello del loop li contraddice**:
`agent/loop.ts:57` + `agent/context/compact.ts:90` cancellano il payload
*intero* (§2.6), e `agent/tools/mcp.ts:111-114` non ha nessun cap. In più
`agent/loop.ts:1100` tiene solo `user`/`assistant`: i risultati dei tool **non
sopravvivono mai al turno successivo**, quindi «richiamalo se ti serve ancora»
del segnaposto è l'unica strada e non c'è niente da richiamare se il tool non è
idempotente. M5-BIS **B12**, `?`.

**Verdetto: `LORO MEGLIO`.** E questa lettura ha trovato un difetto vero, non
una mancanza: il livello del loop butta via ciò che ogni livello sotto ha
faticato a preservare. Il rimedio più piccolo (testa+coda in `compact.ts`) è
anche quello che rende il resto opzionale.

**Allegati.** Vedi §2.7.

### 3.9 · Installazione e processo — `NOI MEGLIO` su `doctor`, `LORO MEGLIO` (di molto) sull'aggiornamento

**Loro.** Installer via `curl | bash`. **Auto-rilevamento del metodo di
installazione** (checkout git, immagine Docker, path dello store Nix) e
`hermes update` stampa il comando giusto per quel percorso: nessuna variabile
d'ambiente da impostare, la rilevazione è sul layout. E il pezzo che vale:

> *«Post-pull syntax validation + auto-rollback — after the pull, Hermes compiles
> the nine critical files every `hermes` invocation imports at startup. If any
> fails to parse (e.g. an orphan merge-conflict marker, an accidentally
> truncated file), Hermes runs `git reset --hard <pre-pull-sha>` to roll the
> install back so your shell stays bootable.»*
> — `https://hermes-agent.nousresearch.com/docs/getting-started/updating`, letto 2026-08-15

Più: i gateway in esecuzione vengono riavviati **attraverso il service manager**
dopo l'aggiornamento; uno scanner di advisory della supply chain con
`hermes doctor --ack <id>` che persiste il riconoscimento; installazione pigra
delle dipendenze opzionali con allowlist **solo-nome-da-PyPI** (niente
`--index-url`, niente `git+https://`, niente `file:`) così che un `config.yaml`
malevolo non possa dirottare l'installazione.

**Noi.** `install.sh` fa un symlink in `~/.local/bin`, **mai sudo**, con nome a
prova di collisione. `muffin init` è idempotente e dice a voce cosa ha dedotto.
`muffin gateway install` scrive un'unità systemd utente o un LaunchAgent
(`core/gateway/unit.ts:118`). **`muffin update` non esiste**: nessun caso nello
switch di `cli/main.ts`, nessuna modalità di aggiornamento in `install.sh`. È
citato come concetto in `09-contratti-m0-m1.md:182` (*«scritto solo da `muffin
init`/`muffin update`»*) e non esiste in codice.

**Verdetto: `LORO MEGLIO` sull'aggiornamento — noi non abbiamo niente.** Ma
`NOI MEGLIO` su `doctor`: il nostro **esegue** i controlli invece di
constatarne l'esistenza (`cli/doctor.ts:37`, 14 controlli, exit code
`0 | 1 | 2`), che è la disciplina che questo repo ha imparato dall'audit del
2026-08-06 («quattro difese scritte, testate, documentate e collegate a
niente»).

**Cosa costa.** Il rollback post-pull è la cosa da rubare per prima e costa
quasi niente: dopo un `git pull`, compilare i file critici e
`git reset --hard <sha-precedente>` se uno non parsa. È la differenza fra un
aggiornamento sbagliato e una shell che non parte più — e tocca **A6**
(«aggiornare il codice non distrugge dati?»), che oggi è `?` e in realtà è
peggio: il comando non c'è.

### 3.10 · Modelli e costi — `NOI MEGLIO` sui soldi, `LORO MEGLIO` sull'instradamento

**Loro, sull'instradamento.** Un modello principale più una tabella di **compiti
ausiliari** ciascuno instradabile in modo indipendente: `vision`, `web_extract`,
`title_generation`, `compression`, `approval`, `goal_judge`,
`background_review`, `curator`, `triage_specifier`, `kanban_decomposer`,
`profile_describer`. Il default è `auto` = il modello principale, con una nota
onesta sul perché è cambiato («users who paid for an aggregator subscription
would see a different model handling their auxiliary traffic»). Ogni compito
accetta provider, modello, `base_url`, timeout, uno `reasoning_effort`
abbreviato, e una **`fallback_chain` propria**. Più `max_concurrency` sulle
chiamate LLM ausiliarie in tutto il processo.
(`https://hermes-agent.nousresearch.com/docs/user-guide/configuration`, letto
2026-08-15.)

**Loro, sui soldi: non hanno nessun tetto monetario.** Ho cercato
`spend_limit`, `cost_limit`, `budget_usd`, `daily_budget`, `max_cost`, `cost
cap` su tutto il corpus: zero. Quello che hanno sono **cap sull'atto**:
`agent.max_turns: 500` (budget di iterazioni), `goals.max_turns: 20`,
`loops.max_ticks: 100`, e `tool_loop_guardrails` con hard stop opzionali più
`loop_caps` — `max_web_searches: 50` e `max_subagents: 50` **per turno**, con i
contatori azzerati a ogni turno, sempre attivi. Più `/usage` che legge i limiti
residui dell'account dal provider.

**Noi.** `models.main` + `models.light` (`core/config/config.ts:44`); `models.deep`
è **dichiarato nello schema e cablato da nessuna parte**
(`core/config/inventory.ts:53`, «(non configurato)»). Il profilo si sceglie per
glob sul nome del modello (`agent/profiles/profile.ts:183`). `maxOutputTokens:
4096` è **hardcoded** nel loop (`agent/loop.ts:462`); i chiamanti della corsia
light si impostano i propri (1500 / 500 / 200 in
`core/memory/{extract,judge,rerank}.ts`).

Sui soldi siamo l'opposto: un cap mensile **sigillato** di 80 USD e uno
giornaliero per-tenant di 2 USD (`defaults/rot/budgets.json:4-5`, e il commento
dice che il file è l'unica sorgente dei cap — `config.budget` non esiste più,
ADR-0039), letti dal kernel come predicato puro
(`core/policy/decide.ts:145`, `budgetExhausted`), con il turno che si ferma con
`stopped: 'budget'` (`agent/loop.ts:436`). E un dettaglio che è meglio del loro:
**un modello sconosciuto viene fatturato alla tariffa più cara che conosciamo**
(`core/budget/pricing.ts:43` — `UNKNOWN: { inputPerMTok: 15, outputPerMTok: 75 }`),
cioè si sbaglia in modo caro invece che gratis. L'owner è esente dal cap
giornaliero (`core/budget/budget.ts` — `HOST_TENANT` ritorna `false`), e il cap
per-iterazione è un conteggio di giri (`MAX_ITERATIONS_HARD_CAP = 40`,
`agent/profiles/profile.ts:118`), non di token.

**Verdetto sui soldi: `NOI MEGLIO`, e nettamente.** Loro un tetto monetario non
ce l'hanno. Il nostro è sigillato nella RoT e l'agente non può alzarselo. Questa
è una riga da non riaprire.

**Verdetto sull'instradamento: `LORO MEGLIO`.** La nostra `light` è una corsia
sola con tre chiamanti cablati; la loro è un blocco di config per compito. E
questo tocca direttamente due cose di questo documento: il giudice di §2.1 e la
revisione di fondo vogliono **un modello economico dichiarato per nome**, non
«la corsia light se ti ricordi di usarla».

**E qui c'è la cosa che sposta E1.** M5-BIS E1 è BLOCKER perché «il per-job non
esiste», e lo abbiamo sempre inteso come *un tetto in token o in dollari per
job*. Hermes suggerisce una via più economica e più diagnosticabile:
**contare l'atto patologico invece del denaro**. Un turno che fa 50 ricerche web
o genera 50 subagent è già patologico *a prescindere da quanto costa*, e un cap
sul conteggio (a) non richiede di stimare i token prima di spenderli, (b) dice
*cosa* è andato storto invece di *quanto*, (c) è deterministico. Non sostituisce
il tetto monetario — che noi abbiamo e loro no — ma è il pezzo per-job che
manca, e costa un contatore azzerato a inizio turno.

### 3.11 · Skill e progressive disclosure — `NOI MEGLIO` sulla forma, `LORO MEGLIO` sul contenuto

**Loro.** *Tool Search*: quando ci sono molti tool MCP o plugin, i loro schemi
JSON vengono sostituiti da tre tool ponte (`tool_search`, `tool_describe`,
`tool_call`) e caricati su richiesta. I tool **core** di Hermes non differiscono
mai. La scoperta che conta è nella sezione «Why the listing exists»:

> *«Without it, deferred capabilities are invisible — live benchmarking showed
> models substituting visible core tools (running `gh` in the terminal instead of
> searching for the deferred GitHub tool) or declaring a capability nonexistent
> instead of calling `tool_search`.»*
> — `https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search`, letto 2026-08-15

Il rimedio è un *listing*: nome + prima frase della descrizione, sempre
visibile, con gli schemi completi differiti.

**Noi.** È **esattamente il nostro pattern per le skill**, e lo abbiamo azzeccato
per costruzione: `skillsPromptSection` produce una riga «nome — descrizione» per
skill, ed è l'unico contenuto sempre in contesto (~100 token/skill,
`core/skills/skills.ts:124-132`, agganciato a `agent/runtime.ts:546`); il
contenuto vero arriva solo se il modello chiama `skill_read`
(`agent/tools/skill.ts:32-45`), con doppio `realpath` contro le fughe via
symlink e un rifiuto oltre 512KB.

**Verdetto: `NOI MEGLIO` sulla forma** (l'abbiamo per le skill e non abbiamo mai
avuto la tentazione di nasconderle del tutto), **ma il loro dato empirico va
registrato**: nascondere una capacità fa sì che il modello la **sostituisca o la
dichiari inesistente**. È il rovescio esatto di
`knowledge/04-learn-from-absence.md`, e va tenuto per quando i tool MCP
cresceranno.

Con un'ammissione: **non abbiamo nessuna skill installata di default**, e nulla
crea `~/.muffin/skills` all'onboarding (gap già registrato in
`data-surfaces.json`). Loro ne spediscono ~90. La macchina nostra funziona e non
ha ancora un consumatore.

---

## 4 · Cosa NON prendiamo, e perché

Un confronto che dice sì a tutto non è un confronto. Noi abbiamo vincoli che
loro non hanno — **un kernel dei permessi puro, il taint monotono, i dati solo
in `~/.muffin/`, la RoT che può solo stringersi** — e ogni idea che li viola va
rifiutata per iscritto, adesso, così non torna.

**1 · `approvals.mode: smart` — un LLM dentro la decisione di permesso.**
Rifiutato. `Decide` è dichiarato puro e sincrono (`core/policy/types.ts:117-120`)
e questa non è una comodità implementativa: è ciò che rende la decisione non
attaccabile per prompt-injection e riproducibile in un test. Un giudice LLM può
stare **fuori** dal kernel (è precisamente ciò che propongo in §2.1 per `wait`,
dove l'esito è *parcheggia il lavoro*, non *concedi un permesso*). Dentro, mai.

**2 · `--yolo` / `/yolo`.** Rifiutato. Un interruttore di sessione che aggira
ogni approvazione è l'inverso esatto del nostro cricchetto: i tetti stanno nella
RoT sigillata e possono **solo stringersi** (`core/policy/matrix.ts:163`). E c'è
una prova interna che è la forma sbagliata: loro hanno dovuto costruire una
*hardline blocklist* sotto yolo proprio perché yolo era troppo largo. Noi
avremmo la malattia per poi aggiungere la cura. `neverAtRuntime` (`rot.write`) e
`forbiddenForSystem` (`outward.send`, `config.ratchet`) fanno già il lavoro del
loro pavimento, dall'inizio e senza il piano di sopra.

**3 · `security.allow_lazy_installs: true` come default.** Rifiutato *come
default*, non come meccanismo. Installare pacchetti a runtime dal percorso
d'esecuzione dell'agente è la superficie che il nostro hook `PreToolUse` blocca
di proposito (allucinazione di pacchetti sui modelli frontier: 4,6–6,1%,
arXiv:2605.17062). Le loro mitigazioni sono buone — venv-scoped, solo nomi PyPI,
allowlist in-tree, nessun retry silenzioso — ma acceso di default significa che
il caso normale è «l'agente installa». Il nostro caso normale deve restare
«l'agente chiede».

**4 · Gli 8 provider di memoria esterni** (Honcho, Mem0, Supermemory, …).
Rifiutati senza discussione: `AGENTS.md` dice che i dati vivono solo in
`~/.muffin/`, e ognuno di questi spedisce il modello che l'agente ha dell'owner
a un terzo. È la categoria di decisione dove non esiste un compromesso parziale.

**5 · Il Tool Gateway** («one subscription, every tool built in»: web search,
TTS, generazione immagini, browser cloud instradati attraverso l'infrastruttura
di Nous con l'OAuth dell'utente). Rifiutato per la stessa ragione, più una
seconda: la nostra allowlist di egress è **sigillata e vuota di default**
(`defaults/rot/egress.json:4` — «niente esce di default»). Un gateway di tool è
un permesso di uscita permanente verso un host solo, che è la forma di
concessione che quella riga esiste per impedire.

**6 · `GATEWAY_ALLOW_ALL_USERS` e i default ad accesso aperto.** Il loro default
è già deny, e la scala giusta è la loro; ma la *manopola* «apri a tutti» non la
vogliamo nemmeno come opzione. Da noi un principal non-owner è `member` con
taint 2 e un prompt senza `identity.md` — «tutti» non è un valore rappresentabile
e va tenuto così.

**7 · `hermes send` come primitiva outward da script di shell**, che consegna a
una piattaforma «from scripts without spinning up an agent loop». Rifiutato:
`muffin telegram send` è deliberatamente **un comando dell'owner e non un tool
del modello**, perché mandare è azione outward e ha il suo gate. Un percorso di
invio che salta il loop salta anche il kernel. Lo stesso vale per la variante di
§2.7: lo scanner dei path può togliere l'attrito, **non** il permesso.

**8 · Il numero di superfici.** 21 adattatori sono 21 sorgenti di taint e 21
obblighi di consegna. Prendiamo l'astrazione (§3.1) e non il catalogo. Il vecchio
Muffin ci ha già mostrato il costo di una superficie di feature ampia: 16 tool su
47 mai invocati in quattro mesi.

**9 · Il *managed scope* con `.env` a `0644`.** Non ci serve (siamo
single-user) e loro stessi documentano che il file dei segreti gestiti è
leggibile da chiunque sulla macchina. Vale la pena registrarlo solo come
contrasto: la loro pinnatura amministrativa è difesa dai permessi del
filesystem, la nostra RoT dalla sigillatura e dal cricchetto. Sono due modelli di
minaccia diversi e il nostro è quello che abbiamo scelto.

---

## 5 · Le righe di `M5-BIS.md` che questo documento tocca

Nessuna riga cambia stato qui — questo è un documento di ricerca, non una
verifica. Quello che sposta è **la forma del rimedio** e, in tre casi, il fatto
che la riga era ottimista.

La tabella riga-per-riga — impatto su ciascuna voce toccata, con ogni
`file:riga` a sostegno — vive nella zona tecnica per non scriverla due volte
(PRACTICES §13.5): **Parte II, «M5-BIS impact table»**. Il verdetto in una
frase: undici righe si muovono, nessuna chiude da sola — le sette BLOCKER
(B2, B3, B4, B8, D2/D3, E1, E4) restano BLOCKER ma con un rimedio più
economico o più chiaro di quello che avevamo in mente; le quattro `?` (A6,
B11, B12, E2) diventano un disegno nominato o, per B12, un difetto trovato.

### Righe nuove da aggiungere all'inventario

M5-BIS ha una regola: *«se durante il lavoro emerge una lacuna nuova, non si
nasconde: si aggiunge qui»*. Cinque, tutte con la provenienza scritta.

| # | Area | Domanda Gate 1 | Provenienza |
|---|---|---|---|
| **B13** | Progress | Un turno lungo dice di essere vivo, in modo **strutturale** e non cosmetico? | Hermes, indicatori di digitazione + bolle `⏳ Working — N min` |
| **B14** | Attachment | Un file prodotto arriva come **allegato**, o come percorso che l'owner deve copiare? | Hermes, *deliverable mode* |
| **C9** | Pressure | L'agente sa **quanto spazio gli resta** in memoria, dentro il prompt? | Hermes, intestazione `[67% — 1.474/2.200 chars]` |
| **D11** | Checkpoint | Esiste uno **snapshot prima di ogni mutazione**, e un ripristino che disfa anche il turno? | Hermes, *checkpoints and `/rollback`* |
| **E6** | Act caps | Un singolo turno può fare 200 ricerche web o 200 subagent? | Hermes, `loop_caps` |

---

## 6 · Le tre cose da adottare per prime

In ordine di rapporto valore/costo, non di importanza percepita.

1. **La soglia di guadagno sulla potatura del contesto** (§2.8). Un `if` e una
   costante in `agent/loop.ts` / `agent/context/compact.ts`. Oggi ogni
   iterazione che supera i 60.000 caratteri riscrive la storia già mandata e
   rompe il prefisso di cache; è denaro che non compare in nessuna riga. Va
   fatto **insieme** al passaggio da cancellazione-intera a testa+coda (§2.6),
   perché sono lo stesso file e lo stesso difetto visto da due lati.

2. **Il modello a checkpoint per `draft`** (§3.7). È la risposta che M5-BIS §1
   chiede, sblocca **D2 e D3** insieme, e cambia una decisione di design in un
   lavoro di implementazione. La forma da tenere: *non chiedere, fotografare* —
   e il ripristino disfa anche il turno di conversazione, altrimenti il contesto
   dell'agente e il filesystem divergono.

3. **`SurfaceCapabilities`** (§3.1, e di nuovo §3.8 da un'altra strada). Due
   aree indipendenti chiedono la stessa astrazione, il che è di solito il segnale
   che è quella giusta. Cancella tre gap già scritti in `data-surfaces.json`
   (canale non validato, consegna non cablata, divergenza REPL/gateway) invece di
   aggiungere una feature, ed è **una decisione di forma**: per la sequenza in
   testa a M5-BIS («fondamenta riscrivibili → usabile davvero → 14 giorni → open
   source»), viene prima di qualunque feature.

---

# Parte II — technical notes (English, STE)

Per PRACTICES §13.1: facts, contracts, `file:riga`, no modals. Reasoning and
hedges stay in Part I. This section holds the one table dense enough in
`file:riga` to earn the split — the impact table §5 points to — moved here
instead of duplicated.

## M5-BIS impact table

Source: §5 (Italian zone). No row here changes state; this table records how
this document's findings change the shape of the remedy, or the confidence
behind the row.

| Row | State today | Impact |
|---|---|---|
| **A6** Upgrade | `?` | `muffin update` does not exist: no case in the `cli/main.ts` switch (`cli/main.ts:158-190`), no mode in `install.sh`. §3.9 names the cheaper remedy: post-pull syntax validation, `git reset --hard` to the prior sha on failure. |
| **B2** Long-running | BLOCKER, substrate ready | The fix is not an asynchronous `runTurn`. Hermes's own loop is blocking too; it adds a progress channel orthogonal to the turn, plus delivery that writes more than once per turn. Composable with ADR-0042 (§3.2). |
| **B3** Wait | BLOCKER, substrate ready | A judge outside the turn reads the process registry and decides `wait`, not the model inside the turn (§2.1–2.3). Three barrier forms: pid, session+pattern, time. Invariant: a stale barrier never wedges the loop. ADR-0035 makes the session/scheduler split economical here (§3.3). |
| **B4** Todo | BLOCKER | The Hermes answer is not a `todo` tool: a persistent goal, criteria addable mid-run, a deterministic gate (§2.1, §2.3). `goal → plan → todo{…} → resume` (§2) still holds; the exit-0 gate closes the loop, not todo state. |
| **B8** Delivery | BLOCKER | The outbound half is missing. `sendDocument` is written and tested with no caller (`connectors/telegram/media.ts:154-161`). Deliverable mode is the target shape, routed through `outward.send` here (§2.7). |
| **B11** Streaming | `?` | From open question to design. Streaming as a surface capability, not a global setting: progressive edit, per-platform edit-support detection, message-length overflow split. The `stream` field is already on the contract (`agent/providers/types.ts:107`) and no adapter reads it (§3.8). |
| **B12** Overflow | `?` | From open question to a found defect. `agent/context/compact.ts:90` drops the whole payload; every cap below it keeps head and tail instead. `agent/tools/mcp.ts:111-114` has no cap at all. Three-part fix; overflow goes to the vault with the re-read call attached (§2.6). |
| **D2/D3** File write, Undo | BLOCKER | §1 has a working model: snapshot, then act. A shared shadow git repo records state before every mutation; `/rollback` reverts files and the conversation turn together. The "reversible but destructive" class stops collapsing to `allow` (§3.7). |
| **E1** Budget | BLOCKER | The per-job piece counts the pathological act — web searches per turn, subagents per turn, continuation turns — instead of a token ceiling. Deterministic, no pre-spend estimate needed, names the failure mode. Does not replace the sealed dollar cap; Hermes has none (§3.10). |
| **E2** Cost | `?` | An uncounted cost exists. `compactToolResults` runs before every request with no reclaim threshold; every prune invalidates the cache prefix. A `min_reclaim` guard is one `if` (§2.8). |
| **E4** Tests | BLOCKER | Quality gates are the light form of an acceptance test: a command exits 0, runs before the judge, and a git fingerprint skips the rerun when nothing changed (§2.3). |

---

# Cosa non si è potuto stabilire

1. **181 pagine su 202 non sono state lette, solo interrogate.** §1 le
   elenca: gli adattatori di messaggistica oltre a Telegram/Discord/Slack e
   l'indice, le guide per-provider (Bedrock, Azure Foundry, Vertex, Gemini,
   Ollama, MiniMax, xAI), i 15 documenti `developer-guide/*-plugin`,
   `nix-setup`, `termux`, `windows-native`, i cataloghi di skill (~90 bundled
   + ~60 opzionali), `pets`, `skins`, `spotify`, `wake-word`. Non affermo
   nulla su una pagina che non ho aperto (§1); se una di queste tocca la
   roadmap più di quanto l'indice lasci credere, questo documento non lo
   saprebbe.

2. **Hermes non è mai stato eseguito, qui.** Ogni riga di questo documento
   viene dalla documentazione pubblica (`llms.txt`/`llms-full.txt`), letta
   via HTTP pubblico, non da un'installazione provata (blocco di freschezza
   in testa). Se un meccanismo si comporta diversamente da come i `.md` lo
   descrivono, questo documento non se ne accorgerebbe.

3. **I numeri attribuiti a Hermes sono riportati, non misurati.** «~200
   token di output per chiamata» per il giudice del `wait` (§2.1) è quello
   che dice la loro documentazione, non una chiamata cronometrata da noi. Lo
   stesso vale per ogni altro numero preceduto da «loro dicono» in questo
   file.

4. **Le stime «cosa costa» sono dimensionamento a vista, non
   implementazione.** «Una giornata» per `SurfaceCapabilities` (§3.1, §6),
   «~15 righe» per pinnare il modello, e ogni altra cifra simile in §2 e §3:
   nessun rimedio proposto qui è stato scritto o provato. Sono etichettate
   come stima perché lo sono.

5. **Se le categorie escluse davvero non toccano la roadmap è un giudizio
   sull'indice, non sulle pagine.** §1 esclude gli adattatori minori, le
   guide per-provider, i documenti plugin, i setup per piattaforma e i
   cataloghi di skill perché la loro riga di descrizione in `llms.txt` non
   sembra toccare M5-BIS — nessuna di quelle pagine è stata aperta per
   confermarlo.

6. **Il corpus letto è quello che l'indice offre, non necessariamente tutto
   ciò che Nous Research pubblica su Hermes.** `llms.txt`/`llms-full.txt` e
   il sito `/docs` sono stati raccolti per intero (§1); blog, changelog o
   issue pubbliche fuori da quel dominio non sono stati cercati.
