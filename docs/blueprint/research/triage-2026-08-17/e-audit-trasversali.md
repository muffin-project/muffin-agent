# Triage — Sezione E, 14 MEDIUM residui, 8 proprietà trasversali

Base: `origin/dev @ 3068ece` (HEAD di questo worktree, dopo merge #52
`slice/fs-containment`). Baseline audit (`b9ab672`) è ancestor di HEAD;
`git diff b9ab672..HEAD` sui file citati dai 24 reperti tocca solo
`agent/tools/fs.ts` (P28/P29) e `core/memory/consolidator.ts` (log E5, non
tocca la logica di P27) — la classificazione "STILL PRESENT" dell'audit per
tutti gli altri file resta valida senza ri-lettura.

**Verifica P28/P29 (CRITICAL+MEDIUM, esclusi dall'assegnazione ma verificati
come richiesto)**: CONFERMATO CHIUSO. `agent/tools/fs.ts:238` `realpathDeepest`
risolve il path reale sia per il target finale (read/list, `terminal:'follow'`)
sia per la directory padre (write, `terminal:'reject'`); commento a riga 229
cita esplicitamente P28. Hard-link rifiutato ora anche in lettura (`nlink > 1`,
riga 344). `resolveInScope` (riga 315) usa questa funzione per entrambi i casi.

---

## 1 · Sezione E — Economia e osservabilità (M5-BIS §E, E1-E6)

### E1 — Budget cap globale e per-job
**Stato: BLOCKER.**
Evidenza: `grep -rn "perJob|per_job|per-job" core/ agent/ cli/` → zero risultati.
`core/budget/budget.ts` ha solo due caps: `monthlyUsd` (globale) e
`perTenantDailyUsd` (esplicitamente non applicato a `host`, riga
`tenantExhausted`: `if (tenant === HOST_TENANT) return false;`). Nessuna
struttura dati job→cap in `core/scheduler/jobs.ts` o `scheduler.ts`. Manca
implementazione, non solo cablaggio: manca il tipo.
Failure 14gg: un job schedulato (`muffin jobs add`, capability Day-1 per
mandato §5) con un goal che innesca un loop costoso (es. l'agente che rilegge
lo stesso documento grande più volte in una singola esecuzione notturna) è
fermato solo dal cap MENSILE — che protegge il mese, non quella notte. Lo
stesso commento del file (`core/budget/budget.ts`) cita un caso reale: "un
echo loop ha bruciato $47 in venti minuti su un sistema comparabile" — il
cap per-tenant-daily esiste apposta per quello, ma è escluso per `host`, e non
esiste alcun cap per singola esecuzione di job.
Journey: proposta #6 sotto (E1+E6+P35).
Costo: **M** — colonna `perJobUsd` su `jobs`, check in `Scheduler.tick()`
prima di eseguire il goal, wiring `BudgetEngine`.

### E2 — Cost: "so quanto costa una giornata?"
**Stato: BLOCKER** (declassato da READY-per-scenario: lo scenario è verde ma
prova meno di quanto la riga chiede).
Evidenza: `evals/acceptance/scenarios/e-cost.accept.ts` E2 (verde) prova solo
che `/spend` (cli/repl.ts:328) stampa `$X / $80 questo mese` — il TOTALE
MENSILE, mai un dato giornaliero. `BudgetEngine.tenantTodayUsd()` esiste
(core/budget/budget.ts) ma è raggiunto solo da `tenantExhausted`, che per
`host` ritorna sempre `false` senza mai leggere il numero — nessun comando
espone la spesa **di oggi** per l'owner. La riga M5-BIS dice letteralmente
"una giornata", non "il mese".
Failure 14gg: owner apre `/spend` a metà di una sessione costosa (molti tool
call, molto contesto) per capire se sta spendendo troppo OGGI e vede solo il
progressivo mensile — nessun segnale se la giornata corrente è anomala
rispetto alle altre.
Journey: estensione naturale dello scenario E2 esistente (stesso file).
Costo: **S** — `tenantTodayUsd('host')` già esiste, serve solo esporlo in
`/spend` e un test.

