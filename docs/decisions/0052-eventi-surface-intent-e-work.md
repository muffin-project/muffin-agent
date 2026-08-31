# ADR-0052 — Un evento della surface non è un intento e non è un turno

**Stato:** accettato · 2026-08-21 · decisione owner durante la riconciliazione
repository-wide dell'input/UX

## Contesto

Il runtime attuale nasce da una forma semplice:

```text
messaggio Telegram
→ connector.handle()
→ runTurn()
→ risposta
```

Quella forma ha permesso di costruire e verificare presto il percorso vero, ma
confonde tre identità diverse:

1. l'evento nativo che una surface consegna;
2. ciò che la persona intende comunicare;
3. il Work durevole che Muffin crea per agire su quell'intento.

La distinzione diventa concreta appena si usa una surface reale.

Telegram, per esempio, può consegnare:

- un album come più update legati da `media_group_id`;
- testo e caption come parti diverse;
- più file o immagini che appartengono allo stesso gesto dell'utente;
- un messaggio lungo spezzato dal client/transport in due messaggi arrivati a
  breve distanza;
- reply/edit/forward con metadata che cambiano il significato e la provenance;
- voice/audio che deve conservare l'originale e produrre un transcript derivato.

Inoltre il requisito prodotto è più forte di "non perdere l'update": la surface
deve continuare a ricevere input **mentre Muffin sta lavorando**. Un secondo
messaggio può completare ciò che l'owner stava ancora scrivendo, correggere il
lavoro corrente, diventare un follow-up indipendente o chiedere di interrompere.

`slice/inbound-unit` ha pagato una lezione corretta e importante: un update
Telegram deve avere identity durevole e non può creare/eseguire lavoro due volte
attraverso crash e retry. La formulazione `update_id → one durable turn`, però,
cristallizza una relazione 1:1 che i consumer sopra smentiscono. La garanzia
exactly-once dell'evento va preservata senza trasformare il transport id nel work
id.

OpenClaw fornisce prior art utile sulla seconda metà del problema con semantiche
esplicite di `steer`, `followup`, `collect` e `interrupt`. Non copiamo la sua
implementazione o i suoi timeout; adottiamo il fatto che receiving, grouping e
work execution sono responsabilità separabili.

## Decisione

### 1. Tre identità, tre responsabilità

La forma semantica è:

```text
NativeEvent
    │
    ▼
DurableIngressFragment
    │
    ├── source / principal
    ├── surface-native identity
    ├── provenance / taint
    ├── typed parts / media references
    └── native relation metadata
    │
    ▼
Surface assembler
    │
    ▼
UserIntent
    │
    ▼
Durable Work identity
```

Quindi:

```text
transport event id != user intent id != work/turn id
```

La relazione può essere:

```text
1 event → 1 intent → 1 turn
N events → 1 intent → 1 turn
1 later event → amendment of existing work
1 later event → new follow-up work
```

Questa ADR non richiede una tabella `intents`. `UserIntent` è prima di tutto una
semantica. Finché non esiste un consumer che abbia bisogno di persistere uno
stato d'intento indipendente dal Turn, il Turn può restare la concreta durable
Work identity materializzata quando l'intento viene sigillato.

### 2. Exactly-once appartiene all'evento, non alla relazione 1:1 col Turn

Ogni evento nativo ricevuto deve avere una identity/idempotency stabile quanto la
surface permette.

La garanzia è:

> **lo stesso evento nativo non viene consumato semanticamente due volte e non
> può causare due volte lo stesso lavoro soltanto perché il processo è morto o
> il transport lo ha riconsegnato.**

Questo non significa che ogni evento crei un Turn proprio.

Il percorso deve poter distinguere almeno:

```text
received durably
included in composition X
sealed into Work Y
processed/settled
```

La meccanica precisa può usare le primitive dell'inbox esistente. Quello che non
può fare è perdere la parentela evento→composition/work necessaria a provare
crash recovery e dedup.

### 3. La Surface possiede la composizione nativa

Il core non deve contenere euristiche Telegram travestite da regole universali.

Ogni Surface conosce le proprie primitive di grouping:

