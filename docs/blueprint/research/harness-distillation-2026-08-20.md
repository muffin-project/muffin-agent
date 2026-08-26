# Harness distillation — runtime topology

> **Evidence comparativa datata (2026-08-20), non direzione corrente.**
> Il confronto con i sistemi esterni citati vale come fotografia del momento
> in cui è stato fatto. Le decisioni Muffin che ne sono seguite vivono negli
> ADR-0050/0051/0052 e in `docs/ARCHITECTURE.md`.


**Status:** research snapshot, non normativo  
**Data:** 2026-08-20  
**Branch:** `idea/runtime-topology`

## Perché esiste questo documento

Muffin sta rimettendo in discussione assunzioni che sembravano locali — `one process`, surface = message, execution host implicito, modello locale vs remoto — ma che in realtà formano una sola domanda di runtime topology.

Prima di inventare primitive nuove, questo documento distilla quattro harness contemporanei che hanno già pagato parte del costo di esplorazione:

1. **OpenClaw** — personal agent multi-surface / multi-device;
2. **Hermes Agent** — harness generalista con gateway, delegation e terminal backends;
3. **Letta** — agente persistente con memoria, runtime locali/remoti e multi-environment;
4. **OpenHands** — separazione forte fra agent core ed execution runtime/sandbox.

Non sono authority per Muffin. Sono esperimenti esterni da cui estrarre pattern, failure mode e anti-pattern.

---

## 1. Sintesi comparativa

| Asse | OpenClaw | Hermes | Letta | OpenHands | Lezione per Muffin |
|---|---|---|---|---|---|
| Identità persistente | Gateway-owned sessions/state | profile/home + sessions | agent ID persistente, conversation/session separate | conversation/agent server oriented | identità di Muffin non deve coincidere con PID, surface o host |
| Host remoto | Gateway su VPS/home host | `hermes serve` remoto + gateway separato | app server / cloud + remote environments | agent server locale/remoto/cloud | deployment location deve essere sostituibile |
| Device/node | vero Node con capability native | soprattutto terminal backend SSH/cloud | environment con stable `deviceId` e connection lease | più agent server/workspace che device | Muffin ha bisogno di Node come primitive esplicita |
| Input mentre lavora | steer/followup/collect/interrupt | background delegation; gateway queue meno centrale | `send()` mentre streaming + queue updates + abort | event-driven | busy-input deve essere first-class, non incidental |
| Burst/coalescing | inbound debounce per channel/conversation | adapter-specific | queued turns nel runtime | event stream | transport event != user intent |
| Execution placement | gateway / sandbox / node | local/docker/ssh/modal/daytona/etc. | current environment / selected environment / cloud | runtime/sandbox remoto o locale | execution host è una dimensione della capability |
| Host-local safety | approval policy applicata sul nodo | isolamento dipende dal terminal backend | permission mode/runtime approvals | sandbox come boundary principale | il nodo deve poter restringere il Home, mai essere allargato da remoto |
| Delegation | lanes/subagents | child agent fresh-context, tool inheritance e blocchi | subagents/agents; multi-environment | composable agent graph | delega deve ridurre authority e context coupling |
| Reconnect | paired node identity + gateway state | gateway/service lifecycle | stable device id, ephemeral connection id, seq/ACK/sync | server/runtime reconnect | separare identità stabile dalla connessione corrente |
| State writes | Gateway centrale | home locale; evitare più agent writer sulla stessa home | persistent agent state backend | server/event state | canonical writes devono avere owner esplicito |
| Worker isolation | node hosts + sandbox | terminal backend + child terminal sessions | environment/runtime boundary | action executor container | computation rebuildable è candidata a worker |

---

## 2. OpenClaw — il precedente più vicino alla topologia personale

### 2.1 Gateway e Nodes

OpenClaw usa un **Gateway long-lived** che possiede sessioni, auth profiles, channels e state. Client e Nodes si connettono al Gateway; i Node non diventano un secondo Gateway.

La topologia supportata esplicitamente include:

```text
always-on VPS / home server
          │
       Gateway
          │
    secure transport
          │
   Mac / iOS / Android / watchOS / headless node
```

Il Mac può funzionare come Node tramite companion app. Il Node espone command families come `system.*`, `camera.*`, `device.*`, `notifications.*` e capability native della piattaforma.

