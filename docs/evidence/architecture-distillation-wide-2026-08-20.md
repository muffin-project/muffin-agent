# Architecture distillation — OpenClaw · Hermes · Letta · OpenHands

> **Evidence comparativa datata (2026-08-20), non direzione corrente.**
> Il confronto con i sistemi esterni citati vale come fotografia del momento
> in cui è stato fatto. Le decisioni Muffin che ne sono seguite vivono negli
> ADR-0050/0051/0052 e in `docs/ARCHITECTURE.md`.


**Status:** evidence / reconciliation, non normativo  
**Data:** 2026-08-20  
**Branch:** `idea/runtime-topology`

Questa passata non confronta feature count. Chiede, per ogni confine di Muffin:

> quale problema hanno già pagato altri harness, quale forma hanno trovato, e
> cosa cambia davvero nella nostra architettura?

Verdetti usati:

- **KEEP** — la forma Muffin è già corretta o più adatta al prodotto;
- **TIGHTEN** — il principio resta, il peer espone un failure mode o una
  semantica che conviene incorporare;
- **DEFER** — forma utile, ma nessun consumer giustifica l'implementazione ora;
- **REOPEN** — due semantiche plausibili e incompatibili richiedono una decisione
  owner prima di chiamare chiusa l'architettura.

Fonti vive usate in questa passata includono documentazione corrente di OpenClaw
(queue/steering), Hermes Agent (persistent memory, delegation, checkpoints),
Letta (memory blocks, client tools) e OpenHands Agent SDK (design principles e
workspace/isolation). Le fonti storiche già nel repo restano evidence, non
sostituiscono la verifica corrente.

---

## 1. Identity / continuity

### Peer lesson

I peer moderni convergono sul fatto che sessione, UI ed execution environment non
sono necessariamente l'identità dell'agente. Letta persiste `AgentState`; OpenClaw
mantiene session/runtime state separato dai canali; Hermes separa SOUL/USER/MEMORY
dal terminal backend.

### Muffin

ADR-0045 e `ARCHITECTURE.md` sono già più espliciti:

```text
Muffin != session != process != model != device != surface
Muffin = durable continuity
```

Cinque piani:

```text
Evidence · Beliefs · Work · Effects · Authority
```

### Verdict

**KEEP.**

Non adottare un `AgentState` monolitico soltanto perché è comodo da serializzare:
la separazione dei cinque piani rende visibili provenance, effect uncertainty e
authority che in altri harness restano più impliciti.

---

## 2. Home / Node / Surface / Worker

### Peer lesson

OpenClaw rende i device capability endpoint separati dal Gateway. Letta dimostra
che un agente remoto può fermarsi su un client tool, far eseguire localmente la
capability e continuare dopo il result. Hermes astrae terminal backends locali e
remoti. OpenHands separa agent logic e workspace/execution environment.

### Muffin

ADR-0050 adotta:

```text
1 active authoritative Home
N Nodes
N Surfaces
N Workers / compute targets
```

Node local authority:

```text
Home allow ∩ Node local ceiling ∩ OS permission
```

### Verdict

**KEEP — ADOPTED.**

Il differenziale Muffin è che locality non sostituisce authority: pairing non
concede root remoto e un Home compromesso non può bypassare il ceiling locale.

---

## 3. Process topology / isolation

### Peer lesson

OpenHands V0 ha pagato mandatory sandboxing/process separation ovunque: stato che
diverge, friction e rigidità. V1 torna a single-process by default e isolamento
opzionale dove compra davvero qualcosa.

Hermes e OpenClaw, dall'altro lato, usano process/execution boundaries reali per
terminal, backend, subagents o device quando servono.

### Muffin

ADR-0018 sandboxa le mani che eseguono codice; ADR-0050 supersede soltanto la
frase generale di ADR-0022 «un processo OS per tutto».

### Verdict

**KEEP + TIGHTEN.**

Regola:

```text
process boundary iff it buys
security | crash isolation | resource lifecycle | placement | untrusted code
```

