# Gate 1 — l'inventario che ha un fondo

> Direttiva owner, 2026-08-15. Due frasi che governano tutto il resto:
>
> **«Non chiamerei ancora questo MVP.»** Abbiamo un **runtime funzionante**, non
> un agente personale che possa sostituire quello che l'owner usa oggi. La
> differenza non è retorica: un runtime lo provi, un agente personale ci vivi.
>
> **La domanda è binaria**: *«esiste qualcosa che mi impedirebbe concretamente
> di vivere 14 giorni usando esclusivamente Muffin?»* Finché la risposta è sì,
> quella cosa entra qui.

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
- **INVALIDATED** — la premessa della riga non regge più: la domanda Gate 1
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

> **Triage evidence-only 17/08.** Tre worker in sola lettura hanno riletto ogni
> riga A1–E6, i 19 MEDIUM residui dell'audit e le otto proprietà trasversali
> del mandato contro `origin/dev` — `research/triage-2026-08-17/{a-b,c-d,
> e-audit-trasversali}.md`. L'ordine in cui le righe BLOCKER si chiudono è
> `gate1/PERCORSO-CRITICO.md`, non questo file: qui c'è la risposta, lì la
> sequenza e il perché.
>
> **Conteggio: 13 READY · 35 BLOCKER · 7 OUT · 0 INVALIDATED** (55 righe, E7
> aggiunta dall'owner il 17/08). Aggiornato dopo l'integrazione di #53 (lease e
> fencing), #54 (verità dell'accettazione), #56 (A1 continuità), #57 (WAL
> dell'intento), #58 (identità parte 1) e #59 (`init --local`). `?` non esiste
> più come stato: ogni riga ha una delle quattro risposte con evidenza — e
> l'evidenza si riconcilia al merge, non dopo (`BRANCHING.md` checkpoint 4).

Stato: `READY` · `OUT` (fuori dal Gate 1, con ragione) · `BLOCKER` (con cosa
manca e la slice del percorso critico che la chiude) · `INVALIDATED`
(premessa non più valida, con ragione). `?` è ritirato dal 17/08 — le due
eccezioni sopra sono temporanee, non una riabilitazione dello stato.