**Pattern da trattenere:**

- un host always-on può possedere la continuità senza possedere tutte le capability fisiche;
- un laptop che dorme può sparire e ricomparire senza creare una nuova identità agente;
- il Node è una capability endpoint, non soltanto una UI;
- device identity e pairing sono separati dalla connessione corrente.

### 2.2 Host-local approvals

OpenClaw applica le exec approvals **sull'host che esegue**. Una policy locale più restrittiva non può essere allentata dal Gateway.

Per un'esecuzione approvata costruisce inoltre un piano canonico — command/cwd/session context — e riusa quel piano dopo l'approvazione, invece di fidarsi di argomenti modificati dopo che l'utente ha detto sì.

**Pattern forte per Muffin:**

```text
Home requested authority
        ∩
Node local authority
        =
effective authority
```

Il nodo può stringere. Non può essere costretto dal Home a superare i propri confini locali.

### 2.3 Input durante un run

OpenClaw rende esplicite quattro semantiche:

```text
steer      → prova a influenzare il run corrente
followup   → nuovo turno dopo quello corrente
collect    → coalescing di più input compatibili in un followup
interrupt  → abort del run e partenza col nuovo input
```

Ha anche un inbound debounce per messaggi di testo consecutivi dello stesso mittente, scoped per channel/conversation, configurabile per surface. I media non vengono necessariamente trattati come il testo.

Questo è molto vicino al problema Muffin emerso con Telegram:

```text
update 1: prima metà di un messaggio lungo
update 2: seconda metà due secondi dopo
```

La lezione non è copiare `500ms` o `2000ms`. È separare:

```text
transport event
from
surface composition policy
from
work semantics
```

### 2.4 Cosa NON copiare alla cieca

OpenClaw rimane Gateway-centric. Il Node è soprattutto command surface/peripheral. Muffin vuole una semantica più forte di evidence, work, effects, authority e memory provenance.

Quindi `node.invoke` è una buona primitive di trasporto, ma non è da solo un modello sufficiente per:

- durable effect identity;
- semantic work graph;
- provenance di input multimodale;
- memory commit;
- host-aware model/resource placement.

---

## 3. Hermes — execution backend e delegation pragmatica

### 3.1 Gateway separato e surface adapters

Hermes usa un gateway long-lived separato dalla CLI, con numerosi platform adapter. È una conferma utile che surface lifecycle e interactive CLI non devono necessariamente coincidere.

La documentazione stessa espone un rischio interessante: CLI e Gateway possono leggere config attraverso percorsi diversi. Questo è esattamente il tipo di drift che Muffin deve evitare quando separa processi.

**Lezione:** separare processi senza una sola authority/config path può peggiorare il sistema.

### 3.2 Terminal backend come execution placement

Hermes astrae dove eseguire terminal work:

```text
local
Docker
SSH
Modal
Daytona
Vercel Sandbox
Singularity / Apptainer
```

Questo è semplice e molto utile. L'agente può vivere in un posto e fare shell work altrove.

**Da trattenere:** execution placement deve essere configurabile e sostituibile.

**Da migliorare per Muffin:** non ridurre un Node a "SSH backend". Un personal Node può esporre screen, notification, microphone, local model, sensors e capability native che SSH non modella bene.

### 3.3 Delegation

`delegate_task` crea child agents con:

- fresh context;
- terminal session propria;
- tool access ereditato;
- capability particolarmente sensibili bloccate (`memory`, `send_message`, `cronjob`, user clarification);
- parallelismo bounded;
- cancellation legata all'owner;
- solo final summary che torna al parent.

Questa è una buona distillazione di una regola generale:

> Un subagent non deve poter auto-espandere l'autorità del parent e non deve scrivere direttamente lo stato condiviso soltanto perché sa ragionare.

Per Muffin questo suggerisce:

```text
parent authority
      ↓ only narrows
child authority
```

E una distinzione fra:

- **reasoning delegation** — child agent;
- **mechanical work** — worker/tool execution;
- **durable long-running work** — work ledger/scheduler, non child process volatile.

### 3.4 Memory

