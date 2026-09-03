# L'orizzonte del turno: non è il tetto, è l'orientamento — 03/09/2026

Nasce da una frase dell'owner sul tetto di 15 tool call — *«lo limitano per le
long run task man, muffin sembra essere molto capace, e sembra che (anche se un
minimo giustamente) lo stiamo limitando, ma non è governance questa»* — con la
richiesta esplicita di leggere paper e documentazione ufficiale, non di
opinare: *«per i pattern agentici voglio che guardi paper e docs, cosi da
trovare soluzioni SOTA o adatte a noi»*.

A metà istruttoria un coordinatore ha interrogato `turn_tool_calls`
sull'installazione viva dell'owner (238 righe, sola lettura, non riletta da me
— vedi il vincolo in cima al mio mandato) e ha capovolto la domanda. Questo
memo segue quel capovolgimento: prima l'orientamento, poi le tre grandezze
confuse, poi la tool search — nell'ordine in cui la misura dice che contano.

## La raccomandazione, in tre frasi

Il tetto non è il collo di bottiglia misurato: un solo turno su un campione di
238 chiamate lo ha toccato, e più della metà del budget se ne va a chiedere
«dove sono / cosa sto guardando», non a lavorare. La priorità non è alzare o
spostare il numero — è dare a ogni turno un orientamento economico e stabile
(pochi fatti veri sull'istanza, nella sezione volatile del prompt che già
esiste per ora/superficie/modello, secondo lo schema *hybrid* che la stessa
Anthropic raccomanda), e solo dopo separare le tre grandezze oggi impastate in
due numeri e sostituire la morte-al-tetto con la sospensione che il runtime ha
già. La tool search resta una risposta strutturale valida quando la superficie
dei tool crescerà, ma sui dati reali non è la cosa che sta costando i turni
oggi, e proporla come priorità sarebbe venderla oltre quello che misura.

## Parte 0 — la misura che ha riordinato tutto

