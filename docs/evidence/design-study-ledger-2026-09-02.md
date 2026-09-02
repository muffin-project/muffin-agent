# Design / study ledger — snapshot 2026-09-02

**Tipo:** evidence, snapshot datata. Non governa HEAD.
**Data dello snapshot:** 2026-09-02, su `dev` `28a30c9` (subito dopo la chiusura
di STEP 0).
**Ruolo epistemico:** memoria del reasoning di design già fatto — challenge set,
catalogo di invarianti candidate, alternative già scartate, finding e domande
ancora aperte al momento del freeze.

## Come si legge questo file

- **Le authority correnti vincono sempre.** Codice, schema e config
  possiedono la meccanica; `docs/ARCHITECTURE.md` e `docs/SECURITY.md` la
  semantica corrente; gli ADR in `docs/decisions/` le decisioni. Se una voce
  qui sotto confligge con una di quelle, la voce è sbagliata o è in attesa,
  mai l'inverso. Il conflitto si segnala quando il dominio entra nel lavoro;
  non si corregge l'authority per adattarla al ledger.
- **Non è** architettura corrente, una specifica da implementare, una
  backlog, una nuova authority, né un proposals layer.
- Gli **status** (`INVARIANT`, `DESIGN`, `DESIGN CANDIDATE`, `FINDING`,
  `OPEN FINDING`, `OPEN QUESTION`, `OPEN HYPOTHESIS`, `OWNER DECISION`,
  `PRODUCT DIRECTION`, `COGNITIVE PRINCIPLE`, `CAUTION`) descrivono la
  conclusione dello studio di design **al momento dello snapshot**, non lo
  stato di HEAD.
- Una **OPEN QUESTION non è un requisito.**
- Un **INVARIANT è una sfida/un check** da opporre a una modifica, finché non
  è già promosso in un'authority corrente. La promozione avviene soltanto
  attraverso l'authority corrente appropriata, un ADR o un contratto
  eseguibile, con la sua evidence — mai per citazione di questo file.
- Una voce non si implementa perché compare qui. Un design candidate richiede
  una ragione indipendente: failure misurato, requisito corrente,
  decisione owner, evidence esterna, o invariante già in authority.
- Secondo la regola di `docs/evidence/README.md`, questo file **non si
  aggiorna per farlo tornare vero**: una correzione arriva come errata a
  fianco, o come nuovo snapshot.

---

## A. Product thesis

[INVARIANT]
Muffin è un agente personale persistente, non un chatbot e non un wrapper di un
modello.

[INVARIANT]
`Model ≠ Agent`.

Cambiare modello/provider non deve creare una nuova identità personale.

[INVARIANT]
`Surface ≠ Agent`.

CLI, Telegram, voice, Mac, wearable, speaker o altre superfici devono essere
corpi/porte dello stesso agente, non agenti separati.

[INVARIANT]
`Process lifetime ≠ Agent lifetime`.

Processi, sessioni e device possono morire senza perdere la continuità canonica.

[PRODUCT DIRECTION]
One agent, many bodies.

Home possiede la continuità canonica; Nodes possono fornire presenza/capability
locale; Surfaces sono porte d'interazione.

[PRODUCT DIRECTION]
Autonomia progressiva: Muffin guadagna libertà per scope/evidence, non riceve
una fiducia globale indistinta.

---

## B. Canonical ontology

[INVARIANT]
`Evidence ≠ Belief`

Un'osservazione/fonte non diventa automaticamente qualcosa che Muffin considera
vero.

[INVARIANT]
`Work ≠ Effect`

Volere/fare lavoro e causare una mutazione del mondo sono piani diversi.

[INVARIANT]
`Identity ≠ Authority`

Sapere chi è una persona non implica cosa quella persona può autorizzare.

[INVARIANT]
`Canonical ≠ Derived`

Embeddings, indexes, profili, summaries, mappe, projections e prompt assembly
non sono la continuità canonica.

[INVARIANT]
`Intent ≠ transport event`

Il significato dell'azione non coincide col messaggio Telegram/HTTP/evento che
l'ha trasportata.

[INVARIANT]
`Memory ≠ task list`

Ricordare qualcosa e dover fare qualcosa sono primitive differenti.

[INVARIANT]
`Artifact ≠ WorkItem ≠ Effect ≠ Evidence`

Non fondere oggetti solo perché possono riferirsi alla stessa attività.

[INVARIANT]
`World State ≠ Evidence`

Il fatto che qualcosa esista nel mondo e la prova/osservazione attraverso cui
Muffin lo sa sono concetti distinti.

