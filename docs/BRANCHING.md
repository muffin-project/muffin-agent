# Rami

Due permanenti, e i rami di lavoro sono usa-e-getta.

```
main ←── dev ←── slice/<cosa>
```

| | cosa contiene | chi ci scrive |
|---|---|---|
| **`main`** | ciò che è stato **revisionato e verificato**. È la risposta a "cosa regge". | solo un merge da `dev` |
| **`dev`** | l'integrazione: slice arrivate, verdi, non ancora giudicate tutte insieme | merge dalle slice |
| **`slice/<cosa>`** | un cambiamento coerente, vita breve | chi lavora |

## Perché due e non uno

Per un progetto a un solo autore la risposta di default sarebbe **uno**: main più
rami di feature brevi. `dev` aggiunge un passaggio, e un passaggio senza scopo
diventa cerimonia da saltare.

Il suo scopo qui è preciso: **`dev` è dove una slice sta mentre viene giudicata,
e `main` è dove arriva dopo.** Prima di questa separazione cinque PR sono restate
aperte per un giorno intero mentre `main` non si muoveva, perché non c'era un
posto dove una cosa potesse essere *finita ma non ancora approvata*. Con `dev`
quel posto esiste, e `main` smette di essere l'unica misura di progresso.

Se un giorno il giudizio diventa automatico e istantaneo, `dev` perde il suo
scopo e va tolto. Un ramo si tiene finché risponde a una domanda.

## Le regole

1. **Il lavoro non nasce su `main` né su `dev`.** Nasce su `slice/<cosa>`.
2. **Una slice è coerente**, non "tutto quello che ho fatto oggi". Il metro:
   riesci a scrivere il titolo della PR senza usare "e"? L'eccezione dichiarata
   sono i FAST indipendenti — typo, ancore stale, viste rigenerate — che possono
   stare insieme in **una** maintenance slice, purché restino leggibili e
   verificabili separatamente: una PR per riga meccanica è essa stessa ceremony.
   STANDARD e CRITICAL restano centrati su una claim sola.
3. **Una slice entra in `dev` verde**, e «verde» dipende dal suo profilo di
   verifica (`ORCHESTRATION.md` §17, scelto **prima** di implementare e scritto
   nella PR): FAST vuole il check pertinente e il diff letto; STANDARD vuole
   l'evidenza che la claim richiede più la suite completa **una volta**, in CI;
   CRITICAL vuole la disciplina piena, red-first e mutazione sulla cucitura
   portante inclusi. La CI resta il gate meccanico per tutte e tre.
4. **Da `dev` a `main` si passa solo per un verdetto terminale** — `MERGE`,
   oppure `BLOCKED`/`REJECT` che rimandano indietro (`docs/JUDGE.md`).
5. **Niente stack profondi.** Le PR impilate di 5 livelli hanno prodotto rebase
   a catena, conflitti risolti da automatismi che hanno silenziosamente disfatto
   fix corretti, e un commit atterrato nella PR sbagliata. Se una slice dipende
   da un'altra, si aspetta che la prima entri in `dev`.
6. **Il ramo si cancella al merge**, locale e remoto. Un ramo mergiato che resta
   è un invito a ripartire da uno stato vecchio.

## Commit, PR e checkpoint

Una slice non resta una massa non recuperabile fino alla fine. I checkpoint
sono decisi **prima** del lavoro e hanno una prova osservabile:

1. **Decisione fissata** — scope e, se serve, ADR sono leggibili. Si apre una PR
   draft; il link entra nello stato. Prima di questo punto il lavoro può ancora
   cambiare forma senza fingere stabilità.
2. **Meccanismo raggiunto** — il percorso di produzione arriva al cambiamento e
   il test di wiring fallisce senza quella cucitura. Si crea un commit coerente
   e si aggiorna la PR; non serve aspettare tutta la slice per avere un punto di
   ripresa.
3. **Slice verificata** — `npm run build`, `npx vitest run`, scenario di
   fallimento, accettazione richiesta, documenti/stato e viste derivate sono
   aggiornati. La PR esce da draft e chiede il verdetto di `JUDGE.md`.
