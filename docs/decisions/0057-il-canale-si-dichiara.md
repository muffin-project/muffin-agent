# ADR-0057 — Il canale si dichiara: `muffin update` sceglie il ramo e nomina sempre l'altro

**Stato:** accettato · 2026-09-03

## Contesto

Il failure è osservato, non ipotizzato. Il 2026-09-03, sulla macchina
dell'owner: il launcher `~/.local/bin/muffin` era un symlink dentro
`.releases/5c49f1e/dist/cli/main.js`, e `5c49f1e` **era** la testa di
`origin/main`. Quindi `muffin update` era già girato, era uscito 0, e aveva
detto «già aggiornato». Tutto vero.

Nello stesso istante `origin/dev` era avanti di **sette commit non-merge**,
compresa la correzione che l'owner stava aspettando. Ha dovuto fare `git pull`
a mano per vedere il codice nuovo.

Il comando non è rotto. **Il canale lo è.** `main` avanza soltanto quando un
umano apre e mergia una PR di promozione, e `muffin update` non sapeva
distinguere due situazioni opposte:

| situazione | cosa stampava |
|---|---|
| non c'è niente di nuovo | `già aggiornato: nessun commit di distanza da origin/main` |
| c'è parecchio, nessuno l'ha promosso | *gli stessi byte* |

La proprietà che l'owner vuole è una sola: **non sedersi davanti a una build
vecchia credendola corrente.**

## Il percorso reale, misurato prima di decidere

Tutto qui sotto è stato eseguito il 2026-09-03 contro il repository vero, non
dedotto dal YAML.

**1. La promozione è manuale e discontinua.** `gh pr list --base main` mostra
PR intitolate `promote: dev → main`, aperte a mano, con buchi di ore. Al
momento della misura la #318 era aperta e non mergiata, con `dev` avanti di 14
commit (7 non-merge).

**2. Nessun workflow parte sul push a `dev`.** I quattro workflow
(`ci.yml`/verifica, `accettazione.yml`, `collegamenti.yml`, `strumenti.yml`)
hanno tutti trigger `pull_request` e `push: branches: [main]`. La testa di
`ci.yml` documenta che il push a `dev` è stato **tolto apposta** per budget, e
nomina la finestra accettata: se `dev` avanza fra il run della PR e il merge,
il merge commit resta non provato.

**3. Le check run sulla storia di `dev` sono irregolari.** Interrogando
`repos/…/commits/<sha>/check-runs` sugli ultimi otto commit di `dev`:

| commit | check run | conclusion |
|---|---|---|
| `b316c41` | 4 | tutte success |
| `aafe0da` | 4 | **cancelled**, cancelled, success, success |
| `c009694` | 3 | success ×3 |
| `e3cc65d` | **0** | — |
| `ea25eb2` | 3 | success ×3 |
| `e12f677` | **0** | — (ed è un merge commit) |
| `7cb3238` | 2 | success ×2 |
| `432376a` | 3 | success, **failure**, success |

Tre fatti dentro quella tabella, e ognuno da solo basta:

- **zero check run non è verde.** Due commit su otto non hanno nulla da
  leggere. È la stessa forma della PR #107, mergiata con zero check;
- **il numero varia** (0, 2, 3, 4) perché i `paths` filtrano workflow diversi:
  «tutte success» non distingue «ha girato tutto ed è passato» da «non ha
  girato niente di rilevante»;
- **`dev` va rosso davvero** (`432376a`, una `failure`), e va `cancelled`
  (`aafe0da`, che è `cancel-in-progress`, non un guasto — ma non è `success`).

**4. Le check run che ci sono, le crea la promozione manuale.** `b316c41`, la
testa di `dev`, ha 4 check run soltanto perché la PR #318 (`dev → main`) è
aperta: l'evento `pull_request` attacca le run alla testa del ramo *head*. Un
cancello automatico che leggesse quelle conclusion leggerebbe il prodotto
dell'atto umano che stava automatizzando. È circolare.

**5. La protezione di ramo non è disponibile su questo piano.**
`gh api repos/…/branches/{main,dev}/protection` → **403**, «Upgrade to GitHub
Pro or make this repository public». Quindi niente required status check e
niente auto-merge di GitHub, che sarebbe stato l'unico cancello a *conclusion*
a costo CI zero.

## L'ipotesi con una storia

La testa di `cli/update.ts` diceva, verbatim: *«`main` is deliberately the
channel this reads from — `dev` stays where development happens; the two are
not the same question `muffin update` exists to answer.»* L'invariante che
proteggeva è reale e resta valida: **la PR di promozione fa girare l'intera CI
esattamente sull'albero che sta per diventare `main`**, ed è la verifica più
forte che questo repository produca (punto 4 sopra, letto al contrario).

