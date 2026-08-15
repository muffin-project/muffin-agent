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
| A2 | Identity | Sa chi è e quali limiti ha? | BLOCKER 👤 template vuoto |
| A3 | Persona | Il comportamento è definito? | BLOCKER 👤 manca il taglio dell'owner |
| A4 | Config | Si configura senza toccare il codice? | ? |
| A5 | Doctor | Individua **davvero** i problemi? | ? |
| A6 | Upgrade | Aggiornare il codice non distrugge dati? | ? |
| A7 | Migration | Lo schema evolve senza perdere memoria? | ? ⚠️ `episodes.kind` ha un CHECK non alterabile |
| A8 | Backup | La memoria si salva e si ripristina? | ? |

### B · Continuità del runtime → `gate1/b-continuita.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| B1 | Conversation | CLI e Telegram condividono **davvero** sessione e memoria? | ? |
| B2 | Long-running | Un turno può durare minuti senza rompere il connector? | BLOCKER — `runTurn` è sincrono · substrato pronto 🧱 |
| B3 | Wait | Può aspettare **senza bloccare il runtime**? | BLOCKER — primitiva assente · substrato pronto 🧱 |
| B4 | Todo | Mantiene lavoro multi-step persistente? | BLOCKER — tool assente |
| B5 | Resume | Se muore a metà, riprende? | BLOCKER — nessun resume · substrato pronto 🧱, e un crash ora **si vede** |
| B6 | Retry | Se fallisce una tool call, recupera? | ? |
| B7 | Scheduler | I job sopravvivono al riavvio? | ? |
| B8 | Delivery | Un job che dice «inviato» è **arrivato**? | BLOCKER 🔧 in lavorazione |
| B9 | Proactivity | Agisce spontaneamente secondo i gate? | ? ⚠️ 4 dei 5 `ProactiveKind` non hanno produttore |
| B10 | Telegram | Messaggi, file, immagini, **errori** | ? |
| B11 | Streaming | La risposta arriva mentre si forma, o solo alla fine? | ? |
| B12 | Overflow | Un output enorme di un tool va in contesto, o diventa un file richiamabile? | ? |

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
> Quello che **non** è costruito, e per cui le tre righe restano BLOCKER: `wait`,
> il resume vero, la consegna dalla corsia. Il record non li fa — li rende
> costruibili senza riaprire il loop.

> ⚠️ **B11 e B12 le ha trovate l'owner, non questo documento** — poche ore dopo
> che era stato scritto per rendere impossibile esattamente questo: *«mi pare che
> ci siamo dimenticati lo streaming, inoltre anche i token limit dovrebbero
> essere piu dinamici, oppure ancora meglio magari quando le cose sono troppo
> grandi le manda come file del vault?»*.
>
> Restano marcate con la loro provenienza invece di essere assorbite in silenzio.
> Il punto dell'inventario non è essere completo al primo colpo — nessuna lista
> lo è. Il punto è che una lacuna, quando qualcuno la vede, **entri**. Ricerca in
> corso: `research/superfici-e-streaming.md`.

### C · Memoria e acquisizione → `gate1/c-memoria.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| C1 | Memory write | Ogni informazione importante viene acquisita? | ? |
| C2 | Extraction | L'estrazione è automatica? | READY (ADR-0038) |
| C3 | Consolidation | Si consolida senza intervento? | READY (ADR-0040) |
| C4 | Recall | Ripesca il vecchio **e** il superseded? | BLOCKER — `--history` non fa niente |
| C5 | Provenance | Posso capire **perché** crede una cosa? | ? |
| C6 | Temporal graph | «Chi era X a maggio» | BLOCKER — niente date/surface/vicinato |
| C7 | PDF | Acquisisce documenti utili? | READY (ADR-0043) ⚠️ niente OCR |
| C8 | Audio | Gestisce le note vocali? | BLOCKER — nessuna trascrizione |

> **C7, cosa vuol dire `READY` qui.** PDF, DOCX e testo entrano **interi** nel
> piano evidence (`core/documents/`, `unpdf` 1.8.1), pagina per pagina, e il
> percorso vero ci arriva: allegato Telegram → `vault/inbox/` → reindex →
> episodi `kind='document'`. Il turno riceve una **vista compatta** — indice
> delle pagine + `document_read` per riaprirne una dal file — invece del
> documento intero. Provato end-to-end in
> `connectors/telegram/document-arrival.test.ts` con PDF veri costruiti byte per
> byte, e le stesse dieci asserzioni falliscono se si spegne il parser.
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

### E · Economia e osservabilità → `gate1/e-osservabilita.md`

| # | Area | Domanda Gate 1 | Stato |
|---|---|---|---|
| E1 | Budget | Cap globale **e** per-job? | BLOCKER — il per-job non esiste |
| E2 | Cost | So quanto costa una giornata? | ? |
| E3 | Tracing | Posso ricostruire cosa è successo? | ? |
| E4 | Tests | Acceptance test **reali**, non solo unit? | BLOCKER |
| E5 | Failure | Ogni fallimento importante è esplicito e recuperabile? | ? |

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

## §2 · `wait` e `todo` sono primitive del runtime, non tool

```
WAIT → persisti lo stato → rilascia l'esecuzione → scheduler/evento → riprendi
```

Un `await sleep()` dentro il processo cognitivo **non** è `wait`: è una funzione
async molto lunga, ed è precisamente la differenza fra un Muffin vivo e un
Muffin lanciato da terminale. Stessa cosa per `todo`: il modello operativo non è
`goal → turn → done` ma `goal → plan → todo{done|blocked|waiting|retry|pending}
→ resume`.

---

**Il lavoro finisce quando l'inventario ha zero BLOCKER e ogni voce è READY o
FUORI DAL GATE 1 con la ragione scritta.** Solo allora si propone il Gate 1 —
e da lì lo sviluppo lo guidano i problemi che l'owner incontra vivendoci, non le
feature immaginate davanti a una lavagna.