Distribuzione delle 238 chiamate (`turn_tool_calls`, installazione
dell'owner, letta dal coordinatore):

```
shell_run 65 · fs_list 44 · memory_search 39 · fs_read 37 · sys_inspect 31 ·
fs_search 11 · send_file 6 · todo 2 · document_read 2 · wait 1
```

Le quattro che rispondono a «dove sono / cosa è questo» — `fs_list`, `fs_read`,
`fs_search`, `sys_inspect` — sono 123 su 238, il 51,7%. La distribuzione delle
chiamate per turno mostra il tetto toccato da **un solo turno** (15), due a 14,
e la moda è 2. Alzare 15 comprerebbe più ri-orientamento, non più lavoro: la
correlazione fra «il modello si perde» e «il tetto morde» non c'è nel campione.
L'owner l'ha detto nelle sue parole: *«a volte non sa manco dove deve cercare e
ogni volta deve navigare... dovremo proprio analizzare il suo comportamento»*.

Le quattro chiamate di orientamento non sono lo stesso bisogno. Vanno separate,
perché la risposta è diversa per ciascuna:

- **`fs_list` + `fs_read` + `fs_search` (92/238, 38,7%)** sono navigazione del
  *workspace* — inerentemente specifica del compito, cambia da turno a turno,
  non c'è un solo «dove sono» che valga per sempre. Questo è esattamente il
  caso che Anthropic chiama *just-in-time retrieval*: mantenere riferimenti
  leggeri (percorsi) e caricare i dati a runtime coi tool invece di
  precaricarli — «mirrors human cognition: we generally don't memorize entire
  corpuses of information» (Anthropic, *Effective context engineering for AI
  agents*, 29/09/2025, letto 03/09/2026). La stessa fonte non nasconde il
  costo: *«there's a trade-off: runtime exploration is slower than retrieving
  pre-computed data»*, e propone un ibrido — *«retrieving some data up front
  for speed, and pursuing further autonomous exploration at its discretion»*.
  Un elenco del primo livello della working dir nella sezione volatile
  toglierebbe la prima `fs_list` quasi certa di ogni turno che tocca file,
  senza fingere di sapere cosa contengono i file.
- **`sys_inspect` (31/238, 13%)** è un bisogno diverso: fatti sull'**istanza**
  — modello, profilo, provider, stato del root of trust, quanti job e turni
  aperti — che cambiano raramente dentro una sessione e quasi mai dentro un
  turno. `agent/tools/inspect.ts:157` (`makeInspectTool`) produce un report
  pesante: due letture async (`sources.doctor()`, `sources.build()`), l'elenco
  dei tool esposti, ogni check di `muffin doctor`, i blocchi del system prompt
  e l'elenco dei job — per rispondere a domande che nella maggioranza dei casi
  hanno la stessa risposta della chiamata precedente nella stessa sessione.

### Cosa c'è già nel prompt, e cosa manca

`agent/context/assemble.ts:172-259` (`ambienteSection`) è precisamente il
meccanismo per questo bisogno, e la sua docstring lo dice già: **il difetto
misurato il 28/08/2026** — chiesto «che ora è», Muffin ha provato a eseguire
`date` con `sys.shell`, chiedendo un permesso per sapere l'ora, perché la data
non era nel prompt in nessuna forma. La riparazione: una sezione `## Questo
turno` nella **coda volatile** dell'ultimo messaggio (non in `systemPrompts`,
che deve restare un prefisso cacheable byte per byte — la stessa distinzione
che la documentazione Anthropic sul prompt caching chiama «il breakpoint su
contenuto che cambia a ogni richiesta»). Oggi contiene: adesso (con offset
UTC), superficie, con chi, modello e profilo
(`agent/context/assemble.ts:253-259`). **Non contiene**: la working directory,
un elenco di primo livello del workspace, né un riassunto a una riga
dell'istanza (provider, quanti job attivi, se il RoT è integro). Il commento
in cima al file cita tre peer che tengono un `world state` cwd-incluso — Codex
CLI (`cwd` accanto a `current_date`), OpenClaw (`## Temporal Context`), Hermes
(`Session ID`, `Model`, `Provider`, `Platform`) — e il nostro elenco si ferma
prima del filesystem.

