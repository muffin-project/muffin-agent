# Critica modulo per modulo, contro i peer — 2026-09-07

**Evidence datata, non autorità.** Domanda dell'owner (07/09, dopo il dogfood):
*«stiamo facendo una memoria del cazzo? se ci paragoniamo alle memorie più grandi
in circolazione, stiamo facendo slop? sii critico, ogni modulo»*. Quattro
revisori indipendenti (memoria; loop, prompt e tool; superfici; kernel e
harness) hanno letto il codice installato (`fe8d55e`) e la documentazione
ufficiale dei peer. **Due parti sono complete** (memoria, superfici); le altre
due sono morte per il limite di utilizzo e non sono state riscritte: la loro
assenza è dichiarata, non riempita. I numeri vivi vengono dal `muffin.db`
dell'owner letto in sola lettura, in forma aggregata.

Come usarla: nessuna riga qui è una decisione. Ciò che cambia una promessa
corrente è stato instradato nella sua casa autoritativa dalla riconciliazione
di #463; il resto resta ipotesi per il dogfood.

---

# La memoria di Muffin, letta contro il campo

Revisione critica, 2026-09-07. Codice letto: il codice installato (`fe8d55e`).
Numeri vivi: database dell'owner (528 episodi, 145 fatti, 4 entità, 0 identità,
557 chunk, 0 digest, 0 profili, 146 righe di `memory_review`, 203 run di
consolidamento).

Risposta breve alla domanda: **no, non è slop nel senso di "generato senza
pensiero" — è il contrario, è il sistema più ragionato del confronto.** È slop
in un senso più scomodo: **una quantità di meccanismo che nessuno ha mai
misurato, sopra un grafo che dopo 528 episodi contiene 4 entità, 0 identità e
~72 credenze vere.** Il rapporto fra righe di ragionamento scritte e bit di
conoscenza prodotti è il difetto principale, e non si vede da dentro perché
tutto è verde.

---

## 1. Episodi e raw-first

**Cosa fa Muffin.** `core/memory/schema.ts:26-88` — piano evidenza append-only:
`episodes(content, trust_tier, connector, thread_key, kind, turn_id,
superseded_at, undone_at)` più FTS5 con trigger. `turn_id` esiste per una sola
domanda di recall («questo episodio è già davanti al modello?») e
`agent/loop/engine.ts:443` lo usa via `excludeTurnIds` per non far rileggere al
modello ciò che ha appena scritto come conferma indipendente di sé stesso.
`superseded_at` ritira senza cancellare; `undone_at` è distinto perché «non è più
l'ultima parola» e «l'effetto non è più sul disco» sono due cose diverse.

