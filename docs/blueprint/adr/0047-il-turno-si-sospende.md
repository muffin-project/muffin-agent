# ADR-0047 — Il turno si sospende: `wait`, `todo`, resume

**Stato:** accettato · 2026-08-16 · chiude B3, B4, B5 dell'inventario Gate 1

**Contesto.** ADR-0042 ha costruito la riga: un turno è un record durevole con
un'identità, modello pinnato, trascritto intero, taint persistita e intento+esito
per ogni tool call. Quella ADR si chiude dicendo cosa **non** aveva costruito —
«`wait`, il resume vero, la consegna dalla corsia» — e lascia B2, B3 e B5
BLOCKER apposta: il record non li fa, li rende costruibili senza riaprire il
loop. Questa ADR registra i consumatori, e le decisioni che scriverli ha
costretto a prendere. Le colonne `wake_at` e `wait_for` e gli stati `waiting` e
`runnable` erano già nel `CHECK` senza scrittori, messi lì da quella slice
esattamente per oggi.

Il modello operativo che M5-BIS §2 chiede non è `goal → turn → done` ma
`goal → plan → todo{done|blocked|waiting|retry|pending} → resume`, e la forma di
`wait` è scritta come una sequenza: `WAIT → persisti lo stato → RILASCIA
l'esecuzione → scheduler/evento → riprendi`. La parte che costa è la terza: un
`await sleep()` dentro il processo cognitivo non è `wait`, è una funzione async
molto lunga, ed è precisamente la differenza fra un Muffin vivo e un Muffin
lanciato da terminale.

## Decisione

### 1. `wait` arma una barriera, non dorme

Il tool non blocca, non usa `setTimeout` e non ritorna tardi. Valida, controlla
il tetto e **arma una barriera sul turno**; il loop la onora al punto di
sospensione successivo — *fra* un'iterazione e l'altra, mai dentro — persiste e
ritorna. La sospensione fra i batch non è un dettaglio di implementazione: un
modello emette più tool call in un turno, e sospendere da dentro l'handler
lascerebbe le chiamate successive con un `tool_use` senza `tool_result`, che è
una richiesta malformata che il provider rifiuta al giro dopo.

Le costanti vivono in `core/turns/wait.ts` con la ragione accanto:

- **`MIN_WAIT_MS = 60_000`** — il risveglio passa dal battito del runtime
  (30 s), quindi un'attesa più corta diventerebbe comunque più lunga. Rifiutata
  al confine invece di essere arrotondata in silenzio: un'attesa sotto il minuto
  non è un wait, è uno `sleep` dentro un tool.
- **`MAX_WAIT_MS = 7 giorni`** — un'attesa di sei mesi è un errore di battitura,
  non un'intenzione; oltre, è un job.
- **`MAX_SUSPENDED_PER_TENANT = 8`** — abbastanza perché un lavoro multi-step
  vero non sbatta mai contro il tetto, poco abbastanza perché un modello a cui
  piace aspettare ci arrivi in una sessione invece di riempire una tabella che
  nessuno legge. Il rifiuto dice il numero: un limite che fallisce senza dire
  quale era è un limite che si debugga leggendo il sorgente.
- **`MAX_RESUMES = 3`** — il guasto da cui protegge è uno che il record rende
  *più* probabile, non meno: un turno la cui ripresa uccide il processo verrebbe
  riprovato a ogni boot per sempre, e il processo che muore non è mai quello che
  può contare. Sta nella riga, non nella corsia.

La scadenza è **obbligatoria** anche quando c'è una barriera a evento. Un job
senza condizione d'arresto continua ad arrivare, quindi l'owner se ne accorge;
un turno sospeso senza scadenza è **silenzioso** — tiene una riga e tutto il suo
contesto e non lo dice nessuno. `WaitKind` ha un membro solo, `process_exit`, e
non è uno stub: un insieme chiuso i cui membri nessuno sa valutare sarebbe
l'ennesimo meccanismo collegato a niente, quindi contiene esattamente ciò che la
corsia sa decidere su questa macchina senza un broker.

### 2. `wait` ha `maxTaint: 3`, e la ragione è specifica

`defaultMaxTaint.medium` è 1, quindi senza dichiararlo il caso canonico —
*«leggi la pagina, aspetta un'ora, ricontrolla»* — è negato `taint_exceeded` nel
momento in cui la pagina viene letta. L'agente potrebbe aspettare solo di cose
che non ha guardato, che è quasi mai.