Questo **non** contraddice la scelta dichiarata in `agent/tools/inspect.ts:29`
(*«qui non c'è documentazione infilata nel system prompt: la descrizione
dell'architettura sta nei documenti»*): quella riga parla di non duplicare i
*documenti* d'architettura nel prompt per non farli divergere dalla fonte.
Qui si parla di fatti d'istanza — provider, quanti job, cwd — che sono
**esattamente gli stessi valori, dalla stessa fonte**, che `sys_inspect` legge
a ogni chiamata; metterne un sottoinsieme cheap nella coda volatile non crea
una seconda copia, ne evita 31 letture ridondanti per sessione dello stesso
dato.

### Cosa proporrei, senza costruirlo in questa passata

Estendere `ambienteSection` con due righe, sourced come `sys_inspect` le
legge (nessun ricalcolo, nessuna seconda fonte): la working directory più
l'elenco di primo livello (limitato, come `fs_list` già limita), e una riga di
stato istanza a bassissima cardinalità (`provider · N job attivi · RoT
integro|SAFE MODE`). Non un dump di `sys_inspect`: quello resta il tool per
«voglio i dettagli adesso» (check di `doctor`, blocchi del prompt, capability
esposte) — l'obiettivo è tagliare la chiamata *di scoperta*, non sostituire
quella *di verifica*. Questa è una modifica a `agent/context/assemble.ts`, che
è fuori dal perimetro di questa slice di ricerca: resta una raccomandazione,
non un cambio di codice.

### La misura continua che manca

Il numero sopra è stato prodotto a mano, interrogando `muffin.db`
dell'owner una volta. `turn_tool_calls` registra già ogni chiamata col suo
`turn_id`; la distribuzione andrebbe letta con un comando ripetibile, non con
un'interrogazione occasionale. La forma più piccola: una query che aggrega
`turn_tool_calls` per `tool` (frequenza, quota del totale) e una seconda che
aggrega `COUNT(*) GROUP BY turn_id` per la distribuzione di chiamate-per-turno
(quanti turni toccano 14 o 15, cioè il tetto), esposta come sotto-comando di
`muffin doctor` o come riga nel report di `sys_inspect`/`muffin gateway
status` — la stessa fonte che già legge questa tabella
(`core/turns/store.ts:365-379`). Non la costruisco qui: la indico come il test
che falsificherebbe o confermerebbe questo memo la prossima volta che qualcuno
tocca il tetto, senza dover rileggere il database a mano.

## Parte 1 — le tre grandezze impastate in due numeri

Misurato nel codice, non dedotto:

- **`maxToolsExposed`** decide quali tool il modello *vede* in un turno:
  `agent/loop.ts:1517-1523` fa `visibleTools(...).slice(0,
  deps.profile.maxToolsExposed)`, e `agent/runtime.ts:775`
  (`tools.slice(profile.maxToolsExposed)`) calcola cosa resta tagliato per
  loggarlo in una `bootLine` — un tool oltre la linea non produce errore, non
  esiste per quel turno.
- **`maxToolCallsPerTurn`** governa **due** cose diverse con lo stesso numero:
  - il budget di *chiamate*: `agent/loop.ts:2234`
    (`if (toolCallsMade >= deps.profile.maxToolCallsPerTurn)`) rifiuta la
    singola tool call oltre il tetto, dentro un batch che può contenerne più
    di una;
  - il tetto di *round-trip* col modello: `iterationCap(profile)` in
    `agent/profiles/profile.ts:220-222` è `Math.min(profile.maxToolCallsPerTurn,
    MAX_ITERATIONS_HARD_CAP)` (cap duro 40, riga 119), e `agent/loop.ts:1732`
    (`while (iterations < cap)`) lo usa per limitare i giri del ciclo — non le
    tool call.

Non esiste oggi un campo separato per «quanti giri di conversazione» contro
«quante tool call totali»: sono la stessa cifra, letta due volte con due
significati. Su `consumer-local.json:10-11` i due JSON *field* distinti
(`maxToolsExposed`, `maxToolCallsPerTurn`) valgono entrambi 15 — quindi in
pratica **un solo numero governa tre grandezze**: cosa si vede, quante volte si
chiama un tool, quanti giri si fanno. Ognuna ha un guasto diverso quando viene
sottodimensionata (un tool invisibile non è la stessa cosa di un giro
negato), e oggi si muovono insieme per coincidenza di configurazione, non per
progetto.

### Morte al tetto: il guasto misurato

Quando `iterations` raggiunge `cap`, `agent/loop.ts` esce dal `while` e
richiama `finish(turn, 'cap', ...)` con il messaggio *«Mi sono fermato dopo N
passaggi senza chiudere. Dimmi come restringere il compito.»* — non una
sospensione, una fine. `core/turns/store.ts:75` elenca `'cap'` come uno dei
`TurnOutcome` finali insieme ad `'answered' | 'budget' | 'aborted' | 'error' |
'ask'` — **non** `'suspended'`, che è un valore distinto e a parte
(`suspendHere`, `agent/loop.ts:2335`). `cli/run.ts:118-121` lo traduce in un
exit code dedicato (5): un comando bloccante che si ferma, senza che nulla
riprenda automaticamente. Nessun punto del codice (verificato con `grep` su
tutto l'albero, fuori da `loop.ts` e dai test compare solo in
`core/turns/store.ts` e `cli/run.ts`) consuma `'cap'` per rimettere in coda il
lavoro. L'owner deve rispondere di nuovo, da zero di contesto operativo — il
`todo` e i messaggi restano, ma l'iniziativa di riprendere è sua.

Questo è precisamente il guasto che l'owner nomina: **non è governance** — il
messaggio del tetto non protegge un'autorità o un effetto, dice solo «ho finito
il budget di scaffolding». Ma nel dato di Parte 0 questo guasto è raro (1/238
turni), quindi risolverlo non è la priorità — lo è capire perché quel turno
è arrivato a 15 senza chiudere, e la risposta più probabile, coerente col
51,7% di chiamate di orientamento, è che ha continuato a ri-orientarsi invece
di lavorare.

## Parte 2 — cosa dicono le fonti, con le date

### Documentazione ufficiale

- Anthropic, *Effective context engineering for AI agents* —
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents,
  29/09/2025, letto 03/09/2026. Tre tecniche per l'orizzonte lungo:
  **compaction** (riassumere e reinizializzare quando ci si avvicina al
  limite), **structured note-taking** (stato persistente fuori dal contesto —
  il memory tool, «build up knowledge bases over time, maintain project state
  across sessions»), **sub-agent architecture** (sotto-agenti con contesto
  pulito, che restituiscono un sommario di 1.000-2.000 token). Nessuna delle
  tre parla di un tetto di turni o di tool call — il documento non prescrive
  un numero, prescrive una tecnica di gestione del contenuto.
- Anthropic, *Introducing advanced tool use* —
  https://www.anthropic.com/engineering/advanced-tool-use, 24/11/2025, letto
  03/09/2026. **Tool Search Tool**, beta pubblica, header
  `advanced-tool-use-2025-11-20`; tool marcati `defer_loading: true` restano
  dichiarati all'API ma non entrano nel contesto finché il modello non li
  cerca. Misurato: **85% di riduzione token** in uno scenario con 58 tool
  (~77K → ~8,7K); accuratezza di selezione **Opus 4: 49% → 74%**, **Opus 4.5:
  79,5% → 88,1%**. Raccomandazione dell'owner: usarlo quando le definizioni
  superano ~10K token o la libreria è grande; «less beneficial when small tool
  library (<10 tools)». **I modelli testati sono Opus 4 e Opus 4.5** — nessun
  modello della classe consumer-local (Qwen3/Gemma/GLM, 7-30B).
- Model Context Protocol, spec `tools/list` —
  https://modelcontextprotocol.io/specification/2025-06-18/server/tools,
  letto 03/09/2026: paginazione a cursore, già usata da `core/mcp/connect.ts`
  (confermato in `docs/evidence/tool-design-2026-08-26.md`). La ricerca
  progressiva/dinamica dei tool è discussa in issue e discussion pubbliche del
  progetto (`modelcontextprotocol/modelcontextprotocol#1923`, `#532`) ma
  **non è nella spec**: è una proposta della community, non un primitivo
  standardizzato. Il *Tool Search Tool* di Anthropic è lato API/host — opera
  sulla lista di tool che Claude vede, non sul protocollo MCP — quindi non è
  qualcosa che un server MCP espone; è qualcosa che chi assembla la richiesta
  al modello farebbe da sé, per qualunque provider.
- OpenAI Agents SDK — https://openai.github.io/openai-agents-python/running_agents/,
  letto 03/09/2026: `max_turns` solleva `MaxTurnsExceeded` al superamento (lo
  stesso guasto — morte, non sospensione — del nostro `'cap'`), disattivabile
  con `max_turns=None`. Gli *handoffs* sono la loro forma di delega a
  sotto-agente: trasferimento di controllo dentro lo stesso run, con l'intera
  history visibile al nuovo agente salvo un `input_filter` esplicito.

### Paper

- **Repantis, Gawde, Singh, Blackwell — *How Many Tools Should an LLM Agent
  See? A Chance-Corrected Answer*** — arXiv:2605.24660, v1 23/05/2026, v2
  07/06/2026, letto 03/09/2026. Metrica *Bits-over-Random* (successo a una
  data profondità corretto per la baseline casuale a quella profondità),
  trasformata in reward per una policy di selezione appresa. Risultato
  misurato: su BFCL (370 tool) la policy appresa eguaglia quasi la copertura
  di mostrarne 50 staticamente (90,3% contro 90,8%) mostrandone **7** in
  media; su ToolBench (3.251 tool) la selezione adattiva raggiunge 61,9% di
  copertura mostrandone meno della profondità fissa che ne dà 64,7%. Questa è
  evidenza diretta e misurata che una selezione dinamica batte l'esposizione
  statica grande — la stessa tesi strutturale di
  `docs/evidence/tool-design-2026-08-26.md`. **La validazione a valle usa solo
  Claude Sonnet 4.6**: nessun modello open-weight nella classe 7-30B.
- Cercati e **non trovati**: un paper che isoli specificamente Qwen3, Gemma o
  GLM (o classe di taglia comparabile, 7-30B) e misuri l'accuratezza di
  selezione del tool in funzione del numero di tool esposti, tenendo fissi gli
  altri fattori. La letteratura confusability/distractor (BFCL, ToolBench: un
  toolset di dimensione N si costruisce ordinando i tool per confondibilità
  col target e prendendo i primi N-1 come distrattori) esiste come
  *metodologia* — l'ho trovata descritta in benchmark come "Benchmarking
  Function Calling in LLMs" — ma non sono riuscito a estrarre dai PDF
  (compressione FlateDecode non testuale via il fetch disponibile) numeri
  specifici per modelli della taglia che ci interessa, e non li riporto perché
  non verificati alla fonte. Un risultato di ricerca automatica citava «JSON
  tool calling accuracy degrades above fan-out counts of 13» attribuendolo a
  *The Bitter Lesson of Tool Calling* (arXiv:2608.06370): **verificato e
  falso** — l'abstract del paper (Programmatic Tool Calling contro JSON su 14
  modelli, BFCL v4) dice «matches or outperforms baseline in 13 of **14
  modelli**», una frase su quanti modelli, non sul numero di tool. Lo segnalo
  qui proprio perché la regola dell'owner è non affermare ciò che non si è
  verificato: una fonte secondaria l'ha confuso, e il numero «13» non ha
  niente a che fare col nostro tetto di 15.