**Peer migliore.** Zep/Graphiti tiene gli episodi come nodi e non li cancella mai
(https://github.com/getzep/graphiti). Letta ha archival memory out-of-context
(https://docs.letta.com/memory). Hermes non tiene episodi strutturati: due file
Markdown più `session_search` FTS su SQLite
(https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).

**Verdetto: solido.** `turn_id` e `undone_at` non li ha nessuno, e risolvono due
guasti reali (auto-conferma, undo). Il piano evidenza è la parte del sistema che
regge il proprio peso.

---

## 2. Estrazione dei fatti e schema TKG

**Cosa fa Muffin.** `core/memory/schema.ts:117-160`: `facts` con `valid_from/
valid_to` (tempo del mondo) e `recorded_at/expired_at` (tempo di sistema),
`episode_id NOT NULL`, `speaker_id`, `trust_tier`, `confidence`, `origin
(said|inferred|imported)`, `importance 0-2`, `pinned`. Set-valued di default:
`functional_predicates` elenca le eccezioni. `valid_from` non si indovina mai.
Il prompt (`core/memory/extract.ts:135-198`) è disciplinato: regola 1
descrittiva-non-imperativa contro MINJA, regola 3 sul `validFrom`, regola 7
importanza a due sì/no invece di un voto 1-10, regola 5 sul predicato che porta
la relazione. `canonicalPredicate` (`extract.ts:545`) normalizza e non chiude
l'ontologia.

**Cosa dicono i numeri vivi.**
- **145 fatti su 528 episodi**, e i due predicati più frequenti sono `asked_to`
  (46) e `asks_to` (27): **73 su 145, il 50,3%, sono richieste.** Per progetto
  (`schema.ts:225-250`) una richiesta non è una credenza, non ha mai una
  fiducia, non riceve un vettore proprio e viene etichettata a render come non-
  istruzione. Quindi il grafo semantico vero è **~72 credenze in 528 episodi**.
- **un solo fatto ha `valid_from`.** Su 145. La bi-temporalità è nello schema e
  non nei dati: di fatto il sistema è mono-temporale (solo tempo di sistema),
  esattamente come mem0.
- gli ultimi dodici predicati includono `created_button`, `won`, `updated`,
  `knows` — cioè cronaca del turno, non stato del mondo.

**Peer migliore.** Graphiti estrae `valid_at/invalid_at` dal testo e invalida gli
edge in contraddizione mantenendo lo storico. mem0 fa ADD/UPDATE/DELETE/NOOP con
un LLM che confronta il fatto nuovo coi candidati recuperati
(https://docs.mem0.ai/core-concepts/memory-types) — e la `DELETE` è proprio il
failure mode che ADR-0032 rende non rappresentabile, con ragione.

**Verdetto: schema solido, resa slop.** Lo schema è migliore di quello di
chiunque nel confronto. La resa non è mai stata misurata, e i numeri vivi dicono
che metà del raccolto sono promemoria di richieste e che il campo bi-temporale
per cui esiste tutto l'apparato è vuoto al 99,3%. Nessuno ha misurato precisione
né copertura dell'estrazione: non esiste un solo numero nel repository che dica
quanti dei 145 fatti sono giusti.

---

## 3. Entità e identità

**Cosa fa Muffin.** `schema.ts:91-115`: `entities` e `identities` con
`link_status (unlinked|proposed|confirmed)` e `link_evidence`, «una persona vista
da due connettori sono due identità finché qualcuno non conferma».

**Cosa c'è nel database.** entities **4**, identities **0**.

**Cosa c'è nel codice.** `grep -rn identities --include=*.ts core/ agent/ cli/
connectors/` restituisce **zero scrittori**: le uniche occorrenze sono il DDL
(`schema.ts`), un check di invariante che legge `link_status`
(`invariants.ts:107`) e un commento in `connectors/shared/ingress/remember.ts:113`
che dice a chiare lettere che «la riga `identities` per questo mittente non
esisterà mai». Quindi `episodes.actor_id` e `facts.speaker_id` sono NULL per
costruzione, e `describeEpisodeSource` (`recall.ts:1053`) — scritto per non
confondere ruolo e fiducia — ripiega sempre su ruolo+tier.

**Peer migliore.** Graphiti fa entity resolution e dedup come parte del ciclo di
ingest, con summary delle entità che evolvono nel tempo.

**Verdetto: manca.** Non è "diverso per ragione": è uno schema dichiarato, un
invariante che lo controlla, un renderer che lo prevede, e nessun produttore. Il
person model — la cosa che distingue un agente personale da un RAG — non esiste
al HEAD.

---

## 4. Consolidamento e giudice

**Cosa fa Muffin.** `core/memory/consolidator.ts:1-190`. Debounce sul bordo di
coda a **20 s misurati sul corpus dell'owner** (1 793 messaggi consecutivi, l'1,0%
a meno di 20 s), soffitto a 12 episodi come rete, drain per il backlog, lock
durevole (`ingest-lock.ts`) perché due processi non estraggano due volte, log dei
run con esito e durata. Il ragionamento sul perché non è un `Job` né una corsia
dello `Scheduler` è corretto e specifico. Il giudice (`judge.ts:1-55`) mette il
campo `reasoning` **prima** del verdetto nello schema Zod (il fix documentato per
il collasso di Graphiti #1666), e nel dubbio **coesiste** invece di superseding.

**Il buco.** `memory_review` ha **146 righe contro 145 fatti** — circa una
escalation per fatto — ed è append-only per scelta esplicita (`schema.ts:166-172`,
`maintenance.ts:197`: «nessuna colonna di stato, non diventiamo un workflow
engine»). Nessun consumatore automatico: solo `muffin memory review` digitato a
mano (`store.ts:996`). Un giudice che nel dubbio rimanda a un umano che non
guarda mai è, in pratica, un giudice che non decide mai — e i 146 record sono la
misura di quanto spesso.

**Peer migliore.** Letta sleep-time agents girano a `turns % frequency` o alla
compattazione (https://docs.letta.com/guides/agents/sleep-time-agents); LangMem
distingue hot-path e background senza dire quando
(https://langchain-ai.github.io/langmem/concepts/conceptual_guide/). **Nessuno ha
tarato il proprio debounce su dati propri.**

**Verdetto: consolidamento solido — il migliore del confronto. Giudice: slop in
pratica**, non nel disegno: l'output esiste, è durevole, e non arriva a nessuno.

---

## 5. Chunk, embedding, recall

**Cosa fa Muffin.** Chunking strutturale con contesto portato
(`core/vault/chunk.ts:1-27`): heading → paragrafo → parole, e ogni chunk porta
`note/clienti.md › Acme › Riunione 12 marzo` davanti al testo. È la metà
deterministica del contextual retrieval, a costo zero di modello, e la scelta di
**non** fare chunking semantico è argomentata con evidenza (ADR-0024).
Embedding: Ollama `qwen3-embedding:0.6b` locale con fallback OpenAI-compatibile
che **rifiuta di partire se le dimensioni non coincidono** (`embed.ts:234`),
perché due modelli sono due spazi vettoriali. Recall (`recall.ts`): RRF k=60 su
FTS + vettori + hop sul grafo, `selectForExpansion` che dà all'importanza **un
posto e mai un posto migliore** (con il calcolo di quanto vale uno spostamento in
spazio RRF, 0,001242), `PINNED_BUDGET 12`, `MAX_CONTEXT_ITEMS 40`, rerank sulla
corsia leggera con `reordered: false` quando ha fallito, `strategies[]` perché un
recall degradato non sia mai silenzioso.

**Cosa manca.** `evals/memory/` sono **due file, 402 righe**: `acceptance.ts` è
**uno scenario** (Marco commercialista → Lucia, con asserzioni SQL su
`expired_at`/`superseded_by`, tre domande, processo separato per turno — è ben
costruito) e `corpus.ts` è un caricatore del vecchio database. **Non esiste
nessuna metrica di retrieval**: né recall@k, né nDCG, né un'ablazione che dica
cosa succede togliendo il reranker o i vettori. Il commento di `rerank.ts:8-18`
dice che il rerank «conta enormemente su un vault di anni di note»: nel database
vivo i documenti sono **6**.

**Peer migliore.** Graphiti offre RRF, MMR, cross-encoder e node-distance come
strategie selezionabili, con ricerca ibrida semantico+BM25+traversal. Anche
Graphiti però non pubblica numeri (verificato: nessun benchmark nella pagina).
mem0 e Letta pubblicano LoCoMo; ADR-0032 cita i numeri di Letta (74,0% con tool
di filesystem nudi contro 68,5% di mem0-graph), quindi **in questo repository si
sa leggere i benchmark altrui e non se ne produce nessuno proprio**.

**Verdetto: implementazione solida, valore non misurato — cioè, per il criterio
dato, slop.** È la definizione: complessità senza valore misurato. Non che sia
sbagliata; è che nessuno può dire se il RRF a tre gambe più il reranker batta un
FTS5 con `LIMIT 8` su questo corpus, e con 557 chunk la risposta onesta è che
potrebbe non batterlo.

---

## 6. Assenza, invarianti, provenienza, taint

**Assenza** (`absence.ts:1-45, 186-202`). Coda predittiva Lomax da posteriore
Gamma-Exponential: `P(T > gap) = (1 + gap/S)^(-n)`, la soglia è **p** (il tasso
di falsi allarmi accettato) e non un moltiplicatore, e la calibrazione è
simulata su entità vive (0,047 · 0,051 · 0,053 a n = 2, 5, 20 contro 0,154 ·
0,099 · 0,063 della regola ×3 del vecchio sistema). **È cablata in produzione**:
`core/scheduler/observe.ts:1,133` e `agent/observe-run.ts:60`.

**Invarianti** (`invariants.ts`). Check SQL puri, due severità, soglia di
vocabolario dei predicati tarata su dati (43 predicati su 329 edge nel vecchio
sistema, 26 usati una volta sola → soglia 80). Ma l'intestazione dice «cheap
enough to run nightly» e **l'unico chiamante è `cli/memory.ts:523`**: girano
quando l'owner li digita. Il difetto che intercettano è per definizione quello
che nessuno nota; se nessuno li lancia, non intercettano niente.

**Provenienza** (`provenance.ts:1-20`). Un solo renderer per `muffin memory why`
e per il tool `memory_why`, **non generativo**: legge righe, non racconta. «Un
agente a cui si chiede di spiegare la propria credenza produrrà una storia
fluente che esista o no; una foreign key no.»

**Taint** (`agent/loop/engine.ts:449-455`). `recallTaint` = massimo `trust_tier`
dei ricordi richiamati, e `snapshot.raiseTaint(inherited, 'la memoria
richiamata')` alza il tetto di autorità del turno: **un fatto piantato da uno
sconosciuto mesi fa vincola questo turno come se avesse appena parlato.**

**Peer migliore.** Nessuno. Hermes fa una scansione di pattern d'iniezione prima
di accettare una memoria — è un filtro, non una propagazione di autorità.
Graphiti, mem0, Letta, LangMem non hanno alcun concetto di fiducia della fonte.

**Verdetto: diverso per ragione, e solido.** È la parte da non toccare.
Eccezione: **invarianti = manca il cablaggio.**

---

## 7. Come la memoria entra nel prompt

**Cosa fa Muffin.** `agent/loop/engine.ts:436-480`: recall deterministico prima
che il modello veda qualsiasi cosa, `limit` di default **8**
(`recall.ts:490`), più fino a 12 fatti appuntati, reso da `renderForPrompt`
(`recall.ts:981`) dentro una recinzione con **nonce per render**
(`spotlight.ts:1-40`) e con la nota che il blocco è contesto a bassa autorità da
usare in silenzio. Righe di lacuna esplicite («su X non ho niente che valga per
il …; dillo, non rispondere con quello che vale oggi»), successore sulla stessa
riga della credenza ritirata, `dedotto — non detto` solo quando è l'eccezione.

**Il difetto.** La riga resa è una tripla: `[tu, 2026-09-03] owner — created —
video script`. Con metà della tabella fatta di `asked_to`/`asks_to`, il blocco
che il modello legge ogni turno è in larga parte un elenco di promemoria di
richieste già chiuse, in una notazione che ha buttato via la frase originale —
mentre gli episodi da cui vengono sono lì, interi, indicizzati e a portata di
recall. Nessuno ha misurato che la tripla batta la frase.

**Peer migliore.** Hermes carica due file Markdown in prosa una volta a inizio
sessione (snapshot congelato, per preservare la cache del prompt). Letta tiene
blocchi di memoria editabili in prosa dentro il context. Claude Code:
`MEMORY.md` come indice più un file per fatto, in prosa. **Il campo intero mette
prosa nel prompt; Muffin è l'unico che mette triple.**

**Verdetto: recinzione con nonce = diverso per ragione, e nessuno ce l'ha.
Rendering a triple = slop** — complessità (estrai, normalizza, canonicalizza) il
cui prodotto finale è peggio leggibile dell'input, senza una misura che dica il
contrario.

---

## 8. Tabelle e concetti dichiarati e vuoti

- **`profiles`** (`schema.ts:188`): 0 righe. `grep "INSERT INTO profiles"` →
  **nessuno scrittore in tutto il repository.**
- **`digests`** (`schema.ts:196`): 0 righe, **nessuno scrittore.**
- **`identities`**: 0 righe, **nessuno scrittore** (§3).
- **`functional_predicates`**: 4 righe = esattamente il seed di
  `DEFAULT_FUNCTIONAL_PREDICATES`. Mai cresciuto: nessun predicato è mai stato
  dichiarato funzionale in esercizio, quindi *tutto* è set-valued e i fatti si
  accumulano senza che niente sia mai davvero singolo.
- **`EXTRACTION_VERSION = 1`** (`schema.ts:315`), mai incrementato. La colonna
  `extraction_v` e l'invariante fondativa dello schema («butta il derivato,
  rigioca gli episodi, sei dove eri») **non sono mai state esercitate**. È
  esattamente il pattern che AGENTS.md chiama per nome: un meccanismo che esiste,
  ha i test, e non è sul percorso di produzione.
- **`MemoryProposal` di ADR-0051** (accettato 2026-08-21, «many producers, one
  semantic writer»): **non implementato.** I soli tool di memoria esposti sono
  `memory_search` e `memory_why` (`agent/tools/memory.ts:65,252`). L'emendamento
  di ADR-0032 — «Muffin deve poter gestire intenzionalmente la propria memoria» —
  è falso al HEAD.

**Peer migliore.** LangMem distingue *profiles* (documento singolo a schema
stretto) e *collections* e li implementa entrambi. Letta consolida i blocchi con
gli sleep-time agent e ha una modalità propose-only in arretramento (#3118).

**Verdetto: slop.** Non per come è scritto, per il rapporto: quattro tabelle e
un ADR accettato che descrivono un sistema che non gira. Ogni riga di DDL vuota
è una promessa che il prossimo lettore crederà.

---

## 9. Vault e documenti

**Cosa fa Muffin.** `core/vault/vault.ts` indicizza note e documenti come
episodi `kind: 'document'` (`vault.ts:453`), e `ingest.ts:327-335` **li salta
sempre in estrazione**: «un paper scaricato è pieno di affermazioni sicure, e
nessuna è una credenza sulla vita dell'owner». Chunking strutturale con contesto
portato (§5). Nel database: **6 documenti, 57 chunk da fatti, 500 da episodi.**

**Peer migliore.** mem0 e Graphiti estraggono fatti da qualunque cosa gli si dia
in pasto, documenti inclusi — cioè hanno il difetto che qui è chiuso per
costruzione.

**Verdetto: la regola è solida, il vault è vuoto.** Sei documenti non giustificano
il reranker, il chunking a tre livelli e l'indice vettoriale. La macchina è
dimensionata per un corpus che non c'è.

---

## Le 5 cose peggiori, in ordine

1. **Non esiste una sola misura di qualità del recupero.** `evals/memory/` è uno
   scenario e un caricatore. Ogni scelta — RRF a tre gambe, reranker, hop sul
   grafo, importanza con un posto solo, chunking strutturale — è argomentata
   benissimo e **non falsificabile**. Con 557 chunk è del tutto possibile che
   FTS5 con `LIMIT 8` faccia uguale, e nessuno lo saprebbe.
2. **Il grafo è quasi vuoto e metà di ciò che contiene non è conoscenza.**
   528 episodi → 145 fatti → 73 richieste → **~72 credenze**, 4 entità, 0
   identità, 1 solo `valid_from`. La bi-temporalità, l'ontologia e il person
   model esistono nello schema e non nei dati.
3. **Schema e ADR dichiarano un sistema più grande di quello che gira.**
   `profiles`, `digests`, `identities` senza scrittori; `functional_predicates`
   fermo al seed; `EXTRACTION_VERSION` mai incrementato (l'invariante di replay
   mai esercitata); ADR-0051 accettato e non implementato.
4. **I circuiti di chiusura sono aperti.** 146 righe di `memory_review` contro
   145 fatti, append-only, lette solo se l'owner digita il comando; invarianti
   che si dicono «nightly» e hanno un solo chiamante interattivo. Il giudice
   sbaglia nella direzione sicura e la direzione sicura non porta da nessuna
   parte.
5. **Il blocco nel prompt è la superficie più debole del sistema più forte.**
   Otto triple normalizzate al turno, in maggioranza promemoria di richieste,
   quando gli episodi originali in prosa sono lì. Tutto il campo mette prosa nel
   contesto; qui si mette notazione, senza una misura che la giustifichi.

## Le 3 cose che nessun peer ha

1. **La memoria come confine di autorità.** `recallTaint` → `raiseTaint` in
   `agent/loop/engine.ts:449`: ciò che il turno *ricorda* alza il tetto di ciò
   che il turno *può fare*. Graphiti, mem0, Letta, LangMem non hanno il concetto
   di fiducia della fonte; Hermes ha un filtro d'ingresso, non una propagazione.
2. **Due difese strutturali contro l'avvelenamento, non due prompt.**
   L'estrazione descrittiva-non-imperativa (una richiesta diventa il fatto *che
   qualcuno l'ha detta*, `extract.ts:139-145`) più la recinzione con **nonce per
   render** (`spotlight.ts`), che rende impossibile chiudere il recinto da dentro
   con testo scritto prima. Nessun peer ha nessuna delle due.
3. **Il rilevamento dell'assenza calibrato.** Coda Lomax con la soglia espressa
   come tasso di falsi allarmi, calibrata su entità reali, cablata in una corsia
   proattiva (`observe-run.ts`). Il resto del campo, quando ha un "silenzio", ha
   una costante.

Bonus, e conta: il **debounce a 20 s misurato sul proprio corpus** e
`memory_why` **non generativo**. Nessun peer misura la propria cadenza; nessun
peer sa dire *perché* crede una cosa senza raccontarlo.

## I prossimi 3 giorni, e come si misura che è migliorata

**Giorno 1 — il numero che non esiste.** Congelare un set d'oro dai 528 episodi
dell'owner: 50 domande la cui risposta l'owner conosce, ciascuna con l'id
dell'episodio o del fatto che la supporta. `evals/memory/corpus.ts` già legge il
vecchio database in sola lettura e scrive su un database separato: è
l'impalcatura, manca la chiave di risposta. Metrica: **recall@8 sul blocco reso**
— il supporto compare fra le otto righe che il modello vede davvero, sì o no —
misurata su quattro configurazioni: pipeline completa, senza reranker, senza
vettori, solo FTS5. *Criterio*: se togliere il reranker o i vettori non fa
scendere il numero in modo visibile, quel pezzo non si sta pagando e va spento,
non difeso.

**Giorno 2 — la resa dell'estrazione.** Etichettare a mano l'estrazione di 100
episodi: corretto / sbagliato / irrilevante, e la quota della famiglia
richiesta. Due numeri: **precisione dei fatti** e **credenze durevoli per
episodio** (escluse le richieste). *Criterio*: oggi la seconda è ~72/528 = 0,14.
Se una modifica al prompt o la separazione delle richieste in una tabella loro la
alza senza far scendere la precisione, è un miglioramento; altrimenti è rumore.
La domanda vera che questo numero decide: **le richieste devono stare in `facts`?**

**Giorno 3 — chiudere o cancellare.** Tre tagli, nessuno dei quali è nuovo
meccanismo: (a) invarianti dentro il consolidatore o dentro `doctor`, non solo
sotto le dita dell'owner; (b) `memory_review` su una superficie che l'owner vede
davvero, oppure il giudice smette di scrivere righe che nessuno leggerà; (c)
`profiles`, `digests` e `identities`: o si implementa il linking delle identità —
che sblocca `speaker_id`, che il renderer già si aspetta — o si cancellano dallo
schema. *Criterio*: `memory_review` aperte in calo turno su turno, o la tabella
non esiste più; `identities > 0` con almeno un `link_status = 'confirmed'`, o il
DDL sparisce.

Il criterio che governa tutti e tre: **dopo questi tre giorni deve esistere un
numero che può peggiorare.** Oggi non ce n'è nessuno, ed è per questo che la
domanda «stiamo facendo una memoria del cazzo?» non si può rispondere dall'interno
del repository.


---

# Critica indipendente — superfici e connettori (Telegram, Discord, CLI/REPL)

Fonte: `(fe8d55e) `. Peer: OpenClaw (docs.openclaw.ai), Hermes Agent (hermes-agent.nousresearch.com/docs/user-guide/messaging/), Bot API Telegram (core.telegram.org/bots/api). Sola lettura, nessun test eseguito.

## 1. Ingresso condiviso e parità

Muffin: pipeline unica `connectors/shared/ingress/{pair,ingest,lane,router,compose,remember,types}.ts`, e un test di parità che confronta stadio per stadio Telegram/Discord (`connectors/shared/ingress/parita.test.ts:290-360`, tabella `DIVERGENZE_AMMESSE`): ogni divergenza deve essere dichiarata a mano *e* verificata, non un buco silenzioso. Peer: nessuna delle due fonti pubbliche descrive un meccanismo equivalente esplicito di parità testata fra canali; Hermes/OpenClaw parlano di "channel plugins" senza un contratto di parità verificabile documentato.
**Verdetto: solido.** È l'unico pezzo dell'intero sistema di superfici che non è slop per costruzione: il disaccordo fra porte diventa rosso da solo.

## 2. Identità/owner/pairing e gruppi

Muffin: `identify()` (`core/surface/types.ts:287-318`) separa identità/autorità/tenant da un'unica funzione condivisa da ogni connector; `tierOf()` nega sistematicamente all'owner-in-gruppo il tier owner (`core/surface/types.ts:330-332`, `connectors/telegram/impersonation.test.ts:47-51`). Il gate «devo rispondere in gruppo?» (`apreUnTurno`, `connectors/telegram/connector.ts`, testato in `gate-di-gruppo.test.ts:1-40`) è arrivato solo il 04/09/2026, dopo che `docs/evidence/muffin-nei-gruppi-2026-09-04.md` ha misurato che *non esisteva* e che nel frattempo il gate su `sys.http` era "silenziosamente inerte per ogni turno di gruppo". Discord non ha gruppi affatto: `DISCORD_PLACES = ['direct']` (`connectors/discord/surface.ts:58`), `parseMessage` accetta solo DM. Peer: OpenClaw — *"ogni chat di gruppo riceve una sessione separata"* — e Hermes trattano gruppo/canale come caso di base su ogni piattaforma inclusa Discord.
**Verdetto: Telegram solido (con un buco di sicurezza recente e documentato su `sys.http` in gruppo); Discord manca** — non "diverso per ragione" quando i due peer citati lo fanno di base.

## 3. Comandi e coda, turno vivo

Muffin: `LaneRegistry`/`QueueNotices` condivisi (`connectors/shared/ingress/lane.ts:60-95`), ADR-0054 "una chat, un turno alla volta", `/stop` e `/steer` cablati su Telegram (`busy.test.ts`). Discord importa lo stesso registro (`connectors/discord/connector.ts:18`) ma dichiara `commands: false` nella sua porta (`connectors/discord/surface.ts:187`): nessun comando slash, nessun `/stop`/`/steer` testuale. CLI: `/stop` via Ctrl+C funziona; `/steer` è esplicitamente disattivato — `steer: () => false` (`cli/repl.ts:721`) — perché la textzone possiede il terminale in modalità raw e non legge input mentre un turno gira (`cli/repl.ts:706-712`).
**Verdetto: Telegram solido; Discord manca (coda/lane condivisi ma comandi mai esposti); CLI diverso per ragione** (vincolo I/O reale, documentato, non un buco).

## 4. Streaming, passi, segni di vita, negoziazione per stanza

Muffin: `Negotiation` per `(porta, stanza)` con numeri reali della Bot API — un edit/secondo per chat, venti/minuto per gruppo, bozza 30s solo in DM (`connectors/telegram/negoziazione.ts:1-94`); lo streaming vive dentro il messaggio vero, non in una preview effimera (`connectors/telegram/presence.ts:1-30`, dopo il fallimento in produzione del 04/09 documentato lì). Discord dichiara onestamente `streaming: {transport: 'off'}` (`connectors/discord/surface.ts:88-92`) e ha solo un typing-indicator rinnovato (`connectors/discord/presence.ts`). Peer: Hermes — *"supporta aggiornamenti progressivi dei messaggi tramite editing"* — genericamente sulle piattaforme che lo consentono, e Discord **supporta** l'edit di un messaggio proprio (API nativa), quindi il vincolo non è della piattaforma.
**Verdetto: Telegram solido; Discord manca** — dichiarato onestamente (non è teatro), ma la ragione data in codice ("B17, esplicitamente fuori scope") è una decisione di sequenza, non un limite tecnico, e Discord lo supporterebbe.

## 5. Consegna durevole e retry

Muffin: `TelegramDeliveryStore`, write-ahead per parte di messaggio, recupero `attempting → possibly_sent` a un riavvio a metà invio (`connectors/telegram/delivery.ts:1-90`). Discord: `deliver()` fa `sendMessage` con `try/catch` diretto, nessuno store, nessun piano persistito (`connectors/discord/surface.ts:106-121`). Peer: Hermes — *"le risposte finali dell'agente sono registrate in un registro consegna durevole attorno a ogni invio della piattaforma"*, con recupero e prefisso "♻️ Recovered reply" — esplicitamente generico per piattaforma, non solo per un canale.
**Verdetto: Telegram solido; Discord manca**, ed è lo stesso genere di difetto che Telegram ha già pagato in produzione (evidence 04/09) e risolto — non riportato sull'altro connettore.

## 6. Approvazioni

Muffin: `core/approvals/store.ts` — chiave capability+risorsa, `consumed_at` una tantum, finestra 6h (`core/approvals/store.ts:1-60`) — design solido e generico. Wiring: Telegram ha bottoni (`cli/surface.ts`, `approvatoreTelegram`), CLI ha `[s/N]` su readline (`cli/repl.ts:657-683`). Discord: zero — nessuna occorrenza di "approv" in `connectors/discord/connector.ts`. Peer: Hermes usa "clarify questions" con pulsanti nativi multi-piattaforma.
**Verdetto: lo store è solido; il wiring Discord manca del tutto** — ogni capability che chiede conferma (es. `sys.shell`) è semplicemente inutilizzabile da un owner che scrive solo su Discord: scade in silenzio dopo 6 ore.

## 7. Media, documenti, voce

Muffin: la pipeline condivisa `ingest.ts` trasforma un allegato Telegram in `ImageBlock`/`AudioBlock` che il modello vede/ascolta davvero (`connectors/shared/ingress/ingest.ts:1-50`, usato da `connectors/telegram/connector.ts:23`). Discord scarica l'allegato nel vault (`connectors/discord/media.ts`, riuso corretto di `safeVaultName`) ma non chiama mai `ingestAttachment`: il turno riceve solo la riga di testo `[allegato ricevuto]` (`connectors/discord/connector.ts:755-770`) — nessuna vision, nessuna trascrizione vocale, e nessun tipo "voice" è mai distinto da un documento qualsiasi. Peer: Hermes dichiara esplicitamente *"funzionalità vocali complete — inclusi... risposte vocali in messaggistica e conversazioni canale vocale Discord"*.
**Verdetto: Telegram solido; Discord manca**, ed è una regressione rispetto al proprio altro connettore, non solo rispetto al peer.

## 8. CLI/REPL

Approvazioni sincrone via readline, `/stop` via Ctrl+C, streaming su stdout quando TTY con fallback dichiarato (`cli/repl.ts:512-526`) — coerente con la capability model di `core/surface/types.ts`. L'assenza di `/steer` a turno vivo è un vincolo architetturale reale (I/O a possesso esclusivo del terminale), documentato nel codice, non uno scarto.
**Verdetto: solido**, con un limite dichiarato e giustificato.

## 9. Discord

DM-only per una scelta di scope scritta nei commenti (`connectors/discord/surface.ts:170-181`: *"ogni capability inbound-only è dichiarata com'è oggi... slice 15 la lascerà diversa"*), non un incidente: `commands: false`, `buttons: false`, `edit: false`. Riusa correttamente la parte "meccanica" condivisa (lane, pair, safeVaultName) ma non collega nessuna delle parti "owner-facing" che rendono un connettore usabile per qualcosa di più di una chat testuale a bassa fiducia: niente gruppi, niente comandi, niente approvazioni, niente streaming, niente vision/voce, niente consegna durevole. Cinque righe su dieci di questa tabella sono "manca" solo per Discord.
**Verdetto: slop per accumulo** — non nel senso di codice scritto male (il codice che c'è è pulito e ben documentato), ma nel senso che il gap dichiarato "per oggi" (ADR/commenti citano "slice 15", "slice 16") non si è chiuso mentre la superficie Telegram ha continuato a crescere, e i 2700 righe restano quasi tutte transport/gateway websocket, non capability.

## 10. Quanto costa aggiungere un connettore oggi

La pipeline condivisa (`pair`/`ingest`/`lane`/`router`/`compose`/`remember`, contratto `Surface`+`IngressPort` in `core/surface/types.ts` e `connectors/shared/ingress/types.ts:246-275`) abbassa davvero il pavimento per un connettore *DM-only, a bassa fiducia*: Discord lo dimostra, ~2700 righe di cui la maggior parte (`gateway.ts`, 420 righe) è gestione websocket specifica della piattaforma, non logica di dominio. Ma quel pavimento non è la parità: raggiungere quanto Telegram fa oggi (gruppi, approvazioni, streaming-edit, consegna durevole, voce) richiede reintrodurre, per ogni nuova porta, capability che oggi vivono solo dentro `connectors/telegram/*` e non sono state fattorizzate una seconda volta (a differenza di `pair`/`ingest`, che *sono* state fattorizzate proprio perché Discord esisteva già come secondo caso). La promessa di ADR-0021 ("aggiungere una surface è dichiarare capability e credenziali") vale per l'instradamento, non per la parità di capacità — e oggi non c'è prova che valga per la seconda.

## Le 5 cose peggiori, in ordine

1. Discord non fa mai vedere o ascoltare un allegato al modello (niente vision, niente voice-to-text) — `connectors/discord/connector.ts:755-770` non chiama mai `ingestAttachment` — regressione rispetto al proprio altro connettore e rispetto a Hermes (voce anche su canali vocali Discord); 3gg: collegare `ingest.ts` già condiviso, misura = un test come `voice-arrival.test.ts`/`document-arrival.test.ts` ma per Discord che asserisce un `AudioBlock`/`ImageBlock` non vuoto nel `TurnInput`.
2. Nessuna consegna durevole su Discord (`connectors/discord/surface.ts:106-121`, nessuno store) — lo stesso difetto che Telegram ha già pagato in produzione il 04/09 e risolto con `TelegramDeliveryStore`; 3gg: generalizzare lo store esistente (già quasi porta-agnostico) e wirarlo su Discord, misura = kill -9 a metà invio + riavvio → il messaggio arriva esattamente una volta.
3. Nessuna approvazione possibile da Discord — `sys.shell` e ogni capability a rischio restano bloccate 6h e poi si negano da sole per chi scrive solo lì, mentre `core/approvals/store.ts` è già generico; 3gg: bottoni Discord sullo stesso `ApprovalDecide`/`Get` di Telegram, misura = test equivalente ad `approvazione.test.ts` che preme un bottone e il turno sospeso riprende.
4. Gruppi assenti su Discord per scelta di scope non rivalutata mentre entrambi i peer citati li trattano come caso base — `connectors/discord/surface.ts:58`; misura prima di costruire: contare nel handoff/log quante richieste reali dell'owner hanno voluto Discord in gruppo; se >0, il costo concreto è basso (gate di gruppo e `identify()` già scritti per Telegram, riusabili).
5. Streaming dichiarato `'off'` su Discord per una ragione di sequenza vecchia ("B17, fuori scope"), non tecnica — Discord supporta nativamente l'edit di un messaggio come Telegram; 3gg: misura falsificabile = provare in locale un edit ripetuto su un messaggio Discord reale contro il rate limit reale della piattaforma; se regge, è una `Negotiation` Discord di poche righe sul modello già scritto per Telegram, non un redesign.
