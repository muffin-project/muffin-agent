# Eventi, workspace e contesto — istruttoria dei cinque bivi

**Data**: 2026-08-15 · **Per**: la richiesta owner su liste spuntabili, workspace
editabile, «processo sempre in attesa di eventi», e «cosa finisce in contesto e
cosa via tool» · **Base**: `origin/dev` @ `1ad1b48` · **Metodo**: ogni
affermazione riportata qui è stata verificata leggendo il file e il numero di
riga citato, su questo checkout, oggi. Dove una fonte interna afferma un
`file:riga` che non ho riverificato, lo dico. Dove non esiste evidenza, la
domanda va in §«Cosa non si è potuto stabilire» e non riceve un'opinione.

**Cosa questo documento non è**: non è un ADR, non propone di costruire niente
adesso, e non chiude nessuno dei cinque bivi. Istruisce i bivi perché li decida
l'owner.

---

## Bottom line

1. **I tre piani reggono, ma il confine fra vault e workspace non è un percorso —
   è un atto.** La regola che l'owner cercava è già ratificata e dice l'opposto
   della sottocartella: *«le directory sono convenzione, non semantica … una
   cartella non è mai un permesso»* (`confronto-gemini.md §17`). E il vault non
   vieta che una lista parli di te: vieta di **minare il file** per estrarne
   credenze (`core/vault/vault.ts:25-30`). Una casella spuntata non è il file: è
   una **transizione con un parlante attaccato**, che è esattamente la forma che
   quel commento dichiara legittima. Il file resta documento; la transizione
   diventa evidenza. Nessun `vault/tuo`, e nessuna migrazione di schema (§T2).

2. **Il bus si può costruire, e non è la cosa che fu respinta — ma la sveglia è
   un'altra domanda, e oggi la risposta è no.** Ciò che `§15` respinge è
   Redis/NATS e il multi-processo, con motivazione esplicita: *«pagheremmo un
   broker e una classe di guasti nuova per coordinare processi che abbiamo deciso
   di non avere»*. Una tabella SQLite in-processo non paga né il broker né i
   processi, quindi la ragione scritta **non la raggiunge**. Di più: `STATE.md:202`
   elenca *«event-bus soglia→consolidamento»* fra i tre residui di M5, e
   `knowledge/03-observing-spine.md:26` **pretende** che lo Stadio 1 sia
   *«event-driven (non a orologio)»*. Il bus non è un'idea esterna: è un
   deliverable nostro non costruito. Quello che va tenuto chiuso non è il bus, è
   **chi ha il diritto di svegliare l'agente**.

3. **Sul workspace non si può costruire niente prima del registro di undo, e il
   registro va giustificato dal diff, non dall'undo.** Oggi l'agente **non può
   scrivere un file, per niente**: `fs.write` è `medium` + `undoable`
   (`agent/tools/fs.ts:52-58`), il kernel emette `draft`
   (`core/policy/decide.ts:197-198`) e il loop lo rifiuta
   (`agent/loop.ts:656-666`). Ma `§19` porta il numero che uccide il registro
   generico: nel vecchio Muffin `undo_log` ha **zero righe in quattro mesi** col
   tier acceso di default. La via d'uscita è non giustificarlo con l'undo: il
   **diff** è simultaneamente il payload dell'evento (bivio 1), la risposta di
   `muffin vault check`, e il revert. Un meccanismo, tre usi, e solo uno dei tre
   deve risultare popolare.

**Il numero che riorienta tutto il resto**: l'insieme chiuso dei trigger non
rischia di allargarsi — è **vuoto per quattro quinti**. `ProactiveKind` dichiara
cinque `kind` (`core/scheduler/proactivity.ts:44-64`) e solo `gone_quiet` ha un
produttore (`core/scheduler/observe.ts:109`). `commitment_due`, `deadline_near`,
`fact_actionable` e `consolidation` esistono nel tipo e in nessun altro posto —
verificato con grep su tutto `core/`, `agent/`, `cli/`. Il primo lavoro di un bus
non è aggiungere `kind`: è **produrre i quattro che abbiamo già dichiarato**, che
è alla lettera il punto (3) dei residui di M5 in `STATE.md:202`.

---

# Parte I — la parte concettuale

## Bivio 1 — I tre piani reggono sul nostro codice?

### Cosa esiste, piano per piano

**Memory — esiste, ed è il più forte dei tre.** Tre sottopiani già separati in
schema (`core/memory/schema.ts:1-23`): evidenza (`episodes`, append-only), grafo
(`entities`/`identities`/`facts`, bi-temporale), derivato (`profiles`,
`digests`). L'invariante è scritta: butta il derivato, rigioca gli episodi, e sei
dove eri.

