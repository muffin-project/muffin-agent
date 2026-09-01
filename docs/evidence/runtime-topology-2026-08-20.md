# Idea — Runtime topology: Home, Nodes, Surfaces, Workers

> **Superata — evidence storica, non direzione corrente.**
> Le decisioni uscite da questo lavoro vivono in ADR-0050 (una Home, molti
> capability node), ADR-0051 (molti produttori, un writer semantico della
> memoria) e ADR-0052 (eventi surface, intent e work), tutti su `dev` dal
> 2026-08-25, e nella forma corrente di `docs/ARCHITECTURE.md` e
> `docs/SECURITY.md`. Questo file resta perché conserva il *perché* e il
> vocabolario di lavoro che l'ADR non ripete — non perché descriva HEAD.
> Per lo stato corrente parti sempre da `docs/README.md`.


**Status:** architectural proposal, non normativo finché non promosso ad ADR/ARCHITECTURE  
**Data:** 2026-08-20  
**Branch:** `idea/runtime-topology`  
**Research companion:** `harness-distillation-2026-08-20.md`

## 0. La frase che deve sopravvivere

> **One Muffin is one durable continuity. Process, host, model and surface boundaries are replaceable implementation boundaries. Every invariant has exactly one explicit owner.**

La topologia non parte da "quanti processi?". Parte da:

- chi possiede quale stato;
- chi può prendere quale decisione;
- quale parte può crashare senza cambiare l'identità di Muffin;
- dove una capability può essere eseguita;
- quali dati possono o non possono lasciare un host;
- come un dispositivo sparisce e ritorna senza diventare un altro Muffin.

---

## 1. Vocabolario

### Muffin Home

Il **Home** è la casa autorevole di una continuità Muffin.

Possiede almeno:

- durable identity;
- canonical work ledger;
- authority/delegation state;
- effect journal;
- budget ledger;
- canonical memory/evidence/belief state;
- scheduler;
- Node registry e pairing;
- session/work routing.

Il Home **non è Muffin**. È l'host logico che in questo momento custodisce la sua continuità autorevole.

Può vivere su:

- MacBook;
- Mac Mini;
- home server;
- VPS;
- altro host affidabile.

Spostare il Home deve essere una migrazione di Muffin, non la creazione di un nuovo agente.

### Node

Un **Node** è un host/device paired che mette a disposizione capability, risorse e/o contesto locale.

Esempi:

- MacBook;
- iPhone;
- Apple Watch;
- futuro pendente Muffin;
- Mac Mini;
- NAS/home server;
- workstation con GPU;
- headless Linux box.

Un Node ha identità stabile separata dalla connessione corrente:

```text
NodeId        durable
ConnectionId  ephemeral
```

Un Node può essere offline senza perdere la propria identità.

### Surface

Una **Surface** è il modo in cui una persona o un sistema comunica con Muffin.

Esempi:

- Telegram;
- CLI/REPL;
- menubar app;
- web UI;
- voice surface;
- pendant button/wake interaction;
- iPhone app;
- Discord.

Surface e Node sono assi diversi.

Un MacBook può essere contemporaneamente:

```text
Node      → filesystem, shell, screen, local model, notifications
Surface   → menubar UI, voice, CLI
```

Telegram può essere una Surface senza essere un Node.

### Worker / Executor

Un **Worker** esegue computation o effects che non devono possedere canonical state.

Esempi:

- sandboxed shell executor;
- browser executor;
- Whisper/STT;
- OCR/document parser;
- embedding worker;
- reranker;
- local model server;
- image understanding;
- candidate memory extraction.

Un worker può vivere:

- dentro il Home host ma fuori processo;
- dentro un Node;
- in una sandbox/container;
- su un remote compute host.

### Provider / Compute target

Il modello non è un componente identitario. È compute.

Possibili target:

- remote frontier provider;
- local model sul Home;
- local model su un Node;
- dedicated inference host.

`docs/ideas/local-agentic-runtime.md` è un sotto-problema di questo livello.

---

## 2. Topologia base proposta

