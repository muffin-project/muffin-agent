# Percorso critico DAY-1

Questo file possiede **ordine e dipendenze**, non lo stato. Lo stato dei
requisiti vive solo in `docs/work/day1/requirements-status.md`; il lavoro vivo in
Git + `docs/work/handoff.md`; le deliberate deferral in `docs/ROADMAP.md`.

La regola è: una cosa compare qui soltanto se **deve precederne un'altra**. Se è
solo un finding, un follow-up o una feature desiderabile, non è percorso
critico.

## Fase corrente

La milestone **RETURN TO OWNER è conclusa**: l'installazione reale è stata
eseguita e non è più “il prossimo passo”. La cronaca delle slice chiuse e delle
promozioni resta in Git/PR e nella history, non in questo file — la regola di
manutenzione in fondo lo dice, e una data copiata qui era già sbagliata.

Il progetto è nella convergenza immediatamente precedente/al principio del
**dogfood reale**: abbastanza vicino all'uso da far ordinare il lavoro ai
failure osservati, ma con due problemi di Effects/Authority già misurati che
vengono prima di allargare capability o architettura.

## Ordine corrente

```text
1  decisione owner: il soffitto di fs.write dopo una lettura
        ↓
2  undo semantico (l'altra metà di D11, raggiungibile solo dopo 1)
        ↓
3  prerequisiti reali sulla macchina dell'owner, detti da doctor prima
   che servano (note vocali: whisper.cpp, ffmpeg, modello)
        ↓
4  dogfood reale e backlog guidato dai fallback
        ↓
5  journey integrate / battery finale quando una claim lo richiede
```

L'ordine 1 → 2 si è invertito il 02/09 per una misura, non per gusto: sul
database dell'owner `fs.write` non è mai stata eseguita, e la metà di undo che
riallinea il turno ripara un percorso che oggi nessun turno raggiunge. Prima si
apre la porta, poi si ripara ciò che c'è dietro.

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

PR #186 è chiusa senza merge (30/08, SALVAGE: miniera, non rebase) e il ramo
`slice/undo-riallinea-il-turno` resta. Quella metà si reimplementa su HEAD
**dopo** il punto 1, perché oggi ripara un percorso che nessun turno raggiunge.
`requirements-status.md` possiede lo stato D11.

### Decidere il workflow locale read → write

**È un bivio dell'owner, e il 02/09 è istruito.** `sys.shell` è `high` con
`maxTaint: 2` (revisione ADR-0044 del 16/08): dopo una lettura è un ASK.
`fs.write` è `medium` + `undoable` con il soffitto di classe 1: dopo una
lettura è un DENY. Quindi oggi, in un turno che ha letto un file, l'unico modo
di scriverne un altro è la shell — la porta **senza** checkpoint e senza undo —
mentre la porta con il journal è chiusa. Il sink è lo stesso (il disco dentro
lo scope), ma la porta sicura è quella negata. ADR-0044 §«Reversibilità» dice
già dove si interviene: il soffitto della capability che agisce, non il tier
della lettura.

Le opzioni restano dell'owner (confine di sicurezza): alzare `fs.write` a
`maxTaint: 2` lasciando `draft` automatico anche a taint 2; alzarlo a 2 ma con
`draft` solo a taint 0 e ASK sopra — parità con la shell, più il checkpoint;
oppure lasciare tutto com'è. La raccomandazione e le conseguenze stanno nel
handoff finché l'owner non decide; poi la decisione entra come emendamento di
ADR-0044 e in `agent/tools/fs.ts`, con il costo dichiarato come test come per
la shell.

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

### I requisiti sono riconciliati; le righe di sola evidence si chiudono per journey

La rilettura riga per riga contro HEAD è stata fatta il 02/09 e vive nel
banner datato di `requirements-status.md`. Quello che ne esce come dipendenza:
diciassette righe aspettano soltanto uno scenario di accettazione sul binario
vero, e vanno chiuse per **journey reale** (lifecycle/install/backup ·
memoria/documenti · shell/processi · Telegram · tracing), non una PR per riga —
lo stesso scenario può chiudere più righe se attraversa gli stessi confini.
Una riga rossa solo per evidence riceve evidence, mai un subsystem.

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

## Cluster DAY-1 quando diventano il prossimo problema

Questi cluster preservano dipendenze utili, ma **non sono uno sprint pre-caricato**.
Lo stato di ogni riga resta in `requirements-status.md`.

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
riparazione. Git/PR possiede il lavoro vivo; `requirements-status.md` lo stato; ROADMAP la fase;
`docs/history/` e `docs/evidence/lessons.md` il passato e ciò che abbiamo imparato.
