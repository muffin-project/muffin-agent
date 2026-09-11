# ADR-0076 — Il compute lungo resta osservabile e finito

**Stato:** accettato · 2026-09-11 · direttiva owner dopo dogfood e challenge del runtime · non decide da sola i valori numerici dei timeout

## Contesto

Muffin deve poter portare avanti lavoro multi-step e lungo. Il runtime aveva usato un tetto di round come protezione dal runaway; l'uso reale ha mostrato il difetto della forma: un giro economico e un giro di reasoning di minuti valevano entrambi `1`, e un task sano poteva morire perché aveva raggiunto un numero che non misurava né costo, né tempo, né progresso. Quel tetto è stato rimosso.

La rimozione lascia però scoperta l'altra metà del contratto. Oggi una singola chiamata al provider può trattenere il controllo per minuti; il progress `model` arriva solo quando la chiamata è già terminata; gli SDK possono ritentare internamente mentre il loop possiede un secondo budget di retry; e denaro, tool call, tempo di modello, wall clock e stagnazione sono ancora governati come problemi separati o, per alcuni assi, non governati affatto.

Il dogfood ha già prodotto entrambe le classi di segnale che rendono il problema reale:

- una finestra visibile di silenzio mentre sotto il renderer arrivavano eventi di reasoning/tool-call;
- chiamate sufficientemente lunghe da rendere inaccettabile affidare l'intero confine al timeout implicito del client HTTP.

La ricerca e il confronto con Hermes, LangChain/LangGraph, il comportamento corrente dell'OpenAI Node SDK e la letteratura su test-time compute/progress sono registrati in `docs/evidence/execution-governance-2026-09-11.md`.

## Decisione

### 1. Lavoro lungo sì; compute illimitato e invisibile no

L'invariante è:

> **Muffin può lavorare a lungo, ma nessuna esecuzione può consumare tempo o compute indefinitamente senza progresso osservabile.**

“Lungo” non è un errore. “Non torna mai al controllo e non sappiamo se sta avanzando” lo è.

Questa decisione non reintroduce un `maxRounds` come normale criterio di fine.

### 2. Il budget di esecuzione è multidimensionale

Non esiste un singolo numero chiamato “budget dell'agente”. Il runtime distingue almeno:

```text
money / spend
model-call attempts
tool-call attempts
active model time
turn wall-clock time
provider activity / inactivity
progress / stagnation
```

Una dimensione non sostituisce le altre. Un tool lento consuma wall clock senza consumare model time; un reasoning stream può consumare model time pur senza produrre testo finale; un task può restare sotto il tetto economico e comunque essere bloccato.

### 3. `activeModelMs` e `turnWallMs` sono fatti diversi

Il governor misura separatamente:

- **active model time** — tempo cumulativo speso nelle chiamate cognitive del turno;
- **turn wall time** — tempo totale trascorso per l'owner dal principio alla fine dell'esecuzione, tool inclusi.

Il primo governa compute/model pressure. Il secondo governa l'esperienza e il tempo totale trattenuto dal turno.

Non è richiesto che ogni millisecondo diventi stato canonico permanente. Se un budget deve sopravvivere a suspend/resume o impedire che un restart azzeri il limite, il minimo stato necessario entra nel Work record; metriche puramente diagnostiche possono restare tracing/derived state.

### 4. Una model call ha tre orologi, non “un timeout”

Il runtime tratta come concetti separati:

1. **first-activity / TTFT deadline** — quanto può passare prima che il provider dia un segno reale di attività;
2. **inactivity/stall deadline** — quanto può passare dall'ultima attività reale;
3. **absolute model-call deadline** — il tetto esterno della singola chiamata anche se continua a produrre attività.

Un futuro valore numerico può coincidere fra due di questi. La semantica non coincide.

Per modelli locali, una lunga fase di prefill prima del primo token può essere sana; il policy layer può quindi scegliere envelope diversi senza cambiare il significato dei tre orologi.

### 5. Il turno ha un envelope proprio

Sopra le singole model call esistono almeno:

- cumulative active-model budget;
- wall-clock deadline del turno;
- emergency fuse sul numero di model call;
- emergency fuse sul numero di tool call.

