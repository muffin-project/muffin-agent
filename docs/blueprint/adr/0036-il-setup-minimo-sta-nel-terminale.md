# ADR-0036 — Il setup minimo sta nel terminale, il resto lo guida Muffin

**Stato:** accettato · 2026-08-13 · direzione owner

**Contesto.** Dopo la prima conversazione vera con Muffin (18 episodi, 2026-08-11)
l'owner ha detto tre cose che sono la stessa cosa: *«memory extract dovrebbe
essere automatico, non una cosa che lanci»*, *«non lancerò mai quei comandi a
mano»*, e *«vorrei più setup possibile tramite Muffin stesso — al massimo le cose
che si fanno da terminale sono le più importanti e le più sicure, tipo impostare
la API key di OpenRouter; setup minimale e poi il resto guidato da Muffin
stesso»*.

Non è una richiesta di comodità. È la stessa osservazione che ha prodotto
ADR-0035 letta da un'altra parte: un sistema che richiede di digitare comandi per
esistere non è un agente, è un attrezzo. Ma «il resto lo fa Muffin» apre una
domanda che ADR-0035 aveva chiuso per il gateway e che qui si riapre per la
configurazione: **quali manopole un agente può girare su se stesso?**

## La linea esiste già, e si chiama sigillo

Il Root of Trust sigilla oggi **cinque file** (verificato sul manifest
dell'installazione reale, non sul design):

```
budgets.json · egress.json · evals/voice.json · identity.md · policy.json
```

Ognuno è «una cosa su cui l'agente non deve poter essere indulgente con se
stesso»: il tetto di spesa, la superficie di rete, il pavimento di qualità della
voce, il patto con l'owner, la matrice dei permessi. Il commento dentro
`budgets.json` lo dice da solo — *«Dimensional, not sacred — ma l'agente non può
alzarli da sé»*.

**Decisione: quella è la linea, e non se ne inventa un'altra.** Ciò che è
sigillato si tocca dal terminale con un reseal esplicito. Tutto il resto — i
modelli, le surface, la lingua, i job, il testo di persona e voce — Muffin lo può
guidare e scrivere.

L'argomento che rende la linea di principio e non arbitraria: **il tetto è
l'invariante, ciò che sta sotto il tetto è negoziabile.** Cambiare modello è una
decisione di spesa, ma con un tetto reale è una decisione *dentro* un limite che
l'agente non può spostare. Senza tetto reale sarebbe una firma in bianco.

## Il difetto che rende la linea finta oggi

`agent/runtime.ts:123` costruisce `new BudgetEngine(db, config.budget)`. I tetti
che **legano davvero** vengono da `config.json`, che **non è nel manifest**. Il
file sigillato che promette *«l'agente non può alzarli da sé»* è letto solo da
`cli/observe.ts` e `cli/jobs.ts`, e **solo per le quiet hours**.

Cioè: il sigillo sta proteggendo una copia. Oggi qualunque cosa sappia scrivere
`~/.muffin/config.json` alza il tetto mensile, e il Root of Trust non se ne
accorge. Il registro dei lettori (`core/rot/readers.ts:113-118`) lo aveva già
trovato e scritto — *«recorded so the next reader finds it»*. Questa ADR è il
lettore successivo.

**Nessuna superficie di scrittura conversazionale viene costruita prima che il
tetto sia sigillato per davvero** (o `BudgetEngine` legge il file sigillato, o
`config.budget` entra nel manifest). Non è una precondizione morale: senza,
«Muffin può regolare i modelli sotto il tetto» è una frase che non descrive
niente.

## Cosa fa il terminale, in tutto e per tutto

Due cose, e sono le due che un agente non può fare per sé:

1. **Il segreto.** `muffin secret set` legge da stdin, mai da argv, mai stampato
   (`AGENTS.md` §Convenzioni). Una chiave che passa da una conversazione passa da
   un prompt, da una traccia e da un episodio — tre posti dove per contratto non
   deve stare.
2. **Il reseal.** `muffin rot reseal`, dopo aver toccato uno dei cinque.

Più `muffin init`, che deve diventare **minimo**: provider e chiave, e basta.

La chiave, in realtà, è già risolta e bene: ADR-0030 la fa vivere **fuori dalla
home che il reset cancella**, in una `.env` gitignorata della working dir, e il
percorso è cablato per davvero — `loadDotenvIfPresent()` a `cli/main.ts:111`,
`MUFFIN_API_KEY` letto a `cli/main.ts:192`. Un `muffin init` senza argomenti
prende la chiave da lì.

Quello che manca è **il provider**. `firstRun()` (`cli/main.ts:282`) chiede
*«Set it up now?»* e poi chiama `cmdInit([])` senza opzioni: `options.provider ??
'anthropic'` (`cli/init.ts:84`) scrive `anthropic` anche a chi ha una chiave
OpenRouter. Il risultato non fallisce al setup — fallisce **alla prima chiamata
al modello**, che è il posto peggiore per scoprirlo. Un primo avvio minimo è una
domanda sola in più: *da chi passiamo?*

## Cosa fa Muffin

Tutto il resto, **conversando**, non compilando un modulo. È anche la lacuna che
l'inventario aveva già nominato: il vecchio muffin aveva un *meccanismo* di
onboarding, il nuovo ha una *sezione di prompt*.

Vincolo che questa ADR impone alla superficie di scrittura, quando verrà scritta:
passa dal kernel come qualunque altra capability, con `hostOnly` — un turno di
gruppo non configura l'agente di nessun altro — e non può nominare i cinque file
sigillati. Il rifiuto su quelli non è un errore da gestire: è la risposta giusta,
e va detta in italiano all'owner con il nome del file e il comando da usare.

## `muffin config` è sola lettura, e questo è il punto

Il punto 3 di M5-bis è *«l'owner non sa cosa può regolare perché non c'è un posto
dove chiederlo»*. Un comando che elenca ogni manopola, il valore attuale, dove
vive e **se è sigillata** risolve la domanda per intero senza costruire una
superficie di scrittura da sorvegliare. Ed è la stessa lista che serve a Muffin
per guidare: se il comando la sa produrre, il tool che guida la legge da lì
invece di avere una copia che invecchia.

## La lingua

Correlata perché arriva dalla stessa frase dell'owner, e perché tocca
**ADR-0020**, che aveva deciso *«Help della CLI, messaggi di errore, log →
inglese»* con l'argomento *«finiscono negli screenshot delle issue»*.

Lo stato reale è che il codice è già andato alla deriva: `USAGE` è in inglese con
una riga italiana in mezzo, gli errori sono metà e metà (`unknown command:`
accanto a `"${name}" non esiste: serve il comando`), e circa **280 stringhe**
utente sono già in italiano. Quindi non si sceglie una direzione nuova: si smette
di non averne una.

**Decisione.** Output utente **in italiano, una lingua sola**. Il pubblico
open-source che giustificava l'inglese non esiste ancora — il repo è privato — e
quando esisterà la domanda si riapre con dei lettori veri invece che ipotetici.

**Alias italiani sui nomi dei comandi, selettivi.** L'owner è stato esplicito:
*«sicuramente non mi immagino TUTTI i comandi in italiano, alcune parole inglesi
si usano anche in italiano»*. Quindi non una tabella di traduzione: un alias solo
dove l'italiano ha davvero la parola che si userebbe parlando (`memoria`,
`lavori`, `segreto`), e l'inglese dove l'italiano parlato è già inglese
(`config`, `status`, `install`, `log`, `doctor`). Una sola mappa alias → comando,
i nomi inglesi continuano a funzionare, nessuna doppia scrittura.

**Scartato: una manopola locale `it|en`.** ADR-0020 chiama il bilingue-ovunque
*«la peggiore delle opzioni — doppia scrittura, deriva garantita»*, e su ~280
stringhe è vero a meno di un catalogo con un lint che fallisce sulle chiavi
mancanti. Senza quel lint marcisce; con quel lint è una slice che non compra
niente finché l'unico lettore parla italiano.

## Conseguenze

**Più facile.** Il primo avvio diventa una domanda e una chiave. La domanda
«cosa posso regolare» ha un posto. Muffin guida il resto, che è ciò che un agente
personale dovrebbe fare invece di rimandarti a un JSON.

**Più difficile.** Il tetto va sigillato davvero prima di qualunque scrittura
conversazionale, e il rifiuto sui cinque file va scritto bene — un rifiuto che
non dice quale comando usare è un vicolo cieco travestito da sicurezza.

**Segnale che era sbagliata.** Se l'owner si ritrova a fare `muffin rot reseal`
spesso, la linea è nel posto sbagliato: vorrebbe dire che uno dei cinque non è
una cosa «su cui l'agente non deve essere indulgente con se stesso», ma una
preferenza finita nel sigillo per abitudine.