**Workspace — non esiste come piano.** Esiste una cartella: `~/.muffin/vault/`,
e di fatto solo `inbox/` viene creata (`cli/surface.ts:206`). La sottostruttura
`notes/ research/ artifacts/ tmp/` è stata **adottata** in `confronto-gemini.md
§17` e non è costruita. E c'è uno scollamento che nessuno ha ancora nominato: i
tool `fs_*` hanno per radice `cwd` (`agent/runtime.ts:151`), **non** il vault.
Oggi «i file dell'agente» e «i file del vault» sono due cose diverse che non si
incontrano mai.

**Runtime/Event — deciso e non costruito.** Lo scheduler esiste
(`core/scheduler/scheduler.ts`) ma il suo unico battito è un
`setInterval(..., 30_000)` dentro `cli/repl.ts:123`, e quello è l'**unico** sito
di costruzione di uno `Scheduler` nel repo. ADR-0035 ha deciso il processo di
lunga vita; non è costruito. `SchedulerEvent`
(`core/scheduler/scheduler.ts:51-55`) è l'unico tipo «evento» esistente: è una
callback sincrona in memoria, non persistita, con un solo consumatore che tratta
solo `delivery_failed` (`cli/repl.ts:118-122`).

**Verdetto sulla tripartizione**: regge come *lente*, non come istruzione di
costruzione. Due dei tre piani sono già lì e il terzo è già deciso altrove. Il
valore della proposta esterna non è il terzo piano — è aver messo il dito sul
fatto che **il workspace oggi non ha un posto**.

### Dove passa il confine, senza la sottocartella bocciata

La frase del vault che crea il conflitto va letta esatta
(`core/vault/vault.ts:25-30`):

> *documents are indexed for **recall**, never mined for facts … If something in
> a note should become a belief, the owner says it in conversation and it arrives
> as evidence with a speaker attached.*

Non dice «un file non può parlare di te». Dice due cose: (a) non si **mina** il
file, (b) una credenza arriva **con un parlante attaccato**. Quindi il confine
non è documento-contro-lista. È **contenuto contro transizione**:

| oggetto | cos'è | dove vive | minabile? |
|---|---|---|---|
| il file `film-da-vedere.md` | documento | `episodes kind='document'`, come oggi | **no**, mai |
| «*Dune*: da vedere → visto, dall'owner, alle 21:04» | transizione | un episodio nuovo, con parlante e ora | sì, è evidenza normale |

Sono due oggetti nella stessa cartella, e la sottocartella era l'asse sbagliato
perché avrebbe dovuto rispondere alla domanda «questo è minabile?», che è un
**permesso** — e `§17` ha già stabilito che una cartella non è mai un permesso.
L'owner ha rifiutato `vault/tuo` con un *«che nome sarebbe? nah»*, e aveva
ragione per un motivo che il codice già scrive.

- **Pro**: nessun piano nuovo, nessuno store nuovo, nessuna migrazione del vault,
  nessuna cartella-permesso. La transizione entra in `episodes` come è oggi
  (§T2 mostra che costa **zero** migrazioni). E soddisfa la regola del vault alla
  lettera invece che per deroga.
- **Contro**: bisogna calcolare un diff al salvataggio, che è lavoro vero
  (bivio 5); e bisogna decidere chi ha il diritto di dire «questa transizione
  l'ha fatta l'owner» (bivio 3, ed è il punto duro di tutto il documento).
- **Raccomandazione**: adottare contenuto-contro-transizione. Costruire la
  sottostruttura di `§17` come pura convenzione. **Non** creare un terzo piano.

---

## Bivio 2 — `MuffinEvent`/`MuffinBus`: che forma esatta?

### Cosa fu respinto davvero, e cosa no

Tre rifiuti scritti, e vanno separati perché non colpiscono la stessa cosa:

1. `confronto-gemini.md §15`: *«L'event bus (Redis/NATS) … pagheremmo un broker e
   una classe di guasti nuova per coordinare processi che abbiamo deciso di non
   avere. RESPINGI.»* — l'asse è **broker esterno + multi-processo**.
2. `§22`: *«Global Workspace / moduli paralleli su event bus»* → RESPINGI, *«è
   l'event bus di §15 con un'etichetta cognitiva»* — l'asse è **moduli
   paralleli**, cioè di nuovo la concorrenza.
3. ADR-0022 respinge i processi separati perché *«pagheremmo IPC,
   serializzazione e un secondo punto di fallimento»*.

Nessuno dei tre raggiunge una tabella SQLite in-processo con **un solo
consumatore**. Lo dico come conclusione stabilita, non come cavillo: la ragione
scritta è ogni volta il *processo*, e qui non c'è un secondo processo. Va però
detto esplicitamente in qualunque decisione futura, perché il verdetto di `§15`
com'è scritto non distingue i due casi e verrà citato contro.

