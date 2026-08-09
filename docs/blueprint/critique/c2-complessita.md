# C2 — Attacco alla complessità (Fase C, Critico Ostile №2)

> Letti integralmente: `00-findings.md`, `01-verdetti.md`, `02-ontologia.md`, `03-threat-model.md`, `04-roadmap.md`, `05-testing-evals.md`, `06-modelli.md`, `07-durevole-vs-impalcatura.md`, `08-assunzioni.md`, `BRIEF.md`, `STATE.md`, i 18 ADR, `research/a1-inventario-codebase.md`, `research/a2-prior-art.md`, `research/a6-brain-hands-sandbox.md`. I numeri e i `file:riga` sotto sono tutti citazioni dirette di questi file letti in questa sessione; le stime di tempo/costo sono giudizio ingegneristico esplicitamente marcato come tale, non misure.
>
> Criterio unico: l'owner è UNA persona, di sera, part-time su questo progetto. Ogni pezzo che richiede più di un pomeriggio per essere capito da zero da chi lo manutiene, o che genera una seconda superficie da tenere viva (un secondo processo, una seconda piattaforma, un secondo modello, una seconda tassonomia), parte con l'onere della prova.

---

## 0. Nota di framing — due direttive owner già ferme, rispettate ma messe sotto stress

Da `STATE.md:6`, l'owner ha già confermato al checkpoint: (1) "riparti-da-zero sul design", (2) capability floor multi-tier sui modelli consumer, (6) renderer rich-media per connector (ADR-0016). Non ridiscuto queste direttive come tali — le prendo come date. Attacco però **come vengono tradotte in moduli e sequenza**, perché "riparti da zero sul design" (ri-derivare ogni scelta con evidenza) e "riparti da zero sull'implementazione" (costruire un secondo sistema in parallelo, M0→M7, prima che il primo faccia nulla di nuovo per l'owner) sono due costi diversi, e il piano li tratta come uno solo. Lo stesso vale per il renderer: "rich-media invece di prosa verbosa" è la direttiva; "un modello di contenuto canonico strutturato con capability-negotiation generica" è UNA implementazione possibile di quella direttiva, non l'unica, e la attacco su questo piano.

---

## 1. Tabella di sintesi — i 18 ADR (risposta a "quali non andavano decisi ora")

