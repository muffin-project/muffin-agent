# ADR-0051 — Molti produttori, un writer semantico della memoria

**Stato:** accettato · 2026-08-21 · **non implementato al 2026-09-07**: i soli produttori di scritture durevoli restano quelli automatici (ingestione allegati, episodio di ogni turno); nessuna proposta intenzionale (`remember`/correggi/dimentica) raggiunge il writer semantico. Misura e confronto con i peer in `docs/evidence/critica-moduli-vs-peer-2026-09-07.md`; il posto in cui si decide quando entra è `docs/ROADMAP.md` «Intentional memory proposals».

## Contesto

ADR-0032 aveva corretto la prima posizione troppo rigida — pipeline-only — dopo la decisione dell'owner che Muffin deve poter gestire intenzionalmente la propria memoria. Quell'emendamento lasciava però aperta la scelta più importante per il piano Beliefs:

```text
A) il modello scrive direttamente una belief canonica
B) il modello produce una proposta durevole che passa dal percorso canonico di riconciliazione
```

La distinzione non riguarda se Muffin possa decidere *cosa vale la pena ricordare*. Può farlo. Riguarda chi possiede la transizione da una osservazione, istruzione o inferenza a una belief attiva che il sistema tratterà come ciò che Muffin pensa sia vero.

La memoria corrente separa già due piani che non vanno riuniti per comodità:

```text
Evidence  = ciò che è entrato o è successo
Beliefs   = interpretazioni ricostruibili, contraddicibili e supersedibili
```

L'owner ha scelto esplicitamente l'opzione B il 2026-08-21.

## Decisione

**Muffin può produrre intenzionalmente memoria, ma non auto-promuove direttamente una propria proposta a belief canonica.**

Il sistema adotta il principio:

> **many producers, one semantic writer.**

Più componenti possono produrre candidate belief / `MemoryProposal`; una sola semantica di riconciliazione possiede la transizione verso la Beliefs layer canonica.

Forma:

```text
producer
   │
   ▼
durable MemoryProposal
   │
   ▼
canonical reconciliation
   │
   ├── accept / insert
   ├── merge / deduplicate
   ├── supersede
   ├── review
   └── reject / no-op
   │
   ▼
canonical Belief
```

La scelta del nome concreto (`MemoryProposal`, `BeliefCandidate` o altro) è meccanica e può essere decisa dall'implementazione. La proprietà durevole è che il producer non possiede il commit semantico canonico.

## Produttori ammessi

Il pattern deve poter accogliere almeno:

- estrazione automatica dagli episodi;
- istruzione esplicita dell'owner, ad esempio «ricorda che il mio commercialista è Mario»;
- decisione intenzionale di Muffin durante il reasoning, ad esempio «questa informazione è importante e vale la pena conservarla»;
- future import pipeline;
- future Node o sensor pipeline;
- future subagent/delegate, senza trasformarli in writer della memoria condivisa.

Aggiungere un producer non crea un nuovo percorso di commit delle belief.

## Caso 1 — l'owner dice esplicitamente «ricorda X»

La frase dell'owner è **Evidence immediatamente**, indipendentemente dall'esito della proposta. Non serve una belief per conservare il fatto che l'owner abbia detto quella frase.

Esempio:

```text
owner message:
  "ricorda che il mio commercialista è Mario"

Evidence:
  episode/message id = E123
  authenticated speaker = owner
  content = ...

MemoryProposal:
  candidate = commercialista(owner) = Mario
  source = E123
  producer = agent intentional memory
  provenance = owner statement
```

La provenienza forte dell'owner influenza la riconciliazione; non crea un secondo writer.

La UX può essere immediata — Muffin può rispondere «lo ricordo» quando la proposta è stata durabilmente accettata/registrata secondo il contratto implementato — ma non deve mentire dicendo che una belief canonica è stata committata se il percorso canonico non l'ha ancora resa tale.

## Caso 2 — Muffin inferisce autonomamente qualcosa

Una inferenza del modello non diventa vera perché il modello ha deciso che vale la pena ricordarla.

Esempio:

```text
MemoryProposal:
  candidate = owner prefers concise technical communication
  producer = agent inference
  source_evidence = [E10, E44, E91]
  confidence = ...
  tier = max(source tiers)
```

La proposal conserva l'intenzione e la provenienza dell'inferenza. La riconciliazione decide se inserirla, fonderla con una belief esistente, mandarla in review o non promuoverla.

## Un solo writer non significa un solo modello o un solo processo

"Writer semantico unico" non significa necessariamente una singola funzione, PID o chiamata LLM. Significa che esiste **una sola semantica autorevole** per la transizione verso la Beliefs layer.

L'implementazione può usare più passi — normalizzazione, candidate matching, contradiction judge, deterministic dedup, review — purché tutti i producer attraversino lo stesso contratto e nessuno disponga di una scorciatoia che scriva belief attive con regole diverse.

In particolare, un future worker o Node può calcolare una proposta ma la Home mantiene il canonical commit ownership, coerentemente con ADR-0050.

## Riconciliazione con l'estrazione automatica

Il problema che ADR-0032 aveva già nominato — proposta intenzionale oggi, estrazione automatica dello stesso episodio poco dopo — viene chiuso per forma:

```text
intentional proposal ─┐
                      ├─> same identity/reconciliation semantics -> one belief
automatic extraction ─┘
```

Il sistema non deve produrre due belief quasi-identiche soltanto perché arrivano da producer diversi.

L'identità/dedup concreta non è decisa qui. Deve però usare provenance/source identity quando disponibile prima di affidarsi a similarità probabilistica.