La built-in memory Hermes è deliberatamente piccola e curata (`MEMORY.md`, `USER.md`) con session search separata. È pragmatico, ma non è una base sufficiente per la tesi Muffin su evidence/belief/provenance/temporal change.

La documentazione avverte inoltre di non puntare due agent processes allo stesso home perché avresti più writer della stessa memoria.

**Pattern da trattenere:** canonical memory ownership deve essere esplicita.  
**Pattern da NON copiare:** "un file condiviso e speriamo che un solo processo scriva".

---

## 4. Letta — identità persistente, environment e protocollo portabile

### 4.1 Agent ≠ conversation ≠ session ≠ environment

Letta separa concetti che per Muffin sono preziosi:

- agent persistente con memoria;
- conversation come thread;
- session come connessione attiva;
- environment come macchina/runtime in cui il lavoro gira.

La documentazione della harness esplicita una proprietà particolarmente interessante: file/skills possono appartenere all'environment, mentre la memoria appartiene all'agente e può seguirlo quando cambia environment.

Questo è molto vicino alla distinzione Muffin:

```text
Muffin continuity
      !=
Mac filesystem
      !=
VPS filesystem
```

### 4.2 Stable device identity vs connection lease

Per remote environments Letta distingue:

```text
deviceId       stabile attraverso reconnect
connectionId   lease della connessione online corrente
```

Il protocollo usa heartbeat, sequence numbers, ACK, sync/replay e idempotency keys dove disponibili.

Questa è una primitive che Muffin dovrebbe quasi certamente adottare concettualmente:

```text
NodeId          durable identity
ConnectionId    ephemeral presence
```

Un reconnect non deve creare un nuovo Mac.

### 4.3 Queue e client state

Le sessioni possono ricevere un altro `send()` mentre un turn sta streammando; il client riceve `queue_update`, può abortire il lavoro e rimuovere queued messages con acknowledgement del server.

Il contributo importante è la distinzione fra:

- transport acknowledgement;
- authoritative queue mutation;
- runtime result;
- state replay dopo reconnect.

Muffin non deve mai trattare "il Node ha ACKato il frame" come "l'effetto è successo".

### 4.4 Multi-environment

Letta permette a un agente persistente di lavorare su laptop, cloud VM, Mac Mini o managed sandbox.

**Da trattenere:** environment/host placement è un parametro dell'esecuzione, non l'identità dell'agente.

**Da non copiare automaticamente:** il modello cloud-centric e il relay hosted. Muffin deve poter fare lo stesso sotto controllo dell'owner e senza dipendere da un control plane SaaS.

---

## 5. OpenHands — separare agent core da execution environment

OpenHands V1 enfatizza layer distinti:

```text
agent core / SDK
      ↓
tools
      ↓
workspace / sandbox
      ↓
agent server
```

Il runtime di esecuzione è client/server: il backend produce Actions, un Action Executor nel sandbox le esegue e restituisce Observations.

Questa separazione dà proprietà concrete:

- arbitrary code fuori dal processo di reasoning;
- sandbox sostituibile;
- resource control;
- runtime locale o remoto;
- event-driven action/observation boundary.

Per Muffin il pattern importante è:

```text
Decision / authorized intent
        !=
Execution
        !=
Observed outcome
```

Un executor non deve diventare authority soltanto perché possiede il processo che fa l'azione.

OpenHands è però orientato soprattutto a coding workspace/session runtime, non a una persona continua con device fisici e memoria longitudinale. Quindi la sua unità di isolamento è più vicina al workspace che al personal Node.

---

## 6. Pattern convergenti da promuovere nel design Muffin

### P1 — Stable identity separata da active connection

```text
MuffinId / HomeId / NodeId
            !=
PID / WebSocket / connection lease
```

### P2 — State authority separata da execution placement

Il posto che esegue un comando non diventa proprietario della verità canonica.

### P3 — Transport event separato da user intent

```text
native events
   ↓
surface assembler
   ↓
intent
   ↓
work
```

### P4 — Busy input ha semantica esplicita

Il sistema deve poter rappresentare almeno:

```text
steer
followup / queue
collect
interrupt
```

L'UX può scegliere automaticamente quale usare; il runtime non deve ridurre tutto a "nuovo turno".

### P5 — Host-local policy è un confine reale