- **Conclusione onesta**: la letteratura che ho trovato conferma che *la
  selezione dinamica batte l'esposizione statica ampia* (Repantis et al.) e
  che *un modello frontier degrada quando i tool aumentano senza tool search*
  (Anthropic, Opus 4/4.5). Non esiste, in quello che ho potuto verificare,
  una misura equivalente per la classe di modelli che questo profilo
  seleziona. Il tetto di 15 resta — esattamente come lo era 10 — **un numero
  senza misura dietro** per la nostra classe di modelli specifica, e la Parte
  0 dice che comunque non è quello che sta costando i turni oggi.

## Parte 3 — la raccomandazione

### Separare le tre grandezze

Sì, vanno separate concettualmente anche se restano numericamente uguali
finché nessuna misura dice di differenziarle: `maxToolsExposed` (visibilità),
`maxToolCallsPerTurn` (budget di chiamate, che oggi decide anche
`iterationCap`) e un ipotetico `maxIterationsPerTurn` (round-trip col
modello) sono tre domande diverse — *cosa vedo*, *quanto lavoro*, *quanti
scambi mi costa*. Impastarle in un solo campo (`profile.ts:220-222`) rende
impossibile alzare l'una senza alzare l'altra, che è esattamente come 15 è
diventato sia il tetto di visibilità sia quello di round-trip per la stessa
ragione sbagliata: comodità di configurazione, non progetto. Non propongo di
cambiare `agent/profiles/profile.ts` in questa passata (fuori perimetro): la
raccomandazione è che quando qualcuno li tocca di nuovo, li tocchi come tre
campi distinti nello schema, anche se il valore shipped resta identico finché
una misura non dice diversamente.