4. **Integrazione** — per profilo (`ORCHESTRATION.md` §17; decisione owner
   2026-08-17): **FAST e STANDARD** li integra l'orchestratore quando l'evidence
   budget del profilo è soddisfatto e la CI è verde, scrivendo nella PR i comandi
   eseguiti e il loro esito. **CRITICAL** richiede il verdetto terminale `MERGE`
   di un judge nuovo, a contesto fresco (`JUDGE.md`) — è lì che un contesto
   indipendente compra qualcosa che chi ha scritto il codice non può comprarsi da
   solo. Il passaggio `dev`→`main` resta un checkpoint separato: suite
   sull'insieme integrato e review dell'insieme.

   **Deroga temporanea, 2026-08-18 — la CI non gira.** I 2.000 minuti/mese del
   piano Free sono esauriti e nessun workflow parte (repo privato; `ci.yml`
   documenta il vincolo). Decisione dell'owner: *«per adesso mergiamo così, non
   siamo ancora pronti per la repo pubblica»*. Finché dura, **il gate meccanico
   è la verifica locale**, e va scritta nella PR con i comandi: `npm run build`,
   `npx vitest run`, `npm run test:acceptance`, `npx tsx
   evals/acceptance/report.ts`, `node docs/blueprint/mappa/ancore.mjs --check`.
   Vale per FAST e STANDARD come per CRITICAL, che continua a volere anche il
   judge fresco. Non è un allentamento del profilo: è lo stesso insieme di
   prove, eseguito dove può girare. Quando i minuti tornano — nuovo ciclo, minuti
   a pagamento, o repo pubblica — questa deroga si cancella e la CI torna il
   gate.

   **L'integrazione include la riconciliazione del handoff**, non la rimanda: se
   il merge cambia lo stato di una slice o l'evidenza di una riga Gate 1, nello
   stesso passaggio si aggiornano `gate1/PERCORSO-CRITICO.md` §0 e la riga di
   `M5-BIS.md`, e `STATE.md` **solo se** cambia davvero obiettivo, blocker,
   decisione owner o PR attiva (`ORCHESTRATION.md` §19). Il controllo meccanico è
   `node .claude/riconcilia.mjs`: esce ≠ 0 se il percorso critico descrive come
   «in volo» una PR già mergiata o un branch già cancellato. Incrementare un
   contatore non è riconciliare: il difetto trovato dall'owner il 2026-08-17 era
   esattamente questo — il percorso critico mandava una sessione fresca a
   lavorare su slice già integrate.

“Commit continuo” non significa un commit per ogni file: significa che nessuna
unità verificabile o passaggio rischioso vive soltanto nel worktree. Un commit
deve poter essere descritto e verificato da solo. `WIP` è ammesso solo sulla
slice/draft PR, mai come requisito d'ingresso in `dev`. Un merge non è un gesto
periodico né automatico: avviene al checkpoint scritto, con la prova dello stato
che si sta promuovendo.

## Cosa NON abbiamo, e perché va saputo

**Nessuna protezione su `main`.** `gh api .../branches/main/protection` risponde
403: serve GitHub Pro o un repo pubblico. Quindi *"solo un merge da `dev` scrive
su `main`"* è una convenzione, non un vincolo — chiunque abbia accesso può
pushare direttamente, e nessun meccanismo lo ferma.

Detto qui perché la regola sopra sembra applicata e non lo è. Quando il repo
diventerà pubblico, o con Pro, la protezione va accesa: è il gradino quattro
della scala di `PRACTICES.md` §6 per una regola che oggi sta al gradino uno.

**La CI esiste, il gate no.** `.github/workflows/ci.yml` esegue typecheck e suite
su ogni PR e sui push a `dev`/`main`, col sandbox Linux richiesto. Questo rende
il risultato osservabile e ripetibile; senza branch protection non obbliga però
GitHub a richiedere il verde prima del merge o a impedire un push diretto.
Quindi la regola 3 ha un meccanismo di verifica, ma il suo enforcement resta una
convenzione finché la protection non può rendere il check obbligatorio.
