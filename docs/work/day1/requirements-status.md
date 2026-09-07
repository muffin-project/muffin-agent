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
  B6, B15, C8, D2, D3, D11, E1, E5, E7) e la semantica busy-input
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
> **E1 chiusa 04/09/2026 (`slice/e1-budget-per-job`, issue #368).** Il tetto
> per-job esiste ed è sul percorso di produzione: `jobs.per_job_usd` (nullable,
> migrazione 6), il contatore su `spend.job_id`/`turns.job_id`, e il rifiuto in
> `agent/scheduler-run.ts` `runFresh` — l'unico punto che chiama il modello.
> Misurato prima di implementare: ADR-0035 emendamento №2 chiedeva questa cosa
> per nome (*«è la differenza fra un job rotto che costa €0,50 e uno che si
> mangia il mese prima delle 7»*) e chiedeva anche che il conto stesse **fuori
> dal turno** — sta nel registro, una riga per chiamata al modello, non in una
> colonna contatore che si aggiorna solo se il giro torna. Un guasto trovato
> dai test e non a mano: `TurnInput` non basta, perché `drive` ricostruisce
> l'input dal record — senza `turns.job_id` la spesa non veniva attribuita a
> nessun job e il tetto non sarebbe scattato mai.
>
> **Conteggio: 35 READY · 14 BLOCKER · 6 OUT · 0 INVALIDATED** (56 righe). I 14
> BLOCKER: B11/B13 (forma dello streaming e dei passi, dogfood), B2/B16
> (busy-input, forma decisa), A2/A3, B10, B15, C5, C8, D6/D7, E5, E6 —
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

> **D11 chiusa 04/09/2026 (ADR-0067).** L'altra metà di D11 — «l'undo riallinea
> il turno» — reimplementata su HEAD dopo che ADR-0053 ha tolto la dipendenza
> che teneva PR #186 fuori scope. Misurata prima di implementare: `cmdUndo`
> toccava solo `UndoJournal`, mai `TurnStore`/`MemoryStore`. Marcatura (mai
> riscrittura, mai esclusione dal recall) su `turn_tool_calls.undone_at` ed
> `episodes.undone_at`, letta da `agent/loop.ts` alla reiniezione della
> history. Due end-to-end sul runtime vero, mutation-testati a mano. Residuo
> dichiarato in ADR-0067 §"Cosa resta fuori" (granularità per-`callId` su un
> restore parziale, redo asimmetrico, riconciliazione di un turno sospeso a
> metà) — non blocca la riga, che passa a READY.
>
> **Conteggio: 20 READY · 30 BLOCKER · 6 OUT · 0 INVALIDATED** (56 righe). Dei
> 13 restanti che aspettano una decisione o un meccanismo (14 meno D11): A2/A3
> (character eval), B1 (metà Telegram), B2/B16 (busy-input), B15 (binding nel
> RoT), C5 (tool di provenance), C8 (prerequisiti reali), D6/D7 (percorso
> felice senza provider veri), E1 (per-job), E5 (composite), E6
> (per-capability).

> **C5 chiusa 04/09/2026 (slice/c5-memory-why).** Il gap era esattamente
> quello che la riga nominava: `muffin memory why` (`cli/memory.ts`) esisteva
> solo per l'owner, mai esposto come tool dell'agente. `agent/tools/memory.ts`
> registra ora `memoryWhySpec`/`whyMemory`, sulla stessa `memoryCapability` di
> `memory_search` (`memory.read`, sola lettura, nessuna capability nuova),
> cablato in `agent/runtime.ts` accanto a `memory_search`. CLI e tool
> condividono lo stesso renderer, `describeProvenance`
> (`core/memory/provenance.ts`, estratto da `cmdMemoryWhy`), quindi le due
> risposte a "perché lo credi" non possono più divergere in silenzio.
> Scenario `C5` verde sul binario vero (`c-memory.accept.ts`): un turno reale
> chiama `memory_why` per testo — il caso ordinario, perché `memory_search`
> non stampa mai un fact_id da riusare — e la richiesta successiva del
> modello porta il connettore, la tier reale e la frase originale
> dell'episodio piantato, mai una parafrasi. Mutazione verificata: commentare
> la registrazione in `agent/runtime.ts` (tool file intatto) fa cadere lo
> scenario sulla prima assert ("il risultato di memory_why non porta il
> connettore").
>
> **B10 chiusa 04/09/2026 (slice/b10-immagini-ed-errori, issue #361).** Il gap
> era solo lo scenario: le immagini arrivavano già al modello (`ingest()`,
> b815751), ma il finto Bot API dell'accettazione non serviva `getFile`, quindi
> nessuno scenario poteva mettere byte veri dietro un `file_id`. Il finto Bot
> API serve ora `getFile` e il download `/file/bot<token>/<file_path>`
> (`FakeTelegram.plantFile`, `evals/acceptance/telegram.ts`), più un rifiuto
> one-shot (`FakeTelegram.guasta`) per la metà «errori». Due scenari sul
> binario vero (`b-immagini-ed-errori.accept.ts`): `B10` (una foto reale
> attraversa Bot API finto → download → vault → `image_url` con i byte esatti
> scaricati) e `B10-errori`, non manifestato per la stessa ragione di B1 in
> `b-telegram-journey.accept.ts` (il manifest è 1:1 per riga) — una
> `editMessageText` rifiutata a metà consegna resta `rejected`/`failed:<why>`
> in `telegram_delivery_parts`/`turns.delivery`, mai promossa in silenzio a
> `sent`, e il messaggio successivo dell'owner ne innesca il retry senza
> richiamare il modello. Mutazione verificata: rimuovere lo spread
> `images:` in `connector.ts#ingest` fa cadere `B10`; far saltare
> `store.rejected(...)` in `delivery.ts#deliverTelegram` fa cadere
> `B10-errori` su un'asserzione precisa (`part 'attempting'` invece di
> `'rejected'`), non su un timeout generico.
>
> **Conteggio: 22 READY · 28 BLOCKER · 6 OUT · 0 INVALIDATED** (56 righe). Dei
> 12 restanti che aspettano una decisione o un meccanismo (13 meno C5): A2/A3
> (character eval), B1 (metà Telegram), B2/B16 (busy-input), B15 (binding nel
> RoT), C8 (prerequisiti reali), D6/D7 (percorso felice senza provider veri),
> E1 (per-job), E5 (composite), E6 (per-capability).

Stato: `READY` · `OUT` (fuori da DAY-1, con ragione) · `BLOCKER` (con cosa
manca e la slice del percorso critico che la chiude) · `INVALIDATED`
(premessa non più valida, con ragione). `?` è ritirato dal 17/08 — le due
eccezioni sopra sono temporanee, non una riabilitazione dello stato.

### A · Installazione e ciclo di vita

| # | Area | Domanda DAY-1 | Stato |
|---|---|---|---|
| A1 | Boot | Muffin parte da solo e recupera lo stato? | READY — accettazione: gateway vero SIGKILLato a metà vita, un secondo processo lo sostituisce e riprende un turno sospeso (`wait`) più un job dovuto, ciascuno consegnato **una sola volta** (righe `turns`/`turns.delivery`/`jobs.last_run_at` provate, non assunte — mutation-testato: `markRan` disattivato a mano rifà partire il job all'infinito e lo scenario va rosso, `evals/acceptance/scenarios/a-lifecycle.accept.ts`), `muffin gateway status`/`doctor` sani prima e dopo, `SIGTERM` drena ed esce `EXIT_STOPPED`. Due gap chiusi con test: `TelegramConnector.run()` riprova `getMe()` con backoff invece di morire una volta sola quando la rete non è pronta al boot (`connectors/telegram/reconnect.test.ts`, rosso confermato pre-fix); `doctor` verifica il **supervisore** (unit/plist al suo posto + enable/linger su Linux o launchd su macOS), non solo il processo (`core/gateway/supervisor.ts`, mai `fail`, sempre un rimedio) — un `muffin gateway run` a mano ora si legge distinto da uno supervisionato. Reboot reale della macchina target = battery §10 di `day1/readiness-criteria.md`, non provato qui. ADR-0035 §Continuità appartiene a Muffin, non al pid. |
| A2 | Identity | Sa chi è e quali limiti ha? | READY — il contenuto era già provato (identity.md sigillata nel RoT, raggiunge il prompt reale, scenario A2). La metà che mancava era la baseline: **corsa del 04/09 sui modelli DAY-1** (`docs/evidence/character-baseline-2026-09-04.md`, `npx tsx evals/character/con-la-chiave.ts`): main 68/75 pass, light 62/75 con 2 misure perse su `needs-measuring` (da rifare). `epistemically_honest` e `inference_is_not_fact` passano su tutti i probe del main: sa cosa non sa. Reperto: 5 dei 6 fail del main sono dell'harness (headless senza approvatore, `sys.shell` chiede sempre) e il sesto è la nostra frase dell'ask — aperto come lavoro sull'eval, non sul modello. |
| A3 | Persona | Il comportamento è definito? | READY — persona/voice raggiungono il prompt reale nell'ordine canonico (scenario A3, byte-identico). La baseline sui modelli DAY-1 esiste dal 04/09 (`docs/evidence/character-baseline-2026-09-04.md`): `recognizably_muffin`, `natural`, `not_assistanty`, `non_sycophantic`, `point_of_view` passano sul main; il light ha tre fail suoi (emozione inventata, azione imposta con dettagli inesistenti, tic `🧁`) che sono la lista per `models.light`. Il confronto col vecchio `Muffin.ai` (punto 8 del mandato) resta un desiderio, non un blocco: il vecchio non ha un metro comparabile e la tesi §7 non richiede continuità di voce fra generazioni. |
| A4 | Config | Si configura senza toccare il codice? | READY — scenario `A4` verde (`a-lifecycle.accept.ts`, #285): un hand-edit di `config.json` (`models.main`, fuori sigillo) vincola senza reseal — lo dice `muffin config --json` e lo riceve davvero il provider; un hand-edit di `rot/budgets.json` (`monthlyUsd` a 0, dentro il sigillo) vincola **prima** del reseal (il turno vero si ferma con exit 4) mentre `doctor` lo chiama manomissione finché `muffin rot reseal` non lo fa proprio dell'owner. `muffin config` resta read-only per disegno (ADR-0036) |
| A5 | Doctor | Individua **davvero** i problemi? | READY — manomissione reale di `rot/policy.json`, `doctor` la rileva e nomina il file con un rimedio azionabile (`evals/acceptance/scenarios/a-lifecycle.accept.ts:56-94`, verde); ogni check esegue, non assume (`cli/doctor.ts:45-568`) |
| A6 | Upgrade | Aggiornare il codice non distrugge dati? | READY — il verbo `muffin update` esiste (`cli/update.ts`, da 9f56484) e la journey è provata da `A6` (`a-lifecycle.accept.ts`, #285): `runUpdate` — la funzione che `cmdUpdate` chiama — con i soli seam documentati (`moduleDir`, `bindirs`) e tutto il resto vero: git contro un checkout+origin usa-e-getta, `npm ci`, smoke test, `backupNow` su una home popolata; il backup precede lo swap del launcher (invertire l'ordine in `update.ts` fa cadere lo scenario, mutazione verificata) e i dati scritti prima sopravvivono. Limite dichiarato: non si spawna il binario `muffin update` perché `findCheckoutRoot` risale al checkout principale della macchina — un `--dry-run` muterebbe il repo vero. **03/09**: il verbo esisteva e diceva il falso per omissione — «già aggiornato» su `main` mentre `dev` era avanti di sette commit non promossi, misurato sulla macchina dell'owner. Chiuso da ADR-0057: `--channel <main\|dev>`, la distanza dell'altro ramo nominata sempre (numero + ramo + comando), e l'elenco dei soggetti arrivati dopo lo swing |
| A7 | Migration | Lo schema evolve senza perdere memoria? | READY — scenario `A7` verde (`a-lifecycle.accept.ts`, #285): un DB popolato riportato a uno `schema_version` precedente viene migrato dal binario vero (`MIGRATIONS` v2/v3) con righe intatte e backfill applicato (neutralizzare il backfill v3 fa cadere lo scenario, mutazione verificata); un DB marcato **oltre** il codice rifiuta prima di scrivere (`SchemaAheadError`). `rebuildTable` (allargamento di un CHECK) resta provato solo a livello unit: nessuna migrazione di produzione lo chiama ancora |
| A8 | Backup | La memoria si salva e si ripristina? | READY — scenario `A8` riscritto (`a-lifecycle.accept.ts`, #285) sui verbi veri: `muffin backup` produce il file che dichiara con `quick_check`, `muffin restore <file> --yes` mette da parte il DB corrente, ripristina (**sostituisce**, non aggiunge: ciò che è stato scritto dopo il backup non si trova più) e la memoria ante-backup torna trovabile; WAL-safe e SIGKILL provati in `cli/backup.test.ts`. Restano dogfood: matrice hot-backup sotto carico e retention/cron |
| A9 | Setup locale | `muffin init --local` riusa i segreti persistiti per un'installazione pulita di prova? | READY — `muffin init --local [<dir>]` (default `~/.muffin-local`) risolve `home` su quella directory e lascia il passo «api key» leggerlo dalla stessa catena `locateSecret` contro quella home — mai una copia (`cli/main.ts:276-303`); guardia realpath rifiuta un `<dir>` che coincide con la home reale o le sta annidato sotto, anche attraverso un symlink, prima di scrivere qualunque cosa (`cli/init.ts:47-93`, unit test con symlink `cli/init.test.ts`); scenario di accettazione sul binario vero — segreto scritto sul backend persistent isolato dall'harness (mai quello reale), `init --local` lo trova senza copiarlo, `muffin doctor` sano sulla home locale, la home originale invariata (hash prima/dopo), `--local` sulla home reale rifiutato con exit 78 (`evals/acceptance/scenarios/a-lifecycle.accept.ts:293-364`, verde, manifest `evals/acceptance/manifest.ts`) |
| A10 | Giro owner | Il giro dalla macchina pulita alla risposta — install, gateway supervisionato, conversazione, uninstall pulito — funziona nell'ordine reale, uno dietro l'altro? | READY — uno scenario solo, sull'ordine reale che l'owner digita (`evals/acceptance/scenarios/e2e-giro-owner.accept.ts`): `muffin init` (config/db/RoT sigillato asseriti, non assunti) → `secret set --persist` avvisa che la home ha la precedenza (`SECRET_BACKENDS`, `core/config/config.ts`) e nomina la copia vincente → `muffin doctor` con ogni WARN dichiarato e nominato per questo punto del giro (`root of trust mode: single-user`, `vector index`, `consolidamento`, `gateway` — nessuno di questi un `fail`) e la riga `api key` risolta a una sola copia dopo il doppione → `muffin gateway install`: la unit passa il parser della piattaforma vera (Linux: `systemd-analyze verify`, gated `MUFFIN_REQUIRE_SYSTEMD` come `core/gateway/unit.test.ts`; macOS: `plutil -lint` sul testo di `planUnit()` chiamato **direttamente con un `homeDir` di scratch**, mai passando per `cli/gateway.ts`, che su questa piattaforma deriva il percorso da `homedir()` reale — la label `ai.muffin.gateway` è quella del gateway vivo dell'owner su questa stessa macchina, e lo scenario non scrive mai in `~/Library/LaunchAgents` né invoca `launchctl`) — la gamba non eseguibile sulla macchina corrente lo dichiara (asserzione, non solo commento) invece di saltare in silenzio → gateway vero (`inst.gateway()`), `muffin gateway status` lo vede → pairing Telegram sul binario vero (`evals/acceptance/telegram.ts`, come i scenari `b-*`) e un turno reale consegnato (`turns.delivery = 'sent'`, non solo stdout) → un episodio tenant-scoped registrato e ripescato da un secondo processo `muffin run` (pattern C1) → `muffin uninstall --yes` (stdin, mai `rm`): la home sparisce, il segreto `--persist` sopravvive (ADR-0039), quello in home no. Sotto i 30s (tick del gateway accelerato, nessun poll a spawn ripetuto). Nota onesta: la gamba «il supervisore lo tiene davvero su» è provata da Linux, non da questa macchina — macOS valida solo il testo della unit, mai il supervisore reale. |
| A11 | Install pulita | Su una VPS Linux vuota, l'installazione è un'esperienza pulita — un comando, `doctor` verde, gateway sotto systemd, aggiornamento e rollback — senza conoscere il repo? | READY 06/09/2026 — un comando solo (`curl -fsSL .../install.sh \| sh`, oppure `sh install.sh` da un tar), e `install.sh` possiede adesso tutta la riga invece dei soli passi finali: pacchetti OS, **Node 22 dal tarball ufficiale** sotto `~/.local/share/muffin/node` (Ubuntu 24.04 spedisce Node 18; né nvm né fnm, che una unit systemd non sorgerebbe mai), `git clone` in `~/.local/share/muffin/src`, `npm ci`, il launcher in `~/.local/bin`, `muffin init` con la chiave **solo da stdin** (`MUFFIN_API_KEY_FILE` passa un percorso, mai il valore — ADR-0048) e `muffin gateway install --write --start`. Codice e Node stanno **fuori** da `~/.muffin` di proposito: `muffin uninstall` cancella quella directory, e l'`Environment=PATH` della unit punta proprio a quel Node. La prova è eseguibile e sta nel cancello, non a mano: `.github/workflows/install.yml` esegue `bash evals/install/ubuntu.sh` dentro il container `ubuntu:24.04` di `ci:local` (`MUFFIN_CI_LOCAL_ONLY=install npx tsx scripts/ci-local.ts`). Parte da una macchina **senza Node** — il PATH è ricostruito dalle sole directory di sistema e lo script si rifiuta di proseguire se `node` è ancora raggiungibile — con `HOME` usa-e-getta e un origin git locale fissato al commit in prova. Corse del 06/09/2026: **PASS in 39-69s** (quattro giri; la varianza è il carico dell'host, non il lavoro), 35 check di `doctor`, **0 rossi**, 7 gialli tutti nominati. Mutazioni verificate, due, ciascuna con il proprio messaggio: saltare l'installazione di Node → rosso su «no Node under .../node — install.sh did not resolve the Node 22 prerequisite»; scrivere la unit senza abilitarla (`--write` senza `--start`) → **un solo** check rosso, «install.sh exited 0 on a machine with no user systemd — it should exit 3 and say so», con tutto il resto ancora verde. Ripristinato, verde. Tre limiti dichiarati, non aggirati. **(1)** `doctor` esce **1**, non 0: esce 0 solo in assenza di qualunque WARN, e in un container i WARN sono legittimi (niente sandbox senza userns, indice vettoriale vuoto, consolidamento mai girato). La condizione eseguibile è perciò «nessun check di livello `fail`», non «exit 0». **(2)** In un container non esiste un'istanza systemd utente (`Failed to connect to bus`), quindi `systemctl --user is-active` non è asseribile: `install.sh` esce **3** — installato, gateway non attivo — e la prova **verifica quella scusa** invece di accettarla, con `systemd-analyze verify` sulla unit scritta più un avvio in primo piano del suo `ExecStart` fino a un pid vivo visto da `muffin gateway status`. Dove un'istanza systemd utente c'è davvero, lo script prende da solo la strada forte (`is-active` più `loginctl Linger=yes`). **(3)** Il container locale è **arm64**; `ubuntu-latest` e la VPS sono x86_64, e nessuno ha ancora eseguito questo comando su una VPS Ubuntu vera. La gamba macOS/launchd di `install.sh` non è esercitata da questa prova. Difetto trovato dalla prova e chiuso nello stesso giro: `muffin update --rollback` faceva il flip **in silenzio** — `rollback()` in `cli/update.ts` accumulava il proprio passo senza emetterlo, quindi il comando stampava `checkout` e poi nulla, e «tornato a <sha>» e «non c'era nessuna release precedente» apparivano identici. Ora emette, e la prova lo asserisce. Documentazione: `docs/INSTALL.md`, mappata in `docs/README.md`; la sezione «Try Muffin» del README è riscritta sul comando unico. |

### B · Continuità del runtime

| # | Area | Domanda DAY-1 | Stato |
|---|---|---|---|
| B1 | Conversation | CLI e Telegram condividono **davvero** sessione e memoria? | READY — **e dal 03/09 condividono la sessione, non solo la memoria** (ADR-0056): l'id di sessione esce da `identify` ed è `owner` per il principal owner su ogni porta, quindi ciò che è stato detto su Telegram è nella **finestra reiniettata** del turno CLI successivo — non più soltanto ripescabile dal recall. La frase precedente di questa riga, «le sessioni restano distinte per costruzione», era vera fino a quel giorno e ora è falsa per la DM dell'owner (resta vera per i gruppi, che hanno una chiave per stanza). Il failure che l'ha chiusa è misurato: «non sembra di star parlando allo stesso muffin» (`docs/evidence/continuita-e-provenienza-2026-09-03.md`). Prove: scenario CLI `B1` (`b-continuity.accept.ts`), la metà Telegram (`b-telegram-journey.accept.ts`, #286) e, per la fusione, `b-una-conversazione.accept.ts` sul binario vero — la riga Telegram compare marcata `[telegram]` nella finestra e non nell'ultimo messaggio utente dove viaggia il recall; il collegamento via memoria tenant-scoped resta e copre tutto ciò che è più vecchio della finestra |
| B2 | Busy work | Una Surface continua a ricevere durevolmente mentre Work è vivo, e l'input successivo può diventare `COLLECT` / `STEER` / `FOLLOWUP` / `INTERRUPT` a un safe boundary? | READY — **chiusa il 04/09/2026 dalla corsia reale** (`evals/e2e/telegram.ts`, modello vero, Bot API vera, owner al telefono): 9 asserzioni su 9 verdi sul filo registrato. Il secondo messaggio mandato mentre il primo girava e' stato confermato in **0,1s** («in coda: rispondo appena finisco»), in risposta al messaggio giusto, e **prima** della risposta al primo; entrambi poi risposti nell'ordine. La superficie ha continuato a ricevere durevolmente mentre il Work era vivo. Filo e comandi in `docs/evidence/e2e-telegram-2026-09-04.md`. **Aggiornata il 06/09/2026 — la risposta dipende dalla stanza.** `Surface.negotiate(place)` (`core/surface/types.ts`) dichiara la catena per `(porta, stanza)`: in **privato** `['draft','edit','off']` con `draftTtlMs` 30 s — l'anteprima effimera di #388 torna, ma **rinnovata dentro la finestra**, perche' il difetto misurato il 04/09 era il rinnovo mancante e non la bolla; la risposta che la chat conserva resta un messaggio **vero e uno solo**. Nei **gruppi e nei topic** `['edit','off']`, nessuna anteprima (`sendMessageDraft` e' documentata solo per le chat private, e `assertNegotiable` rifiuta la dichiarazione alla registrazione della porta), con i due limiti della Bot API tenuti separati: un edit al secondo per chat e venti al minuto per gruppo. Rinnovo misurato con l'orologio finto in `connectors/telegram/transcript.test.ts`; il filo di un bot vero ha guadagnato due asserzioni in `evals/e2e/telegram.ts` (anteprima presente con un solo `draft_id`, nessun buco oltre i 30 s) **non ancora eseguite**: la corsa con bot vero e' dell'owner. |
| B3 | Wait | Può aspettare **senza bloccare il runtime**? | READY — `wait` sospende la riga e RILASCIA il runtime; la corsia del gateway la risveglia, e `doctor` avverte se non ne gira nessuna |
| B4 | Todo | Mantiene lavoro multi-step persistente? | READY — tabella `todos` con `tier`, letta nel contesto di **ogni** turno della sessione. **Dal 03/09 (ADR-0056) il piano aperto dell'owner è uno solo attraverso le porte**, perché `todos.open(tenant, session.id)` riceve la chiave condivisa: è il comportamento che ADR-0045 §1 vuole («il lavoro non è posseduto da una porta»), ed è un cambiamento osservabile — i todo legati agli id di sessione vecchi restano nel database e non compaiono più |
| B5 | Resume | Se muore a metà, riprende? | READY — accettazione: processo vero ucciso con SIGKILL a metà turno, riprende al riavvio |
| B6 | Retry | Se fallisce una tool call, recupera? | READY — retry per-tool (`eseguiConRitentativi`, `agent/loop.ts`, `MAX_TOOL_RETRIES=2`; `http.ts`/`search.ts` marcano transienti/5xx) provato da `agent/tool-retry.test.ts` (unit) e, sul binario vero, da `b-retry.accept.ts` (#284): un `http_get` verso `127.0.0.1` allowlistato è fermato dal pavimento SSRF (`core/net/egress.ts` `isForbiddenAddress`) e registrato **una** volta — e togliendo quel pavimento (mutazione) il 503→200 arriva davvero al modello: il percorso felice è provato per mutazione, non ripetibile in CI perché l'harness può legare un server solo a indirizzi che il pavimento vieta per disegno |
| B7 | Scheduler | I job sopravvivono al riavvio? | READY — l'identità dell'occorrenza è chiusa (`slice/job-fires`, ADR-0035 emendamento №5). `job_fires` (`core/scheduler/job-fires.ts`, additiva, `(job_id, scheduled_for)` UNIQUE) lega ogni occorrenza dovuta a UN `turn_id`: `agent/scheduler-run.ts`'s `makeJobRunner` lo lega **prima** di chiamare il modello, e risolve un fire già legato (turno `done` → recupera testo/settle senza richiamare il modello; `runnable`/`running`/`waiting`/`interrupted` → cede alla corsia dei turni). `core/scheduler/scheduler.ts` guadagna due esiti (`FireDeferred`, `FireSettleOnly`) e un `settleFire` chiamato **prima** di ogni `markRan`, mai dopo. Matrice dei sette punti dell'owner, provata: i cinque interni con lo store/il runner reali (`core/scheduler/job-fires.test.ts`, `agent/scheduler-run.test.ts`, `core/scheduler/scheduler.test.ts` — quest'ultimo con la mutazione dell'ordinamento eseguita a mano, osservata rossa, ripristinata); i due che il mandato chiede col binario vero — crash fra il binding e la creazione del turno, e turno `done` prima di `markRan` — provati da `evals/acceptance/scenarios/job-fires.accept.ts` (riga B7 del manifest), due `SIGKILL` reali su `muffin gateway run` nelle due finestre (rese osservabili da `MUFFIN_JOB_FIRES_STALL_*`, stesso precedente di `MUFFIN_GATEWAY_TICK_MS`), verificato anche contro due mutazioni a mano (identità ignorata del tutto; bind interrotto completato con un id nuovo invece di quello legato) entrambe rosse per la ragione attesa. La proprietà resta occurrence→Work idempotente; ADR-0052 vieta di generalizzarla in “ogni transport event deve avere un Turn proprio”. Telegram riusa le primitive di idempotenza in #78, ma sotto event→composition→Work. |
| B8 | Delivery | Un job che dice «inviato» è **arrivato**? | READY — canale non connesso → `failed:<why>`, mai `sent`, e `doctor` lo nomina ⚠️ nota sotto |
| B9 | Proactivity | Agisce spontaneamente secondo i gate? | OUT — post-DAY-1: nessuna capability §5 dei 14 giorni dipende da trigger proattivi; `ProactiveKind` ha oggi 4 valori (non 5, `consolidation` rimosso da ADR-0038), `gone_quiet` ha un produttore reale (`core/scheduler/observe.ts`) cablato solo su invocazione manuale (`muffin observe --send`); `commitment_due` ne ha uno da ADR-0060 (`core/scheduler/commitments.ts`, un `todos.due_at` letto dal tick dello scheduler, prima consegna proattiva che non passa dal dito dell'owner); `deadline_near` e `fact_actionable` restano fuori finché non emerge un consumer reale → `docs/ROADMAP.md` “Proactivity beyond explicit jobs” |
| B10 | Telegram | Messaggi, file, immagini, **errori** | READY — messaggi e documenti ok (provato, vedi C7); **le immagini arrivano al modello** (`ImageBlock` in `agent/providers/types.ts`, `ingest()` di `connectors/telegram/connector.ts` → `images:` del turno, da b815751 del 28/08; il vault non le indicizza per scelta — si mostrano, non si trascrivono in testo). **04/09** (issue #361): il finto Bot API dell'accettazione serve ora `getFile` e il download `/file/bot<token>/<file_path>` (`FakeTelegram.plantFile`/`guasta`, `evals/acceptance/telegram.ts`), e due scenari sul binario vero lo provano — `B10` (una foto reale attraversa Bot API finto → download → vault → arriva al modello come `image_url` con i byte esatti) e `B10-errori`, non manifestato (una `editMessageText` rifiutata a metà consegna resta `rejected`/`failed:` in `telegram_delivery_parts`/`turns.delivery`, mai promossa in silenzio a `sent`, e il messaggio successivo dell'owner ne innesca il retry senza richiamare il modello) — `evals/acceptance/scenarios/b-immagini-ed-errori.accept.ts`. Il difetto «documenti non indicizzati in produzione» che questa riga citava (nota C7/B10/C8 qui sotto) era già chiuso il 03/09, prima di questa slice. |
| B11 | Streaming | La risposta arriva mentre si forma, o solo alla fine? | READY — **chiusa il 04/09/2026 dalla corsia reale** (`evals/e2e/telegram.ts`, modello vero, Bot API vera, owner al telefono): 9 asserzioni su 9 verdi sul filo registrato. La risposta si forma dentro un messaggio **vero e durevole**: 7 edit successive sullo stesso messaggio, zero `deleteMessage`, niente oltre i 4096 caratteri. Da #388 la risposta finale **edita** il messaggio della scia invece di aggiungerne uno: una bolla per turno, che era esattamente la lamentela dell'owner («mi sta rispondendo due volte»). Filo e comandi in `docs/evidence/e2e-telegram-2026-09-04.md`. |
| B12 | Overflow | Un output enorme di un tool va in contesto, o diventa un file richiamabile? | OUT — ROADMAP “Overflow / context-pressure UX”: `agent/context/compact.ts:89-101` sostituisce l'intero payload con un placeholder invece di troncare testa+coda (un difetto noto, non solo una mancanza); nessun overflow-a-file esiste; B11 copre già il segnale di presenza durante l'attesa |
| B13 | Progress | Un turno lungo dice di essere vivo in modo **strutturale**, non cosmetico? | READY — **chiusa il 04/09/2026 dalla corsia reale** (`evals/e2e/telegram.ts`, modello vero, Bot API vera, owner al telefono): 9 asserzioni su 9 verdi sul filo registrato. I passi ci sono ancora **alla fine**, non solo durante — verificato sullo stato finale del messaggio, non sull'esistenza di una scrittura qualsiasi: l'ultima edit contiene ancora `✓ leggo un file`, `✗ … interrotto`, `✓ sys.shell: consentito`, `✓ eseguo un comando`. La specifica «mai una cronologia» resta rovesciata, come chiesto il 03/09. Filo e comandi in `docs/evidence/e2e-telegram-2026-09-04.md`. |
| B14 | Attachment | Un file prodotto arriva come **allegato**, o come percorso da copiare a mano? | READY — scenario `B14` verde (`b-telegram-journey.accept.ts`, #286): `send_file` → `sendDocument` multipart reale sul finto Bot API con filename, byte count e caption giusti, sulla chat dell'owner; il turno registra «inviato: report.txt». Resta il limite noto: un member non può ricevere un proprio file (`hostOnly`) |
| B15 | Owner binding | Ogni surface riconosce l'owner solo da un subject-id stabile autenticato e protetto? | READY — **chiusa il 05/09/2026 (`slice/b15-owner-nel-rot`, issue #363)**: la metà "protetto" ora esiste — il pairing scrive il legame in `rot/owner.json` **dentro il sigillo** e risigilla nello stesso atto (`sealOwnerBinding`, `core/rot/owner.ts`), `connectSurfaces` costruisce `TelegramConfig.ownerUserId` da lì (`cli/surface.ts:832`) e `config.json` vale solo su una casa che il sigillo non ha mai coperto; un legame sigillato che non si verifica non autentica nessuno e **non** retrocede su `config.json`. Scenario `B15` verde sul binario vero (pairing → `rot/owner.json` con l'id giusto → `muffin rot verify` ancora pulita → `muffin doctor` che nomina la provenienza), più il cablaggio in `cli/owner-sigillato.test.ts` (sigillo A vs config B: A comanda, B è uno sconosciuto). Mutazione eseguita il 05/09/2026 — sostituita la sola riga `telegramOwner(sealedOwner, tg)` di `cli/surface.ts` con la lettura diretta di `config.json`: il test del cablaggio diventa rosso su `expected true to be false`, perché l'account che solo `config.json` nomina esegue `/pause` e riceve «in pausa: nessun job»; ripristinato, verde. Le due metà preesistenti restano: `identify()` unica e cablata su Telegram e Discord, DM-only su `channel_type`. **Riserva del giudice (05/09/2026):** in modalità `single-user` (il default) `rot/`, `.rot-anchor` e `config.json` hanno lo stesso proprietario OS e gli stessi permessi, quindi chi può scrivere la home può **risigillare** una catena coerente (`owner.json` + manifest + ancora con `sha256` pubblico) e `doctor` la mostra come un pairing legittimo: la protezione è reale solo sotto `hardened` (ADR-0003: rilevato, non impedito — e un reseal coerente non è rilevato). La riga resta READY perché la claim DAY-1 è il *cablaggio* (una sola sorgente, niente fallback); il «protetto» pieno è `muffin rot harden`, già azione owner. |
| B16 | Typed ingress | Gli input DAY-1 sono multipart tipizzati con provenance/taint per parte e parentela durevole `native event → composition → Work`, senza provenance laundering? | READY — **05/09/2026**, scenario `B16` verde sul binario vero (`evals/acceptance/scenarios/b-ingresso-tipizzato.accept.ts`), attraverso il finto Bot API (stesso seam di B10): un messaggio inoltrato tiene `FORWARD_TIER` (2) e il suo recinto `[inoltrato]`; una reply-con-commento a un messaggio di un terzo tiene il proprio recinto `[citato]` e tier, mentre la nuova frase dell'owner nello stesso messaggio resta fuori da quel recinto (mutazione verificata: farla rientrare nel recinto del citato fa cadere rosso lo scenario, ripristino verde). Copre il perimetro DAY-1 effettivamente usato (testo, reply/forward); voce è C8, file/immagini restano B10/B14. L'envelope universale per metadata senza consumer resta OUT (issue #364) — questa riga non lo richiedeva, chiedeva la prova sul binario del minimo già in HEAD. |
| B18 | Ingresso unico | Ogni superficie entra dallo stesso percorso — evento tipizzato → composizione → turno — così che streaming, passi, approvazioni, coda e `/steer` esistano **una volta** e non per connettore? | READY — **chiusa il 06/09/2026**, fase B del disegno `docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md` §3, fette 10-16 (PR #434 `types`, #439 `compose`, #444 `remember`+`pair`, #445 `lane`, #448 router+`ingest`+`work` e Telegram porta, e questa fetta 15-16: Discord porta e il test di parità). Il registro aveva unificato **solo l'uscita**; l'ingresso ha adesso il gemello in `connectors/shared/ingress/`, con `receive`/`recover` e i dieci stadi di `INGRESS_STAGES` — un array **iterato** dal router, non una lista dichiarativa, così toglierne un elemento toglie il comportamento dalla produzione. I due connettori sono porte: costruiscono un `InboundEvent` e chiamano il router, e `turns.surface` viene da `port.surface.id` (§4 inv. 1) invece che da un letterale per connettore. **Criterio eseguibile, misurato:** `connectors/shared/ingress/parita.test.ts` esiste con i quattro `describe` di §2.6, e le quattro mutazioni sono state rosse e poi verdi — A (reimportare `runTurn` in Discord) → describe 3; B (togliere `busy` da `INGRESS_STAGES`) → describe 2 rosso **su entrambe le porte**; **C (inlinare gli stadi nel drain di Discord importando i moduli condivisi) → describe 4 rosso, e solo il 4**: i describe 1, 2 e 3 restano verdi, che è esattamente il falsificatore che §5 nomina per tutta la fase B; D (una cella `nonApplicabile` non dichiarata in `DIVERGENZE_AMMESSE`) → describe 1. `DIVERGENZE_AMMESSE` contiene `gate` e `remember` per Discord dal giorno uno, citando `parseMessage:155-156`. Fase C (parità Discord: comandi e avviso di coda, approvazioni, transcript, consegna per parti, provenienza) segue e **non è DAY-1**: ogni fetta cancella una riga da `DIVERGENZE_AMMESSE`. Provata dal meccanismo, non da uno scenario di accettazione: ciò che la regge è `parita.test.ts` — vedi `evals/acceptance/manifest.ts`. |
| B19 | Nucleo modulare | Il loop del turno è un nucleo stretto di moduli nominati, ciascuno col suo test gemello, e non un monolite che solo `runTurn` sa attraversare? | READY — **chiusa il 06/09/2026**, fase A del disegno `docs/evidence/ingresso-unico-e-nucleo-2026-09-05.md` §3, nove fette in ordine (PR #435 tipi+barile, #438 `stream`/`context`/`permissions`, #440 `tool-call`, #443 `run-state`, #446 `durability`, #447 `round`+`engine`+`entry`). Il criterio eseguibile che la riga si era data, misurato: `wc -l agent/loop.ts` = **54** — un barile che conserva ogni nome per i 35 importatori (§4 inv. 8), contro le 4.428 righe di partenza; **nove moduli con il gemello** sotto `agent/loop/` (`stream`, `context`, `permissions`, `tool-call`, `run-state`, `durability`, `round`, `engine`, `entry`, ciascuno col suo `.test.ts`), più `types.ts` che non ha un gemello di proposito — la sua superficie è di tipi, guardata da `tsc` e da `barrel.test.ts` che asserisce i cinque export di valore; **per ogni fetta la mutazione della tabella §3 è stata rossa e poi verde** (registrate nel corpo di ciascuna PR, con il conteggio dei test falliti); **i 23 scenari di accettazione verdi a ogni confine di fetta** (§4 inv. 10), incluso `b-continuity` nominato per le fette 6, 7 e 9. `resumes` è rimasto `const` (§5: un resume contato due volte contro `MAX_RESUMES` è un turno che rifiuta di riprendere). Provata dal meccanismo, non da uno scenario di accettazione: la riga parla della forma del codice, e ciò che la regge è `agent/loop/barrel.test.ts` più i nove gemelli — vedi `evals/acceptance/manifest.ts`. |
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
| C5 | Provenance | Posso capire **perché** crede una cosa? | READY — `agent/tools/memory.ts` registra ora `memoryWhySpec`/`whyMemory`, cablato in `agent/runtime.ts` accanto a `memory_search` sulla stessa `memoryCapability` (`memory.read`); CLI e tool leggono le stesse righe da `describeProvenance` (`core/memory/provenance.ts`), unificato da `cmdMemoryWhy` (`cli/memory.ts`). Scenario `C5` verde (`c-memory.accept.ts`): un turno vero chiama `memory_why` per testo (nessun fact_id in mano, il caso ordinario) e la richiesta successiva del modello porta connettore, tier reale e frase originale del episodio piantato; commentare la registrazione in `agent/runtime.ts` fa cadere lo scenario sulla prima assert (`"il risultato di memory_why non porta il connettore (\"discord\")..."`) — mutazione verificata |
| C6 | Temporal graph | «Chi era X a maggio» | READY — scenario `C6` verde (`c-tempo.accept.ts`, #283): fatti superseded a due date, «chi era il capo progetto a maggio» risponde con il valore di maggio sia via CLI (`memory search --as-of`) sia via tool (`memory_search` con `as_of`) sul binario vero; non esercitato `nearestFactTo`/il report del gap (limite dichiarato, non DAY-1) |
| C7 | PDF | Acquisisce documenti utili? | READY — scenario `C7` verde (`c-documenti.accept.ts`, #283): un PDF vero con testo entra da `muffin vault add`, si indicizza ed è trovato da `memory search`; una scansione senza testo fallisce esplicitamente (exit 1, ragione nominata, zero episodi) — togliere il ramo `no_text_layer` fa cadere lo scenario (mutazione verificata). Il path Telegram allegato→vault resta provato da `connectors/telegram/document-arrival.test.ts` (non-acceptance) perché il finto Bot API non serve `getFile`; DOCX e il tool `document_read` non sono nello scenario. **03/09**: fino a questa slice l'ingest era morto sull'installazione vera — la home `~/.muffin` faceva scattare il filtro dotfile sul percorso assoluto e ogni allegato veniva rifiutato come «nascosto» (zero episodi `document` nel database dell'owner, tre file nel vault); ora le home di test hanno la forma di produzione, vedi la nota C7/B10/C8 |
| C8 | Audio | Gestisce le note vocali DAY-1 conservando audio originale e provenance del transcript? | READY — **05/09/2026**, scenario `C8` verde sul binario vero (`evals/acceptance/scenarios/c-audio.accept.ts`): una nota vocale Ogg vera attraversa il finto Bot API (`getFile`/download, lo stesso seam aperto per B10) → vault → trascrizione → turno. `audioAccettato` risponde `false` in modo deterministico (il provider finto serve `GET /models` con `data: []`), quindi il ramo preso è sempre "trascritto"; `config.audio.{whisperBin,ffmpegBin}` — una manopola già esistente (ADR-0036) — punta a due script finti al posto di whisper-cli/ffmpeg veri, così la suite non dipende dai binari di questa macchina né da chiavi/chiamate a pagamento. Provato: i byte audio originali restano intatti nel vault, il transcript arriva alla richiesta reale al modello **recintato** (`fence('trascrizione', …)`, etichetta "dati, mai istruzioni") e mai come prosa dell'owner, e nessun blocco `input_audio` parte mai (mutazione verificata: rimuovere il recinto del transcript fa cadere rosso lo scenario, ripristino verde). Resta non provata qui la correttezza di whisper.cpp/ffmpeg stessi — claim su un binario terzo, già verificata a voce dall'owner sulla propria installazione (02/09). |
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
> lo scenario C7 passa dalla CLI e non da `getFile`. **04/09**: il finto Bot
> API serve ora `getFile` (issue #361), e B10 ha il proprio scenario di
> accettazione (`b-immagini-ed-errori.accept.ts`); C8 (nota vocale) resta
> senza, per lo stesso motivo, non affrontato da questa slice.

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
| D6 | HTTP | Naviga secondo policy? | READY — il residuo era «nessuno scenario prova un `allow` con fetch riuscito». Dal 04/09 lo prova D10 (`d-capability.accept.ts`), riscritta dopo ADR-0066: la lettura nuda di `https://example.com/` passa **e il `tool_result` porta il 200 col corpo vero** — la suite di accettazione raggiunge quell'host. Il resto del kernel è cambiato di criterio, non di soglia (ADR-0071, `agent/link-copiato-non-e-composto.test.ts`): un URL **citato** da un ingresso passa a qualunque taint, uno **composto** dal modello chiede all'owner (D10, terzo blocco: `exit 3` con l'URL intero) e viene negato a un membro. Residuo dichiarato in `decide.ts`, non taciuto: `hasParams` non guarda il *path*; chiuderlo inverte ADR-0066 ed è una decisione owner, non una riga di codice. |
| D7 | Web search | Funziona end-to-end? | READY — il residuo era «la journey non prova il percorso felice». Dal 04/09 D7 (`d-capability.accept.ts`) prova al binario vero **due metà**: dopo contenuto tainted la ricerca gira, con il turno già a taint 3 (ADR-0072, `searchMaxTaint` separato da `paramsMaxTaint`); e un `rot/policy.json` che riabbassa la soglia rimette l'`ask` con la query intera — mutazione: far ignorare il file al merge → `exit 0` invece di 3. Il giro «cerca → apri il primo risultato» col tool di ricerca vero è in `agent/link-copiato-non-e-composto.test.ts`. Sull'installazione dell'owner `search.provider=tavily`, chiave presente, `api.tavily.com` in `rot/egress.json`, `doctor` la dice attiva (misurato 04/09, sera). |
| D8 | MCP | Gestisce drift e revoca? | OUT — revoca calda: pinning e sospensione su drift sono solidi (`core/mcp/registry.ts:125 verifyTools`, `agent/tools/mcp.ts:11-24`), ma `muffin mcp remove` lo dice già onestamente («spariscono al prossimo avvio», `cli/mcp.ts:142-152`); il riavvio è un verbo del supervisore → ROADMAP public-alpha “MCP hot lifecycle” |
| D9 | Skills | Scopre e usa le skill senza promuovere descrizioni non fidate a istruzioni? | READY — `slice/skill-di-serie`. La riga chiedeva «injection/fake-close **+ production wiring**»: il recinto era già provato in unità, il cablaggio no, e **non era provabile**, perché `defaults/` non spediva nessuna skill. Su un'installazione vera `skillsPromptSection` tornava stringa vuota, la sezione non esisteva nel prompt e `skill_read` era offerto al modello senza avere un oggetto; su `~/.muffin` dell'owner la cartella `skills` non esisteva proprio. Costruire una skill dentro il test avrebbe misurato il test. Ora `defaults/skills/` ne spedisce due — `collega-telegram` (la procedura reale: il token lo mette l'owner, l'abilitazione la esegue Muffin) e `studia-un-documento` (`vault add` → `memory_search` → `document_read` per intervalli) — e `init` le semina registrandole nel manifest dei default, così un'edit dell'owner resta distinguibile dallo spedito. Accettazione **D9** verde sul binario vero: le skill sono nel prompt di un'installazione nuova, il modello ne attiva una e riceve il corpo, e una `description` che finge di chiudere il recinto perde il tentativo. 4 mutazioni uccise. **Difetto trovato misurando, e riparato qui:** il recinto prendeva un nonce nuovo a ogni chiamata, quindi il system prompt era diverso a ogni processo — e ogni `muffin run` è un processo — perciò il prefisso non era mai lo stesso e la cache del provider non poteva prendere. Nonce ora per-installazione (`core/skills/nonce.ts`), con prova di stabilità fra due boot in `agent/context/assemble.test.ts`. Costo della sezione: 744 caratteri su 23.648, il 3,1%, solo metadati. **03/09/2026 — questa riga era morta su un'installazione aggiornata, e lo è stata dal giorno in cui è stata scritta.** `init` semina le skill in una casa **nuova**; la casa dell'owner era nata prima, e nessuno gliele ha mai portate: il suo `defaults-manifest.json` elencava un file solo (`persona.md`), `~/.muffin/skills` non esisteva, `skillsPromptSection` tornava stringa vuota. Il meccanismo era di nuovo «completo e vuoto», stavolta a valle: spedito e mai consegnato. Riparato da `reconcileDefaults` (`cli/adopt.ts`), che gira dentro `muffin update` sui `defaults/` della release nuova e installa **solo ciò che manca** — mai una sovrascrittura di un file dell'owner. Prova rossa prima: una casa ridotta a com'era la sua non aveva skill dopo la riconciliazione (`cli/home-invecchiata.test.ts`). |
| D10 | Security | Nessuna capability escape? | READY — taint in ingresso chiuso (`slice/taint-in-ingresso`, ADR-0044, giro 2 PR #28: STATE.md "Taint in ingresso — chiuso"); un turno a taint 3 che tenta `http_get` fuori allowlist riceve `deny/resource_denied` dal kernel, mai `ask` — provato end-to-end (`evals/acceptance/scenarios/d-capability.accept.ts`, scenario D10) |
| D11 | Checkpoint | Esiste uno snapshot prima di ogni mutazione, e un ripristino che disfa anche il turno? | READY — entrambe le metà rientrate. Lineage: #253 (`episodes.turn_id`, `RecallItem.turnId`, esclusione del recall per lineage). «L'undo riallinea il turno»: ADR-0067, reimplementata su HEAD dopo che ADR-0053 ha tolto la dipendenza che teneva PR #186 fuori scope (chiusa il 30/08 come SALVAGE, non nel merito — 141 commit indietro, 5 conflitti). Misurato prima di implementare (`cli/undo.ts` toccava solo `UndoJournal`, mai `TurnStore`/`MemoryStore`): dopo un `muffin undo`, `turn_tool_calls.undone_at` ed `episodes.undone_at` (`role: 'agent'`) marcano il turno e la memoria — mai riscritti, mai esclusi dal recall — e `agent/loop.ts` annota il messaggio `assistant` corrispondente alla lettura, senza mai toccare il JSONL di sessione. Due scenari end-to-end sul runtime vero (`agent/runtime-wiring.test.ts`), mutation-testati a mano (marcatura disattivata → rosso vero, ripristino da copia con nome distinto → verde). Residuo dichiarato, non taciuto (ADR-0067 §"Cosa resta fuori"): granularità per-`callId` su un restore parziale (oggi non marca nulla, mai una marcatura totale su un disfacimento parziale), redo asimmetrico (`annulla-<turno>` non pulisce l'`undone_at` originale), riconciliazione di un turno sospeso a metà da un undo concorrente → tracked in issue #367 |
| D12 | Ask | L'ASK mostra **cosa** sta per fare (comando+cwd, URL, pid+nome) e perché il turno è a quel taint? | READY — **chiusa il 04/09/2026 dalla corsia reale** (`evals/e2e/telegram.ts`, modello vero, Bot API vera, owner al telefono): 9 asserzioni su 9 verdi sul filo registrato. L'ASK ha mostrato il **comando intero** (`command: echo ciao`), la frase del modello in corsivo e il contesto del taint («turno a taint 2 — gruppo/sconosciuto»), con la tastiera di conferma. Lo `/stop` a meta' turno ha risposto «fermato» e poi «Interrotto.» Filo e comandi in `docs/evidence/e2e-telegram-2026-09-04.md`. |
| D13 | Uso dei tool | Il modello usa il tool giusto e li concatena, invece di passare da `sys.shell` per tutto? | BLOCKER — misurato due volte il 04/09: 35 approvazioni in tutta la vita dell'installazione, **tutte** `sys.shell`; e nella baseline di carattere 4 fail `agentic` del main nascono da un turno fermo su «serve la tua approvazione per sys.shell» dove esisteva un tool dedicato (`fs_read`, `process_list`, `sys_inspect`). Direzione owner: *«sta usando quello per tutto, forse va cambiato un po' il prompt dei tool e spingerlo ad usarli e concatenarli meglio»*. Chiude: descrizioni dei tool e guida nel prompt riscritte perché il tool dedicato sia la prima scelta e la shell l'ultima; misura **prima/dopo** con la character eval (`agentic`) e con il conteggio degli ask `sys.shell` su un giro reale. Non si tocca il kernel. **06/09:** descrizioni dei 14 tool riscritte (quando sì / quando no / cosa torna / esempio; `shell_run` ultima scelta che nomina i tool dedicati), regola nel prompt, test di forma `agent/tools/tool-descriptions.test.ts`. Misura dopo, un giro (`tool-use-2026-09-06.md`): 4 probe su 22 chiedono ancora la shell — 2 senza tool dedicato (porte aperte, query SQLite), 2 con tool esistente (`ls`→`fs_list`, `env`→`sys_inspect`); i pass del giudice (68→60) sono rumore di un giro solo. Resta BLOCKER: serve un approvatore finto nell'eval, due tool mancanti (porte, SQLite in lettura), e tre giri di misura, non uno. **07/09 (riconciliazione audit):** da #457 la shell in sola lettura non chiede più, quindi le 4 probe vanno **rimisurate prima** di aggiungere tool one-off (cautela dell'audit §14): tre giri con approvatore finto, e un tool dedicato solo dove la misura dice che la shell in sola lettura non basta. |
| D14 | Solo l'irreversibile chiede | Un `ask` arriva **se e solo se** l'azione non si può annullare, e mai perché il turno ha letto qualcosa? | READY — ADR-0074 punti 1-3 (fetta 1: kernel). `RowPolicy` perde `askAbove` e acquista `asksForIrreversible`; `decide.ts` chiede se e solo se `reversible: 'no'` incontra una riga che chiede (`host`, `external`, `outward`), e le tre vecchie cause sono sparite: il taint (`taint > row.askAbove`), la classe (`risk: 'high'`) e la scorciatoia `hardened && owner && taint === 0 → allow`. Il soffitto non si muove (ADR-0044): a taint 3 `fs.write` resta `deny/taint_exceeded`. **Criterio eseguibile:** `core/policy/solo-irreversibile.test.ts` enumera **ogni** `CapabilityDecl` spedita (le 18 di `agent/tools/*.ts`, `sys.shell.write` compresa più le due porte di `doors.ts`) e asserisce l'esito per owner e per un membro di gruppo a taint 0/1/2/3 — mai `ask` per `reversible !== 'no'`, sempre `ask` per `'no'` su `host`/`external`/`outward` a ogni taint sotto il soffitto (owner e `hardened` compresi), mai `ask` per `surface.reply`/`memory.write`, e sotto il soffitto la decisione non cambia col taint; l'elenco delle capability che chiedono è pinnato **per nome** (`sys.shell`, `sys.process.kill`, `mcp.*`), quindi una quarta che comparisse va nominata invece di scivolare dentro. Un `policy.json` sigillato che porta ancora `askAbove` è rifiutato nominando il campo (`core/policy/matrix.test.ts`). Sul binario vero: `b-parita-superfici.accept.ts` misura `leggi → scrivi` su CLI, REPL e Telegram — stesso esito su tutte e tre (**file scritto, copia nel giornale, zero domande**) e lo **stesso** esito a taint 0 e a taint 2, che è l'affermazione «il taint non chiede mai» misurata fuori dagli unit test. **Tre mutazioni eseguite** (backup `cp`, ripristino verificato): (a) `askAbove: 1` rimesso sulla riga `host` → rosso; (b) scorciatoia `hardened` rimessa → rosso; (c) `asksForIrreversible: true` sulla riga `reply` → rosso. Fuori da questa riga, dichiarati: la shell reversibile per costruzione (ADR-0074 punto 4) e le annotazioni MCP (punto 5) sono altre fette — finché il punto 5 non atterra **ogni** chiamata MCP chiede, che è la conseguenza dichiarata dell'ADR e non una regressione. |
| D15 | Registro degli effetti | Dopo ADR-0074 l'owner vede **cosa è passato senza domanda** — per turno e per giornata — e non solo cosa gli è stato chiesto? | BLOCKER — nasce dalla lettura di Centria (`origin/stage`, CONTEXTUAL-AUTONOMY, decisione owner 06/09: «ok, ci sta»): più autonomia chiede più sorveglianza, e ADR-0074 toglie quasi ogni domanda. Oggi `approvals` (`core/approvals/store.ts`) registra solo ciò che è stato *chiesto*; `turn_tool_calls` (`core/turns/store.ts`) registra ogni chiamata ma non la classe di effetto che l'ha lasciata passare. Chiude la riga: (1) ogni chiamata eseguita senza domanda porta la classe di reversibilità e la riga della matrice che l'ha ammessa, durevole nella stessa tabella; (2) una porta unica (`muffin effetti` e lo stesso comando in REPL e Telegram, un meccanismo, due porte) elenca per turno e per giornata ciò che è passato senza domanda; (3) lo scenario di accettazione esegue una scrittura ammessa senza ask e ne trova la riga nel registro, e va rosso quando la scrittura del registro è tolta. Entra dopo le fette di ADR-0074, non prima: senza il kernel nuovo non c'è nulla da registrare. |
| D16 | Taint usabile | Dopo una ricerca web, nella **stessa** conversazione, shell e scrittura restano usabili, e il taint compare come ragione nelle domande invece che come muro? | READY — ADR-0075, accettato il 06/09. La riga nasce da una misura sul `muffin.db` dell'owner: nove turni su quattordici in privato a taint 3, ultima shell vera il 03/09, ultimo turno chiuso da `context taint 3 exceeds 2 for sys.shell (host)` — decisione owner «inutilizzabile in sto modo». Cosa è cambiato: `POLICY_FLOOR.host.denyAbove` 2 → 3 (il file sigillato può ancora stringere, mai allargare); `maxTaint` tolto da `skill.read` e `sys.process.list` (`sys.shell` non ne aveva già più dopo #457) perché **un `maxTaint` non stringe mai una capability reversibile**; sopra il soffitto di `external`/`outward` l'owner riceve un `ask` che cita il taint e chiunque altro il `deny/taint_exceeded` di prima; e il prompt di ogni `ask` porta l'origine del livello quando è > 0 (`PermissionSnapshot.taintOrigin`, scritta dallo stesso `raiseTaint`/`raiseCeiling` che alza il numero — non un secondo registro). `egress`, `searchMaxTaint` e `paramsMaxTaint` (ADR-0071/0072) invariati. **Criterio eseguibile, eseguito:** (1) `core/policy/solo-irreversibile.test.ts` enumera ogni dichiarazione spedita a taint 0/1/2/3 per owner e membro; un test per nome raccoglie ogni `taint_exceeded` della riga `host` e pretende la lista vuota, e due test nuovi pinnano il ramo verso l'esterno (owner `ask` col taint nel testo, membro `deny`, su una dichiarazione `outward.send` sintetica perché nessuna spedita sta su quella riga e il ciclo sarebbe vacuo). (2) Accettazione **D16** verde sul binario vero (`evals/acceptance/scenarios/d-capability.accept.ts`): turno headless, `web_search` e poi `shell_run` nello stesso turno, `taint: 3` nell'esito JSON, exit 0, nessun `pending`, e l'output di `ls` torna al modello; il livello 3 arriva da un episodio piantato e ripescato da `memory_search` — dichiarato nel file — perché l'endpoint di Tavily è una costante e senza rete vera `web_search` tornerebbe `tier: 0`, cioè lo scenario misurerebbe la connessione di chi lo esegue. La seconda metà dello stesso scenario rimette `{"rows":{"host":{"denyAbove":2}}}` in `rot/policy.json`, risigilla, e pretende che il rifiuto torni: il soffitto è una manopola, non una riga cancellata. (3) `evals/security/` rieseguito prima e dopo: **4/8 attacchi completano senza umano e 5/8 se l'owner risponde come ha risposto, identici scena per scena**, controlli vivi 8/8, candidate B batte A su 0/8. Le fixture deterministiche sono state **rimisurate, non allentate**: `s2`/`s6`/`f4` passano da `deny` a `draft`, `s5-external-destination-outward` da `deny` ad `ask`, e la baseline ora asserisce il risultato che ne esce — per l'owner, su ogni scena, A e B danno la stessa risposta. **Tre mutazioni eseguite** (backup `cp`, ripristino verificato): (a) `host.denyAbove: 2` → rosso, con `context taint 3 exceeds 2 for sys.shell (host)` nel messaggio, e D16 rosso sul binario; (b) taint tolto dal prompt (kernel e loop) → 5 test rossi; (c) membro che ottiene `ask` su `outward` → rosso. |

### E · Economia e osservabilità

| # | Area | Domanda DAY-1 | Stato |
|---|---|---|---|
| E1 | Budget | Cap globale **e** per-job? | READY — `slice/e1-budget-per-job` (issue #368): `jobs.per_job_usd` (nullable, additiva, migrazione 6) più `spend.job_id`/`turns.job_id` come contatore, e l'enforcement su `agent/scheduler-run.ts` `runFresh` — l'unico punto del file che chiama il modello — **prima** del ramo `script` e prima della sessione; un giro rifiutato scrive una riga durevole con esito `budget` e modello `(tetto per-job: nessun modello)`, e l'owner la riceve sul canale del job. Porte: `muffin jobs add --per-job-usd`, `muffin jobs cap <id> <dollari\|none>`, e `jobs list` mostra tetto **e** speso. Lo scenario `E1` copre ora entrambe le metà della domanda della riga (`evals/acceptance/scenarios/e-cost.accept.ts`, gateway vero + `jobs add` vero): mutation-testato — tolto il controllo in `runFresh`, il rosso è *«il modello è stato chiamato 1 volte per un job già oltre il proprio tetto»* e la risposta del modello arriva davvero all'owner. Il tetto può solo stringere: il tetto mensile resta sigillato (ADR-0039) e limita tutto sopra di lui. |
| E2 | Cost | So quanto costa una giornata? | READY — `/spend` (`cli/repl.ts`) stampa ora anche `oggi: $X`, letto da `tenantTodayUsd('host')` (`core/budget/budget.ts`, esisteva già senza chiamante); lo scenario `E2` aggiornato (`evals/acceptance/scenarios/e-cost.accept.ts`) prova entrambe le righe — mensile e di oggi — non-zero dopo un turno reale che ha speso, verde: `npx vitest run --config vitest.acceptance.config.ts evals/acceptance/scenarios/e-cost.accept.ts` (3/3) |
| E3 | Tracing | Posso ricostruire cosa è successo? | READY — scenario `E3` esteso (`e-cost.accept.ts`, #285): oltre alla redazione dei segreti (ADR-0048), `muffin trace turn <id>` / `trace grep` ricostruiscono un turno qualunque dai file di trace veri, e la ricostruzione del turno B non mostra le tool call del turno A (isolamento asserito in entrambe le direzioni) |
| E4 | Tests | Acceptance test **reali**, non solo unit? | READY (`evals/acceptance/`) — è il meccanismo: harness contro il binario vero, provider finto deterministico, ogni verde visto rosso prima. La PR #54 aggiunge nel manifest la specie provata dal meccanismo stesso, chiudendo l'unico "READY senza scenario" rimasto dopo il triage 17/08 |
| E5 | Failure | Ogni fallimento importante è esplicito e recuperabile? | READY — la sintesi che la riga chiedeva, dopo la chiusura delle parti: `docs/evidence/fallimenti-espliciti-2026-09-04.md` — quindici classi di guasto, per ognuna cosa vede l'owner, come si recupera e quale scenario lo prova sul binario vero (A1, B5, B7, B8, B10-errori, E1, D10/D12, D6, E5, A5, A6, D4/E7, #383, D3/D11, #424). Tre classi restano con recupero dichiarato manuale o assente (timeout del turno, 5xx a metà stream, disco pieno in memoria — che da #425 non spegne più la superficie): esplicite, non ancora recuperabili, scritte. |
| E6 | Act caps | Un singolo turno può fare 200 ricerche web o 200 deleghe? | OUT — la domanda come è posta è chiusa (ma il residuo è OUT, e lo stato segue il residuo, 05/09): `maxToolCallsPerTurn` vale per singola call anche dentro un batch, e le call oltre il tetto ricevono un `tool_result` di rifiuto esplicito invece di eseguire (RETURN S3). Il residuo che la teneva BLOCKER — «200 ricerche in 15 turni restano possibili» — è una domanda **diversa**, e la risposta è il tetto nell'unica unità che conta: `monthlyUsd`, `perTenantDailyUsd` e, da `slice/e1-budget-per-job`, il cap per job. Un contatore per-capability duplicherebbe il tetto in denaro in un'unità peggiore → OUT con ragione, issue #370 da chiudere con questo testo. |
| E7 | Self-inspection | Sa spiegare **tecnicamente** come funziona e cosa sta usando **adesso**, distinguendo architettura/progetto da stato live dell'istanza? | READY — scenario `E7` verde (`e-cost.accept.ts`, #284): `sys_inspect` risponde con il modello main letto dalla config reale, lo stato live del RoT e le capability esposte; dopo un vero `muffin model main <altro>` la seconda risposta riflette il cambio e non ripete la prima — cablare a mano la riga del modello in `inspect.ts` fa cadere lo scenario (mutazione verificata). Dal 03/09/2026 nomina anche le capability spente o tagliate: `web_search` disattivo, `shell_run` senza sandbox, un tool oltre il tetto del profilo — motivo e rimedio, dalla stessa fonte che legge `muffin doctor` (`agent/tools/capability-status.ts`), mai due frasi che possono divergere. |

### F · Gruppi

> Aggiunta il 04/09/2026 su direzione owner: *«aggiungi i gruppi al day1»*. La
> ricerca che la ordina è `docs/evidence/muffin-nei-gruppi-2026-09-04.md`; le
> decisioni sono ADR-0061 (l'owner in un gruppo è un membro), ADR-0063 (il gate
> è nostro), ADR-0065 (l'host-gruppo non è un tier), ADR-0071 (provenienza).

| # | Area | Domanda DAY-1 | Stato |
|---|---|---|---|
| F1 | Gate | In un gruppo con privacy mode spenta, un turno parte **solo** quando Muffin è chiamato in causa? | READY — `apreUnTurno` (`connectors/telegram/connector.ts`, ADR-0063, #413): menzione `@<username>` con confine di parola, risposta a un messaggio di Muffin, comando, allegato; chiuso per costruzione prima che `getMe` risponda. `gate-di-gruppo.test.ts` (10 casi, incluso `@MuffinAgentTestBot2` che non sveglia `@MuffinAgentTestBot`), cablaggio dal filo in `group-context.test.ts`. Misurato dal vivo il 04/09: 6 update → 2 turni, 4 archiviati senza aprire niente. |
| F2 | Tenant | Un gruppo è un inquilino separato, e l'owner che ci scrive dentro non porta la sua autorità? | READY — `identify()` (`core/surface/types.ts`): tenant `group:telegram:<chatId>`, l'owner in un gruppo è `member` a taint 2 (ADR-0061, combinazione C scartata con ragione). Scenario di accettazione «i gruppi restano separati» attraverso il percorso di produzione (#417), `impersonation.test.ts` su Telegram e Discord. Misurato sul `muffin.db` dell'owner: 14 episodi `group:*` contro 478 `host`, nessuno incrociato. |
| F3 | Topic | In un forum, due topic sono due conversazioni? | READY — #415: `message_thread_id` entra in `sessionKey` (`telegram:<chatId>#<thread>`) e **non** nel tenant — un topic non ha membri né permessi propri. Solo con `is_topic_message`, perché in un supergruppo normale lo stesso campo marca le catene di risposta. La risposta esce nel topic su **ogni** pezzo (`message_thread_id` esplicito, `reply_parameters` porta nel topic solo il primo), «sta scrivendo» compreso; colonna `thread_id` persistita con ALTER idempotente. `topic-di-forum.test.ts`, 10 casi dal filo; lungo la strada l'indirizzo di risposta è diventato `indirizzoDi()`, scritto una volta invece di due. |
| F4 | Uscita | Se qualcuno lo aggiunge dove il suo umano non c'è, se ne va e lo dice? | READY — #422, `invito.ts` + `dove-e-il-mio-umano.test.ts` (13 casi, 7 dal filo). `my_chat_member` **richiesto** in `allowed_updates` (prima non arrivava affatto: il test che conta è quello sul payload di `getUpdates`). `getChatMember` sull'owner; `undefined` («non ho potuto chiedere») vale uscire. Saluto nel gruppo → avviso in privato con chi e dove → `leaveChat`, ognuno nel suo `try`. Nel gruppo non dice niente dell'owner. Nessun turno aperto. |
| F5 | Egress | Un membro può far uscire byte che si è inventato? | READY — no, da ADR-0071 (#419): il gate sui parametri risponde alla **provenienza**, non al numero. Prima era `taint <= paramsMaxTaint` vero per costruzione (2 ≤ 2) e la prima query composta usciva senza che nessuno la vedesse (§6.1 della ricerca). Ora composto + non-owner → `deny`, non `ask`; un link scritto da qualcuno nella stanza resta apribile. `agent/link-copiato-non-e-composto.test.ts`, describe sul membro. `sys.search` resta `hostOnly`. |
| F6 | Ricordo | Un messaggio che non apre un turno viene comunque ricordato dal gruppo? | READY — #425: nel ramo chiuso di `drain()` (`ricordaSenzaRispondere`, `connectors/telegram/connector.ts`) il messaggio diventa un episodio del tenant del gruppo — `role: user`, taint di chi scrive più quello del contenuto, `threadKey` = sessione, senza `turnId` perché nessun turno esiste — **dopo** aver chiesto al kernel la porta `memory.write` come fa il loop. Costo zero per costruzione, citato e provato: `CONSOLIDATION_TENANT` è `host` e `Consolidator.notify('group:…')` non arma mai. `ricordare-senza-rispondere.test.ts`, 6 casi dal filo: zero chiamate al provider, un episodio, e il turno successivo nello stesso gruppo lo ritrova nel prompt; kernel a `deny` → niente scritto; uno store che lancia non ferma `drain()` (aggiunto in revisione: la chiamata era fuori da ogni `try` e un errore SQLite avrebbe spento la superficie). Mutazione: via `addEpisode` → 2 rossi. **Scenario `F6` verde sul binario vero (05/09):** il messaggio entra dal gateway contro il Bot API finto, l'episodio compare in `episodes` con tenant del gruppo, `turn_id` nullo e sessione del gruppo, zero chiamate al provider, zero messaggi, zero turni; mutazione — porta `memory.write` sostituita con una capacità inesistente → rosso (`condizione mai raggiunta`), ripristino verde. |
| F7 | Capability per stanza | In un gruppo specifico Muffin può cercare sul web, leggere e creare file in uno spazio di quella stanza, tenere una todo, aspettare — e mai la shell? | READY (punti 1, 2, 3, 5 di ADR-0073; il punto 4 resta aperto) — **la manopola è per stanza e vive nel sigillo**: `rot/policy.json` accetta `tenants: { "group:…": { grants: [...] } }` (`core/policy/matrix.ts`), e il kernel legge `hostOnly && principal.kind === 'member' && !grantedTo(tenant, capability)` (`core/policy/decide.ts`) — tutto il resto (soffitti, ADR-0071/0072/0074/0075) invariato e attraversato identico. Il grant **aggiunge per nome**: mai `group:*`, mai una famiglia `prefix.*`, e mai la lista chiusa `sys.shell` / `sys.shell.*` / `sys.process.*` / `fs.*` / `rot.*` / `outward.*` / `config.*` — un file che li nomina è rifiutato **intero** citando il campo (`tenants.group:telegram:42.grants.0`), come per `askAbove`; il pavimento non concede niente a nessuno. **Lo spazio della stanza è il suo vault, non il disco**: `vault.write` + `vault_save` (`agent/tools/vault-save.ts`) scrivono in `salvati/<stanza>/…` con il tenant preso da `ToolContext` e mai dagli argomenti, riga di effetto nuova `vault` (`asksForIrreversible: false`, `denyAbove: 3`), `reversible: 'undoable'` con giornale e `muffin undo` per la stessa strada di `fs_write` (`resolveEffectPath` + `ctx.effectPath`). `turn.todo` e `turn.wait` restano `hostOnly` e arrivano nominati dal grant (punto 5); nessun `sys.search:composed` per stanza (punto 3). `visibleTools` legge gli stessi grant del kernel, o il menu e il kernel tornerebbero a mentirsi. **Provato**: `matrix.test.ts` (lista chiusa voce per voce, rifiuto col nome del campo), `solo-irreversibile.test.ts` (enumerazione estesa a un membro **con** e **senza** grant; mutazione «il kernel ignora il grant» → `expected 'vault.write@0/stanza-con-grant: deny' to be '…: draft'`; mutazione «riga `vault` al livello delle righe di rete» → 3 rossi), `vault-save.test.ts` (un `tenant` negli argomenti non sposta i byte; due stanze non si sovrascrivono), `capability-gaps.test.ts` (cosa raggiunge un membro con e senza grant, dal `buildRuntime` vero e da un `policy.json` **sigillato**). **Scenario `F7` verde sul binario vero (07/09)**: stessa stanza, due vite del gateway con `seal()` in mezzo — senza grant `principal_forbidden` e nessun file; col grant il membro salva **senza nessun ask** (zero righe in `approvals`), i byte sono nel tenant `group:telegram:<id>` e in nessun altro, `document_read` della stanza li ritrova e quello di `host` no, e `shell_run` resta `deny`; mutazione «il kernel ignora il grant» → rosso (`col grant, il membro non ha salvato niente: manca …/salvati/group-telegram-100970/orari-della-portineria.md`). **Resta aperto il punto 4**: un `ask` nato in una stanza è ancora `deny` per un membro — la domanda effimera all'owner dentro il gruppo (Bot API 10.2/10.3) è un'altra fetta. |
| F8 | Proattività | Interviene da solo — dopo T secondi di silenzio, ogni X messaggi nei momenti pieni, quando un messaggio somiglia a qualcosa che sa? | OUT — deliberatamente dopo DAY-1, parole dell'owner del 04/09: *«andiamo con la versione completa dopo ok? quindi deterministico + proattivo»*. La base deterministica è F1; la parte proattiva (debounce, soglia, rilevanza via embedding, modello leggero sui sopravvissuti, interruttore per stanza, tetto 20 msg/min per gruppo) è la fase successiva e non allarga DAY-1. Collocata in `docs/ROADMAP.md`. |
| F9 | Ritmo | Muffin può inondare un gruppo? | OUT — con ragione: F1 lega ogni uscita a un messaggio che l'ha chiamato, quindi il ritmo lo dà chi scrive, e `api.ts` fa un retry onorando `retry_after` sul 429. Un limitatore proprio serve quando Muffin parla senza essere chiamato, cioè con F8, e va costruito con lei. |


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
> della claim e lasciare la riga BLOCKER (A2/A3, B1, E3/E5). `C8` e le
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
