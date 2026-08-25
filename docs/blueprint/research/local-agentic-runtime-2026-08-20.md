# Idea — Local-first agentic runtime

> **Ipotesi di prodotto, mai promossa a decisione.**
> Nessun ADR l'ha né adottata né rigettata: non è superata, è *aperta*. Le
> decisioni di topologia adiacenti (ADR-0050/0051/0052, su `dev` dal
> 2026-08-25) ne vincolano il perimetro senza deciderla. Trattala come una
> proposta da riesaminare, non come una direzione in corso.


**Status:** exploratory, non normativo  
**Data:** 2026-08-20  
**Original branch:** `idea/local-agentic-runtime`  
**Topology continuation:** `idea/runtime-topology`

> **Topology amendment (2026-08-20).** In questo documento `locale` non significa
> necessariamente “nello stesso processo o host del Muffin Home”. Dopo la
> distillazione Home/Node, un modello owner-controlled può vivere sul Home, su un
> Mac/compute Node o su un dedicated inference host. Il selector decide un
> **compute target**; identity, authority, Work e canonical memory restano al di
> fuori del modello. Vedi `runtime-topology.md`.

## Tesi

Muffin non dovrebbe assumere che un singolo modello remoto sia sempre il posto migliore in cui eseguire ogni passaggio cognitivo.

L'ipotesi da validare è una gerarchia di compute sostituibile:

```text
                         ┌─ modello locale/owner-controlled agentico
                         │  loop ordinari, tool use, memoria,
                         │  shell, routing, task frequenti
utente / surface → Muffin ┤
                         │
                         └─ frontier model remoto
                            escalation per task difficili,
                            planning profondo, failure recovery,
                            context eccezionalmente grande
```

Una variante futura potrebbe aggiungere un secondo livello locale più costoso:

```text
reflex / routing      → modello piccolo
normal cognition      → modello locale agentico efficiente
deep local            → modello locale più grande / aggressivamente quantizzato
frontier escalation   → provider remoto
```

Questa non è una proposta per rendere il modello parte dell'identità di Muffin. È il contrario: `ARCHITECTURE.md` tratta già provider e modelli come compute sostituibile. La proposta prova a sfruttare quella proprietà per ridurre latenza, costo ed egress senza indebolire continuità, authority o osservabilità.

## Perché vale la pena provarla

Un agente continuo non effettua una sola generazione. Un task reale può attraversare ripetutamente:

```text
reason → tool → observation → reason → tool → observation → ...
```

In questo regime contano proprietà diverse dalla sola qualità del modello su una risposta isolata:

- latenza per ogni passaggio del loop;
- affidabilità del tool calling multi-turn;
- capacità di recuperare da output/tool failure;
- RAM lasciata al runtime, ai tool e al sistema operativo;
- costo marginale di una cognizione sempre disponibile;
- quantità di contesto che può restare locale;
- possibilità di funzionare anche senza rete;
- qualità dell'escalation quando il modello locale non basta.

Su hardware consumer, il modello più grande che tecnicamente entra in memoria può quindi essere un backend peggiore di un modello più piccolo ma più veloce e addestrato specificamente per agentic workloads.

## Primo candidato: Ornith-1.0-9B

Il candidato più interessante emerso al 2026-08-20 è `ornith-ai/Ornith-1.0-9B`, un 9B dense post-trained esplicitamente per agentic coding e terminal-based coding agents.

Per Apple Silicon esiste `mlx-community/Ornith-1.0-9B-4bit`, circa 5.95 GB su disco. La model card MLX documenta direttamente un server OpenAI-compatible:

```sh
uv tool install mlx-lm
mlx_lm.server --model mlx-community/Ornith-1.0-9B-4bit
```

Questo è interessante per Muffin perché permette, almeno concettualmente, di trattare il backend locale come un normale provider HTTP senza accoppiare il core a MLX.

Nel modello Home/Node il server può essere, per esempio, una resource del Mac Node anche se il Muffin Home vive su una VPS. Il protocollo Node non deve incorporare MLX: pubblica una capability/compute endpoint e il provider boundary rimane sostituibile.

Il candidato va considerato **default sperimentale**, non scelta architetturale definitiva.

