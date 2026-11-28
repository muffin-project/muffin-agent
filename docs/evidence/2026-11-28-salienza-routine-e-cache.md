# Salienza, routine e cache del prompt

28 novembre 2026. Confronto tra Muffin.ai `09e02db` e il runtime di
`muffin-agent` su `dev` a `510888f9`. I casi di valutazione sono sintetici.

## Curiosità, salienza e routine

| Fonte storica | Riscontro | Decisione |
|---|---|---|
| `context/SOUL.md`, dal commit `16bea5d214`, e il default `c1e313a8` di muffin-agent | Il calore, il disaccordo e la continuità erano parte del patto. La voce annunciava l'attesa durante una ricerca e lasciava implicito il lavoro interno. | La fondazione v3 recupera il patto in seconda persona. La personalizzazione segue ADR-0112. |
| `context/HEARTBEAT.md`, ADR-127, `src/cognition/belief_gaps.ts`, `src/dreamer.ts` | Le lacune fondate potevano produrre una domanda. Il flusso aveva un limite giornaliero e arretrava davanti a domande ignorate. Il testo del heartbeat chiedeva di cogliere un'apertura naturale. | Portata la curiosità nella conversazione. Un caso di valutazione distingue una domanda pertinente da una reazione generica o da un incarico inventato. Le domande spontanee fuori conversazione richiedono una prova propria. |
| ADR-149, `src/salience.ts`, `scripts/evals/salience-trim-delta.mjs` | La prova su 1.398 turni ha mostrato un segnale dominato dal cambio di argomento. Dopo la riduzione il punteggio alimentava i log e non aveva un consumer comportamentale. | Conservata la distinzione fra novità e importanza. In Muffin attuale l'importanza resta distinta da provenienza, fiducia e rilevanza. Può recuperare un posto al taglio del recall senza comandarne l'ordine. |
| `src/thinker.ts`, `src/memory/memory_proactive.ts`, `src/utils/proactive_gate.ts` e replay del 9 giugno | Il percorso proattivo valutava il contesto recente e poteva tacere. Sonno, conversazione attiva e duplicati erano problemi reali. Una valutazione storica ha registrato quattro invii della stessa osservazione in dodici ore. | Portata nel patto la capacità di adattare tono e contenuto di un rito quando l'owner ha raccontato qualcosa che gli cambia significato. I probe usano lo stesso messaggio in due contesti. La politica di invio richiede una verifica distinta. |

Il percorso conversazionale usa la cronologia reiniettata e il recall del tenant
in `agent/loop/engine.ts` e `agent/loop/context.ts`. Le ricorrenze vere passano
da `agent/scheduler-run.ts`, che apre una sessione dedicata ed entra nel modello
con `promptMode: 'minimal'`. Il recall del tenant usa il goal di quel job come
query. Una frase nel patto interattivo non può cambiare quel percorso. La
consegna `silent` già presente si applica al successo ordinario dei job che la
richiedono, mentre il gate delle iniziative proattive in
`core/scheduler/proactivity.ts` valuta provenienza, quiet hours e budget.

La prima prova per le routine automatiche dovrebbe valutare in modalità
anteprima una singola routine scelta dall'owner. Confrontare a coppie una
giornata ordinaria, un fatto singolo significativo riferito dall'owner,
un'inferenza incerta e una correzione successiva che cambia il contesto.
Misurare se il testo raggiunge lo scopo della routine, se adatta la voce senza
riesporre il dettaglio privato e se sbaglia il momento per intervenire. Per
promemoria e azioni esplicitamente richiesti, un fatto personale può cambiare
come comunicarli. Farlo influire anche sulla consegna di una ricorrenza
facoltativa è una scelta di prodotto. Il confronto sul ramo v3 al momento
verifica con il provider finto il percorso dei probe interattivi.

Le ipotesi H3 e H5 restano in [Cognitive design](../product/COGNITIVE-DESIGN.md).
Per la distinzione fra salienza e ranking, si veda la
[ricerca sull'importanza e la fusione](memory-salience-and-fusion.md). Lo
[studio di Park et al.](https://storage.googleapis.com/gweb-research2023-media/pubtools/7070.pdf)
motiva il confronto fra rilevanza, recenza e importanza. Le sue ablation
riguardano componenti della memoria e non isolano il peso dell'importanza.

## Cache del prompt

La prima slice è su `dev` via [#1050](https://github.com/muffin-project/muffin-agent/pull/1050).
Su `510888f9`, `flattenSemantic` rende la cronologia prima di memoria e
orologio. La richiesta nuova però ricostruisce la cronologia dalle battute
persistite. Il suo prefisso quindi non coincide necessariamente con tutta la
richiesta precedente, che conteneva anche il contesto sintetico del turno.

Il menu può cambiare già all'inizio del turno tramite il preload rilevante per il
task, e nei giri seguenti tramite `activatePending`. Il test di discovery
percorre il loop di produzione con quattro richieste. Il menu resta stabile
dalla prima alla seconda, cresce dopo la discovery, poi resta stabile. La
traccia esporta solo il numero di schemi e un indicatore di cambio rispetto
alla richiesta precedente dello stesso tratto del loop. Il primo giro non ha
un confronto. I byte del prompt, i nomi e gli schemi non finiscono nei nuovi
campi.

Nelle tracce locali recenti c'è almeno una chiamata Grok 4.7 con 13.568 token
serviti dalla cache su 13.669 in input. Le tracce precedono la nuova
strumentazione, quindi non permettono un confronto a parità di menu, modello e
sessione. Sono evidenza che la cache può funzionare sull'installazione.

Per un confronto causale mantenere modello e sessione fissi, ripetere lo stesso
flusso con schema progressivo e con catalogo già autorizzato stabile, poi
confrontare token in input, token in cache, tempo al primo testo e riuscita
dei tool. Un catalogo completo può rendere il primo giro più costoso e più
dispersivo. Un contesto persistito può conservare ricordi che il turno
successivo non avrebbe richiamato, oppure che l'owner ha corretto o rimosso.
Prima di introdurlo servono prove su correzione, oblio, provenienza e taglio
della cronologia. Le misure del ramo corrente sono strumentali e non
certificano un risparmio di latenza.

Fonti primarie sul caching:
[xAI](https://docs.x.ai/developers/model-capabilities/text/best-practices),
[OpenClaw](https://docs.openclaw.ai/reference/prompt-caching) e
[Hermes](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching).
OpenClaw documenta il contesto del turno in coda e i punti di ricostruzione
del prefisso. Hermes espone il compromesso fra breakpoint, stabilità e
compattazione.