### Cosa sostituisce la morte al tetto

Il runtime ha già il primitivo giusto: `wait`/`suspendHere`
(`agent/tools/wait.ts`, `agent/loop.ts:2335`) sospende un turno rilasciando il
processo, persiste `messages`/taint/contatori, e riprende senza perdere
niente — la stessa distinzione onesta fra «non fatto / fatto / forse fatto»
che il resto del kernel usa. `todo` (`agent/tools/todo.ts`) è il piano che
sopravvive alla sospensione, letto a ogni turno della sessione. Muffin ha già,
cioè, `plan → todo → wait/resume` — il pattern che Anthropic chiama
sub-agent/checkpoint e che gli SDK (OpenAI Agents, Claude Agent SDK) chiamano
handoff/resume — solo che **il tetto non lo usa**: arrivare a `cap` chiude il
turno invece di armare la stessa sospensione che `wait` arma volontariamente.
La differenza tecnica è piccola (lo stesso `suspendHere` con un `WaitSpec` a
brevissima scadenza, o una riga in `todo` scritta automaticamente con «continua
da qui»), ma cambia il fallimento: da *«dimmi come restringere»* (l'owner deve
ricostruire il contesto) a *«sto continuando, ecco cosa ho già fatto»* (il
lavoro riprende senza intervento).