[INVARIANT]
`Context ≠ State`

Il context è una projection temporanea dello stato necessaria per decidere il
prossimo passo.

---

## C. Identity / tenancy / authority

[OWNER DECISION]
Owner identity deve derivare da binding stabile autenticato/configurato, non da
reasoning del modello.

Principio:

> The model may learn about the owner.
> It may never decide who the owner is.

[DESIGN]
Owner iff:
- configured ownerId nonempty;
- direct interaction;
- stable authenticated authorId exact.

I gruppi sono tenant separati, es.:
`group:<connector>:<conversationId>`.

L'owner dentro un gruppo è un membro del gruppo, non bypassa automaticamente il
tenant boundary.

[INVARIANT]
Model può proporre un authority operation.
Model non può auto-concedersi authority.

[DESIGN]
Authority deve restare deterministic e inline sul critical execution path.

Hooks/eventi possono osservare/estendere.
Non devono possedere invarianti di sicurezza fondamentali.

[INVARIANT]
Critical invariants → explicit control flow.
Extensibility/observation → events/hooks.

---

## D. Conversation / Turn / Work

[DESIGN CANDIDATE]
Conversation/Thread dovrebbe diventare surface-agnostic.

Semantica proposta:

`Agent = chi è`
`Tenant = trust boundary`
`Conversation = contesto locale di attenzione`
`Surface = dove si parla`
`Turn = durable unit of work`

[INVARIANT]
Conversation attention boundary ≠ memory boundary.

Una nuova Conversation non cancella Evidence e non deve necessariamente
cancellare Work.

[INVARIANT]
New Conversation does not cancel Work.

[INVARIANT]
Stop Work ≠ leave Conversation.

[DESIGN]
Conversation è prospettica/locale.
Episode è retrospettivo.

[INVARIANT]
Request ≠ Goal.

Una richiesta dell'utente può essere risposta senza diventare automaticamente
un Goal durevole.

[DESIGN CANDIDATE]
Goal → Plan revision → WorkItem.

Un Plan deve essere revisionabile.
Step omessi da una nuova revisione non possono restare silenziosamente aperti.

[INVARIANT]
User todo artifact ≠ internal WorkItem.

Una lista TODO visibile è un Artifact/projection, non la macchina dello stato
del lavoro.

---

## E. Durable execution / Effects

[INVARIANT]
Tool invocation ≠ proof of Effect.

Una tool call non dimostra che il mondo sia cambiato.

[INVARIANT]
Unknown Effect ≠ failed Effect.

Un risultato sconosciuto richiede reconciliation prima di retry.

[INVARIANT]
Reconcile before retry.

[INVARIANT]
Wait releases execution.

Aspettare non deve occupare artificialmente un executor/processo.

[DESIGN]
Durable execution vocabulary candidato:

runnable
running
waiting
interrupted
done

Suspension ≠ outcome.

[INVARIANT]
Execution ≠ Work ≠ Effects ≠ Delivery.

[DESIGN]
Effect lifecycle ideale:

intent durable
→ execute
→ observed outcome
→ eventualmente reconcile contro World State/postcondition.

[INVARIANT]
Intent senza `ended_at` = uncertainty, non failure automatica.

[INVARIANT]
`possibly_sent` non deve essere automaticamente ritentato.

[DESIGN]
Rerunnable, reversible e reconcilable sono proprietà diverse.

[DESIGN]
Undo corretto è compensating transaction / Saga, non riscrittura del passato.

La storia deve poter dire:
l'effetto è avvenuto,
poi è stato compensato.

---

## F. Taint / provenance / security

[FINDING]
Il scalar ambient taint è troppo grossolano per alcuni workflow reali.

Lettura di contenuto tainted può impedire un successivo write locale anche
quando quel contenuto non ha scelto l'azione.

[INVARIANT]
Approval does not clean taint.

[DESIGN CANDIDATE]
Taint/provenance dovrebbe descrivere influence propagation e destination/sink,
non paralizzare tutto il turno.

Principio:

> Il taint dovrebbe limitare dove l'influenza può propagarsi,
> non paralizzare tutto ciò che viene dopo.

[OPEN HYPOTHESIS]
Task/action-flow authority può forse sostituire ambient/context taint come
segnale primario, ma SOLO dopo eval comparativo senza material security
regression.

Current security semantics restano incumbent fino ad allora.

[INVARIANT]
Authenticated transport facts ≠ untrusted metadata/content.

Solo transport facts autenticati possono stabilire identity/routing.
Metadata e payload restano Evidence, mai authority.

[INVARIANT]
Prompt filtering is not a security boundary.

