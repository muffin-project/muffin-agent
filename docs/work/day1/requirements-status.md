# Stato dei requisiti DAY-1

> Direttiva owner, 2026-08-15. Due frasi che governano tutto il resto:
>
> **«Non chiamerei ancora questo MVP.»** Abbiamo un **runtime funzionante**, non
> un agente personale che possa sostituire quello che l'owner usa oggi. La
> differenza non è retorica: un runtime lo provi, un agente personale ci vivi.
>
> **La domanda è binaria**: *«esiste qualcosa che mi impedirebbe concretamente
> di vivere 14 giorni usando esclusivamente Muffin?»* Finché la risposta è sì,
> quella cosa entra qui.

## Milestone RETURN TO OWNER — 2026-08-25, decisione owner

La soglia dei quattordici giorni resta il fondo dell'inventario, ma non è più la
prima soglia. Prima viene **RETURN TO OWNER**: rimettere Muffin nelle mani
dell'owner per l'uso quotidiano, con limitazioni note, appena è *sicuro*
accumulare dati e lavoro reali — non appena è *completo*.

RETURN è una **safety threshold, non una completeness threshold**: l'evidence
resta proporzionata alla claim (ORCHESTRATION), senza ricreare DAY-1 in
miniatura. La domanda che classifica ogni blocker è:

> *Se l'owner iniziasse a usare Muffin stasera, questo difetto rende pericoloso
> accumulare dati/lavoro, oppure produce soltanto una limitation/fallback
> osservabile?*

Le righe dell'inventario restano una e una sola volta qui sotto, con il loro
status DAY-1. La milestone aggiunge una classificazione, non un secondo backlog:

- **RETURN** (impedisce la riaccensione sicura): A6, A7, A8 *(minimo: online
  backup + un restore provato; la matrice hot-backup resta dogfood)*, D12
  *(minimo: l'ASK mostra comando+cwd/URL/pid e il motivo del taint su REPL e
  Telegram; un ask non consegnabile fallisce visibilmente, mai in silenzio)*,
  E6, più la **metà foundation** di B2/B16 — l'atterraggio di PR #90: event
  identity exactly-once e fence della delivery; assembler e COLLECT/STEER
  restano dogfood.