Una proposta che contraddice una belief esistente non la cancella direttamente: usa le stesse semantiche di contradiction/review/supersede del resto della memoria. Le regole no-DELETE e bi-temporali restano intatte.

## Provenance, taint e origin sono obbligatori semanticamente

Ogni proposta deve conservare abbastanza informazione da rispondere almeno a:

```text
chi/che cosa l'ha prodotta?
da quale Evidence deriva?
con quale trust/taint è stata prodotta?
era owner-stated, extracted o agent-inferred?
quando è stata proposta?
quale esito di reconciliation ha avuto?
```

I nomi delle colonne non sono architettura. La possibilità di ricostruire queste risposte sì.

La taint non viene lavata dalla proposta: una inferenza nata dopo aver letto Evidence tier 3 non diventa tier 0 perché Muffin l'ha riscritta con parole proprie.

## Durability della proposta

Una `MemoryProposal` che conta abbastanza da poter cambiare una future belief non deve esistere soltanto nella RAM del turno. Prima che il sistema possa affermare di averla affidata alla memoria, deve esserci un record durevole o un commit atomico equivalente nel percorso canonico.

Questo evita il failure mode:

```text
model: "lo ricorderò"
process crash
proposal lost
```

La meccanica precisa — tabella dedicata, queue durevole o inserimento transazionale in uno staging store — è lasciata alla slice di implementazione.

## Authority e sicurezza

La proposal path non è una scorciatoia attorno al kernel o al modello di trust.

- Un subagent non diventa writer della memoria canonica.
- Un Node remoto non può promuovere direttamente una belief canonica.
- Contenuto non fidato non guadagna trust perché il modello lo ha parafrasato.
- Una prompt injection può al massimo tentare di produrre una proposal con la provenance/taint corretta; non acquisisce un canale privilegiato di scrittura della verità.
- Eventuali capability future di `memory.propose` e `memory.commit` non devono essere equivalenti: il commit canonico appartiene al confine Home/reconciliation, non al menu generico del modello.

## Cosa questa ADR non decide

Non decide ancora:

- il nome della tabella/tipo;
- se la riconciliazione avviene inline o sulla corsia di consolidamento;
- se una owner-stated proposal ad alta confidenza può essere promossa deterministicamente senza judge LLM;
- il formato esatto del candidate identity/dedup key;
- la UX precisa del tool (`remember`, `memory_propose`, ecc.);
- soglie di confidence;
- se alcune proposal richiedano review umana.

Queste sono scelte di meccanica/evidence finché rispettano il writer semantico unico.

## Alternative scartate

### Direct canonical write dal modello

Più semplice e simile ai sistemi con memory blocks/file agent-editable, ma crea due writer concettuali appena resta attiva anche l'estrazione automatica. Dedup, contradiction, provenance e timing diventano responsabilità distribuite fra producer diversi. Inoltre un'inferenza del reasoning loop acquisirebbe un percorso privilegiato verso la verità canonica che Evidence esterna non possiede.

Scartata.

### Pipeline-only, nessuna memoria intenzionale

Era la prima posizione di ADR-0032 ed è già stata corretta dall'owner. Perde il segnale utile che il reasoning loop ha nel momento in cui riconosce che un dettaglio è importante o quando l'owner dice esplicitamente di ricordarlo.

Scartata.

### File/profile agent-editable come seconda memoria canonica

Può essere utile in futuro come derived view ad alta frequenza, ma introdurrebbe una seconda source of truth non bitemporale e con semantiche di update diverse dalla Beliefs layer.

Scartata come memoria canonica.

## Conseguenze

Più facile:

- un solo posto dove ragionare su merge/contradiction/supersede;
- nessun double-writer fra agent tool e background extraction;
- provenance uniforme;
- future Node/subagent/importer possono contribuire senza diventare authority root;
- una future derived owner profile può essere ricostruita dalla stessa Beliefs layer.

Più difficile:

- `remember` non è semplicemente `INSERT INTO facts`;
- serve uno stato durevole fra proposta e commit quando i due non coincidono;
- l'UX deve distinguere onestamente «ho registrato la proposta» da «questa belief è canonica» se la riconciliazione è asincrona;
- bisogna progettare idempotenza fra proposta intenzionale ed estrazione dello stesso evidence.

## Reversibilità

Media. Passare in futuro da proposal-first a direct write sarebbe facile tecnicamente ma indebolirebbe la proprietà di ownership. Fare il contrario dopo aver accumulato belief create da writer con semantiche diverse sarebbe più costoso: bisognerebbe ricostruire quale percorso ha scritto cosa e con quali regole.

Per questo si parte dal lato con ownership più stretta.

## Segnali che la decisione è sbagliata

La forma va riaperta se l'uso reale mostra uno di questi casi in modo ripetuto e misurabile:

- instruction-to-memory troppo lenta o inaffidabile nonostante la proposta sia durevole;
- reconciliation rifiuta o perde frequentemente owner-stated facts ovvi;
- duplicate/merge failure fra proposal ed extraction resta elevato nonostante source identity;
- il costo/complessità del percorso unico supera il beneficio senza produrre migliori provenance o contradiction semantics.

Il rimedio iniziale, però, è semplificare la riconciliazione per i casi forti — non aggiungere un secondo writer.

## Relazioni

- supersede l'unico punto rimasto aperto nell'emendamento di ADR-0032;
- preserva ADR-0004 (Beliefs/Evidence), ADR-0006 (contraddizione/supersede), ADR-0038/0040 (consolidamento/manutenzione);
- compone con ADR-0045 (un agente continuo) e ADR-0050 (canonical commit ownership nella Home).