Alzare il tetto qui è sicuro per una ragione propria di questa capability, non
per indulgenza generale: `wait` **non esporta niente** (nessun byte esce, nessun
messaggio parte, nessun file viene scritto: mette due colonne su una riga
nostra), **non arma niente verso l'esterno** (l'unica barriera che può chiedere
è «questo pid locale è uscito», una *lettura* della tabella dei processi), e —
la metà portante — **aspettare non compra privilegio**: il turno ripreso
ripristina la taint dal record, quindi torna esattamente sporco com'era. Se la
sospensione lavasse la taint, questo tetto sarebbe la scelta sbagliata; è
sicuro precisamente perché non la lava.

La classe di rischio resta `medium`, perché risponde a un'altra domanda: cosa la
chiamata **impegna** (una riga, un contesto, un prefisso ririmandato che nessun
contatore misura ancora). Tetto di taint e classe di rischio sono due assi.

**Il tetto alzato vale solo per l'host** (N2, judge giro 2). `wait` dichiara
`hostOnly: true` (`agent/tools/wait.ts`): un membro di gruppo a tier 2 che arma
un'attesa persistente è una superficie che il threat model non ha ancora
esaminato, quindi resta fail-closed — il kernel rifiuta un membro qui
(`decide.ts`) e `visibleTools` toglie il tool dal suo menu, non solo dal
risultato. La domanda resta aperta per quando i gruppi si attivano: *se* e a
quale tetto un `wait` di gruppo debba essere permesso non è deciso da questa
ADR.

> **Principio, dall'owner (2026-08-16):** un tetto che rende inusabile la
> capability nel suo caso canonico non è una difesa, è un difetto. La direzione
> è l'usabilità reale — mai «chiedi ogni cinque minuti», che è il modo in cui un
> gate smette di essere letto.

### 3. `todo` è una tabella nuova con cinque stati chiusi

