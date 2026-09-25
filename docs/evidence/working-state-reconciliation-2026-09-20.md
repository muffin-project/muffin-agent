# Working state per lavoro long-horizon — riconciliazione 2026-09-20

> **Evidence snapshot, non backlog e non ADR.** Questa passata riconcilia nuovi
> segnali di ricerca con il repository e lo stato Git/GitHub osservati. Non
> autorizza da sola una nuova tabella, un nuovo registry, dynamic tool discovery
> o un giudice semantico nel runtime.

## Verdetto

Muffin ha già la separazione semantica che i nuovi lavori rendono desiderabile:
conversation history è Evidence, la memoria episodica non è Work, il `Turn` è
uno stato di esecuzione durevole e Authority resta un kernel deterministico
esterno al modello. Non serve importare un'altra tassonomia.

Il gap reale è più stretto: lo stato necessario a portare avanti un obiettivo
lungo è distribuito tra `Turn`, todo, tool-call/effect records e fonti di
evidenza. Non esiste una proiezione tipata task-level che renda espliciti
obiettivo, vincoli, avanzamento, blocker, riferimenti alle prove e punto di
continuazione senza ricostruirli dalla prosa. Il todo è un piano persistente per
sessione; non è l'identità canonica di un task e non registra da solo claim
verificati, prove o tentativi.

La prossima mossa corretta non è aggiungere subito `Task` o `WorkingMemory` al
database. È valutare una **proiezione derivata e ricostruibile** dagli owner già
esistenti. Solo un beneficio misurato può giustificare una nuova identità
canonica sopra `Turn`.

## Snapshot osservato

La ricognizione è stata eseguita su `origin/dev` al commit
`1fbe5b1ac313b3e23b03f6dbda6b83defc4dbc8f`, in una worktree isolata. Al momento
della lettura:

- `dev` locale nel checkout principale era pulito ma divergeva da `origin/dev`;
- non c'erano PR aperte;
- #608 era il programma corrente e dichiarava ancora pendenti acceptance Linux,
  verifica esterna e promozione del candidate;
- #469 e #607 erano aperte ma parcheggiate fino al freeze di #608;
- esisteva una worktree separata e sporca per #469 con una prima implementazione
  `search/load` su una base precedente: è stata letta come evidence e lasciata
  intatta.

Queste sono condizioni datate. Prima di trasformare questo memo in lavoro va
ricostruito lo stato live.

## Dove vive oggi ogni significato

| Superficie | Owner attuale | Cosa garantisce | Cosa non è |
|---|---|---|---|
| Conversation history | `core/session/` | record append-only di ciò che è stato detto | stato mutabile del lavoro; memoria canonica |
| Episodi e belief | `core/memory/` | Evidence durevole, interpretazioni riconciliabili e retrieval | avanzamento corrente del task |
| Esecuzione corrente | `core/turns/` | identità, transcript del loop, taint, contatori, lease, wait/continuation e tool-call WAL | necessariamente l'obiettivo long-horizon sopra più turni |
| Piano esplicito | `core/turns/todo.ts`, `agent/tools/todo.ts` | lista persistente per `(tenant, session)`, con stati e reiniezione a ogni turno | task identity, claim ledger o prova che un passo sia vero |
| Effetti | `turn_tool_calls` e delivery state | intento/outcome, possibile effetto, rerunnability, undo/delivery | ricordo narrativo del lavoro |
| Skill | `core/skills/`, `agent/tools/skill.ts` | metadata sempre visibile, corpo/file letti al bisogno | capability o grant |
| Authority | `core/policy/`, Root of Trust | decisione deterministica su fatti tipati | giudizio del modello o proprietà dello working state |

La separazione chiave è già nel codice: `core/session/store.ts` dichiara il
transcript Evidence append-only e non memory; `core/turns/store.ts` dichiara il
`Turn` record mutabile distinto, con fencing, lease, counters e WAL. Anche il
progressive disclosure delle skill è già reale: il prompt contiene nome e
descrizione, mentre `skill_read` carica il corpo o un file solo al bisogno.

## Segnali esterni e limiti

### Recuris

Recuris separa una Working Memory che traccia il progresso dalla Experiential
Memory di skill/esperienze, e usa la prima per guidare il retrieval della
seconda. Il paper riporta miglioramenti in 35 delle 37 combinazioni completate
su quattro benchmark e dieci modelli, con il vantaggio maggiore sui task più
lunghi. Il repository descrive inoltre validazione deterministica delle skill
candidate.

Questo **supporta** uno working state esplicito che orienti la selezione di
skill. Non dimostra che Muffin debba introdurre una nuova tabella o skill
self-modifying: è un singolo paper recente, alcuni risultati per-task sono
negativi e la sua evoluzione ricorsiva delle skill ha un rischio/owner diverso.

Fonti primarie:

- https://arxiv.org/abs/2608.24876
- https://github.com/Gen-Verse/Recuris

### HyMem

HyMem separa planning persistente, dettagli di esecuzione e reasoning temporaneo,
con summary strutturati che preservano il progresso nei refresh di contesto. Il
paper riporta +6,1 e +4,7 Pass@1 sui due benchmark valutati.

Questo **contraddice** il flattening di piano, execution trace e reasoning in un
solo contesto. Non decide il livello di persistenza corretto per Muffin: è un
paper recente, su due benchmark, senza replica assunta qui.