### Perché 9B può battere 27B per il loop ordinario

Sul MacBook M4 16 GB usato per il dogfood, un 9B 4-bit lascia diversi GB al processo Muffin, ai tool e a macOS. Questo headroom è una proprietà del sistema, non un dettaglio del modello.

Un 27B molto quantizzato può essere qualitativamente superiore su singoli problemi, ma se occupa quasi tutta la memoria unificata può peggiorare:

- swap e memory pressure;
- tempo di risposta;
- context disponibile;
- concorrenza con browser, shell e altri tool;
- stabilità del loop continuo.

Il criterio corretto non è quindi "qual è il modello più intelligente che entra", ma "quale backend massimizza il successo end-to-end di Muffin su un workload realistico".

## Candidato deep-local: Qwen3.8-27B quantizzato

`Qwen/Qwen3.8-27B` è un candidato molto più capace ma più costoso. Le quantizzazioni GGUF Dynamic pubblicate da Unsloth includono, al 2026-08-20:

| Quantizzazione | Dimensione indicativa |
| --- | ---: |
| `UD-IQ2_XXS` | 9.01 GB |
| `UD-IQ2_M` | 10.3 GB |
| `UD-Q2_K_XL` | 10.7 GB |
| `UD-IQ3_XXS` | 11.9 GB |
| `Q3_K_S` | 12.6 GB |
| `UD-Q3_K_XL` | 13.4 GB |
| `Q3_K_M` | 13.8 GB |
| `IQ4_XS` | 15.7 GB |

Su una macchina da 16 GB le varianti Q3 sono plausibili ma molto più strette: pesi, KV cache, runtime e sistema operativo competono per la stessa memoria unificata.

Per questo Qwen3.8-27B è più interessante come **deep-local experiment** che come default continuo, almeno sull'hardware attuale.

## Architettura proposta da esplorare

Non introdurre logica cognitiva speciale nel core. Estendere invece il concetto già esistente di provider/model profile con policy di selezione osservabili.

Con la runtime topology, il selector sceglie due cose logicamente separate:

```text
assembled context
      │
      ▼
model selection / escalation policy
      │
      ├── target: Home-local endpoint
      ├── target: Node-local endpoint
      └── target: remote provider
```

Il selector non deve concedere authority e non deve possedere stato canonico. Decide soltanto dove eseguire compute già autorizzato dal resto del sistema.

L'escalation deve essere tracciabile. Ogni passaggio dovrebbe poter rispondere almeno a:

- quale modello/provider è stato usato;
- su quale compute target/host logico è stato eseguito;
- perché è stato scelto;
- quanto è costato in tempo/token;
- se il locale ha fallito prima dell'escalation;
- se la risposta finale ha richiesto il remoto;
- quale porzione di contesto ha cambiato host o raggiunto un provider remoto.

Questo si allinea direttamente con P4 (il modello giudica, il codice possiede i contratti), P5 (propriocezione prima del potere) e P6 (non costruire infrastruttura prima che un consumer la dimostri necessaria).

## Privacy / egress / locality

La proposta rende concreta una proprietà già descritta in `ARCHITECTURE.md`: il provider remoto è un boundary di egress.

Un backend owner-controlled può quindi diventare utile non solo per costo e latenza, ma per ridurre il numero di turni in cui il context assemblato raggiunge un provider terzo.

Con Nodes compare però una seconda dimensione: **lasciare il Home host** non è uguale a **lasciare il dominio dell'owner**. Un context inviato dalla VPS Home al Mac Node cambia host e attraversa un transport; un context inviato a OpenRouter cambia anche trust/data-recipient boundary.

Non assumere quindi che `local-first` equivalga automaticamente a `local-only` o a `same-host`.

Una futura policy `local-only` / `owner-controlled-only` / `cloud-allowed` dovrebbe essere progettata come capability/policy esplicita al provider/placement boundary, non inferita dal router.

## Non-goal

Questa idea **non** propone ora:

- di sostituire il provider remoto esistente;
- di rendere Ornith una dipendenza obbligatoria;
- di hardcodare Apple Silicon o un Mac specifico nell'architettura;
- di richiedere che il Muffin Home viva sullo stesso host del modello locale;
- di aggiungere un orchestratore multi-model complesso;
- di scaricare automaticamente modelli;
- di implementare una nuova abstraction prima di aver misurato il problema;
- di considerare un benchmark pubblico sufficiente a scegliere il modello.