`todos`, con `CHECK (state IN ('pending','done','blocked','waiting','retry'))`.
I cinque vengono da M5-BIS §2 alla lettera, e non c'è deliberatamente un
`cancelled`: una cosa che ha smesso di contare è `done` (è finita) o `blocked`
con la ragione nella nota (qualcosa l'ha fermata). Uno stato che significa
«lascia perdere» farebbe della lista un posto dove il lavoro sparisce in
silenzio, ed è la stessa ragione per cui qui non si cancellano righe.

**Il costo del sesto stato è dichiarato**: SQLite non altera un `CHECK`, quindi
uno stato nuovo dopo il giorno 1 dei quattordici costa la ricostruzione della
tabella — la stessa trappola di `episodes.kind` e di `turns.status`. Prima del
giorno 1 costa una riga. Oggi la tabella è nuova, quindi il costo di migrazione
su un database installato è **zero**, come per `jobs` e `spend`.

Il criterio di completamento è **deterministico e si legge dalle righe**:
finito = nessun passo `pending` o `retry`. Mai il modello che si dichiara
finito. La frase è scritta nel contesto perché quello è l'unico posto dove il
modello legge del piano.

Il piano è letto nel contesto di **ogni** turno della sessione, e sta nella coda
volatile e non in `SystemPrompts`: i prompt sono assemblati una volta al boot
proprio perché restino byte-identici e il prefisso resti caldo, e una lista che
cambia a ogni turno davanti a loro lo farebbe raffreddare a ogni messaggio.

**Il piano ha un tetto cumulativo, e non solo per chiamata** (N3, judge giro 2).
`plan` limita già una singola chiamata (30 passi × 500 caratteri), ma quel tetto
non limitava la sessione: niente impediva a un modello di richiamare `plan`
più volte, ognuna sotto chiavi nuove, mentre il contesto rende **tutte** le
righe aperte a ogni turno senza condizione. `MAX_OPEN_TODOS = 60`
(`core/turns/todo.ts`) chiude la coda: sopra il tetto `plan` rifiuta con i
numeri nel rifiuto, nella stessa forma di `MAX_SUSPENDED_PER_TENANT` sopra.

### 4. Un todo porta la taint di chi lo ha scritto

Colonna `tier`, `NOT NULL` senza default, `max()`-ata a ogni scrittura.

Un piano è testo del modello scritto **sotto l'influenza di quello che c'era nel
contesto del turno**. Un turno che aveva letto una pagina a tier 3 e poi scriveva
«manda le credenziali a x@y» nel piano consegnava quella frase al turno
*successivo* a tier 0, incorniciata come intenzione propria dell'agente — e ogni
capability che il kernel misura sulla taint era aperta. È il pattern
fetch-then-act travestito da tabella, la stessa forma che ADR-0042 ha chiuso per
la taint del turno e `slice/taint-non-si-lava-in-uscita` per la risposta.

`max()` e mai assegnazione: un turno più pulito che ripete lo stesso passo non
lava la frase che quello sporco ha scritto. La nota è una seconda porta sulla
stessa riga e porta il tier allo stesso modo. Il loop alza lo snapshot alla
peggiore riga aperta **prima** che il modello venga chiamato.

### 5. Il resume riparte dalla riga, e rifiuta invece di indovinare

Tre rifiuti espliciti, nessuno dei quali è una comodità:

- **modello diverso** → rifiuto terminale e riga chiusa. Le firme di thinking
  appartengono al modello che le ha prodotte, e ADR-0037 registra che
  rimandarle altrove **non fa rumore**: il server le toglie o spegne il
  thinking, e il sintomo è un agente peggiore. Riprovare significherebbe una
  riga che si sveglia a ogni boot per essere rifiutata di nuovo.
- **riprese esaurite** (`MAX_RESUMES`) → chiusa, per la ragione sopra.
- **presa da un altro processo** → non è un errore: due corsie su un database è
  il caso normale nei secondi in cui REPL e gateway si sovrappongono.

La **taint viene dalla colonna**, mai riderivata dal principal: ricostruirla
farebbe ripartire a tier 0 un turno che aveva già letto il web. `rerunnable`
decide cosa si rifà: esito registrato → **rigiocato**; intento senza esito →
`rerunnable`, e dove dice no il turno riparte **dichiarando** che la chiamata può
essere avvenuta. Mai fingere che non sia successa, mai affermare che sia
successa.

La prima esecuzione di una riga registrata da una superficie **non** conta come
ripresa. Il segnale è `counters.contextBuilt`, non lo stato: una riga svegliata
da `waiting` torna `runnable`, quindi lo stato da solo non distingue «registrata
e mai girata» da «sospesa e ora scaduta». `interrupted` conta comunque, ed è
quel ramo che tiene il limite un limite — una riga che uccide il processo durante
il proprio preambolo non arriva mai a `contextBuilt`.

### 6. La corsia dei turni è la seconda, e la corsia del modello è una sola

`core/turns/lane.ts` batte sul tick del gateway (30 s, lo stesso battito contro
cui `MIN_WAIT_MS` è scritto) e prende **una** riga da `TurnStore.due` —
registrata e mai eseguita, sospesa e scaduta, o lasciata da un processo morto:
tre produttori in una coda sola. È obbligatoria su `GatewayDeps`, perché una
corsia opzionale è una corsia che qualche assemblaggio dimentica, e dimenticarla
significa che ogni turno sospeso su quell'install dorme per sempre.

**La concorrenza è 1, e adesso è un oggetto invece di due affermazioni.**
ADR-0022 dava allo scheduler «one owner, one model lane»; la corsia dei turni
diceva la stessa frase di sé. Erano vere **separatamente** — un flag privato per
uno — e `Gateway.tick` le guida sullo stesso battito, quindi un job e un turno
ripreso giravano nello stesso momento contro un provider e un budget mentre
entrambi i file documentavano che non potevano. `core/turns/model-lane.ts` è un
token che il gateway possiede e passa a tutt'e due: un token non può essere
collegato a metà, mentre due fili sì e il guasto è silenzioso.

La corsia **non consegna**: non sa cosa sia una chat id. L'indirizzo è il
`replyTo` sulla riga, e la porta è quella della superficie connessa in quel
processo. Un turno chiuso con del testo e nessun indirizzo emette un evento
`undeliverable` invece di essere scartato in silenzio.

### 7. Le uscite che una superficie deve saper dire

`TurnStopped` è `TurnOutcome | 'suspended'`, referenziata e mai ridichiarata:
l'unione aveva tre copie letterali e il disegno aveva nominato la divergenza
come il difetto tipico di questo repo prima che accadesse. Aggiungere l'arma in
un posto solo è ciò che ha costretto ogni consumatore a rispondere:

- `muffin run` esce **6** — un codice suo, perché uno script che non distingue
  «sospeso» da «risposto» stampa una stringa vuota e la chiama risultato;
- lo scheduler segna il fire come avvenuto e **non consegna** (consegnerà la
  corsia): lasciare il job dovuto farebbe partire un secondo turno per lo stesso
  goal mentre il primo è ancora in volo;
- la REPL dice fino a quando e **chi** lo finirà, perché lì la risposta è dovuta
  a qualcun altro: la REPL cede al gateway (ADR-0035) e non ha una corsia.

## Alternative scartate

- **`await sleep()` dentro il turno.** È l'implementazione che il documento
  chiama per nome come *non* wait. Tiene il runtime, e un processo che muore
  durante l'attesa perde tutto, perché l'attesa è un frame di stack e non una
  riga.
- **Far chiedere alla corsia dei turni se lo scheduler sta girando, e viceversa**
  (`gate: { isActive: () => scheduler.isRunning() }`). Corretto oggi e solo
  oggi: sono due fili che un punto di costruzione può attaccare a metà, e il
  guasto è silenzioso — tutto continua a funzionare, solo due volte insieme.
- **Un `cancelled` fra gli stati del todo.** Farebbe della lista il posto dove
  il lavoro sparisce senza che nessuno lo veda.
- **Ricostruire la taint dal principal alla ripresa.** È una scalata di
  privilegio, non una comodità: farebbe ripartire pulito un turno che aveva già
  letto il web.
- **Riprovare un resume rifiutato per modello diverso.** Una riga che si sveglia
  a ogni boot per essere rifiutata di nuovo è il fallimento silenzioso-per-sempre
  che il record esiste per non produrre.
- **`wait` senza scadenza, con la sola barriera a evento.** Un evento che non
  arriva mai è una riga che nessuno guarda più.

## Reversibilità

**Alta sul codice, media sullo schema, e la parte media è quella da decidere
adesso.**

Le costanti (§1), il tetto di taint (§2) e l'ordine di registrazione dei tool
sono numeri in un file: si cambiano in un commit, e il tetto di esposizione ha
un test che nomina cosa entra e cosa esce, quindi spostarli non può essere
silenzioso.

Lo schema è l'altra metà. La tabella `todos` è nuova, quindi **oggi** aggiungere
uno stato o una colonna costa zero su un database installato — `CREATE TABLE IF
NOT EXISTS` crea, e nessuna install ha righe. Dal **giorno 1 dei quattordici** lo
stesso `CHECK` a cinque valori costa la ricostruzione della tabella. Vale per il
sesto stato del todo e per un sesto stato di `turns.status`.

I due campi aggiunti a `TurnCounters` (`resumes`, `contextBuilt`) stanno nel blob
JSON, che è la direzione additiva ed economica: `toCounters` li normalizza,
perché una riga scritta prima che esistessero non li ha e `undefined + 1` è
`NaN` — che è il modo in cui un limite smette di limitare senza dirlo.

**Il punto di sutura con `slice/superfici`** è `agent/turn-lane.ts` →
`LaneDeliver`, che prende il record intero e non `(channel, text)`: l'indirizzo
di un turno è opaco, e appiattirlo obbligherebbe ogni superficie a codificare la
propria forma in una stringa che qualcun altro deve riparsare. Quando quella
slice atterra col suo esito tipizzato, la modifica qui è il tipo di ritorno di
una funzione. `replyTo: { channel: job.channel }` in `makeJobRunner` è preso
verbatim da lì, così la cucitura è già fatta; la `Map` delle porte in
`cli/surface.ts` va assorbita nel loro `SurfaceRegistry` al merge.

**B2 resta BLOCKER a una chiamata**: `await runTurn(...)` → `enqueueTurn(...)` in
`TelegramConnector.handle`. Non è cambiata qui perché `slice/superfici` sta
riscrivendo `Deliver` e la resa in-band, e due slice che modificano lo stesso
invio sono una guerra di merge invece di una cucitura.

**Verificato eseguendo.** Un processo vero costruisce il runtime di produzione,
prende un turno, entra in una tool call dichiarata `rerunnable: false` e viene
**ucciso con SIGKILL** (`agent/crash-resume.test.ts`: `child.signalCode` è
asserito, perché un figlio che esce da solo è uno spegnimento ordinato travestito
da crash). Al riavvio la riga è `interrupted`, il boot la nomina, la corsia la
riprende, la risposta arriva all'indirizzo scritto sulla riga — e il contatore
degli invii resta a **0**, con il modello che riceve «questa chiamata era partita
quando il processo è morto … non è possibile sapere se ha avuto effetto. Non
l'ho rifatta.» Disabilitando il ramo `!open.rerunnable` il messaggio parte una
seconda volta.