### E3 — Tracing: "posso ricostruire cosa è successo?"
**Stato: BLOCKER.**
Evidenza: implementazione esiste e **è cablata** — `cli/trace.ts`
(`readSpans`/`formatSpan`), `case 'trace':` in `cli/main.ts:217`, comandi
`muffin trace tail`/`muffin trace grep`. Ma: (a) nessuno scenario di
accettazione (assente da `evals/acceptance/manifest.ts`); (b) gap di
redazione confermato — vedi P34(1)/P34(2) sotto, `core/tracing/tracer.ts:94`
redige gli attributi ma riga 98 scrive `span.error` SENZA passare da
`redactValue`; (c) i risultati dei tool restano in chiaro per sempre in
`turns.messages`/`turn_tool_calls.content` (nessun prune, a differenza delle
trace che un prune ce l'hanno). "Ricostruire cosa è successo" oggi significa
anche "e trovarci dentro un segreto in chiaro", che è l'opposto della garanzia
implicita nel nome del comando.
Failure 14gg: owner debugga un fallimento con `muffin trace grep` (uso
quotidiano previsto per uno strumento costruito apposta) e un errore di rete/
provider che incorpora un header o una query con una chiave finisce in chiaro
nel JSONL — permanente, mai pruned, leggibile da chiunque abbia accesso al
filesystem o incollato altrove dall'owner stesso.
Journey: proposta #2 sotto (in comune con la redazione dei segreti).
Costo: **S** per il redact di `span.error` (one-liner); **M** per il prune/
redazione della persistenza in `turns`.

### E4 — Acceptance test reali
**Stato: READY** (nessuna nuova verifica necessaria — già documentato per
esteso in M5-BIS.md righe 337-376 con le sette condizioni di §3.B citate:
harness contro il binario vero, provider finto deterministico, report
derivato da manifest+M5-BIS, 12 scenari **oggi**, ogni verde visto rosso prima
di essere lasciato verde). Confermato ancora vero su HEAD: `evals/acceptance/`
invariato nel diff dalla baseline audit tranne l'aggiunta di scenari (vedi
`slice/acceptance-truth`, proprietà trasversale #8 sotto).
Journey: n/a — è il meccanismo che prova le altre.
Costo: n/a.

### E5 — Failure: "ogni fallimento importante è esplicito e recuperabile?"
**Stato: BLOCKER** (la riga resta esplicitamente "?" anche nel commento della
stessa suite che la tocca).
Evidenza: `evals/acceptance/scenarios/e-cost.accept.ts` E5 (verde) prova UNA
classe sola — il giudice di contraddizione che risponde in una forma che lo
schema non legge (`non_json`) è ora nominato invece di ripetuto verbatim
(`muffin memory review`) — il file stesso lo dice: *"E5 proves a narrower
thing than its own question... which is why the row stays `?` in M5-BIS.md"*.
Non toccato: fallimento di rete/provider a metà turno, tool che lancia,
delivery fallita, job schedulato che fallisce (P21-2/3/4, già in
slice/lease-fencing — vedi sotto), crash del processo. Ognuno di questi ha
pezzi di evidenza sparsi nelle altre righe (B6 "?", B10 "?", B9 con gap
noti) ma nessuna sintesi che risponda alla domanda **per l'intero sistema**.
Failure 14gg: qualunque delle classi di fallimento non provate (es. il
provider risponde 500 a metà di un turno lungo) — l'owner non ha garanzia
scritta che il fallimento sia visibile e non silenzioso.
Journey: nessuna singola — richiede l'insieme delle journey su B6/B10/D5/D12/
scheduler (fuori dal mio scope diretto, ma le proprietà trasversali #3/#4
sotto ne coprono una fetta consistente: delivery e turno telegram).
Costo: **L** — non è un fix locale, è una sintesi cross-cutting; il costo
reale è capire quali classi mancano ancora dopo che B6/B10/D5 sono chiuse.

### E6 — Act caps: "un singolo turno può fare 200 ricerche web o 200 deleghe?"
**Stato: BLOCKER — confermato con lettura diretta del meccanismo, non solo
sospetto.**
Evidenza: `agent/loop.ts:959` `while (iterations < cap)` — `cap =
iterationCap(deps.profile)` (`agent/profiles/profile.ts:197-199`, valori 15
consumer-local / 30 frontier, tetto duro 40) limita le **iterazioni** (giri di
andata-ritorno col modello), MAI il numero di tool call. Alla riga 1281:
`toolCallsMade += result.toolCalls.length; for (const call_ of
result.toolCalls) { ... }` — TUTTI i `tool_use` che il modello mette in UNA
risposta (tool calling parallelo, supportato dalle API Anthropic/OpenAI-compat)
vengono esaurientemente eseguiti nella STESSA iterazione. `toolCallsMade` è
incrementato ma **mai confrontato con un tetto** (unico altro uso: letto in un
oggetto di stato riga 1165, mai un `if`). Non esiste alcuna "delega"
(subagent/Task tool): `grep -rn "delega|subagent" agent/tools/` → zero — quindi
"200 deleghe" non è raggiungibile per assenza della capability, ma "200
ricerche web" **sì**: nulla impedisce a un modello di emettere 200 blocchi
`tool_use` di `web_search` in una singola risposta ed eseguirli tutti in un
colpo, sforando `maxToolCallsPerTurn` di un ordine di grandezza.
Failure 14gg: web_search è capability Day-1 (D7); un modello confuso o
un'istruzione iniettata in un contenuto tier≥2 che il turno ha già letto (il
`maxTaint:2` amendment lascia `sys.shell`/altri tool leggibili dopo una
lettura) può produrre un batch enorme di ricerche in una singola iterazione —
costo reale (denaro, E1/E2), rumore di rete verso host allowlisted, e proprio
il canale di egress che l'invariante 7 del mandato vuole confinato.
Journey: proposta #6 sotto.
Costo: **S-M** — un tetto su `toolCallsMade` (o sul numero di `tool_use` per
singola risposta) indipendente da `iterations`.

---

## 2 · 14 MEDIUM residui dell'audit (esclusi P28, P29, P19×2, P20, P21×3, P39
già coperti da altre slice/verificati sopra)

