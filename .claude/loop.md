# Il control loop di Muffin

Porta Muffin al **DAY-1 READY** definito in `docs/blueprint/M5-BIS.md`, poi
accompagna i quattordici giorni d'uso reale senza perdere il lavoro parallelo
su gruppi, M6 e M7. Non eseguire una manutenzione generica: scegli il prossimo
obiettivo dal percorso critico e chiudilo secondo `docs/ORCHESTRATION.md`.

## 1. Prima di scegliere — il minimo, non tutto

Il contesto è una risorsa: si carica ciò che la task rende load-bearing, non
tutto il repo a ogni giro (`ORCHESTRATION.md` §6).

All'inizio normale di una sessione bastano:

1. `CLAUDE.md` (la mappa) e il blocco START HERE, che arriva già iniettato.
2. Lo **stato osservato**: `node .claude/deleghe.mjs riprendi` — deleghe aperte,
   chiuse, **parcheggiate** (uccise da quota o 529: da rilanciare dal brief su
   disco, non da ricostruire a memoria) e la diagnosi dello stato danneggiato
   che una sessione morta lascia dietro (merge o rebase a metà, marcatori di
   conflitto, toolchain inutilizzabile, commit non pushati). Poi branch, PR e
   loro check. Una PR in review o un `ADJUST` aperto viene prima di nuovo
   lavoro; uno stato danneggiato viene prima di tutto.
3. `docs/blueprint/gate1/PERCORSO-CRITICO.md` — §0 «In volo adesso» e la voce
   che stai per prendere.
4. La riga o le righe di `docs/blueprint/M5-BIS.md` che quella voce tocca.

Se documenti e stato osservato divergono, **correggi prima il handoff**: una
sessione fresca deve poter capire da sola dove siamo. `node
.claude/riconcilia.mjs` lo dice meccanicamente.

Delegare non è il default: una task piccola e locale la fa l'orchestratore, e un
subagente costa un contesto intero per ricostruire ciò che qui è già noto. Prima
di un ventaglio, `node .claude/deleghe.mjs preventivo <n>` dà il costo misurato
sulle deleghe già fatte — e se è materialmente costoso la decisione è dell'owner
(`ORCHESTRATION.md` §2), non una cosa da scoprire a metà. Ogni delega si registra
**prima** che parta; una che muore per quota si parcheggia invece di sparire.

## 2. Cosa caricare quando

| se la task tocca… | leggi anche |
|---|---|
| taint, provenienza, egress, capability | `03-threat-model.md`, `core/policy/*`, ADR-0044 |
| memoria, recall, estrazione | `knowledge/`, ADR-0038/0040/0045, `core/memory/*` |
| schema, migrazioni, durabilità | `09-contratti-m0-m1.md`, gli ADR dello store toccato |
| turno, lane, gateway, scheduler | ADR-0022/0035/0042/0047 |
| identità, prompt, RoT | `defaults/`, ADR-0011, `core/rot/*` |
| una review da fare | `docs/JUDGE.md` |
| come si scrive qui | `docs/PRACTICES.md` |
| come si integra | `docs/BRANCHING.md` |

`THESIS.md` e `DESIGN-PRINCIPLES.md` si leggono quando è in gioco **cosa** stiamo
costruendo o **perché**, non per correggere un typo. La repo deve insegnare dove
andare, non obbligare ogni sessione a leggere tutto.

## 3. Classifica prima di implementare

Scegli il profilo di verifica (`ORCHESTRATION.md` §17) e **scrivilo nella PR**.
Non lo decide la dimensione del diff: lo decide il rischio della garanzia.

- La claim tocca effect WAL/journal · effetti irreversibili o non ri-eseguibili ·
  authority/capability/policy kernel · taint/provenienza · egress · Root of Trust
  · segreti · schema durevole/migrazioni · backup-restore · concorrenza/lock ·
  exactly-once/idempotenza · crash recovery che può duplicare o perdere lavoro ·
  sandbox/containment · operazioni distruttive?
  → **CRITICAL**: disciplina piena, judge fresco, verdetto terminale.
- È documenti, stato, viste generate, soli test, formattazione, una correzione
  meccanica che non cambia comportamento né contratti?
  → **FAST**: check pertinente, diff letto, CI. Più FAST indipendenti possono
  stare in una sola maintenance PR.
- Tutto il resto (prodotto/runtime reversibile) → **STANDARD**: solo l'evidenza
  che la claim richiede; suite completa una volta in CI; integra l'orchestratore.

Nel dubbio fra STANDARD e CRITICAL, guarda cosa succede **se la garanzia si
rompe in silenzio**: se la risposta contiene perdita dati, effetti duplicati,
autorità violata o unsafe silenzioso, è CRITICAL.

## 4. Come scegli l'obiettivo

- Prima rendi possibile il giorno 1: continuità del turno e del lavoro;
  autorità/taint; superficie privata e delivery; memoria; acceptance reale.
- Chiudi prima le decisioni di schema: dal giorno 1 i dati non si resettano più.
- Durante i quattordici giorni continua a correggere ciò che emerge e prepara i
  gruppi in parallelo; non attivare i gruppi prima del checkpoint previsto.
- Una decisione prodotto, sicurezza, privacy, schema o irreversibile richiede
  opzioni, costi e una domanda precisa all'owner. Non scegliere in silenzio.

## 5. Ogni pezzo considera l'intero sistema

Prima di implementare, traccia produttori, consumer, failure path e viste
derivate della garanzia. Controlla anche branch e worktree non integrati per non
duplicare una primitiva o sovrascrivere lavoro migliore.

Un valore valido oggi per `host`, Telegram, una chat privata, un modello o una
macchina non diventa una costante per comodità. Autorità, tenant, surface,
provider, budget, percorso e capability attraversano i confini come dati
tipizzati o configurazione. Il default single-user è una configurazione della
forma generale, non un secondo percorso cognitivo. Nessuna surface può eleggere
l'owner da nomi, bio, username, stanze, foto o contenuto; ogni campo letto resta
input potenzialmente iniettato anche dopo parsing.

## 6. Resta dentro la claim

Se emerge un altro problema, entra in questa slice solo se invalida la claim, ne
impedisce la verifica, crea un rischio Day-1 concreto, o è tecnicamente
inseparabile (`ORCHESTRATION.md` §18). Altrimenti registralo come follow-up e
chiudi ciò che stai facendo.

## 7. Come chiudi un'iterazione

Chiuso = **claim soddisfatta + evidence budget del profilo soddisfatto + nessun
blocker noto che la invalidi**. Commit recuperabili, PR con profilo ed evidenza
scritti, CI verde; FAST e STANDARD li integra l'orchestratore, CRITICAL richiede
il verdetto terminale di un judge fresco.

Dopo l'integrazione riconcilia il handoff — `PERCORSO-CRITICO.md`, l'evidenza
delle righe M5-BIS toccate, START HERE se cambia davvero — e ricostruisci lo
stato prima di scegliere altro. Non aggiornare per riflesso i documenti che il
cambiamento non ha reso stale (`ORCHESTRATION.md` §19).

Non dichiarare DAY-1 READY perché il codice compila: richiede zero BLOCKER
nell'inventario personale, un percorso reale provato come lo userà l'owner e
nessun lavoro integrato soltanto per affermazione.
