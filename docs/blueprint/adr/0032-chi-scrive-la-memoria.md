# ADR-0032 — Chi scrive la memoria: l'harness estrae, l'agente non si cura da solo

**Contesto.** ADR-0004 ha scelto la *forma* della memoria (TKG bi-temporale schema-light) scartando triple rigide, GraphRAG come storage, Graphiti/Zep e l'estrazione pura Mem0-style. Non ha mai nominato l'alternativa che il campo considera ovvia: la **memoria auto-curata dal modello via tool** — la linea MemGPT→Letta, `core_memory_append`/`replace` in mano all'agente. La scommessa era già presa (in `02-ontologia.md` §3 la pipeline di estrazione è *"per batch di episodi, asincrona, mai nel path di risposta"*; in `agent/tools/memory.ts` l'unico tool di memoria è `memory_search`, capability `memory.read`) ma non era **scritta** — e una scommessa non scritta è una che il prossimo refactor ribalta senza accorgersi di ribaltare qualcosa. La passata di confronto coi peer (`research/confronto-harness.md` §2.2, 2026-08-11) l'ha armata di evidenza, e insieme ha **ristretto il fork**: anche Letta — l'azienda costruita sulla scommessa opposta — dà **timing ed eviction all'harness** (la compattazione non ha un tool; gli agenti sleep-time girano a schedulazione, `turns % frequency == 0`). Non stiamo scegliendo fra "harness" e "agente": stiamo scegliendo **chi scrive il contenuto**, e solo quello.

**Decisione.** L'harness scrive, il modello legge. In concreto, e per ciascuna delle tre cose che si possono dare a un agente:

1. **Contenuto — all'harness.** Un fatto entra in memoria solo dalla pipeline: episodi immutabili → estrazione batch (`core/memory/extract.ts`, descrittiva per costruzione: si estrae *cosa il testo dice*, mai *cosa chiede*) → ingest col giudice di contraddizione (ADR-0006: mai DELETE, solo supersede come chiusura bi-temporale con link). Nessun tool crea, modifica o cancella un fatto. **L'assenza è di superficie, non di prompt**: non c'è niente da convincere, perché non c'è niente da chiamare.
2. **Timing ed eviction — all'harness** (come già fa Letta, quindi non è qui che si decide qualcosa).
3. **Cosa il modello può fare della memoria — leggerla.** `memory_search` sul tenant del turno, senza campo tenant negli argomenti; l'unico contributo del modello al contenuto è indiretto e onesto: ciò che dice diventa episodio — **e nemmeno quello diventa fatto**: l'estrazione salta `role: 'agent'` (`core/memory/ingest.ts:91`, contato come `skipped_agent`). Il contributo del modello al contenuto della memoria è zero, non indiretto.

**Alternative scartate.** *Self-editing via tool* (Letta, e la scelta di default del campo). Contro, tutto verificato in `confronto-harness.md` §2.2: (a) **Letta stessa** misura **74,0%** su LoCoMo con filesystem tools nudi (gpt-4o-mini), sopra Mem0-graph a 68,5% — l'apparato di self-editing non è ciò che produce il punteggio; (b) **il loro leaderboard** dice dove si rompe: `core_read` saturo ~100, `core_update` collassa (claude-sonnet 83,7 · gpt-4.1 66 · o3-mini **16,7** · nano **0,0**) — cioè la scrittura agentica è affidabile esattamente sulla classe di modelli che non possiamo assumere; (c) **Memory-R1** (ACL 2026, arXiv:2508.19828): self-editing promptato porta F1 da 41 a **34,5**, e il failure mode nominato è il *DELETE spurio su non-contraddizione* — che il nostro modello dati rende **non rappresentabile**, non improbabile; (d) gli **incidenti**, verificati uno per uno: `#3388` (aperto) poisoning cross-sessione via self-write nella persona, `#1616` replace-vuoto che esplode il blocco, `#3241` blocchi che si gonfiano di notte per **$30** con risposta *"intended"*, `#3291` il summarizer che inventa contenuto e lo salva; (e) e la direzione del vento: con `#3118` Letta sta **arretrando** le scritture di background a propose-only. *Ibrido — pipeline più un tool di correzione per il modello*: è la stessa superficie con meno usi, e ne eredita per intero la classe di guasto peggiore (un fatto piantato da un messaggio ostile che si scrive da solo in memoria); se un giorno serve, la forma giusta è lo **staged-pending store** (proposta persistita, revisionabile, l'owner ratifica — `confronto-harness.md` §3), non un edit diretto. *Nessuna memoria strutturata, solo retrieval sul trascritto*: già scartata da ADR-0004 per ragioni indipendenti (introspezione, "chi/quando/perché").