Ciò che non era stato deciso è il resto: che il comando potesse **tacere**
sulla differenza fra i due rami. Quella non è una scelta registrata, è un
effetto collaterale.

## Tabella di decisione

| candidato | cosa fa alla proprietà dell'owner | costo quando `dev` è rotto | verdetto |
|---|---|---|---|
| **A — promozione automatica su check verdi** | eliminerebbe la staleness per costruzione | promuove il rosso a tutti, senza che nessuno l'abbia scelto | **rifiutato**: il cancello non è implementabile onestamente oggi (punti 2, 3, 4, 5). Un cancello a conclusion leggerebbe 0 check su due commit su otto e non saprebbe distinguere «tutto verde» da «niente ha girato» |
| **A′ — come A, ma aggiungendo i trigger `push: [dev]`** | idem | idem | **rifiutato**: paga un run pieno di CI a ogni merge in `dev`, che è esattamente ciò che `ci.yml` ha tolto apposta, su un piano da 2 000 minuti/mese |
| **B — promozione schedulata** | riduce la latenza, non la elimina | come A | **rifiutato**: stesso cancello inesistente di A, più un costo di sonda ricorrente per il caso normale in cui non c'è niente da promuovere |
| **C — il canale è una scelta dichiarata, e il comando nomina sempre l'altro** | l'owner non può *credere* di essere corrente: il numero e il ramo sono sullo schermo, con il comando che li installa | tocca solo chi ha scritto `--channel dev`, e la release è comunque costruita a fianco, smoke-testata, con backup e `--rollback` | **scelto** |
| **D — non toccare niente, migliorare solo la prosa** | nessuno | — | rifiutato: è il difetto |

Il punto che decide fra A e C non è il gusto: è che **A oggi non ha un cancello
da leggere**. Un cancello che si accontentasse di «nessuna conclusion diversa
da success» promuoverebbe i commit con zero check, cioè proprio quelli che
nessuno ha verificato.

## Decisione

1. `muffin update` prende `--channel <main|dev>`. Il default resta **`main`**,
   la linea promossa, per l'invariante che l'ADR precedente proteggeva.
2. Il canale **non è persistibile**. Un canale salvato in configurazione
   tornerebbe a essere un default invisibile, che è la forma esatta del difetto
   che questa decisione chiude.
3. Qualunque canale si legga, il comando **nomina sempre la distanza
   dell'altro**: quanti commit ci sono su `origin/dev` che non sono su
   `origin/main`, e il comando che li installa sapendo che non sono promossi.
   Vale nei tre casi — `--dry-run`, «già aggiornato», aggiornamento eseguito.
4. Una distanza che non si è potuta misurare si **dichiara ignota**. Un numero
   non misurato non si stampa: sarebbe la stessa bugia con un'altra faccia.
5. Dopo un aggiornamento riuscito il comando dice **cosa è arrivato**: i
   soggetti dei commit fra il marker vecchio e quello nuovo, tagliati a dieci
   con il conteggio del resto. Se `git log` non risponde degrada al conteggio:
   l'elenco è un racconto, non un cancello, e la release è già viva sul disco.
6. La promozione `dev → main` resta un atto umano, e resta ciò per cui è buona:
   marcare un punto verificato, non essere il ritmo con cui l'owner riceve il
   proprio lavoro.

L'implementazione vive in `cli/update.ts` (`CHANNELS`, `channelLagNote`,
`arrivalsSummary`) con i suoi test in `cli/update.test.ts`.

## Conseguenze

- L'owner che vuole il proprio lavoro adesso ha una strada esplicita
  (`muffin update --channel dev`) e sa, mentre la prende, che sta installando
  commit non promossi.
- L'owner che non fa niente **non può più concludere la cosa sbagliata**: la
  riga con il numero e il ramo è sullo schermo insieme a «già aggiornato».
- `muffin update` fa una chiamata di rete in più (il fetch del ramo a monte).
  Il suo fallimento non fa fallire l'aggiornamento: rende la distanza ignota.
- La staleness resta *possibile*: questa decisione la rende **impossibile da
  non vedere**, non impossibile.

## Cosa la rovescerebbe

Tre osservazioni, una qualunque:

1. i workflow acquistano un trigger sul push a `dev` (o il repository diventa
   pubblico, dove i runner standard sono gratuiti e il costo sparisce): allora
   la testa di `dev` ha check run proprie, e il cancello a conclusion del
   candidato A diventa implementabile — con la regola, non negoziabile, che
   **zero check non è success** e che il cancello legge la conclusion, mai
   l'output stampato;
2. la protezione di ramo diventa disponibile: l'auto-merge di GitHub sulla PR
   di promozione dà il candidato A a costo CI zero, ed è la forma preferibile;
3. l'owner misura di aver girato `--channel dev` come abitudine: allora il
   default sta sul ramo sbagliato e va spostato, non aggirato.
