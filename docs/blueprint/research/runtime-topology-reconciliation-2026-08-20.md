# Runtime topology — reconciliation with current Muffin architecture

> **Superata — evidence storica, non direzione corrente.**
> Le decisioni uscite da questo lavoro vivono in ADR-0050 (una Home, molti
> capability node), ADR-0051 (molti produttori, un writer semantico della
> memoria) e ADR-0052 (eventi surface, intent e work), tutti su `dev` dal
> 2026-08-25, e nella forma corrente di `docs/ARCHITECTURE.md` e
> `docs/SECURITY.md`. Questo file resta perché conserva il *perché* e il
> vocabolario di lavoro che l'ADR non ripete — non perché descriva HEAD.
> Per lo stato corrente parti sempre da `docs/README.md`.


**Status:** reconciliation proposal, non normativo  
**Data:** 2026-08-20  
**Branch:** `idea/runtime-topology`  
**Read with:** `runtime-topology.md`, `harness-distillation-2026-08-20.md`

## 0. Verdict

La nuova topologia **non sostituisce** l'architettura corrente. La completa.

`ARCHITECTURE.md` ha già stabilito le parti più importanti:

- Muffin non è un processo, modello, device, sessione o connector;
- l'unità è un agente continuo;
- processi e modelli sono compute sostituibile;
- un processo può morire senza creare un nuovo Muffin;
- un deployment futuro può avere più processi;
- le surface sono porte;
- lo stato semantico è diviso nei cinque piani Evidence · Beliefs · Work · Effects · Authority;
- canonical state e derived/rebuildable state sono distinti;
- il runtime può essere ospitato su desktop, home node, NAS o VPS.

Quindi non serve un “distributed rewrite”. Serve nominare e rendere composabili alcuni confini topologici che oggi sono ancora impliciti.

---

## 1. Due assi, non uno

I cinque piani rispondono:

> **Che tipo di significato/stato è questo?**

La runtime topology risponde:

> **Dove vive, sotto quale lifecycle/trust/failure boundary, e chi ne possiede l'invariante?**

Sono assi ortogonali.

```text
SEMANTIC PLANES
Evidence · Beliefs · Work · Effects · Authority

                 ×

TOPOLOGICAL ROLES
Home · Node · Surface · Worker/Executor · Compute target
```

Un Node non è un sesto piano. Un Home non è una nuova memoria. Un Worker non è un nuovo tipo di Work.

Questa distinzione deve restare esplicita perché altrimenti un refactor topologico rischia di ricreare store duplicati per ogni host.

---

## 2. Cosa resta invariato

### 2.1 One continuous agent

Resta integralmente.

`ADR-0045` ha già rifiutato “un agente per device”. La nuova primitive `Node` non contraddice quella decisione: rende finalmente esplicito che un device può essere una parte del corpo di Muffin senza essere Muffin.

### 2.2 Five semantic planes

Rimangono la mappa semantica canonica.

- Evidence conserva cosa è entrato/accaduto;
- Beliefs conserva cosa Muffin pensa sia vero;
- Work conserva ciò che resta dovuto;
- Effects conserva cosa può/forse/ha modificato il mondo;
- Authority conserva quali transizioni sono consentite.

La topologia deve rispettare questi owner, non duplicarli per processo.

### 2.3 Model outside authority

Resta integralmente. Routing locale/remoto e Node model placement non trasformano il model selector in un policy kernel.

### 2.4 Core narrow

Resta integralmente. Nodes e Workers sono un modo per mantenere stretto il trusted core, non per spostare casualmente tutto fuori processo.

### 2.5 Canonical vs derived

Diventa ancora più importante.

Derived/rebuildable computation è il candidato naturale a worker/process/remote placement. Canonical transitions richiedono owner stretto e protocollo durevole.

---

## 3. Cosa va esteso nell'ARCHITECTURE corrente

### A — Home: rendere esplicita la casa autorevole

Oggi `ARCHITECTURE.md` dice correttamente che desktop, home node, NAS o VPS possono ospitare il runtime, ma non nomina l'oggetto logico che viene spostato.

Proposta:

