# BRIEF — Mandato originale del refactor Muffin → MuffinOS

> Fonte: /loop dell'owner, 2026-08-04. Testo **verbatim** — non editare: è il contratto del blueprint.
> Stato di esecuzione: `docs/blueprint/STATE.md`. Deliverable: questa directory.

---

Refactor totale: Muffin → MuffinOS

Contesto e obiettivo

Muffin è il mio agente AI personale (nato marzo 2026, TypeScript/Node/SQLite, Telegram-first). Voglio farlo evolvere in MuffinOS: da assistente a infrastruttura/harness personale.

MuffinOS sarà open source. "Personale" non significa "solo mio": significa che si adatta in modo profondo a chi lo usa. Questo cambia i requisiti — il sistema deve installarsi e configurarsi su macchine che non sono la mia, e la separazione tra codice del repo / configurazione utente / stato e memoria dell'utente diventa un confine architetturale, non un dettaglio.

Il refactor è atomico e da zero: non modifichiamo il codice esistente, ridisegniamo ogni ADR e piu nello specifico il modo stesso di lavorare, componente, doc e scelta tecnologica. Il codebase attuale è materiale di studio, non base di partenza.

Regola fondamentale di questo esercizio: ogni scelta va rimessa in discussione, incluse quelle che elenco sotto come ipotesi. Se pensi che una mia ipotesi sia sbagliata, dillo e argomenta l'alternativa. Preferisco un piano che mi contraddice con buone ragioni a uno che esegue i miei bias.

Prima di pianificare: esplora il codebase attuale di Muffin e mappa cosa esiste, cosa funziona, cosa è debito.

Analizziamo cose come Hermes (ma non solo) per capire esattamente come funzionano, compreso esperienza utente, capability, features e altre cose che scopriamo/ti vengono in mente

Cercando di mantenere quello che identifica Muffin rispetto a tutti gli altri

Criterio di successo (cosa deve saper fare, e per chi)

MuffinOS non è un prodotto da vendere: è uno strumento personale e un artefatto pubblico. Questo cambia cosa significa "buona architettura" — non elegante in astratto, ma effettivamente vissuta ogni giorno da una persona sola sulla sua macchina. Un design che richiede un team per essere mantenuto ha fallito anche se è corretto.

Le capability che devono esistere, descritte come esperienza e non come feature — sono i casi d'uso da cui derivare le primitive, non un elenco di moduli:

* Ricerca profonda. Non "chiama una search API": indagare su un argomento per conto mio, tenere traccia di cosa ha già guardato, tornare con qualcosa che io non avrei trovato.
* Vault capiente. Gestire una quantità di materiale personale che non entra in nessun context: note, documenti, conversazioni, roba di anni. Il vault è il posto dove vive quello che so, e Muffin ci si muove dentro.
* Memoria solida. Non recall a caso: ricordare la cosa giusta al momento giusto, e sapere quando quello che ricorda è vecchio o non vale più.
* Proattività solida. Parla per primo quando serve, tace quando non serve. La soglia tra le due cose è la feature difficile, non la notifica.
* Fluidità sull'utente. Il comportamento si adatta a me — al mio modo di scrivere, ai miei orari, a come lavoro — senza che io debba configurarlo esplicitamente.
* Introspezione, nelle due direzioni. Guarda i propri pattern e propone come migliorarsi; guarda i miei pattern e mi mostra dove non sto funzionando. Questa è la capability che non ho visto fatta bene da nessuna parte, ed è probabilmente il vero differenziale.

Il vincolo etico è un vincolo di design, non una nota a piè di pagina: MuffinOS non deve sostituire il pensiero critico di chi lo usa, deve rinforzarlo. Un sistema che l'utente non riesce più a smettere di usare ma che ha smesso di renderlo più lucido è un fallimento, anche se tecnicamente impeccabile. Il piano deve dire dove questo vincolo tocca l'architettura — come si progetta un agente proattivo che non crea dipendenza cognitiva, cosa mostra del proprio ragionamento, quando dice "non lo so" o "questa la devi decidere tu", e se esiste un modo per accorgersi che sta scivolando dalla parte sbagliata.

Non ho un criterio di successo misurabile per un sistema così personale. Se ne esiste uno sensato, proponilo — se non esiste, dillo e spiega come si valuta comunque se sta funzionando.

Il nome è una decisione di scope, non di branding

Sto oscillando tra MuffinOS e OpenMuffin, e mi sono accorto che non è una scelta estetica: le due parole descrivono due sistemi diversi.

* MuffinOS mette il system layer al centro. Se si chiama OS, il controllo della macchina è portante e non può essere rimandato a dopo la v1 — il nome promette una cosa e il piano deve mantenerla.
* OpenMuffin mette al centro l'apertura e l'adattamento all'utente. Il system layer diventa una capability tra le altre, posticipabile, e il differenziale si sposta su memoria, introspezione e modello community.

Quindi la domanda sul nome va risolta prima della roadmap, non dopo, perché decide cosa entra nella v1.

Il piano deve rispondere a:

* "OS" è onesto o è overclaim? Un sistema operativo schedula processi, gestisce risorse, media l'accesso all'hardware. MuffinOS non fa niente di tutto questo. Esiste una lettura difendibile — "OS" come control plane, come strato attraverso cui uso la macchina, più vicino a una shell o a un userland che a un kernel — ma va argomentata, non assunta. Guarda anche come è invecchiato l'uso di "OS" in altri prodotti che se lo sono attaccato addosso.
* Il costo dell'overclaim è specifico. Questo progetto è un artefatto di credibilità rivolto a sviluppatori, cioè al pubblico che punisce più duramente le promesse gonfiate. Se il nome promette più di quanto il sistema fa, il danno non è estetico.
* Quanto può davvero "controllare la macchina"? Voglio una risposta concreta e non ottimistica: cosa si riesce a fare in modo affidabile oggi (processi, filesystem, lancio di app, lettura dello stato), cosa si fa in modo fragile (automazione della UI, computer-use), e cosa non si fa. La differenza tra "eseguo comandi sulla macchina" e "controllo la macchina" è esattamente dove sta o cade la parola OS.
* OpenMuffin ha un costo suo. Sta nella stessa famiglia di nomi di progetti che già occupano questo spazio: rende leggibile la categoria ma suona derivato, e mi mette dentro un confronto diretto con loro. Valutalo.
* Esiste una terza opzione? Un nome che non promette un'astrazione che non esiste e non si mimetizza in una famiglia già affollata.

Voglio un verdetto argomentato, non una preferenza.

Lungimiranza (regola trasversale a tutto il piano)

Voglio costruire per il modello che arriva, non per quello che c'è adesso. Buona parte di quello che oggi chiamiamo "architettura agentica" è impalcatura attorno ai limiti attuali dei modelli: compattazione della memoria perché il context finisce, routing tra modelli perché quelli buoni costano, orchestrazione elaborata perché il modello da solo non tiene il filo. Quando quei limiti si spostano, l'impalcatura non diventa neutra: diventa peso morto che combatte contro il modello invece di aiutarlo.

Per ogni modulo e ogni decisione rilevante, il piano deve classificare:

* Durevole — risolve un problema che resta vero anche con un modello dieci volte migliore (identità, permessi, isolamento dei tenant, confine codice/dati utente, audit).
* Impalcatura — esiste solo perché oggi i modelli hanno un limite specifico. Va dichiarato quale limite, e quale segnale indica che è ora di smontarla.

Non voglio che l'impalcatura venga evitata: serve, adesso. Voglio che sia etichettata e isolata, così che togliere un pezzo non richieda una riscrittura. Se una scelta rende difficile smontare la propria impalcatura, è una scelta sbagliata anche se oggi funziona bene.

Stessa domanda dal lato opposto: cosa sto progettando che diventerà più importante, non meno, man mano che i modelli migliorano? La mia ipotesi è che sia tutto ciò che riguarda il contenimento e la fiducia — più il modello è capace, più conta cosa gli è permesso fare. Confermala o smontala.

Niente finto (regola trasversale a tutto il piano)

Non voglio un sistema che sembra funzionare. Ogni pezzo previsto dal piano deve essere realmente funzionante su dati veri, oppure non essere previsto affatto.

Cosa significa in concreto per il piano:

* Nessun mockup, nessuno stub, nessun placeholder. Se un componente non si può realizzare adesso, esce dallo scope della v1 e lo dici — non lo metti nella roadmap come pezzo "da riempire dopo". Preferisco un sistema piccolo e vero a uno completo e finto.
* Nessuna capability decorativa. Se un tool è esposto, deve davvero fare la cosa. Un agente che risponde in modo plausibile senza aver agito è peggio di un agente che dice "non posso": il primo produce fiducia mal riposta, ed è esattamente il fallimento descritto nel criterio di successo.
* Nessun valore hardcoded nel repo. Percorsi, chiavi, ID, soglie, nomi, preferenze: niente di tutto questo vive nel codice. Ma attenzione a non risolvere il problema spostandolo in un file di config gigante che nessuno compila.
* La configurazione la imposto usando Muffin, ed è la strada giusta. È letteralmente il vincolo 2: l'interfaccia di configurazione è Muffin stesso. Quindi per ogni cosa configurabile il piano deve dire tre cose — chi la imposta (io in chat, il sistema da solo, il repo come default), quando (onboarding, primo uso, a runtime quando serve), e cosa succede se manca (chiede, degrada, o si rifiuta di partire). Non voglio scoprire una configurazione mancante da un errore a metà di un'operazione.
* Definition of done = uno scenario reale eseguibile. Per ogni modulo, descrivi lo scenario concreto che deve funzionare end-to-end perché lo si consideri fatto. "I test passano" non è uno scenario. "Scrivo X da Telegram, il sistema fa Y, e dopo un riavvio ricorda Z" lo è.
* Prerequisiti espliciti. Cosa deve esistere prima che il modulo possa girare — account, chiavi, permessi del sistema operativo, hardware. Dichiarati in anticipo, non scoperti durante l'implementazione.

Il criterio di fondo: dobbiamo dare al sistema la possibilità di fare le cose davvero. Ogni volta che il piano prevede un pezzo che simula, imita o rimanda, quella è una decisione da giustificare esplicitamente o da eliminare.

Livello 0 — Vincoli veri (non negoziabili)

Questi sono gli unici punti fermi:

1. CLI-first. MuffinOS si installa e parte da terminale. Ogni altra interfaccia è un connector.
2. Self-modifying by design. Il comportamento vive in file (JSON/YAML/MD) che Muffin stesso può leggere e modificare. L'interfaccia di configurazione è Muffin stesso.
3. Esiste un Root of Trust. Deve esistere una porzione di sistema — piccola, esplicita, nominata — che né il loop agentico né alcun tenant possono modificare a runtime. È il contrappeso obbligatorio al vincolo 2: senza, "self-modifying" e "sicuro" non possono coesistere. Il piano deve dire quali file/moduli ne fanno parte e perché quel confine è tracciato lì.
4. Sicurezza first nel multi-tenant. Se esistono Muffin di gruppo/community, l'isolamento dei dati tra tenant non è sacrificabile per nessuna feature.
5. Le capability di sistema sono host-only. Il layer che tocca l'OS della macchina (processi, app, filesystem) è raggiungibile solo dall'istanza principale sull'host, mai da un tenant remoto — nessun percorso, diretto o indiretto, da un messaggio in un gruppo Discord a un comando di sistema.
6. Riparti da zero. Nessuna scelta attuale sopravvive per inerzia: sopravvive solo se ri-giustificata.

Nota sui conflitti tra questi vincoli. Alcuni tirano in direzioni opposte (il 2 contro il 3, il 5 contro il modello community). Non voglio che tu risolva questi conflitti a intuito né che li appiani: vanno risolti con l'evidenza raccolta in fase di ricerca — come li hanno risolti i sistemi che esistono già, cosa ha funzionato e cosa si è rotto. Se la ricerca non dà una risposta, dichiara il conflitto come irrisolto e presenta le opzioni con i rispettivi costi, invece di sceglierne una in silenzio.

Livello 1 — Ipotesi correnti (da sfidare esplicitamente)

Queste sono le mie ipotesi di lavoro. Per ciascuna, nel piano devi: (a) dire se la confermi, la modifichi o la scarti, (b) argomentare, (c) proporre l'alternativa migliore se la scarti.

Stack

* Ibrido Python (core/AI/logica) + TypeScript (gateway/integrazioni). Sfida: il costo di due runtime vale davvero i benefici? Quale confine esatto tra i due?

Modelli (da rivedere da zero, nessuna ipotesi ereditata)

Oggi Muffin è Claude API + Voyage, con routing Haiku/Sonnet. Questa scelta non sopravvive per inerzia: rimettila in discussione dall'inizio. Ci sarà molta ricerca da fare qui, ed è una delle decisioni più costose da cambiare dopo.

Tre assi da valutare separatamente, perché rispondono a domande diverse:

1. Tier. Frontier a pagamento, modelli medi, o modelli piccoli/consumer. Un agente personale always-on non fa quasi mai lavoro di frontiera: fa classificazione, estrazione, recall, routing, riassunto — task su cui un modello piccolo può bastare. Quali task richiedono davvero un modello grande, e quanti stanno pagando frontier per fare grep?
2. Approvvigionamento. API a consumo, inferenza locale su hardware consumer, o abbonamento consumer usato tramite harness da CLI. Sono tre economie completamente diverse: l'API scala col numero di token e un agente proattivo genera token anche quando non lo usi; il locale ha costo fisso e zero latenza di rete ma un tetto di capacità; l'abbonamento consumer ha costo piatto ma vincoli d'uso e dipendenza da un client che non controllo. Valuta anche le implicazioni di ToS di ognuno, senza girarci intorno.
3. Collocazione. Quale task su quale modello, e chi decide. Il routing è una feature o è impalcatura destinata a sparire (vedi sezione Lungimiranza)?

Domande specifiche da risolvere:

* Un progetto open source può pretendere un provider specifico? Se serve un'astrazione, quanto costa — prompt caching, formato di tool calling ed extended thinking sono provider-specifici, e l'astrazione tende a livellare verso il minimo comune denominatore.
* Esiste una configurazione completamente locale che funziona? Con quale hardware realistico e con quale degrado di capability? Per un agente che legge tutto quello che scrivo, "gira sulla mia macchina e non esce niente" è un argomento forte, non un dettaglio ideologico.
* Ibrido locale/cloud: il modello locale come primo filtro (classificazione, routing, estrazione, dati sensibili) e il frontier solo dove serve, è un design sensato o due sistemi da mantenere?
* Embedding: Voyage è cloud. Esiste un'alternativa locale che non degrada il recall?
* Quanto mi costa MuffinOS al mese in ognuno degli scenari, con un uso realistico e proattivo? Voglio un numero, non una sensazione.

Self-learning / self-improving

Il vincolo di Livello 0 dice che il comportamento vive in file modificabili. Questa è la meccanica. Quello che voglio davvero è il livello sopra: MuffinOS che migliora perché mi ha usato, non perché ho editato un file.

Il piano deve rispondere a:

* Qual è il segnale di apprendimento? Correzioni esplicite, feedback implicito (ho ignorato una proposta, ho riscritto la sua risposta), esiti osservabili, o il ciclo notturno di consolidamento? Un sistema che impara dal segnale sbagliato peggiora con sicurezza.
* Dove si deposita il miglioramento? Prompt, config, memoria, skill nuove, soglie di proattività, preferenze di routing. Sono posti diversi con reversibilità diverse, e non è detto che debbano essere tutti scrivibili dal sistema stesso.
* Come si distingue miglioramento da deriva? Questa è la domanda vera, e si aggancia alla sezione evals: senza un modo di misurare, "self-improving" e "degrada in silenzio" sono la stessa cosa vista da fuori. Serve un meccanismo a cricchetto — una modifica entra solo se supera un set di eval, e si torna indietro se non lo supera?
* Cosa richiede la mia approvazione e cosa no? Un sistema che mi chiede il permesso per ogni aggiustamento è inutile; uno che si riscrive da solo mentre dormo è pericoloso. Dove sta la linea, e cambia col tempo man mano che mi fido?
* Interazione col Root of Trust: l'auto-miglioramento non può toccarlo. Ma allora come evolve il Root of Trust stesso? Solo con un aggiornamento del repo e un mio intervento esplicito?
* Prior art: nel 2026 si è parlato molto di self-improvement e RSI. Separa cosa è stato dimostrato da cosa è narrativa, e dimmi quali tecniche sono realmente applicabili a un sistema di questa scala.

Muffin costruisce Muffin

Voglio usare MuffinOS per sviluppare MuffinOS. Non come aneddoto simpatico: come requisito architetturale, perché è il modo migliore per accorgersi che una scelta è sbagliata, ed è anche la dimostrazione pubblica più forte che il progetto possa dare.

Conseguenze da progettare, non da assumere:

* Bootstrap. MuffinOS v0 non può costruire MuffinOS v1. Qual è la versione minima da cui inizia a lavorare su se stesso, e cosa deve avere esattamente a quel punto (accesso al repo, esecuzione di test, lettura dei propri trace)?
* Il sistema come primo utente. Se lavora sul proprio codice, i suoi trace e i suoi eval diventano il dato con cui migliora. È un ciclo virtuoso o un ciclo chiuso che si autoconferma?
* Confine con il Root of Trust. Può leggere il proprio Root of Trust, proporne una modifica, aprire una PR — ma non applicarla a runtime. Il piano deve dire dove passa esattamente questa linea, perché è il punto in cui il vincolo 2 e il vincolo 3 si toccano più da vicino.
* Host-only, senza eccezioni. Il lavoro sul proprio codice è capability di sistema: nessun tenant, nessun gruppo, nessun percorso indiretto ci arriva. Vale anche per "proponi un miglioramento" scritto da uno sconosciuto in un gruppo Discord.
* Rapporto con gli harness da coding esistenti. Ha senso che MuffinOS reimplementi le capability di coding, o deve orchestrare un harness già maturo per quel pezzo? Vale la regola generale: non riscrivere roba risolta.

Orchestrazione

* Graph workflow dove serve per task e tool. Attenzione: è un pattern recente, valuta librerie e maturità reale (LangGraph, Pydantic Graph, alternative, o graph fatto in casa). "Dove serve" va definito: quali flussi beneficiano del grafo e quali restano loop semplici?

Core & Gateway

* Gateway centrale con asyncio sempre aperto che instrada i messaggi verso i connector tramite metadati (connector, sessione, context ID). Un connector è designato come principale.

Loop agentico

* Loop stile harness moderno (riferimento: Hermes/pi/Claude Code): tool call in continuazione fino alla risposta finale. Nota: qui avevo un pensiero incompleto ("però prima...") — probabilmente una fase di pre-processing prima del loop (routing? recall memoria? classificazione?). Proponi tu cosa dovrebbe accadere prima del loop e perché.
* L'harness deve poter lavorare su se stesso e analizzare i pattern dell'utente — questa è la differenza chiave rispetto a un harness generico. Come si progetta questa capability?

Context

* Il context si costruisce al messaggio. Il design deve considerare: prompt caching, sessioni, multi-turn. Proponi la strategia di costruzione.

Memoria

* Storage ibrido: Vault (file) + SQLite (relazionale) + sqlite-vec (vettoriale). Salviamo ogni messaggio, compattazione semantica oltre soglia.
* Ontologia per l'estrazione: triplette soggetto→predicato→oggetto con vincoli di coerenza (es. "un solo padre"; da "Mario insegna a Carlo" derivare Mario:professore, Carlo:studente, relazione:insegnamento). Grafo + reranking sul recall.
* Sfida: l'ontologia rigida è il design giusto o over-engineering? Quali alternative (schema-light, entity extraction pura, GraphRAG)?

Identità

* File tipo soul.md (system prompt base), voice.md (modificabile), human.md (modificabile). Valuta se questa tripartizione è giusta o se esiste un modello migliore.

Scheduling

* Cron semantico interno: "ogni mattina fai X" definibile dalla chat in linguaggio naturale.

Sicurezza: modello di minaccia (sezione obbligatoria del piano)

MuffinOS come descritto ha tutte e tre le gambe della "lethal trifecta" di Simon Willison, nella forma peggiore possibile:

1. Dati privati: grafo di memoria completo + filesystem + accesso al sistema.
2. Input non fidato: messaggi di sconosciuti in gruppi Telegram/Discord. Chiunque entri in un gruppo può scrivere testo che il modello leggerà come istruzione.
3. Canale di esfiltrazione: API, tool esterni, connector, rete. Non è un rischio ipotetico: OWASP nel 2026 classifica l'indirect prompt injection come rischio principale per le applicazioni agentiche, e il consenso attuale è che sia un difetto architetturale — non si patcha con hardening del system prompt. La prevenzione (togliere una gamba) romperebbe il prodotto; l'approccio praticabile è il contenimento: scoping dei dati per tenant, controlli a runtime, blocco dei percorsi di esfiltrazione prima dell'esecuzione, osservabilità di ogni azione.

* Sotto-problema specifico e grave: memory poisoning. La mia pipeline scrive ogni messaggio nel grafo di memoria dopo estrazione ontologica. Un messaggio ostile in un gruppo può inserire un'istruzione persistente che si attiva molto dopo, in un contesto diverso. Il piano deve dire come si separa "contenuto osservato" da "istruzione ricevuta" nel modello dati della memoria, non solo nel prompt.
* Domanda diretta: quali azioni restano possibili quando il context contiene input non fidato? Serve un concetto di taint che si propaga dal messaggio al grafo alle azioni?

Standard ed ecosistema (valuta ognuno: adottare, ignorare, o divergere motivatamente)

Non voglio reinventare formati che hanno già un ecosistema. Per ciascuno: si adotta?

* MCP — attenzione, il 28 luglio 2026 esce la spec `2026-07-28` con breaking changes: protocollo stateless, handshake `initialize` rimosso, sessioni e `Mcp-Session-Id` eliminati, Tasks spostato in extension, nuovo framework di extensions (incluse MCP Apps), e deprecazione di Roots/Sampling/Logging. Costruire oggi contro la spec vecchia significa nascere legacy. Il piano deve scegliere esplicitamente quale revisione targetizzare.
* MCP Apps (SEP-1865) — l'extension che permette a un server MCP di servire UI HTML interattive renderizzate dall'host in iframe sandboxed, dichiarate come risorse `ui://` e associate ai tool via metadata. La mia ipotesi è che questa sia la strada per la dashboard e la UI generativa di MuffinOS, costruita sopra il gateway invece che come frontend separato: Muffin genera l'interfaccia di cui ha bisogno in quel momento (stato del sistema, esplorazione del grafo di memoria, approvazione HITL, configurazione) e la serve al connector che la sa renderizzare. Valuta: (a) è la scelta giusta o è meglio una UI propria; (b) quali connector la supportano davvero e cosa succede su quelli che non la supportano (Telegram non renderizza HTML — degrada a cosa?); (c) come si incastra col modello di permessi, dato che un'azione partita dalla UI deve passare per lo stesso path di consenso e audit di una tool call diretta; (d) se ha senso che MuffinOS sia anche un server MCP che espone la propria UI, non solo un client.
* MCP Tasks — ora extension separata dopo il redesign. Riguarda il lavoro long-running: un task che dura minuti od ore, di cui si può seguire lo stato. Sembra il candidato naturale per la ricerca profonda, la compattazione della memoria e il cron semantico. Domanda: adotto Tasks come modello per il lavoro asincrono interno di MuffinOS, o l'astrazione MCP è pensata per il confine client/server e usarla internamente è forzarla? E se la uso solo verso l'esterno, che modello uso dentro?
* Agent Skills / SKILL.md — standard aperto (Apache 2.0, agentskills.io), adottato da molte piattaforme, con progressive disclosure e cataloghi già popolati. Se MuffinOS inventa il proprio formato di skill, rinuncia a un ecosistema già esistente. C'è una ragione per divergere?
* AGENTS.md — convenzione de facto per il contesto di progetto, ora sotto Agentic AI Foundation (Linux Foundation), la stessa che governa MCP.
* OpenTelemetry GenAI semantic conventions (`gen_ai.*`, span per agent/workflow/tool/model, convenzioni MCP) — vocabolario standard per la telemetria agentica. Ancora pre-stabile, quindi si pinna la versione, ma è la scelta ovvia rispetto a inventare log format propri.
* Benchmark di memoria: LoCoMo, LongMemEval, BEAM sono lo standard di confronto per architetture di memoria. Prior art rilevante sulla mia idea di ontologia: temporal knowledge graph (Zep/Graphiti) e la letteratura su graph-based agent memory. La mia ontologia va confrontata con questi, non progettata nel vuoto.

Osservabilità ed evals (mancava del tutto)

* Un sistema con graph workflow + estrazione ontologica + compattazione + cron + self-modification è un sistema in cui "perché ha fatto così?" è difficilissimo da rispondere. Il tracing non è un extra di fine progetto: è la condizione per poterlo sviluppare. Va progettato nel Modulo 1.
* Evals: se MuffinOS può modificare la propria configurazione, serve un modo per accorgersi che una modifica ha peggiorato le cose. Senza un set di eval (sulla memoria in particolare: il recall è corretto? il grafo dice il vero?) il self-modifying è una funzione che degrada in silenzio. Come si testa un sistema che cambia se stesso?

Open source: conseguenze architetturali

Il piano deve trattare queste come decisioni di design, non di packaging:

* Confine codice / config / dati utente: se sono intrecciati non si può distribuire. Dove vive `soul.md` di default e dove finisce la versione personalizzata dell'utente? Come si aggiorna il repo senza sovrascrivere l'identità che l'utente ha costruito?
* Provider di modelli: oggi Muffin è Claude API + Voyage. Un progetto open source può richiedere un provider specifico? Serve un'astrazione? Come impatta prompt caching e formato di tool calling, che sono provider-specifici?
* Secrets: chiavi API e token dei connector. In un progetto personale si hardcoda; qui no.
* Modello di estensione: se è open source, terzi vorranno scrivere connector e skill. L'API di estensione è una decisione da prendere all'inizio, non dopo.
* Onboarding: primo avvio, bootstrap della configurazione, cosa serve avere prima di partire.
* Privacy e dati di terzi: nei gruppi la memoria cattura messaggi di persone che non hanno acconsentito a finire in un knowledge graph. Export, cancellazione, retention — sono requisiti reali (GDPR, e io sono in EU), non nice-to-have.
* Telemetria: il sistema manda dati fuori? Per un agente che legge tutto, la risposta di default deve essere no, e va detto esplicitamente.
* Migrazione di schema: una volta che il grafo ha dati veri di utenti veri, cambiare l'ontologia è doloroso. Strategia di versioning e migrazione della memoria.
* Licenza: la scelgo io, ma dimmi quali implicazioni tecniche/architetturali ha (es. se un giorno volessi una versione commerciale, cosa mi vincola).

Prior art e differenziazione

Lo spazio "agente personale always-on, self-hosted, open source, che parli dalle chat app" è già affollato nel 2026: OpenClaw (MIT, con un registry di migliaia di "claws") e Hermes sono esattamente questa forma; Goose (Apache 2.0, Block) è un harness generale con architettura a extension; OpenHarness (HKUDS) è un runtime agentico CLI-first.

* Il piano deve iniziare con un confronto onesto: cosa fa MuffinOS che questi non fanno? La mia ipotesi è che il differenziale sia (a) la memoria ontologica con analisi dei pattern dell'utente e (b) il modello community cross-connector. Confermalo o smontalo.
* Dove ha senso stare sopra a qualcosa di esistente invece di riscriverlo? Quali pezzi del mio piano sono valore reale e quali sono riscrittura di roba risolta?
* Non reinventiamo la ruota, ci sono cose che sono gia state fatte da tantissimi altri developer, dobbiamo distillare il piu possibile

Gruppi e community

* Muffin è aggiungibile a gruppi su connector diversi (Telegram, Discord, ecc.). Ogni gruppo è un tenant indipendente di default.
* La community è un layer opzionale e trasversale ai connector: un sottoinsieme arbitrario di gruppi può essere raggruppato in una community, e solo quei gruppi condividono memoria e capability. Esempio concreto: ho 3 gruppi Telegram e 2 Discord; 1 Telegram + 1 Discord formano una community, gli altri 3 restano isolati e non sanno nulla l'uno dell'altro.
* Il Muffin principale orchestra i Muffin di gruppo, che hanno capability ridotte.
* Questo modello apre problemi che il piano deve affrontare, non aggirare:
   * Identità cross-connector: se una community unisce Telegram e Discord, la stessa persona ha due identità diverse. Il sistema le risolve? Come, e con quale grado di certezza? Cosa succede se sbaglia?
   * Cosa si condivide esattamente: memoria? tool? identità (voice/soul)? Una community ha una sua voce propria o eredita quella del main?
   * Direzionalità: la memoria di gruppo risale al Muffin principale? Il principale può leggere nei gruppi? È simmetrico o gerarchico?
   * Confini mutabili: cosa succede alla memoria condivisa quando un gruppo entra o esce da una community? Si può "smontare" una community senza fughe di dati?

Tools

* Set primitivo di tool/skill built-in: CLI, MCP, API — il più primitivo e flessibile possibile, utilizzabile sia verso l'interno (manutenzione del sistema) che verso l'esterno.

System layer (è questo che rende MuffinOS un OS)

* Qui sta il salto rispetto a un harness tipo Hermes. MuffinOS non lavora solo su se stesso e sulle API: opera sulla macchina. Aprire applicazioni, ispezionare e gestire processi, muoversi nel filesystem, osservare lo stato del sistema — l'ambizione è vicina a un ambiente di cowork, non a un chatbot con dei tool.
* Domande che il piano deve risolvere:
   * Astrazione: shell? API native per OS? un layer di computer-use? Quale confine tra "eseguo un comando" e "controllo la macchina"?
   * Cross-platform: aprire un'app su macOS e su Linux sono cose diverse. Si supporta un solo OS all'inizio (quale?) o si progetta l'astrazione da subito? Voglio che macOS sia un target reale, non un "magari un giorno": valuta cosa comporta davvero — API di automazione e accessibilità, prompt di permesso del sistema, firma e distribuzione di qualcosa che tocca l'OS — e confrontalo con l'equivalente Linux. Se le due strade divergono troppo per essere unificate adesso, dimmi quale si fa prima e dove va messo il confine perché aggiungere la seconda non sia una riscrittura.
   * Modello di permessi: l'attuale Muffin ha una classificazione HITL a tre livelli (read_only / always_ask / contextual). È prior art rilevante: si estende al system layer o serve un modello diverso, più simile a capability/scope?
   * Reversibilità e blast radius: quali azioni di sistema sono irreversibili, e come le si gate?
   * Interazione col vincolo self-modifying: un agente che può modificare la propria configurazione E controllare il sistema è una combinazione potente e pericolosa. Dove sta il confine? Cosa non deve poter toccare mai di se stesso?