```text
                              ┌──────────────────────────┐
                              │       MUFFIN HOME        │
                              │                          │
                              │ identity + authority     │
                              │ work ledger              │
                              │ effect journal           │
                              │ scheduler + budget       │
                              │ canonical memory         │
                              │ node registry            │
                              └───────────┬──────────────┘
                                          │
                             secure capability protocol
                                          │
              ┌───────────────────────────┼──────────────────────────┐
              │                           │                          │
              ▼                           ▼                          ▼
      ┌──────────────┐            ┌──────────────┐          ┌──────────────┐
      │ MacBook Node │            │ iPhone Node  │          │ Pendant Node │
      │              │            │              │          │              │
      │ files        │            │ location     │          │ mic / wake   │
      │ shell        │            │ camera       │          │ haptic       │
      │ screen       │            │ notify       │          │ tiny output  │
      │ local model  │            │ surface      │          │ voice surface│
      │ menubar      │            │              │          │              │
      └──────────────┘            └──────────────┘          └──────────────┘

Surfaces that do not need a Node can terminate directly at the Home:
Telegram / Discord / API / webhooks / remote web UI.
```

### Importantissimo: nessun active-active Home nell'MVP

```text
1 authoritative Home
N Nodes
N Surfaces
N Workers
```

Se il Home è offline, i Nodes non eleggono automaticamente un nuovo leader.

Offline/local-degraded continuity e replicated Home sono ricerca separata post-MVP.

---

## 3. Ownership model

L'architettura deve assegnare owner per **invariante**, non per cartella o processo.

| Invariante | Owner logico iniziale |
|---|---|
| canonical identity | Home |
| raw surface transport id / dedupe | surface ingress owner, persisted at Home o durable adapter store |
| intent/work identity | Home work ledger |
| active turn/work state | Home work owner |
| permissions/delegation | Home authority kernel + Node local restriction |
| budget/spend | Home budget ledger |
| effect intent/outcome/undo | Home effect journal |
| node pairing/identity | Home registry + Node private device identity |
| host-local exec approval | Node |
| evidence/belief canonical commit | Home memory owner |
| embedding/OCR/STT result computation | worker |
| local filesystem truth | Node/host itself |
| model resource availability | resource endpoint / Node advertises, Home routes |

### Regola

> Un processo può eseguire lavoro senza possedere la transizione canonica che quel lavoro informa.

Esempio:

```text
Home: "trascrivi audio A"
        ↓
Whisper worker
        ↓
"transcript candidate T"
        ↓
Home commits transcript/provenance
```

Il worker non scrive direttamente "la verità" nel database canonico.

---

## 4. Ingress: event != intent != work

Il modello attuale `one update → one turn` è troppo stretto.

Forma proposta:

```text
NativeTransportEvent
        │
        ├── immutable provenance / transport id
        ▼
IngressFragment
        │
        ▼
SurfaceAssembler
        │
        ▼
IntentDraft
        │
        ▼
Intent
        │
        ▼
Work / Turn / WorkGraph
```

### Perché serve

Telegram può produrre:

- album;
- caption;
- messaggi di testo spezzati;
- reply;
- edit;
- voice;
- audio;
- più documenti;
- immagini multiple.

Una futura voice surface può produrre:

- VAD segments;
- partial transcript;
- final transcript;
- button press;
- wake event;
- interruption.

Il core non deve conoscere tutti i dettagli di ogni transport.

### Exactly-once corretto

Non:

```text
update_id → exactly one turn
```

ma:

```text
each native event is consumed exactly once
N native events may compose one intent
one intent has one durable work identity
```

### Surface assembler

Ogni Surface può usare:

- primitive native (`media_group_id`, thread/reply ids, edit ids);
- sender/conversation identity;
- breve quiet window configurabile;
- content type;
- control commands che bypassano il debounce.

La policy è surface-specific. Il core riceve la composizione e conserva provenance per ogni fragment.

---

## 5. Input mentre Muffin sta lavorando

Muffin non deve bloccare l'ingress mentre un run è attivo.

Primitive runtime da supportare:

```text
STEER
  modifica la direzione del work corrente al prossimo safe boundary

FOLLOWUP / QUEUE
  crea lavoro successivo

COLLECT
  accumula input compatibili e li materializza come un solo followup

INTERRUPT
  abortisce/cancella il work corrente secondo la sua semantica e parte col nuovo
```

### Safe boundary

Steer non significa interrompere arbitrariamente un effect già in volo.

Possibili boundary:

- prima di un nuovo model call;
- prima di lanciare un tool/effect non ancora partito;
- dopo il completion di un effect già started;
- durante reasoning/runtime che supporta nativamente steering.

### UX Smart

La Surface può fornire hint; il runtime conserva tutte le primitive.

Esempi:

```text
"no aspetta, usa l'altro file"
→ likely STEER

"quando hai finito ricordami di chiamare Luca"
→ likely FOLLOWUP / new work

2 pezzi dello stesso messaggio Telegram in 1.5s
→ likely COLLECT prima ancora di creare work

"ferma tutto"
→ control command / INTERRUPT
```