- album/media group;
- thread/topic;
- reply/edit semantics;
- eventuali client ids;
- limiti di messaggio;
- ordering guarantees;
- caption/media representation;
- delivery/input capabilities.

Quando esiste una chiave nativa affidabile, quella ha precedenza su euristiche di
tempo.

Quando non esiste — per esempio due frammenti testuali consecutivi che il client
o la rete hanno consegnato separatamente — la surface può usare una breve
**quiet/coalescing window** e contesto locale per evitare di materializzare il
lavoro troppo presto.

Il valore esatto della finestra **non è architettura**. Va calibrato con uso
reale e può dipendere dalla surface. Non viene hardcodato in questa ADR.

### 4. Grouping non può fare provenance laundering

Comporre più frammenti non li rende una stringa indistinta e più fidata.

Ogni parte conserva quanto serve a sapere:

- chi/che cosa l'ha prodotta;
- quale evento nativo l'ha portata;
- quale surface/conversation/thread;
- forward/reply/source metadata rilevante;
- trust/taint;
- media originale e derivati;
- timestamp/order osservati.

Due actor differenti non diventano owner speech perché sono entrati nello stesso
intent. Un filename/caption/OCR/transcript non eredita authority dal principal
che ha inviato il contenitore. ADR-0046 e le regole di taint/provenance restano
intatte.

L'assembler può creare una vista utile al modello; non riscrive la storia di chi
ha detto/prodotto ciascun byte.

### 5. Multimodalità è multipart, non "stringa con descrizione"

L'internal input deve poter rappresentare parti tipizzate, almeno quando un
consumer reale lo richiede:

```text
text
file/document reference
image
voice/audio reference
caption / reply context
future typed parts
```

Per media:

```text
original media = Evidence
transcript/OCR/caption = derived representation con provenance
native media = current-turn input quando il provider/capability lo supporta
```

Un transcript non sostituisce retroattivamente l'audio originale. Una caption
non rende il file trusted. Un'immagine non deve diventare soltanto un placeholder
textuale se il modello del turno può realmente vederla.

DAY-1 richiede il subset concreto necessario all'uso personale Telegram: testo,
più file, più immagini e voice/audio con transcript. Video e un framework media
universale non seguono automaticamente da questa decisione.

### 6. Receiving continua mentre Work è vivo

Una Surface non aspetta la fine di `runTurn()` per poter durabilmente ricevere il
prossimo input.

Il nuovo input viene prima **ricevuto e preservato**. Solo dopo viene classificato
rispetto al Work vivo.

Il runtime deve poter rappresentare almeno:

```text
COLLECT
  il nuovo frammento completa un intent ancora in composizione / compatibile

STEER
  modifica o integra il Work corrente al prossimo safe boundary

FOLLOWUP
  è un nuovo intento che deve diventare Work successivo

INTERRUPT
  chiede di fermare/redirigere il Work secondo la semantica degli effetti già
  iniziati
```

Il modello può aiutare nel giudizio semantico `STEER vs FOLLOWUP`, perché il
significato linguistico è contestuale. Non può però decidere retroattivamente
che un evento non è mai arrivato, cambiare il suo id, attribuirlo a un altro
principal o spostarlo su un Turn senza una transizione durevole osservabile.

### 7. Un safe boundary rispetta Effects

`STEER` e `INTERRUPT` non sono time travel.

Prima di lanciare una nuova tool/effect invocation il runtime può osservare input
nuovo e cambiare la direzione del Work. Un effect già partito mantiene invece la
propria semantica:

```text
not started       → può essere evitato
started/outcome?  → resta Effect state da riconciliare
completed         → non viene reso "mai successo" da uno steer
```

Per un effect non-rerunnable o dall'outcome incerto, interrompere il reasoning
non autorizza a ripetere o dimenticare l'effetto.

La semantica busy-input quindi compone con EFFECT WAL, rerunnability,
reversibility e futuro undo; non crea una corsia parallela che li aggira.

### 8. Edit/reply/forward sono nuovi fatti, non riscritture invisibili

La forma concreta dipende dalla Surface, ma vale un principio comune:

- un edit ricevuto dopo che l'originale è già diventato Evidence/Work non deve
  far finta che l'originale non sia mai esistito;
