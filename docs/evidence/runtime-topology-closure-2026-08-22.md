# Runtime topology — architecture closure matrix

> **Superata — evidence storica, non direzione corrente.**
> Le decisioni uscite da questo lavoro vivono in ADR-0050 (una Home, molti
> capability node), ADR-0051 (molti produttori, un writer semantico della
> memoria) e ADR-0052 (eventi surface, intent e work), tutti su `dev` dal
> 2026-08-25, e nella forma corrente di `docs/ARCHITECTURE.md` e
> `docs/SECURITY.md`. Questo file resta perché conserva il *perché* e il
> vocabolario di lavoro che l'ADR non ripete — non perché descriva HEAD.
> Per lo stato corrente parti sempre da `docs/README.md`.


**Status:** working closure record, non normativo  
**Data:** 2026-08-21  
**Normative decisions:** ADR-0050 + ADR-0051 + `docs/ARCHITECTURE.md` + `docs/SECURITY.md`  
**Phase placement authority:** `docs/ROADMAP.md`

Questo documento risponde a una domanda sola:

> **Resta qualche scelta architetturale fondamentale con due semantiche plausibili e incompatibili che dobbiamo decidere prima di costruire?**

Non possiede Gate status, ordine del lavoro o roadmap. Se una capability è deliberatamente rinviata, la fase autorevole vive in `docs/ROADMAP.md`; se diventa DAY-1, entra in M5.

## 1. Decisioni architetturali chiuse

| Tema | Decisione |
|---|---|
| identità | One Muffin = one durable continuity; non PID/device/model/surface |
| semantic state | Evidence · Beliefs · Work · Effects · Authority restano i cinque piani |
| topology | Home · Node · Surface · Worker/Executor · Compute target sono ruoli ortogonali ai cinque piani |
| Home | una sola Home autorevole attiva nella fase corrente; migrabile; non è Muffin |
| Node | stable paired capability endpoint; non è un secondo agente |
| Surface | interaction/transport; distinta da Node |
| process model | process boundaries solo quando comprano trust/crash/resource/lifecycle/placement; niente vincolo one-PID |
| canonical ownership | canonical transitions hanno un owner Home; worker/node possono calcolare/eseguire senza possederle |
| canonical Beliefs writer | many producers, one semantic writer: agent/extractor/importer/node/subagent producono candidate; solo reconciliation Home canonizza/merge/supersede |
| intentional memory | Muffin può decidere cosa vale la pena ricordare, ma non direct-commit una active Belief né autoassegnarsi tenant/provenance/taint |
| Node authority | `Home allow ∩ Node local ceiling ∩ OS permission`; il ceiling locale non è bypassabile remotamente |
| pairing | prova Node identity, non authority illimitata |
| approval | legata all'ExecutionPlan canonico; cambiare target/resource/args invalida il consenso |
| Node protocol | proprietà semantiche/security decise; transport concreto intenzionalmente non deciso |
| ingress | native event ≠ user intent ≠ work identity |
| grouping | N native events possono comporre un intent/work; policy di composizione surface-specific |
| busy input | runtime deve poter rappresentare STEER / FOLLOWUP / COLLECT / INTERRUPT a safe boundaries |
| multimodality | internal input deve poter essere typed/multipart con provenance per part; `text: string` non è la forma finale |
| effects | effect intent/outcome e uncertainty restano separati; reversible ≠ rerunnable; rollback deve riallineare mondo e Work/context |
| reversible safety | quando uno snapshot/undo record è la precondizione che rende eseguibile una mutazione reversibile, fallire la precondizione impedisce l'effect |
| model placement | modello/provider è compute sostituibile; può essere Home/Node/owner-controlled/remote senza possedere authority |
| schema evolution | canonical state deve sopravvivere a upgrade versionati; una migrazione non sicura fallisce prima dell'uso normale, non degrada silenziosamente |
| extension authority | `package != capability != grant`; installare codice non gli concede implicitamente authority |
| storage technology | SQLite non viene sostituito per eleganza; topology non implica DB service |
| active-active | nessuna leader election/replica autorevole implicita dai Node nella fase corrente |
| pendant | futuro Node + Surface specializzato, non protocollo/agente separato |

## 2. Architettura decisa, meccanica ancora da costruire o riconciliare

Queste aree **non sono decisioni architetturali aperte**. Il loro status reale appartiene a M5/codice/evidence.

### Smart ingress e conversazione mentre Muffin lavora

```text
native events
→ durable typed fragments + provenance
→ surface-specific assembler
→ user intent
→ durable Work identity
```

