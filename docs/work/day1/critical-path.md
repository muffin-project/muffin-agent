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
0  dogfood reale — parte subito, in parallelo
        ↓
1  le righe: il soffitto viene dalla riga di effetto (ADR-0053) — fatto
        ↓
2  le superfici che il dogfood ha bocciato (memo dogfood-superfici 03/09):
   2a Telegram: una bolla per segmento, ASK intero, `description` su shell_run
   2b CLI: scroll region, casella e stato in fondo
   2c input mentre un turno è vivo: coda, /steer, /stop, /pause, /resume (ADR-0054)
   2d la corsia end-to-end REALE (modello e Bot API veri, in locale)
        ↓
3  le due porte ancora fuori dal kernel: risposta e scrittura di memoria
   — meccanismo sul ramo (ADR-0055): sono capability dichiarate dal kernel e
     tracciate a ogni giro; nessun permesso è cambiato, e a decidere i permessi
     resta il punto 4
        ↓
4  le colonne: eval di sicurezza, adapter B + corpus avversariale sul binario
        ↓
5  undo semantico (l'altra metà di D11)
        ↓
6  battery finale e revisione indipendente del dev integrato
```

Il punto 2 precede le porte perché è ciò che rende il dogfood **sopportabile**:
senza, l'owner torna al vecchio agente prima che il punto 3 serva a qualcuno.
2d va costruita con 2a e non dopo: è la prova che 2a e 2b chiedono.

Stato al 03/09: 2a (#298) e 2b (#299) su `dev`; 2c in PR (#300, profilo
CRITICAL, aspetta la revisione indipendente); 2d **costruita**
(`evals/e2e/telegram.ts`) e da eseguire dall'owner — il passo che chiude
B11/B13/B2 è quella corsa, non un'altra PR.

Righe e colonne sono domande separate, e questa è la ragione dell'ordine. La
**riga** dice dove finiscono i byte di un effetto, e ADR-0053 l'ha resa
eseguibile: la matrice normativa era prosa, il kernel decideva da una classe di
rischio più un numero appuntato a mano, e le due erano divergiute su una cella
che il documento chiamava `ASK` da un mese. La **colonna** è il taint
ambientale, ed è l'ipotesi non falsificata di `docs/SECURITY.md` §13: si chiude
con l'eval comparativo, non con una decisione scritta prima. Le righe
sopravvivono a qualunque risposta l'eval dia.

I prerequisiti vocali sono sulla macchina dell'owner dal 02/09 e `doctor` li
controlla; la promozione `dev → main` e `muffin update` sono stati eseguiti lo
stesso giorno (build installata `dd38d40`): non sono più passi.

L'ordine è cambiato di nuovo il 02/09, e stavolta la causa è più a monte: il
soffitto di `fs.write` non è più il primo passo perché **non è chiaro che sia il
difetto**. La memo di decisione
(`docs/evidence/decision-memo-taint-2026-09-02.md`) misura che il gate più
stretto sta sulla porta più innocua — la scrittura locale reversibile con
journal — mentre la risposta in chat e la scrittura di memoria non passano
affatto dal kernel. Finché l'eval non dice se il segnale di autorità è
sbagliato o solo tarato male, spostare un numero sarebbe rispondere prima di
aver misurato. La metà di undo di D11 resta dietro quella decisione per la
ragione di prima: ripara un percorso che oggi nessun turno raggiunge.

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

**CHIUSO il 02/09 da ADR-0053, e non scegliendo fra A, B e C.** Le tre opzioni
erano varianti della stessa forma — tieni lo scalare, sposta il numero — cioè
la forma che aveva prodotto il guasto. La memo
`docs/evidence/decision-memo-taint-2026-09-02.md` ha misurato che il gate più
stretto stava sulla porta più innocua; la ricostruzione ha poi trovato la causa
a monte: la matrice normativa dà a `fs.write` una riga che a taint 2 dice `ASK`,
e il kernel non eseguiva quella tabella. Ora la esegue, e la cella non è stata
scelta: era già scritta. Il testo qui sotto resta come storia della decisione.

**Il bivio, come era istruito il 02/09.** `sys.shell` è `high` con
`maxTaint: 2` (revisione ADR-0044 del 16/08): dopo una lettura è un ASK.
`fs.write` è `medium` + `undoable` con il soffitto di classe 1: dopo una
lettura è un DENY. Quindi oggi, in un turno che ha letto un file, l'unico modo
di scriverne un altro è la shell — la porta **senza** checkpoint e senza undo —
mentre la porta con il journal è chiusa. Il sink è lo stesso (il disco dentro
lo scope), ma la porta sicura è quella negata. ADR-0044 §«Reversibilità» dice
già dove si interviene: il soffitto della capability che agisce, non il tier
della lettura.

**La classe è più larga di `fs.write`, e su Telegram è permanente** (revisione
indipendente del 02/09): a taint 2 sono DENY secchi tutte le capability
`medium` senza `maxTaint` proprio — `fs.write`, `surface.send_file`,
`skill.read` (`maxTaint: 1`), `sys.process.list` — e ogni URL fuori allowlist.
Il taint non nasce solo dalla lettura del turno: la history reiniettata
(finestra di 40 messaggi, `agent/context/history-taint.ts`) porta il turno a 2
prima che l'owner scriva — misurato sulla sessione Telegram reale, 17 messaggi
tier-2 su 40 — e la sessione Telegram è una per chat, quindi solo `/new` la
pulisce. La CLI lo evita solo perché ogni `muffin` apre una sessione nuova.

**Misurato il 02/09, prima di toccare qualunque soffitto**
(`evals/acceptance/scenarios/b-parita-superfici.accept.ts`, binario vero): a
parità di principal, tenant, history e richiesta, `leggi dati.txt` → `scrivi
esito.txt` decide **identico** su CLI, REPL e Telegram — taint 2,
`taint_exceeded`, file non scritto. Non c'è nessuna divergenza
superficie/kernel: la sola variabile è la sessione, e infatti la stessa CLI
con una sessione nuova al secondo turno scrive a taint 0. Il finding si
enuncia così:

> *Surface-specific session lifetime → different context → different ambient taint.*

Ma la stessa misura chiude anche la domanda successiva, ed è la ragione per
cui il bivio resta: `leggi → scrivi` **dentro un turno solo, su una sessione
appena aperta e senza un byte di history**, è ugualmente `taint_exceeded`. Il
taint sale dentro il turno alla lettura (`DISK_TIER` = 2) e il soffitto della
capability che scrive è 1. Quindi nessuna riforma di *quale* conversazione
viene reiniettata — una `Conversation` distinta dalla `Surface`, per dire —
può aprire questo percorso: cambierebbe il taint **ambiente**, non quello che
la lettura stessa produce. La vita della sessione spiega perché la CLI
sembrava sana e Telegram no; non spiega il fallimento. Il soffitto sì.

Le opzioni restano dell'owner (confine di sicurezza):

| opzione | cosa cambia | costo |
|---|---|---|
| A. `maxTaint: 2` sulla classe, `draft` automatico anche a taint 2 | scrive/invia senza chiedere, con checkpoint+undo dove c'è | un file letto può far scrivere un altro file nello scope senza che l'owner lo veda (es. `.git/hooks/`) |
| B. `maxTaint: 2` sulla classe, `draft`/`allow` solo a taint 0, ASK sopra | parità con la shell più il checkpoint: l'ASK mostra path/byte, poi scrive revocabile | un ASK in più per ogni write/invio in un turno a taint 2 |
| C. lasciare com'è | niente | read→write resta nella shell senza undo; `send_file` e le skill restano chiusi su Telegram; D11 irraggiungibile |

**Raccomandazione: B**, sull'intera classe e non su `fs.write` sola: è il
precedente di ADR-0044 per la shell applicato alle porte che hanno il journal;
l'egress non si tocca (`sys.http` fuori allowlist resta DENY a taint ≥ 2) e la
monotonicità della provenienza resta. Entra come emendamento di ADR-0044 e del
threat model (`03` §3, riga «filesystem host · taint 2 · DENY»), in
`agent/tools/*.ts` e in `decide.ts`, con il costo dichiarato come test (come
`shell.test.ts` §«il costo»), profilo CRITICAL. Nel dato niente diventa
irreversibile. **La decisione minima: A, B o C.**

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

### Le righe di sola evidence sono chiuse per journey

Le diciassette righe che aspettavano solo uno scenario sono state chiuse il
02/09 da quattro journey sul binario vero (lifecycle, memoria/documenti,
capability, Telegram su gateway vivo). Restano due righe della stessa famiglia
che l'harness non raggiunge ancora — B10 (immagini) e C8 (nota vocale) — perché
il finto Bot API non serve `getFile`: la dipendenza è un'estensione
dell'harness, non un meccanismo di prodotto. Una riga rossa solo per evidence
riceve evidence, mai un subsystem.

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
