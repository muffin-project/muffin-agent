# Il mandato del judge

Ogni review di una slice riceve questo documento. Il mandato specifico della PR
dice *cosa attaccare*; questo dice *cosa chiedersi sempre*, e non si accorcia
perché la PR sembra piccola.

## La regola che governa tutto il resto

**Non rivedere il diff. Rivedi le garanzie.**

Il difetto caratteristico di questo repo è un meccanismo scritto, testato,
documentato e raggiunto da niente. L'esemplare: `decide.ts` faceva il gate sugli
URL, i suoi test passavano una risorsa `url` a mano ed erano verdi, e `loop.ts`
quella risorsa non l'ha mai costruita. **Le due metà erano corrette. Il difetto
non era in nessuno dei due diff.** Un revisore che leggeva l'uno o l'altro
approvava.

Quindi: per ogni garanzia dichiarata, **parti dal punto d'ingresso di produzione
e prova a raggiungere il meccanismo**. Se non riesci a dimostrare il percorso, la
garanzia è **non provata**, per quanto buono sia il codice.

E **muta**: annulla una riga, rilancia i test, riporta quali falliscono. Un test
che resta verde sotto mutazione è teatro, e trovarlo è parte del lavoro — non un
extra. Quattro test d'autore in questo repo non potevano fallire: uno asseriva
una parola presente nel boilerplate circostante, uno aveva una fixture in cui
ogni valore era identico, uno scriveva un file vuoto dove il nome diceva
"cancellato".

## Le domande di sempre

Si fanno su ogni slice, anche quando la risposta è ovvia — perché è quando
sembra ovvia che non ce la si fa.

**Torna?**
- Il cambiamento fa quello che la sua stessa descrizione dice, da un capo all'altro?
- C'è una frase nel commit o nel codice che afferma una garanzia che il codice non fornisce?

**È cablato?**
- La produzione ci arriva? Da quale funzione, per quale percorso?
- Se lo scollego, quali test si accorgono? *(se nessuno: reperto)*

**Si poteva riusare?**
- Esiste già in questo repo una funzione, un tipo o una primitiva che fa questo?
- L'abbiamo duplicata senza accorgercene? Due punti che fanno la stessa cosa divergeranno.

**Serviva una libreria — o non serviva?**
- Questo pezzo scritto a mano è un problema risolto meglio da una dipendenza matura?
- E l'inverso, che qui è più frequente: abbiamo aggiunto una dipendenza per una
  cosa che la stdlib fa? Il repo gira su poche dipendenze **per scelta**, e il
  rischio è sempre la prossima.

**È al posto giusto?**
- È una **proprietà di una primitiva che esiste** o un **modulo bullonato a lato**?
  La regola sta in cima a `knowledge/README.md` e non è negoziabile.
- Se domani serve un secondo caso d'uso, questo pezzo si estende o si riscrive?

**Scala?**
- Cosa succede a 100×? Fatti, chunk, tool, tenant, righe di prompt.
- C'è una query senza indice, un `slice()` su una lista che cresce, un loop che
  chiama il modello una volta per elemento?

**Costa?**
- Token per turno. Questa roba sta nel prefisso cacheabile o nella coda volatile?
- Chiamate al modello per turno. Soldi al mese.

**Segue le pratiche di casa?**
- Viola una regola che il repo si è dato — `AGENTS.md`, `docs/PRACTICES.md`, un ADR?
- Se diverge da una convenzione del campo, la divergenza è **registrata** o solo avvenuta?

**Come fallisce?**
- Il fallimento è visibile o silenzioso? Il silenzioso è quello che ci costa.
- È reversibile? Se non lo è, poteva esserlo?

**Si può togliere qualcosa?**
- Cosa si cancella senza perdere niente? La semplificazione è un reperto valido.

## Il ciclo, e come finisce

Una review non è un evento, è uno **stato** di una slice. Il difetto che questo
paragrafo esiste per chiudere: cinque review, cinque giri di correzioni, **zero
slice chiuse** — perché ADJUST non aveva un seguito obbligato e "corretto"
sembrava progresso. In letteratura ha un nome: la tassonomia MAST (1.642 tracce
annotate a mano) la chiama *"unaware of termination conditions"*.

```
needs_review → in_review → verdetto
    MERGE / REJECT / BLOCKED  → terminale, si chiude
    ADJUST / SPLIT            → si corregge → needs_review (giro +1)
```

Tre regole, e nessuna è opinione:

1. **Solo MERGE, REJECT e BLOCKED chiudono.** ADJUST vuol dire che ci sarà un
   altro giro, non che il lavoro è finito.
2. **Tetto a 3 giri**, poi si escala all'owner invece di continuare. Il numero
   converge in tutte le fonti — Self-Refine si ferma a 4, l'esempio ciclico di
   LangGraph a 3, Google ADK affianca `max_iterations` a un segnale di uscita
   anticipata — e il rendimento crolla dopo il secondo o terzo giro.
