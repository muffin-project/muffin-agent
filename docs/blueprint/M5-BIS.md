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
| B13 | Progress | Un turno lungo dice di essere vivo in modo **strutturale**, non cosmetico? | ? 🔭 |
| B14 | Attachment | Un file prodotto arriva come **allegato**, o come percorso da copiare a mano? | BLOCKER 🔭 — `sendDocument` scritto, nessun chiamante |
| B15 | Owner binding | Ogni surface riconosce l'owner solo da un subject-id stabile autenticato e protetto? | BLOCKER — Telegram usa `from.id`, ma il binding è config ordinaria e il registry multi-surface non è integrato |
| B16 | Ingress parsing | **Ogni** campo letto entra tipizzato con provenienza/taint, inclusi nomi, bio, metadata, immagini e derivati? | BLOCKER — envelope universale assente; parse non significa trusted |

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
> parsare un contenuto non lo rende sicuro. Il test di impersonazione Telegram
> prova già che display name e chat non eleggono l'owner; manca ancora la forma
> che obblighi ogni futura surface a fare lo stesso e che impedisca a bio,
> filename, metadata, OCR o trascrizioni di entrare come stringhe senza fonte.

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
| C9 | Pressure | L'agente sa **quanto spazio gli resta**, dentro il prompt? | ? 🔭 |
| C10 | World state | Distingue ciò che vale adesso da episodi, credenze e lavoro? | OUT — post-Gate 1, consumer prima dello schema (ADR-0045) |

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
> sola suite (12 scenari, **~17s** misurati in locale); gira anche in CI,
> job separato (`.github/workflows/accettazione.yml`, su push `dev`/`main` e
> `workflow_dispatch` — non su ogni push di PR, per lo stesso motivo di budget
> che governa `ci.yml`).
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
completamento. Il worktree `slice/turno-sospeso` contiene un'implementazione in
corso, non committata: finché non passa integrazione, cablaggio e accettazione,
B2–B5 restano BLOCKER.

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