E c'è il verso opposto, che è più forte del permesso: **il bus è già nostro
lavoro arretrato.** `STATE.md:202` elenca fra i residui di M5 *«(2) event-bus
soglia→consolidamento (consuma il conteggio episodi della memoria)»*, e
`knowledge/03-observing-spine.md:26` pretende uno Stadio 1 *«cheap,
deterministico, event-driven (non a orologio) … aggiornato quando succede
qualcosa»*. Oggi lo Stadio 1 non è né a orologio né a eventi: è **a mano**
(`cli/observe.ts:186` è l'unico chiamante di `observe`).

### La forma: un log con un consumatore, non un bus con molti

Il pattern esiste già in casa, costruito e testato, e la sua docstring è la
migliore specifica che potremmo scrivere: `connectors/telegram/updates.ts:12-24`
— scrivi l'evidenza, **poi** avanza l'offset, poi elabora; chiave primaria che
assorbe il duplicato; `markFailed` che registra il motivo e **lascia la riga
pending** (`updates.ts:146`), così un riavvio riprova.

Quindi `MuffinBus` non è una tecnologia nuova: è `telegram_updates` generalizzato
a più sorgenti. Il rischio è il contrario di quello temuto — non che il bus sia
troppo, ma che nasca **accanto** a quello esistente invece di sussumerlo, e ci
ritroviamo due registri di «già fatto», che è la domanda che `12-casi-uso-primitive.md:58-60`
dice essere la prima che fa il judge.

**Chi pubblica**: solo produttori in-processo che portano un principal
autenticato. Mai il modello — se un tool potesse pubblicare, il modello
scriverebbe la propria sveglia. Mai un tenant remoto.

**Chi consuma**: uno solo, il runtime, sul tick che già esiste. Niente
sottoscrizioni, niente fan-out: il fan-out è la parte che `§22` respinge, e non
ci serve per niente di quello che l'owner ha chiesto.

### L'innesto su `decideProactive` senza allargare l'insieme chiuso

Qui la risposta è più semplice di quanto sembrasse, per via del numero della
bottom line: **quattro dei cinque `kind` non hanno un produttore.** Quindi
l'innesto corretto non aggiunge niente all'enum — lo **riempie**:

- `consolidation` ← il conteggio di `episodes.extraction_v` supera la soglia. È
  letteralmente l'item (2) dei residui di M5.
- `commitment_due`, `deadline_near` ← i signal-detector, che sono l'item (3)
  degli stessi residui.

E per la richiesta dell'owner («al salvataggio arriva un event a Muffin») c'è una
seconda cucitura, che è quella che evita di toccare `ProactiveKind` del tutto.
ADR-0028 dichiara due modi in cui Muffin parla per primo: **(1) ciò che gli è
stato chiesto esplicitamente** (job, reminder) e (2) un segnale forte. Un job
armato dall'owner il cui orologio è un predicato invece di un cron **cade in
(1), non in (2)**: non è proattività inferita, è una cosa che l'owner ha chiesto,
con una sveglia diversa. `12-casi-uso-primitive.md:69-73` ha già deciso questa
forma — al job store si aggiunge un `trigger` che è `cron` **oppure** `event`,
dove `event` è un **insieme chiuso** di predicati.

Quindi: `decideProactive` non si tocca, e la lista dei predicati di job è un
secondo insieme chiuso, con la stessa disciplina.

### Cosa succede al taint

Il precedente esiste ed è quello giusto: il connector Telegram passa a
`reindex()` un `defaultTier` **derivato dal mittente autenticato**
(`connectors/telegram/connector.ts:356`). Il tier non viene dal file: viene da
**chi**, su una superficie che sa autenticare.

Applicato agli eventi:

| origine dell'evento | tier | cosa succede già oggi, senza regole nuove |
|---|---|---|
| owner che salva dalla Dashboard, sessione autenticata | 0 | tutto permesso secondo la matrice normale |
| una mail | 2–3 | `decideProactive` **nega** a tier > 1 (`proactivity.ts:95-97`); e `defaultMaxTaint.medium = 1` (`defaults/rot/policy.json`) blocca già ogni scrittura |
| un file che *compare* nella cartella, senza scrittore autenticato | **non asseribile** | qui non c'è regola, ed è il buco vero |

Il punto che conta: **la mail non è il pericolo.** Una mail avvelenata arriva
tier 2/3 e incontra due cancelli che esistono già e sono testati. Il pericolo è
il **file non attribuibile**, perché per dargli un tier bisognerebbe *indovinare*,
e un tier indovinato che parte da 0 è esattamente il lavaggio che
`core/vault/vault.ts:219-227` esiste per impedire (*«Trust never rises on
reindex, and it follows the content rather than the path»*).

- **Pro**: durabilità e dedup li abbiamo già scritti una volta; il bus chiude tre
  residui dichiarati (M5 punti 2 e 3, Stadio 1 event-driven); non allarga nessun
  insieme chiuso; il taint di un evento ha già la sua regola nel precedente
  Telegram.
- **Contro**: è un secondo registro «già fatto» accanto a `proactive_fires` se
  non lo si progetta per sussumerlo; ADR-0022 ha un **segnale di reversibilità
  che questa richiesta sfiora** (vedi sotto); e un `type` a stringa libera
  ricostruirebbe il firehose che ADR-0028 ha reso incostruibile.
- **Raccomandazione**: **costruire il log, non la sveglia.** Gli eventi atterrano
  durevolmente e sono leggibili; il consumatore è uno; l'unica cosa che può
  *agire* su un evento è un job armato dall'owner con un `trigger` da insieme
  chiuso. `decideProactive` resta intatto e il suo primo lavoro è produrre i
  quattro `kind` che abbiamo dichiarato e mai prodotto.

### ⚠️ Il rail che la Dashboard tocca, e va detto adesso

ADR-0022 dichiara il proprio segnale di falsificazione: *«un secondo consumatore
del DB che nasce fuori dal runtime (**una webapp**, un secondo agente) — a quel
punto il confine di processo diventa reale e va disegnato, non subìto»*.

La Dashboard che l'owner immagina **è** una webapp. Se apre `muffin.db`, ADR-0022
è falsificato dal proprio criterio e il confine di processo va ridisegnato prima
di qualunque altra cosa. Se invece scrive **solo file** e il runtime resta l'unico
scrittore del DB, ADR-0022 regge intatto.

Da cui un rail che costa niente enunciare adesso e moltissimo scoprire dopo:
**il file è l'interfaccia; la Dashboard non apre mai il database.** È anche
coerente con l'invariante del vault (i file sono la fonte, l'indice è derivato):
la Dashboard scrive alla fonte, e l'indice si riallinea da sé.

