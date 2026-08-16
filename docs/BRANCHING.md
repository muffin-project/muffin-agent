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
   riesci a scrivere il titolo della PR senza usare "e"?
3. **Una slice entra in `dev` verde**: `npm run build` e `npx vitest run` puliti,
   e i test nuovi verificati *rossi* prima del fix (`PRACTICES.md` §5).
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
4. **Integrazione** — solo un verdetto terminale `MERGE` autorizza il merge in
   `dev`. Il passaggio `dev`→`main` è un checkpoint separato: suite sull'insieme
   integrato e nuovo verdetto terminale.

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
