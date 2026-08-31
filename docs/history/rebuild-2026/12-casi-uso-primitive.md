# 12 — Casi d'uso → primitive

> Inventario owner del 2026-08-09, tradotto. La regola che governa questo
> documento è quella in cima a `knowledge/README.md`: **un principio diventa una
> proprietà di una primitiva che già esiste, mai un modulo a lato**. Venti casi
> d'uso non sono venti feature — sono **sette primitive**, e la maggior parte
> dei casi cade fuori gratis una volta che quelle esistono.

## La tabella che decide il lavoro

| Primitiva | Copre | Stato |
|---|---|---|
| **Trigger a predicato** ("cron dinamico") | sveglia, dopo-il-caffè, pre-riunione, "appena arriva una mail" | ❌ il pezzo mancante vero |
| **Sorgenti osservate** (mail, calendario, git, sensori) | metà dei casi elencati | ❌ categoria nuova — vedi §rischio |
| **Outward draft-only** | rispondere alle mail, bozze nel tuo stile | 🟡 dichiarato in ADR-0015, mai costruito |
| **Modello di stile dell'owner** | "rispondi usando le vecchie mail come base" | ❌ nuovo, e **diverso** dalla voce di muffin |
| **Auto-report strutturato nel tempo** | journaling, energia, mood, diario | 🟡 vault c'è, la serie temporale no |
| **Render ricco per superficie** | widget meteo, calendario, genUI, fallback immagine | 🟡 ADR-0016/0023 progettati, non costruiti |
| **Fetch binario** | "mandami il file / le immagini da quel sito" | ❌ `http_get` è GET testuale |

Due osservazioni che valgono più della tabella.

**"Differenzia chit-chat da lavoro da studio"** non è una feature: è la
**dimensione 4** di `knowledge/01-understanding.md` — *context specificity*, che
non è una proprietà dell'entità ma della **coppia (entità, contesto corrente)**.
È già nel corpus, non è costruita. Chi la implementa la implementa lì, non come
un classificatore di intent a lato.

**"Rispondi usando le vecchie mail come base"** è il caso più delicato della
lista, e non per ragioni tecniche. Non è recall: è **imitare l'owner verso
terzi**. L'errore non produce una risposta brutta, produce una mail a suo nome
che non avrebbe scritto. Merita un gate suo, separato da tutto il resto, e
`outward.*` è già escluso dai principal autonomi (`decide.ts`, `FORBIDDEN_FOR_SYSTEM`).

## Il cron dinamico — dove sta la difficoltà

L'owner: *«alcune cose non sono definite da un tempo ma da un evento tipo "si è
svegliato", ma magari io voglio che prima prendo il caffè per essere considerato
svegliato»*.

**"Si è svegliato" non è un orario: è un predicato su stato osservato, che deve
fare latch.** Tre pezzi, e nessuno richiede un LLM che gira a vuoto:

1. **Segnale** — stadio 1 di `knowledge/03-observing-spine.md`: deterministico,
   event-driven, zero LLM. Primo messaggio del giorno, attività dopo un silenzio
   lungo, evento di calendario che si avvicina. Le àncore di ritmo si
   **imparano** dal profilo circadiano, non si fissano.
2. **Il predicato con la sua conferma** — ed è qui che sta il caffè: "sveglio"
   per questo owner non è il primo messaggio, è *dopo il caffè*. Quindi la
   definizione è **sua**, dichiarata o appresa, non una costante che scegliamo noi.
3. **Latch di consegna** — l'intento è armato, spara **una volta**, si spegne.
   "Un nudge che si toglie dal prompt quando consegnato" è esattamente questo, e
   la proprietà che serve si chiama idempotenza.

   **Questo pezzo è costruito** (2026-08-10, slice della spina osservante):
   `core/scheduler/firelog.ts` è il latch. Righe mai cancellate, chiave sull'ancora,
   e l'ancora porta dentro *quale* istanza dell'evento — così ciò che si spegne è
   quella occasione lì, non la cosa in generale. Il trigger a predicato **riusa
   questo**, non ne costruisce un secondo: due registri di "già fatto" divergono,
   ed è la domanda che il judge fa per prima.

   Due cose imparate cablandolo, che valgono qui identiche. **Un rinvio non è uno
   sparo**: registrare un `defer` trasforma una notte in quiet-hours in un
   silenzio permanente su quella cosa — si segna solo ciò che è davvero uscito.
   E **controlla-poi-consegna non è atomico**: due comandi lanciati insieme
   consegnavano due volte contro un registro solo, misurato. La cura è un lock
   sul percorso che consegna, non sul percorso che mostra.

**La forma concreta**: il job store ha già `cron`. Gli si aggiunge un `trigger`
che è `cron` **oppure** `event`, dove `event` è un **insieme chiuso** di
predicati — stessa disciplina di ADR-0028, che ha reso il firehose
*incostruibile* rendendo `kind` un enum invece che una stringa libera. Se il
predicato è testo libero, si è ricostruito il demone che osserva tutto.