---

## Bivio 3 — Il watcher sul filesystem

### La scoperta che cambia la domanda: forse non serve un watcher

Il rilevamento delle modifiche **esiste già**, ed è deterministico e per
contenuto. `Vault.reindex()` (`core/vault/vault.ts:177`) calcola `hashOf(text)`
(sha256 troncato, `:369`), lo confronta con l'hash dell'episodio esistente
(`:210-217`) e classifica added/updated/unchanged/removed. `audit()` fa lo stesso
per dire cosa è divergente.

Cosa manca non è il rilevamento: è **un chiamante periodico**. I soli chiamanti
di `reindex()` sono comandi CLI a mano (`cli/vault.ts:36`, `:64`) e il connector
Telegram alla ricezione di un media (`connectors/telegram/connector.ts:356`).
Nessun job, nessun tick.

- **Pro del poll sul tick**: nessuna dipendenza nuova (il repo ne ha nove, e la
  prassi §1 chiede di giustificarne ognuna); nessuna classe di guasti inotify —
  esaurimento descrittori, tempeste di rename, volumi di rete, eventi persi al
  riavvio; deterministico e rigiocabile; riusa un confronto già testato; e
  degrada bene, perché un tick perso non è un evento perso, è un evento più
  tardi.
- **Contro**: latenza fino a un tick (oggi 30 s); una modifica fatta e disfatta
  dentro il tick non produce evento — probabilmente corretto, ma è una scelta da
  dichiarare; e costa un hash per file per tick (la docstring lo prevede già:
  *«Unchanged files cost one hash»*, `vault.ts:173`).
- **Raccomandazione**: **poll prima, watcher mai finché il poll non fa male
  misurabile.** Se un giorno servirà, il trigger è un numero (latenza percepita
  come rotta, o costo di hash misurato), non un'intuizione.

### Cosa serve nel threat model prima di accenderlo — e la riga che lo vieta oggi

`03-threat-model.md §4(e)` dice, dei file importati nel vault: *«il contenuto
entra nel recall come dati etichettati; mai eseguito, **mai fonte di trigger**»*.

Trasformare un salvataggio in un evento fa dei file del vault esattamente una
fonte di trigger. Quindi **la riga che serve non è un capitolo nuovo: è un
emendamento a (e), o una contraddizione dichiarata.** Non c'è una terza via, e
questo è il fatto più netto del documento.

Il capitolo che manca, detto stretto, non è «sorgenti in ingresso» in generale:
è **l'attribuzione di autore a una modifica del filesystem.** Oggi il tier si
deriva da un mittente autenticato (Telegram) o da un flag umano (`--tier` su
`muffin vault add`). Una directory non ha né l'uno né l'altro, e questi quattro
casi sono **indistinguibili** per chi guarda solo il filesystem:

1. l'owner che scrive nel suo editor;
2. iCloud/Dropbox che sincronizza una modifica fatta altrove, o da qualcun altro;
3. un `git pull` o un'altra applicazione;
4. **l'agente stesso**, la cui scrittura tornerebbe indietro come «segnale
   sull'owner» — che è un ciclo di auto-conferma, la forma che
   `agent/observe-run.ts:55-67` ha già evitato una volta passando `memory:
   undefined` perché *il nudge non diventi la propria evidenza*.