Non trasformare logical topology in microservices. DAY-1 può restare mostly one
daemon. Whisper, local model, browser, OCR o extension code possono uscire in
worker quando il consumer lo giustifica.

---

## 4. Ingress / smart conversation

### Peer lesson

OpenClaw ha una semantica particolarmente utile perché la forma è già stata
stressata in un agent loop reale:

```text
steer
followup
collect
interrupt
```

Una steer non finge che un tool già partito non esista. Il runtime controlla ai
boundary prima di nuovi launch/model call; lavoro già started ha una semantica
diversa da lavoro soltanto preparato.

OpenClaw mantiene inoltre debounce/queue semantics separati per canale/runtime.

### Muffin

La forma corrente `Telegram update → runTurn` è troppo stretta. Anche
`slice/inbound-unit` va mediata: l'invariante utile è exactly-once del transport
event, non `update_id == turn_id`.

Forma target:

```text
native event(s)
  → typed fragments + provenance
  → surface assembler
  → user intent
  → durable Work identity
```

### Verdict

**TIGHTEN — DAY-1.**

Semantica da preservare:

```text
each native event is consumed idempotently
N native events may compose 1 user intent
receipt continues while work is busy
```

La surface possiede grouping/debounce perché Telegram album, split messages,
reply/edit e un futuro voice stream non hanno la stessa semantica.

Non hardcodare una finestra OpenClaw: il numero è calibration/evidence. La forma
è architettura; i millisecondi no.

---

## 5. Multimodal input

### Peer lesson

Gli harness moderni trattano image/file/audio support come capability del
provider/surface più che come una stringa universale. Il vecchio ADR-0023 di
Muffin aveva già individuato una distinzione importante: media nativo nel turno,
rappresentazione derivata indicizzabile per memoria.

### Muffin

Il runtime attuale è più indietro della propria idea: `TurnInput.text` e
`ContentBlock` non rappresentano image/audio.

La forma semantica corretta resta:

```text
original media = Evidence
native media view = current-turn cognition when provider supports it
derived transcript/OCR/caption = rebuildable/indexable representation
```

Per audio:

```text
audio original
→ transcript derived with provenance
→ composed user input
```

### Verdict

**KEEP principle + IMPLEMENT MINIMUM DAY-1.**

DAY-1 richiede Telegram text + multiple files + multiple images + voice/audio e
provenance per part. Non richiede un media framework universale né video.

Il dettaglio vecchio di ADR-0023 su uno specifico modello incumbent è storico;
la semantica dual-path resta valida.

---

## 6. Work durability / wait / resume

### Peer lesson

Hermes distingue session-bound work e cron/durable background work. OpenClaw
mantiene run/queue state esplicito. Entrambi confermano che `await sleep()` dentro
il reasoning loop non è durable waiting.

### Muffin

ADR-0042 + ADR-0047 hanno già:

- Turn durable identity;
- runnable/running/waiting/interrupted/done;
- pinned model;
- persistent taint;
- claim fencing;
- wait barrier;
- todo state;
- resume limit;
- single ModelLane ownership;
- separate delivery outcome.

### Verdict

**KEEP.**

Muffin è già più rigoroso dei peer sul crash boundary. La nuova busy-input
semantica deve comporre con questa Work state machine invece di crearne una
seconda.

---

## 7. Effects / reversible mutations / undo

### Peer lesson

Hermes v2 checkpoints sono prior art molto diretto:

- snapshot automatico prima di file/destructive terminal mutation;
- shadow git store;
- max one checkpoint per directory/turn;
- `/rollback` e diff;
- pre-rollback snapshot;
- rollback riallinea anche l'ultimo conversation turn.

Quindi il punto fondamentale è confermato empiricamente:

> ripristinare il filesystem ma lasciare il context che crede nell'effetto
> annullato è un rollback incompleto.

Una differenza importante: Hermes tratta gli errori del Checkpoint Manager come
non-fatali e lascia continuare i tool.