La classificazione semantica può usare un modello, ma durability/order/target work id non devono dipendere da output ambiguo non verificabile.

---

## 6. Node protocol: contratto minimo

Non decidiamo ora WebSocket vs QUIC vs altro come principio architetturale. Il contratto logico deve però avere almeno:

### Identity / presence

```text
NodeId
ConnectionId
node name / class
platform
software version
last heartbeat
online/offline
device public identity
```

### Capability advertisement

```text
CapabilityDescriptor {
  id
  version
  locality
  risk/trust class
  input/output schema
  resource hints
}
```

Esempi:

```text
system.run
system.which
fs.workspace.read
screen.observe
computer.act
notification.send
audio.capture
speech.transcribe
model.infer
camera.capture
location.read
```

### Resource advertisement

Non per costruire subito un optimizer, ma per rendere rappresentabile:

```text
architecture: arm64
ram: 16GB
accelerator: Metal
power: battery/ac
foreground: true/false
local models: [...]
```

### Request lifecycle

Ogni invocation deve distinguere:

```text
request accepted / ACK
execution started
execution outcome
semantic commit at Home
```

Con request id/idempotency key, deadline/cancel e outcome typed.

### Reconnect

Un Node reconnectato mantiene il proprio `NodeId`; `ConnectionId` può cambiare.

Il protocollo deve poter fare sync/replay dello stato necessario senza assumere che ogni frame precedente sia ancora in memoria.

---

## 7. Authority fra Home e Node

Una capability remota non deve equivalere a "il Home ha shell sul Mac".

Forma:

```text
Home policy request
        ∩
Node local policy
        =
effective permission
```

Il Node può:

- negare capability;
- richiedere approval locale;
- limitare path/app/device state;
- essere più restrittivo del Home;
- fallire closed se la UI di approval non è disponibile.

Il Home non può allargare unilateralmente il Node.

### Approval binding

Una approval deve essere legata alla cosa effettivamente eseguita.

Esempio:

```text
ExecutionPlan {
  capability
  canonical args
  target NodeId
  cwd/resource
  work id
  expiry
}
```

Dopo l'approvazione, cambiare command/path/target invalida il piano invece di riusare il sì precedente.

Questo estende naturalmente il modello Muffin di authority/effects e riduce TOCTOU semantici.

---

## 8. Workers, processes e failure domains

Non tutti i componenti devono vivere in un PID diverso. Process separation deve comprare almeno una di queste proprietà:

1. **security isolation**;
2. **crash isolation**;
3. **resource isolation / independent lifecycle**;
4. **placement su un altro host**;
5. **untrusted code boundary**.

### Buoni candidati out-of-process

- arbitrary shell/code;
- browser/computer-use executor;
- MCP/community extension non trusted;
- local LLM server;
- Whisper;
- OCR/heavy parsing;
- embedding/rerank service se resource-heavy;
- future hardware bridges.

### Cose che possono restare nello stesso daemon inizialmente

- work ledger orchestration;
- scheduler;
- authority kernel;
- budget;
- canonical state transitions;
- lightweight network surfaces;
- routing.

Questo non è un voto eterno. È una scelta di deployment DAY-1.

---

## 9. Process topology ≠ logical topology

La logical architecture deve essere multiprocess-ready anche se DAY-1 usa pochi PID.

### DAY-1 deployment possibile

```text
muffin daemon
  ├─ Home authority/state
  ├─ Telegram
  ├─ CLI
  ├─ scheduler
  └─ lightweight routing

child processes
  └─ sandboxed execution quando serve
```

### Evoluzione MVP

```text
Home daemon
  ├─ state/authority/work
  └─ node protocol

Mac Node
  ├─ menubar surface
  ├─ system/fs/screen capability
  └─ local compute endpoints

workers
  ├─ Whisper
  ├─ browser
  └─ local LLM
```

Nessun refactor dovrebbe richiedere di cambiare il significato di Intent, Effect o Node solo perché una classe si sposta in un altro processo.

---

## 10. Home location: Mac vs VPS

L'architettura non deve hardcodare la risposta.

### Home su MacBook

Pro:

- dati locali;
- semplice per sviluppo;
- nessun remote trust boundary per il core.

Contro:

- sleep/offline;
- network intermittente;
- compete con uso quotidiano e local inference.

### Home su VPS

Pro:

- always-on;
- stable network;
- scheduler/Telegram/background work continui.

Contro:

- più dati/state remoti;
- Mac capability richiede Node;
- execution locale richiede protocollo e pairing;
- security/backup del server diventano critici.

### Home su Mac Mini / home server

Compromesso potenzialmente molto forte:

- always-on;
- owner-controlled hardware;
- LAN/local services;
- costo upfront e gestione hardware.

### Decisione architetturale proposta

> **Home placement è deployment configuration, non product identity.**

La distribuzione può avere un default futuro, ma la continuity deve poter essere migrata.

Per il dogfood DAY-1 non rendere il Node protocol un prerequisito solo per eleganza. Se il percorso più veloce è Home sul Mac, va bene. Se la necessità always-on rende il VPS realmente necessaria, allora il primo Mac Node diventa una slice concreta motivata da un consumer reale.

---

## 11. Pendente Muffin

Il pendente non deve essere un piccolo secondo agente. È un **Node + Surface specializzato**.

### Forma minima

```text
Pendant Node
  capabilities:
    audio.capture
    haptic.notify
    tiny status / led
    optional speaker

  surfaces:
    push-to-talk
    wake/voice
```

Possibile pipeline:

```text
button / wake
    ↓
local VAD / capture
    ↓
Home or paired STT worker
    ↓
Intent
    ↓
Muffin work
    ↓
short voice / haptic response
```

### Perché Node è la primitive giusta

Lo stesso protocollo che collega il Mac può collegare:

- un pendant;
- Watch;
- phone;
- future home device.

Non serve una "pendant architecture" separata.

### Offline pendant

Non MVP iniziale.

Una versione futura può bufferizzare durable audio/events quando il Home è irraggiungibile e sincronizzarli dopo. Non deve assumere authority locale o creare beliefs canonici offline senza reconciliation.

---

## 12. Local models come Node resources

L'idea `local-agentic-runtime` cambia forma:

```text
ModelTarget
  provider remote
  Home local endpoint
  Node local endpoint
```

Un Mac Node potrebbe pubblicare:

```text
model.infer:
  Ornith-9B
  Qwen3.8-27B-Q3

speech.transcribe:
  Whisper
```

Il Home può inizialmente usare routing esplicito, non un optimizer.

Esempio:

```text
privacy-sensitive + Mac online + model available
→ Mac local model

Mac offline
→ remote provider se policy consente
```

In futuro resource placement può considerare RAM/Metal/battery/warm model, ma solo quando misurato necessario.

---

## 13. Delegation / subagents nella topologia

Un subagent non è automaticamente un Node e non è automaticamente un processo.

È un **work child** con context e authority derivati.

Regole proposte:

```text
child authority ⊆ parent authority
child canonical memory writes: no direct by default
child external effects: bounded / journaled through parent/Home authority
child context: explicit package, non implicit full transcript
child cancellation: follows durable work ownership
```

Dove gira il child è un'altra decisione:

- stesso provider;
- modello economico;
- local model Node;
- remote worker.

Separare delegation semantics da compute placement evita di confondere "subagent" con "nuovo processo".

---

## 14. Database / canonical state

Questa è una delle decisioni da non banalizzare.

Lo stato attuale usa SQLite/WAL e alcune componenti aprono handle separati. Con Nodes/processi remoti non possiamo assumere atomicità condividendo una connection.

### Direzione proposta

Per canonical transitions, preferire un singolo **state ownership boundary** nel Home.

Workers/Nodes comunicano intent/outcome; non scrivono direttamente tabelle canoniche.

Non serve creare oggi un `StateService` di rete. Serve evitare API interne che rendano impossibile separarlo domani.

### Read side

Read-only snapshots/query API possono diventare più permissivi in futuro. La priorità è che la write authority sia chiara.

---

## 15. Supervision

Un agente continuo ha bisogno di supervision semantics, non solo di un `launchd` entry.

### Home

Il supervisor del Home deve poter distinguere:

- permanent config error;
- transient network/provider failure;
- worker crash;
- graceful drain/update;
- process restart con recovery del work ledger.

### Node

Un Node deve poter reconnectare/restartare senza far restartare il Home.

### Worker

Un worker crashabile deve essere restartabile se il work è rerunnable; se un effect può essere già successo, il journal deve chiedere reconcile invece di fare retry cieco.

---

## 16. Fasi: evitare overengineering

Questa sezione è provvisoria finché esiste una ROADMAP authority dedicata.

### DAY-1 / 14-day dogfood

