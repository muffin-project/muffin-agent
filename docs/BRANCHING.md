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

## Cosa NON abbiamo, e perché va saputo

**Nessuna protezione su `main`.** `gh api .../branches/main/protection` risponde
403: serve GitHub Pro o un repo pubblico. Quindi *"solo un merge da `dev` scrive
su `main`"* è una convenzione, non un vincolo — chiunque abbia accesso può
pushare direttamente, e nessun meccanismo lo ferma.

Detto qui perché la regola sopra sembra applicata e non lo è. Quando il repo
diventerà pubblico, o con Pro, la protezione va accesa: è il gradino quattro
della scala di `PRACTICES.md` §6 per una regola che oggi sta al gradino uno.

**Nessuna CI.** Non esiste `.github/workflows`. Build e test girano perché
qualcuno li lancia. Stesso discorso: la regola 3 è disciplina, non cancello.