Nominare i due guasti, esplicitamente:

- **Guasto della forma attuale**: un turno che stava chiudendo bene ma ha
  speso il budget in ri-orientamento si ferma comunque, e l'owner riparte da
  zero di contesto conversazionale (il `todo` resta, la sospensione no).
- **Guasto della forma proposta**: una sospensione automatica al tetto che non
  fosse essa stessa limitata diventerebbe un turno che non finisce mai —
  serve un contatore di *quante volte* un turno può auto-continuare (per
  esempio, 2-3 sospensioni-per-tetto prima di fermarsi per davvero, oppure lo
  stesso budget monetario che già ferma i turni altrove,
  `deps.budgetExhausted`). Non è un dettaglio: è la ragione per cui questa non
  è un'implementazione ma una raccomandazione da verificare con un eval prima
  di scriverla.

### Tool search: secondaria, e va detto chiaramente

Sui dati reali (Parte 0), i 15 tool esposti non sono ciò che costa i turni
dell'owner oggi — nessun turno del campione ha chiamato un decoy o mostrato
segni di confusione fra tool simili nel senso misurato da Anthropic (selezione
sbagliata). Il problema misurato è la *frequenza* con cui si richiede
orientamento, non la *scelta* fra tool candidati. Questo non rende falsa la
tesi strutturale di `docs/evidence/tool-design-2026-08-26.md` — resta vero che
15 è un numero senza misura e che ogni tool nuovo la fa mordere di nuovo — ma
la tool search risponde alla domanda sbagliata per il problema che i dati di
oggi mostrano. Resta la risposta corretta per *quando* la superficie
crescerà (il prossimo `sys_inspect`-like, il prossimo MCP server): la versione
più piccola che la farebbe smettere di contare sarebbe un tool
`tool_search`/`list_more_tools` lato harness (i modelli qui non sono sull'API
Claude, quindi il `defer_loading` nativo non si applica: servirebbe
un'implementazione nostra, coerente col fatto che MCP stesso non lo
standardizza), con 5-8 tool sempre caricati (quelli che il campione mostra più
usati: `shell_run`, `fs_list`/`fs_read`, `memory_search`) e il resto dietro
ricerca. Non costruirla ora: prima l'orientamento, che costa meno e risolve
una quota di gran lunga maggiore del problema misurato.

### Cosa misurare in locale prima di cambiare un numero

Due misure distinte, non una:

1. **La distribuzione d'uso** (Parte 0), come comando ripetibile — vedi sopra.
   Va ripetuta ogni volta che si considera di toccare `maxToolsExposed` o
   `maxToolCallsPerTurn`, perché è quella che decide se il problema è ancora
   quello misurato oggi.