**Il contro-argomento, per intero.** Non esiste **nessun head-to-head controllato agentico-vs-pipeline**, in nessun punto del campo: è il "non trovato" dichiarato dalla ricerca, e vale contro di noi quanto contro di loro. La linea MemGPT ha numeri forti, ma su una domanda diversa — memoria agentica contro **nessuna** memoria — e quel confronto lo vinciamo anche noi, perché una pipeline è memoria. Sull'unica domanda che ci separa nessuno ha misurato, quindi ciò che abbiamo non è una prova: è un fascio di evidenza indiretta (il punteggio che non viene dal self-editing, l'update che collassa, il failure mode che sappiamo eliminare, quattro incidenti e una ritirata) contro zero evidenza indiretta dall'altra parte. Lo scriviamo così, non meglio di così.

**Conseguenze.** Più facile: il memory-poisoning per auto-scrittura non è una minaccia da mitigare ma una forma inesistente; l'estrazione è **ri-eseguibile** su tutti gli episodi con una `extraction_v` nuova (un modello che estrae male si corregge rigiocando, non ripulendo a mano); la qualità della memoria non dipende dalla classe del modello del turno. Più difficile: **paghiamo i miss**. Ciò che la pipeline non estrae non entra, e nessuno se ne accorge nel momento in cui succede — un agente curatore, quando funziona, cattura anche l'irregolare. La contromisura non è un tool di scrittura: è la revisione a freddo dei fatti (`02-ontologia.md` §3) e il consolidamento.

**Reversibilità.** Media, e asimmetrica. Aggiungere una scrittura agentica dopo è additivo e a buon mercato (un tool, una capability, il kernel già sa negarla); toglierla dopo significa vivere con una memoria in cui non sai più quale riga è stata scritta da chi — il percorso caro è quello, ed è il motivo per cui si parte da qui. Segnale che era sbagliata, con numeri e senza controfattuali: alla revisione a freddo dei **primi cento fatti estratti dall'uso reale**, più di **10/100** risultano sbagliati o mancanti in un modo che una rilettura umana coglie al volo (il comparatore è la rilettura, che si può fare — non "cosa avrebbe catturato un curatore", che non si può osservare senza costruirlo); oppure compare un head-to-head controllato che misura la nostra stessa domanda e dice il contrario. Si conta sui fatti, non sull'impressione che la memoria "sembri povera".

---

## Emendamento (2026-08-11) — l'owner corregge: ibrido, con riconciliazione

**La correzione, sua**: *"dovremo lasciar gestire la memoria a muffin, e piuttosto se usa un tool per fare ste cose la learning pipeline che spariamo in background ne deve essere consapevole, così da non salvare due volte, o magari sistemare."*

Ha ragione, e la decisione sopra va stretta invece che difesa. Rileggendo l'evidenza che l'ha armata: **nessuno dei due peer sta al polo che questo ADR aveva scelto.** Letta dà all'agente i tool per il *contenuto* e tiene all'harness *timing ed eviction*; Hermes è esplicitamente ibrido (l'agente chiama il tool `memory`, l'harness fa prefetch/sync e lo *sollecita* a scrivere ogni N turni). Il polo puro — "il modello non tocca mai la memoria" — non lo occupa nessuno, e non era necessario per evitare i failure mode misurati.