La forma che rispetta `§4(e)` quasi per intero, e che raccomando come postura di
partenza: **solo le modifiche che arrivano attraverso una superficie autenticata
diventano eventi** (la Dashboard con la sua sessione, che sa *chi*). Le modifiche
**trovate da una scansione** non generano niente: aggiornano l'indice, che è
precisamente ciò che il sistema fa già oggi. Così `§4(e)` resta vero per i file
trovati, e l'emendamento riguarda solo il canale autenticato — che è una frase
piccola e difendibile invece di un capitolo intero.

Resta comunque non coperto, e non lo copre questo documento, il caso di
`12-casi-uso-primitive.md:116-119`: *«una mail avvelenata che arriva da sola alle
7 del mattino, mentre nessuno guarda»*. Va scritto prima di accendere sorgenti
in ingresso che non siano l'owner stesso.

---

## Bivio 4 — La context policy senza un classificatore

### Le sette classi contro il nostro codice

| # | Classe proposta | Meccanismo qui | Deterministico? | Verdetto |
|---|---|---|---|---|
| 1 | Always Context | `buildSystemPrompts` (`agent/context/assemble.ts:125-192`), a boot, ordine fisso, prompt owner pinnato a sha256 nel test | sì, totalmente | **ha casa** — ma vedi il buco sotto |
| 2 | Context When Relevant | recall (`core/memory/recall.ts:160-268`), RRF K=60, taglio posizionale | sì per la fusione, **no** per il taglio finale | **ha casa, col nome sbagliato** |
| 3 | Retrieve On Demand | `memory_search` + `fs_read` | sì | **ha casa** |
| 4 | Tool Required | `visibleTools(...).slice(0, maxToolsExposed)` (`agent/loop.ts:290-293`) | sì | **ha casa**, con un difetto noto |
| 5 | Workspace Artifact | niente: tutto atterra in `inbox/` | — | **nessuna casa** |
| 6 | Memory | `facts`/grafo | sì | **ha casa** |
| 7 | Ephemeral | `compactToolResults` (`agent/context/compact.ts:58-117`), 60.000 caratteri, dal più recente, esenzione `keepResult` | sì, la cosa più deterministica del path | **ha casa** |

Cinque su sette hanno un meccanismo. Una (5) è la classe che **serve davvero**
alla richiesta dell'owner ed è la sottostruttura adottata in `§17` e mai
costruita. Una (2) è un nome che, preso alla lettera, richiederebbe un
classificatore.

### I tre buchi che il confronto fa emergere, e che nessuno aveva scritto

- **Non esiste un «always context» per i fatti.** `spotlight.ts` ha il nome che
  suggerisce il pinning, ma è **spotlighting anti-injection**: recinta il testo
  non fidato con un nonce (`core/memory/spotlight.ts:48-59`). Non seleziona
  niente. Quindi il nome dell'owner arriva al modello solo se il messaggio
  corrente ci somiglia lessicalmente o semanticamente. Questo è un buco vero, e
  la classe 1 lo copre solo per persona/identità/voce/skill/regole.
- **Non si contano i token, in nessun punto del sistema.** Tutti i budget sono
  caratteri (`TOOL_RESULT_BUDGET_CHARS = 60_000`, `agent/loop.ts:56`) o conteggi
  di elementi (40 turni, `agent/loop.ts:62`; `limit = 8` sul recall). Nessun
  budget totale, nessun ordine di priorità su cosa cade per primo. Una context
  policy che promette di governare la finestra non si può appoggiare su un
  sistema che la finestra non la misura mai: **è un prerequisito, ed è piccolo.**
- **Il taglio del recall non ha soglia.** È solo posizionale
  (`recall.ts:254-267`): otto risultati deboli entrano lo stesso, a 400 caratteri
  l'uno, e **alzano il taint del turno** (`agent/loop.ts:269-270`) per quanto
  debole fosse la corrispondenza.

### La regola che tiene fuori il classificatore

La classe di un oggetto deve essere **proprietà di dove sta e di chi l'ha
scritto, mai di cosa dice.** Percorso, `kind` dell'episodio e principal sono
tutti noti *prima* che il modello giri. È la stessa disciplina di `tenantClass`
(`assemble.ts:80-84`) e la stessa del menu dei tool, la cui regola è scritta a
`agent/loop.ts:287-289`: deciso *«from who is speaking and where — never from
what they said»*.