### Muffin

M5/decisione owner aveva già scelto:

```text
snapshot pre-effect
→ effect intent
→ execute
→ outcome
→ reusable undo
→ conversational/work reconciliation
```

con snapshot per turno e separazione `reversible != rerunnable`.

### Verdict

**KEEP + TIGHTEN — DAY-1.**

Per Muffin uno snapshot che rende eseguibile una capability `draft/reversible` è
una **precondizione di safety**, non observability best-effort:

```text
snapshot failed
→ effect MUST NOT start
```

È la stessa logica già pagata dall'EFFECT WAL: fallire la scrittura dell'intento
non può lasciare partire l'handler.

Non copiare il checkpoint manager Hermes come tecnologia per forza. Copiare la
semantica; scegliere storage/meccanica in `slice/undo-journal` con failure-path
evidence.

---

## 8. ASK / approvals

### Peer lesson

Letta client tools rappresentano il remote/local tool call come una pausa con
richiesta contenente tool e arguments; il client esegue e restituisce il result.
OpenClaw/modern harnesses distinguono steering da cancellation e tool already
started da unstarted.

### Muffin

Il kernel ha `ask`, ma M5 D12 nota che l'UX corrente non mostra ancora abbastanza
il piano concreto e non ha una durable approval queue completa.

ADR-0050 aggiunge un requisito ancora più forte per Nodes: local approval legata
all'esatto `ExecutionPlan`.

### Verdict

**TIGHTEN — DAY-1 dove ASK è required.**

Approval UI/protocol deve mostrare la cosa che verrà fatta, non solo capability
name. Il consenso è su canonical resource/args/target, non su una frase generica.

---

## 9. Memory — evidence / beliefs / derived views

### Peer lesson

Hermes usa `USER.md` e `MEMORY.md`: piccole memorie curate e agent-editable,
iniettate come snapshot. La documentazione avverte esplicitamente di non far
scrivere due agent process sulla stessa home.

Letta rende le memory blocks stato persistente editabile direttamente dall'agente
e può condividerle fra agenti. È una forma potente per in-context working memory,
ma è deliberatamente più vicina a «agent state» che a un registro epistemico
bitemporale.

### Muffin

Muffin separa:

```text
Evidence      what actually entered/happened
Beliefs       interpretations, temporal, supersedable/contradictable
Derived       embeddings/index/profile/digest
```

ADR-0004/0006/0038/0040 danno già provenance, bitemporalità, contradiction,
supersede, review e rebuildability.

### Verdict

**KEEP.**

Non sostituire la memoria canonica con file agent-editable o context blocks.
Possiamo avere derived/profile views equivalenti a USER.md/blocks per velocità di
context, ma non devono diventare il source of truth.

### One remaining architecture question: intentional memory write

ADR-0032 contiene già la correzione owner: il pipeline-only è troppo rigido;
Muffin deve poter dire intenzionalmente «questo vale la pena ricordarlo» durante
il turno.

Il runtime corrente ha solo `memory.read`, non un memory-write tool.

La decisione lasciata aperta dall'ADR è ancora reale:

```text
A) agent direct-commits canonical Belief
B) agent emits durable memory proposal/candidate
   → canonical reconciliation lane commits/merges it
```

Peer flat-memory designs rendono A naturale. La separazione Evidence/Beliefs di
Muffin dà però un motivo architetturale forte per B. **REOPEN — owner decision.**

Raccomandazione della passata: B, con un caso speciale semantico ma non un secondo
writer:

- owner dice esplicitamente «ricorda X» → la frase/istruzione è Evidence subito;
  la candidate Belief può avere forte provenance owner ma passa comunque dal
  canonical writer;
- Muffin decide «questa cosa importa» → durable candidate con origin=agent,
  source evidence ids, tier/confidence;
- extraction/consolidation e intentional write convergono sulla stessa identity /
  contradiction/supersede path;