I fuse numerici sono **catastrophic safety bounds**. Se scattano normalmente su lavoro sano, sono configurati male: non diventano una nuova versione mascherata del vecchio round cap.

### 6. Le cause di stop restano tipizzate

Il runtime non appiattisce in “timeout” eventi che richiedono policy diverse. La tassonomia minima da preservare nell'implementazione è:

```text
transport_timeout
model_deadline_exceeded
user_abort
turn_budget_exhausted
```

Possono esistere sottotipi ulteriori quando un consumer ne ha bisogno.

`user_abort` non è un errore di provider. `turn_budget_exhausted` non è una rete instabile. `model_deadline_exceeded` dice che quella generazione ha già consumato il proprio envelope, non che riprovarla subito la renderà sana.

### 7. Il retry automatico appartiene a un owner solo

Un retry è una spesa e una nuova esecuzione, quindi deve avere un budget osservabile unico.

Quando Muffin possiede retry/fallback per una classe di failure, gli SDK sottostanti vengono configurati per **non aggiungere retry impliciti della stessa classe**. Per l'OpenAI-compatible client la direzione corrente è `maxRetries: 0` quando il loop-level governor è il proprietario del retry.

La regola normale è:

- failure transitoria di trasporto → può ritentare dentro il budget;
- deadline di compute/model → non ritenta automaticamente la stessa generazione;
- user abort → non ritenta;
- turn budget exhausted → non ritenta.

La policy può scegliere fallback espliciti; non può nascondere tentativi che il governor non conta.

### 8. Progress è un fatto del runtime, non un messaggio cosmetico

Il runtime mantiene almeno la possibilità di sapere:

```text
modelCallStartedAt
firstProviderActivityAt
lastProviderActivityAt
current execution phase
```

Sono attività reali, quando disponibili:

- text delta;
- reasoning delta;
- tool-call delta;
- usage/provider event che prova avanzamento;
- tool start/retry/end;
- completamento della model call.

Una surface può proiettare questi fatti come “thinking”, “waiting for model”, “receiving”, “tool …”, “model appears stalled”. Non viene fatta una nuova chiamata LLM per produrre un heartbeat.

Reasoning privato può quindi contare come activity senza essere mostrato integralmente all'owner.

### 9. La stagnazione è progresso nullo, non semplicemente tempo passato

Il controllo già esistente sulle chiamate tool identiche con risultato/fallimento identico resta il pavimento deterministico.

L'evoluzione ammessa è una escalation osservabile:

```text
repetition observed
→ warn/replan
→ stop further discovery or return partial work when repetition continues
```

Un fingerprint candidato usa almeno tool, argomenti canonici e digest del risultato normalizzato. Cambiare range, cursor, chunk o risorsa è progresso potenziale e non deve essere schiacciato in “duplicato”.

Un classificatore LLM di “stagnazione” non entra nel core per default: il modello gestisce judgement semantico, ma il governor parte da contratti deterministici e misurabili. Meccanismi più semantici richiedono un failure che l'uguaglianza/novelty deterministica non riesce a coprire.

### 10. Reasoning capability e execution policy sono assi diversi

`Profile.thinking` è scaffolding corrente, non la grammatica universale dei provider.

L'architettura deve poter rappresentare separatamente ciò che un model/provider **può** fare:

```text
can disable reasoning?
which effort levels?
supports a reasoning-token budget?
is reasoning mandatory?
```

e ciò che una particolare esecuzione **vuole** chiedere:

```text
mode: off | adaptive | on
effort: optional
max reasoning tokens: optional
```

Gli adapter traducono questa richiesta nel dialect del provider. Il loop non cresce una lista di `if model.includes(...)`.

Un reasoning token cap è un limite di compute/costo. Non è una garanzia di latenza: provider e modelli hanno throughput diversi.

### 11. Le classi di esecuzione sono una policy candidata, non identità del modello

La distinzione:

```text
interactive
deliberate / deep
background
```

è ammessa come livello di policy per scegliere envelope diversi. Non viene aggiunta allo schema soltanto per possedere tre nomi: deve arrivare con un consumer e con metriche.