> **Muffin Home** è il deployment authority boundary che custodisce in un dato momento la continuity canonica di un Muffin.

Non è l'identità di Muffin e deve essere migrabile.

Per MVP: un solo authoritative Home alla volta.

### B — Node distinto da Surface

Oggi device e surface sono entrambi descritti soprattutto come “porte”. Questo è corretto per l'identità ma troppo poco per il runtime.

Un Node può offrire:

- execution capability;
- sensors/actuators;
- data locality;
- local compute;
- una o più surfaces.

Una Surface descrive interaction/transport, non l'intero host.

Quindi:

```text
Surface = come comunichi
Node    = dove Muffin può percepire/agire/calcolare
```

### C — Ingress event distinto da composed intent/work

Il turn path attuale salta da `surface / ingress` a `principal + typed content` e poi `durable turn`.

Va raffinato semanticamente in:

```text
native surface events
       ↓
typed fragments + provenance
       ↓
surface composition
       ↓
user intent
       ↓
durable work identity
```

Questo è necessario per album, messaggi spezzati, multi-file, voice segments ed input durante un work già attivo.

### D — Execution placement come dimensione esplicita

Oggi provider e shell hanno già forme sostituibili, ma non esiste ancora una primitive generale per dire:

```text
questa capability gira sul Home
questa sul Mac Node
questa in sandbox
questa su remote provider
```

La topologia deve renderlo possibile senza obbligare DAY-1 a costruire un placement optimizer.

### E — Host-local authority

L'Authority plane resta unico semanticamente, ma un Node deve poter imporre una restrizione locale ulteriore.

Quindi il confine diventa:

```text
Home policy
   ∩
Node local policy
   =
effective authority
```

Non è un secondo policy kernel che può concedere di più. È un lower ceiling locale.

### F — Process topology come deployment concern

La frase da evitare è “Muffin gira in un solo processo”.

La frase utile è:

> Process boundaries are chosen when they buy a trust, failure, resource, lifecycle or placement boundary; they do not create additional Muffins.

DAY-1 può restare mostly single-daemon senza rendere quella forma un'invariante architetturale.

---

## 4. Intent vs Turn — evitare una nuova tabella per estetica

L'architettura ha bisogno della distinzione concettuale:

```text
TransportEvent
    ↓
Intent
    ↓
Work execution
```

Questo **non** implica immediatamente:

```text
CREATE TABLE intents (...)
```

Il `TurnStore` attuale è già una durable Work identity con crash ownership, resume, taint, transcript, delivery e effect linkage.

Per DAY-1 una forma minimale può essere:

```text
raw inbound event(s)
      ↓
surface assembler / durable grouping
      ↓
seal composition
      ↓
create ONE Turn
      ↓
Turn remains the concrete durable work identity
```

Quindi “Intent” può restare per ora il significato dell'input composto che causa la creazione del Turn.

Una prima-class Intent entity/table diventa giustificata solo quando serve una proprietà che il Turn non può onestamente possedere, per esempio:

- più execution attempts indipendenti sotto una stessa intenzione;
- un WorkGraph con più child work unit;
- una modifica dell'intent che deve sopravvivere separatamente dal transcript;
- routing/delegation che produce più turn sotto un unico commitment;
- cross-surface handoff dove la stessa intenzione deve restare indipendente da una singola conversazione.

Fino a quel consumer: non costruirla.

---

## 5. Impatto su `slice/inbound-unit`

La PR contiene una proprietà importante e una formulazione troppo stretta.

### Da preservare

- ingress durability;
- transport event idempotency;
- crash recovery;
- no duplicate model/effect/delivery;
- external event bound to durable work identity.

### Da cambiare semanticamente

Da:

```text
update_id → one durable turn
```

A:

```text
update_id → one durable native event
N native events may compose one durable turn
once a turn/work identity exists, execution is exactly-once/idempotent according to effect semantics
```

Questa mediazione deve avvenire prima del merge della PR, altrimenti il nuovo invariant rende più difficile album/split-message composition appena dopo averlo reso durable.

---

## 6. Impatto su `TurnInput`

`TurnInput` oggi contiene principalmente:

```text
principal
tenant
surface
session
text: string
contentTaint
reply metadata
```

È sufficiente per testo, non per l'interazione DAY-1 ormai richiesta.

Il contratto futuro deve poter rappresentare typed input parts con provenance propria, per esempio concettualmente:

```text
InputEnvelope {
  principal
  tenant
  surface
  session
  parts: [
    TextPart,
    ImagePart,
    FilePart,
    AudioPart,
    TranscriptPart,
    ReferencePart
  ]
  sourceEvents[]
}
```

Non va definito uno schema definitivo prima di leggere i consumer reali. Ma `text: string` non può essere considerato la forma finale.

### Provider boundary

`agent/providers/types.ts` non possiede ancora image/audio content blocks. Quindi il problema è in due stadi:

```text
surface multimodal ingress
        ↓
internal typed envelope
        ↓
provider-specific supported representation
```

Un'immagine non deve essere ridotta a una stringa tipo `[immagine ricevuta]` se il provider può realmente vederla.

Un audio può invece avere sia evidence originale sia derived transcript; i due non sono lo stesso dato.

---

## 7. Busy input e Work

Il `TurnStore` e `enqueueTurn` hanno già separato reception dall'esecuzione: un Turn può essere scritto durable e poi eseguito dalla lane.

La lacuna è che il connector e il Work model non hanno ancora una semantica completa per input che arriva mentre un work è running.

Da modellare:

```text
STEER       → amendment al work corrente al prossimo safe boundary
FOLLOWUP    → nuovo work successivo
COLLECT     → più input diventano un solo followup
INTERRUPT   → cancellation/abort controllato + nuovo work
```

### Non fare

- mutare arbitrariamente il transcript mentre un provider call è in volo;
- interrompere un effect non-rerunnable nel punto sbagliato;
- lasciare che ogni connector inventi la propria semantica di “utente ha scritto di nuovo”.

### Safe boundary da formalizzare

Il runtime deve poter dire quando un amendment può entrare senza falsificare il work/effect history.

Minimo candidato:

1. prima di un nuovo model call;
2. dopo una tool batch già iniziata e completata;
3. prima di iniziare il prossimo effect;
4. mai reinterpretare come non avvenuto un effect già started.

---

## 8. Node topology e Security

La nuova topologia non cambia la principale security thesis: meaning e authority restano separate.

Aggiunge però un nuovo trust boundary:

```text
Home
  ↕ authenticated node protocol
Node
  ↕ local OS / hardware / data
```

Servono quindi in futuro:

- pairing forte Home ↔ Node;
- stable Node identity;
- connection/session replay protection;
- capability advertisement;
- local permission ceiling;
- canonical execution plan bound to approval;
- request id / idempotency;
- outcome typed;
- no implicit secret/env inheritance;
- explicit data locality/egress semantics quando un payload cambia host.

### Security promise da evitare

“Paired node = trusted with everything” non è accettabile come modello permanente.

Pairing stabilisce *chi è quel Node*. Capability/grant stabiliscono *cosa può fare*.

---

## 9. Node topology e Extensions

`EXTENSIONS.md` è già compatibile con questa direzione.

Una extension può introdurre:

- una Surface;
- capability disponibili sul Home;
- capability che richiedono un Node class/platform;
- un Worker/Executor;
- un provider adapter;
- un hardware bridge.

Il manifest futuro può quindi dichiarare placement requirements senza diventare un scheduler:

```text
requires:
  platform: macos
  node-capability: screen.observe
```

L'installazione non concede automaticamente l'autorità a quel Node.

---

## 10. Home migration e Capsule

`VISION.md` possiede già l'idea di una futura canonical export/import (“Muffin Capsule”).

La runtime topology le dà un consumer concreto:

```text
Home on MacBook
      ↓
verified export / backup
      ↓
Home on VPS or Mac Mini
```

Una migrazione deve preservare almeno:

- identity;
- Evidence/Beliefs/Work/Effects/Authority canonical meaning;
- secrets references/material secondo il loro backend;
- Node registry/pairing o una procedura deliberata di re-pair;
- scheduler state;
- effect uncertainty;
- schema/version metadata.