- duplicate proposal + later automatic extraction devono diventare una sola
  canonical belief, non due righe concorrenti.

Questa scelta mantiene «Muffin può ricordare intenzionalmente» senza creare due
writer della verità appresa.

---

## 10. Context / profiles

### Peer lesson

Hermes USER/MEMORY sono frozen per session per cache stability. Letta core memory
blocks sono always-in-context e modificabili. Entrambi mostrano il valore di una
piccola proiezione ad alta frequenza separata dall'archivio più grande.

### Muffin

Persona / identity / voice sono separati da learned owner memory; recall porta
solo ciò che serve; derived profiles/digests sono già classificati rebuildable.

### Verdict

**KEEP + DEFER derived profile sophistication.**

Un future owner-profile block può essere una proiezione rebuildable della
Beliefs layer, non una quarta memoria concorrente. Non costruirlo finché context
pressure/latency non lo rende utile.

---

## 11. Delegation / subagents

### Peer lesson

Hermes ha un disegno pratico forte:

- fresh isolated context;
- child inherits parent-enabled toolsets but cannot widen;
- leaf blocks `delegate_task`, user clarification, shared-memory write,
  cross-platform send and scheduling;
- default spawn depth 1;
- cancellation follows ownership;
- only final summary returns to parent context.

Questo è quasi esattamente il safety shape che ADR-0033 aveva scritto prima di
implementare nulla.

### Muffin

ADR-0033 rinvia la delega con trigger misurato, fresh context, subset capability,
depth 1, no recursive spawn, returned result carries source tier.

### Verdict

**KEEP DEFERRED + TIGHTEN semantics.**

Quando arriverà:

```text
subagent = scoped Work computation
not a new Muffin
not a new authority root
not a shared-memory writer
```

Default child capabilities should exclude at least:

- recursive delegation unless explicit orchestrator role/depth;
- direct shared canonical memory write;
- scheduling new durable owner work;
- cross-surface send;
- authority widening.

A child can propose outputs/effects; parent/Home retains canonical commit and
Authority. Enable only when ADR-0033's trigger or a new measured consumer fires.
Not DAY-1 by peer parity alone.

---

## 12. Local model / compute routing

### Peer lesson

Hermes permits model/provider selection for delegates and multiple terminal
backends. Letta separates server agent and client execution. OpenHands separates
agent from Workspace.

### Muffin

Provider/model are already replaceable compute; ADR-0050 allows Home-local,
Node-local, dedicated owner-controlled or remote provider placement.

`local-agentic-runtime.md` proposes Muffin-specific eval before routing.

### Verdict

**KEEP direction + DEFER automatic router.**

Start with explicit placement/profile experiments. Do not build a generic
resource optimizer before evidence says switching targets per task materially
helps.

---

## 13. Extensions / MCP / community code

### Peer lesson

MCP makes local execution ergonomically easy but does not create containment or
least authority automatically. OpenHands's V1 move away from mandatory sandbox
also demonstrates that “extension point” and “security boundary” must not be the
same abstraction.

### Muffin

`EXTENSIONS.md` already separates:

```text
package != capability != grant
```

and requires requested authority to be inspectable separately from install.
`SECURITY.md` correctly treats current third-party local MCP process as TCB until
process-level containment exists.

### Verdict

**KEEP.**

For public alpha, Node/hardware bridge can become another extension contract,
without creating a universal `Plugin` interface. Manifest/catalog/governance do
not become DAY-1 runtime work before a consumer.

---

## 14. Proactivity / presence

### Peer lesson

Hermes's competing philosophy — let the model see runtime facts and justify user
contact — is a valid argument for transparency. Existing Muffin research already
recorded it and also measured why a deterministic outer rail is still useful.

OpenClaw's queue semantics independently reinforce a more general point:
`being present` includes being able to wait, accept guidance, queue work and stay
silent; it is not continuous unsolicited output.

### Muffin

ADR-0028 chose high-confidence actionable signals + deterministic rail; ADR-0045
defines presence as work/attention continuity, not activity.