Una forma plausibile è interactive più stretta, deliberate con reasoning più ampio, background con un envelope ancora diverso. I valori esatti non appartengono a questa ADR.

### 12. Qwen non viene spento globalmente per ridurre la latenza

L'installazione dell'owner ha già prodotto evidenza negativa quando `thinking: off` è diventato un comando reale su OpenRouter: perdita di qualità/continuità osservata in conversazione. `adaptive` ha ripristinato il default del modello.

Quindi il prossimo cambio di policy su Qwen passa da un confronto misurato, almeno fra adaptive/deterministic, adaptive/model-default, off/deterministic e low-or-bounded quando supportato. Latency da sola non sceglie il vincitore.

### 13. Ogni model call deve diventare diagnosticabile senza registrare il prompt

La seam di tracing/usage deve poter ricostruire, quando il provider espone i dati:

```text
request_id
requested_model
response_model
upstream_provider
attempt
started_at
first activity / ttft
last activity
total duration
input/output/reasoning/cache tokens
requested max output
requested reasoning mode/effort/budget
stop reason
abort reason
```

Questa telemetria non richiede il contenuto del prompt o il chain-of-thought. Sono metadata di esecuzione.

### 14. I limiti richiesti vanno confrontati con ciò che il provider ha realmente contato

L'osservazione owner di circa `15,914` token su una chiamata che il loop costruisce con `maxOutputTokens: 4096` resta un'anomalia aperta finché non viene classificata.

Prima di usare quel numero per scegliere un reasoning cap bisogna provare se rappresenta:

- output della singola completion;
- reasoning incluso nell'output;
- input + output;
- totale cumulativo del turno;
- un campo/provider accounting differente.

Se una singola completion ha davvero superato il limite richiesto, il problema è nell'adapter/provider contract e va chiuso prima di fidarsi del governor token-based.

## Cosa questa ADR non decide

Non decide:

- 30 s, 90 s, 3 min o qualunque altro timeout di produzione;
- che ogni surface debba mostrare un timer;
- che ogni stream reasoning debba essere esposto all'owner;
- un nuovo framework agentico;
- un model router automatico;
- una nuova tabella per i budget temporali prima di sapere quali campi devono sopravvivere al restart;
- una soglia semantica di “progresso” affidata a un altro LLM;
- un default `thinking: off` per Qwen;
- che i token siano una misura sufficiente del tempo.

Le ipotesi numeriche e il piano di misura stanno nell'evidence, non qui.

## Relazione con l'architettura esistente

Questa decisione non crea un sesto piano semantico.

- **Work** possiede l'esecuzione che deve poter continuare/terminare responsabilmente.
- **Effects** continua a possedere l'incertezza sugli effetti reali quando un abort/deadline avviene a metà lavoro.
- **Authority/budget** continua a imporre i limiti espliciti.
- provider/model restano harness sostituibile.
- tracing/progress sono proprioception del runtime, non memoria personale.

ADR-0045 resta valida: presenza non significa attività continua. ADR-0050 resta valida: un Worker/Node può avere deadline/cancel propri, ma non diventa owner del Work canonico. ADR-0037 resta la storia del reasoning corrente; questa ADR restringe la pretesa che la sua grammatica sia universale a tutti i provider.

## Reversibilità e falsificazione

Il governor deve essere introdotto in slice piccole e strumentate. La decisione va rivista se il dogfood mostra che:

- stall detection interrompe lavoro sano più di quanto elimini attese morte;
- `activeModelMs` non aggiunge informazione utile rispetto a wall clock/costo;
- la capability normalization del reasoning degenera in un catalogo di eccezioni per modello;
- la stagnation escalation ferma lavoro iterativo legittimo;
- gli emergency fuse diventano il criterio normale di fine;
- un layer di retry provider-native dimostra migliore resilienza e può essere reso interamente osservabile/contabilizzato senza moltiplicazione.

Il criterio di successo è più semplice: un owner può lasciare Muffin lavorare a lungo sapendo **che cosa sta succedendo, quanto envelope resta e perché il runtime ha scelto di continuare, ritentare o fermarsi**.