Embeddings/cache/derived indexes possono essere ricostruiti.

Non serve implementare Capsule per accettare Home come primitive; serve evitare di definire Home come “questa directory su questo Mac per sempre”.

---

## 11. Pendente e altri bodies

`ADR-0045` aveva già deciso la cosa fondamentale: pendant/speaker non sono seconde entità.

La nuova topologia la rende implementabile:

```text
Pendant
  Node capabilities:
    audio.capture
    haptic.notify
    optional speaker/status

  Surface:
    push-to-talk / voice / interrupt
```

Un futuro speaker domestico, Watch o telefono usa la stessa grammatica.

Non creare un protocollo hardware separato finché il primo device non lo richiede.

---

## 12. Cosa NON serve cambiare per questa architettura

Non serve oggi:

- sostituire SQLite;
- creare microservices;
- creare un message broker;
- introdurre Redis/NATS/Kafka;
- rendere ogni store un network service;
- active-active Home;
- leader election;
- distributed consensus;
- replicare tutta la memory sui Nodes;
- costruire un scheduler generale di compute placement;
- separare Telegram/Discord in processi solo perché possiamo.

Queste scelte restano fuori finché un consumer/failure mode reale le rende necessarie.

---

## 13. Modifiche canoniche future, se la proposta viene accettata

### `docs/ARCHITECTURE.md`

Aggiungere:

- topological roles Home/Node/Surface/Worker;
- refined ingress path event → composition → durable work;
- execution placement / host boundary;
- single authoritative Home for current product phase;
- logical topology != process topology.

Non cambiare i cinque piani.

### `docs/VISION.md`

Chiarire che “many replaceable bodies” include Nodes e che pendant/phone/Mac possono essere bodies/capability endpoints. `Muffin Capsule` diventa anche Home migration.

### `docs/SECURITY.md`

Aggiungere il Node trust boundary e la rule Home authority ∩ Node local ceiling.

### `docs/EXTENSIONS.md`

In futuro, quando un consumer esiste, aggiungere optional platform/node placement requirements ai manifest. Non ora se nessun runtime le legge.

### Nuova ADR

Serve una nuova ADR, non la riscrittura di ADR-0045, perché questa decisione amplia la topologia mantenendo valida la decisione storica.

Working title:

```text
ADR — One continuity, one active Home, many capability Nodes
```

L'ADR dovrebbe supersedere/amendare soltanto eventuali decisioni storiche che richiedevano materialmente un singolo processo, non ADR-0045.

### M5 / DAY-1

Non trasformare “Node framework” in Gate per entusiasmo.

Aggiornare il Gate solo dove la nuova understanding dimostra che una journey DAY-1 era formulata male:

- multimodal ingress;
- voice;
- images/files;
- smart event composition;
- busy input / steer+queue semantics;
- `inbound-unit` generalized identity.

Remote Home + Mac Node resta fuori dal Gate finché non decidiamo che il dogfood richiede Home su VPS.

---

## 14. Architecture closure checklist

Prima di promuovere questa proposta a authority canonica dobbiamo poter rispondere sì a:

- [ ] Home è definito senza coincidere con Muffin identity.
- [ ] Un solo active authoritative Home è sufficiente per MVP.
- [ ] Node e Surface sono distinti.
- [ ] I cinque piani restano semantic ownership map.
- [ ] `event != intent != work` è accettato senza obbligare una Intent table.
- [ ] Multi-input e multimodal hanno un posto nel contratto.
- [ ] Busy input ha primitive esplicite.
- [ ] Node authority può solo restringere l'authority richiesta dal Home.
- [ ] Worker/executor non diventa canonical writer per comodità.
- [ ] Process boundaries sono implementation/failure boundaries, non identity.
- [ ] Home placement è migrabile/configurabile.
- [ ] Pendant è Node + Surface.
- [ ] Replicated Home / consensus resta fuori MVP.
- [ ] Il design permette DAY-1 semplice su singolo host.

Se queste proprietà sono accettate, i dettagli del protocollo Node possono essere differiti a un'ADR/slice con un primo consumer concreto senza lasciare l'architettura ambigua.