### Verdict

**KEEP.**

Tighten observability of suppression/deferral rather than moving the safety gate
back into model judgement. Unratified speculative absence/gone-quiet detector
stays evidence-driven and does not become architecture by being interesting.

---

## 15. Observability / proprioception

### Peer lesson

Remote workspaces, Nodes, queues and worker isolation increase the number of
failure classes users need to distinguish. Mature harnesses expose runtime/session
state rather than reducing every failure to “agent failed”.

### Muffin

`doctor`, traces, prompt provenance, turn/delivery state and RoT readers are
already strong. M5 E7 correctly identifies the missing model-facing half:
`sys.inspect`.

### Verdict

**KEEP + TIGHTEN.**

As topology grows, inspection must distinguish at least:

```text
Home unhealthy
Surface disconnected
Node offline
Node local denial
Worker failed
Provider failed
Work waiting/interrupted
Effect uncertain
Delivery failed
```

`sys.inspect` must read the same authoritative state as doctor/control plane, not
maintain a second narrative.

---

## 16. Storage / database

### Peer lesson

Hermes's warning against two writers on one memory home and OpenHands's
one-source-of-truth principle both point at explicit state ownership, not a
particular database engine.

### Muffin

SQLite/WAL is currently sufficient and gives durable local state cheaply. The
current code already has multiple DB handles in places, so “one PID” must never
be mistaken for atomicity.

### Verdict

**KEEP SQLite; TIGHTEN ownership.**

Do not introduce Postgres/Redis/broker for Node topology. If a future Node or
worker cannot participate in one transaction, use durable idempotent handoff and
explicit semantic commit ownership instead of pretending network operations are
atomic.

---

## 17. Active-active / offline continuity

### Peer lesson

Remote/client patterns usually keep one agent/server authority and reconnectable
clients. They do not give us a free replicated-personal-agent consistency model.

### Muffin

ADR-0050 explicitly keeps one active Home.

### Verdict

**DEFER — post-MVP research.**

No leader election, CRDT continuity, multi-Home merge or local authority takeover
until a real outage pattern justifies distributed-consistency cost.

---

## 18. Architecture outcome

The broad comparison does **not** suggest replacing Muffin with a peer-shaped
harness. It suggests a smaller set of targeted corrections:

```text
ADOPTED       Home / Node topology + local ceiling
DAY-1         smart multimodal ingress + busy-input semantics
DAY-1         undo snapshot as fail-closed precondition for reversible draft
DAY-1         rich/durable ASK where policy requires it
KEEP          evidence/beliefs temporal memory architecture
KEEP          durable Work / wait / resume
KEEP          policy kernel + sandboxed hands
KEEP          narrow core / capability grants
DEFER         delegation until measured trigger
DEFER         automatic local/remote model routing until eval
DEFER         generic Node fabric until first real Node consumer
POST-MVP      replicated / offline authoritative continuity
REOPEN        intentional memory write: direct canonical commit vs candidate
```

The remaining `REOPEN` is intentionally not resolved in this evidence document.
It changes canonical ownership in the Beliefs plane and therefore requires an
owner decision or a new piece of evidence strong enough to eliminate one of the
alternatives.

## Sources checked in this pass

- OpenClaw — Steering queue / command queue / agent runtime:
  https://docs.openclaw.ai/concepts/queue-steering
- Hermes Agent — persistent memory:
  https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/
- Hermes Agent — delegation:
  https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- Hermes Agent — checkpoints and rollback:
  https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback
- Letta — client-side tools:
  https://docs.letta.com/guides/agents/tool-execution-client-side/
- Letta — memory blocks / AgentState API:
  https://docs.letta.com/api/resources/agents
- OpenHands Agent SDK — design principles:
  https://docs.openhands.dev/sdk/arch/design

Research snapshots in `docs/blueprint/research/` remain useful lineage, but any
peer fact used to make a new decision was checked against current documentation
again on 2026-08-20.