- **DOGFOOD** (si chiude durante l'uso reale, non prima): tutte le altre righe
  BLOCKER — quelle di sola evidence (A4, B14, C2, C3, C6, C7, D4, D5, D6, D7,
  D9, E3), il character eval A2/A3, le capability fail-closed o oneste (B1,
  B6, B10, B15, C5, C8, D2, D3, D11, E1, E5, E7) e la semantica busy-input
  (B2/B16, metà restante). Nota di sicurezza verificata sul codice: foto e
  vocali sono archiviati come Evidence integra e dichiarati al turno —
  trascrizione/caption sono derivabili retroattivamente, quindi iniziare prima
  non perde nulla.
- **PUBLIC-ALPHA**: nessuna riga corrente è solo-public; la classe eredita da
  OUT/ROADMAP (gruppi, multi-tenant, extension surface) più la promozione di
  B15-sealing prima di imporre il sistema ad altri utenti.
- **OUT**: invariato.

**Percorso RETURN — le quattro slice sono chiuse (25/08/2026).** S1 la
foundation ingress è atterrata (#90, judge CRITICAL MERGE al giro 1: mutation
testing rosso per la ragione giusta su entrambe le cuciture, doppio invio
riprodotto e fermato con due connessioni reali) · S2 schema lifecycle
(A6+A7+A8-min, #93) · S3 hardening minimo (D12-min+E6, #95) · S4 bring-up del
modello, smoke 3/3 su home temporanea. Resta **solo l'install reale**.
Decisione owner 25/08: **API-first** — modello personale `qwen/qwen3.8-27b`
via OpenRouter (openai-compat); Muffin resta multi-famiglia (qwen / anthropic
/ gpt / gemma) attraverso i due provider esistenti, senza adapter nuovi;
embeddings locali (`qwen3-embedding:0.6b` su Ollama, default già in
`core/memory/embed.ts`) e reranker già cablato in recall. Il character eval è
smoke/evidence, **non gate di qualità** — la scelta provider non tiene Muffin
spento.

**Install reale eseguita il 25/08/2026**, sulla macchina dell'owner: backup
validato prima che il codice nuovo toccasse il database di agosto, `~/.muffin`
migrata (29 tabelle, schema v1), provider OpenRouter con `qwen/qwen3.8-27b`,
recall della memoria di agosto verificato in un turno reale, gateway vivo sotto
launchd con un job schedulato eseguito da solo. Due difetti trovati **solo**
installando davvero: la unit non diceva a launchd dove sta `node` (#101, il
gateway non era mai partito: exit 127 ogni dieci secondi) e `doctor` su una
home non ancora avviata dà un rimedio sbagliato su un database che esiste
(follow-up). Resta il pairing Telegram, che richiede il token dell'owner.

**Regola di stop**: soddisfatti S1–S4, **stop pre-dogfood development** →
install reale → Muffin torna in uso. Voice, immagini, undo, busy semantics e il
resto vengono ordinati dal dogfood (ROADMAP.md#14-day-owner-dogfood), salvo nuove evidenze di
rischio RETURN. Dopo RETURN nessuna nuova astrazione importante senza almeno
uno di: failure osservato nel dogfood · requirement owner già decisa ·
migrazione che diventa costosa rimandandola · rischio concreto di
authority/data/effect correctness.

## La finestra si chiude, ed è questo che ordina il lavoro

Direttiva owner, 2026-08-15: *«le "cose che non devono cambiare" possono ancora
cambiare fino a quando non andiamo opensource, per questo importante partire
dalle fondamenta e rendere muffin usabile per davvero, così da testarlo due
settimane in prod»*.

Quindi l'ordine non è una preferenza, è una **sequenza con una scadenza**:

```
fondamenta riscrivibili  →  usabile davvero  →  14 giorni d'uso  →  open source
        ↑ siamo qui                                                    ↑ la finestra si chiude
```

Oggi cambiare la forma di un turno non rompe nessuno: niente è pubblico, niente
è in produzione. Dopo, la stessa modifica rompe le installazioni di altri, e
quello che oggi è una riscrittura di un pomeriggio diventa una migrazione con
deprecazioni.

**DAY-1 READY è il fondo dell'inventario, non una sensazione.** Il contatore dei
quattordici giorni parte solo con zero `BLOCKER` e zero `?` in questo inventario
e con l'accettazione sulla vera installazione dell'owner. Durante quei giorni il
repo continua a cambiare e i gruppi si costruiscono in parallelo; l'attivazione
dei gruppi aspetta il termine della finestra. Escluderli dall'esperienza non
esclude la loro architettura: ogni lavoro del giorno 1 conserva tenant,
principal, provenance, taint e capability come assi variabili, mai `host` come
forma nascosta.

**Conseguenza pratica sull'inventario**: le righe che sono **decisioni di forma**
vengono prima di quelle che sono **aggiunte di feature**, anche quando una
feature si sente di più. Un turno che non sa sospendersi è una forma; un parser
PDF è una feature. Il parser si aggiunge in qualunque momento; la forma no.

**E anche lo schema è ancora libero — misurato, non supposto.** Il primo taglio
di questa sezione diceva che i dati dell'owner erano il vincolo che restava.
⬤ Contato oggi sul suo `~/.muffin`: **20 episodi, 0 fatti, 0 entità, 0 job**, in
una finestra 11→15 agosto. Sono quattro giorni di prove sull'onboarding — le
tabelle esistono, la memoria no. Una migrazione che oggi costringesse a
`uninstall && init` costerebbe all'owner venti messaggi.

Quindi il vincolo non è «lo schema non si tocca»: è **«lo schema si tocca
adesso»**. Il momento in cui i dati diventano preziosi è il **giorno 1 dei
quattordici** — da lì una migrazione va progettata invece che eseguita, e
`episodes.kind` mostra già il prezzo (un `CHECK` a cinque valori che SQLite non
altera: un `kind` nuovo funziona su un database fresco e rompe ogni
installazione con dentro qualcosa).

Il che stringe la sequenza invece di allargarla: **ogni decisione di schema va
chiusa prima del giorno 1**, non prima dell'open source.

## La regola delle quattro risposte

> **Aggiornata dal triage evidence-only del 17/08** — vedi il blocco in cima
> all'inventario. `?` smette di essere una risposta legittima: era un debito
> travestito da stato, non una quarta categoria.

Ogni riga di questo inventario deve avere **una** di queste quattro, e una
quinta non esiste:

- **READY** — implementata, cablata, provata, e il percorso reale ci arriva.
- **FUORI DAL GATE 1** (`OUT`) — deliberatamente non serve per i 14 giorni,
  **con la ragione scritta**.
- **BLOCKER** — impedisce i 14 giorni.
- **INVALIDATED** — la premessa della riga non regge più: la domanda DAY-1
  che poneva non ha più senso contro il sistema reale, con la ragione scritta
  e cosa la sostituisce.

> **«Non ci avevamo pensato» è la quinta categoria che non esiste, ed è
> precisamente quella che ci ha portati a M5-bis.** Se durante il lavoro emerge
> una lacuna nuova, non si nasconde: si aggiunge qui con una delle quattro
> risposte sopra — mai un `?` lasciato a fare da segnaposto.

## Cosa significa «chiuso»

Un test verde **non** è «chiuso». Chiuso è, per ogni voce:

implementazione · unit test · **integration test** · **cablaggio in produzione**
· **percorso di fallimento** · **scenario di accettazione reale** ·
documentazione e `STATE.md` aggiornati.

È la stessa disciplina del giudice di questo repo: non che il codice *sembri*
corretto, ma che **la garanzia sia raggiungibile dal percorso vero**.

---

## L'inventario

> **Riconciliazione semantic authority 25/08/2026.** Le 55 righe sono state
> rilette contro `dev` dopo PR #88 e ADR-0050/0051/0052. Le righe della tabella
> sono la risposta DAY-1 corrente; i blocchi datati sotto restano evidence e
> cronaca della decisione, ma una formulazione storica non può sovrascrivere la
> riga corrente né `ARCHITECTURE.md`/`SECURITY.md`/ADR. L'ordine vive in
> `day1/critical-path.md`; le deliberate deferral hanno la fase di ritorno
> in `docs/ROADMAP.md`, non in una seconda backlog implicita qui.
>
> **Conteggio: 15 READY · 33 BLOCKER · 7 OUT · 0 INVALIDATED** (55
> righe). **Le fondazioni già integrate restano evidence valida**: WAL
> dell'intento · history senza provenance laundering · egress sui byte · segreti
> fuori dal data plane · forward non-owner-tainted · occurrence schedulate con
> identità durevole. ADR-0052 corregge però la relazione di ingress: event id,
> user intent e Work id non sono la stessa identità; #78 va mediata su questa
> forma prima dell'integrazione, non usata per cristallizzare `update_id=Turn`.

> **Journey di accettazione 02/09/2026 (`dev` 28a0d1b).** Quattro journey sul
> binario vero — lifecycle (#285), memoria/documenti (#283), capability (#284),
> Telegram su gateway vivo con il finto Bot API (#286) — chiudono le diciassette
> righe che aspettavano solo evidence, più la metà Telegram di B1. Ogni scenario
> asserisce su stato (DB, file, chiamate registrate dal server finto, richieste
> al provider finto), e per ciascuna journey almeno una mutazione del meccanismo
> è stata vista far cadere lo scenario. Due limiti dichiarati nelle righe: B6 ha
> il percorso felice provato solo per mutazione (il pavimento SSRF vieta per
> disegno ogni indirizzo che l'harness può legare), A6 esercita `runUpdate` e non
> il binario `muffin update` (che risalirebbe al checkout vero della macchina).
>
> **Riconciliazione dogfood 03/09/2026** (`docs/evidence/dogfood-superfici-2026-09-03.md`).
> ADR-0053 sblocca D11 (soffitto); il dogfood riapre B11 e B13, perché il finto
> provider e il finto Bot API provavano il meccanismo e non la forma che
> l'owner vede; B2 ha la forma decisa (ADR-0054). Da qui ogni riga user-facing
> dichiara se è provata sul finto o sulla corsia **reale** (memo §5.4).
>
> **Conteggio: 34 READY · 15 BLOCKER · 6 OUT · 0 INVALIDATED** (56 righe). I 15
> BLOCKER: B11/B13 (forma dello streaming e dei passi, dogfood), B2/B16
> (busy-input, forma decisa), A2/A3, B10, B15, C5, C8, D6/D7, E1, E5, E6 —
> D11 non è più bloccata dal soffitto e resta per l'undo semantico.

> **Conteggio precedente (02/09): 36 READY · 14 BLOCKER · 6 OUT · 0 INVALIDATED** (56 righe). I 14
> BLOCKER: A2/A3 (character eval), B2/B16 (busy-input), B10 (scenario immagini
> — il finto Bot API non serve `getFile`), B15 (binding nel RoT), C5 (tool di
> provenance), C8 (scenario vocale: stesso limite di B10; i prerequisiti sulla
> macchina dell'owner ci sono), D6/D7 (percorso felice senza provider veri), D11
> (soffitto di `fs.write`, sbloccato da ADR-0053), E1 (per-job), E5 (composite), E6
> (per-capability).

> **Riconciliazione contro HEAD 02/09/2026 (`dev` 4384450).** Le 56 righe
> rilette contro codice, `evals/acceptance/manifest.ts` e il `muffin.db`
> dell'owner. Sette righe raccontavano un HEAD di fine agosto: A6 (il verbo
> `update` esiste), A8 (lo scenario copia la home, non esercita i verbi), B6
> (retry per-tool atterrato), B10 (le immagini arrivano al modello), C8
> (transcriber atterrato, prerequisiti assenti sulla macchina reale), D11 (PR
> #186 chiusa; il soffitto non blocca più, ADR-0053), E7 (il tetto è 15,
> `sys_inspect` è esposto). Nessuna riga cambia status: mancava l'evidence
> del profilo, non il meccanismo.
>
> **Conteggio: 19 READY · 31 BLOCKER · 6 OUT · 0 INVALIDATED** (56 righe).
> Dei 31 BLOCKER, **17 sono «solo scenario mancante»** — A4 A6 A7 A8 · B6 B10
> B13 B14 · C2 C3 C6 C7 · D4 D5 D12 · E3 E7 — e si chiudono per journey, non
> una PR per riga. I 14 restanti aspettano una decisione o un meccanismo: A2/A3
> (character eval), B1 (metà Telegram), B2/B16 (busy-input), B15 (binding nel
> RoT), C5 (tool di provenance), C8 (prerequisiti reali), D6/D7 (percorso
> felice senza provider veri), D11 (undo che riallinea il turno), E1 (per-job), E5
> (composite), E6 (per-capability).

Stato: `READY` · `OUT` (fuori da DAY-1, con ragione) · `BLOCKER` (con cosa
manca e la slice del percorso critico che la chiude) · `INVALIDATED`
(premessa non più valida, con ragione). `?` è ritirato dal 17/08 — le due
eccezioni sopra sono temporanee, non una riabilitazione dello stato.

### A · Installazione e ciclo di vita

| # | Area | Domanda DAY-1 | Stato |
|---|---|---|---|
| A1 | Boot | Muffin parte da solo e recupera lo stato? | READY — accettazione: gateway vero SIGKILLato a metà vita, un secondo processo lo sostituisce e riprende un turno sospeso (`wait`) più un job dovuto, ciascuno consegnato **una sola volta** (righe `turns`/`turns.delivery`/`jobs.last_run_at` provate, non assunte — mutation-testato: `markRan` disattivato a mano rifà partire il job all'infinito e lo scenario va rosso, `evals/acceptance/scenarios/a-lifecycle.accept.ts`), `muffin gateway status`/`doctor` sani prima e dopo, `SIGTERM` drena ed esce `EXIT_STOPPED`. Due gap chiusi con test: `TelegramConnector.run()` riprova `getMe()` con backoff invece di morire una volta sola quando la rete non è pronta al boot (`connectors/telegram/reconnect.test.ts`, rosso confermato pre-fix); `doctor` verifica il **supervisore** (unit/plist al suo posto + enable/linger su Linux o launchd su macOS), non solo il processo (`core/gateway/supervisor.ts`, mai `fail`, sempre un rimedio) — un `muffin gateway run` a mano ora si legge distinto da uno supervisionato. Reboot reale della macchina target = battery §10 di `day1/readiness-criteria.md`, non provato qui. ADR-0035 §Continuità appartiene a Muffin, non al pid. |
| A2 | Identity | Sa chi è e quali limiti ha? | BLOCKER 👤 il contenuto non è più il gap: `identity.md` è testo reale dell'owner da c090dce, sigillata nel RoT, e raggiunge il system prompt reale — provato (`slice/identita` parte 1: `docs/evidence/prompt-assembly-2026-08-17.md`, `muffin prompt show`, wiring test mutati rosso-prima, scenario di accettazione A2 verde contro il binario vero, `evals/acceptance/scenarios/a-lifecycle.accept.ts`). Resta BLOCKER: manca il character eval sui modelli DAY-1 (punto 6 mandato owner — non più «solo owner»: il contenuto è dato, la verifica no) → parte 2 di `slice/identita` |
| A3 | Persona | Il comportamento è definito? | BLOCKER 👤 `persona.md`/`voice.md` sono testo reale dell'owner da c090dce e raggiungono il system prompt reale nell'ordine canonico (persona → identity → voice) — provato: scenario A3 verde, `muffin prompt show` byte-identico a quanto ricevuto davvero dal provider (`evals/acceptance/scenarios/a-lifecycle.accept.ts`). Resta BLOCKER: mancano character eval, cross-model e confronto col vecchio `Muffin.ai` (punti 6-8 mandato owner) → parte 2 di `slice/identita` |
| A4 | Config | Si configura senza toccare il codice? | READY — scenario `A4` verde (`a-lifecycle.accept.ts`, #285): un hand-edit di `config.json` (`models.main`, fuori sigillo) vincola senza reseal — lo dice `muffin config --json` e lo riceve davvero il provider; un hand-edit di `rot/budgets.json` (`monthlyUsd` a 0, dentro il sigillo) vincola **prima** del reseal (il turno vero si ferma con exit 4) mentre `doctor` lo chiama manomissione finché `muffin rot reseal` non lo fa proprio dell'owner. `muffin config` resta read-only per disegno (ADR-0036) |
| A5 | Doctor | Individua **davvero** i problemi? | READY — manomissione reale di `rot/policy.json`, `doctor` la rileva e nomina il file con un rimedio azionabile (`evals/acceptance/scenarios/a-lifecycle.accept.ts:56-94`, verde); ogni check esegue, non assume (`cli/doctor.ts:45-568`) |
| A6 | Upgrade | Aggiornare il codice non distrugge dati? | READY — il verbo `muffin update` esiste (`cli/update.ts`, da 9f56484) e la journey è provata da `A6` (`a-lifecycle.accept.ts`, #285): `runUpdate` — la funzione che `cmdUpdate` chiama — con i soli seam documentati (`moduleDir`, `bindirs`) e tutto il resto vero: git contro un checkout+origin usa-e-getta, `npm ci`, smoke test, `backupNow` su una home popolata; il backup precede lo swap del launcher (invertire l'ordine in `update.ts` fa cadere lo scenario, mutazione verificata) e i dati scritti prima sopravvivono. Limite dichiarato: non si spawna il binario `muffin update` perché `findCheckoutRoot` risale al checkout principale della macchina — un `--dry-run` muterebbe il repo vero |
| A7 | Migration | Lo schema evolve senza perdere memoria? | READY — scenario `A7` verde (`a-lifecycle.accept.ts`, #285): un DB popolato riportato a uno `schema_version` precedente viene migrato dal binario vero (`MIGRATIONS` v2/v3) con righe intatte e backfill applicato (neutralizzare il backfill v3 fa cadere lo scenario, mutazione verificata); un DB marcato **oltre** il codice rifiuta prima di scrivere (`SchemaAheadError`). `rebuildTable` (allargamento di un CHECK) resta provato solo a livello unit: nessuna migrazione di produzione lo chiama ancora |
| A8 | Backup | La memoria si salva e si ripristina? | READY — scenario `A8` riscritto (`a-lifecycle.accept.ts`, #285) sui verbi veri: `muffin backup` produce il file che dichiara con `quick_check`, `muffin restore <file> --yes` mette da parte il DB corrente, ripristina (**sostituisce**, non aggiunge: ciò che è stato scritto dopo il backup non si trova più) e la memoria ante-backup torna trovabile; WAL-safe e SIGKILL provati in `cli/backup.test.ts`. Restano dogfood: matrice hot-backup sotto carico e retention/cron |
| A9 | Setup locale | `muffin init --local` riusa i segreti persistiti per un'installazione pulita di prova? | READY — `muffin init --local [<dir>]` (default `~/.muffin-local`) risolve `home` su quella directory e lascia il passo «api key» leggerlo dalla stessa catena `locateSecret` contro quella home — mai una copia (`cli/main.ts:276-303`); guardia realpath rifiuta un `<dir>` che coincide con la home reale o le sta annidato sotto, anche attraverso un symlink, prima di scrivere qualunque cosa (`cli/init.ts:47-93`, unit test con symlink `cli/init.test.ts`); scenario di accettazione sul binario vero — segreto scritto sul backend persistent isolato dall'harness (mai quello reale), `init --local` lo trova senza copiarlo, `muffin doctor` sano sulla home locale, la home originale invariata (hash prima/dopo), `--local` sulla home reale rifiutato con exit 78 (`evals/acceptance/scenarios/a-lifecycle.accept.ts:293-364`, verde, manifest `evals/acceptance/manifest.ts`) |
| A10 | Giro owner | Il giro dalla macchina pulita alla risposta — install, gateway supervisionato, conversazione, uninstall pulito — funziona nell'ordine reale, uno dietro l'altro? | READY — uno scenario solo, sull'ordine reale che l'owner digita (`evals/acceptance/scenarios/e2e-giro-owner.accept.ts`): `muffin init` (config/db/RoT sigillato asseriti, non assunti) → `secret set --persist` avvisa che la home ha la precedenza (`SECRET_BACKENDS`, `core/config/config.ts`) e nomina la copia vincente → `muffin doctor` con ogni WARN dichiarato e nominato per questo punto del giro (`root of trust mode: single-user`, `vector index`, `consolidamento`, `gateway` — nessuno di questi un `fail`) e la riga `api key` risolta a una sola copia dopo il doppione → `muffin gateway install`: la unit passa il parser della piattaforma vera (Linux: `systemd-analyze verify`, gated `MUFFIN_REQUIRE_SYSTEMD` come `core/gateway/unit.test.ts`; macOS: `plutil -lint` sul testo di `planUnit()` chiamato **direttamente con un `homeDir` di scratch**, mai passando per `cli/gateway.ts`, che su questa piattaforma deriva il percorso da `homedir()` reale — la label `ai.muffin.gateway` è quella del gateway vivo dell'owner su questa stessa macchina, e lo scenario non scrive mai in `~/Library/LaunchAgents` né invoca `launchctl`) — la gamba non eseguibile sulla macchina corrente lo dichiara (asserzione, non solo commento) invece di saltare in silenzio → gateway vero (`inst.gateway()`), `muffin gateway status` lo vede → pairing Telegram sul binario vero (`evals/acceptance/telegram.ts`, come i scenari `b-*`) e un turno reale consegnato (`turns.delivery = 'sent'`, non solo stdout) → un episodio tenant-scoped registrato e ripescato da un secondo processo `muffin run` (pattern C1) → `muffin uninstall --yes` (stdin, mai `rm`): la home sparisce, il segreto `--persist` sopravvive (ADR-0039), quello in home no. Sotto i 30s (tick del gateway accelerato, nessun poll a spawn ripetuto). Nota onesta: la gamba «il supervisore lo tiene davvero su» è provata da Linux, non da questa macchina — macOS valida solo il testo della unit, mai il supervisore reale. |

### B · Continuità del runtime

| # | Area | Domanda DAY-1 | Stato |
|---|---|---|---|
| B1 | Conversation | CLI e Telegram condividono **davvero** sessione e memoria? | READY — scenario CLI `B1` (`b-continuity.accept.ts`) più la metà Telegram è ora provata (`b-telegram-journey.accept.ts`, #286, `it()` non nel manifest perché la riga ha già lo scenario CLI): un fatto detto su Telegram attraverso il gateway (turno con `session_id = telegram:<chatId>`) arriva via memoria a un secondo processo CLI. Le sessioni restano distinte per costruzione; il collegamento è la memoria tenant-scoped, ed è dichiarato |
| B2 | Busy work | Una Surface continua a ricevere durevolmente mentre Work è vivo, e l'input successivo può diventare `COLLECT` / `STEER` / `FOLLOWUP` / `INTERRUPT` a un safe boundary? | BLOCKER — **forma decisa il 03/09 (ADR-0054) e meccanismo su `dev`** (`slice/busy-input`): il poller Telegram riceve sempre (`connector.ts#controlla` + `scheduleDrain`, non più `await this.drain()`), un messaggio a turno vivo è confermato «in coda» e risposto dopo, `/stop` aborta il turno vivo della chat (anche a metà chiamata al modello: `AbortError` → `aborted`, prima finiva `error`), `/steer` entra al confine di giro come messaggio dell'owner e resta nel transcript, `/pause`/`/resume` sono una riga durevole (`core/runtime/pausa.ts`) letta da scheduler e corsia dei turni di ogni processo. Provato: `agent/steer.test.ts`, `agent/comandi.test.ts`, `core/runtime/pausa-corsie.test.ts` (mutation-worthy), `connectors/telegram/busy.test.ts` attraverso `run()` vero, e sul binario vero `b-busy.accept.ts` (manifest B2). **Manca la prova reale** (memo §5.4) e la coda del terminale (ADR-0054 emendamento §6). Prima: **REFRAME + MECHANISM/CRITICAL**: la durable Turn/lane/wait machinery esiste, ma la vecchia chiusura “cambia una chiamata `runTurn` in `enqueueTurn`” non prova più la claim. ADR-0052 richiede separare receipt, composition e Work; l'amendment non può fingere che un Effect già started non sia avvenuto → PC 1.2/1.3 |
| B3 | Wait | Può aspettare **senza bloccare il runtime**? | READY — `wait` sospende la riga e RILASCIA il runtime; la corsia del gateway la risveglia, e `doctor` avverte se non ne gira nessuna |
| B4 | Todo | Mantiene lavoro multi-step persistente? | READY — tabella `todos` con `tier`, letta nel contesto di **ogni** turno della sessione |
| B5 | Resume | Se muore a metà, riprende? | READY — accettazione: processo vero ucciso con SIGKILL a metà turno, riprende al riavvio |
| B6 | Retry | Se fallisce una tool call, recupera? | READY — retry per-tool (`eseguiConRitentativi`, `agent/loop.ts`, `MAX_TOOL_RETRIES=2`; `http.ts`/`search.ts` marcano transienti/5xx) provato da `agent/tool-retry.test.ts` (unit) e, sul binario vero, da `b-retry.accept.ts` (#284): un `http_get` verso `127.0.0.1` allowlistato è fermato dal pavimento SSRF (`core/net/egress.ts` `isForbiddenAddress`) e registrato **una** volta — e togliendo quel pavimento (mutazione) il 503→200 arriva davvero al modello: il percorso felice è provato per mutazione, non ripetibile in CI perché l'harness può legare un server solo a indirizzi che il pavimento vieta per disegno |
| B7 | Scheduler | I job sopravvivono al riavvio? | READY — l'identità dell'occorrenza è chiusa (`slice/job-fires`, ADR-0035 emendamento №5). `job_fires` (`core/scheduler/job-fires.ts`, additiva, `(job_id, scheduled_for)` UNIQUE) lega ogni occorrenza dovuta a UN `turn_id`: `agent/scheduler-run.ts`'s `makeJobRunner` lo lega **prima** di chiamare il modello, e risolve un fire già legato (turno `done` → recupera testo/settle senza richiamare il modello; `runnable`/`running`/`waiting`/`interrupted` → cede alla corsia dei turni). `core/scheduler/scheduler.ts` guadagna due esiti (`FireDeferred`, `FireSettleOnly`) e un `settleFire` chiamato **prima** di ogni `markRan`, mai dopo. Matrice dei sette punti dell'owner, provata: i cinque interni con lo store/il runner reali (`core/scheduler/job-fires.test.ts`, `agent/scheduler-run.test.ts`, `core/scheduler/scheduler.test.ts` — quest'ultimo con la mutazione dell'ordinamento eseguita a mano, osservata rossa, ripristinata); i due che il mandato chiede col binario vero — crash fra il binding e la creazione del turno, e turno `done` prima di `markRan` — provati da `evals/acceptance/scenarios/job-fires.accept.ts` (riga B7 del manifest), due `SIGKILL` reali su `muffin gateway run` nelle due finestre (rese osservabili da `MUFFIN_JOB_FIRES_STALL_*`, stesso precedente di `MUFFIN_GATEWAY_TICK_MS`), verificato anche contro due mutazioni a mano (identità ignorata del tutto; bind interrotto completato con un id nuovo invece di quello legato) entrambe rosse per la ragione attesa. La proprietà resta occurrence→Work idempotente; ADR-0052 vieta di generalizzarla in “ogni transport event deve avere un Turn proprio”. Telegram riusa le primitive di idempotenza in #78, ma sotto event→composition→Work. |
| B8 | Delivery | Un job che dice «inviato» è **arrivato**? | READY — canale non connesso → `failed:<why>`, mai `sent`, e `doctor` lo nomina ⚠️ nota sotto |
| B9 | Proactivity | Agisce spontaneamente secondo i gate? | OUT — post-DAY-1: nessuna capability §5 dei 14 giorni dipende da trigger proattivi; `ProactiveKind` ha oggi 4 valori (non 5, `consolidation` rimosso da ADR-0038), solo `gone_quiet` ha un produttore reale (`core/scheduler/observe.ts:109,128`) ed è cablato ma solo su invocazione manuale (`muffin observe --send`); i tre mancanti (`commitment_due`, `deadline_near`, `fact_actionable`) restano fuori finché non emerge un consumer reale → `docs/ROADMAP.md` “Proactivity beyond explicit jobs” |
| B10 | Telegram | Messaggi, file, immagini, **errori** | BLOCKER — solo scenario mancante: messaggi e documenti ok (provato, vedi C7); **le immagini arrivano al modello** (`ImageBlock` in `agent/providers/types.ts`, `ingest()` di `connectors/telegram/connector.ts` → `images:` del turno, da b815751 del 28/08; il vault non le indicizza per scelta — si mostrano, non si trascrivono in testo); errori gestiti a pezzi, non come proprietà unica; nessuno scenario dedicato → PC 3.6 (riconciliato il 02/09: la riga diceva «nessun content-block immagine»). **03/09**: i file *documento* non arrivavano affatto in memoria in produzione — stesso difetto della nota C7/B10/C8 |
| B11 | Streaming | La risposta arriva mentre si forma, o solo alla fine? | BLOCKER — **riaperta il 03/09 dal dogfood** (`docs/evidence/dogfood-superfici-2026-09-03.md` §1–2): il meccanismo sotto è vero e resta, ma la forma che l'owner vede no — il preambolo di una tool call viene azzerato dal draft al `boundary`, oltre 4096 resi il draft si congela, e la prova era sul finto provider che risponde in un colpo solo. Chiude con «una bolla per segmento» (memo §5.1) provata sulla **corsia reale** (memo §5.4), non solo sul finto. **Meccanismo su `dev`** (`slice/telegram-segmenti`): `connectors/telegram/transcript.ts` sostituisce `progress.ts` — il preambolo passa al `boundary` in un messaggio vero, i passi si appendono sotto, niente si cancella, oltre 4096 si apre il segmento dopo, il contatore scorre da solo; provato su `transcript.test.ts`, `streaming.test.ts` (cablaggio per `buildRuntime`) e sul binario vero (`b-telegram-journey.accept.ts` B13). Manca la prova reale. Storia della riga, valida per il meccanismo: era READY per CLI/REPL e per le chat private Telegram (`slice/streaming`, due PR verso `dev`) — nei gruppi Telegram resta la presenza effimera `sendChatAction` e la risposta arriva alla fine; Discord resta OUT (B17). Entrambi gli adapter honorano `ChatCall.stream` (`Provider.chatStream`, SDK ufficiali, non SSE fatto a mano); il loop bufferizza i delta per giro e li rilascia solo per quello che risponde davvero (mai durante una tool call — un giro nudged dal completion gate non trapela il suo bozzone). REPL: stampa progressiva byte-identica a fine turno, `--no-stream`. Telegram privata: bozza dal vivo (`sendMessageDraft`, con `draft_id` — mancava, trovato e corretto in questa slice, vedi ADR-0025 §revisione e `docs/evidence/lessons.md`), spenta per sessione al primo update fallito; mai più di un messaggio Telegram per turno (overflow → consegna normale a fine turno). Il precedente placeholder materiale nei gruppi è stato rimosso in #90: la Bot API non accetta una chiave di idempotenza e, se accetta `sendMessage` ma la risposta HTTP si perde, non esiste un `message_id` recuperabile da editare senza rischiare un duplicato. **Nota onesta**: un giro si rilascia in un colpo solo a `done` (mai un punto prima è conoscibile — "streamma e ritira" scartato di proposito), quindi un turno senza tool call produce tipicamente UN aggiornamento dal vivo in privato, non un typewriter; nei gruppi la percezione di attività durante l'attesa viene solo da `typing`. Fallback singolo e contato se lo stream del provider si rompe a metà (`ProviderStreamError`). Cablaggio verificato end-to-end con provider SSE finto attraverso `buildRuntime` reale (`cli/repl.test.ts`, `connectors/telegram/streaming.test.ts`), non un `Provider`/`TelegramApi` sostituito a mano. Scenario di accettazione contro il binario vero verde (`evals/acceptance/scenarios/b-streaming.accept.ts`, spawna `muffin repl --stream` come processo reale contro il provider SSE finto e legge la richiesta `stream:true` che il fake ha ricevuto — non un'assunzione dalla risposta arrivata giusta) |
| B12 | Overflow | Un output enorme di un tool va in contesto, o diventa un file richiamabile? | OUT — ROADMAP “Overflow / context-pressure UX”: `agent/context/compact.ts:89-101` sostituisce l'intero payload con un placeholder invece di troncare testa+coda (un difetto noto, non solo una mancanza); nessun overflow-a-file esiste; B11 copre già il segnale di presenza durante l'attesa |
| B13 | Progress | Un turno lungo dice di essere vivo in modo **strutturale**, non cosmetico? | BLOCKER — **riaperta il 03/09 dal dogfood**: «non voglio perdere gli step che ha fatto». La specifica «mai una cronologia» era sbagliata per l'owner: la riga di avanzamento viene cancellata a fine turno (`progress.ts` §`stop`) e il contatore dei secondi si aggiorna solo su evento. Chiude con i passi appesi al segmento e non cancellati (memo `dogfood-superfici-2026-09-03.md` §5.1), provato sulla corsia reale. **Meccanismo su `dev`** (`transcript.ts`, vedi B11): lo scenario B13 ora asserisce che entrambi i passi restano nell'ultima edit, che nessun `deleteMessage` parte e che il contatore vivo è sparito. Manca la prova reale. Storia della riga: era READY — scenario `B13` verde (`b-telegram-journey.accept.ts`, #286): su un gateway vero con il finto Bot API, un turno a più giri produce **un** `sendMessage` di avanzamento, ≥1 `editMessageText` sullo stesso id con testo davvero diverso, un `deleteMessage` a fine turno e la risposta come messaggio a parte (mai una cronologia); il REPL cabla lo stesso `onProgress` su stderr con gate `isTTY` |
| B14 | Attachment | Un file prodotto arriva come **allegato**, o come percorso da copiare a mano? | READY — scenario `B14` verde (`b-telegram-journey.accept.ts`, #286): `send_file` → `sendDocument` multipart reale sul finto Bot API con filename, byte count e caption giusti, sulla chat dell'owner; il turno registra «inviato: report.txt». Resta il limite noto: un member non può ricevere un proprio file (`hostOnly`) |
| B15 | Owner binding | Ogni surface riconosce l'owner solo da un subject-id stabile autenticato e protetto? | BLOCKER — `identify()` unica e cablata su Telegram e Discord (provato da impersonation test su entrambe); DM-only enforced su `channel_type` (D1, judge PR #42, 2026-08-16: un GROUP_DM senza `guild_id` non deriva più `direct: true`); resta aperta la metà "protetto": binding ancora in config, non nel RoT — `ownerUserId` vive in `config.json` ordinario (`core/config/config.ts:80`), non nel Root of Trust → PC 3.5 `slice/pairing-sigilla` |
| B16 | Typed ingress | Gli input DAY-1 sono multipart tipizzati con provenance/taint per parte e parentela durevole `native event → composition → Work`, senza provenance laundering? | BLOCKER — **REFRAME + MECHANISM/CRITICAL**: il minimo già provato (`forward_origin` tier 2 recintato, caption e filename tipizzati, `contentTaint`) resta valido ma non esaurisce più la claim. ADR-0052 e il consumer DAY-1 richiedono testo, file, immagini, voice/audio e reply relations nel perimetro effettivamente usato; original media resta Evidence, transcript/OCR/caption derivati mantengono la propria provenance. L'envelope universale per metadata senza consumer resta OUT, non viene costruito per completezza → PC 1.3 |
| B17 | Ripresa su Discord | Un turno sospeso (`wait`) su Discord riceve la risposta quando riprende? | OUT — Discord non è nella finestra dei 14 giorni; prima di attivarlo servono `DiscordConnector.deliverTo` e la porta nel `SurfaceRegistry` (oggi la ripresa registra `failed:`; trovato dal judge integrato di #44). Il connettore non manda più una risposta fantasma su un turno sospeso → ROADMAP public-alpha “Discord completion” |

> 🧱 **«Substrato pronto» non è «chiuso», e le righe restano BLOCKER apposta.**
> `slice/turno-record` (2026-08-15, **ADR-0042**, disegno in
> `docs/evidence/turno-sospendibile.md`) ha costruito quello che B2, B3 e B5 vogliono
> tutti e tre: **un turno è una riga durevole con un'identità** — `core/turns/`,
> tabella `turns` — con modello pinnato, trascritto intero, **taint persistito**
> (ricostruirlo dal principal era una scalata di privilegio) e **intento+esito
> per ogni tool call**, che è ciò che distingue «fatta» da «forse fatta».
> `CapabilityDecl.rerunnable` è il secondo asse, obbligatorio, e **non** è
> `reversible`.
>
> Quello che l'owner vede oggi che prima non vedeva: un processo che muore a metà
> turno lascia una riga `interrupted`, nominata al boot e da `muffin doctor`, con
> **quali chiamate possono essere partite senza che si possa sapere**. Prima quel
> caso rifaceva il turno da capo, effetti compresi, in silenzio.
>
> **Aggiornamento 2026-08-16 — `slice/turno-sospeso` (PR #41).** I consumatori
> ci sono: `wait` sospende davvero (la riga va a `waiting`, la rivendicazione si
> rilascia, `runTurn` **ritorna**), `todo` sopravvive al riavvio ed è letto nel
> contesto di ogni turno, il resume riprende dalla riga — taint compresa — e la
> corsia (`core/turns/lane.ts`) batte sul tick del gateway. B3, B4 e B5 sono
> READY; **B2 resta BLOCKER** e per la formulazione current va letta la riga
> B2 sopra: ADR-0052 ha superseded la vecchia equivalenza “connector async =
> busy-input chiuso”. Le decisioni del substrato restano in **ADR-0047**, con
> l'emendamento in coda ad ADR-0042.
>
> Due cose rendono onesti quei READY, e sono arrivate dal judge:
>
> - **B3** — un turno sospeso da una superficie *senza corsia* (REPL, `muffin
>   run`) restava `waiting` per sempre senza che nessuno lo dicesse. Adesso
>   `health()` conta anche i sospesi e `doctor` li accoppia allo stato del
>   gateway: «3 turni sospesi e nessun gateway: non li sveglia nessuno». Un
>   `wait` che nessuno risveglia non è un wait.
> - **B4** — un piano scritto da un turno a tier 3 tornava al turno dopo a tier
>   0, incorniciato come intenzione dell'agente. La riga porta il `tier` di chi
>   l'ha scritta, `max()`-ato, e il loop alza lo snapshot prima di mostrarlo.
>   Una tabella che lava la taint non è memoria di lavoro, è un canale.
>
> 🪡 **Nota storica su B2, superseded da ADR-0052.** Il meccanismo di
> `enqueueTurn` e lane resta utile e provato (`agent/lane-wiring.test.ts`):
> scrivere Work durevole senza chiamare subito il modello è una precondizione,
> non la claim completa. Il vecchio rimedio “sostituisci una sola `runTurn` nel
> connector” chiudeva soltanto il coupling sincrono; non rappresentava receiving
> mentre Work è vivo, composition di N eventi, STEER/FOLLOWUP/COLLECT/INTERRUPT
> o safe boundary rispetto agli Effects. #78 porta la durability dell'evento e
> va mediata prima del merge; la nuova composition/busy-input segue PC 1.2/1.3.

> ⚠️ **B11 e B12 le ha trovate l'owner, non questo documento** — poche ore dopo
> che era stato scritto per rendere impossibile esattamente questo: *«mi pare che
> ci siamo dimenticati lo streaming, inoltre anche i token limit dovrebbero
> essere piu dinamici, oppure ancora meglio magari quando le cose sono troppo
> grandi le manda come file del vault?»*.
>
> Restano marcate con la loro provenienza invece di essere assorbite in silenzio.
> Il punto dell'inventario non è essere completo al primo colpo — nessuna lista
> lo è. Il punto è che una lacuna, quando qualcuno la vede, **entri**. La prima
> stesura rimandava a `research/superfici-e-streaming.md`, ma quel file non
> esiste in `dev`: il worktree `slice/superfici` contiene codice in corso, non
> l'istruttoria promessa. Il buco resta dichiarato invece di fingere il link.

> 🔭 **Le righe col cannocchiale vengono dal confronto esterno con Hermes**, già
> persistito su `slice/hermes` e riletto insieme alla conversazione owner del
> 2026-08-16. Un audit che confronta il codice solo coi nostri documenti non può
> trovare ciò che non abbiamo mai scritto. Queste righe restano aperte finché il
> relativo branch non è integrato e verificato: una ricerca su un altro branch
> non è una feature in `dev`.

> 🔐 **B15 e B16 vengono dalla direttiva owner del 2026-08-16 (ADR-0046).** Sono
> due garanzie diverse: autenticare chi parla non rende fidato ciò che porta, e
> parsare un contenuto non lo rende sicuro. **Aggiornamento 2026-08-16
> (`slice/superfici`):** la "forma che obblighi ogni futura surface" per la
> prima garanzia è ora `identify()`/`tierOf()` in `core/surface/types.ts` —
> Telegram e Discord la chiamano entrambe, e l'impersonazione è provata su
> entrambe (`connectors/{telegram,discord}/impersonation.test.ts`: un
> `username`/`global_name` che dichiara di essere l'owner non è nemmeno letto
> nella struttura `Incoming`, non solo ignorato per disciplina). **Correzione
> 2026-08-16 (judge PR #42, D1):** quella prima metà aveva comunque un buco —
> un GROUP_DM (`channel_type: 3`) non ha `guild_id` più di quanto ne abbia una
> DM vera, quindi il check basato solo su `guild_id === undefined` lasciava
> passare un GROUP_DM come `direct: true`, costante, verso `identify()`. Il
> check ora legge `channel_type === 1` (fail-closed: assente è rifiutato, non
> assunto DM) e `direct` è derivato in `parseMessage`, mai riasserito da
> `principalFor`. Quello che resta aperto per B15 è la seconda metà,
> "protetto": il binding vive in `config.json` ordinario, non nel Root of
> Trust — nessuna surface lo cambia ancora. B16 è stata **reframed il 25/08**:
> il minimo forward/caption/filename resta evidence valida, ma non è più la
> totalità del contratto DAY-1 multipart/provenance di ADR-0052.
>
> **Aggiornamento 17/08 (`day1/critical-path.md` storico §1.4).** B16 era
> stata scomposta in minimo (`forward_origin`, caption/filename) e envelope
> universale; quella distinzione resta utile, ma ADR-0052 aggiunge consumer
> concreti DAY-1 — image/file/audio/reply — senza riaprire l'envelope universale.
>
> **Aggiornamento 18/08 (`slice/ingress-forward`, ADR-0044 emendamento).** Il
> minimo storico è chiuso — vedi la riga B16 per ciò che sopravvive come
> evidence. La parte universale resta OUT; il blocker current è il contratto
> multipart dei consumer reali, non un catalogo di metadata ipotetici.

> 🔭 **Le righe col cannocchiale le ha trovate uno sguardo fuori** —
> `docs/evidence/hermes-documentazione.md` (2026-08-15), la documentazione intera di
> Hermes Agent letta contro il nostro codice. Quel documento non aggiunge solo
> righe: **cambia la forma del rimedio** di B2 (il turno non va reso asincrono
> — serve un canale di progresso ortogonale), di B12 (`agent/context/compact.ts:90`
> cancella il payload *intero* mentre ogni cap sotto è testa+coda — è un difetto,
> non una mancanza), di D2/D3 (*non chiedere, fotografare*) e di E1 (contare
> l'atto patologico costa meno che stimare i token). Il §5 di quel file elenca
> riga per riga cosa sposta.

> 🎯 **B8, cosa prova lo scenario — e cosa no.** Lo scenario
> (`evals/acceptance/scenarios/b-continuity.accept.ts`, righe 73-171) manda un
> job a un canale `telegram` che questa installazione non connette mai: un
> `$HOME` fresco non ha token Telegram, quindi `SurfaceRegistry` nasce con zero
> superfici e `find('telegram')` (`core/surface/registry.ts:28-29`) torna
> `null` **prima** di toccare una consegna reale. Quello che lo scenario prova
> è solo la metà negativa: un canale non connesso non fa mai leggere `sent` sul
> turno — resta `failed:<why>`, e `doctor` (il controllo "consegne" su
> `TurnStore.undelivered()`, `core/turns/store.ts:912`, cablato in
> `cli/doctor.ts`) lo nomina per id-turno. La metà positiva — una superficie
> **davvero connessa**, un `sent` genuino — non è provata qui: arriva dallo
> scenario A1 rafforzato, in arrivo (`slice/a1-continuita`: gateway vero, job
> sul canale `cli`, `turns.delivery === 'sent'` e il testo sullo stdout del
> processo reale), e per Telegram nello specifico dalla journey inbound-unit
> (`docs/work/day1/critical-path.md` §1, da mediare sotto ADR-0052).

### C · Memoria e acquisizione

| # | Area | Domanda DAY-1 | Stato |
|---|---|---|---|
| C1 | Memory write | Ogni informazione importante viene acquisita? | READY — scenario `C1` verde (`c-memory.accept.ts:27-58`): turno 1 scrive un fatto, turno 2 su sessione diversa lo recupera via memoria (non transcript di sessione, quello è B1); acquisizione "evidence first" (`agent/loop.ts:872`, `core/memory/store.ts:201`). ADR-0051 vincola la futura memoria intenzionale a `MemoryProposal → reconciliation`, ma non trasforma quella capability non ancora necessaria in un blocker DAY-1. |
| C2 | Extraction | L'estrazione è automatica? | READY — scenario `C2` verde (`c-consolidamento.accept.ts`, #283): un job vero eseguito da `muffin gateway run` produce fatti nel DB senza che nessuno lanci `memory extract`; la catena è `onTurnEnd → consolidation.notify` (`agent/runtime.ts`), debounce `CONSOLIDATION_IDLE_MS` 20 s in produzione, accorciato solo dalla seam test-only `MUFFIN_MEMORY_IDLE_MS` (stesso precedente di `MUFFIN_GATEWAY_TICK_MS`); scollegare `notify` fa cadere lo scenario (mutazione verificata) |
| C3 | Consolidation | Si consolida senza intervento? | READY — scenario `C3` verde (`c-consolidamento.accept.ts`, #283): 27 episodi drenati in un solo `muffin memory extract`, due fatti duplicati a chiave esatta collassati (`sweepDuplicates`), una contraddizione aperta mostrata da `muffin memory review` con exit 1 e i due valori nominati |
| C4 | Recall | Ripesca il vecchio **e** il superseded? | READY — scenario `C4` **verde** sul binario vero dopo la PR #54 (`evals/acceptance/scenarios/c-memory.accept.ts`, entità capitalizzata: `--history` ritrova il fatto superseduto, la ricerca ordinaria quello attivo); meccanismo in PR [#35](https://github.com/GiustoPiedimonte/muffin-agent/pull/35) (`factsAsOf`/`nearestFactTo`, `asOf` unico) ⚠️ limite noto: il one-hop del grafo parte solo da un nome capitalizzato (nota sotto); il percorso turno→estrazione→supersede è provato da J1 con C2/C3, non qui |
| C5 | Provenance | Posso capire **perché** crede una cosa? | BLOCKER — `muffin memory why` esiste per l'owner (`cli/memory.ts:29`, `core/memory/store.ts:918 provenanceOf`), ma non è esposto come tool-agente (`agent/tools/memory.ts` ha solo `memorySearchSpec`); nessuno scenario → critical-path.md#da-qui-ordina-luso (J2) |
| C6 | Temporal graph | «Chi era X a maggio» | READY — scenario `C6` verde (`c-tempo.accept.ts`, #283): fatti superseded a due date, «chi era il capo progetto a maggio» risponde con il valore di maggio sia via CLI (`memory search --as-of`) sia via tool (`memory_search` con `as_of`) sul binario vero; non esercitato `nearestFactTo`/il report del gap (limite dichiarato, non DAY-1) |
| C7 | PDF | Acquisisce documenti utili? | READY — scenario `C7` verde (`c-documenti.accept.ts`, #283): un PDF vero con testo entra da `muffin vault add`, si indicizza ed è trovato da `memory search`; una scansione senza testo fallisce esplicitamente (exit 1, ragione nominata, zero episodi) — togliere il ramo `no_text_layer` fa cadere lo scenario (mutazione verificata). Il path Telegram allegato→vault resta provato da `connectors/telegram/document-arrival.test.ts` (non-acceptance) perché il finto Bot API non serve `getFile`; DOCX e il tool `document_read` non sono nello scenario. **03/09**: fino a questa slice l'ingest era morto sull'installazione vera — la home `~/.muffin` faceva scattare il filtro dotfile sul percorso assoluto e ogni allegato veniva rifiutato come «nascosto» (zero episodi `document` nel database dell'owner, tre file nel vault); ora le home di test hanno la forma di produzione, vedi la nota C7/B10/C8 |
| C8 | Audio | Gestisce le note vocali DAY-1 conservando audio originale e provenance del transcript? | BLOCKER — solo scenario mancante: il meccanismo è atterrato (`core/audio/voce.ts` decide per modello, `core/audio/trascrivi.ts` trascrive in casa con whisper.cpp + ffmpeg, cablato nel path vocale Telegram con transcript recintato come dato tainted; `voice-arrival.test.ts`), **e l'installazione reale è pronta** (02/09): `qwen/qwen3.8-27b` dichiara `["text","image","video"]`, quindi si trascrive in casa — `ffmpeg` e `whisper-cli` installati con Homebrew, `~/.muffin/models/ggml-base.bin` scaricato, e una frase sintetizzata con `say` è tornata testo corretto attraverso `trascrivi` sul binario di questa macchina. `muffin doctor` ha la riga `note vocali` (misura `audioAccettato` e i prerequisiti dalle stesse fonti del runtime, avvisa solo con una superficie vocale abilitata) e sull'installazione dell'owner è verde. Manca lo scenario di accettazione con una nota vocale vera che attraversa Telegram → vault → trascrizione → turno (il finto Bot API non serve ancora `getFile`) → PC 3. **03/09**: le home di accettazione hanno ora la forma di produzione (`<root>/.muffin`), quindi lo scenario mancante, quando arriverà, non potrà essere verde su una forma di percorso che nessuna installazione ha — vedi la nota C7/B10/C8 |
| C9 | Pressure | L'agente sa **quanto spazio gli resta**, dentro il prompt? | OUT — ROADMAP “Overflow / context-pressure UX”: la forma del segnale cambierebbe il prefisso cacheabile owner (`agent/context/assemble.ts`, pinnato a sha256); nessuna capability dei 14 giorni ne dipende |
| C10 | World state | Distingue ciò che vale adesso da episodi, credenze e lavoro? | OUT — ROADMAP research/consumer-triggered: consumer prima dello schema (ADR-0045/0050) |

> **C4/C6 — cosa il meccanismo prova.** Riclassificate `BLOCKER` il 17/08 per
> mancanza/rossore dello scenario di accettazione (C4 ha uno scenario reale
> ma ancora rosso, `it.fails` conferma; C6 non ne ha uno) — non per un difetto
> nel meccanismo sotto, che resta quello descritto qui. `--history` era già stato corretto per
> i fatti sul solo hop grafo (`d66765d`, già in `dev` prima di questa slice); il
> gap reale era più stretto di quanto la riga dicesse, ma restava su tre punti:
> il lato episodi di `--history`, `asOf` come primitiva unica al posto di due
> manopole, e l'intera C6 (data/superficie/vicinato). Un parametro solo,
> `asOf: string | 'all' | undefined`, attraversa `recall()` — non un flag in
> più, la rimozione di una costante (`expired_at IS NULL`/`superseded_at IS
> NULL`) che nessun chiamante poteva muovere. `factsAsOf`/`nearestFactTo`
> (`core/memory/store.ts`) rispondono a «chi era X a maggio» dentro le
>
> primitive esistenti — nessuna tabella nuova. `(surface, date_range)` e
> vicinato sono le due primitive di `02-ontologia.md` §9, cablate sia in
> `muffin memory search` sia nel tool `memory_search` che il modello raggiunge
> — quest'ultimo era il cablaggio mancante reale: lo schema dichiarava
> `as_of`/`history`/`surface`/`since`/`until`/`around` e l'handler leggeva solo
> `query`/`limit`. Un fatto superseded torna etichettato con successore e
> finestra `valid_from → valid_to`, mai come corrente; una domanda temporale
> fuori portata risponde con una lacuna esplicita invece del presente. Tre
> percorsi di fallimento espliciti (data malformata, finestra `since`>`until`,
> `asOf` nel futuro) condivisi da CLI e tool via `checkTemporalWindow`. Un
> invariante a 60 combinazioni (`asOf`×`surface`×`since/until`×`neighbours`)
> prova che un fatto ritirato non torna mai attivo; isolamento cross-tenant
> verificato sul vicinato e sulla modalità storia. Ogni test nuovo verificato
> **rosso** prima del fix (PRACTICES.md#model-judgement-and-deterministic-contracts-stay-separate). Dettaglio in `docs/evidence/lessons.md`
> («Una garanzia che regge su due percorsi e non sul terzo non è una
> garanzia»).
>
> ⚠️ **Trovato lavorandoci, non nel mandato originale.** Il mezzo semantico di
> `recall()` non aveva mai letto `expired_at`: un fatto o un episodio ritirato,
> una volta indicizzato per vettori, resta trovabile per significato per
> sempre (niente si re-indicizza al supersede), e tornava **senza** la marca
> `expired` su **qualunque** ricerca semanticamente vicina — non solo sotto
> `--history`. Misurato: 60/60 combinazioni prima del fix, 0/60 dopo. Corretto
> leggendo il fatto intero via `factById` invece di una seconda query di
> provenienza più stretta, con la stessa regola `successorOf` del hop grafo
> (una sola, letta da due punti). `(surface, date_range)` sul mezzo semantico
> vale solo per gli episodi, mai per i fatti — per costruzione, coerente con
> `02-ontologia.md` §9 che nomina il filtro come proprietà dell'evidenza, non
> del grafo.
>
> ⚠️ **Il one-hop grafo parte solo da un nome capitalizzato in query.**
> `extractCandidateNames` (`core/memory/recall.ts:819-820`) prende come
> candidato solo una parola che comincia per maiuscola
> (`/\b[A-ZÀ-Ú][\wÀ-ú'-]{2,}\b/`); lo scenario C4
> (`evals/acceptance/scenarios/c-memory.accept.ts`) usa di proposito
> un'entità scritta come nome proprio ("Ristorante preferito") perché è
> l'unico percorso di ritrovamento che può raggiungere questo fatto (vedi
> sopra). Una query tutta minuscola ("il mio ristorante preferito") non fa
> partire l'hop — limite noto, non coperto dal claim di questa riga.
>
> **Aggiornamento 17/08.** Il triage evidence-only aveva trovato lo scenario
> `C4` rosso perché il fixture scriveva via `addFact`/`supersede` diretti; la PR
> #54 lo ha riscritto (entità capitalizzata, vedi sopra) ed è **verde** sul
> binario vero: C4 è READY nel perimetro dichiarato. Il percorso completo
> turno→estrazione→giudice→supersede resta da provare per **C2/C3** (`day1/
> critical-path.md` §4, journey J1); C6 (`asOf`) resta BLOCKER solo per
> scenario mancante nella stessa journey.

> **C7/B10/C8 — l'ingest era morto in produzione fino al 03/09.** Misurato
> sull'installazione dell'owner quel giorno: tre file nel vault (due foto di
> agosto, un PDF), **zero** episodi con `kind in ('media','document')`. La home
> di Muffin è `~/.muffin`, il filtro dei dotfile di `core/vault/vault.ts` girava
> anche sul percorso **assoluto** risolto, il segmento `.muffin` corrispondeva,
> e ogni file mai inviato è stato rifiutato con «nascosto: i dotfile non sono
> note e a volte sono chiavi» — un messaggio falso e inagibile stampato in chat
> su un `inbox/…-cv-….pdf`. Tutte le prove qui sotto restavano verdi perché le
> home di test erano directory temporanee senza alcun segmento col punto: la
> suite provava una macchina che non esiste.
>
> Ciò che lo prova ora: il contenimento è separato dal filtro dei nomi
> (`insideRoot` confronta per **segmenti**, mai per prefisso di stringa), le
> regole dot/`NEVER_CONTENT` girano sul percorso **relativo alla radice** del
> vault, e il rifiuto nomina il segmento vero. Le home di test hanno la forma di
> produzione: il fixture di `core/vault/vault.test.ts` crea
> `<tmp>/.muffin/vault`, `install()` di `evals/acceptance/harness.ts` crea
> `<root>/.muffin`, e `connectors/telegram/document-arrival.test.ts` fa lo
> stesso — quindi ogni scenario di accettazione, C7 compreso, gira ora su un
> percorso con un segmento col punto. Rimettere il percorso assoluto nel filtro,
> o sostituire `insideRoot` con uno `startsWith`, fa cadere i test nuovi
> (mutazione verificata il 03/09). Restano vere le riserve già scritte sotto:
> lo scenario C7 passa dalla CLI e non da `getFile`, e B10/C8 restano senza
> scenario di accettazione proprio.

> **C7 — cosa il meccanismo prova.** Riclassificata `BLOCKER` il 17/08 per
> mancanza dello scenario di accettazione, non per un difetto nel meccanismo
> sotto. PDF, DOCX e testo entrano **interi** nel
> piano evidence (`core/documents/`, `unpdf` 1.8.1), pagina per pagina, e il
> percorso vero ci arriva: allegato Telegram → `vault/inbox/` → `reindexPath` →
> episodi `kind='document'`, nello stesso tenant risolto dal connector. Il turno
> di gruppo riapre il proprio documento e `host` non lo vede; l'ingresso non
> enumera il vault condiviso, quindi non importa nel gruppo note host o allegati
> di un altro gruppo. Il turno riceve
> una **vista compatta** — indice delle pagine + `document_read` per riaprirne una dal file — invece del
> documento intero. Provato end-to-end in
> `connectors/telegram/document-arrival.test.ts` con PDF veri costruiti byte per
> byte; il test parte anche da due chat di gruppo con una nota host già presente
> e osserva isolamento dello store in tutte le direzioni, oltre al tool result.
> Per DOCX il corpo e le parti OOXML collegate (header, footer, note, commenti)
> restano nominate; la decompressione ha un bound indipendente dalla dimensione
> dichiarata nello ZIP. I symlink esterni sono esclusi con motivo visibile,
> perché non offrirebbero una fonte stabile a `document_read`.
>
> ⚠️ **Il limite, dichiarato invece che scoperto dopo.** Un PDF di sole
> scansioni non ha testo da estrarre: **fallisce in modo esplicito** («PDF senza
> testo selezionabile: N pagine di sola immagine… qui non c'è OCR») e non viene
> mai indicizzato come documento vuoto. L'OCR resta fuori scopo — quando entrerà,
> è una riga nuova di questo inventario, non una correzione silenziosa di questa.
> Insieme all'OCR resta fuori la **struttura visiva**: due colonne e le celle di
> una tabella arrivano come testo di seguito (misurato in ADR-0043), il contenuto
> tutto, la forma no.
>
> **Aggiornamento 17/08.** `document-arrival.test.ts` prova il meccanismo ma
> non gira in `evals/acceptance/`: il lavoro che resta è incapsulare un test
> già passante nell'harness di accettazione, non scrivere nuova logica
> (`day1/critical-path.md` §4, journey J2, con C5).

### D · Capability e sicurezza

| # | Area | Domanda DAY-1 | Stato |
|---|---|---|---|
| D1 | File read | Legge file reali? | READY — scenario `D1` verde (`d-capability.accept.ts:15-66`): symlink che punta fuori dal workspace, `fs_read` lo rifiuta (`is_error=1`); `realpathDeepest` risolve il path reale anche per hard link in lettura (PR #52, `agent/tools/fs.ts:238`); CI Linux verde sullo stesso HEAD (run 32016357127) |
| D2 | File write | Modifica file reali **in sicurezza**? | READY — `slice/undo-journal`: `draft` ha un'implementazione, e la sua forma è «prima la copia, poi l'effetto» (`agent/loop.ts`, ramo `case 'draft'`). Il file che viene fotografato lo dichiara il tool (`resolveEffectPath`, `agent/tools/fs.ts` — lo stesso `resolveInScope` che userà l'handler), non il loop, perché il percorso che il modello passa è relativo a uno scope che il loop non conosce: fotografare l'argomento grezzo copierebbe un file relativo alla cwd. Se la copia non si può prendere, la scrittura non avviene. Accettazione D2 verde sul binario vero (il file c'è, `muffin undo` lo toglie); cablaggio provato end-to-end in `agent/runtime-wiring.test.ts`; 6 mutazioni uccise, fra cui «copia non presa ma si esegue», «journal non cablato in `buildRuntime`» e «si fotografa l'argomento invece del file risolto». **Il limite noto è caduto il 02/09 (ADR-0053):** dopo un `fs_read` il turno è a taint 2 e «leggi, calcola, scrivi» ora è una **domanda**, non un rifiuto. Il `deny` non era una scelta ma una trascrizione mancata: la matrice normativa dà a `fs.write` la riga *Shell / filesystem host / processi*, che a taint 2 dice `ASK`, e l'emendamento del 16/08 l'aveva scritta solo su `sys.shell`. Il soffitto ora viene dalla riga di effetto; `core/policy/effect-rows.test.ts` asserisce ogni cella e `b-parita-superfici.accept.ts` misura il giro sul binario, identico su CLI, REPL e Telegram. |
| D3 | Undo | Posso recuperare una modifica? | READY — `muffin undo` esiste ed è la metà che legge il registro (`cli/undo.ts`): elenca i turni disfabili, senza `--yes` stampa cosa farebbe, con `--yes` rimette i file. Journal su filesystem in `~/.muffin/undo/<turno>/` — la forma decisa dall'owner il 16/08 (§1, via B), non una tabella, quindi nessuna migrazione. Ripristino a ritroso, perché due scritture sullo stesso file nello stesso turno hanno due copie e in avanti resterebbe la penultima; `copy: null` significa «non esisteva» e disfare vuol dire togliere. **L'undo è a sua volta reversibile**: lo stato attuale finisce sotto `annulla-<turno>` prima di essere sovrascritto, come `muffin restore` fa col database. Accettazione D3 verde sul binario vero (modifica, non creazione: il file torna ai byte di prima). |
| D4 | Shell | Esegue comandi nel sandbox? | READY — la prova è composta e dichiarata: contenimento reale provato da `D10` (seatbelt/bwrap sul binario vero) e dalla CI Linux; scenario `D4` verde (`d-capability.accept.ts`, #284): `shell_run` è offerto solo dopo una sonda viva del sandbox e l'ASK mostra comando+cwd reali; forzare `allow` sul ramo high di `decide.ts` esegue davvero il comando e fa cadere lo scenario. Non provato in accettazione: l'esecuzione dopo un'approvazione (headless `muffin run` non ha canale di approvazione) — quella vive nei test unitari del kernel e in `e2e-giro-owner` |
| D5 | Process | Gestisce processi lunghi? | READY — scenario `D5` verde (`d-capability.accept.ts`, #284): un figlio vero (`sleep 300`) è elencato da `process_list` con pid e nome e **senza argv** (il `300` non compare nel transcript); `process_kill` si ferma sull'ASK con il pid reale in `pending`; ucciderlo resta al test, mai al tool |
| D6 | HTTP | Naviga secondo policy? | BLOCKER — kernel esteso, non solo host: `slice/egress-params` (17/08, mandato inv. 7) fa sì che il ramo `url` di `decide.ts` ispezioni anche query/fragment su un host già allowlisted (`gateParams`, soglia `paramsMaxTaint`, default 1), non solo l'hostname come prima (audit P04-1); scenario di accettazione `D6` (`d-capability.accept.ts`) prova al binario reale, dopo contenuto tainted, `ask` mai eseguito senza approvazione — mutazione verificata (`resourceKind:'none'` in `search.ts` è il caso gemello, non questo, ma la stessa disciplina si applica). Resta BLOCKER, non promossa: nessuno scenario prova ancora un `allow` con fetch riuscito, perché servirebbe un host realmente raggiungibile e questa suite non tocca provider reali → PC 1.6 `slice/egress-params` (J5) |
| D7 | Web search | Funziona end-to-end? | BLOCKER — `sys.search` dichiara ora `resourceKind:'query'` (`agent/tools/search.ts:61`, era `'none'`, audit P04-2) e il nuovo ramo `query` di `decide.ts` (`gateParams`) applica alla query la stessa soglia di taint dei parametri URL; scenario di accettazione `D7` (`d-capability.accept.ts`) prova al binario reale che, dopo contenuto tainted, la ricerca chiede e non parte senza approvazione — mutazione verificata: rimettere `resourceKind:'none'` fa cadere lo scenario (`stopped:'answered'` invece di `ask`). Resta BLOCKER, non promossa: la journey J5 non prova ancora il percorso felice (una ricerca reale che torna risultati), perché l'endpoint di `tavilyBackend` è una costante compilata senza un modo di puntarlo a un server finto da un sottoprocesso, e la vera Tavily è fuori scope (niente provider veri) → PC 1.6 `slice/egress-params` (J5) |
| D8 | MCP | Gestisce drift e revoca? | OUT — revoca calda: pinning e sospensione su drift sono solidi (`core/mcp/registry.ts:125 verifyTools`, `agent/tools/mcp.ts:11-24`), ma `muffin mcp remove` lo dice già onestamente («spariscono al prossimo avvio», `cli/mcp.ts:142-152`); il riavvio è un verbo del supervisore → ROADMAP public-alpha “MCP hot lifecycle” |
| D9 | Skills | Scopre e usa le skill senza promuovere descrizioni non fidate a istruzioni? | READY — `slice/skill-di-serie`. La riga chiedeva «injection/fake-close **+ production wiring**»: il recinto era già provato in unità, il cablaggio no, e **non era provabile**, perché `defaults/` non spediva nessuna skill. Su un'installazione vera `skillsPromptSection` tornava stringa vuota, la sezione non esisteva nel prompt e `skill_read` era offerto al modello senza avere un oggetto; su `~/.muffin` dell'owner la cartella `skills` non esisteva proprio. Costruire una skill dentro il test avrebbe misurato il test. Ora `defaults/skills/` ne spedisce due — `collega-telegram` (la procedura reale: il token lo mette l'owner, l'abilitazione la esegue Muffin) e `studia-un-documento` (`vault add` → `memory_search` → `document_read` per intervalli) — e `init` le semina registrandole nel manifest dei default, così un'edit dell'owner resta distinguibile dallo spedito. Accettazione **D9** verde sul binario vero: le skill sono nel prompt di un'installazione nuova, il modello ne attiva una e riceve il corpo, e una `description` che finge di chiudere il recinto perde il tentativo. 4 mutazioni uccise. **Difetto trovato misurando, e riparato qui:** il recinto prendeva un nonce nuovo a ogni chiamata, quindi il system prompt era diverso a ogni processo — e ogni `muffin run` è un processo — perciò il prefisso non era mai lo stesso e la cache del provider non poteva prendere. Nonce ora per-installazione (`core/skills/nonce.ts`), con prova di stabilità fra due boot in `agent/context/assemble.test.ts`. Costo della sezione: 744 caratteri su 23.648, il 3,1%, solo metadati. **03/09/2026 — questa riga era morta su un'installazione aggiornata, e lo è stata dal giorno in cui è stata scritta.** `init` semina le skill in una casa **nuova**; la casa dell'owner era nata prima, e nessuno gliele ha mai portate: il suo `defaults-manifest.json` elencava un file solo (`persona.md`), `~/.muffin/skills` non esisteva, `skillsPromptSection` tornava stringa vuota. Il meccanismo era di nuovo «completo e vuoto», stavolta a valle: spedito e mai consegnato. Riparato da `reconcileDefaults` (`cli/adopt.ts`), che gira dentro `muffin update` sui `defaults/` della release nuova e installa **solo ciò che manca** — mai una sovrascrittura di un file dell'owner. Prova rossa prima: una casa ridotta a com'era la sua non aveva skill dopo la riconciliazione (`cli/home-invecchiata.test.ts`). |
| D10 | Security | Nessuna capability escape? | READY — taint in ingresso chiuso (`slice/taint-in-ingresso`, ADR-0044, giro 2 PR #28: STATE.md "Taint in ingresso — chiuso"); un turno a taint 3 che tenta `http_get` fuori allowlist riceve `deny/resource_denied` dal kernel, mai `ask` — provato end-to-end (`evals/acceptance/scenarios/d-capability.accept.ts`, scenario D10) |
| D11 | Checkpoint | Esiste uno snapshot prima di ogni mutazione, e un ripristino che disfa anche il turno? | BLOCKER — metà lineage rientrata (#253: `episodes.turn_id`, `RecallItem.turnId`, esclusione del recall per lineage); metà «l'undo riallinea il turno» **non rientrata**: PR #186 chiusa senza merge il 30/08 come SALVAGE (141 commit indietro, 5 conflitti), il ramo `slice/undo-riallinea-il-turno` resta come miniera, non si rebasa. La misura che l'ha chiusa era: sul `muffin.db` dell'owner `fs.write` **non è mai stata eseguita** (0 chiamate su 165 turni), perché 110 turni su 165 sono a taint 2 e `fs.write` aveva soffitto 1. **ADR-0053 apre quel percorso** — a taint 2 la riga dice `ASK` — quindi la dipendenza è caduta e questa metà si reimplementa su HEAD. Resta BLOCKER perché il lavoro non è fatto, non più perché è irraggiungibile |
| D12 | Ask | L'ASK mostra **cosa** sta per fare (comando+cwd, URL, pid+nome) e perché il turno è a quel taint? | READY — difetto del 03/09 chiuso su `dev` (`slice/telegram-segmenti`): `summarizeCallArgs` non tronca più a 220 (l'owner aveva ricevuto un comando monco nel messaggio che chiedeva di eseguirlo), l'ASK Telegram si spezza con `splitHtml` e i pulsanti stanno sull'ultima parte, e `shell_run` ha `description` — la frase del modello su cosa fa il comando, sopra il comando (`ApprovalRequest.description`, mostrata da REPL e Telegram; lo scenario D12 la asserisce e asserisce che non finisce fra gli argomenti). Scenario `D12` verde (`b-telegram-journey.accept.ts`, #286): l'ASK su Telegram mostra capability, comando+cwd e `taint 2` con i pulsanti; il pulsante di un impostore non decide nulla (riga `approvals` intatta); quello dell'owner riprende il turno sospeso e consuma l'approvazione **una** volta — togliere il blocco che stampa il taint in `cli/surface.ts` fa cadere lo scenario (mutazione verificata). REPL provato da `D6`/`D7` |

### E · Economia e osservabilità

| # | Area | Domanda DAY-1 | Stato |
|---|---|---|---|
| E1 | Budget | Cap globale **e** per-job? | BLOCKER — il per-job non esiste: solo `monthlyUsd` e `perTenantDailyUsd` (quest'ultimo escluso per `host`, `core/budget/budget.ts`); nessuna colonna `perJobUsd` su `jobs` → PC 3.7 `slice/budget-per-job` |
| E2 | Cost | So quanto costa una giornata? | READY — `/spend` (`cli/repl.ts`) stampa ora anche `oggi: $X`, letto da `tenantTodayUsd('host')` (`core/budget/budget.ts`, esisteva già senza chiamante); lo scenario `E2` aggiornato (`evals/acceptance/scenarios/e-cost.accept.ts`) prova entrambe le righe — mensile e di oggi — non-zero dopo un turno reale che ha speso, verde: `npx vitest run --config vitest.acceptance.config.ts evals/acceptance/scenarios/e-cost.accept.ts` (3/3) |
| E3 | Tracing | Posso ricostruire cosa è successo? | READY — scenario `E3` esteso (`e-cost.accept.ts`, #285): oltre alla redazione dei segreti (ADR-0048), `muffin trace turn <id>` / `trace grep` ricostruiscono un turno qualunque dai file di trace veri, e la ricostruzione del turno B non mostra le tool call del turno A (isolamento asserito in entrambe le direzioni) |
| E4 | Tests | Acceptance test **reali**, non solo unit? | READY (`evals/acceptance/`) — è il meccanismo: harness contro il binario vero, provider finto deterministico, ogni verde visto rosso prima. La PR #54 aggiunge nel manifest la specie provata dal meccanismo stesso, chiudendo l'unico "READY senza scenario" rimasto dopo il triage 17/08 |
| E5 | Failure | Ogni fallimento importante è esplicito e recuperabile? | BLOCKER — **COMPOSITE**: lo scenario `E5` prova una classe (giudice di contraddizione), non l'intera domanda. Non creare un “E5 subsystem”: chiudere B6/ASK/delivery/scheduled-work e poi fare una synthesis integrata delle classi residue → critical-path.md#da-qui-ordina-luso |
| E6 | Act caps | Un singolo turno può fare 200 ricerche web o 200 deleghe? | BLOCKER — il meccanismo c'è (RETURN S3): il tetto `maxToolCallsPerTurn` vale per singola tool call anche dentro un batch in una sola risposta del modello; le call oltre il tetto ricevono un `tool_result` di rifiuto esplicito invece di eseguire; restano i budget per-capability (200 ricerche in 15 turni restano possibili) → DOGFOOD |
| E7 | Self-inspection | Sa spiegare **tecnicamente** come funziona e cosa sta usando **adesso**, distinguendo architettura/progetto da stato live dell'istanza? | READY — scenario `E7` verde (`e-cost.accept.ts`, #284): `sys_inspect` risponde con il modello main letto dalla config reale, lo stato live del RoT e le capability esposte; dopo un vero `muffin model main <altro>` la seconda risposta riflette il cambio e non ripete la prima — cablare a mano la riga del modello in `inspect.ts` fa cadere lo scenario (mutazione verificata) |

> **E4, cosa vuol dire `READY` qui — e cosa esplicitamente non vuol dire.**
> `evals/acceptance/` lancia `muffin` come **processo vero** (`node --import tsx
> cli/main.ts`, mai `runTurn()` con dipendenze finte) contro un `$HOME`
> temporaneo, parlando con un provider HTTP finto e deterministico
> (`evals/acceptance/provider.ts` — nessuna chiave, nessuna chiamata a
> pagamento). Lo stato delle **altre** righe di questo inventario è **derivato**,
> non scritto a mano: `npx tsx evals/acceptance/report.ts` legge questo stesso
> file e la registrazione degli scenari (`evals/acceptance/manifest.ts`) e
> stampa, per riga, `verde` / `rosso-inatteso` / `atteso-rosso` (con la ragione
> e la slice che lo chiude) / `nessuno scenario` — con exit code ≠ 0 su un rosso
> inatteso, su una riga `READY` scoperta, o su una riga `READY` il cui scenario
> è ancora `atteso-rosso` (readiness-criteria.md#day-1-ready — le due affermazioni non possono
> essere vere insieme). Un `atteso-rosso` a sua volta è verificato contro la
> firma di fallimento che il manifest dichiara
> (`ScenarioEntry['expectFailure']`), non contro "ha lanciato qualcosa": uno
> che fallisce per un motivo diverso da quello scritto è `rosso-inatteso`, non
> "va bene così". `npm run test:acceptance` gira la sola suite (17 scenari,
> **~60s** misurati in locale). Job CI dedicato scritto
> (`.github/workflows/accettazione.yml`), ora anche su `pull_request` verso
> `dev`/`main` oltre che su `push`/`workflow_dispatch`.
>
> **La copertura evolve con l'inventario.** Un verde può provare solo una metà
> della claim e lasciare la riga BLOCKER (A2/A3, B1, D6/D7, E3/E5). `C8` e le
> parti real-surface/real-service possono richiedere evidence che il provider
> finto non ha il diritto di simulare. `E4` stessa resta `provata dal meccanismo`:
> non avrebbe senso una suite di accettazione che prova se stessa. Il rapporto
> deve restare a zero `READY` senza scenario/meccanismo, zero rossi inattesi e
> zero orfani; la riconciliazione del 25/08 cambia la domanda B2/B16/C8, non
> retroattivamente ciò che i vecchi scenari avevano davvero osservato.

---

## Il modello di reversibilità — la decisione sotto `fs.write`

Non è una patch a `fs.write`. Direttiva owner: *«se ogni operazione
potenzialmente distruttiva diventa "vuoi che scriva questo file?" ogni cinque
minuti, l'agente diventa inutilizzabile»*.

La forma richiesta è un **modello coerente con il kernel dei permessi**:

```
READ → IL MODELLO DECIDE → WRITE → UNDO RECORD → EXECUTE → TRACE
```

con quattro classi, non due:

| Classe | Esito |
|---|---|
| reversibile | si esegue |
| reversibile ma potenzialmente distruttivo | policy / undo |
| irreversibile | ASK |
| irreversibile **verso l'esterno** | ASK, o vietato |

Oggi il kernel ne ha tre (`allow` / `draft` / `ask` / `deny`) e `draft` non è
eseguibile da nessun percorso. Il disegno va fatto **dopo** aver letto ADR,
threat model e i contratti di capability — non prima.

**Decisione owner, 2026-08-16**: si adotta il modello a **quattro classi** con **journal per turno** (via B: copia del file prima della mutazione in `~/.muffin/undo/<turno>/`, undo che riallinea filesystem **e** turno; il vault resta append-only); l'owner lo accetta «anche se non convince del tutto, magari refactorizziamo in futuro» — riscrivibile finché non siamo open source.

Il confronto Hermes aggiunge una forma concreta: **non chiedere, fotografare**.
Uno snapshot prima della mutazione può rendere eseguibile `draft` senza
trasformarlo in `allow`, e il ripristino deve riallineare filesystem **e turno**
o il contesto continuerà a credere in un effetto che è stato annullato. È una
traccia di disegno, non una feature acquisita: deve ancora rispettare il vincolo
che i dati vivono solo in `~/.muffin/`, dichiarare quando il checkpoint non può
essere creato e lasciare il kernel puro. ADR-0050 non cambia questa ownership:
un future Node può eseguire l'effect, ma Home possiede intent/outcome e il Node
può soltanto restringere l'authority effettiva.

## `wait` e `todo` sono primitive del runtime, non tool

```
WAIT → persisti lo stato → rilascia l'esecuzione → scheduler/evento → riprendi
```

Un `await sleep()` dentro il processo cognitivo **non** è `wait`: è una funzione
async molto lunga, ed è precisamente la differenza fra un Muffin vivo e un
Muffin lanciato da terminale. Stessa cosa per `todo`: il modello operativo non è
`goal → turn → done` ma `goal → plan → todo{done|blocked|waiting|retry|pending}
→ resume`.

Il lavoro non si chiude aggiungendo due tool al menu. `wait` deve avere una
barriera durevole con scadenza che non può incastrare il loop; `todo` deve essere
letto dal turno successivo e accompagnato da un criterio deterministico di
completamento.

**Fatto (PR #41).** La barriera è `wake_at` + `wait_for`, entrambe persistite:
la scadenza è obbligatoria — un'attesa senza scadenza è silenziosa e nessuno la
vede — con un pavimento di 60s (sotto il battito del runtime non è un'attesa, è
un `sleep` dentro un tool), un tetto di 7 giorni e un massimo di 8 turni sospesi
per tenant. Il criterio di completamento dei `todo` è una query sulle righe, mai
il modello che si dichiara finito: **finito = nessun passo `pending` o `retry`**,
e la frase è scritta nel contesto perché è l'unico posto dove il modello legge
del piano.

> 🔭 **Manca il decisore, non solo la primitiva** — `docs/evidence/hermes-documentazione.md`
> §2.1–2.3 e §3.3 (2026-08-15). Tre cose che questa sezione non diceva:
>
> **Chi decide il `wait`.** Non il modello dentro il turno — lì la decisione è
> tainted come tutto il resto e attaccabile per injection. Un giudice *fuori* dal
> turno che legge il registro dei processi vivi (che è fatto nostro, non testo di
> un terzo: `agent/tools/process.ts` esiste già e non è mai stato collegato a una
> decisione di controllo) e restituisce `done | continue | wait`, con tre forme di
> barriera: pid, sessione+pattern, tempo. **Fail-open**: giudice rotto ⇒
> `continue`, e il freno vero resta il budget di turni.
>
> **Un invariante che non avevamo scritto.** *Una barriera scaduta non può mai
> incastrare il loop*: pid già morto, pid che muore mentre si aspetta, scadenza
> passata ⇒ la barriera si libera al controllo successivo. Lo stesso pattern del
> lock del gateway (stale dopo 10 battiti, qualunque sia il pid) mai
> generalizzato.
>
> **Dove vive la durevolezza.** Hermes divide: ciò che è legato a una sessione
> persiste lo *stato* ma serve un processo vivo per *scattare*; ciò che deve
> sopravvivere a tutto va nello scheduler. Per noi la divisione costa meno che
> per loro, perché ADR-0035 ha già deciso che un processo che vive esiste — a
> patto che un `waiting` orfano si veda al boot, come già fa la riga
> `interrupted` di ADR-0042.
>
> E su `todo`: la loro risposta **non è un tool `todo`**. È un obiettivo
> persistente + criteri aggiungibili a metà corsa + **gate deterministici** —
> un comando che deve uscire 0 prima che un giudice venga anche solo chiamato.
> Il pezzo che fa terminare il ciclo è il gate, non lo stato del todo.

## La direzione oltre DAY-1 non allarga DAY-1

ADR-0045 nomina l'agente continuo, la presenza, il world state e l'autonomia
guadagnata. ADR-0046 fissa il confine di ogni surface. ADR-0050/0051/0052
raffinano topologia, writer canonico della memoria e ingress. Non sono una scusa
per aggiungere adesso hardware, un trust score, broker o tabelle generiche. Il
DAY-1 compra la continuità operativa necessaria a vivere quattordici giorni;
l'uso reale decide poi quale interfaccia sostituire.

Quattro confini restano già decisi:

- world state è distinto da episodi, credenze e stato del lavoro, ma aspetta un
  consumer prima dello schema;
- un device può essere **Node, Surface o entrambi** dello stesso Muffin; non è
  una seconda memoria/authority e il Node può soltanto restringere la Home;
- una surface separa identità autenticata e contenuto: nessun metadata elegge
  l'owner, ogni campo model-visible è parsato, provenanced e tainted;
- l'autonomia futura comprime supervisione per capability/risorsa/contesto su
  evidenza osservabile; non indebolisce il kernel, il taint o il Root of Trust.

---

**Il lavoro finisce quando l'inventario ha zero BLOCKER e ogni voce è READY,
FUORI DAL GATE 1 o INVALIDATA, ciascuna con la ragione o l'evidenza scritta.**
Solo allora si propone DAY-1 — e da lì lo sviluppo lo guidano i problemi
che l'owner incontra vivendoci, non le feature immaginate davanti a una
lavagna.