Criterio owner: BLOCKER = CHIUDI-PRIMA-DEL-DAY-1 con failure plausibile nei
14 giorni; OUT = POST-GATE-1 con motivo legato alla finestra, mai "è
difficile".

| # | Claim | File:riga | Stato | Failure plausibile nei 14gg (o perché no) | Costo |
|---|---|---|---|---|---|
| P05 | `TurnStore.endToolCall` tipizza `tier` opzionale: se omesso scrive NULL e salta il bump di taint | `core/turns/store.ts:841,850,853` | **BLOCKER** | B5 (resume dopo SIGKILL, READY, uso quotidiano previsto su macOS dev dove il laptop dorme/crasha spesso) passa da questo stesso store. Un tool nuovo o un path che dimentica di passare `tier` scrive NULL silenzioso, la taint del turno resta sottostimata — stessa famiglia del laundering di proprietà trasversale #1, un livello più in basso. `ToolOutcome.tier` è già obbligatorio a monte (ADR-0044) ma `endToolCall` non lo richiede nella propria firma: la garanzia vive nel chiamante, non nel tipo (contrario a ORCHESTRATION.md §15). | S — rendere `tier` obbligatorio nella firma del metodo |
| P04(1) | Kernel egress guarda solo l'host, mai path/query/fragment | `core/policy/decide.ts:178,182,184`; `agent/tools/http.ts:116` | **BLOCKER** | D6/D7 (http/web) sono capability Day-1. Un turno che ha letto contenuto tier 2/3 (Telegram inoltrato, pagina web) può costruire una query verso un host ALLOWLISTED con dati sensibili nei parametri — il kernel approva perché guarda solo l'host. Invariante 7 del mandato lo nomina esplicitamente. | M — ispezionare `policyArgs` per byte tier≥2 prima di consentire, non solo l'host |
| P04(2) | `sys.search` dichiara `resourceKind:'none'`, mai ispezionato dal kernel | `agent/tools/search.ts:57`; `core/policy/decide.ts:155` | **BLOCKER** | web_search è capability Day-1 con `maxTaint:3` dichiarato (STATE.md), ma la query stessa esce dal ramo di ispezione URL per costruzione — zero controllo anche quando il turno è già tainted. Stessa famiglia di P04(1), stesso invariante 7. | S-M — assegnare un `resourceKind` reale o un controllo dedicato |
| P30 | `ExecRequest.allowHosts` inerte: allowlist proxy fissa a `[]`, il campo per-call non la raggiunge mai | `core/sandbox/executor.ts:34,110,132` | **OUT/POST-GATE-1** | Verificato: `grep -rn "allowHosts" agent/ core/ cli/` → SOLO la dichiarazione del tipo e il punto di lettura, **nessun chiamante lo imposta mai** a un valore non vuoto. Fallisce chiuso oggi (nessuna capability Day-1 offre "shell con accesso rete scoped" all'owner), quindi nessun percorso reale dei 14 giorni lo raggiunge: è un campo morto su entrambi i lati, non un buco sfruttabile. Diventa CHIUDI il giorno in cui un tool/CLI verbo prova a impostarlo. | — |
| P27 | Escape hatch `ensureColumn` (ALTER-ADD-COLUMN) esiste solo per `core/memory/store.ts`; `turns`/`jobs` non ne hanno uno | `core/memory/store.ts:170,192` | **BLOCKER** | STILL PRESENT su `dev` (verificato: `grep ensureColumn core/turns/store.ts core/scheduler/jobs.ts` → zero). **Prova non ipotetica**: `slice/lease-fencing` (non ancora mersa, HEAD `b0a9fd3`) ha dovuto generalizzare esattamente questo helper in `core/lock/durable.ts` e usarlo in `core/turns/store.ts` per aggiungere la colonna `claim_token` — la stessa settimana. `core/scheduler/jobs.ts` resta scoperto **anche su quel branch**. Ogni fix che aggiunge una colonna a `turns`/`jobs` durante i 14 giorni (probabile: il repo aggiunge colonne quasi ogni slice) rompe un'installazione già popolata — esattamente il momento in cui l'owner avrà dati veri. | S — generalizzare l'helper (già fatto per metà da lease-fencing) e applicarlo a `jobs.ts` |
| P36 | "hardened" è una probe W_OK a boot-time, non un controllo uid: un chmod stesso-utente declassa `sys.shell` da ASK ad ALLOW silenzioso per tutta la vita del processo | `core/rot/verify.ts:120`; `core/policy/decide.ts:211` | **BLOCKER** | VPS Linux prod: il caso comune è Muffin che gira come proprio uid dedicato, proprietario della propria directory di config — esattamente lo scenario dove un tool call compromesso con scrittura scoped alla propria home (non serve root) può fare `chmod +w` sul file RoT e declassare silenziosamente e permanentemente `sys.shell`. `sys.shell` è già la capability più esposta a taint (maxTaint:2 dopo l'amendment 16/08). Nessun avviso all'owner: il probe rigira solo al boot successivo. | S — confrontare `statSync(path).uid === process.getuid()` oltre al probe W_OK |
| P34(1) | `span.error` scritto DOPO `redactAttributes()`, mai passato da `redactValue` | `core/tracing/tracer.ts:94,98` | **BLOCKER** | Vedi E3 sopra — stessa evidenza, confermata leggendo il file: riga 94 redige gli attributi, riga 98 assegna `span.error` dal messaggio dell'eccezione grezzo. | S |
| P34(2) | Transcript e risultati tool interi in chiaro in `muffin.db` (`turns.messages`, `turn_tool_calls.content`), nessuna scadenza | `core/turns/store.ts:321,346,419,489` | **BLOCKER** | Le righe non si cancellano mai (AGENTS.md, invariante architetturale) — quindi un segreto letto anche una sola volta da `fs_read`/`shell_run` durante i 14 giorni resta in chiaro per sempre nel DB, senza nemmeno il prune che le trace hanno. Con l'uso quotidiano previsto (CLI+Telegram ogni giorno) la probabilità che PRIMA o poi un tool result contenga qualcosa di sensibile è alta, non remota. | M/L — richiede una decisione owner su come redigere senza rompere "le righe non si cancellano mai" (ORCHESTRATION §2: sicurezza/privacy → ci si ferma) |
| P35 | Token di cache-write fatturati a 0.25× invece di 1.25× sull'adapter Anthropic nativo — sottoconteggio 5× | `core/budget/pricing.ts:69,77-86` | **BLOCKER** | Confermato leggendo il codice: il commento del file stesso ammette il bug ("an UNDER-count, in the direction this header calls dangerous... filed, not smuggled in"). I profili usano Claude Sonnet/Opus con prompt di sistema pinnato per il caching (per design, M5-BIS B11/§caching) — cache-write avviene su turni reali ogni giorno, non un edge case. Il cap mensile (E1, READY) è la sola rete di sicurezza dell'owner sul proprio account Anthropic: un sottoconteggio 5× sistematico la rende inaffidabile esattamente nella direzione che conta (scatta più tardi del vero). | S — normalizzare al confine dell'adapter Anthropic (somma dei tre campi usage), come il commento stesso prescrive |
| P37 | `ToolSpec` non ha campo cache: le tool definitions non sono cache-pinned come il system prompt | `agent/providers/types.ts:54-59` | **OUT/POST-GATE-1** | Nessun failure di correttezza o sicurezza: un mancato cache-hit sulle tool definitions costa qualche centesimo in più a turno, non causa comportamento sbagliato, dato perso, o bypass di policy. Il cap mensile (E1) resta un backstop funzionante indipendentemente da questo gap. È un'ottimizzazione di costo, non un blocker dei 14 giorni. | — |
| P10 | `ProactiveKind` è un insieme chiuso solo a compile-time; `decideProactive` non legge mai `trigger.kind`; `firelog.ts` fa un cast non validato da SQLite | `core/scheduler/proactivity.ts:111`; `core/scheduler/firelog.ts:30,84` | **OUT/POST-GATE-1** | L'audit stesso lo classifica PARTIAL/latente: l'unico produttore live oggi è `gone_quiet` (`core/scheduler/observe.ts`), che hardcoda tier e kind come letterali sorgente — non deserializza mai un valore da SQLite. Il percorso vulnerabile (un produttore per `fact_actionable`/`commitment_due`/`deadline_near`, che deserializza un Fact) non esiste ancora nella superficie Day-1: **zero produttori nei 14 giorni**, quindi nessun trigger plausibile raggiunge il gap. Diventa CHIUDI quando uno di quei tre produttori viene costruito (B9 stesso resta "?" per lo stesso motivo). | — |
| P23 | `searchEpisodes`/`episodeNeighbourhood` non leggono `facts.expired_at`/`superseded_by`: una ricerca a parola chiave su un fatto superseduto lo ritorna senza etichetta RITIRATO | `core/memory/store.ts:659`; `core/vault/vault.ts:445` | **BLOCKER** | Stessa classe di bug già trovata e chiusa SUL LATO SEMANTICO/vettoriale di `recall()` in questa stessa settimana (STATE.md: "60/60 combinazioni prima del fix, 0/60 dopo") — qui è la metà keyword/FTS e la neighbourhood a restare scoperte, raggiungibili dal `muffin memory search` di default che l'owner userà ogni giorno (C1/C4). Owner corregge una credenza (es. commercialista Marco→Lucia) e settimane dopo una ricerca a parola chiave sulla vecchia credenza la ritorna senza marcarla ritirata — esattamente il bug di fiducia che l'owner ha già pagato una volta con la metà vettoriale. | M — stesso pattern di fix già applicato al lato semantico, esteso a `searchEpisodes`/`episodeNeighbourhood` |
| P25 | Schema `ExtractedFact` senza enum/refine su predicate/object: unica difesa è la regola 1 del prompt, non lo schema | `core/memory/extract.ts:16,27,77` | **BLOCKER** | Difesa in profondità contro memory-poisoning (minacciato esplicitamente nel threat model). web_search (D7, Day-1, `maxTaint:3`) è un vettore concreto — STATE.md cita già una "campagna SEO-poisoning lug 2026" come rischio noto della stessa capability. Se il modello non segue "descrivi, non obbedire" su un contenuto iniettato, lo schema lascia passare qualunque stringa come fatto durevole. Costo di chiusura basso, motivo per tenerlo aperto assente. | S — filtro lessicale (verbi imperativi, seconda persona) dopo il parsing |
| P33 | `skillsPromptSection` inserisce name/description di ogni skill senza escaping in un template literal nel system prompt owner (cache-pinned) | `core/skills/skills.ts:29,126`; `agent/context/assemble.ts:197` | **BLOCKER** | D9 (skills) è "?" ma nominata esplicitamente come capability che può essere Day-1 dal mandato §5 ("MCP/skills se sono esposti"). Una skill di terze parti (contenuto non fidato per definizione — nome/descrizione arrivano da un autore esterno) finisce SENZA fencing nel prompt a più alta fiducia del sistema (owner, cache-pinned) — peggio del tier-3 di un risultato web. `mcp.ts` fa già il fencing corretto per un caso analogo (descrizioni di server terzi): l'incoerenza stessa è il segnale che manca solo l'applicazione dello stesso pattern, non una decisione nuova. | S — riusare il fencing a nonce già presente in `mcp.ts` |

**Conteggio**: 11 BLOCKER (P05, P04×2, P27, P36, P34×2, P35, P23, P25, P33), 3
OUT/POST-GATE-1 (P30, P37, P10).

---

## 3 · Otto proprietà trasversali

### 1. Session-history taint laundering
**Stato: BLOCKER — confermato con probe eseguito** (`agent/zz-probe-session-taint.test.ts`,
scritto in `agent/`, eseguito con `npx vitest run`, cancellato subito dopo;
`git status` verificato pulito).
Meccanismo: `agent/loop.ts:579` — ogni turno nuovo parte con
`taint: input.principal.kind === 'member' ? 2 : 0`, **derivato solo dal
principal**, mai da cosa contiene la sessione. `buildContext`
(`agent/loop.ts:2019-2050`) legge `deps.sessions.read(input.session)` e
inietta i messaggi user/assistant passati **come testo puro**, senza
`raiseTaint` — a differenza di recall (riga 858-859) e todo (riga 885-886),
che ALZANO la taint del turno in base a ciò che mostrano. `SessionMessage`
(`core/session/store.ts:21-31`) non ha nemmeno un campo tier: l'informazione è
persa nel momento in cui la risposta viene scritta nella sessione
(`sessions.append` a loop.ts:931/1199/1889).
Probe eseguito: turno 1 (owner) chiama un tool tier-3 (`demo_web`), risponde
con testo derivato ("...evil.example"), taint persistita = 3 (confermato).
Turno 2, STESSA sessione, nessuna tool call, testo pulito: taint persistita =
**0**. Confermato che il testo del turno 1 è fisicamente presente nella
richiesta del turno 2 al modello (`provider.seen[2]` contiene "evil.example").
**VERDICT stampato dal probe: LAUNDERED.**
Journey che la proverebbe: proposta #1 sotto (già eseguita come probe isolato,
manca la versione end-to-end attraverso `runTurn`+`SessionStore` reali con
assert nel repo, non nella scratchpad).
Costo: **M** — `buildContext` deve calcolare (o `runTurn` deve leggere) il
tier massimo del contenuto storico reiniettato e alzare la snapshot PRIMA di
qualunque decisione del kernel in quel turno; serve persistere il tier per
messaggio in `SessionMessage` (oggi assente) o derivarlo da `TurnStore` per
`sessionId`.
Dipendenze: stesso meccanismo di P05 (tier facoltativo su `endToolCall`) e
dello stesso invariante del mandato (#2). Priorità massima: è la proprietà
esplicitamente nominata come ipotesi #2 da confutare, ed è confutata in senso
negativo (la proprietà NON regge).

### 2. Agent-output recalled as owner evidence
**Stato: BLOCKER — confermato con probe eseguito** (`core/memory/zz-probe-agent-as-owner.test.ts`,
scritto, eseguito, cancellato; `git status` pulito).
Meccanismo: `episodes.role` include `'agent'` (`core/memory/store.ts:26`).
`core/memory/ingest.ts:261` esclude gli episodi `role==='agent'`
**dall'estrazione di fatti** ("l'agente non può manifatturare le proprie
prove") — ma questo non tocca il RECALL degli episodi grezzi. Ogni episodio,
agente incluso, viene indicizzato **incondizionatamente** in FTS da un
trigger SQL senza filtro di ruolo (`core/memory/schema.ts:57-59`,
`CREATE TRIGGER episodes_ai AFTER INSERT ON episodes`). `searchEpisodes`
(`core/memory/store.ts:637-677`) seleziona `id, content, createdAt, trustTier,
connector, threadKey, supersededAt` — **`role` non è nemmeno nel SELECT**,
strutturalmente scartato. Il rendering della provenienza,
`describeTier(tier, when, surface)` (`core/memory/recall.ts:769-776`), mappa
`tier===0 → 'tu'` — **basato SOLO sulla tier, mai sul ruolo dello speaker** —
usato da tutti e 5 i punti di costruzione di `RecallItem.source`
(righe 446, 501, 535, 604, 673).
Probe eseguito: scritto un episodio `role:'agent', trustTier:0` con una frase
che l'owner non ha mai detto ("sembri sotto pressione..."); chiamato
`recall()` con una query che la trova. Risultato: `source: "tu via cli,
2026-08-17"`. **VERDICT stampato dal probe: CONFLATED.**
Journey: proposta #1 sotto (condivide il fixture con la proprietà #1: stesso
turno che produce sia il laundering di taint sia l'episodio agent-authored).
Costo: **M** — `describeTier` deve ricevere anche il ruolo/speaker
dell'episodio (richiede aggiungere `role` al SELECT di `searchEpisodes` e agli
altri 4 call site, e cambiare la firma per distinguere "tu" da "io (Muffin)"
quando `role==='agent'`), non solo la tier.
Dipendenze: nessuna con le altre proprietà, ma stesso file (`recall.ts`) della
proprietà C4/C5 (provenance, "?" in M5-BIS) — probabile stessa slice.

### 3. Telegram update → exactly one durable turn
**Stato: BLOCKER — confermato con lettura diretta del percorso completo
(non eseguito: richiede mock di TelegramApi + crash injection, valutato
troppo costoso per il budget residuo; il trace statico è comunque
inequivocabile su tre file indipendenti).**
Meccanismo: `telegram_updates.update_id` è PK (`connectors/telegram/updates.ts:31`)
e dedup solo lo STORAGE dell'update (`accept()`, INSERT OR IGNORE) — non la
sua RIESECUZIONE. `drain()` (`connectors/telegram/connector.ts:258-281`)
itera `inbox.pending()`, chiama `await this.handle(incoming)`, e SOLO se non
lancia chiama `markProcessed(stored.updateId, ...)` (riga 272). `handle()`
(righe 330-441) chiama `runTurn(this.deps.loop, {...})` **direttamente**
(riga 359, non `enqueueTurn` — confermato: M5-BIS B2 ha ragione, resta
un'unica chiamata). `runTurn` crea un turno con id **fresco**
(`turn.traceId`, nessuna relazione con `update_id`) ogni volta che viene
chiamato — confermato: `grep -n "update_id|updateId" core/turns/store.ts` →
zero righe. Non esiste ALCUN modo, dato un `update_id` pending dopo un
crash, di scoprire "esiste già un turno per questo update?" — l'unica
durevolezza è `telegram_updates.processed_at`/`failure`, scritta solo alla
fine di `handle()`.
Failure chain: crash in QUALUNQUE punto fra l'inizio di `handle()` (riga 330)
e `markProcessed` (riga 272, nel chiamante) → al riavvio `drain()` rilegge lo
stesso `update_id` ancora pending → chiama `handle()` di nuovo → `runTurn`
crea un **secondo turno indipendente**, richiama il modello da capo, e (se
la prima esecuzione era arrivata fino all'invio) **rispedisce la risposta**
o, peggio, riesegue qualunque tool call non-rerunnable il primo turno avesse
fatto.
Journey: proposta #1 sotto.
Costo: **L** — serve una chiave di idempotenza che leghi `update_id` a un
turno (colonna su `turns` o una tabella ponte), controllata PRIMA di chiamare
`runTurn` in `handle()`, e la migrazione di `enqueueTurn` che B2 lascia
esplicitamente in sospeso per non entrare in conflitto con `slice/superfici`.
Dipendenze: B2 (BLOCKER dichiarato), `slice/superfici` (Deliver/resa in-band).

### 4. Durable result + delivery uncertainty
**Stato: BLOCKER — stesso trace di sopra, letto nello stesso file.**
Meccanismo: dopo che `runTurn` ritorna con un risultato (`result.text`),
`handle()` (righe 407-437) fa `await this.deps.api.sendMessage(...)` per
ogni parte, e SOLO DOPO che tutte le `sendMessage` sono tornate chiama
`this.recordDelivery(result.turnId, 'sent')` (riga 428). Se `sendMessage`
lancia, il catch registra `'failed:...'` e **rilancia** (riga 435-436) — che
risale a `drain()`, lascia l'update pending, e la prossima esecuzione di
`handle()` **rifà tutto da capo incluso il turno**, non solo il tentativo di
invio. Il risultato del turno 1 (già computato, già persistito nella tabella
`turns`) non viene mai riusato per una semplice ri-consegna: non esiste un
lookup "questo update ha già un turno con un `result.text` pronto? mandalo
senza richiamare il modello".
Failure chain: crash ESATTAMENTE dopo `sendMessage` (l'owner ha già ricevuto
il messaggio) ma prima di `recordDelivery`+`markProcessed` → l'update resta
pending → riavvio → secondo turno, secondo giro modello, **secondo
messaggio identico recapitato all'owner** — la cosa che l'invariante 5 del
mandato chiama esplicitamente "non deve richiamare modello/tool solo per
riconsegnare il risultato".
Journey: proposta #1 sotto (stesso scenario della proprietà #3 — sono la
stessa fault-chain vista da due estremi diversi della stessa finestra di
crash).
Costo: **L** — condivide la soluzione con la proprietà #3 (idempotenza per
`update_id`); in più serve che il lookup, se trova un turno già `answered`,
riconsegni `result.text` senza rientrare in `runTurn`.
Dipendenze: identiche alla proprietà #3; B8 (delivery remota, atteso-rosso
in manifest.ts, `slice/superfici`).