* Tensione da affrontare esplicitamente, non da appianare: il system layer e il multi-tenant tirano in direzioni opposte. Più MuffinOS è capace sulla macchina, più grave diventa qualunque falla nell'isolamento dei gruppi. Il piano deve mostrare dove passa questa linea a livello architetturale, non solo a livello di permessi runtime.

Livello 2 — Domande aperte (nessuna ipotesi, proponi tu)

1. Cosa accade prima del loop agentico (vedi nota sopra)?
2. Struttura esatta dello schema dell'ontologia e del modello dati del grafo.
3. Strategia di migrazione della memoria esistente di Muffin (se ne vale la pena) vs. cold start.
4. Come si valida l'integrità del grafo di memoria nel tempo (testing della memoria, non solo del codice).
5. Ordine di build dei moduli: la mia intuizione è Core → Memory → Tools → Community, ma sfidala se ha senso un ordine diverso. Nota: il system layer non è in questa sequenza — dimmi tu dove va, e se va posticipato a dopo la v1.
6. Modello di permessi unificato: esiste un'unica astrazione che copra tool interni, tool esterni, azioni di sistema e capability dei tenant? O sono modelli separati per natura?
7. Qual è lo scope minimo di v1? Questo documento descrive un sistema molto grande. Dimmi cosa taglieresti per avere qualcosa di funzionante e usabile il prima possibile, e cosa invece è strutturale e va deciso subito perché cambiarlo dopo costerebbe una riscrittura.

Modello di esecuzione

Non affrontare questo documento come un thread singolo: il context finisce prima della roadmap e le ultime sezioni escono peggiori delle prime. Lavora in tre fasi.

Fase A — Ricerca, in parallelo

Fan-out di subagenti su lavoro read-only (ricerca, lettura, analisi). Tre-cinque concorrenti: oltre, si spende più tempo a fondere i risultati di quanto se ne risparmi. Mandati:

1. Inventario del codebase Muffin — cosa esiste, cosa funziona, cosa è debito. Output: tabella keep / change / kill con una riga di motivazione.
2. Prior art — OpenClaw, Hermes, Goose, OpenHarness e ogni altro sistema rilevante che emerge. Capability reali, esperienza utente, architettura, cosa hanno risolto e cosa hanno lasciato aperto.
3. Standard — spec MCP `2026-07-28` letta dalla fonte primaria, extension MCP Apps e Tasks, SKILL.md, AGENTS.md, OTel GenAI. Cosa dicono davvero, non cosa si racconta in giro.
4. Memoria — LoCoMo, LongMemEval, BEAM, Zep/Graphiti, GraphRAG, letteratura su graph-based agent memory. Come sono fatte le architetture che vincono e perché.
5. Modelli ed economia — panorama attuale su tutti e tre gli assi della sezione Modelli: frontier vs medi vs piccoli, API vs locale vs abbonamento consumer, capacità reali dei modelli open-weight sul tool calling e sul long context, hardware necessario, costo mensile realistico per un agente always-on. Più lo stato reale della ricerca su self-improvement. Serve materiale con numeri, non impressioni.

Contratto di output dei subagenti: restituiscono evidenza con fonte, mai raccomandazioni o verdetti. Chi decide è l'agente principale, che deve poter vedere su cosa sta decidendo. Un subagente che torna con "consiglio X" mi fa ereditare una conclusione che non posso verificare.

Tutta la ricerca la fai qui: nessuna affermazione fattuale nel piano deve venire dalla memoria del modello. Se una cosa non è stata verificata in Fase A, o si verifica, o si dichiara come non verificata.

I conflitti tra i vincoli di Livello 0 si risolvono qui: guardando come li hanno risolti gli altri.

Fase B — Sintesi, sequenziale

Verdetti sulle ipotesi, design dell'ontologia, roadmap, threat model, scope di v1. Questa parte non si parallelizza: sono decisioni che devono restare coerenti tra loro, e due subagenti che progettano pezzi diversi dello stesso sistema producono un blueprint che si contraddice.

Fase C — Critica, di nuovo in parallelo

Tre subagenti con mandato ostile, ognuno che legge il piano di Fase B:

1. Attacca il threat model — trova il percorso da un messaggio in un gruppo a un'azione che non dovrebbe essere possibile.
2. Attacca la complessità — con licenza esplicita di dire "questo pezzo non serve, ecco cosa si perde a toglierlo". Cerca over-engineering, astrazioni premature, roba già risolta da altri.
3. Fai l'ingegnere che deve costruire il Modulo 1 — leggi il piano come se dovessi implementarlo domani e scrivi ogni domanda che ti resta.

Il terzo è il test vero della definition of done. Le sue domande vanno risolte nel piano, non lasciate come appendice.

Checkpoint

Uno solo, e vero: fermati alla fine della Fase A e mostrami i findings prima di scrivere qualunque verdetto. Aspetta la mia risposta. È l'unico punto in cui una correzione costa poco: dopo, ogni decisione è già cementata in tutto il resto del documento.