**Cosa resta identico** (ed è ciò che i numeri difendevano davvero): mai DELETE, solo supersede bitemporale; ogni fatto porta `origin` e provenienza all'episodio; il modello non decide *quando* si consolida. I fallimenti di Memory-R1 (DELETE spurio su non-contraddizione) e di Letta #3388 (poisoning cross-sessione) restano **non rappresentabili** perché nascono dallo *sbiancamento* di righe, non dalla loro scrittura.

**Cosa cambia**: il modello può *scrivere* attraverso un tool, e la scrittura è una riga come le altre — `origin: 'inferred'`, tier del turno, episodio d'origine. Cioè: non un canale privilegiato, una riga in più con la sua provenienza.

**Il problema vero che l'owner nomina — la riconciliazione — e la sua forma.** Se il tool ha già scritto un fatto da un episodio, l'estrazione in background non deve ri-derivarlo. Il materiale c'è già:
- l'estrazione salta gli episodi già minati (`extraction_v`), quindi il doppio passaggio *sullo stesso episodio* è già escluso;
- ciò che manca è la chiave che lega un fatto scritto-dal-tool al suo episodio, così che l'estrazione riconosca "questo l'ha già detto lui" invece di produrre un duplicato quasi-uguale;
- e il caso "magari sistemare": un fatto estratto che contraddice uno scritto dal tool non è un conflitto nuovo — è **esattamente** il giudice di contraddizione di ADR-0006, che chiude la vecchia riga con `superseded_by` invece di cancellarla.

**Cosa non è ancora deciso e va deciso quando si costruisce**: se il tool scrive direttamente o *propone* (Letta sta arretrando verso propose-only, #3118 — e il nostro esito `DRAFT` del kernel esiste già per questa forma); e se un fatto scritto dal modello debba portare un `origin` proprio invece di `inferred`, cioè se "dedotto da me mentre parlavo" e "dedotto dalla pipeline" siano la stessa cosa per il recall. Non le decidiamo qui: le decide il primo turno in cui il tool esiste.

**Segnale che questo emendamento era sbagliato**: duplicati quasi-identici fra fatti scritti dal tool ed estratti (contati sulla revisione a freddo), oppure una scrittura del modello che sopravvive a una contraddizione che avrebbe dovuto chiuderla.

---

## Emendamento (2026-08-21) — il fork direct-write/propose è chiuso da ADR-0051

La formulazione dell'11/08 «il modello può scrivere attraverso un tool» va letta
come una tappa storica, non come la semantica corrente. La decisione owner del
21/08 chiude il fork lasciato aperto sopra:

> **Muffin può decidere cosa vale la pena ricordare, ma produce una
> `MemoryProposal`; una sola reconciliation posseduta dalla Home applica le
> transizioni canoniche delle Beliefs.**

Quindi il tool futuro non è semanticamente `memory.write` ma `memory.propose`,
anche se la UX potrà chiamarlo `remember`. Tenant, source identity,
speaker/provenance e trust/taint sono derivati dal runtime, non scelti dal
modello. Una proposal agentica non è una belief attiva e non entra nel recall
come verità canonica finché non attraversa reconciliation.

La seconda domanda che l'emendamento dell'11/08 lasciava aperta è chiusa nello
stesso punto: **agent-inferred e pipeline-inferred devono restare distinguibili
semanticamente**, anche se il nome fisico dell'enum verrà scelto quando esisterà
lo schema. Una deduzione del modello non diventa owner-stated per il fatto di
essere stata formulata nel turno dell'owner.

ADR-0051 possiede rationale, conseguenze, threat boundary e ciò che resta
intenzionalmente lasciato all'implementazione. Questo ADR conserva la storia del
cambio di direzione; ADR-0051 possiede la forma corrente.