### 5. Lock / lease / fencing
**Stato: BLOCKER su `dev`, in chiusura su `slice/lease-fencing` (non
mersa) — citato, non re-investigato per direttiva del brief.**
Evidenza: audit P19(1)/P19(2)/P20/P21(1) tutti HIGH+MEDIUM, "STILL PRESENT"
su `dev` (confermato: nessuno dei file citati tocco nel diff baseline→HEAD).
`slice/lease-fencing` (worktree `agent-ae4998a4bcd5d7ef3`, HEAD `b0a9fd3`,
non mersa in `dev`) ha commit nominati esattamente sui reperti: "lock:
heldBy asks liveness before the wall clock, and every claim carries a
fencing token (P19/P20)", "turns: claim_token fences checkpoint/finish/
suspend, and the loop stops on loss (P19)", "gateway: stillOwner
re-verifies this process's own claim before every effect (P20)", "gateway:
end-to-end test for the mandate's 'job due, gateway asleep' scenario (P21)".
Non ri-eseguiti i test su quel branch (fuori scope, altro worker ci lavora).
Journey: proposta #3 sotto (laptop-sleep durante turno/gateway — già
implicita nei nomi dei commit citati).
Costo: **0 per questo triage** — dipende dal merge di `slice/lease-fencing`;
la sola azione utile qui è confermare che non regredisca rispetto ai probe
P19/P20/P21 già eseguiti dall'audit prima del merge.