Architettura da rispettare, implementazione minima:

- `event != intent != work`;
- multimodal/smart ingress necessario all'uso reale;
- voice input;
- image/file multi-input;
- steer/queue/collect semantics sufficienti alla conversazione continua;
- canonical work/effect ownership;
- niente active-active;
- deployment può essere single-host;
- process isolation dove già necessaria (shell/untrusted execution).

### MVP / trusted alpha

- basic Node protocol;
- Mac Node;
- remote Home deployment support;
- node pairing + stable identity + reconnect;
- host-local capability policy;
- capability routing esplicito Home vs Node;
- local model/STT come Node resources se gli eval lo giustificano;
- first real menubar/native surface.

### Public alpha / open-source readiness

- Node SDK/contract abbastanza stabile per community nodes;
- extension/process isolation contract;
- migrations/backups per Home move;
- UX per node discovery/pairing/permissions;
- documented deployment patterns VPS/Mac Mini/local.

### Post-MVP

- pendant hardware prototype/generalized wearable node;
- mobile richer sensor nodes;
- dynamic resource placement;
- offline event buffering/reconciliation;
- optional local-degraded behavior.

### Research only until evidence

- active-active / replicated Home;
- automatic leader election;
- consensus;
- generalized distributed scheduler;
- autonomous cross-node data replication.

---

## 17. Decisioni che questa proposta prova a chiudere

### D1 — Muffin non è un processo

**Proposta:** ACCEPT.

### D2 — Esiste un solo authoritative Home alla volta nell'MVP

**Proposta:** ACCEPT.

### D3 — Node è una primitive di prima classe distinta da Surface

**Proposta:** ACCEPT.

### D4 — Ogni invariante ha un owner esplicito

**Proposta:** ACCEPT.

### D5 — Nodes possono restringere localmente l'autorità richiesta dal Home

**Proposta:** ACCEPT.

### D6 — Transport event e Intent sono entità diverse

**Proposta:** ACCEPT.

### D7 — Busy input supporta steer/followup/collect/interrupt come semantiche di runtime

**Proposta:** ACCEPT come capability model; policy UX/default da dogfood.

### D8 — Workers non scrivono direttamente canonical state

**Proposta:** ACCEPT come direzione; eccezioni solo deliberate e documentate.

### D9 — Process boundaries sono guidati da failure/trust/resource domain, non da estetica microservice

**Proposta:** ACCEPT.

### D10 — Home placement è configurazione migrabile

**Proposta:** ACCEPT.

### D11 — Il pendente è Node + Surface, non una seconda identità Muffin

**Proposta:** ACCEPT.

### D12 — Replicated/active-active Home non è MVP

**Proposta:** ACCEPT.

---

## 18. Domande ancora aperte prima della promozione ad ARCHITECTURE/ADR

1. Quale parte dell'attuale `TurnStore` diventa Work/Intent e quale rimane turn transcript?
2. L'ingress raw event store deve vivere nel DB canonico del Home o può essere adapter-owned con durable handoff?
3. Qual è il safe-boundary contract esatto di `steer` rispetto a tool calls ed effects?
4. Qual è il protocollo minimo Node per una prima Mac capability senza costruire un framework generale?
5. Quale state deve essere replicato/cacheato sul Node per funzionare bene ma restare non-authoritative?
6. Come migrare Home + secrets + RoT + DB in modo verificabile da Mac a VPS/Mac Mini e ritorno?
7. Quali capability richiedono approval sul Home, quali sul Node, quali entrambi?
8. Come rappresentare data-locality/egress policy senza trasformare il placement router in un secondo policy kernel?
9. Il primo dogfood richiede davvero remote Home + Mac Node, o può validare la semantica su un solo host prima?
10. Quale parte del protocollo deve essere pubblica/stabile per rendere il pendente e i community nodes realistici senza congelare troppo presto l'implementazione?

Queste sono domande di dettaglio/contract. Nessuna richiede di tornare alla dicotomia "monoprocesso o multiprocesso".

---

## 19. Criterio anti-overengineering

Una nuova abstraction/process/protocol feature entra nell'implementazione soltanto se compra almeno una proprietà misurabile:

```text
security isolation
crash isolation
resource independence
remote placement
lifecycle independence
or
un consumer reale già presente
```

Se non compra una di queste proprietà, rimane logical boundary/documentation fino a quando un consumer la rende necessaria.

Questo è il compromesso intenzionale:

> **design distributed enough to survive future Nodes; deploy simple enough to dogfood now.**