E va detta la cosa scomoda, perché altrimenti la regola sembra più pulita di
com'è: **un punto di giudizio del modello su cosa entra in contesto esiste già.**
`LlmReranker` (`core/memory/rerank.ts:47-103`), quando i candidati fusi sono ≥ 12,
riceve i primi 40 e sceglie gli 8 finali. Non è un router — non decide *se*
recuperare, né da quale store, né quale modello — ma esercita giudizio su cosa il
modello principale vede. Il suo insieme di candidati è deterministico e il
fallback in caso di errore è l'ordine RRF (`rerank.ts:88-102`).

Questo è il **precedente e il tetto**: se un giorno una context policy avrà
bisogno di giudizio, deve avere quella forma — candidati deterministici, il
modello ordina soltanto, fallback deterministico al guasto — e mai la forma «un
modello decide cosa caricare», che è ADR-0009 e le due retrocessioni in casa
(`confronto-gemini.md §8`).

- **Pro**: cinque classi su sette non chiedono lavoro; la sesta è una convenzione
  di cartelle già adottata; la settima si respinge con una riga.
- **Contro**: i tre buchi sopra sono reali e nessuno dei tre è nella roadmap
  oggi; e il conteggio dei token è un prerequisito che non abbiamo.
- **Raccomandazione**: adottare le sette classi **come vocabolario**, non come
  componente. Concretamente: (a) costruire la sottostruttura di `§17` e derivare
  la classe dal percorso, (b) aggiungere il conteggio dei token prima di
  qualunque politica di finestra, (c) **non** costruire «Muffin decide cosa
  tenere» in nessuna forma che non sia quella di `LlmReranker`.

---

## Bivio 5 — Struttura di base modificabile, senza cancellare, con revert

### Dove siamo davvero, e sono tre fatti che sorprendono

1. **Una capability di cancellazione non esiste.** `fsCapabilities` è
   read/list/write (`agent/tools/fs.ts:34-59`). Nessun unlink, nessun rmdir, in
   nessun tool. La richiesta dell'owner «non deve poter eliminare cartelle con
   cose dentro» è **già vera** per la superficie `fs_*`.
2. **Ma «non cancella» non è «non distrugge».** `fs_write` sovrascrive
   (`agent/tools/fs.ts:82-84`, `fsWrite` a `:230-235`) senza copia di sicurezza:
   un file vuoto scritto sopra la lista della spesa la distrugge senza cancellare
   niente.
3. **E il buco vero è la shell.** `sys.shell` è `high` + `reversible: 'no'`
   (`agent/tools/shell.ts:33-40`). In modalità `hardened`, con principal owner e
   taint 0, il kernel restituisce **allow silenzioso**
   (`core/policy/decide.ts:203-205`). Quindi `rm -rf` su una cartella piena passa
   senza cancello in quella configurazione. La garanzia che l'owner chiede vale
   sulla superficie `fs`, **non** sulla superficie `shell`, e vale la pena dirlo
   invece di ereditarlo.

E sopra tutto: oggi non gira niente di tutto ciò, perché il `draft` è rifiutato
(`agent/loop.ts:656-666`). L'agente non può scrivere un file.

### Le tre forme possibili per il registro mancante

**(a) Registro staged-pending generico** — la forma Hermes, citata in
`confronto-harness.md §9` punto 4 e nominata da ADR-0035.
*Pro*: generale, copre ogni capability `undoable`, e onora il contratto del
kernel per tutte insieme.
*Contro*: è esattamente ciò contro cui `§19` porta un numero — `undo_log` a
**zero righe in quattro mesi** col tier acceso di default — e ADR-0035 dice già
che *«costruire il registro non basta; va costruito il caso d'uso che lo riempie,
o è la dodicesima istanza»*.

**(b) Git trasparente sulla cartella** — la forma candidata di `§19`.
*Pro*: il revert è `git revert` e copre anche il danno a livello di directory; il
**diff è il payload dell'evento** del bivio 1; e `§19` nota il secondo uso — fa
dire a `muffin vault check` non solo *«disco e indice divergono»* ma *«ecco cosa
è cambiato»*. Lo scanner salta già `.git` (`core/vault/vault.ts:36`), quindi non
c'è interferenza con l'indicizzazione.
*Contro*: non è un undo generale — il `draft` resterebbe rifiutato per ogni altra
capability, e il kernel continuerebbe a emettere un verdetto implementato solo a
volte; e una cartella che l'owner edita a mano dentro un repo git produrrà stati
sporchi che qualcuno dovrà gestire.

**(c) Copia-prima-di-scrivere** — la cosa più piccola che funziona: prima di
`fsWrite` nel workspace, i byte precedenti vanno in un posto ritenuto, con una
riga che registra path, hash e ora.
*Pro*: minuscola, nessuna dipendenza, ed è **esattamente** ciò che serve al
contratto che il kernel già dichiara — `windowSeconds: 300`
(`core/policy/decide.ts:198`): per annullare entro cinque minuti bastano i byte
di prima. È anche la regola «non cancellare mai righe» applicata ai file.
*Contro*: nessun revert a livello di directory, e cresce senza una regola di
ritenzione.