---

## G. Context

[INVARIANT]
Il modello deve ricevere abbastanza stato per decidere il prossimo passo,
non abbastanza storia per ricostruire tutto l'agente.

[DESIGN]
Context candidato come typed, fresh, provenance-preserving projection.

Possibili componenti:

- constitutional/stable;
- current Work;
- current Execution;
- World/proprioception;
- Evidence/history rilevante;
- recall;
- open commitments;
- surface capabilities.

[DESIGN CANDIDATE]
Context policy separata dal context assembler.

Il policy layer decide cosa serve.
L'assembler materializza quella projection.

[INVARIANT]
Context lifetime should follow semantic dependency, not turn count.

[DESIGN CANDIDATE]
Typed wake/resume context.

[DESIGN CANDIDATE]
Working set esplicito per document/media/site su cui si sta lavorando.

---

## H. Memory

[INVARIANT]
Many producers → durable MemoryProposal → one canonical reconciliation path
→ active Belief.

No direct-write/two-writer semantics.

[INVARIANT]
Owner statements, external evidence e Muffin inference devono restare
epistemicamente distinguibili.

[INVARIANT]
Agent output non deve diventare prova di sé stesso.

[DESIGN]
Memory lineage già promossa:

TurnRecord.id
→ SessionMessage.traceId
→ Episode.turn_id
→ RecallItem.turnId

Exact current-history exclusion.
No fuzzy dedup per distinguere history da recall.

[OPEN FINDING]
Actor attribution non è ancora sufficientemente ricca:
principal → canonical identity → actor → Episode.actorId → extractor speaker →
fact.speakerId.

[OPEN FINDING]
Generic group consolidation è disabilitata / incompleta.

[INVARIANT]
Documents may be indexed without being automatically mined into canonical
beliefs.

[COGNITIVE PRINCIPLE]
Understanding ≠ frequency.

Intensity, affect, trend, context specificity, silence, significance, confidence
sono segnali distinti da considerare quando consumer reali lo richiedono.

[COGNITIVE PRINCIPLE]
Forgetting is a feature, but Muffin should complement human forgetting rather
than blindly imitate it.

[CAUTION]
Non costruire salience/decay/person-model machinery solo perché il principio è
plausibile. Serve failure osservato + kill criterion.

---

## I. World / Artifact

[INVARIANT]
Artifact bytes ≠ artifact identity ≠ artifact index.

[DESIGN]
Vault bytes/source data are source of truth.
Indexes are derived.

[INVARIANT]
Memory non deve diventare un world catalog generico.

[DESIGN CANDIDATE]
File existence / resources / current external state appartengono a
World/Artifact State, non a Belief soltanto.

[OPEN QUESTION]
Quanto World State generico serve davvero prima di consumer concreti?

Default: non costruirlo preventivamente.

---

## J. Voice / Activity / Hands

[INVARIANT]
Voice ≠ Activity ≠ Hands.

Voice = intentional communication.
Activity = deterministic runtime facts/state transitions.
Hands = capabilities/effects.

[INVARIANT]
Non mostrare chain-of-thought come Activity.

Mostrare:
- started;
- waiting;
- needs approval;
- executing capability;
- completed/failed/uncertain.

[FINDING]
Worker/subagent claims devono esistere solo quando c'è un WorkerRun/durable
execution realmente osservabile.

---

## K. Nodes / surfaces

[DESIGN]
Home canonical.
Node authority ceiling.

Effective Node execution authority:

Home-authorized request
∩ Node local policy
∩ OS / physical device permissions.

Home non può remotamente allargare il ceiling locale.

[INVARIANT]
Pairing establishes Node identity, not every capability.

[DESIGN]
Surface owns:
- authenticated subject;
- native receipt/idempotency;
- composition;
- rendering/delivery;
- transport metadata.

Surface non possiede memory/agent identity/work/policy.

[DESIGN CANDIDATE]
Busy input vocabulary:

STEER
FOLLOWUP
COLLECT
INTERRUPT

Durable ordering e effect safety devono rimanere deterministic.

---

## L. Community / group isolation

[INVARIANT]
Group/community state is a separate trust boundary.

[DESIGN]
Separate Vault/settings/state where required.

Host ↔ community projection must be explicit and default-deny.

[INVARIANT]
Owner presence in community non autorizza automaticamente il main personal
agent a riversare private state nella community.

[DESIGN]
Canonical owner identity deve essere risolta prima di far agire il personal
agent in un gruppo.

[PRODUCT DIRECTION]
Physical separation può essere desiderabile quando il threat model lo rende
utile, ma non costruire distributed infrastructure prima del consumer.

