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

## La regola delle tre risposte

Ogni riga di questo inventario deve avere **una** di queste tre, e la quarta non
esiste:

- **READY** — implementata, cablata, provata, e il percorso reale ci arriva.
- **FUORI DAL GATE 1** — deliberatamente non serve per i 14 giorni, **con la
  ragione scritta**.
- **BLOCKER** — impedisce i 14 giorni.

> **«Non ci avevamo pensato» è la quarta categoria, ed è precisamente quella che
> ci ha portati a M5-bis.** Se durante il lavoro emerge una lacuna nuova, non si
> nasconde: si aggiunge qui.

## Cosa significa «chiuso»

Un test verde **non** è «chiuso». Chiuso è, per ogni voce:

implementazione · unit test · **integration test** · **cablaggio in produzione**
· **percorso di fallimento** · **scenario di accettazione reale** ·
documentazione e `STATE.md` aggiornati.

È la stessa disciplina del giudice di questo repo: non che il codice *sembri*
corretto, ma che **la garanzia sia raggiungibile dal percorso vero**.

---

## L'inventario

Stato: `READY` · `OUT` (fuori dal Gate 1, con ragione) · `BLOCKER` · `?` (non
ancora verificato — **è un debito, non uno stato**).

### A · Installazione e ciclo di vita → `gate1/a-installazione.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| A1 | Boot | Muffin parte da solo e recupera lo stato? | ? |
| A2 | Identity | Sa chi è e quali limiti ha? | BLOCKER 👤 `identity.md` è testo reale dell'owner da c090dce, sigillata nel RoT, e raggiunge il system prompt reale — provato: `slice/identita` parte 1 (`research/prompt-assembly-2026-08-17.md`, `muffin prompt show`, wiring test mutati rosso-prima, scenario di accettazione A2 verde contro il binario vero). Resta BLOCKER: manca il character eval sui modelli Gate 1 (punto 6 mandato owner) → parte 2 |
| A3 | Persona | Il comportamento è definito? | BLOCKER 👤 `persona.md`/`voice.md` sono testo reale dell'owner da c090dce e raggiungono il system prompt reale nell'ordine canonico (persona → identity → voice) — provato: scenario A3 verde, `muffin prompt show` byte-identico a quanto ricevuto davvero dal provider. Resta BLOCKER: mancano character eval, cross-model e confronto col vecchio `Muffin.ai` (punti 6-8 mandato owner) → parte 2 |
| A4 | Config | Si configura senza toccare il codice? | ? |
| A5 | Doctor | Individua **davvero** i problemi? | ? |
| A6 | Upgrade | Aggiornare il codice non distrugge dati? | ? |
| A7 | Migration | Lo schema evolve senza perdere memoria? | ? ⚠️ `episodes.kind` ha un CHECK non alterabile |
| A8 | Backup | La memoria si salva e si ripristina? | ? |
| A9 | Setup locale | `muffin init --local` riusa i segreti persistiti per un'installazione pulita di prova? | BLOCKER 👤 — richiesto dall'owner (16/08): senza, ogni prova «da utente nuovo» costa reincollare le chiavi |