- **Raccomandazione**: **(c), poi (b), e mai (a) per prima.** (c) è la cosa più
  piccola che rende onesto il `draft` e sblocca `fs_write`, che oggi è morto.
  (b) arriva quando il workspace esiste e **si ripaga sul diff**, non sull'undo —
  ed è questo che lo sottrae all'obiezione di `§19`: il diff serve comunque,
  anche se nessuno annullerà mai niente. (a) è la forma che il numero delle zero
  righe sconsiglia di costruire per prima.
- E una riga di disciplina, da prassi §5 (*scrivi il test che fallisce senza il
  cablaggio*): «l'agente non può cancellare una cartella piena» va reso un test
  che fallisce se una capability distruttiva compare fra `fsCapabilities` — non
  una frase in un documento. Oggi è vero per assenza, e le cose vere per assenza
  smettono di esserlo senza che nessuno se ne accorga.

---

# Parte II — technical notes (English, STE)

## T1. Verified state of the mechanisms

All line numbers below were read on this checkout.

| Mechanism | File:line | State |
|---|---|---|
| Kernel emits `draft` for medium + undoable | `core/policy/decide.ts:197-198` | Works |
| Loop refuses every `draft` | `agent/loop.ts:656-666` | Works. `fs_write` is unreachable |
| `fs.write` declaration | `agent/tools/fs.ts:52-58` | `medium`, `undoable` |
| No delete capability exists | `agent/tools/fs.ts:34-59` | Read, list and write only |
| Shell is high risk, not reversible | `agent/tools/shell.ts:33-40` | Silent allow if hardened + owner + taint 0 (`decide.ts:203-205`) |
| Vault change detection by content hash | `core/vault/vault.ts:210-217`, `:369` | Works. No periodic caller |
| Trust never rises on reindex | `core/vault/vault.ts:219-227` | Follows content, not path |
| Scheduler tick | `cli/repl.ts:123` | `setInterval(30_000)`. Only construction site |
| Job store | `core/scheduler/jobs.ts:21-34` | No status column. No claim. No lease. No payload except `goal` |
| Durable inbox pattern | `connectors/telegram/updates.ts:29-52` | The only at-least-once queue in the repo |
| Fired-once ledger | `core/scheduler/firelog.ts:27-35` | Keyed on anchor. `INSERT OR IGNORE`. Nudges only, not jobs |
| Single-row mutex | `core/scheduler/sendlock.ts:66-72` | `BEGIN IMMEDIATE`. One caller: `cli/observe.ts:175` |
| Proactive gate | `core/scheduler/proactivity.ts:94-107` | Works. Tier > 1 denied |
| Proactive kinds with a producer | `core/scheduler/observe.ts:109` | 1 of 5. Only `gone_quiet` |
| Context assembly | `agent/context/assemble.ts:125-192` | System prompts only, built at boot |
| Tool menu selection | `agent/loop.ts:290-293` | By principal, then registration order |
| Tool result eviction | `agent/context/compact.ts:58-117` | 60,000 characters. Newest first |
| Model judgement on context | `core/memory/rerank.ts:47-103` | The only such point. Deterministic fallback |

## T2. Proposed types — and the migration cost is zero

Put the novelty in `episodes.connector`, which is free `TEXT`. Do not put it in
`episodes.kind`, which carries a `CHECK` constraint
(`core/memory/schema.ts:34`).

This matters. `MemoryStore.ensureColumn` (`core/memory/store.ts:101-107`) can add
a column to an existing database. It cannot change a `CHECK` constraint, because
SQLite cannot alter one. `CREATE TABLE IF NOT EXISTS` does nothing to a table
that exists. So a new `kind` value works on a fresh database and **fails on every
installed one**, at insert time.

A workspace transition therefore stores as:

```
connector  = 'workspace'      -- free text column, no CHECK
role       = 'user'           -- allowed by the CHECK at schema.ts:32
kind       = 'message'        -- allowed by the CHECK at schema.ts:34
thread_key = <relative file path>
content    = the rendered transition, one proposition
trust_tier = tier of the authenticated principal
```

This is not a workaround. A ticked box is a message from the owner on a different
surface. The row says exactly that.

The event log, if built, follows `telegram_updates` (`updates.ts:29-52`):

```
events(
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,     -- closed set, validated in code, never free
  kind        TEXT NOT NULL,     -- closed set per source
  payload     TEXT NOT NULL,     -- JSON, parsed by the consumer at the boundary
  principal   TEXT NOT NULL,     -- who produced it. Never inferred from content
  trust_tier  INTEGER NOT NULL CHECK (trust_tier BETWEEN 0 AND 3),
  created_at  TEXT NOT NULL,
  processed_at TEXT,             -- NULL means pending. Same query as the inbox
  failure     TEXT               -- reason kept, row stays pending, restart retries
)
```

