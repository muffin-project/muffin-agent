# Criteri di readiness DAY-1

Questo documento possiede una sola domanda:

> **Quando può iniziare davvero il giorno 1 dei quattordici?**

La direttiva owner originale del 17/08/2026, molto più lunga e comprensiva di
workflow, findings e checklist allora correnti, è preservata integralmente in
`docs/history/day1-2026-08-19/MANDATO-DAY-1-originale.md`. Quello snapshot spiega
come siamo arrivati qui; questo file governa l'uscita corrente.

## Goal

Porta Muffin allo stato in cui l'owner può installare la build verificata sulla
propria macchina reale e, da quel momento, iniziare con fiducia **14 giorni
consecutivi usando Muffin come unico agente personale quotidiano**, senza un
limite, failure silenzioso, problema di continuità, sicurezza, durability o
capability fondamentale già conoscibile che lo costringa a tornare al vecchio
Muffin o a un altro agente general-purpose.

Il goal non è completare una checklist, far passare una suite o chiudere un
numero di PR. `requirements-status.md` è l'inventario che rende falsificabile il goal; non è
il goal stesso.

Questa generazione parte con **memoria nativa nuova** (ADR-0049). Non importare
il database personale del vecchio Muffin non è un fallback e non è un blocker
DAY-1: il vecchio agente è predecessor/archive, non la memoria nativa di questa
generazione.

## DAY-1 READY

Prima di iniziare il giorno 1 devono essere vere tutte queste proprietà:

1. **Inventario personale chiuso.** `docs/status/day1/requirements-status.md` non contiene
   alcun `BLOCKER` per la finestra dei quattordici giorni e nessuna domanda
   lasciata senza una classificazione esplicita. Una riga `OUT` deve avere una
   ragione concreta legata alla finestra, non alla difficoltà di implementarla.
2. **Le claim sono osservate, non dichiarate.** Ogni riga READY ha l'evidence
   budget richiesto dal proprio Verification Profile in
   `docs/development/ORCHESTRATION.md`. Il profilo dipende dalla garanzia e dal blast radius,
   non da una DoD universale.
3. **Il percorso di produzione è quello provato.** Una primitive non chiude una
   riga se il runtime/surface reale non la raggiunge. Per security, durability,
   exactly-once, crash recovery ed effetti, la failure path fa parte della
   claim.
4. **Nessun critical/high corrente è ignorato.** Un finding rilevante è chiuso,
   invalidato con evidence o accettato deliberatamente dall'owner dopo averne
   capito il costo.
5. **Le fonti autorevoli concordano.** Codice/schema/config possiedono la
   meccanica; `ARCHITECTURE.md` e `SECURITY.md` la semantica corrente;
   `requirements-status.md` lo stato dei requisiti. Se la prosa è sbagliata si
   corregge la prosa, non si implementa
   ciecamente una promessa storica.
6. **L'installazione dell'owner è la prova finale.** La build candidata viene
   realmente installata/aggiornata sull'installazione che sarà usata, non solo
   in un HOME temporaneo. `muffin doctor` è sano oppure ogni warning residuo è
   compreso e deliberatamente accettato.
7. **Il sistema integrato viene giudicato come insieme.** Dopo le slice, un
   ultimo audit indipendente parte dal `dev` integrato e cerca una ragione
   concreta per cui l'owner uscirebbe da Muffin durante i quattordici giorni.
8. **Domani non serve sviluppare prima di usare.** Quando DAY-1 è raggiunto, il
   prossimo atto normale è usare Muffin, non implementare un requisito già
   noto.

## La domanda terminale

Prima di dichiarare raggiunto il goal, un reviewer a contesto fresco deve
rispondere a questa domanda:

> **Se l'owner da oggi vive dentro Muffin per 14 giorni, quale problema concreto
> già conoscibile lo farà uscire?**

Se esiste una risposta che soddisfa il criterio, DAY-1 non è raggiunto.

## Cosa questo mandato non possiede

- **Status delle singole righe** → `docs/status/day1/requirements-status.md`.
- **Ordine dei blocker** → `docs/status/day1/critical-path.md`.
- **Lavoro/PR correnti** → Git osservato + `docs/development/handoff.md`.
- **Come verificare FAST/STANDARD/CRITICAL** → `docs/development/ORCHESTRATION.md`.
- **Security/architecture correnti** → `docs/architecture/SECURITY.md` e
  `docs/architecture/ARCHITECTURE.md`.
- **Findings/audit storici** → `docs/evidence/` e `docs/history/`.

Se una nuova lacuna viene scoperta e soddisfa il criterio dei quattordici giorni,
entra nei requisiti DAY-1. «Non ci avevamo pensato» non è una ragione per rimandarla; non è
nemmeno una ragione per gonfiare questo mandato con una nuova checklist.

## Il goal termina all'inizio, non alla fine, dei quattordici giorni

Non simulare né dichiarare completata la finestra. Il primo goal termina quando
**DAY 1 può iniziare realmente**. Da quel momento l'uso reale diventa la fonte
principale per la roadmap: ogni fallback, attrito o capability mancante osservata
vale più di una feature immaginata prima del dogfood.