### B · Continuità del runtime → `gate1/b-continuita.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| B1 | Conversation | CLI e Telegram condividono **davvero** sessione e memoria? | ? |
| B2 | Long-running | Un turno può durare minuti senza rompere il connector? | BLOCKER — meccanismo costruito e provato end-to-end, resta **una chiamata** nel connettore 🪡 |
| B3 | Wait | Può aspettare **senza bloccare il runtime**? | READY — `wait` sospende la riga e RILASCIA il runtime; la corsia del gateway la risveglia, e `doctor` avverte se non ne gira nessuna |
| B4 | Todo | Mantiene lavoro multi-step persistente? | READY — tabella `todos` con `tier`, letta nel contesto di **ogni** turno della sessione |
| B5 | Resume | Se muore a metà, riprende? | READY — accettazione: processo vero ucciso con SIGKILL a metà turno, riprende al riavvio |
| B6 | Retry | Se fallisce una tool call, recupera? | ? |
| B7 | Scheduler | I job sopravvivono al riavvio? | ? |
| B8 | Delivery | Un job che dice «inviato» è **arrivato**? | READY — `Deliver` ritorna `DeliveryOutcome`, `Scheduler.settle` è l'unico chiamante di `markRan` |
| B9 | Proactivity | Agisce spontaneamente secondo i gate? | ? ⚠️ 4 dei 5 `ProactiveKind` non hanno produttore |
| B10 | Telegram | Messaggi, file, immagini, **errori** | ? |
| B11 | Streaming | La risposta arriva mentre si forma, o solo alla fine? | READY per CLI/REPL e Telegram (`slice/streaming`, due PR verso `dev`) — Discord resta OUT (B17). Entrambi gli adapter honorano `ChatCall.stream` (`Provider.chatStream`, SDK ufficiali, non SSE fatto a mano); il loop bufferizza i delta per giro e li rilascia solo per quello che risponde davvero (mai durante una tool call — un giro nudged dal completion gate non trapela il suo bozzone). REPL: stampa progressiva byte-identica a fine turno, `--no-stream`. Telegram: bozza dal vivo (`sendMessageDraft`, con `draft_id` — mancava, trovato e corretto in questa slice, vedi ADR-0025 §revisione e `docs/lessons.md`) in chat privata, `editMessageText` sul placeholder in gruppo; spento per sessione al primo edit fallito (Hermes); mai più di un messaggio Telegram per turno (overflow → consegna normale a fine turno). **Nota onesta**: un giro si rilascia in un colpo solo a `done` (mai un punto prima è conoscibile — "streamma e ritira" scartato di proposito), quindi un turno senza tool call produce tipicamente UN aggiornamento dal vivo, non un typewriter — la percezione di attività durante l'attesa viene dal placeholder/typing che precede. Fallback singolo e contato se lo stream del provider si rompe a metà (`ProviderStreamError`). Cablaggio verificato end-to-end con provider SSE finto attraverso `buildRuntime` reale (`cli/repl.test.ts`, `connectors/telegram/streaming.test.ts`), non un `Provider`/`TelegramApi` sostituito a mano. Scenario di accettazione contro il binario vero verde (`evals/acceptance/scenarios/b-streaming.accept.ts`, spawna `muffin repl --stream` come processo reale contro il provider SSE finto e legge la richiesta `stream:true` che il fake ha ricevuto — non un'assunzione dalla risposta arrivata giusta) |
| B12 | Overflow | Un output enorme di un tool va in contesto, o diventa un file richiamabile? | ? |
| B13 | Progress | Un turno lungo dice di essere vivo in modo **strutturale**, non cosmetico? | ? 🔭 |
| B14 | Attachment | Un file prodotto arriva come **allegato**, o come percorso da copiare a mano? | READY per l'owner — `send_file` (agent/tools/deliver.ts) raggiunge `Surface.deliverFile` su Telegram e Discord; ⚠️ `hostOnly`, un member non può ricevere un proprio file (vedi sotto) |
| B15 | Owner binding | Ogni surface riconosce l'owner solo da un subject-id stabile autenticato e protetto? | BLOCKER — `identify()` unica e cablata su Telegram e Discord (provato da impersonation test su entrambe); DM-only enforced su `channel_type` (D1, judge PR #42, 2026-08-16: un GROUP_DM senza `guild_id` non deriva più `direct: true`); resta aperta la metà "protetto": binding ancora in config, non nel RoT — `ownerUserId` vive in `config.json` ordinario, non nel Root of Trust |
| B16 | Ingress parsing | **Ogni** campo letto entra tipizzato con provenienza/taint, inclusi nomi, bio, metadata, immagini e derivati? | BLOCKER — invariato: Discord non legge username/global_name/bio per l'identità (stesso non-conflation di Telegram), ma non esiste ancora l'envelope universale con provenienza/tier per campo che B16 chiede — questa slice non l'ha costruito |
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