Four rules on this table, each with its reason:

1. Write the row first. Act second. The reason is `updates.ts:12-24`.
2. `source` and `kind` are closed sets in TypeScript. A free string rebuilds the
   firehose that ADR-0028 made unbuildable (`proactivity.ts:26-35`).
3. `trust_tier` is never defaulted. If the producer cannot name a principal, it
   must not write a row.
4. One consumer only. No subscriptions. Fan-out is the part `§22` rejects.

## T3. What must be decided before any code

1. Amend `03-threat-model.md §4(e)` or contradict it in writing. It says vault
   files are never a trigger source.
2. State the Dashboard rail: the Dashboard writes files, never the database.
   ADR-0022 names a webapp on the database as its own falsification signal.
3. Decide whether a scan-found change may become an event. This brief recommends
   no.
4. Decide the undo form. This brief recommends copy-before-write first.

## T4. What must be tested, per practice §5

Write the test that fails without the wiring, not the test that proves the logic.

- A test that fails if a destructive verb appears in `fsCapabilities`.
- A test that a `draft` decision reaches a real undo record, from production
  assembly, not from a unit fixture.
- A test that an event with tier > 1 cannot arm any job trigger.
- A test that a producer without a principal cannot write an event row.
- A test that the workspace transition writes with `connector='workspace'` and
  inserts cleanly into a database created before the change.

---

# Cosa non si è potuto stabilire

1. **`docs/PRACTICES.md §13` non esiste.** Il file è di 298 righe e la sua ultima
   sezione è §12, a `docs/PRACTICES.md:273`. Il formato richiesto — blocco di freschezza,
   bottom line, concettuale in italiano, tecnico in inglese STE, «cosa non si è
   potuto stabilire» — non compare in nessun documento di processo del repo
   (grep su `docs/` per «freschezza», «non si è potuto stabilire», «STE»: zero
   risultati). Ho ricostruito la forma dai documenti di ricerca esistenti
   (`confronto-gemini.md`, `memory-salience-and-fusion.md`,
   `proattivita-quando-parlare.md`), che la seguono di fatto. **Se §13 è stata
   scritta e non committata, questo documento va riallineato**; se non è mai
   esistita, va scritta, perché tre ricerche la seguono già senza una regola.
2. **Se una lista spuntata debba produrre *fatti* o solo *episodi*.** Ho stabilito
   che la transizione è la forma legittima dell'evidenza. Non ho stabilito se
   `ingestPending` debba poi estrarne fatti, e non è decidibile con l'evidenza
   disponibile: `core/memory/extract.ts` non è mai stato girato su testo di questa
   forma, e il consolidamento non parte comunque mai (`STATE.md`, divario #1).
   Va deciso quando l'estrazione avrà un chiamante.
3. **Il costo reale del poll.** Non ho misurato quanti file e quanti megabyte
   contenga un vault d'uso reale, perché il vault dell'owner non è su questa
   macchina e la memoria è a zero (ADR-0028 riporta *zero candidati su 0 entità*
   al 2026-08-10). «Un hash per file per tick costa poco» è una previsione, non
   una misura. Lo spike è dieci righe e va fatto prima di scegliere il tick.
4. **Se la Dashboard possa autenticare davvero.** L'intera raccomandazione del
   bivio 3 poggia sull'esistenza di una superficie che sappia dire *chi* ha
   salvato. Non esiste alcun listener HTTP, socket unix o WebSocket nel repo
   (verificato: nessun `createServer`, nessun `.listen(`). ADR-0035 prescrive un
   socket unix e non è costruito. Finché non esiste, **nessuna modifica al
   filesystem è attribuibile**, e la postura corretta resta quella odierna:
   riallineare l'indice, non generare eventi.
5. **Se il tick a 30 s sia il posto giusto per il poll del vault.** Lo scheduler
   prende **un solo job per tick** (`core/scheduler/scheduler.ts:82`) e ha un
   `running` booleano in memoria (`:58`). Non ho stabilito se un poll del vault
   debba passare da lì, competere con i job, o vivere accanto — dipende da come
   sarà costruito il processo di ADR-0035, che non c'è.
6. **Il numero di `§19` non è stato riverificato da me.** «`undo_log` a zero righe
   in quattro mesi» viene da `confronto-gemini.md §19` e riguarda il database del
   vecchio Muffin, che non è su questa macchina. È l'argomento più forte contro il
   registro generico e regge su una misura che ho letto, non rifatto.
7. **La condizione di stop dei job** (`§15`, «una colonna e un controllo in
   `markRan`») resta aperta e va nella stessa slice del trigger a predicato, come
   `12-casi-uso-primitive.md:75-84` già dice. Non l'ho istruita qui perché non è
   fra le cinque domande, ma un trigger a evento senza condizione di stop accumula
   sveglie esattamente come un cron.