Il Home può chiedere una capability. Il Node decide comunque se quella capability è disponibile e autorizzata localmente.

### P6 — Computation rebuildable e canonical state transition sono cose diverse

Buoni candidati worker:

- embedding;
- transcription;
- OCR;
- parsing;
- rerank;
- image understanding;
- candidate extraction;
- local inference service.

Canonical transitions più strette:

- turn/work state;
- effect journal;
- authority/delegation;
- budget ledger;
- active belief;
- schedule;
- pairing / node identity.

### P7 — Child agent authority only narrows

Un subagent può ricevere meno tool/authority del parent, mai di più per propria scelta.

### P8 — ACK, execution outcome e semantic commit sono tre livelli

```text
message delivered to worker
        !=
worker says command completed
        !=
Muffin committed the resulting state
```

### P9 — No active-active canonical Home per MVP

Nessuno dei pattern utili richiede oggi consensus o replicated leadership.

La forma pragmatica è:

```text
1 authoritative Home
N Nodes
N Surfaces
N workers / execution environments
```

---

## 7. Anti-pattern da evitare

1. **Surface = Agent** — Telegram, CLI, pendant e menubar non possiedono identità indipendenti di Muffin.
2. **Node = SSH** — SSH è un transport/executor utile, non un modello di device completo.
3. **Every process writes the DB** — process separation senza state ownership produce race opache.
4. **One global execution backend** — shell, Whisper, browser e local LLM hanno placement e risk domain diversi.
5. **Transport ACK = success** — un frame ricevuto non prova un effect.
6. **Subagent = unrestricted second Muffin** — delega senza authority narrowing rompe il modello.
7. **Replicated Home now** — offline leadership/merge/consensus è ricerca post-MVP, non prerequisito per Nodes.
8. **Microservices by aesthetic** — process boundaries devono comprare isolation, resource independence o lifecycle independence.

---

## 8. Implicazioni dirette per la repo attuale

### `one process`

Va reinterpretato. L'invariante utile non è "un PID" ma:

> ogni stato canonico e ogni authority-sensitive transition ha un owner esplicito.

Il deployment DAY-1 può restare quasi monoprocesso; l'architettura non deve però dipendere dalla condivisione di oggetti JavaScript come unica forma possibile di coordinamento.

### `ModelLane`

La semantica da preservare è un lease/resource slot esclusivo, non necessariamente l'istanza JS corrente.

### `slice/inbound-unit`

La claim `update_id → one durable turn` è troppo stretta per album, split messages e intent composition.

Forma più generale:

```text
native event id → consumed exactly once
N native events → 1 composed intent quando la surface lo decide
1 intent → durable work identity
```

### Surfaces

Una surface può vivere sul Home o su un Node. Non deve per forza possedere execution capability.

### Local models

`docs/ideas/local-agentic-runtime.md` va reinterpretato come **compute placement**: un modello locale può vivere sul Home oppure essere una capability/resource del Mac Node.

---

## 9. Fonti verificate il 2026-08-20

### OpenClaw

- https://docs.openclaw.ai/gateway/remote
- https://docs.openclaw.ai/nodes
- https://docs.openclaw.ai/concepts/queue
- https://docs.openclaw.ai/concepts/queue-steering
- https://docs.openclaw.ai/concepts/messages
- https://docs.openclaw.ai/tools/exec-approvals

### Hermes Agent

- https://hermes-agent.nousresearch.com/docs/developer-guide/architecture/
- https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals/
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/

### Letta

- https://docs.letta.com/
- https://github.com/letta-ai/letta-agent-sdk
- https://github.com/letta-ai/letta-code
- https://github.com/letta-ai/letta-docs-md/blob/main/agent-sdk/remote-client/reference/index.md

### OpenHands

- https://github.com/OpenHands/docs/blob/main/openhands/usage/architecture/runtime.mdx
- https://github.com/OpenHands/docs/blob/main/sdk/arch/design.mdx
- https://github.com/OpenHands/docs/blob/main/sdk/arch/agent.mdx
- https://github.com/OpenHands/OpenHands/blob/main/docs/architecture.md

Le fonti descrivono sistemi in movimento. I dettagli numerici e di protocollo sono research evidence, non contratti Muffin; vanno riverificati quando un pattern viene trasformato in ADR o implementazione.