> 🔭 **Le righe col cannocchiale le ha trovate uno sguardo fuori** —
> `research/hermes-documentazione.md` (2026-08-15), la documentazione intera di
> Hermes Agent letta contro il nostro codice. Quel documento non aggiunge solo
> righe: **cambia la forma del rimedio** di B2 (il turno non va reso asincrono
> — serve un canale di progresso ortogonale), di B12 (`agent/context/compact.ts:90`
> cancella il payload *intero* mentre ogni cap sotto è testa+coda — è un difetto,
> non una mancanza), di D2/D3 (*non chiedere, fotografare*) e di E1 (contare
> l'atto patologico costa meno che stimare i token). Il §5 di quel file elenca
> riga per riga cosa sposta.

### C · Memoria e acquisizione → `gate1/c-memoria.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| C1 | Memory write | Ogni informazione importante viene acquisita? | ? |
| C2 | Extraction | L'estrazione è automatica? | READY (ADR-0038) |
| C3 | Consolidation | Si consolida senza intervento? | READY (ADR-0040) |
| C4 | Recall | Ripesca il vecchio **e** il superseded? | READY (PR [#35](https://github.com/GiustoPiedimonte/muffin-agent/pull/35)) ⚠️ nota sotto |
| C5 | Provenance | Posso capire **perché** crede una cosa? | ? |
| C6 | Temporal graph | «Chi era X a maggio» | READY (PR [#35](https://github.com/GiustoPiedimonte/muffin-agent/pull/35)) |
| C7 | PDF | Acquisisce documenti utili? | READY (ADR-0043) ⚠️ niente OCR |
| C8 | Audio | Gestisce le note vocali? | BLOCKER — nessuna trascrizione; **decisione owner 16/08**: se il modello ha la capability audio va diretto, altrimenti whisper/faster-whisper in locale sulla VPS; fornitore per capability scelto dalla CLI |
| C9 | Pressure | L'agente sa **quanto spazio gli resta**, dentro il prompt? | ? 🔭 |
| C10 | World state | Distingue ciò che vale adesso da episodi, credenze e lavoro? | OUT — post-Gate 1, consumer prima dello schema (ADR-0045) |

> **C4/C6, cosa vuol dire `READY` qui.** `--history` era già stato corretto per
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

> **C7, cosa vuol dire `READY` qui.** PDF, DOCX e testo entrano **interi** nel
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

### D · Capability e sicurezza → `gate1/d-capability.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| D1 | File read | Legge file reali? | ? |
| D2 | File write | Modifica file reali **in sicurezza**? | BLOCKER — rifiuta ogni draft |
| D3 | Undo | Posso recuperare una modifica? | BLOCKER — registro assente |
| D4 | Shell | Esegue comandi nel sandbox? | READY su macOS · ? su Linux 🔧 |
| D5 | Process | Gestisce processi lunghi? | ? |
| D6 | HTTP | Naviga secondo policy? | READY (estrazione in #8) |
| D7 | Web search | Funziona end-to-end? | ? |
| D8 | MCP | Gestisce drift e revoca? | ? — pinning solo all'attach |
| D9 | Skills | Scopre e usa le skill? | ? |
| D10 | Security | Nessuna capability escape? | ? |
| D11 | Checkpoint | Esiste uno snapshot prima di ogni mutazione, e un ripristino che disfa anche il turno? | BLOCKER 🔭 — è la forma che §1 cercava |
| D12 | Ask | L'ASK mostra **cosa** sta per fare (comando+cwd, URL, pid+nome) e perché il turno è a quel taint? | BLOCKER — direttiva owner 16/08; oggi `ApprovalRequest` porta solo capability+prompt (+path), il REPL chiede «approvi "sys.shell"?» senza il comando |

### E · Economia e osservabilità → `gate1/e-osservabilita.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| E1 | Budget | Cap globale **e** per-job? | BLOCKER — il per-job non esiste |
| E2 | Cost | So quanto costa una giornata? | ? |
| E3 | Tracing | Posso ricostruire cosa è successo? | ? |
| E4 | Tests | Acceptance test **reali**, non solo unit? | READY (`evals/acceptance/`) |
| E5 | Failure | Ogni fallimento importante è esplicito e recuperabile? | ? |
| E6 | Act caps | Un singolo turno può fare 200 ricerche web o 200 deleghe? | ? 🔭 |

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
> inatteso o su una riga `READY` scoperta. `npm run test:acceptance` gira la
> sola suite (12 scenari, **~17s** misurati in locale). Job CI dedicato
> scritto (`.github/workflows/accettazione.yml`, su push `dev`/`main` e
> `workflow_dispatch` — non su ogni push di PR, per lo stesso motivo di budget
> che governa `ci.yml`): workflow validato (YAML analizzato con `js-yaml`,
> passi identici a quelli verificati in locale) ma **non ancora eseguito su
> GitHub Actions** — `workflow_dispatch` risponde 404 finché il file non è
> anche sul branch di default, quindi la prima corsa reale sarà al merge su
> `dev`.
>
> **Oggi, 12 scenari**: A1/A5/A8 (installazione) · B1/B8 · C1/C4 · D2/D3/D10 ·
> E1/E2 — otto **verde**, quattro **atteso-rosso** (B8 delivery →
> `slice/superfici`, C4 recall storico → `slice/memoria-nel-tempo`, D3 undo →
> decisione owner ancora aperta su §1, D10 taint→egress →
> `slice/taint-in-ingresso`). Ogni verde è stato visto cadere per davvero prima
> di essere lasciato verde — rotto il cablaggio in produzione che ciascuno
> prova (`TurnStore.create`, `verify()`, `SessionStore.append`,
> `renderForPrompt`, il caso `draft` del kernel, `BudgetEngine.exhausted`),
> verificato il rosso, ripristinato — non solo scritto a supporre che
> avrebbero funzionato.
>
> **Quello che questo READY non copre**, e il rapporto lo dice da solo ad ogni
> corsa invece di nasconderlo: cinque righe già `READY` per altre ragioni non
> hanno ancora uno scenario qui (C2, C3, C7, D4, D6) — nessuna era nella lista
> minima del mandato di questa slice, e chiuderle resta un lavoro futuro, non
> silenzioso. C8 (audio) è marcata `non provabile qui` col motivo scritto
> (richiede una trascrizione reale, vietata dalla proprietà "non costa niente"
> di questa suite). **E4 READY vuol dire "la primitiva esiste, gira contro il
> binario vero, e lo stato delle altre righe è derivabile da un comando" — non
> "l'inventario è coperto".**

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

**Il lavoro finisce quando l'inventario ha zero BLOCKER e ogni voce è READY o
FUORI DAL GATE 1 con la ragione scritta.** Solo allora si propone il Gate 1 —
e da lì lo sviluppo lo guidano i problemi che l'owner incontra vivendoci, non le
feature immaginate davanti a una lavagna.