| ADR | Verdetto sintetico | Necessaria ORA? |
|---|---|---|
| 0001 Runtime TS unico | Fondazionale, prova d'esistenza reale (193K LOC), costo-di-cambio-dopo alto → decisione giusta ora. Nessun taglio. | Sì |
| 0002 Organizzazione per feature | Economica, reversibilità media dichiarata onestamente. Nessun taglio. | Sì |
| 0003 Root of Trust | **Bersaglio #1** — meccanismo (utente OS separato + boot-refusal) sproporzionato al gap che chiude, in parte ridondante con ADR-0018. | Il concetto sì, il meccanismo no |
| 0004 Memoria TKG | Il nucleo (3 piani, bi-temporale) è riconferma di WG-1 già validato in casa — economico. Le parti che overengineerano sono a sé: v. Bersagli #2, #3. | Sì (nucleo), No (identities/ceremony) |
| 0005 Provenienza/taint | Colonne, economico, è il differenziale dichiarato e la difesa anti-poisoning richiesta esplicitamente dal BRIEF. Nessun taglio. | Sì |
| 0006 Giudice di contraddizione | **Bersaglio #4** — "organo misurato" con soglia di attivazione dedicata costruito prima di avere volume reale di conflitti sul nuovo schema. | Il giudice sì, l'apparato-eval-soglia no |
| 0007 Approvvigionamento modelli | Vincolo di ToS reale e verificato, non rimandabile. Nessun taglio. | Sì |
| 0008 Provider adapter | Minima, YAGNI-compliant, l'alternativa (framework) è già stata scartata con evidenza propria. Nessun taglio. | Sì |
| 0009 Lane statiche, niente router | Questa è l'ADR che il piano stesso usa per **evitare** over-engineering (routing dinamico scartato con post-mortem Manifest). Corretta com'è. | Sì |
| 0010 Standard esterni | SKILL.md/AGENTS.md/OTel-naming = adottare è MENO lavoro che inventare, corretto. Il client MCP generico e la piena macchina OTel sono sovradimensionati per v1 → **Bersagli #12, #13**. | Parziale |
| 0011 Confine repo/config/dati | Economica di per sé (convenzioni di path). Il suo VALORE (distribuzione a terzi) matura solo quando esistono installatori terzi, che in v1 non esistono. Non è un bersaglio a sé: il costo reale è nell'onboarding multi-installatore (wizard, dichiarazione costi), che il §3 esclude finché non esiste un secondo installatore reale. | Il costo sì, il payoff no (per ora) |
| 0012 Nome | Costo di implementazione ~0 (una stringa), reversibilità dichiarata alta. Ha però assorbito una quantità di ricerca (intera sezione A2 §9-10, un'intera ADR con paragrafi di archeologia) sproporzionata al suo costo di attuazione. Non un bersaglio tecnico, ma una spia di dove è andato il tempo. | Il verdetto di scope sì, la profondità della ricerca sul nome no |
| 0013 Kernel permessi unificato | **Bersaglio #5** — la matrice pubblicata (03 righe 35-45) mostra che le colonne taint-2/taint-3 sono identiche riga per riga: 3 colonne dichiarate, 2 di fatto. | Il concetto sì, il parametro a 3 valori no |
| 0014 Cricchetto eval-gated | **Bersaglio #6** — canary + revert automatico + monitoraggio metriche live costruiti prima di aver mai fatto una singola modifica self-inflitta in produzione sul nuovo sistema. | Il gate sì, l'automazione-canary no |
| 0015 Coding orchestrato | Sensata (non reimplementare un harness di coding). La sola parte (b) — orchestrare-e-monitorare un harness esterno — può aspettare che la parte (a) da sola si dimostri insufficiente. Non un bersaglio a sé: la parte (a) resta in v1, la parte (b) è tra le esclusioni implicite del §3 finché (a) non si dimostra insufficiente. | (a) sì, (b) può aspettare |
| 0016 Renderer capability-aware | **Bersaglio #10** — contenuto canonico strutturato per 2 connector che oggi parlano già entrambi markdown. | No, non in questa forma |
| 0017 Community differita | Il RINVIO è corretto. Le "fondamenta strutturali ORA" nascondono il costo reale → **Bersaglio #2**. | Il rinvio sì, le fondamenta-identità no |
| 0018 Sandbox esecuzione | Richiesta esplicita owner, dipendenza già presente in Muffin (A6). Tenere. Nota sul sotto-pezzo Chromium in **Bersaglio #11**. | Sì |

---

## 2. Bersagli

### Bersaglio #1 — Root of Trust: enforcement a utente-OS-separato + boot-refusal (ADR-0003, `04-roadmap.md:63`)

`adr/0003-root-of-trust.md:5` prescrive: file in `~/.muffin/rot/`, **read-only per il processo agente via permessi OS (utente/gruppo separato)**, hash verificato al boot, **boot rifiutato su mismatch**. `04-roadmap.md:63` lo rende DoD bloccante di M0: "manomettere a mano un file del RoT → il boot lo rileva e si rifiuta di partire spiegando perché" — cioè si deve costruire e testare la macchina di enforcement PRIMA che esista, nel sistema, un solo meccanismo che possa scrivere lì (il cricchetto che tocca voice/prompt è M6, l'ultimo modulo di v1).

Il problema non è il principio (un RoT piccolo e nominato è corretto e lo tengo). Il problema è che questo specifico meccanismo duplica una difesa che il piano stesso costruisce altrove: `03-threat-model.md:54` dichiara i `mandatory deny paths` del sandbox — `~/.muffin/rot/`, config, secrets, `.git/hooks/` — "negati in scrittura SEMPRE, anche dentro un allow-write ampio", esplicitamente descritti come "complementa i permessi OS del RoT" (stessa riga). `adr/0018-brain-hands-sandbox.md:5` conferma lo stesso elenco. Quindi: **ogni tentativo di scrittura sul RoT che passi da un tool `shell`/`process`/`dev` è già bloccato dal sandbox**, indipendentemente da chi possiede i file. Il gap che resta per l'utente-OS-separato è uno solo, molto specifico: un bug nel processo del LOOP stesso (non un tool call, il codice del loop che gira sull'host, `adr/0018:5`: "il cervello ... gira nel processo host") che chiama `fs.writeFile` direttamente su un path del RoT. Ma nessuna capability esposta a runtime scrive lì (`adr/0003:5`: modifica "solo via repo→install+riavvio") — quindi questo è un bug in codice fidato, non un percorso raggiungibile da input non fidato o dal modello. `08-assunzioni.md:24` ammette peraltro che l'host compromesso è dichiarato fuori scope.

**Cosa taglierei/semplificerei**: in v1, permessi same-user (chmod di sola lettura sui file del RoT per il processo stesso) + hash-check al boot che **logga e avvisa forte** (non rifiuta di partire) su mismatch. Rimando la creazione di un utente/gruppo OS separato — e il conseguente lavoro di provisioning cross-platform (macOS non ha un equivalente leggero della separazione utente di Linux; serve gestire sudo/setup diverso sui due target dichiarati in `08-assunzioni.md:46`) — al momento in cui M6 esiste davvero e introduce il primo codice che LEGITTIMAMENTE si avvicina al confine del RoT.

**Cosa si perde esattamente**: la garanzia che anche un bug nel codice fidato del loop (non un tool call, non un input esterno) non possa mai corrompere silenziosamente il RoT, e il segnale forte "il sistema si rifiuta di partire" al posto di un warning che si può ignorare. È una perdita reale ma stretta: copre una classe di errore (bug in codice proprio) che oggi, senza cricchetto attivo, non ha un innesco concreto nel sistema.

**Cosa costa tenerlo**: uno script di provisioning utente/gruppo diverso per macOS e Linux, testato su entrambi (M0 DoD lo richiede esplicitamente "su una macchina pulita: macOS e Linux", `04-roadmap.md:63`), da mantenere ogni volta che cambia il modello di permessi del sistema operativo target o la modalità di installazione (single-binary aspirazionale, citato in A1 §11.1). Per un solo manutentore è la parte più "ops" di tutto M0.

**Verdetto: TIENI-MA-SEMPLIFICA.** Tieni il RoT come lista piccola e nominata; sostituisci l'enforcement a due-linee-di-difesa-ridondanti con una sola linea forte (sandbox deny-path, già necessaria per altro) + un tripwire same-user leggero, e rimanda l'hard boot-refusal + utente-OS-separato al momento in cui il cricchetto (M6) dà al sistema un motivo reale di avvicinarsi al confine.

---

### Bersaglio #2 — Identità cross-connector `proposed→confirmed` costruita per un caso che in v1 non può accadere (ADR-0004/0017, `02-ontologia.md:57-67`)

`02-ontologia.md:57-67` definisce `identities` con `link_status` a stati (`unlinked|proposed|confirmed`), proposta automatica su evidenza forte, conferma esplicita, gestione del "link sbagliato torna a unlinked". `adr/0017-community-differita.md:5` giustifica questo lavoro ORA dicendo che serve a rendere la community "un'addizione, non una riscrittura" quando arriverà (post-v1).

Il problema: l'ambiguità che questo meccanismo risolve — "la stessa persona vista da CONNECTOR DIVERSI" (`02-ontologia.md:56`) — richiede per definizione **almeno due connector remoti**. Lo scope v1 dichiarato in `04-roadmap.md:118` è CLI + **un solo** connector remoto (Telegram); Discord/Slack/mail sono esplicitamente fuori v1. Con un solo connector remoto, ogni `external_id` telegram è già univocamente un'unica persona per costruzione — non esiste un secondo canale con cui potrebbe essere in conflitto. Il caso che la state-machine `proposed→confirmed` è progettata per risolvere (il falso-positivo di merge cross-connector, il fallimento peggiore secondo A4 §9 "Sakura Sushi", citato in `02-ontologia.md:137`) **non può verificarsi finché n_connector_remoti = 1**.

**Cosa taglierei/semplificerei**: per v1, `identities` resta una tabella (serve comunque per isolare i membri di gruppo dall'owner e per etichettare la provenienza, M7), ma senza state-machine: mapping diretto `(connector, external_id) → entity`, creato lazily alla prima menzione, nessuna proposta automatica, nessuna conferma. Aggiungo `link_status` e il flusso `proposed→confirmed` quando esiste un secondo connector remoto reale (cioè quando la community, post-v1, viene effettivamente costruita — che è anche il momento dichiarato in `adr/0017:11` come segnale di attivazione).

**Cosa si perde esattamente**: nulla di funzionante in v1, perché lo scenario che il meccanismo previene non può accadere con un solo connector remoto. Si perde solo la comodità di NON dover fare una migrazione additiva (`ALTER TABLE identities ADD COLUMN link_status ...`) quando la community verrà davvero costruita — costo che il piano stesso, altrove (`02-ontologia.md:100`, invariante "DROP di qualunque tabella derivata + replay = stesso stato"), tratta come accettabile e persino atteso.

**Cosa costa tenerlo ora**: la state-machine (3 stati, transizioni, UI di conferma "quale contatto è questo", audit del link-evidence) è codice e superficie di test (M7 DoD la include: `04-roadmap.md:112`) per una capacità che nessun utente reale eserciterà finché la community non esiste — è complessità pagata con mesi di anticipo sul suo primo caso d'uso reale.

**Verdetto: TIENI-MA-SEMPLIFICA** (per M2/M7: mapping diretto, senza state-machine) / **RIMANDA** (per proposed/confirmed: a quando la community entra davvero in roadmap).

---

### Bersaglio #3 — Bi-temporalità a 4 timestamp + classificatore "query storica" nel recall (`02-ontologia.md:76-79`, `:161`)

Lo schema `facts` porta `valid_from`/`valid_to` (quando è vero NEL MONDO) oltre a `recorded_at`/`expired_at` (quando il sistema l'ha appreso/ritirato). La regola esplicita è "mai inventato: `valid_from` NULL=ignoto" (`02-ontologia.md:76`) — cioè per design, ogni volta che l'utente non data esplicitamente il proprio enunciato (la stragrande maggioranza della chat casuale: "ho cambiato commercialista, ora è Lucia" non dice DA QUANDO), `valid_from`/`valid_to` **restano NULL**. Il valore del bi-temporale puro si materializza solo quando l'utente enuncia esplicitamente una data storica ("è cambiato a marzo") — un pattern conversazionale reale ma minoritario rispetto al caso comune "questo è vero ORA".

Il DoD di M2 stesso (`04-roadmap.md:77`) lo dimostra involontariamente: "chi era il mio commercialista a maggio?" risponde "col fatto expired" — e questo funziona già con **uni-temporale puro** (catena `recorded_at` + `expired_at`/`superseded_by`, senza `valid_from`/`valid_to`), perché "Marco" è stato registrato PRIMA e "Lucia" DOPO: non serve sapere quando il cambio è avvenuto nel mondo per rispondere correttamente a una domanda posta rispetto all'ORDINE di registrazione. Il beneficio incrementale del secondo asse (validità-nel-mondo) esiste solo per il caso "l'utente corregge una data passata" — reale, ma raro, e non è quello dimostrato nel DoD.

Il costo non è nello schema (le colonne sono opzionali/nullable, quindi a schema-costo-zero, coerente con `07-durevole-vs-impalcatura.md`). Il costo è nel **recall**: `02-ontologia.md:161` richiede che l'ordinamento sia sensibile allo "stato bi-temporale (un fatto expired si recupera solo se la query è storica)" — questo implica un classificatore (esplicito o implicito nel prompt) che distingua "domanda sul presente" da "domanda storica" per decidere se includere fatti scaduti. È un pezzo di logica in più, con un suo proprio tasso di errore, per servire il sotto-caso minoritario.

**Cosa taglierei/semplificerei**: shippa il recall v1 su semantica uni-temporale (fatto attivo = quello non superseded, ordinato per `recorded_at`); tieni `valid_from`/`valid_to` nello schema (sono gratis) ma NON costruire il classificatore "query storica" finché non hai osservato, sui dati reali migrati, quante domande dell'owner sono davvero del tipo "cosa era vero A UNA DATA PASSATA" contro "cosa è vero ora" (la seconda, per un assistente personale conversazionale, è verosimilmente la stragrande maggioranza).

**Cosa si perde esattamente**: la capacità di rispondere correttamente a "cosa era vero il [data specifica nel passato]" quando quella data cade PRIMA dell'ultimo cambiamento registrato ma l'utente non l'ha esplicitata al momento del cambiamento (caso raro: di solito quando l'utente corregge il passato, lo fa proprio dicendo la data). Nella pratica quotidiana single-user, il caso che si perde è stretto.

**Cosa costa tenerlo**: un classificatore "è una domanda storica" (euristico o a carico del modello) che è esso stesso una fonte di errore aggiuntiva — esattamente la categoria di "impalcatura che il modello deve indovinare" che il progetto ha già imparato a diffidare (cfr. la storia degli intent-classifier retrocessi a monitor-only, `01-verdetti.md:75`).

**Verdetto: TIENI-MA-SEMPLIFICA.** Schema bi-temporale sì (è gratis e non reversibile-in-peggio da aggiungere dopo); logica di recall bi-temporale-aware no, finché il volume di domande davvero storiche non lo giustifica.

---

### Bersaglio #4 — Giudice di contraddizione come "organo misurato" con soglia di attivazione dedicata (ADR-0006, `05-testing-evals.md:28`)

`adr/0006-giudice-contraddizione-misurato.md:5` costruisce: schema reasoning-first, 4 esiti, **eval dedicata con soglia di attivazione** — sotto soglia il giudice "non supersede, accumula e flagga". `02-ontologia.md:108` lo rende parte della pipeline di estrazione di M2, dal primo giorno.

Questo è il pezzo dove la storia interna (89 credenze corrotte, ADR-025, citata in `02-ontologia.md:10`) dà la motivazione più forte di tutto il documento — non lo attacco sul principio. Lo attacco sulla SEQUENZA: si costruisce l'intera infrastruttura di misura (eval dedicata, soglia di attivazione, meccanismo di accumulo-e-flag sotto soglia) PRIMA di aver rigiocato l'estrazione sul dataset reale migrato e aver visto quanti conflitti genera davvero il nuovo schema (set-valued di default, `02-ontologia.md:92`, già riduce drasticamente la superficie del problema rispetto al vecchio singleton che aveva causato i 89 casi). È plausibile che con cardinalità set-valued-di-default il volume di veri conflitti bisognosi di un giudice elaborato sia molto più basso che nel sistema vecchio — cosa che si scopre SOLO rigiocando la migrazione (`02-ontologia.md:151-155`, che è già pianificata come primo eval reale).

**Cosa taglierei/semplificerei**: per la prima iterazione, un giudice LLM one-shot con lo schema reasoning-first (il fix per il collasso Graphiti #1666 è quasi gratis: è solo l'ordine dei campi nel prompt) ma SENZA l'apparato di soglia-di-attivazione-misurata-e-gate — semplicemente: se il giudice non è confident, esito `review` (già previsto). Costruisci la eval dedicata con soglia DOPO aver rigiocato la migrazione (§8) e aver contato quanti conflitti reali il nuovo schema genera.

**Cosa si perde esattamente**: la garanzia misurata "sotto questa soglia il giudice non tocca nulla" fin dal primo giorno — cioè un margine di sicurezza in più nelle primissime settimane, quando peraltro il volume di fatti nuovi (vs. quelli migrati in blocco) è basso e l'owner sta osservando da vicino comunque.

**Cosa costa tenerlo dal giorno 1**: una eval suite dedicata (con i 12 predicati storici + casi-stress) da costruire e tenere verde PRIMA di avere il dato reale che dice se serve una soglia stretta o larga — rischio concreto di tarare la soglia sul corpus sbagliato (quello vecchio) e doverla ritarare comunque dopo la migrazione.

**Verdetto: TIENI-MA-SEMPLIFICA.** Il giudice sì, dal giorno 1 (è cheap, un prompt); l'apparato di eval-a-soglia-dedicata, costruiscilo con i dati della migrazione in mano, non prima.

---

### Bersaglio #5 — Kernel di permessi: la matrice a 3 colonne è, riga per riga, una matrice a 2 (ADR-0013, `03-threat-model.md:35-45`)

Questo è il finding più diretto per la domanda ostile #4. La matrice pubblicata (`03-threat-model.md:35-45`) ha 3 colonne di contesto: `owner@host taint≤1`, `qualunque taint 2`, `qualunque taint 3`. Guardando riga per riga cosa succede tra colonna 2 e colonna 3:

- riga 37 (lettura memoria): `ALLOW (solo proprio tenant)` = `ALLOW (solo proprio tenant)` — identiche
- riga 38 (scrittura memoria): "tier ereditato" vs "tier 3" — stessa azione (ALLOW), etichetta di tier diversa, non un esito di policy diverso
- riga 39 (reply): `ALLOW` = `ALLOW` — identiche
- riga 40 (egress): la colonna 3 è testualmente **"idem"** — cioè il documento stesso dichiara che è la stessa cella della colonna 2
- righe 41-45 (shell/outward/config/dev/RoT): `DENY` = `DENY` su ogni riga

**In nove righe su nove, taint-2 e taint-3 producono lo stesso verdetto del kernel.** L'unica differenza tra i due tier è l'etichetta di provenienza propagata ai dati (utile per l'audit e la UI: "fonte: gruppo X, tier 2" vs "fonte: web, tier 3", `02-ontologia.md:127`) — non una decisione diversa nella funzione `decide()`.

**Cosa taglierei/semplificerei**: la funzione di decisione del kernel (ADR-0013) prende un parametro booleano `trusted` (`principal==owner && taint<=1`), non un taint a 4 valori. Il taint a 4 valori RESTA come campo dati (per l'audit, la UI, il "da dove viene questo ricordo") — quello è a buon mercato e differenziante (ADR-0005, che tengo). Quello che taglio è la ceremonia "dichiara classe di rischio × risorse × taint-massimo-ammesso × reversibilità per ogni capability" (`adr/0013-kernel-permessi-unificato.md:9`) applicata come se il taint avesse 4 gradazioni di conseguenza, quando ne ha 2.

**Cosa si perde esattamente**: nessuna funzionalità di sicurezza — la matrice resta identica nei suoi esiti. Si perde solo l'illusione di una granularità a 4 livelli nel punto (la policy) dove non paga; se in futuro emergesse un vero bisogno di trattare tier-2 diversamente da tier-3 in una capability specifica, aggiungerlo è un cambio locale a quella riga, non una riscrittura del kernel (la funzione resta la stessa forma, si aggiunge un branch).

**Cosa costa tenerlo com'è documentato**: ogni futura capability che si dichiara nel registro deve compilare "taint massimo ammesso" come se fosse una scelta tra 4 valori con conseguenze diverse, quando l'evidenza nella stessa tabella dice che ne bastano 2 — è superficie di configurazione e di test (fuzzing "leggero sulle decision" contro "la matrice attesa", `05-testing-evals.md:37`) che verifica una distinzione che oggi non esiste nel comportamento.

**Verdetto: TIENI-MA-SEMPLIFICA.** Unifica il kernel (è un miglioramento reale rispetto ai 3 modelli separati che i peer usano, e in gran parte è già ciò che Muffin ha oggi con zone HITL + tier-2 act-notify-undo, `research/a1-inventario-codebase.md §4`) ma collassa il parametro di decisione a 2 valori; tieni il tier a 4 valori solo come campo-dato per provenienza/audit.

---

### Bersaglio #6 — Cricchetto: canary + revert automatico + monitoraggio metriche live prima della prima modifica reale (ADR-0014, `05-testing-evals.md:39-45`)

`05-testing-evals.md:39-45` specifica un ciclo a 5 fasi: proposta versionata → gate su eval pertinente → **canary con finestra di osservazione e revert automatico su metriche live sotto baseline** → audit → (la suite di riferimento vive nel RoT). Questo è M6, l'ultimo modulo di v1 nella sequenza dichiarata (`04-roadmap.md:144`).

Il punto 3 (canary + revert automatico su "metriche live sotto baseline") presuppone un'infrastruttura di monitoraggio continuo in produzione (dashboard di metriche live, soglie di baseline calcolate e mantenute, un job che confronta metriche pre/post e decide di fare rollback da solo) che è, di per sé, un sistema separato da costruire e tenere in salute — non è "un pezzo del ratchet", è un sistema di monitoring/alerting con auto-remediation. Per un singolo manutentore che userà il ratchet probabilmente poche volte al mese (non è un sistema multi-tenant con volume che giustifica automazione), il rapporto costo/beneficio di costruire l'auto-revert PRIMA di aver mai fatto la prima modifica manuale è capovolto.

**Cosa taglierei/semplificerei**: v1 del ratchet = "proposta con diff mostrato in chat + eval pertinente passata → l'owner approva o rifiuta in un messaggio" (esattamente il pattern che il progetto già applica al codice: "ogni modulo chiude con PR + review", `08-assunzioni.md:49`, applicato qui a voice/prompt/soglie invece che al codice). Zero canary automatico, zero monitoraggio-metriche-live-con-soglia-di-baseline. Costruisci il canary+auto-revert quando il volume di proposte supera quello che un owner può revisionare a mano in tempo utile (segnale esplicito, misurabile: proposte/settimana > soglia di attenzione dell'owner).

**Cosa si perde esattamente**: la capacità del sistema di attivare E disattivare da solo una modifica senza intervento umano nella finestra di osservazione — cioè un pezzetto dell'autonomia "self-improving mentre dormo" che il BRIEF chiede esplicitamente (`BRIEF.md:138`: "uno che si riscrive da solo mentre dormo è pericoloso... dove sta la linea"). È una perdita reale rispetto all'ambizione dichiarata, non cosmetica — ma è anche esattamente il tipo di autonomia che il BRIEF stesso tratta con sospetto nella stessa frase.

**Cosa costa tenerlo dal giorno 1**: un sistema di metriche-live-vs-baseline (che richiede aver già definito le baseline, che richiedono settimane di dati sul NUOVO schema per essere significative) più il codice di rollback automatico stesso, con il suo proprio rischio di bug (un rollback automatico sbagliato è un secondo genere di incidente, non coperto da nessuna eval finché non lo si testa a sua volta).

**Verdetto: TIENI-MA-SEMPLIFICA.** Il gate (proposta versionata + eval pertinente + audit) è il cuore e va tenuto; il canary automatico con revert-senza-owner è impalcatura di un livello di fiducia che il sistema non ha ancora guadagnato — e il documento lo dice praticamente da solo altrove (`07-durevole-vs-impalcatura.md:28`: "impalcatura la taglia del perimetro auto-applicabile... il ladder si allarga con lo storico di canary puliti" — cioè anche gli autori sanno che il perimetro deve crescere gradualmente; applico la stessa logica al MECCANISMO del canary, non solo al suo perimetro).

---

### Bersaglio #7 — M6 "introspezione bidirezionale": costruibile o promessa? (`04-roadmap.md:101-106`, `01-verdetti.md:132`)

Questo è il modulo dichiarato differenziale (`04-roadmap.md:101`: "è il differenziale") e insieme il più vago. Scomponendolo:

1. **Report sull'utente** (pattern + contrappunto): NON è nuovo — Living Profile, Counterpoint e Self-narrative esistono già, in produzione, nel Muffin attuale (`research/a1-inventario-codebase.md §3.8`). Ricostruirli sul nuovo schema è lavoro reale ma a basso rischio (pattern già provato).
2. **Report su di sé** (pattern di fallimento, costi, tasso di successo tool, derive): questa è la parte genuinamente nuova. Il documento NON specifica se "pattern di fallimento" e "deriva" sono (a) aggregati deterministici su SQL/span (economico, zero rischio di confabulazione: tasso di successo per tool, costo/giorno, distribuzione dei tipi di uscita del loop — tutti GIÀ elencati come metriche deterministiche in `05-testing-evals.md:49`) oppure (b) una sintesi narrativa prodotta da un LLM che legge una settimana di trace e "racconta" cosa è successo. Se è (b) senza la stessa disciplina di ancoraggio-a-episodio richiesta per il report-utente (`04-roadmap.md:105`: "ogni claim linka episodi" — richiesto lì, non ripetuto esplicitamente qui), si ricade esattamente nel pattern già rotto una volta in casa (confabulazione da SOUL_public stale, `research/a1-inventario-codebase.md §5.6`): un sistema che RACCONTA di essersi comportato in un modo plausibile invece di riportare cosa è successo davvero.
3. **Monitor anti-dipendenza** (`01-verdetti.md:132`): "volume di interazione che cresce senza esiti che crescono" — il rapporto interazioni/esiti richiede una definizione operativa di "esito" per tipo di interazione (un esito per una ricerca profonda non è lo stesso tipo di evento di un esito per un check-in serale), che il documento non dà. Senza quella definizione, il monitor è un numero che si può calcolare ma non si sa interpretare.
4. **Skill autodraft loop**: già esistente in produzione (ADR-125, `research/a1-inventario-codebase.md §4`), basso rischio a riportare.

**Cosa taglierei/semplificerei**: dividi esplicitamente il "report su di sé" in due livelli, MAI fusi: (i) aggregati deterministici SQL-only (tasso successo/tool, costo/lane/giorno, istogramma exit-type, tasso di retry) — zero LLM, zero rischio di confabulazione, spedibile subito; (ii) sintesi narrativa sopra quegli aggregati, SOLO con lo stesso vincolo "ogni claim linka uno span" già imposto al report-utente. Non spedire (ii) senza (i) sotto. Per il monitor anti-dipendenza, definisci "esito" per le 3-4 classi di interazione più comuni PRIMA di costruire il rapporto — altrimenti è un numero decorativo.

**Cosa si perde esattamente**: nulla — questo è un chiarimento di specifica, non un taglio di scope. Quello che si perde SE NON lo si fa è la garanzia che il modulo dichiarato "il differenziale" non diventi, nella metà più nuova (il report su di sé), esattamente il tipo di "sembra funzionare" che il BRIEF vieta esplicitamente (`BRIEF.md:77-88`, "Niente finto").

**Cosa costa specificarlo bene ora**: quasi nulla in più — è principalmente scrivere ESPLICITAMENTE nel DoD di M6 (`04-roadmap.md:105`) lo stesso vincolo di ancoraggio-a-episodio già imposto al report-utente, e una definizione per classe di interazione di cosa conta come "esito" prima di costruire il rapporto V13.

**Verdetto: TIENI-MA-SEMPLIFICA** (specifica, non tagli) — il modulo è costruibile, ma il DoD attuale (`04-roadmap.md:105`) non basta a impedire che la metà nuova diventi prosa plausibile invece di dato vero.

---

### Bersaglio #8 — Quattro strati di test + CI di capability live pre-merge su ogni PR `agent/*` (`05-testing-evals.md:9-22`)

`05-testing-evals.md:12` mette la CI di capability (harness live, DUE modelli veri) "pre-merge sui moduli agent/*, nightly". Questo significa: ogni volta che l'owner tocca un file sotto `agent/*` (che secondo l'albero di `04-roadmap.md:31-35` include il loop, il context assembly, i provider, i profili — cioè buona parte del cuore del sistema), il merge aspetta l'esito di scenari eseguiti DAVVERO contro due modelli (uno via API a pagamento, uno locale/consumer) prima di poter procedere.

Per un manutentore singolo che lavora a cicli serali, questo introduce due costi concreti: (a) latenza-di-merge non banale ad ogni tocco del core (chiamate LLM reali, non mock, sono per natura più lente e meno deterministiche dei test unitari — un fallimento intermittente blocca un merge che magari non c'entra nulla con la causa), e (b) doppia superficie di debug per ogni regressione ("è il modello A, il modello B, il profilo, o l'ambiente?" raddoppia il tempo di diagnosi rispetto a un singolo target).

**Cosa taglierei/semplificerei**: sposta il floor-su-due-modelli da "pre-merge" a "nightly + gate di release" (già presente come opzione nella stessa riga, `05-testing-evals.md:12`, ma indicato come "E" pre-merge, non "O"). Pre-merge resta solo il floor sul modello di riferimento PIÙ VINCOLANTE (il consumer-locale, che è anche il vero bersaglio della direttiva owner su cui progettare l'harness, `06-modelli.md:15`), non su entrambi.

**Cosa si perde esattamente**: si perde la garanzia "ogni commit sul core è già verificato su entrambi i profili" nel momento stesso del merge — una regressione sul modello frontier potrebbe restare invisibile per ore (fino al nightly) invece che minuti. Per un sistema single-user senza pressione di rilascio multi-team, questo è un ritardo di scoperta accettabile, non un rischio di produzione (nessun utente terzo è esposto nel frattempo).

**Cosa costa tenerlo com'è**: oltre alla latenza, serve una macchina/ambiente capace di eseguire inferenza locale in CI per un modello classe 20-35B — che per un progetto single-maintainer è o (i) un runner GPU dedicato da provisionare e mantenere (costo ops reale, il tipo di cosa che richiede "un team" per restare in salute), oppure (ii) l'uso di un endpoint API per il "riferimento locale" SOLO in CI (fattibile, ma allora il floor pre-merge non sta testando il vero deploy locale, indebolendo lo scopo dichiarato). Nessuna delle due opzioni è gratis.

**Verdetto: TIENI-MA-SEMPLIFICA.** Il principio (mai testare solo sul modello forte) resta; la frequenza/obbligatorietà del doppio-modello scende da "ogni PR" a "nightly + release-gate".

---

### Bersaglio #9 — Capability floor: due modelli di riferimento sempre, invece di progettare-per-il-debole e usare il forte come spot-check (`06-modelli.md:15-24`, `08-assunzioni.md:19`)

Questo è la stessa area del Bersaglio #8 vista dal lato "quale problema risolve". La direttiva owner (`06-modelli.md:17`, verbatim: "se faccio l'harness su Sonnet, poi Gemma-4 non sta dietro") è risolta nel piano con "verifica sempre su entrambi" — ma la lettura più diretta della stessa direttiva è "**progetta per il modello debole**", non "verifica simmetricamente su entrambi". Se l'harness è disegnato per passare sul modello consumer-locale (il bersaglio esplicitamente più fragile), il passaggio sul modello frontier è quasi sempre garantito per costruzione (i profili/stampelle per il modello debole — meno tool, output più rigidi — sono per definizione un sottoinsieme più permissivo di ciò che il modello forte può gestire; il contrario NON è garantito). Verificare simmetricamente su entrambi, sempre, prova due volte una cosa che nella direzione debole→forte è quasi implicata.

`06-modelli.md:24` conferma peraltro che anche solo SCEGLIERE il riferimento locale costa "un eval interno di 1-2 giorni sul floor" — prima ancora di costruire la CI che lo esegue in continuo.

**Cosa taglierei/semplificerei**: disegna e verifica il floor SEMPRE E SOLO sul riferimento consumer-locale come gate bloccante; il modello frontier-API gira come smoke-test periodico (release-gate, non per-scenario) per catturare l'unica direzione realmente non implicata (un profilo/stampella scritta per il modello debole che rompe qualcosa di specifico del modello forte — raro, ma possibile, es. su formati di tool-call specifici).

**Cosa si perde esattamente**: un caso raro ma reale — una stampella pensata per il modello debole che degrada inavvertitamente il modello forte (es. un output-format più rigido che il frontier avrebbe gestito meglio in modo più naturale) resterebbe visibile solo al prossimo smoke-test di release, non al prossimo commit.

**Cosa costa tenerlo (verifica sempre-doppia)**: il doppio costo computazionale/API per ogni scenario di ogni run (non solo pre-merge, anche nightly, `05-testing-evals.md:12`), il doppio debug quando qualcosa fallisce, e l'infrastruttura per eseguire inferenza locale in automazione continua (v. Bersaglio #8).

**Verdetto: TIENI-MA-SEMPLIFICA.** Riduci a un solo modello come gate bloccante (il debole, che è anche quello coerente con la direttiva owner letta alla lettera), l'altro come spot-check periodico.

---

### Bersaglio #10 — Renderer capability-aware / contenuto canonico strutturato per 2 connector che parlano già lo stesso formato (ADR-0016, `04-roadmap.md:88`)

`adr/0016-renderer-capability-aware.md` richiede che il gateway produca "contenuto in forma canonica strutturata (non stringhe pre-formattate)" e che un renderer per-canale scelga la resa più ricca, degradando: "UI generata/card-immagine → formattazione nativa → testo asciutto". In v1 esistono ESATTAMENTE due connector (`04-roadmap.md:118`): CLI (testo/markdown) e Telegram (markdown nativo + foto/documenti). **Entrambi parlano già markdown.** Il terzo livello della scala di degradazione (UI generata via MCP Apps) è esplicitamente post-v1 (`adr/0010-standard-esterni.md:10`).

Costruire un modello di contenuto canonico generico (tipi per tabelle, serie, card, con una mappatura per-canale) per servire DUE target che condividono già il formato di base non compra granché rispetto a "il modello scrive markdown, e ogni connector sa allegare un file immagine quando ce n'è uno" — il payoff reale dell'astrazione si materializza SOLO quando arriva un terzo connector con superficie di resa radicalmente diversa (MCP Apps), che il piano stesso rimanda. Non a caso, il segnale di rottura che l'ADR stessa dichiara (`adr/0016-renderer-capability-aware.md:11`) è: "se in pratica ogni output finisse comunque in prosa... il contratto va ripensato **prima di moltiplicare i connector**" — cioè gli stessi autori riconoscono che il test vero arriva con un terzo connector, non con due.

Non contesto la DIRETTIVA (poca verbosità, preferire rich-media — è owner-confermata, `STATE.md:6` punto 6): contesto il MECCANISMO scelto per ottenerla ora.

**Cosa taglierei/semplificerei**: v1 = il modello produce markdown (già la lingua franca di entrambi i connector) + può opzionalmente allegare UN file (immagine/documento) prodotto da un tool dedicato quando il contenuto lo giustifica (grafico, card, riepilogo visuale). Niente livello di indirezione "contenuto canonico" con capability-negotiation generica; niente registro di "render capabilities" dichiarative per connector quando ce ne sono 2 e sono quasi identiche. Costruisci il livello di astrazione quando MCP Apps (o un connector con superficie diversa) è davvero schedulato.

**Cosa si perde esattamente**: la garanzia architetturale "aggiungere un nuovo connector = dichiararne le capability, la resa arriva gratis dal contratto" (`adr/0016:9`) — con solo 2 connector oggi questo beneficio non è ancora incassabile; quando arriverà il terzo, andrà scritto un adapter per markdown→quel-formato in ogni caso (il contenuto canonico non elimina quel lavoro, lo sposta prima).

**Cosa costa tenerlo ora**: progettare uno schema di contenuto strutturato che regga "la varietà reale" (tabelle, serie temporali, citazioni, immagini, testo misto) è un problema di modellazione non banale, e il rischio dichiarato dagli stessi autori (finire comunque in prosa) è concreto proprio perché la chat conversazionale è per natura più varia di quanto un piccolo set di tipi canonici riesca a catturare senza diventare "markdown con passaggi in più".

**Verdetto: RIMANDA.** Markdown + allegato opzionale ora; contenuto canonico e capability-negotiation quando il terzo connector (o MCP Apps) è schedulato per davvero, non predisposto in astratto.

---

### Bersaglio #11 — Card-immagine via Chromium headless (`04-roadmap.md:53`, `:88`)

Il renderer Telegram prevede "card-immagine via Chromium headless se presente". Chromium headless è un processo browser completo (centinaia di MB, gestione di crash, sandboxing del browser stesso — ironico in un sistema che già sandboxa la PROPRIA esecuzione e ora dovrebbe anche gestire il sandboxing implicito di un browser) per produrre, in sostanza, un'immagine PNG di una card con testo/numeri formattati.

**Cosa taglierei/semplificerei**: per il caso d'uso dichiarato (una card leggibile con testo/numeri/struttura semplice, non una pagina web interattiva), una libreria di rendering leggera (classe SVG-to-PNG o canvas headless, senza processo browser) copre lo stesso risultato visivo senza il processo Chromium, il suo ciclo di vita (avvio/crash/riavvio), e la sua superficie di sicurezza aggiuntiva.

**Cosa si perde esattamente**: la possibilità di riusare CSS/HTML arbitrariamente complesso per il layout della card (utile se in futuro la card dovesse ospitare layout molto ricchi, es. grafici D3 come quelli già presenti nella webapp attuale, `research/a1-inventario-codebase.md §2.7`). Per "una card leggibile" (l'obiettivo dichiarato in `04-roadmap.md:91`), questa flessibilità non è necessaria.

**Cosa costa tenerlo**: un processo Chromium headless da installare, aggiornare, e far convivere con il resto del sistema mono-processo (`08-assunzioni.md:8`: "un solo processo runtime" — Chromium headless è, di fatto, un secondo processo pesante gestito dall'applicazione, in tensione diretta con l'invariante dichiarata due righe più sopra nello stesso documento).

**Verdetto: TAGLIA.** Sostituisci con una libreria di rendering leggera senza processo browser; è coerente con l'invariante "un solo processo" che il piano stesso dichiara altrove e riduce una dipendenza pesante per un output visivo semplice.

---

### Bersaglio #12 — Adozione della piena macchina OTel (SDK+span+exporter) per un sistema a telemetria-esterna-zero (`04-roadmap.md:60`, `adr/0010-standard-esterni.md:14`)

Adottare la CONVENZIONE di naming `gen_ai.*` (per interoperabilità futura, se mai servirà) è a buon mercato e la tengo. Costruire sopra la convenzione l'intera macchina SDK OTel (span, context-propagation attraverso i confini async di Node, exporter) è un impegno più pesante, giustificato principalmente quando esiste un consumatore ESTERNO di quei dati (un collector, un backend di osservabilità). `03-threat-model.md:97` dichiara esplicitamente "telemetria esterna: nessuna, mai, di default" — l'unico consumatore dei trace è l'owner stesso, via query SQL locali (`03-threat-model.md:81`: "'perché hai fatto così' = query sui trace"). Per un consumo puramente locale via SQL, righe di log strutturate con gli stessi nomi di campo `gen_ai.*` in una tabella SQLite ottengono la stessa interrogabilità della piena istrumentazione OTel, senza il costo di imparare/mantenere l'SDK e senza esporsi ai breaking change di una spec "interamente Development" (`adr/0010:3`) sull'intera superficie SDK invece che solo sui nomi dei campi.

**Cosa taglierei/semplificerei**: adotta i NOMI dei campi (`gen_ai.*`) come schema delle righe in `traces`/`agent_logs` (già tabelle esistenti secondo A1); non importare l'SDK OTel completo finché non esiste un motivo concreto di esportare verso un collector esterno.

**Cosa si perde esattamente**: interoperabilità immediata con strumenti di osservabilità di terze parti (Jaeger, Grafana Tempo, ecc.) se l'owner un giorno volesse collegarne uno — oggi non dichiarato come bisogno.

**Cosa costa tenerlo (SDK completo)**: superficie di dipendenza aggiuntiva (span context che deve propagare correttamente attraverso ogni `await`/callback del loop, un errore comune e sottile in Node), e un punto di rincorsa in più sui breaking change di una spec ancora tutta "Development" (`adr/0010:3`) — l'isolamento dichiarato ("un solo punto di rincorsa", `adr/0010:14`) mitiga ma non elimina il costo di manutenzione.

**Verdetto: TIENI-MA-SEMPLIFICA.** Schema/naming sì da subito (gratis, futuro-proof); SDK/exporter pieno solo quando un consumatore esterno reale lo richiede.

---

### Bersaglio #13 — Client MCP generico con allowlist-UX day-1 (ADR-0010, `04-roadmap.md:81`)

`research/a1-inventario-codebase.md:64` conferma che `@modelcontextprotocol/sdk@^1.27.1` è **già** una dipendenza del Muffin attuale — quindi non si parte da zero sul client MCP in senso stretto. Quello che il piano aggiunge è una UX generica di scoperta/allowlist ("owner · primo uso di un server (chiede)", `04-roadmap.md:85`) pensata per un numero imprecisato di server MCP futuri, quando oggi l'owner non ha una lista dichiarata di server MCP di terzi che vuole collegare (il caso reale noto è un uso mirato, tipo GitHub).

**Cosa taglierei/semplificerei**: v1 = supporto al PROTOCOLLO MCP per i server concretamente in uso (pattern "un server dichiarato in config, funziona"), senza costruire il flusso UX generico di scoperta-e-richiesta-di-consenso-al-primo-uso finché non esiste un secondo caso reale che lo giustifichi (l'owner che vuole aggiungere un server MCP di terzi non ancora noto).

**Cosa si perde esattamente**: la fluidità "aggiungo un server MCP e Muffin me lo chiede da solo" per server non ancora previsti — nella pratica, oggi, l'owner aggiungerebbe comunque un server nuovo editando la propria config (coerente con "la configurazione la imposto usando Muffin" ma solo quando il flusso conversazionale esiste davvero).

**Cosa costa tenerlo ora**: una UX di allowlist-al-primo-uso (dialogo di conferma, persistenza della scelta, gestione del "server rimosso poi ri-aggiunto") costruita per un catalogo di server che, per l'owner-singolo di oggi, è vuoto o quasi.

**Verdetto: RIMANDA** (la UX generica di scoperta/allowlist); **TIENI** (il supporto al protocollo per i server già in uso, che è già in gran parte pagato).

---

### Bersaglio #14 — Il costo del "ripartire da zero" come sistema separato (M0→M7) contro l'evidenza di convergenza già in casa (`00-findings.md:151`, `research/a1-inventario-codebase.md:487-488`)

Questo è il bersaglio più grande e quello su cui sono più opinionato, e tocca direttamente la domanda ostile #9. `00-findings.md:151` registra la tensione onestamente: un audit interno del 2026-07-16, **19 giorni prima** dell'apertura di questo blueprint, con un mandato quasi identico ("controlla Muffin in tutto e per tutto... cosa va sostituito da librerie, cambiato, tolto, rifattorato") e 7 scout paralleli + una misura EVAL-NG, ha concluso testualmente: *"La direzione (ADR-156, due gambe pari, CLI-first, kernel-enforcement) è confermata da dentro, da fuori e dalla storia — non serve un redesign, e quasi niente va sostituito da librerie"* (`research/a1-inventario-codebase.md:488`). L'owner ha comunque confermato al checkpoint (`STATE.md:6`, punto 1) "riparti-da-zero sul design" — decisione che rispetto e non ridiscuto come tale.

Quello che attacco è la conflazione, nella roadmap (`04-roadmap.md §1-2`), tra "riparti da zero SUL DESIGN" (ri-derivare ogni scelta con evidenza — lavoro già fatto, è la Fase B) e "riparti da zero SULL'IMPLEMENTAZIONE" (un secondo albero di cartelle `muffin/core|agent|memory|...` costruito in parallelo al sistema che oggi gira e serve l'owner ogni giorno, con un cutover a fine percorso). La tabella keep/change/kill (`00-findings.md §2`, approvata da owner per `STATE.md:6` punto 5) segna KEEP per: filosofia due-gambe, principio inferenza-non-configurazione, CLI-first runtime, loop unificato, property graph bi-temporale, embedding locale, recall ibrido FTS5+vec, HITL a 3 livelli + tier-2, scope-on-data leak-proof, SQLite+soft-delete, deploy systemd, replay harness, rito flag-lifecycle. **Sono 13 dei 32 elementi della tabella KEEP as-is** — cioè il design nuovo, per sua stessa ammissione, riconferma quasi la metà di ciò che già esiste, e le voci CHANGE (LLM stack, pipeline estrazione, dream cycle, tool registry, task agent, context layering) sono per lo più affinamenti, non sostituzioni concettuali.

Il costo concreto di costruire questo come sistema PARALLELO invece che come patch incrementale al sistema esistente: (a) ogni pezzo KEEP va comunque riscritto una volta (nel nuovo albero) prima di poter essere riusato, anche se la logica non cambia; (b) fino al cutover, l'owner ha DUE sistemi da capire (quello vecchio che gira in produzione, quello nuovo in costruzione) — la peggior condizione possibile per un manutentore singolo part-time; (c) il valore nuovo reale (provenienza/taint, bi-temporale-light, kernel unificato — Bersagli #2-5 sopra) potrebbe essere portato nel sistema ESISTENTE con migrazioni additive (`ALTER TABLE ... ADD COLUMN`, coerente con lo stile di migrazione già in uso in casa, `docs/pitches` e ADR incrementali citati in A1) molto prima che M0-M2 del sistema parallelo siano pronti.

**Cosa taglierei/semplificerei**: separo esplicitamente due tracce con owner-in-copia su entrambe — (1) una traccia "retrofit": le 3-4 idee genuinamente nuove e ad alto valore (provenienza/trust_tier come colonne additive, taint nel kernel esistente, verifica che il sandbox sia vivo sul VPS, self-report introspettivo bolt-on al dream cycle esistente) portate DIRETTAMENTE nel repo che gira oggi, misurabili in giorni non mesi; (2) una traccia "rewrite dei god-file" (gateway.ts, gateway_group.ts, callChat) che ESISTE GIÀ come lavoro riconosciuto e parzialmente in corso (`research/a1-inventario-codebase.md §11.3`, ADR-152/154) e continua sul proprio binario, senza bisogno di un nuovo albero `muffin/` a fianco. Il "blueprint" resta il documento di riferimento per QUALI decisioni prendere, non necessariamente per DOVE il codice deve fisicamente vivere.

**Cosa si perde esattamente**: la pulizia di un repo nuovo senza 150 ADR storici e senza i file da 2.800+ righe da decomporre — un vantaggio reale per la leggibilità a lungo termine e per la storia pubblica del progetto open source. Si perde anche parte della disciplina "ogni scelta va rigiustificata" se il codice resta quello vecchio: è più facile rigiustificare su carta che a codice fermo.

**Cosa costa tenerlo (rewrite parallelo completo M0→M7)**: sulla base della sola complessità di M0 (Bersaglio #1: provisioning cross-platform utente-separato) e M1 (CI a doppio modello, Bersaglio #8-9), stimo — **giudizio ingegneristico, non misura** — che M0+M1 da soli, fatti bene e testati su macOS e Linux, valgano diverse settimane piene di un singolo sviluppatore serale anche PRIMA di arrivare a M2 (memoria, il primo modulo con valore quotidiano visibile). Con un budget di 4 settimane di sere (la domanda ostile #9), il piano M0→M7 come sequenza non raggiunge nemmeno M2 completo.

**Verdetto: TAGLIA la premessa "secondo albero parallelo per tutto"; TIENI la sequenza di DECISIONI (ADR, schema, kernel) come riferimento per un retrofit incrementale del repo esistente**, riservando un vero "nuovo repo pubblico" al momento in cui (a) il retrofit ha dimostrato le idee nuove sui dati reali dell'owner, e (b) la decomposizione dei god-file (già in corso per conto suo, A1 §11.3) è avanti abbastanza da non dover essere rifatta due volte.

---

## 3. Il piano minimo vero

Ordine di costruzione, con la giustificazione di ogni esclusione. Presuppone la traccia "retrofit" del Bersaglio #14 come raccomandazione primaria; se l'owner conferma comunque il secondo-albero-parallelo nonostante Bersaglio #14, la stessa lista di priorità si applica a M0-M2 di quell'albero, nello stesso ordine.

1. **Provenienza + trust_tier come colonne additive su episodi/fatti esistenti.** È il differenziale #2 dichiarato (`00-findings.md:13`), costa colonne (a schema-zero-rottura) più un punto di scrittura obbligato nella pipeline di estrazione. Nessun kernel nuovo richiesto per iniziare a raccoglierlo.
   *Escluso per ora*: l'intera tassonomia di propagazione formale del taint attraverso ogni tipo di blocco di contesto (03§2) — inizia con "etichetta sul dato", aggiungi le regole di propagazione quando la prima azione realmente pericolosa (M7, gruppi) è vicina.

2. **Kernel come funzione binaria (owner-fidato / no) innestata sulle zone HITL già esistenti**, non come nuovo sistema a 3 colonne (Bersaglio #5). Chiude la maggior parte del valore di sicurezza dichiarato con un cambiamento locale, non un modulo nuovo.
   *Escluso per ora*: capability-declaration formale a 4 campi per ogni tool (rischio/risorse/taint-massimo/reversibilità) — un campo `trusted-only: bool` per tool copre oggi lo stesso esito.

3. **Verifica e correzione del sandbox sul VPS reale** (bubblewrap installato, `SANDBOX_ENABLED` non più no-op — `research/a6-brain-hands-sandbox.md:5-6` lo segnala già come "primo controllo concreto"). È, con margine, il rapporto valore/costo più alto di tutto il blueprint: chiude un gap di sicurezza REALE e già diagnosticato con un intervento infrastrutturale, non con un redesign.
   *Escluso per ora*: doppio layer TLS-inspection, sub-agent isolation assiale, modalità strict — già correttamente rimandati dal piano stesso (`08-assunzioni.md:31`, `adr/0018:7`).

4. **Modello dati uni-temporale con supersede-chain** (recorded_at/expired_at, set-valued di default) + giudice LLM one-shot senza apparato-soglia (Bersagli #3, #4). Risponde già al DoD di M2 dichiarato (`04-roadmap.md:77`) senza costruire il classificatore "query storica" né l'eval-a-soglia dedicata.
   *Escluso per ora*: valid_from/valid_to popolati e sfruttati nel recall, eval dedicata del giudice con soglia di attivazione — costruiscili dopo aver rigiocato la migrazione (§8) e guardato i numeri reali.

5. **Chiusura della decomposizione già in corso di `gateway.ts`/`callChat`** (primitivi Agent/Runner/Guardrails, `research/a1-inventario-codebase.md §11.3`) — è lavoro riconosciuto, parzialmente fatto, ad alto valore di manutenibilità futura, e non richiede un nuovo albero di repo per procedere.
   *Escluso per ora*: `src/runner/` generico (già costruito e già rimosso una volta per essere orfano, stesso paragrafo) — non ricostruirlo preventivamente.

6. **Self-report introspettivo come nuova fase bolt-on sul dream cycle esistente**, SOLO aggregati deterministici (tasso successo/tool, costo/giorno, exit-type) per iniziare (Bersaglio #7, parte 2). Il report-utente (Living Profile/Counterpoint) è già production-proven e non va ricostruito da zero, solo riadattato allo schema nuovo di provenienza.
   *Escluso per ora*: sintesi narrativa LLM del report-su-di-sé, canary automatico del cricchetto, monitor anti-dipendenza senza definizione di "esito" — nell'ordine, finché non c'è un motivo misurato per ciascuno.

7. **Ratchet come "proposta + diff in chat + owner approva"** (Bersaglio #6), riusando lo stesso pattern PR-review già costituzionale nel progetto per il codice, applicato a voice/prompt/soglie. Zero infrastruttura di monitoring nuova.
   *Escluso per ora*: canary a finestra con revert automatico su metriche live — richiede baseline che non esistono ancora e un volume di proposte che un owner singolo non genera abbastanza in fretta da giustificarlo.

**Cosa cade esplicitamente, e perché è giusto che cada in questa finestra**: RoT a utente-OS-separato con boot-refusal (nessuna capability runtime lo raggiunge finché il punto 7 non matura); identità cross-connector proposed/confirmed (nessuna ambiguità possibile con un solo connector remoto); renderer capability-aware con contenuto canonico (due connector, stesso formato); client MCP generico con UX di scoperta (nessun catalogo di server di terzi dichiarato); community e le sue fondamenta oltre `tenant_id` come stringa; CI di capability a doppio-modello pre-merge (nightly/release basta); Chromium headless (una libreria di rendering leggera copre lo stesso output); piena macchina SDK OTel (lo schema di naming basta finché il consumatore è solo l'owner via SQL). Nessuno di questi pezzi è sbagliato nel merito — sono tutti pezzi che pagano il loro costo SOLO quando la condizione che li giustifica (un secondo connector, un cricchetto che ha già proposto 50 volte, un catalogo di server MCP di terzi, un volume di traffico che il kernel a 3 colonne inizia davvero a distinguere) è vera. Costruirli prima è pagare l'assicurazione prima che esista il rischio che assicurano.