## Eval Muffin-specific prima dell'implementazione

La decisione dovrebbe dipendere da una suite piccola ma reale di task Muffin, non dai leaderboard generali.

Prima batteria suggerita: 30–50 task riproducibili distribuiti tra:

1. tool call singola corretta;
2. catene da 5–15 tool call;
3. filesystem e shell con output ambiguo;
4. retry dopo tool failure;
5. scelta di non chiamare un tool quando non serve;
6. uso di memoria/recall nel loop;
7. task con context crescente;
8. task che richiedono escalation;
9. task che il locale dovrebbe rifiutare/deferire perché non sa completarli;
10. recupero da risposta malformata o tool call non valida.

Metriche minime:

```text
task success rate
valid tool-call rate
recovery rate after tool failure
median turns to completion
wall-clock latency
prefill latency / generation throughput
peak unified-memory pressure
swap pressure
local completion rate
remote escalation rate
remote token cost
egressed context volume
cross-host context volume / placement changes
```

La metrica principale deve essere **successo end-to-end del task**, non perplexity o token/s isolati.

## Esperimento minimo

Prima di modificare il core:

1. avviare Ornith 9B 4-bit come endpoint OpenAI-compatible owner-controlled;
2. se il provider adapter corrente può già puntare a un endpoint compatibile, usarlo senza nuova abstraction;
3. per il primo test può stare sullo stesso host; il Node protocol non è prerequisito dell'eval del modello;
4. eseguire la stessa batteria di eval con:
   - backend remoto attuale;
   - Ornith 9B locale;
   - opzionalmente Qwen3.8-27B Q3/IQ3 locale;
5. misurare successo, latenza, RAM, swap e failure recovery;
6. solo se emerge un vantaggio reale, progettare routing/escalation come slice separata.

Un risultato negativo è valido: se il locale fallisce troppo spesso o l'escalation annulla i benefici, la proposta può essere chiusa senza lasciare nuova infrastruttura nel core.

## Domande aperte

- Il provider adapter attuale supporta già in modo pulito un endpoint OpenAI-compatible locale?
- Quanto tool calling perde Ornith rispetto al provider frontier sul vero schema tool di Muffin?
- Serve davvero un router, o basta inizialmente una scelta esplicita di model profile?
- Quale segnale di escalation è sufficientemente semplice e osservabile?
- Conviene escalare l'intero turn o soltanto il prossimo reasoning step?
- Come evitare che un fallback remoto duplicato riesegua un effect già possibilmente avvenuto?
- Quanto context locale è realmente utile prima che retrieval e context assembly rendano inutile inseguire context window enormi?
- Quale headroom minimo di memoria deve essere considerato healthy su macOS?
- Quando un Node model target è preferibile al Home-local target, oltre al semplice fatto che il modello esiste lì?

## Criterio di promozione

Questa idea può diventare ADR/slice solo se l'evidenza mostra almeno una delle seguenti proprietà senza regressioni sproporzionate nel task success:

- riduzione significativa della latenza dei loop ordinari;
- riduzione significativa del costo remoto;
- riduzione significativa dell'egress verso terzi;
- funzionamento utile offline/localmente quando il compute target è raggiungibile;
- migliore resilienza quando il provider remoto non è disponibile.

Fino ad allora resta un esperimento sostituibile.

## Fonti iniziali

- Ornith-1.0-9B: https://huggingface.co/ornith-ai/Ornith-1.0-9B
- Ornith-1.0-9B MLX 4-bit: https://huggingface.co/mlx-community/Ornith-1.0-9B-4bit
- Qwen3.8-27B: https://huggingface.co/Qwen/Qwen3.8-27B
- Qwen3.8-27B Unsloth GGUF: https://huggingface.co/unsloth/Qwen3.8-27B-GGUF

Queste fonti descrivono lo stato corrente dei modelli e delle quantizzazioni; nomi, dimensioni, benchmark e disponibilità vanno trattati come dati volatili e riverificati quando l'idea viene promossa a lavoro eseguibile.