Fonte primaria: https://arxiv.org/abs/2608.15703

### Tool e skill discovery

La documentazione Anthropic consiglia tool search quando la superficie supera
circa dieci tool, le definizioni consumano molto contesto o la selezione degrada;
dichiara anche costo di latenza e beneficio minore con set piccoli o quasi tutti
frequenti. Questo supporta progressive disclosure, non una sua applicazione
automatica.

Muffin ha già progressive disclosure per le skill. Per i tool, #469 ha la
decisione ancora aperta e un vincolo più importante: prima convergere le fonti
oggi duplicate (`ToolSpec`, `CapabilityDecl`, ordine/manual assembly e mappe
runtime) in una definizione/registry canonico; poi misurare se search/load batte
la superficie statica. Aggiungere un secondo catalogo qui replicherebbe proprio
il problema che #469 deve rimuovere.

Fonti primarie:

- https://www.anthropic.com/engineering/advanced-tool-use
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool

### Separazione dello stato

OpenAI Agents SDK distingue il contesto locale di run, la conversation history
nelle sessioni e la memoria dell'agente; espone inoltre visibilità dei tool
deterministica dal contesto locale. È prior art compatibile con i cinque piani,
non autorità sullo schema di Muffin.

Fonti primarie:

- https://openai.github.io/openai-agents-js/guides/context/
- https://openai.github.io/openai-agents-python/sessions/
- https://openai.github.io/openai-agents-python/sandbox/memory/

## Confini con le issue esistenti

- **#598** possiede il goal autonomo durevole e il percorso unattended. Uno
  working-state eval per la continuazione di quel goal appartiene a questo
  problema, non a un secondo programma di autonomia.
- **#469** possiede definizione/registry e discovery delle capability. Lo working
  state può in futuro fornire query o vincoli, ma non deve possedere il catalogo
  né caricare capability prima del filtro di Authority.
- **#614** possiede la familiarità durevole cross-session su progetti e workflow.
  È memoria stabile/procedurale; non deve diventare lo stato volatile del task
  corrente.
- **#607** possiede il judgment plane di sviluppo, Jev shadow pack e calibration
  harness. Jev non è una dipendenza del baseline e non può decidere Authority,
  effetti o claim deterministici.
- **#603** possiede il limite di vita delle continuation lease; una proiezione di
  stato non deve aggirare quel budget o trasformare continuation esplicita in
  auto-retry.

Non serve una nuova issue finché #598 può ospitare il claim sperimentale senza
ambiguità di owner. Se in seguito emergesse un consumer indipendente dal goal
autonomo, quella sarebbe evidence per separarlo.

## Proiezione candidata, non schema

La forma da valutare è un read model, non una nuova fonte di verità:

```text
WorkSnapshot (derived)
  work identity         existing Turn; future Goal only if earned
  objective/constraints explicit owner/work artifacts
  completed/pending     todo state + observed outcomes
  evidence refs         references, never copied claims promoted to truth
  attempted actions     tool-call/effect records
  blockers              waits, continuable reason, failed outcomes
  continuation point    last safe boundary
  capability candidates authority-filtered registry results, if #469 earns them
```

`WorkSnapshot` non contiene grant, eccezioni o trust score. È rebuildable; in un
conflitto vincono i record canonici dei rispettivi piani. Il modello può usarlo
per orientarsi e proporre il passo successivo, non per cambiare permessi.

## Eval prima del runtime

Claim falsificabile:

> Su scenari long-horizon con interruzione o compaction, una proiezione derivata
> dagli owner esistenti riduce ricostruzione, azioni duplicate e claim stale
> rispetto a transcript + todo, senza nuove violazioni di Authority o perdita di
> prove.

Primo harness, dopo il freeze di #608:

1. fixture con provider failure e continuation della stessa lease;
2. fixture multi-turn con step completati, blocker e prove in file/tool outcome;
3. fixture di goal schedulato che attraversa restart;
4. fixture con tool result compattati ma riferimenti ancora recuperabili.

Confronto minimo:

- **A:** assembly corrente (history + todo + recall);
- **B:** stesso input più `WorkSnapshot` derivato;
- **C, solo dopo #469:** B con discovery da registry authority-filtered.

Metriche: completamento, letture/tool-call ripetute, effetti duplicati, claim
stale o inventati, token/latency, recovery dal boundary corretto, decisioni di
policy identiche. Il kill criterion è nessun miglioramento sostanziale o un
aumento di stale-state/errori: in quel caso non si aggiunge né projection né
schema.

Jev può essere un osservatore opzionale solo dopo che #607 ha dataset,
calibrazione e sovereignty test. Il baseline e i criteri di pass/fail restano
deterministici; assenza di chiave/SDK significa skip esplicito, non fallback
presentato come evidenza Jev.

## Decisione di questa passata

- aggiornare l'architettura corrente per nominare il gap senza fingere che una
  soluzione sia shipped;
- conservare questo memo come evidence datata e contratto dell'esperimento;
- non modificare runtime/schema durante il programma #608;
- non riprendere o sovrascrivere la worktree sporca di #469;
- non creare un duplicato di #598/#469/#607/#614;
- non chiamare Jev: chiave e SDK non erano presenti e il task corrente richiede
  fatti di repository deterministici, non un giudizio semantico.