### 6. Sensitive bytes → egress/search
**Stato: BLOCKER — vedi P04(1)/P04(2)/P30 sopra (stesso cluster
dell'audit, stesso invariante 7 del mandato).**
Sintesi: il kernel (`core/policy/decide.ts`) ispeziona solo l'host per la
decisione di egress; `agent/tools/http.ts` e `agent/tools/search.ts` non
espongono mai path/query/il corpo della ricerca al kernel come
`policyArgs` ispezionabili — `sys.search` bypassa l'intero ramo dichiarando
`resourceKind:'none'`. `core/sandbox/executor.ts`'s `allowHosts` è un layer
diverso (proxy del sandbox exec) e fallisce chiuso, inerte (OUT, vedi sopra).
Journey: proposta #4 sotto.
Costo: **M** (P04×2, condiviso) + **S-M** (P30, ma OUT per questa finestra).

### 7. Migration da DB popolato
**Stato: BLOCKER.**
Evidenza: nessun comando `muffin update`/upgrade esiste
(`grep "case 'update'" cli/main.ts` → zero). Nessun file di
migrazione/test dedicato nel repo (`find . -iname "*migrat*"` → zero, fuori
da node_modules/worktree). L'unico meccanismo di evoluzione schema è
`ensureColumn` (ALTER-ADD-COLUMN), presente SOLO in `core/memory/store.ts`
(P27 sopra) — `turns`/`jobs`/`todos` non ne hanno equivalente su `dev`.
`episodes.kind` ha un CHECK a 5 valori non alterabile da SQLite (A7, già "?"
in M5-BIS, citato lì). Nessun test che parta da uno schema precedente
realmente popolato (mandato invariante #10: "Day 1 è il momento dopo il
quale reset del dataset non è più un rimedio" — ma oggi reset è l'UNICA via
testata).
Failure 14gg: qualunque fix a `turns`/`jobs`/`todos` durante la finestra (già
successo questa settimana con `claim_token` su `slice/lease-fencing`) non ha
un percorso di upgrade provato sull'installazione REALE dell'owner, che a
quel punto avrà giorni di turni/job veri — la battery di cutover (mandato
§10) lo richiede esplicitamente ("Parti da uno schema realmente precedente e
popolato").
Journey: proposta #5 sotto.
Costo: **M** — generalizzare `ensureColumn` (parzialmente già fatto da
lease-fencing) + UN test che parte da un `muffin.db` con lo schema di
`b9ab672` (pre-lease-fencing) popolato con righe vere, poi applica il codice
HEAD e verifica boot/doctor/turn/memory/scheduler/backup-restore.
Dipendenze: P27, A6/A7 (già "?" in M5-BIS).

### 8. Acceptance expected-red truthful
**Stato: quasi-BLOCKER → in chiusura su `slice/acceptance-truth` (non
mersa) — citato, non re-investigato per direttiva del brief.**
Evidenza: audit P39 (HIGH) "CHANGED BUT STILL PRESENT" su `dev` — il gate di
`report.ts` non controlla mai se una riga READY ha uno scenario
`atteso-rosso` nel manifest; B8/C4 sono READY in tabella con scenari che
PROVANO che sono rotti, exit code non se ne accorge (confermato dall'audit
eseguendo dal vivo `npx tsx evals/acceptance/report.ts`: `process.exitCode=1`
scatta solo da `readyWithoutScenario`, mai dal ramo `atteso-rosso`).
`slice/acceptance-truth` (worktree `agent-ac9a424b4c6e43b0f`, HEAD `9904bc1`,
non mersa) ha commit: "Make the acceptance report fail on a READY row with
an atteso-rosso scenario" (fix diretto di P39) e "Promote B8, C4 and D10 to
verde against the current production path" (le tre righe atteso-rosso
citate dal mandato invariante #9 risultano PROMOSSE su quel branch, non
solo il gate riparato). Non ri-eseguito su questo worktree (altro worker ci
lavora); citato come da istruzione del brief.
Journey: n/a — il fix è il gate stesso (`evals/acceptance/report.ts`).
Costo: **0 per questo triage** — dipende dal merge; verificare al merge che
`npx tsx evals/acceptance/report.ts` esca ≠0 se un READY ha ancora uno
scenario atteso-rosso, e che B8/C4/D10 restino verdi dopo l'integrazione con
`slice/superfici`/`slice/taint-in-ingresso` (che toccano gli stessi
percorsi).

---

## Journey proposte (max 6)

1. **Fault-chain Telegram inbound completa** (copre proprietà #3, #4; B2, B8;
   tocca P21-2/3/4 già in lease-fencing per analogia). Passi: update reale →
   `inbox.accept` → crash iniettato in 4 punti (dopo accept/prima di handle;
   dopo runTurn/prima di sendMessage; dopo sendMessage/prima di
   recordDelivery; dopo recordDelivery/prima di markProcessed) → riavvio →
   `drain()`. Asserisce: **un solo** turno per `update_id`, **una sola**
   consegna Telegram, nessuna riesecuzione di tool non-rerunnable.
   Punto di crash: `process.kill(pid, 'SIGKILL')` reale sul processo
   `muffin`, non un mock — coerente con B5 (già provato così).

2. **Session taint laundering + speaker conflation, end-to-end** (copre
   proprietà #1, #2, P05). Turno 1 owner legge un file/URL tier 2/3 (contenuto
   iniettato) → risposta derivata scritta in sessione E come episodio agent →
   turno 2 stessa sessione, testo pulito → asserisce: (a) taint del turno 2 ≥
   tier massimo del contenuto storico reiniettato; (b) un recall successivo
   dell'episodio del turno 1 non etichetta "tu" se `role==='agent'`.
   Riusa il fixture dei due probe già eseguiti in questa sessione (cancellati,
   ma lo schema è nel corpo di questo file sopra).

3. **Lock/lease sotto sleep del laptop** (copre proprietà #5 — già in corso
   su `slice/lease-fencing`, non duplicare: solo confermare al merge).

4. **Egress non-interference con parametri tainted** (copre proprietà #6,
   P04×2). Contenuto tier 2/3 in contesto → `http_get` con la stringa
   incorporata in query/path verso host allowlisted → `sys.search` con la
   stessa stringa nella query → asserisce: il kernel ispeziona i byte, non
   solo l'host, prima di ALLOW.

5. **Migrazione da DB popolato** (copre proprietà #7, P27, A6/A7). Seed di un
   `muffin.db` allo schema pre-lease-fencing con righe vere in
   `turns`/`jobs`/`episodes`/`facts` → applica codice HEAD → boot → `doctor`
   → un turno → `memory search` → scheduler tick → `backup`+`restore` →
   asserisce: zero errori "no such column", zero perdita di righe.

6. **Act-caps + budget per singola esecuzione** (copre E1, E6, P35). Uno
   script provider finto che risponde con N blocchi `tool_use` paralleli in
   una sola iterazione → asserisce un tetto sul totale di tool call per
   turno indipendente da `iterations`; verifica in parallelo che il costo di
   cache-write sia fatturato 1.25× sull'adapter Anthropic nativo.

## Cosa non ho potuto stabilire

- Non ho eseguito probe per le proprietà #3/#4 (Telegram exactly-once,
  durable delivery): il trace statico attraversa 3 file e converge senza
  ambiguità, ma un mock di `TelegramApi` + crash injection reale (come
  richiesto dal mandato battery §10) non è stato costruito per budget di
  tempo — è la journey proposta #1, non ancora eseguita.
- Non ho verificato se `slice/lease-fencing` e `slice/acceptance-truth`
  passino la loro stessa suite oggi (li ho letti via `git show`/`git log`,
  non ho fatto checkout né `npx vitest run` su quei worktree — non erano nel
  mio scope).
- P34(2) (segreti a riposo in `turns`) è classificato BLOCKER ma la sua
  chiusura tocca l'invariante "le righe non si cancellano mai": è una
  decisione owner (redazione retroattiva? redazione solo in scrittura?), non
  un fix meccanico — l'ho segnalato nel costo (M/L) ma non ho una
  raccomandazione di forma.
- Non ho verificato se altri tool oltre a quelli grepped possano impostare
  `allowHosts` (P30) attraverso un percorso che il grep testuale non copre
  (es. costruzione dinamica del nome del campo) — probabilità bassa, non
  esclusa con certezza assoluta.
- Non ho controllato se `core/scheduler/jobs.ts` su `slice/lease-fencing`
  abbia ricevuto `ensureColumn` in un commit successivo a `b0a9fd3` (ho
  letto lo stato al momento del check, non l'ho seguito nel tempo).
