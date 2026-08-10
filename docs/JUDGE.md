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
- **Non lasciare HEAD su un altro ramo**: una review l'ha fatto e il commit
  successivo è atterrato nella PR sbagliata. Torna sul ramo di lavoro e verifica
  che `git status` sia pulito.