### A · Installazione e ciclo di vita → `gate1/a-installazione.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| A1 | Boot | Muffin parte da solo e recupera lo stato? | READY — accettazione: gateway vero SIGKILLato a metà vita, un secondo processo lo sostituisce e riprende un turno sospeso (`wait`) più un job dovuto, ciascuno consegnato **una sola volta** (righe `turns`/`turns.delivery`/`jobs.last_run_at` provate, non assunte — mutation-testato: `markRan` disattivato a mano rifà partire il job all'infinito e lo scenario va rosso, `evals/acceptance/scenarios/a-lifecycle.accept.ts`), `muffin gateway status`/`doctor` sani prima e dopo, `SIGTERM` drena ed esce `EXIT_STOPPED`. Due gap chiusi con test: `TelegramConnector.run()` riprova `getMe()` con backoff invece di morire una volta sola quando la rete non è pronta al boot (`connectors/telegram/reconnect.test.ts`, rosso confermato pre-fix); `doctor` verifica il **supervisore** (unit/plist al suo posto + enable/linger su Linux o launchd su macOS), non solo il processo (`core/gateway/supervisor.ts`, mai `fail`, sempre un rimedio) — un `muffin gateway run` a mano ora si legge distinto da uno supervisionato. Reboot reale della macchina target = battery §10 di `gate1/MANDATO-DAY-1.md`, non provato qui. ADR-0035 §Continuità appartiene a Muffin, non al pid. |
| A2 | Identity | Sa chi è e quali limiti ha? | BLOCKER 👤 il contenuto non è più il gap: `identity.md` è testo reale dell'owner da c090dce, sigillata nel RoT, e raggiunge il system prompt reale — provato (`slice/identita` parte 1: `research/prompt-assembly-2026-08-17.md`, `muffin prompt show`, wiring test mutati rosso-prima, scenario di accettazione A2 verde contro il binario vero, `evals/acceptance/scenarios/a-lifecycle.accept.ts`). Resta BLOCKER: manca il character eval sui modelli Gate 1 (punto 6 mandato owner — non più «solo owner»: il contenuto è dato, la verifica no) → parte 2 di `slice/identita` |
| A3 | Persona | Il comportamento è definito? | BLOCKER 👤 `persona.md`/`voice.md` sono testo reale dell'owner da c090dce e raggiungono il system prompt reale nell'ordine canonico (persona → identity → voice) — provato: scenario A3 verde, `muffin prompt show` byte-identico a quanto ricevuto davvero dal provider (`evals/acceptance/scenarios/a-lifecycle.accept.ts`). Resta BLOCKER: mancano character eval, cross-model e confronto col vecchio `Muffin.ai` (punti 6-8 mandato owner) → parte 2 di `slice/identita` |
| A4 | Config | Si configura senza toccare il codice? | BLOCKER — solo scenario mancante: `muffin config` è read-only per disegno (ADR-0036, `cli/config.ts:7,22-37`), validazione zod rumorosa al caricamento (`core/config/config.ts:35-63`), ma nessuno scenario prova l'hand-edit di `config.json` + `muffin rot reseal` end-to-end → PC §4 |
| A5 | Doctor | Individua **davvero** i problemi? | READY — manomissione reale di `rot/policy.json`, `doctor` la rileva e nomina il file con un rimedio azionabile (`evals/acceptance/scenarios/a-lifecycle.accept.ts:56-94`, verde); ogni check esegue, non assume (`cli/doctor.ts:45-568`) |
| A6 | Upgrade | Aggiornare il codice non distrugge dati? | BLOCKER — nessun verbo `update`/`upgrade` in `cli/main.ts`; `ensureColumn` esiste solo per 3 colonne di `core/memory/store.ts` (audit P27), `turns`/`jobs` non hanno l'equivalente; nessuno scenario da schema popolato preesistente → PC 2.1 `slice/schema-evolution` |
| A7 | Migration | Lo schema evolve senza perdere memoria? | BLOCKER ⚠️ `episodes.kind` ha un CHECK a 5 valori che SQLite non altera (`core/turns/store.ts:34-35` lo cita come trappola); stessa causa radice di A6 (nessun migration runner condiviso); nessun test da schema popolato → PC 2.1 `slice/schema-evolution` |
| A8 | Backup | La memoria si salva e si ripristina? | BLOCKER — lo scenario (`evals/acceptance/scenarios/a-lifecycle.accept.ts:96-129`, verde) prova solo la copia a freddo (processo fermo); il gateway è un processo residente quindi il backup reale è a caldo, sotto scrittura WAL (`cli/init.ts:109-111`); nessun verbo `muffin backup`/`restore` → PC 2.2 `slice/update-backup` |
| A9 | Setup locale | `muffin init --local` riusa i segreti persistiti per un'installazione pulita di prova? | READY — `muffin init --local [<dir>]` (default `~/.muffin-local`) risolve `home` su quella directory e lascia il passo «api key» leggerlo dalla stessa catena `locateSecret` contro quella home — mai una copia (`cli/main.ts:276-303`); guardia realpath rifiuta un `<dir>` che coincide con la home reale o le sta annidato sotto, anche attraverso un symlink, prima di scrivere qualunque cosa (`cli/init.ts:47-93`, unit test con symlink `cli/init.test.ts`); scenario di accettazione sul binario vero — segreto scritto sul backend persistent isolato dall'harness (mai quello reale), `init --local` lo trova senza copiarlo, `muffin doctor` sano sulla home locale, la home originale invariata (hash prima/dopo), `--local` sulla home reale rifiutato con exit 78 (`evals/acceptance/scenarios/a-lifecycle.accept.ts:293-364`, verde, manifest `evals/acceptance/manifest.ts`) |