3. **Ogni giro va a un judge NUOVO, a contesto pulito.** Questa è la regola
   contro-intuitiva ed è misurata: review a contesto separato **F1 28,6%**;
   self-review nella stessa sessione **24,6%** (p=0,008); self-review
   *ripetuta* nella stessa sessione **21,7%** (p<0,001). Rivedere due volte
   nella stessa sessione **peggiora** — il beneficio viene dalla separazione,
   non dalla ripetizione, e un giudice si affeziona ai propri reperti
   precedenti (self-preference bias). Quindi mai `SendMessage` a un judge che ha
   già giudicato questa slice: se ne lancia un altro, e gli si racconta cosa il
   precedente aveva trovato.

*(Fonti: MAST arXiv:2503.13657 · cross-context review arXiv:2603.12123 —
studio singolo, piccolo, non replicato: sospetto ma non definitivo · Self-Refine
arXiv:2303.17651 · Anthropic "Building Effective Agents", che chiama questo
schema **Evaluator-Optimizer** e non usa mai la parola "grafo".)*

## Un verdetto senza vie d'uscita vale meno della metà

**Misurato, con ablation** (arXiv:2607.14167, luglio 2026): sotto un tetto di
quattro chiamate, un feedback che contiene *posizione* + *valore osservato* +
**alternative ammissibili** porta la riparazione da 14/50 a 36/50 (**+44pp**;
+42pp su un secondo modello). E l'ablation isola l'ingrediente attivo:
**posizione e valore da soli fanno poco — sono le alternative a fare il
lavoro.** Il formato non conta (prosa e JSON pari).

Quindi ogni reperto **defect** porta, oltre allo scenario di fallimento, almeno
una **via d'uscita ammissibile** — non "va sistemato", ma *"o si fa A, o si fa
B, e B costa questo"*. Non è cortesia verso chi corregge: è la parte del
feedback che è stata misurata come quella che funziona.

## Le etichette

Esattamente una, e va scelta senza ammorbidire.

| | |
|---|---|
| **MERGE** | Sano. Dillo in chiaro: una review che si inventa problemi è inutile quanto una che li manca. |
| **ADJUST** | Mergiabile dopo fix nominati. Ogni fix concreto e abbastanza piccolo da farlo senza un altro giro di ragionamento. |
| **SPLIT** | Sono due cambiamenti in una PR, e guardarli insieme nasconde qualcosa. |
| **REJECT** | Sbagliato nella premessa, non nel dettaglio. Non elencare fix: di' cosa la premessa sbaglia. |
| **BLOCKED** | Non giudicabile: manca evidenza, serve una decisione dell'owner, o serve una capability che non hai. Di' precisamente cosa sbloccherebbe. |

## La sezione che vale quanto i reperti

**"Le domande che mi sono fatto."** Obbligatoria. Elenca le domande che hanno
prodotto reperti **e quelle che non hanno prodotto niente** — le seconde valgono
quanto le prime, perché dicono dove non serve più guardare. Scritte **come
domande**, non come conclusioni: è quella lista che rende migliore la review
successiva, e col tempo diventa questo documento.

## Regole d'ingaggio

- **Prova a confutare, non a confermare.** Nel dubbio: *non provato*.
- Ogni reperto ancorato a un `file:riga` **aperto e letto**, mai citato a memoria.
- Etichetta ogni reperto **defect** / **unproven** / **nit**. Non riempire di nit.
- **Non committare, non pushare, non mergiare, non approvare su GitHub.**
- Non creare worktree git (una review si è piantata così). Muta in loco con una
  copia di backup e ripristina.
- **Mai `git checkout`.** Il judge gira nello **stesso albero di lavoro**
  dell'orchestratore: spostare HEAD glielo sposta sotto i piedi, e due volte il
  commit successivo è atterrato nella PR sbagliata. Non serve comunque — si legge
  qualunque ramo senza muoversi:

  ```
  git diff base..slice              # il cambiamento
  git show slice:percorso/file.ts   # un file com'è su quel ramo
  git log base..slice               # i commit della slice
  ```

  Per eseguire test e mutazioni si usa l'albero com'è: la slice sotto review è
  già dentro il ramo di lavoro, perché lo stack è impilato.

  Nota su perché questa riga è una regola e non un guard: il guard esiste
  (`.claude/hooks/guard-review-branch.mjs`) e **non protegge da questo**. Vive nel
  repo, quindi un checkout di un ramo più vecchio lo fa sparire insieme alla sua
  riga in `settings.json` — assente esattamente dove servirebbe. È il difetto di
  casa commesso dal meccanismo costruito per prevenirlo, e la cura è togliere la
  causa invece di sorvegliarla.
- Ogni file temporaneo che crei per sondare (probe, fixture) va **rimosso** prima
  di chiudere. `git status --porcelain` vuoto, e dillo nel report.