---

## M. Ingress

[DESIGN]
Tre classi:

1. authenticated transport facts;
2. untrusted descriptive metadata;
3. untrusted payload/content.

Solo (1) può stabilire identity/routing/authority facts.

(2) e (3) diventano Evidence.

[INVARIANT]
Metadata supplied by an external sender cannot grant authority.

---

## N. Cognition / person model

[DESIGN]
Usare deterministic logic quando il dominio lo consente.

Candidate cognition levels:

LIGHT = mechanical/candidate generation.
MAIN = semantic ambiguity.
HUMAN / HOLD BOTH = uncertain epistemic consequence.

[DESIGN]
Dreaming/reflection should reduce uncertainty / structure continuity,
not manufacture “interesting insights”.

[DESIGN]
Reflection output candidato:

hypothesis
evidence
counterevidence
confidence
usefulness

Non auto-promuoverlo a Belief.

[INVARIANT]
Belief holder ≠ subject.

[INVARIANT]
Owner agreement ≠ truth.

---

## O. Provider / model runtime

[INVARIANT]
Provider is replaceable compute, not identity.

[DESIGN]
Separare semanticamente:

modelResidency
promptPrefixCache
cacheTTL
providerStickiness
telemetry
responseCache

Non chiamare tutto “cache”.

[FINDING]
Ollama keep_alive/residency non implica necessariamente prompt-prefix cache.

[DESIGN]
Stable prefix + volatile tail è la forma preferibile quando il provider la
premia.

[INVARIANT]
Routing semantics first, provider-specific optimization second.

---

## P. Shell / tools / capabilities

[DESIGN]
Shell è una capability fondamentale, non necessariamente una feature
eccezionale.

Candidate naming:
`workspace.exec`
vs
`host.shell`

La scelta deve seguire authority/resource semantics reali.

[DESIGN]
Tool taxonomy candidato:

primitive capabilities
domain capabilities
workflows/compositions

[INVARIANT]
Una dedicated capability merita di esistere quando possiede semantics che
devono vivere in Effect/Authority/durable state, non solo perché è comoda.

---

## Q. Engineering / design principles learned

[INVARIANT]
One semantic → one owner.

[INVARIANT]
Semantic name = primary identity.
Opaque ID = optional stable handle.

[INVARIANT]
Generated ≠ Derived.

Un derived subsystem può contenere editorial source, generator, checker,
template e generated outputs.

[INVARIANT]
Current claim → must agree with HEAD.
Evidence claim → must agree with observation.
Historical claim → must agree with historical state.
Derived current view → must be reproducible/verifiable from current authority.

Never “refresh” evidence into current truth.
Never knowingly leave current truth stale.

[INVARIANT]
Permanent mechanisms/checkers must earn existence from a measured/load-bearing
failure.

[INVARIANT]
Use the smallest mechanism that falsifies the claim.

[OWNER DECISION]
Repair at the lowest semantic layer that eliminates the class of failure.

Escalation candidate:

line
→ function
→ contract
→ type/schema
→ boundary

Escalate only if the lower fix leaves the invalid class representable,
recurrent or structurally likely.

No broad refactor merely because a wider one looks cleaner.

[INVARIANT]
A valid domain value must not double as the silent sentinel for
“source unavailable”.

Example observed:
unreadable DAY-1 inventory → `[]` → `0 su 0`.

[INVARIANT]
Tests can accidentally prove the author's environment instead of the product.

Observed:
- Git global default branch;
- BSD vs util-linux PTY behaviour;
- network error-code platform differences.

Do not create a generic portability framework without recurrence.

---

## R. Open findings / questions at freeze

These are NOT automatically prerequisites or backlog.

F2 — architecture reconciliation.

F5 — persist lowest-semantic-layer repair principle if not already promoted.

F6 — CI verifier ownership / path filtering gap.

F7 — executable logic embedded in rule prose can silently break.

F8 — possible ownership overlap among requirement status / applicability /
critical path.

F10 — future public-repo operational-state boundary.

F17 — architecture map has `file:line` references embedded in prose:
135 total, 94 with stale displayed line; canonical anchors already know the
correct line, renderer currently applies `ancore()` only to `rif`.

Other open design questions:
- surface-agnostic Conversation shape;
- canonical Goal / Plan revision / WorkItem model;
- World State scope;
- task/action-flow security model;
- context policy vs assembler;
- actor attribution;
- community projection;
- WorkerRun/durable delegation semantics;
- local/owner-controlled inference placement.

None of these should be implemented merely because it appears here.

---

# END LEDGER