### B · Continuità del runtime → `gate1/b-continuita.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| B1 | Conversation | CLI e Telegram condividono **davvero** sessione e memoria? | BLOCKER — lo scenario (`b-continuity.accept.ts:19-71`, verde) prova **solo la metà CLI** (il file lo dichiara: "no real Telegram bot is reachable"); le sessioni non sono la stessa per costruzione (`--session` vs `telegram:${chatId}`, `connectors/telegram/connector.ts:365`), solo la memoria tenant-scoped le collega, mai provata dal lato Telegram → PC 1.5 |
| B2 | Long-running | Un turno può durare minuti senza rompere il connector? | BLOCKER — meccanismo costruito e provato end-to-end, resta **una chiamata** nel connettore 🪡 (`connectors/telegram/connector.ts:359`, `runTurn` invece di `enqueueTurn`); rimandato di proposito per non entrare in conflitto con `slice/superfici`, chiuso solo al test di prod → PC 3.9 |
| B3 | Wait | Può aspettare **senza bloccare il runtime**? | READY — `wait` sospende la riga e RILASCIA il runtime; la corsia del gateway la risveglia, e `doctor` avverte se non ne gira nessuna |
| B4 | Todo | Mantiene lavoro multi-step persistente? | READY — tabella `todos` con `tier`, letta nel contesto di **ogni** turno della sessione |
| B5 | Resume | Se muore a metà, riprende? | READY — accettazione: processo vero ucciso con SIGKILL a metà turno, riprende al riavvio |
| B6 | Retry | Se fallisce una tool call, recupera? | BLOCKER — retry esiste solo a livello trasporto/modello (`agent/loop.ts:1089-1103`, `MAX_TRANSPORT_RETRIES=2`); nessun tool (`http.ts`, `search.ts`, `fs.ts`) implementa retry proprio; nessuno scenario → PC 3.4 `slice/provider-retry` |
| B7 | Scheduler | I job sopravvivono al riavvio? | BLOCKER — **non più per il lock**: liveness prima dell'orologio, `holder_id`/`claim_token` e `stillOwner` prima di ogni effetto sono chiusi da PR [#53](https://github.com/GiustoPiedimonte/muffin-agent/pull/53) (audit P19/P20/P21). Resta l'**identità dell'occorrenza**: un crash fra l'esecuzione del job e `markRan` rifà il fire per intero (`core/scheduler/scheduler.ts` `settle`), e nessuna chiave lega `(job_id, scheduled_for)` a un turno. Decisione owner 17/08: `job_fires` come ponte di identità `(job_id, scheduled_for) → turn_id` — crash prima del fire lo crea, dopo il fire completa il binding senza perderlo, dopo la creazione riprende lo stesso `turn_id`, turno `done` prima di `markRan` non richiama il modello, delivery incerta non rifà la computazione, la schedule avanza solo dopo il settlement → PC 1.5 `slice/job-fires` (CRITICAL) |
| B8 | Delivery | Un job che dice «inviato» è **arrivato**? | READY — canale non connesso → `failed:<why>`, mai `sent`, e `doctor` lo nomina ⚠️ nota sotto |
| B9 | Proactivity | Agisce spontaneamente secondo i gate? | OUT — post-Gate 1: nessuna capability §5 dei 14 giorni dipende da trigger proattivi; `ProactiveKind` ha oggi 4 valori (non 5, `consolidation` rimosso da ADR-0038), solo `gone_quiet` ha un produttore reale (`core/scheduler/observe.ts:109,128`) ed è cablato ma solo su invocazione manuale (`muffin observe --send`); i tre mancanti (`commitment_due`, `deadline_near`, `fact_actionable`) restano fuori finché non emerge un consumer reale → PC §5 |
| B10 | Telegram | Messaggi, file, immagini, **errori** | BLOCKER — messaggi e documenti ok (provato, vedi C7); immagini bloccate: scaricate ma mai indicizzate (`core/vault/vault.ts:334-337` le salta) e nessun content-block immagine verso il provider (`agent/providers/types.ts` senza `ImageBlock`); errori gestiti a pezzi, non come proprietà unica; nessuno scenario dedicato → PC 3.6 `slice/telegram-media` |
| B11 | Streaming | La risposta arriva mentre si forma, o solo alla fine? | READY per CLI/REPL e Telegram (`slice/streaming`, due PR verso `dev`) — Discord resta OUT (B17). Entrambi gli adapter honorano `ChatCall.stream` (`Provider.chatStream`, SDK ufficiali, non SSE fatto a mano); il loop bufferizza i delta per giro e li rilascia solo per quello che risponde davvero (mai durante una tool call — un giro nudged dal completion gate non trapela il suo bozzone). REPL: stampa progressiva byte-identica a fine turno, `--no-stream`. Telegram: bozza dal vivo (`sendMessageDraft`, con `draft_id` — mancava, trovato e corretto in questa slice, vedi ADR-0025 §revisione e `docs/lessons.md`) in chat privata, `editMessageText` sul placeholder in gruppo; spento per sessione al primo edit fallito (Hermes); mai più di un messaggio Telegram per turno (overflow → consegna normale a fine turno). **Nota onesta**: un giro si rilascia in un colpo solo a `done` (mai un punto prima è conoscibile — "streamma e ritira" scartato di proposito), quindi un turno senza tool call produce tipicamente UN aggiornamento dal vivo, non un typewriter — la percezione di attività durante l'attesa viene dal placeholder/typing che precede. Fallback singolo e contato se lo stream del provider si rompe a metà (`ProviderStreamError`). Cablaggio verificato end-to-end con provider SSE finto attraverso `buildRuntime` reale (`cli/repl.test.ts`, `connectors/telegram/streaming.test.ts`), non un `Provider`/`TelegramApi` sostituito a mano. Scenario di accettazione contro il binario vero verde (`evals/acceptance/scenarios/b-streaming.accept.ts`, spawna `muffin repl --stream` come processo reale contro il provider SSE finto e legge la richiesta `stream:true` che il fake ha ricevuto — non un'assunzione dalla risposta arrivata giusta) |
| B12 | Overflow | Un output enorme di un tool va in contesto, o diventa un file richiamabile? | OUT — UX/polish, non blocca i 14 giorni: `agent/context/compact.ts:89-101` sostituisce l'intero payload con un placeholder invece di troncare testa+coda (un difetto noto, non solo una mancanza); nessun overflow-a-file esiste; B11 (streaming) copre già il segnale di presenza durante l'attesa → PC §5 |
| B13 | Progress | Un turno lungo dice di essere vivo in modo **strutturale**, non cosmetico? | OUT — UX/polish: il dato strutturale esiste già (`turns.updated_at`, `core/turns/store.ts:333,779-790`) ma nessun consumer lo legge come segnale di vita; B11 copre la presenza percepita → PC §5 |
| B14 | Attachment | Un file prodotto arriva come **allegato**, o come percorso da copiare a mano? | BLOCKER — solo scenario mancante: `send_file` (`agent/tools/deliver.ts:58`) raggiunge `Surface.deliverFile` (`core/surface/registry.ts:58-61`) su Telegram e Discord, `hostOnly` dichiarato (⚠️ un member non può ricevere un proprio file, vedi sotto); manca lo scenario di accettazione → PC §4 |
| B15 | Owner binding | Ogni surface riconosce l'owner solo da un subject-id stabile autenticato e protetto? | BLOCKER — `identify()` unica e cablata su Telegram e Discord (provato da impersonation test su entrambe); DM-only enforced su `channel_type` (D1, judge PR #42, 2026-08-16: un GROUP_DM senza `guild_id` non deriva più `direct: true`); resta aperta la metà "protetto": binding ancora in config, non nel RoT — `ownerUserId` vive in `config.json` ordinario (`core/config/config.ts:80`), non nel Root of Trust → PC 3.5 `slice/pairing-sigilla` |
| B16 | Ingress parsing | **Ogni** campo letto entra tipizzato con provenienza/taint, inclusi nomi, bio, metadata, immagini e derivati? | BLOCKER nel minimo di PC 1.4: un messaggio **inoltrato** entra oggi a tier 0, byte-identico alle parole dell'owner (audit P14, `connectors/telegram/connector.ts` `parseUpdate`); manca `forward_origin` → tier 2 recintato e caption/filename come campi tipizzati con provenienza → PC 1.4 `slice/ingress-forward`. L'envelope universale oltre il minimo (nomi, bio, entità, poll, contatti) resta OUT/post-Gate 1: nessuna capability dei 14 giorni lo richiede oltre l'ingresso minimo |
| B17 | Ripresa su Discord | Un turno sospeso (`wait`) su Discord riceve la risposta quando riprende? | OUT — Discord non è nella finestra dei 14 giorni; prima di attivarlo servono `DiscordConnector.deliverTo` e la porta nel `SurfaceRegistry` (oggi la ripresa registra `failed:`; trovato dal judge integrato di #44). Il connettore non manda più una risposta fantasma su un turno sospeso |

> 🧱 **«Substrato pronto» non è «chiuso», e le righe restano BLOCKER apposta.**
> `slice/turno-record` (2026-08-15, **ADR-0042**, disegno in
> `research/turno-sospendibile.md`) ha costruito quello che B2, B3 e B5 vogliono
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
> READY; **B2 resta BLOCKER** e per una ragione sola, scritta sotto. Le decisioni
> che scriverli ha costretto a prendere sono in **ADR-0047**, con l'emendamento
> in coda ad ADR-0042.
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
> 🪡 **Cosa manca a B2, esattamente.** Il meccanismo è intero e provato
> end-to-end (`agent/lane-wiring.test.ts`): `enqueueTurn` scrive la riga
> **senza nessuna chiamata al modello**, la corsia la esegue e la risposta arriva
> all'indirizzo scritto sulla riga. Quello che resta è **una chiamata** in
> `connectors/telegram/connector.ts` `handle()`: `await runTurn(...)` diventa
> `enqueueTurn(...)`. Non è stata cambiata qui di proposito — `slice/superfici`
> sta riscrivendo `Deliver` e la resa in-band, e due slice che modificano lo
> stesso invio sono una guerra di merge invece di una cucitura. La porta della
> corsia esiste già e non va toccata: `TelegramConnector.deliverTo`, additiva,
> che valida da sé la forma del proprio `replyTo`.

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
> Trust — nessuna surface lo cambia ancora. B16 è invariato: nessun envelope
> universale per bio, filename, metadata, OCR o trascrizioni — questa slice
> non l'ha costruito.
>
> **Aggiornamento 17/08 (`gate1/PERCORSO-CRITICO.md` §1.4).** B16 si
> scompone in due parti con destini diversi: il minimo (`forward_origin` →
> tier 2 recintato, caption/filename tipizzati) resta BLOCKER e ha una slice
> dedicata (`slice/ingress-forward`); l'envelope universale oltre quel minimo
> è OUT/post-Gate 1 — nessuna capability dei 14 giorni personali lo richiede.

> 🔭 **Le righe col cannocchiale le ha trovate uno sguardo fuori** —
> `research/hermes-documentazione.md` (2026-08-15), la documentazione intera di
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
> (`docs/blueprint/gate1/PERCORSO-CRITICO.md` §1.5, in arrivo su `dev`).

### C · Memoria e acquisizione → `gate1/c-memoria.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| C1 | Memory write | Ogni informazione importante viene acquisita? | READY — scenario `C1` verde (`c-memory.accept.ts:27-58`): turno 1 scrive un fatto, turno 2 su sessione diversa lo recupera via memoria (non transcript di sessione, quello è B1); acquisizione "evidence first" (`agent/loop.ts:872`, `core/memory/store.ts:201`) |
| C2 | Extraction | L'estrazione è automatica? | BLOCKER — solo scenario mancante: consolidamento cablato a fine turno (`agent/runtime.ts:619`, `core/memory/ingest.ts:182`), debounce 20s misurato sul corpus reale; nessuno scenario di accettazione → PC §4 (J1) |
| C3 | Consolidation | Si consolida senza intervento? | BLOCKER — solo scenario mancante: drain a pagina piena, dedup a chiave esatta, `muffin memory review` (`core/memory/consolidator.ts`), misurato per STATE.md ma non provato in `evals/acceptance/`; nessuno scenario → PC §4 (J1) |
| C4 | Recall | Ripesca il vecchio **e** il superseded? | READY — scenario `C4` **verde** sul binario vero dopo la PR #54 (`evals/acceptance/scenarios/c-memory.accept.ts`, entità capitalizzata: `--history` ritrova il fatto superseduto, la ricerca ordinaria quello attivo); meccanismo in PR [#35](https://github.com/GiustoPiedimonte/muffin-agent/pull/35) (`factsAsOf`/`nearestFactTo`, `asOf` unico) ⚠️ limite noto: il one-hop del grafo parte solo da un nome capitalizzato (nota sotto); il percorso turno→estrazione→supersede è provato da J1 con C2/C3, non qui |
| C5 | Provenance | Posso capire **perché** crede una cosa? | BLOCKER — `muffin memory why` esiste per l'owner (`cli/memory.ts:29`, `core/memory/store.ts:918 provenanceOf`), ma non è esposto come tool-agente (`agent/tools/memory.ts` ha solo `memorySearchSpec`); nessuno scenario → PC §4 (J2) |
| C6 | Temporal graph | «Chi era X a maggio» | BLOCKER — solo scenario mancante: `factsAsOf`/`nearestFactTo` (`core/memory/store.ts:545,581`) e `asOf` come parametro unico (`core/memory/recall.ts:167-236`) cablati sia in CLI sia nel tool; nessuno scenario di accettazione → PC §4 (J1) |
| C7 | PDF | Acquisisce documenti utili? | BLOCKER — solo scenario mancante: PDF/DOCX/testo interi (`core/documents/extract.ts`), percorso allegato→vault→reindex→episodio provato da `connectors/telegram/document-arrival.test.ts` (non-acceptance, 326 righe); fallimento esplicito su scansioni senza testo; manca lo scenario in `evals/acceptance/` → PC §4 (J2) |
| C8 | Audio | Gestisce le note vocali? | BLOCKER — nessuna trascrizione: `media.ts` salva il vocale come binario opaco, `vault.ts` lo salta senza estrattore, zero righe di whisper/faster-whisper nel repo; se le note vocali servono nei 14 giorni — decisione owner pendente (PC 3.8, ultima) |
| C9 | Pressure | L'agente sa **quanto spazio gli resta**, dentro il prompt? | OUT — post-Gate 1: la forma del segnale ("spazio residuo") è ancora da decidere e cambierebbe il prefisso cacheabile owner (`agent/context/assemble.ts`, pinnato a sha256); nessuna capability dei 14 giorni ne dipende → PC §5 |
| C10 | World state | Distingue ciò che vale adesso da episodi, credenze e lavoro? | OUT — post-Gate 1, consumer prima dello schema (ADR-0045) |

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
> **rosso** prima del fix (PRACTICES §5). Dettaglio in `docs/lessons.md`
> («Una garanzia che regge su due percorsi e non sul terzo non è una
> garanzia»).
>
> ⚠️ **Trovato lavorandoci, non nel mandato originale.** Il mezzo semantico di
> `recall()` non aveva mai letto `expired_at`: un fatto o un episodio ritirato,
> una volta indicizzato per vettori, resta trovabile per significato per
> sempre (niente si ri-indicizza al supersede), e tornava **senza** la marca
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
> turno→estrazione→giudice→supersede resta da provare per **C2/C3** (`gate1/
> PERCORSO-CRITICO.md` §4, journey J1); C6 (`asOf`) resta BLOCKER solo per
> scenario mancante nella stessa journey.

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
> (`gate1/PERCORSO-CRITICO.md` §4, journey J2, con C5).

### D · Capability e sicurezza → `gate1/d-capability.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| D1 | File read | Legge file reali? | READY — scenario `D1` verde (`d-capability.accept.ts:15-66`): symlink che punta fuori dal workspace, `fs_read` lo rifiuta (`is_error=1`); `realpathDeepest` risolve il path reale anche per hard link in lettura (PR #52, `agent/tools/fs.ts:238`); CI Linux verde sullo stesso HEAD (run 32016357127) |
| D2 | File write | Modifica file reali **in sicurezza**? | BLOCKER — rifiuta ogni draft: ogni capability col verdetto kernel `draft` (es. `fs.write`) è rifiutata a priori con messaggio fisso, mai eseguita (`agent/loop.ts:1790-1802`); `fs_write` non scrive mai un file reale oggi → PC 2.3 `slice/undo-journal` |
| D3 | Undo | Posso recuperare una modifica? | BLOCKER — registro assente: `muffin undo` non esiste come comando (scenario `D3` atteso-rosso confermato, `d-capability.accept.ts:105-126`); la forma è decisa (§1, quattro classi + journal per turno) ma zero righe di implementazione → PC 2.3 `slice/undo-journal` |
| D4 | Shell | Esegue comandi nel sandbox? | BLOCKER — solo scenario mancante: "? su Linux" è stale, chiuso il 15/08 (PR #13 `slice/sandbox-linux`); CI Linux verde su `dev@3068ece` (run 32016357127, job `verifica`, 2026-08-17T09:39:47Z); la prova vive in CI, va portata nell'harness di accettazione o dichiarata equivalente → PC §4 (J6) |
| D5 | Process | Gestisce processi lunghi? | BLOCKER — solo scenario mancante per list/kill: `process_list`/`process_kill` tipizzati (`agent/tools/process.ts:47-97`), `sys.process.kill` è ASK in single-user; nessuno scenario → PC §4 (J6). Avviare processi propri in background resta OUT (nessuna capability dei 14 giorni lo richiede) |
| D6 | HTTP | Naviga secondo policy? | BLOCKER — solo scenario mancante: `resourceKind:'url'` raggiunge davvero il kernel (`agent/tools/http.ts:39`, `core/policy/decide.ts:155-193`), allowlist per label esatta, redirect ricontrollato a ogni hop, SSRF floor verificato; nessuno scenario di accettazione → PC 1.6 `slice/egress-params` (J5) |
| D7 | Web search | Funziona end-to-end? | BLOCKER — `sys.search` dichiara `resourceKind:'none'` (`agent/tools/search.ts:57`) e non raggiunge mai il ramo egress del kernel (`core/policy/decide.ts:155`, identico a audit P04-2): l'intera query esce senza ispezione di policy → PC 1.6 `slice/egress-params` (J5) |
| D8 | MCP | Gestisce drift e revoca? | OUT — revoca calda: pinning e sospensione su drift sono solidi (`core/mcp/registry.ts:125 verifyTools`, `agent/tools/mcp.ts:11-24`), ma `muffin mcp remove` lo dice già onestamente («spariscono al prossimo avvio», `cli/mcp.ts:142-152`); il riavvio è un verbo del supervisore (coerente con la lettura forte di A1) → PC §5 |
| D9 | Skills | Scopre e usa le skill? | BLOCKER — scoperta funziona (`core/skills/skills.ts`, zod, skip rumoroso), ma l'injection non è recintata: `skillsPromptSection` (`core/skills/skills.ts:126`) è uno splice diretto senza escaping nel system prompt owner cache-pinned (audit P33) — `core/mcp/*.ts` recinta già le descrizioni terze con nonce, stesso pattern da riusare → PC 2.4 `slice/audit-mediums` |
| D10 | Security | Nessuna capability escape? | READY — taint in ingresso chiuso (`slice/taint-in-ingresso`, ADR-0044, giro 2 PR #28: STATE.md "Taint in ingresso — chiuso"); un turno a taint 3 che tenta `http_get` fuori allowlist riceve `deny/resource_denied` dal kernel, mai `ask` — provato end-to-end (`evals/acceptance/scenarios/d-capability.accept.ts`, scenario D10) |
| D11 | Checkpoint | Esiste uno snapshot prima di ogni mutazione, e un ripristino che disfa anche il turno? | BLOCKER 🔭 — **il WAL dell'intento è chiuso** da PR [#57](https://github.com/GiustoPiedimonte/muffin-agent/pull/57): `startToolCall` che fallisce impedisce l'esecuzione dell'handler (mutazione verificata, `agent/turn-record.test.ts`), e `endToolCall` richiede `tier` (P05). Resta il registro: nessuno snapshot pre-effect esiste, `draft` è ancora ineseguibile da ogni percorso (vedi D2), `muffin undo` non esiste (D3) → PC 2.3 `slice/undo-journal` (CRITICAL) |
| D12 | Ask | L'ASK mostra **cosa** sta per fare (comando+cwd, URL, pid+nome) e perché il turno è a quel taint? | BLOCKER — direttiva owner 16/08; oggi `ApprovalRequest` porta solo capability+prompt (+path), il REPL chiede «approvi "sys.shell"?» senza il comando (`describe()` ritorna `'(no resource)'`, `core/policy/decide.ts:218-220`, audit P03); "ASK-in-coda" non è una coda durevole, `turn_outcome='ask'` persistito ma nessun consumer lo rilegge (`agent/scheduler-run.ts:54-61`) → PC 3.1 `slice/ask-dice-cosa` |

### E · Economia e osservabilità → `gate1/e-osservabilita.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| E1 | Budget | Cap globale **e** per-job? | BLOCKER — il per-job non esiste: solo `monthlyUsd` e `perTenantDailyUsd` (quest'ultimo escluso per `host`, `core/budget/budget.ts`); nessuna colonna `perJobUsd` su `jobs` → PC 3.7 `slice/budget-per-job` |
| E2 | Cost | So quanto costa una giornata? | READY — `/spend` (`cli/repl.ts`) stampa ora anche `oggi: $X`, letto da `tenantTodayUsd('host')` (`core/budget/budget.ts`, esisteva già senza chiamante); lo scenario `E2` aggiornato (`evals/acceptance/scenarios/e-cost.accept.ts`) prova entrambe le righe — mensile e di oggi — non-zero dopo un turno reale che ha speso, verde: `npx vitest run --config vitest.acceptance.config.ts evals/acceptance/scenarios/e-cost.accept.ts` (3/3) |
| E3 | Tracing | Posso ricostruire cosa è successo? | BLOCKER — cablato (`cli/trace.ts`, `muffin trace tail/grep`) ma: nessuno scenario di accettazione; `span.error` non redatto (`core/tracing/tracer.ts:94,98`, audit P34-1); risultati tool in chiaro per sempre in `turns.messages`/`turn_tool_calls.content`, mai pruned (P34-2, decisione owner pendente, PC §2.5) → PC 2.4, poi scenario "trace senza segreti" (PC §4) |
| E4 | Tests | Acceptance test **reali**, non solo unit? | READY (`evals/acceptance/`) — è il meccanismo: harness contro il binario vero, provider finto deterministico, ogni verde visto rosso prima. La PR #54 aggiunge nel manifest la specie provata dal meccanismo stesso, chiudendo l'unico "READY senza scenario" rimasto dopo il triage 17/08 |
| E5 | Failure | Ogni fallimento importante è esplicito e recuperabile? | BLOCKER — la riga resta di fatto "?" anche nel commento della suite che la tocca: lo scenario `E5` (verde) prova solo la classe del giudice di contraddizione (`e-cost.accept.ts`); fallimento di rete/provider a metà turno, tool che lancia, delivery fallita, job schedulato restano non sintetizzati → nessuna slice singola, dipende dalla chiusura di PC 1.5/3.4/3.6 |
| E6 | Act caps | Un singolo turno può fare 200 ricerche web o 200 deleghe? | BLOCKER — confermato con lettura diretta: `while (iterations < cap)` (`agent/loop.ts:959`) limita solo le iterazioni, mai il numero di tool call per iterazione (`toolCallsMade`, riga 1281, incrementato ma mai confrontato con un tetto); un modello può emettere 200 `tool_use` paralleli in una risposta e sforare `maxToolCallsPerTurn` di un ordine di grandezza → PC 2.4 `slice/audit-mediums` |
| E7 | Self-inspection | Sa spiegare **tecnicamente** come funziona e cosa sta usando **adesso**, distinguendo architettura/progetto da stato live dell'istanza? | BLOCKER — lacuna aggiunta dall'owner il 17/08 (propriocezione tecnica): oggi il modello può solo recitare ciò che il prompt dice o indovinare; nessuna primitiva read-only lo lascia interrogare runtime, provider/modelli correnti, surface/tenant, RoT/safe mode, sandbox/search/MCP disponibili, capability esposte, blocchi del prompt e provenienza, modalità reale della memoria (indice vettoriale disponibile o degradato), turni aperti/waiting/interrupted, job essenziali. Forma decisa: **`sys.inspect`** first-class e read-only che legge dalle **stesse fonti autorevoli** di `doctor` / `prompt show` / `gateway status` (una sola source of truth, nessuna implementazione divergente, niente documentazione infilata nel system prompt); acceptance: «spiegami tecnicamente come funzioni e cosa stai usando adesso» → cambia una condizione reale (search off, modello diverso, MCP assente) → ripeti: se recita lo stato vecchio è BROKEN, se distingue design e live state è verde → `gate1/PERCORSO-CRITICO.md` 3.10 |

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
> è ancora `atteso-rosso` (mandato DAY-1 §4.9 — le due affermazioni non possono
> essere vere insieme). Un `atteso-rosso` a sua volta è verificato contro la
> firma di fallimento che il manifest dichiara
> (`ScenarioEntry['expectFailure']`), non contro "ha lanciato qualcosa": uno
> che fallisce per un motivo diverso da quello scritto è `rosso-inatteso`, non
> "va bene così". `npm run test:acceptance` gira la sola suite (17 scenari,
> **~60s** misurati in locale). Job CI dedicato scritto
> (`.github/workflows/accettazione.yml`), ora anche su `pull_request` verso
> `dev`/`main` oltre che su `push`/`workflow_dispatch` (decisione
> dell'orchestratore, PR #54 giro 2, reversibile — prima `pull_request` era
> deliberatamente assente per lo stesso motivo di budget che governa `ci.yml`;
> vedi il commento in testa al workflow per la conseguenza nota): workflow
> validato (YAML analizzato con `js-yaml`, passi identici a quelli verificati
> in locale); con `pull_request` nel trigger questa stessa PR è la prima corsa
> reale su GitHub Actions, non più rimandata al merge su `dev`.
>
> **Oggi, 18 scenari**: A1/A5/A8 (installazione) · B1/B3/B4/B5/B8/B11 · C1/C4 ·
> D1/D2/D3/D10 · E1/E2/E5 — diciassette **verde**, un **atteso-rosso** (D3 undo →
> decisione owner ancora aperta su §1, con una firma di fallimento dichiarata:
> `muffin undo` resta un comando sconosciuto). B8, C4 e D10 erano
> `atteso-rosso` con una ragione già falsa (`slice/acceptance-truth`,
> `docs/lessons.md` "An atteso-rosso that accepts any error…"). Ogni verde è
> stato visto cadere per davvero prima di essere lasciato verde — rotto il
> cablaggio in produzione che ciascuno prova (`TurnStore.create`, `verify()`,
> `SessionStore.append`, `renderForPrompt`, il caso `draft` del kernel,
> `BudgetEngine.exhausted`), verificato il rosso, ripristinato — non solo
> scritto a supporre che avrebbero funzionato.
>
> **Quello che questo READY non copre**, e il rapporto lo dice da solo ad ogni
> corsa invece di nasconderlo: sette righe già `READY` per altre ragioni non
> hanno ancora uno scenario qui (B14, C2, C3, C6, C7, D4, D6) — nessuna era
> nella lista minima del mandato di questa slice, e chiuderle resta un lavoro
> futuro, non silenzioso (`slice/triage-day1`, in corso, le riclassifica). C8
> (audio) è marcata `non provabile qui` col motivo scritto (richiede una
> trascrizione reale, vietata dalla proprietà "non costa niente" di questa
> suite). **E4 stessa non ha, e non può avere, un proprio scenario** — sarebbe
> la suite di accettazione che prova se stessa — quindi il manifest la marca
> `provata dal meccanismo`: è ogni riga verde qui sopra a provarla, non uno
> scenario dedicato. **E4 READY vuol dire "la primitiva esiste, gira contro il
> binario vero, e lo stato delle altre righe è derivabile da un comando" — non
> "l'inventario è coperto".**
>
> **Aggiornamento 17/08.** Il triage evidence-only ha riclassificato le sette
> righe (`B14, C2, C3, C6, C7, D4, D6`) da `READY` a `BLOCKER` «solo scenario
> mancante», ciascuna con la journey che la chiude (`gate1/PERCORSO-CRITICO.md`
> §4); con la PR #54 mergiata (E4 `provata dal meccanismo`) il rapporto non ha
> più righe READY senza scenario. Nessuna riga di questo inventario è
> `INVALIDATED`: il triage non ha trovato una sola domanda Gate 1 la cui
> premessa non regga più contro il sistema reale — ogni riga BLOCKER manca
> ancora implementazione, cablaggio o scenario, mai la ragione d'essere della
> domanda stessa.

---

## §1 · Il modello di reversibilità — la decisione sotto `fs.write`

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
essere creato e lasciare il kernel puro.

## §2 · `wait` e `todo` sono primitive del runtime, non tool

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

> 🔭 **Manca il decisore, non solo la primitiva** — `research/hermes-documentazione.md`
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

## §3 · La direzione oltre il Gate 1 non allarga il Gate 1

ADR-0045 nomina l'agente continuo, la presenza, il world state e l'autonomia
guadagnata. ADR-0046 fissa il confine di ogni surface. Non sono una scusa per
aggiungere adesso hardware, un trust score o una tabella generica. Il Gate 1
compra la continuità operativa necessaria a vivere quattordici giorni; l'uso
reale decide poi quale interfaccia sostituire.

Tre confini restano già decisi:

- world state è distinto da episodi, credenze e stato del lavoro, ma aspetta un
  consumer prima dello schema;
- un device è una surface dello stesso agente, mai una seconda memoria o policy;
- una surface separa identità autenticata e contenuto: nessun metadata elegge
  l'owner, ogni campo model-visible è parsato, provenanced e tainted;
- l'autonomia futura comprime supervisione per capability/risorsa/contesto su
  evidenza osservabile; non indebolisce il kernel, il taint o il Root of Trust.

---

**Il lavoro finisce quando l'inventario ha zero BLOCKER e ogni voce è READY,
FUORI DAL GATE 1 o INVALIDATA, ciascuna con la ragione o l'evidenza scritta.**
Solo allora si propone il Gate 1 — e da lì lo sviluppo lo guidano i problemi
che l'owner incontra vivendoci, non le feature immaginate davanti a una
lavagna.