2. **La curva di degrado nella scelta del tool per la classe consumer-local**,
   con `evals/floor/run.ts` che già supporta esattamente questo:
   `tsx evals/floor/run.ts --model <id-qwen3> --only breadth --tools N --pad M
   --reps 3`, facendo variare `N` (8, 12, 15, 20) e `M` abbastanza da riempire
   davvero quella superficie. **Prerequisito, misurato e non ipotetico**: lo
   scenario `breadth` legge un file e poi scrive un totale, e
   `defaultMaxTaint.medium` è 1 mentre `fs.write` è `risk: 'medium'`
   (`core/policy/read-then-write.test.ts:44`) — il commit `75b7bf6` ha già
   misurato che questo nega la scrittura **indipendentemente dal tetto di
   tool** (0/9 identico a tetto 10, 14, 20), confondendo qualunque sweep che
   usi quello scenario così com'è. Prima di fidarsi di un nuovo sweep va
   scelto uno scenario che non attraversi taint medio→scrittura nello stesso
   turno (`sequencing` o `recovery` sembrano candidati migliori, da
   verificare), oppure va eseguito lo sweep con un `defaultMaxTaint` più alto
   *solo nell'eval*, dichiarato come tale. Il risultato che
   falsificherebbe/confermerebbe questo memo: se l'accuratezza sullo scenario
   scelto resta piatta da 8 a 20 tool, il tetto davvero non è la variabile per
   questa classe di modelli, come Parte 0 già suggerisce; se crolla prima di
   15, il numero è sbagliato nella direzione opposta a quella che l'owner
   temeva (troppo alto, non troppo basso).

## Parte 4 — governance contro guardia dell'harness, nettamente

**Governance**: autorità su un effetto — chi può fare cosa, con quale rischio,
sotto quale taint. Vive nel kernel dei permessi (`core/policy/decide.ts`, la
matrice, `defaultMaxTaint`, l'egress) e nel budget. Non è mai un numero sul
profilo del modello: `hardened`, `matrix`, `budgetExhausted` sono gli stessi
per ogni profilo, perché l'autorità non dipende da quanto un modello è
piccolo.

**Guardia dell'harness**: compensazione per un modello che flaila. Vive
**solo** in `agent/profiles/*` per dichiarazione esplicita del repository
(`agent/profiles/recovery.ts:5-9`: *«07 §3 names that directory as the
boundary an impalcatura may not cross»*) — `maxToolsExposed`,
`maxToolCallsPerTurn`/`iterationCap`, la cascata `recovery`, `thinking`,
`sampling`. Sono scaffolding dichiarata rimovibile: quando un modello smette
di averne bisogno, si cancella un profilo, non un ramo nel loop
(`agent/profiles/profile.ts:6-19`).

Il tetto di 15 è **guardia dell'harness**, punto. Il messaggio che il modello
legge quando lo tocca — *«Tetto di N tool call per turno raggiunto»* — non
nomina un'autorità negata, nomina uno scaffolding esaurito, e oggi le due cose
sono indistinguibili solo nel tono del testo, non nel meccanismo: `'cap'` è un
`TurnOutcome` a parte da `'ask'` (che è la vera riga di governance —
approvazione mancante) fin dalla dichiarazione del tipo
(`core/turns/store.ts:75`). La confusione che l'owner segnala non è nel
codice, è nella percezione: un numero che si comporta come un muro duro (morte
del turno, nessuna ripresa) si legge come un vincolo di sicurezza anche
quando non lo è. Restituirgli la sospensione (Parte 3) è anche una correzione
di questo: un harness guard che sospende e riprende *si comporta* da
scaffolding; uno che uccide il turno si comporta, agli occhi di chi lo osserva,
da regola.

## Cosa NON ho fatto

Nessuna modifica a runtime, profili, ADR, `docs/work/handoff.md`,
`cli/update.ts`, `evals/character/**`, `agent/context/assemble.ts` o al
kernel dei permessi. Non ho letto `~/.muffin` né il database dell'owner: la
misura di Parte 0 è quella già estratta dal coordinatore e riportata qui
verbatim, con la sua provenienza dichiarata. Non ho eseguito lo sweep di
`evals/floor` proposto in Parte 3 — richiede una chiave verso un modello reale
e, come misurato, il prerequisito sul confondimento taint va risolto prima che
il risultato sia leggibile.