- un reply deve mantenere il riferimento alla cosa a cui risponde;
- un forward mantiene origine/actor distinti dal principal che lo inoltra.

L'UX può mostrare una conversazione aggiornata. Il piano Evidence deve poter
spiegare cosa è realmente arrivato e quando.

### 9. Backpressure e bounds sono parte del contratto, non un motivo per bloccare

Separare receiving ed execution crea una coda potenziale. La prima
implementazione deve quindi avere bounds espliciti e failure visibile per:

- numero/byte di frammenti non sigillati;
- dimensione media;
- tempo massimo di composizione;
- backlog di intent/work;
- comportamento quando il provider o il Work resta bloccato.

Questa ADR non sceglie i numeri. Proibisce il fallback silenzioso a "smetti di
ricevere finché il modello ha finito", perché quello annullerebbe la proprietà
prodotto che ha motivato il design.

## Relazione con decisioni precedenti

- **ADR-0021 (Surface model):** estesa. Una Surface possiede anche il mapping
  event-native → typed ingress e la composizione specifica del transport.
- **ADR-0035 (gateway):** resta la Home/runtime continuity; ingress e Work non
  richiedono un secondo agente.
- **ADR-0042/0047 (Turn/Wait/Resume):** restano il substrato Work. Il Turn nasce
  dopo la composizione e può ricevere amendment a safe boundary; non torna a
  essere uno stack frame.
- **ADR-0046 (identity/content):** rafforzata. Grouping mantiene actor,
  provenance e taint per parte.
- **ADR-0050 (Home/Node/Surface):** questa ADR specifica la metà interaction del
  modello topologico. Una futura Node+Surface usa la stessa grammatica senza
  imporre le regole Telegram ad altri device.
- **`slice/inbound-unit`:** conserva il valore del durable inbox, accept/bind/
  settle, fault injection e idempotency dell'evento. La relazione
  `update_id → exactly one Turn` va mediata in `event → exactly-once consumption
  → one composition → one target Work`, dove più eventi possono condividere lo
  stesso Work.

## Cosa questa ADR non autorizza ora

Non introduce per inerzia:

- Kafka/NATS/Redis o un message broker;
- una tabella generica `events` per tutte le integrazioni;
- una tabella `intents` senza consumer;
- un universal media envelope con ogni metadata possibile;
- un classificatore LLM obbligatorio per ogni coppia di messaggi;
- debounce uguale su tutte le surface;
- video/OCR/layout vision completi prima del bisogno;
- semantic merge di messaggi di principal differenti;
- active-active ingress fra Home multiple.

La forma logica deve poter essere implementata inizialmente con SQLite, code
locali e il singolo Home runtime già esistente.

## Conseguenze

Più facile:

- Telegram album/multi-file/multi-image come un gesto coerente;
- messaggi spezzati dal client/rete senza creare conversazioni artificiali;
- voice come input nativo con Evidence originale;
- scrivere mentre Muffin lavora;
- aggiungere una futura voice/pendant Surface senza riusare euristiche Telegram;
- provare exactly-once senza identificare transport id e work id.

Più difficile:

- il connector diventa responsabile di un assembler reale, non solo parsing;
- crash point esistono fra receipt, composition e Work materialisation e devono
  essere fault-injected;
- bisogna rendere visibile backlog/coalescing invece di nasconderlo nel timing;
- steer/interrupt devono rispettare Effects e non soltanto il context del
  modello.

## Reversibilità e falsificazione

La meccanica è sostituibile. Il confine semantico è deliberatamente durevole.

Segnali che la forma è troppo complessa:

- dogfood mostra che grouping oltre le primitive native non migliora quasi mai
  l'UX e introduce soprattutto latency/merge errati;
- `STEER` non produce valore rispetto a un semplice FOLLOWUP deterministico;
- il costo di mantenere provenance per parte non cambia mai un risultato o una
  decisione di authority (improbabile finché forward/media esistono).

In quei casi si può semplificare la policy o disabilitare una modalità. Non si
reintroduce però l'equivalenza `transport event == user intent == Turn`, perché è
falsificata dai consumer nativi già presenti.