Per il resto vai fino in fondo senza chiedermi permessi intermedi.

Deliverable richiesto (MuffinOS Blueprint)

Non scrivere codice. Produci un piano con:

1. Inventario dell'esistente: per ogni scelta/componente dell'attuale Muffin → keep / change / kill, con motivazione in una riga.
2. Verdetti sulle ipotesi di Livello 1: conferma/modifica/scarto + argomentazione.
3. Design delle entità: schema ontologia e modello dati del grafo (o dell'alternativa che proponi).
4. Roadmap di implementazione: sequenza di moduli, con per ciascuno: cosa include, cosa NON include, dipendenze, prerequisiti, e lo scenario reale eseguibile che deve funzionare per considerarlo fatto (vedi "Niente finto").
5. Strategia di testing ed evals: come validare ogni modulo, l'integrità del grafo di memoria, e come accorgersi delle regressioni in un sistema che modifica se stesso.
6. Threat model esplicito: dove passa l'input non fidato, quali azioni può raggiungere, dove si interrompe la catena. Con i controlli di contenimento concreti, non principi generici.
7. Verdetti sugli standard: MCP (quale revisione), MCP Apps, MCP Tasks, SKILL.md, AGENTS.md, OTel GenAI — adottare / ignorare / divergere, con motivazione.
8. Scelta dei modelli: verdetto sui tre assi (tier, approvvigionamento, collocazione), con il costo mensile stimato per ogni scenario e la configurazione consigliata per me e quella consigliata per chi installa il repo — che possono non coincidere.
9. Classificazione durevole / impalcatura: per ogni modulo, quale dei due è. Per ogni impalcatura, quale limite del modello la giustifica e quale segnale dice che è ora di toglierla.
10. Verdetto sul nome: MuffinOS, OpenMuffin o altro, con l'argomentazione e — soprattutto — cosa cambia nello scope della v1 a seconda della scelta.

Prima di presentare il piano finale: ripercorri il piano e fai emergere ogni scelta implicita o assunzione che hai fatto senza che io la chiedessi (strutture dati, librerie, confini tra moduli, dove vive lo stato). Elencale esplicitamente: voglio approvare anche quelle, non solo il piano macro.

Definition of done del piano: potrei consegnare questo blueprint a un altro ingegnere e lui potrebbe iniziare a costruire il Modulo 1 senza farmi domande.

Dove vive il deliverable

Il blueprint non è output di chat: è materiale su cui si lavora per mesi e che deve reggere la consegna a un'altra persona. Scrivi file, in `docs/blueprint/`:

```
docs/blueprint/
  00-findings.md        # output di Fase A: inventario, prior art, standard, memoria
  01-verdetti.md        # Livello 1: conferma / modifica / scarto, con argomentazione
  02-ontologia.md       # schema entità, modello dati del grafo, migrazione
  03-threat-model.md    # percorsi dell'input non fidato e controlli di contenimento
  04-roadmap.md         # moduli, dipendenze, definition of done per ciascuno
  05-testing-evals.md   # validazione, integrità della memoria, regressioni
  06-modelli.md         # tier, approvvigionamento, collocazione, costi, self-improvement
  07-durevole-vs-impalcatura.md   # cosa sopravvive al prossimo salto di modello e cosa no
  08-assunzioni.md      # ogni scelta implicita che hai fatto senza che te la chiedessi
  adr/
    0001-*.md           # una decisione per file, numerata

```

Ogni decisione architetturale rilevante diventa un ADR con questa struttura, non discorsiva:

* Contesto — qual è il problema e quali vincoli lo delimitano
* Decisione — cosa si fa
* Alternative scartate — quali erano, e la ragione precisa per cui perdono
* Conseguenze — cosa diventa più facile e cosa più difficile da qui in poi
* Reversibilità — quanto costa smontarla tra sei mesi, e qual è il segnale che indica che era sbagliata

L'ultimo punto è quello che uso di più: mi serve sapere quali decisioni sono economiche da cambiare e quali no, perché è quello che determina cosa devo decidere adesso e cosa posso rimandare.

---

## Addendum owner №1 — 2026-08-04 (via /loop, verbatim)

> Modifica la sezione «Memoria» del mandato sopra: l'ipotesi delle triplette rigide passa da "ipotesi da sfidare" a "ipotesi sospetta con mandato d'attacco esplicito". Impatta `01-verdetti.md` e `02-ontologia.md`.

Memoria e Grafo: La mia ipotesi iniziale prevedeva un'estrazione ontologica rigida a triplette (soggetto → predicato → oggetto). Ho il forte sospetto che questo sia un classico caso di over-engineering fragile che fallisce con i dati umani imprecisi.

Mandato d'attacco: Metti a confronto l'estrazione a triplette rigide con le architetture a Temporal Knowledge Graph schema-light (es. Graphiti/Zep) e l'approccio hybrid GraphRAG. Valuta la differenza in termini di latenza a runtime, gestione delle contraddizioni dell'utente nel tempo e facilità di manutenzione. Se (come ipotizzo) il Temporal Graph vince, scarta ufficialmente le triplette rigide e progetta il Modulo Memoria su base temporale.
