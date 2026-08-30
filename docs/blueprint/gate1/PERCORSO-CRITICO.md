# Percorso critico verso il dogfood

Questo file possiede **ordine e dipendenze**, non lo stato. Lo stato Gate vive
solo in `../M5-BIS.md`; il lavoro vivo in Git + `../LAVORO.md`; le deliberate
deferral in `../../ROADMAP.md`.

La regola è: una cosa compare qui soltanto se **deve precederne un'altra**. Se è
solo un finding, un follow-up o una feature desiderabile, non è percorso
critico.

## Fase corrente

La milestone **RETURN TO OWNER è conclusa**. L'installazione reale è stata
eseguita e la promozione `dev → main` è avvenuta il 27/08. Non sono più “il
prossimo passo”. La cronaca delle slice chiuse resta in Git/PR e nella history,
non in questo file.

Il progetto è nella convergenza immediatamente precedente/al principio del
**dogfood reale**: abbastanza vicino all'uso da far ordinare il lavoro ai
failure osservati, ma con due problemi di Effects/Authority già misurati che
vengono prima di allargare capability o architettura.

## Ordine corrente

```text
1  undo semantico
        ↓
2  read → transform → local write / taint
        ↓
3  riconciliazione Gate contro HEAD
        ↓
4  dogfood reale e backlog guidato dai fallback
        ↓
5  journey integrate / battery finale quando una claim lo richiede
```

### Chiudere la compensazione, non solo il restore

La parte fisica esiste: per gli effect reversibili supportati, Muffin prende il
checkpoint prima della mutazione e `muffin undo` può ripristinare il filesystem.

La claim che deve chiudersi prima è più larga:

```text
checkpoint/precondition
→ durable effect intent
→ execute
→ outcome
→ compensate/undo
→ Work + context + memory reconciliation
```

Dopo una compensazione la storia non deve presentare l'effetto come ancora
corrente, ma non deve nemmeno cancellare il fatto storico che l'effetto è
avvenuto ed è stato poi annullato. È una **compensating transaction / Saga**,
non un rollback che riscrive il passato.

La slice viva è `slice/undo-riallinea-il-turno` / PR #186. Git decide se è ancora
aperta: non creare una seconda implementazione parallela. `M5-BIS.md` possiede lo
stato D11.

### Decidere il workflow locale read → write

È già un failure osservato, quindi precede qualunque discussione astratta sulla
breadth dei tool: leggere un file porta oggi il turno a taint 2 e la scrittura
locale viene rifiutata dal soffitto della capability.

La decisione non è “sicurezza sì/no” e non si chiude spostando un numero finché
un eval diventa verde. Va separato almeno concettualmente:

```text
provenance/trust dei byte letti
≠ rischio dell'effetto proposto
≠ destinazione/sink dell'effetto
```

Un write confinato e reversibile nella root locale non è lo stesso sink di una
richiesta HTTP, una mail o altro egress. Qualunque rilassamento del workflow
locale deve lasciare intatte le garanzie anti-esfiltrazione e la monotonicità
della provenance.

La prova terminale è un percorso reale del tipo:

> leggi `spesa.txt` → calcola → scrivi `totale.txt` → verifica → undo

non un test isolato del valore di taint.

### Riconciliare il Gate prima di usare i conteggi per decidere

`M5-BIS.md` è l'unica authority degli status, ma alcuni suoi motivi sono rimasti
indietro rispetto a HEAD. Prima di usare “N BLOCKER” come criterio operativo va
riletto riga per riga contro codice, acceptance e PR correnti.

Casi già noti da verificare, non da aggiornare alla cieca:

- **A2/A3**: il character eval esiste ora e non perde più misure; resta da
  classificare cosa significano i fail e quale evidence manca davvero;
- **E7**: il vecchio motivo “`sys_inspect` è oltre il cap 10” non vale più dopo
  il passaggio del profilo a 14 tool;
- **D11**: dipende dallo stato effettivo della slice di undo semantico;
- conteggi e testo introduttivo devono essere ricalcolati dalle 55 righe, non
  modificati per differenza mentale.

Questa riconciliazione non autorizza nuovi subsystem. Se una riga è rossa solo
per evidence, la risposta è evidence.

### Da qui ordina l'uso

Durante il dogfood il segnale più forte è un fallback reale. Registrare almeno:

- apertura di un altro agente/app o interfaccia diretta;
- capability mancante o tool non raggiungibile;
- ASK ripetitivo o non consegnabile;
- errore/retry/recovery che richiede intervento manuale;
- memory miss, belief errata o contraddizione non gestita;
- lavoro promesso e dimenticato;
- costo, latency o pressione di contesto che cambiano davvero il comportamento;
- caso in cui la superficie non riesce a ricevere/steerare mentre Muffin lavora.

Un dolore ripetuto può promuovere un item da ROADMAP o riordinare un BLOCKER.
Senza evidence nuova, l'ordine non si espande.

## Cluster Gate quando diventano il prossimo problema

Questi cluster preservano dipendenze utili, ma **non sono uno sprint pre-caricato**.
Lo stato di ogni riga resta in M5.

### Effects / Authority

Prima la correttezza degli effetti, poi più potere:

1. ASK/approval durevole e legato al canonical plan;
2. retry coerente con rerunnability ed effect uncertainty;
3. owner/surface binding protetto dove ancora necessario;
4. spend/action bound per Work/capability quando l'uso lo richiede.

### Ingress / Surfaces

Receipt idempotente, composition e durable Work restano concetti distinti.
Busy-input (`COLLECT` / `STEER` / `FOLLOWUP` / `INTERRUPT`) viene implementato
contro consumer reali, senza inventare broker, tabella `Intent` o universal
media envelope prima che servano.

Voice/multimedia conserva sempre originale come Evidence e transcript/caption
come rappresentazione derivata con provenance.

### Capability mechanisms

Una capability entra prima quando la sua assenza costringe l'owner a operare
un'interfaccia direttamente. Non si costruisce un “E5 subsystem” o un “retry
framework” generico se la claim può essere chiusa nel percorso che fallisce.

### Evidence-only journeys

Raggruppare per journey reale, non una PR per riga: lifecycle/install/backup,
memory/documenti, shell/http/search, Telegram, identity/persona, tracing. Una
journey può chiudere più righe se attraversa davvero gli stessi confini.

## Battery finale

Quando serve dichiarare una fase pronta:

1. build/install/update sulla macchina target;
2. supervisor/restart/reboot dove la claim lo richiede;
3. provider, Telegram, rete, voice e altri servizi reali solo dove un fake
   cambierebbe la domanda;
4. `doctor`, `status`, `sys.inspect` sullo stato effettivo;
5. red-team integrato con la domanda: **“cosa mi costringe ancora ad aprire un
   altro agente/app?”**;
6. promozione secondo `BRANCHING.md` solo dopo le garanzie della fase.

## Fuori da questo ordine

Senza un consumer/failure che li promuova: active-active/multi-Home, scheduler
distribuito, Node platform generica, world-state generico, grande ecosystem di
extension, nuove strutture cognitive, riscrittura del runtime o cambio framework.
La loro eventuale fase è `ROADMAP.md`.

## Regola di manutenzione

Aggiorna questo file solo quando cambia una **dipendenza, causa radice o ordine**.
Non copiarci stato macchina, conteggi, dettagli di una PR chiusa o cronaca di una
riparazione. Git/PR possiede il lavoro vivo; M5 lo stato; ROADMAP la fase;
`docs/history/` e `docs/lessons.md` il passato e ciò che abbiamo imparato.