**E, nella stessa slice, la condizione di stop** (aggiunto 2026-08-14 da
`research/confronto-gemini.md` §15). Le richieste vere hanno una fine dentro:
*«controlla questo sito ogni mattina **per due settimane**»*, *«ricordamelo
finché non l'ho fatto»*. Oggi un job si spegne **solo se qualcuno lo toglie a
mano**, quindi ogni richiesta a termine lascia dietro di sé un job che nessuno
disarmerà — e il modo in cui te ne accorgi è che continua ad arrivarti. È una
colonna sul job (`until` come data, o un conteggio di fire) più un controllo in
`markRan`, che già ricalcola da *ora*. Costa poco e va fatto qui, perché un
trigger a predicato senza condizione di stop è la forma che accumula sveglie:
il cron a data almeno ti ricorda quando l'hai messo.

## I casi proposti e validati (2026-08-09)

Cinque, in ordine di quanto convincono:

1. **Brief pre-riunione** — dieci minuti prima di un evento: chi è questa
   persona, di cosa avete parlato l'ultima volta, cosa le avevi promesso. Usa
   solo cose che esistono (calendario come fonte + recall), rischio quasi zero.
2. **Diario delle decisioni** — non i fatti, le *decisioni*, col motivo di
   allora. Gioca sulla bi-temporalità già costruita e risponde a "perché a maggio
   avevo deciso così", domanda a cui oggi nessuno strumento risponde.
3. **"Cosa mi sono perso"** — dopo un'assenza, recupero pesato per importanza
   invece che cronologico. Complemento naturale del segnale-assenza.
4. **Impegni verso terzi** — "ti faccio sapere" detto a qualcuno, e il
   promemoria prima che scada. Il vecchio muffin ce l'aveva **costruito e spento
   dietro un flag** (`pledge_pipeline`), quindi il costo è già stato pagato.
5. **Il vault che ritorna** — un paper salvato tre mesi fa che riemerge perché
   *ora* stai parlando di quella cosa. È context specificity applicata al vault.

**Sconsigliato per ora**: telecamere e homelab. Non per etica in astratto — perché
è l'unica voce dove l'errore non è recuperabile e dove il threat model attuale
non ha niente da dire. Le fondamenta reggerebbero (capability registry, kernel);
serve il suo giro di threat model, non un tool in più.

## Il rischio che questa lista introduce, e che il threat model non copre

Metà dei casi aggiunge **sorgenti che leggono la vita dell'owner**: mail,
calendario, posizione. Il threat model (`03-threat-model.md`) copre input ostili
da **gruppi** e dal **web** — contenuto che arriva perché qualcuno parla con
muffin, o perché muffin è andato a leggerlo.

Non copre: **una mail avvelenata che arriva da sola alle 7 del mattino, mentre
nessuno guarda, e innesca un turno proattivo.** È un ingresso non sollecitato,
in un momento senza umano davanti, verso un agente che ha `outward.*` a un gate
di distanza. Prima di costruire questa categoria va scritto quel capitolo.

Nota di coerenza: `sys.search` e `sys.http` hanno già accettato che **la query è
un canale d'uscita** — il modello sceglie la stringa e la stringa parte. È
tollerabile perché l'endpoint è approvato dall'owner. Con le sorgenti in
ingresso il conto cambia, perché il contenuto che *scrive* la query non l'ha più
scelto l'owner.

## Quando si costruiranno mail e calendario: leggi prima di scrivere

Nota per gli adapter, non un componente (aggiunto 2026-08-14 da
`research/confronto-gemini.md` §11). Prima di una scrittura, l'adapter
**interroga lo stato reale** e rifiuta il payload del modello come *fatto di
sistema*, non come rifiuto generico:

> `ConstraintError: le 15:00 sono occupate da "Riunione X". Scegli uno slot libero.`

Perché è una proprietà dell'adapter e non un layer: il kernel decide **se** una
capability può agire, e non sa niente di calendari; un verificatore centrale
che sapesse di calendari sarebbe un secondo posto dove vive la conoscenza del
dominio. E perché la forma dell'errore conta: un `deny` nudo insegna al modello
a riprovare, un vincolo nominato gli dice cosa cambiare — è la stessa ragione
per cui il messaggio del kernel dice *"non insistere"* invece di *"negato"*.

Vale per entrambi i lati dell'ambiguità: il calendario controlla la
sovrapposizione, la rubrica controlla che l'indirizzo generato esista fra i
contatti invece di essere plausibile. Il secondo è il caso che rende `outward`
pericoloso senza rumore — un indirizzo inventato ma ben formato passa ogni
validazione sintattica.

## Fonti

`knowledge/01-understanding.md` (context specificity) ·
`knowledge/03-observing-spine.md` (cancello a due stadi) ·
`knowledge/04-learn-from-absence.md` · `knowledge/05-person-model.md` ·
`adr/0028` (insieme chiuso di trigger) · `adr/0016`/`0023` (render) ·
`adr/0015` (outward differito) · `03-threat-model.md` · `04-roadmap.md` §5.