Receipt continua mentre altro Work è vivo. Nuovo input può diventare STEER, FOLLOWUP, COLLECT o INTERRUPT a safe boundary. Transport idempotency non viene confusa con work identity.

`slice/inbound-unit` va mediata rispetto a questa forma: la proprietà utile è exactly-once dell'evento, non `update_id == turn_id`.

### Multimodalità

Original media = Evidence; transcript/OCR/caption = derived representation; current-turn native media può essere passato al provider quando supportato.

Il primo consumer implementa solo ciò che serve davvero. La forma interna deve comunque poter contenere più parti con provenance distinta.

### Voice

```text
audio evidence
→ transcription
→ transcript with provenance
→ composed input
```

Whisper/faster-whisper è un implementation candidate, non l'identità architetturale.

### Intentional memory

ADR-0051 chiude il writer model:

```text
remember / agent inference
→ durable candidate
→ canonical reconciliation
→ active / merged / superseded / rejected Belief
```

Schema, tool name e inline-vs-background scheduling non sono ancora decisi.

### First Node

La semantica minima è già vincolata:

```text
stable identity + pairing
presence/reconnect
capability advertisement
request identity/idempotency
local ceiling
ExecutionPlan-bound approval
ACK / started / outcome separation
```

Quale capability sia il primo consumer e quando venga implementata appartiene alla roadmap/evidence.

### Effects / undo

Il WAL dell'intento è già una base. Il layer di snapshot/undo deve preservare la regola fail-closed sulla precondizione e riallineare anche il Work/context che aveva osservato l'effetto annullato.

Storage concreto e granularità meccanica vengono verificati nella slice, non da questa closure.

### Schema evolution / backup

La decisione architetturale è preservare canonical state attraverso upgrade e fallire esplicitamente prima dell'uso se la migrazione non è applicabile. Migration runner, metadata e backup mechanics restano implementazione.

### Extensions

Il core non cresce in un plugin monolitico. Package/capability/grant restano separati; containment si sceglie in base ad authority, trust e lifecycle del consumer reale.

### Observability / proprioception

`sys.inspect` e control-plane diagnostics devono leggere le stesse source of truth di doctor/status/trace. La topology rende necessario distinguere Home, Surface, Node, Worker, provider, Work, Effect e Delivery failures senza mantenere una seconda narrativa.

## 3. Decisioni volutamente lasciate all'implementazione o all'evidence

Queste possono cambiare senza cambiare il significato dell'architettura:

- WebSocket vs QUIC vs altro transport Node;
- discovery locale vs rendezvous/Tailscale/manual pairing;
- valore della Telegram quiet/coalescing window;
- algoritmo/euristica/modello che aiuta a classificare STEER vs FOLLOWUP;
- Mac vs VPS come Home concreto del primo dogfood;
- prima capability del Mac Node;
- quale modello locale, quantizzazione o server usare;
- quando un worker merita un PID separato;
- se una futura `Intent` entity/table serve oltre al Turn;
- schema/table/tipo esatto di `MemoryProposal`;
- queue fisica vs chiamata diretta al canonical belief reconciler;
- scheduling/latency target della reconciliation intenzionale;
- naming fisico di agent-inferred vs pipeline-inferred;
- migration runner e metadata/version table concreti;
- backup/rollback mechanics per migrazioni;
- process sandbox/container/remote worker scelto per una specifica extension;
- renderer/UI concreta di `sys.inspect`;
- algoritmo futuro di compute placement/routing.

Una scelta in questa lista diventa architetturale solo se un consumer dimostra che due opzioni cambiano ownership, authority, durability, trust o continuity semantics.

## 4. Phase placement non vive più qui

Le cose rinviate — first Mac Node, Capsule/Home migration, local compute experiments, overflow/context-pressure UX, proactivity, public extension containment, Discord parity, pendant, richer media, multi-Home/offline continuity e altre — sono classificate in `docs/ROADMAP.md`.

Questo file non ne mantiene una seconda copia dettagliata.

## 5. Decisioni architetturali ancora aperte

**Nessuna nota dopo la passata repository-wide corrente.**

La passata ha riesaminato topology, memory, effects/undo, extensions, schema evolution/migrations, observability e il loro rapporto con DAY-1. I problemi residui trovati in questi domini sono implementation/evidence debt o phase placement, non due semantiche fondamentali incompatibili che richiedono una scelta owner oggi.

Questo non rende l'architettura immutabile. Nuovo evidence, dogfood o un consumer reale può riaprire una decisione. Quando succede, non viene risolta qui per inerzia: torna a decisione owner e, se durevole, a nuova ADR.