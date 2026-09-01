# La consulenza Gemini contro il nostro codice, tema per tema

**Data**: 2026-08-14 · **Fonte**: conversazione condivisa
`share.gemini.google/XhaLDrwb6a07` → `gemini.google.com/share/e7f97c26d183`
("ML Engineer vs. AI Engineer: Ruoli", **3.6 Flash**, 14 ago 2026, nove turni
owner) · **Metodo**: la chat letta per intero, poi ogni sua affermazione
confrontata con il codice a `file:riga` e con la decisione scritta che la
riguarda. Dove non esiste né codice né decisione, sta scritto.

Ogni sezione ha la stessa forma: **Adesso** (cosa c'è, verificato) · **Poi**
(cosa è già deciso o in roadmap) · **Gemini** (cosa diceva) · **Verdetto**.

---

## Il verdetto in tre righe, prima di tutto

1. **Gemini non sposta la lista di lavoro.** Delle ~25 raccomandazioni, **14
   descrivono cose che abbiamo già costruito** (spesso in forma più severa),
   **5 sono già state decise contro con evidenza scritta**, **2 sono
   attivamente sbagliate per la nostra forma**, e **4 sono buchi veri**. Nessuno
   dei quattro è più urgente dei due che già conosciamo (il consolidamento che
   non parte, il processo che non vive).
2. **I quattro buchi veri sono piccoli e concreti**: il fetch che non pulisce
   l'HTML, la navigazione della storia per data/surface, il budget per-job, e
   la compattazione per riassunto. Tre su quattro sono già nella nostra
   `inventario-vecchio-nuovo.md §8` — Gemini li ha ritrovati indipendentemente,
   il che è di per sé un dato: sono i buchi che si vedono da fuori.
3. **Il contributo migliore non è una feature, è una riformulazione**: "voce e
   mani" applicato alla chat (§2). È la stessa cosa di ADR-0035 detta dal lato
   dell'esperienza invece che dal lato del runtime, e sarebbe il modo giusto di
   scriverne il criterio di uscita.

**E il limite della fonte, detto una volta.** È una consulenza generica di un
modello veloce che non ha visto una riga del nostro codice, con citazioni web di
qualità disomogenea (accanto ad arXiv e Martin Fowler ci sono Medium, "Kilo
Code", "BOVO Digital", "OpenHosst"). Il valore non è l'autorità: è che una
descrizione esterna del problema, fatta a freddo, funziona da **lista di
controllo indipendente**. Va letta così — e infatti dove abbiamo numeri e lei
non ne ha, vincono i numeri.

---

## 1. Il loop, e "gli agenti continui"

**Adesso.** Un loop solo, cappato, senza planner: `agent/loop.ts:321`
(`while iterations < cap`), il cap dal profilo per-modello
(`agent/profiles/profile.ts`, 15 chiamate su consumer-local, 30 su frontier).
Nessuna classificazione d'intento, nessun router per-prompt. Pre-loop
deterministico: snapshot permessi, taint, recall, classe di tenant — tutto
risolto **prima** che il modello generi (`loop.ts:236-296`).

**Poi.** Niente. ADR-0009 e `research/confronto-harness.md §2.1` hanno
verificato che Hermes (`while api_call_count < max_iterations`), OpenHands
(`while True → step()`, max 500) e Letta v3 (che ha **tolto** l'heartbeat
dichiarato dal modello) hanno tutti la stessa forma, e che Letta si è mossa
*verso* di noi. L'unico gap dichiarato è il tool `todo` — un tool, non un
planner.

**Gemini.** Che il ReAct non sia "pensiero" ma **test-time compute spalmato su
token**, e che regga perché sfrutta la geometria dei Transformer, non perché
imiti la mente. Che i sistemi continui alla Hermes aggiungano quattro cose:
memoria cross-sessione, **skill create autonomamente**, esecuzione always-on,
sub-agenti.

**Verdetto: la diagnosi è giusta e già nostra; una delle quattro colonne è un
consiglio che i nostri numeri respingono.** La spiegazione del ReAct come
scratchpad è corretta ed è il modo migliore per dire perché non serve un
planner. Ma "l'agente compila le strategie efficaci in skill riutilizzabili"
è venduto come virtù senza il dato: nel **vecchio Muffin** lo skill layer era
**3.052 righe → 3 candidati → 1 uso** in quattro mesi
(`inventario-vecchio-nuovo.md §4`), e in **Hermes** fra "skill scritta" ed
"eseguita" di default **non c'è niente** — 751 skill malevole sul registry
(1,3%), scan auto-esentabile via `.skillignore`
(`confronto-harness.md §4`). ADR-0014 mette il RoT prima dell'auto-modifica
eval-gated, ed è confermato. **Nessuna azione.**

---

## 2. Il processo che vive, e "voce e mani"

**Adesso.** Lo scheduler è un `setInterval(() => scheduler.tick(), 30_000)`
dentro `cli/repl.ts:123`. Chiudi il terminale e non gira più niente. La
consegna remota di un job schedulato non esiste: `cli/repl.ts:115` stampa
`[job → telegram: consegna remota da cablare]` sullo stderr del REPL. Il turno
è **sincrono**: il connector Telegram attende `runTurn` fino in fondo. L'unica
cosa che esiste dal lato esperienza è il **keepalive di presenza**
(`connectors/telegram/presence.ts`): draft rinnovato ogni 22s in privato,
`sendChatAction` ogni 4s, placeholder-poi-edit nei gruppi.

**Poi.** **ADR-0035** (2026-08-11): un processo locale di lunga vita, socket
unix, kernel unico punto di decisione, principal per ogni turno autonomo,
nessuna elevazione, visibile e ammazzabile. Con `heartbeat`, `queue`, `steer`,
`undo` come i verbi che ne conseguono.

**Gemini.** Due cose. (a) L'agente continuo *"non vive solo nel terminale
mentre lo guardi"* — distribuito, in ascolto via scheduler o gateway di
messaggistica, può lavorare in background e avvisarti quando ha finito. (b) E
la riformulazione che vale: **"voce e mani" vale anche in chat.** Se chiedi
"analizzami questi 5 PDF", l'approccio sbagliato è tenere "sta scrivendo…" per
45 secondi; quello giusto è *Voce* (<500ms: "ricevuto, ci lavoro, ti aggiorno
qui") + *Mani* (worker asincrono) + update sul messaggio originale.

**Verdetto: ADOTTA la riformulazione, come criterio d'uscita di ADR-0035.**
ADR-0035 argomenta dal lato del runtime — undicesima istanza di "dichiarato e
non connesso", 31 verbi Hermes su 95 che presuppongono un processo. È
corretto e non basta: un ADR che si giustifica con un conteggio di verbi non
dice all'owner **cosa cambia mentre lo usa**. "Voce e mani" lo dice in una
riga, ed è verificabile: *un turno lungo restituisce entro 500ms e consegna
dopo, senza che nessuno resti a guardare i puntini*.

Con due precisazioni che Gemini non fa e che sono nostre:
- il keepalive di presenza è la **metà cosmetica**; ce l'abbiamo dal primo
  giorno perché il vecchio l'aveva tolto e rimesso due settimane dopo. La metà
  strutturale (accetta, torna, consegna dopo) non esiste e **non è
  costruibile senza il processo di ADR-0035** — un worker asincrono dentro un
  REPL muore col REPL. Quindi è una conseguenza, non un lavoro parallelo;
- l'ACK immediato ha un costo che Gemini ignora: **raddoppia i messaggi**.
  Nei gruppi il nostro `presence.ts` già risolve con placeholder-poi-edit (un
  messaggio, non due) — quella è la forma giusta anche per l'ACK, ed è già
  scritta.

---

## 3. Contesto: assemblaggio, cache, compattazione

**Adesso.** Tre pezzi distinti.
- **Assemblaggio**: `agent/context/assemble.ts:125` produce **due prompt**,
  `owner` e `group`, costruiti una volta a boot, ciascuno prefisso cacheabile
  proprio. Ordine: persona → identity (solo owner, dal RoT) → voce → skill →
  regole operative. Il prompt owner è pinnato a sha256 in test.
- **Cache**: `ChatCall.system` è un array di blocchi con `cache: 'stable'`
  posizionale (`agent/providers/types.ts:20`), tetto di 4 breakpoint
  documentato nel tipo. `loop.ts:346` marca il system come stable.
- **Compattazione**: `agent/context/compact.ts:58` **svuota i payload dei
  vecchi tool result** tenendo il `tool_use` e sostituendo il corpo con un
  segnaposto che nomina il tool. Budget 60.000 caratteri (`loop.ts:56`), gli
  errori mai svuotati, i risultati marcati `keepResult` (il recall) mai
  svuotati.
- **Storia**: troncamento secco a **40 turni** (`loop.ts:62`), con una riga
  che annuncia il taglio.

**Poi.** `04-roadmap.md §M5-bis` non nomina la compattazione. La nomina
`inventario-vecchio-nuovo.md §6`: il vecchio faceva **sintesi narrativa oltre
60 messaggi + keep-last-25**; il nuovo tronca. La tabella `digests` esiste
(`core/memory/schema.ts:138`) e — verificato ora — **non ha né scrittori né
lettori** (`grep "INSERT INTO digests"` → zero). Undicesima… no, ennesima
istanza.

**Gemini.** Un *Context Compactor*: oltre soglia (es. 15.000 token) i primi N
messaggi vanno a un modello piccolo che produce un "Summary di Stato" (cosa
fatto, cosa deciso, quali file toccati) e sostituisce i vecchi. E, sul contesto
annuale: tre livelli — active window (20-30 messaggi), episodic summaries,
historical storage — più il *Canonical Event Store* unificato per surface.

**Verdetto: metà già fatto e meglio, metà buco vero.**

Dove siamo avanti: lo svuotamento dei tool result è **la cosa più economica
misurata** in quello spazio (−48% di picco contesto, stesso comportamento) e
Gemini non la nomina affatto — propone direttamente la sintesi, che costa una
chiamata al modello e perde informazione. Il nostro ordine è quello giusto:
prima svuoti ciò che il modello può richiamare, poi semmai riassumi.

Il *Canonical Event Store* ce l'abbiamo già ed è più forte: `episodes` porta
`tenant_id`, `connector`, `thread_key`, `role`, `kind` e **`trust_tier`**
(`core/memory/schema.ts:27`). La versione di Gemini non ha il tier — e senza
tier un event store unificato è precisamente il posto dove un messaggio di
gruppo diventa indistinguibile da uno tuo.

Dove ha ragione: **il troncamento a 40 turni è la scelta peggiore delle tre**
(troncare / svuotare / riassumere) e l'abbiamo fatta sulla storia parlata, che
è l'unica parte non recuperabile da un tool. La cura non è il compattatore
generico di Gemini: è **scrivere `digests`** — la tabella esiste, il piano
derivato è per costruzione ricostruibile (`02-ontologia.md §2.3`), e la
sintesi va sulla corsia leggera come tutto il resto. Costo basso, e chiude una
riga della famiglia "dichiarato e non connesso".

---

## 4. Memoria: modello dati e provenienza

**Adesso.** Tre piani (`02-ontologia.md`, `core/memory/schema.ts`): evidenza
(`episodes`, append-only, mai UPDATE mai DELETE) → grafo (`entities`,
`identities`, `facts` bi-temporali a 4 timestamp) → derivato (`profiles`,
`digests` — entrambi **vuoti e senza lettori**). Ogni fatto porta
`episode_id`, `trust_tier` ereditato e mai crescente, `confidence`,
`origin` (`said`/`inferred`/`imported`), `importance` ordinale 0/1/2,
`extraction_v`. Il ritiro è `superseded_by` + chiusura bi-temporale, mai
cancellazione. Cardinalità **set-valued di default** (la lezione delle 89
credenze corrotte da un vincolo singleton).

**Poi.** ADR-0032 **emendato dall'owner** (2026-08-11): ibrido — il modello
può scrivere attraverso un tool, come riga con la sua provenienza, e la
pipeline in background deve esserne consapevole (riconciliazione via
`extraction_v` + giudice di contraddizione). Non ancora costruito.

**Gemini.** *"Asynchronous Memory & Preference Extractor"*: a fine
interazione, un worker asincrono estrae regole e preferenze implicite
("l'utente rifiuta i meeting il venerdì pomeriggio") e le salva su un DB
vettoriale; alla sessione successiva l'harness inietta solo i vincoli
rilevanti.

**Verdetto: è la nostra pipeline, descritta senza le tre cose che la rendono
sicura.** L'architettura di massima coincide (asincrona, fuori dal path di
risposta, iniezione selettiva a monte) — ed è una conferma non banale, perché
è il fork su cui ADR-0032 si è giocato tutto. Ma la versione di Gemini non ha:
1. **la provenienza.** Nella sua descrizione "l'utente rifiuta i meeting il
   venerdì" è un fatto, punto. Nel nostro modello è un fatto con `origin`,
   `trust_tier` ed `episode_id`, e la differenza si vede nel comportamento:
   `core/memory/recall.ts:284` marca solo l'`inferred` (*"dedotto — non
   detto"*), e la persona è obbligata a portarlo come ipotesi. Hermes ha un
   profilo utente di 1.375 caratteri **interamente dedotto e asserito come
   detto** — è esattamente il guasto che `origin` esiste per impedire;
2. **il tempo.** Nessuna nozione di `valid_from`/`valid_to`. "Chi era il mio
   commercialista a maggio" non è rispondibile in quel modello;
3. **la contraddizione.** Nessun giudice. È la forma Mem0, ed è dove
   Memory-R1 misura il guasto (`DELETE spurio su non-contraddizione`, F1
   41→34,5) che ADR-0006 rende **non rappresentabile**.

**Nessuna azione**, e vale come conferma esterna del disegno.

---

## 5. RAG / recall

**Adesso.** `core/memory/recall.ts:160`. Ibrido per costruzione: FTS5 (parola
esatta) + vettoriale (parafrasi), fusi con **RRF k=60** (`:81`), più **un hop**
di espansione sul grafo (i fatti attivi dell'entità nominata, 6 slot,
`:84`), più reranking LLM sulla corsia leggera quando i candidati sono
abbastanza (`core/memory/rerank.ts`). Ogni item torna **etichettato** con
tier, provenienza e origine; il blocco entra nel prompt dentro uno
spotlight fence (`recall.ts:291`) come contesto a bassa autorità, e il turno
**eredita il taint massimo di ciò che ha ripescato** (`loop.ts:269`).

`importance` **non entra in RRF** e la ragione è aritmetica: a k=60 il gap fra
ranghi adiacenti è 0,000264 e il consenso fra due ranker vale 0,016393 — 62×.
Agisce invece sulla **membership** dell'espansione, un solo slot protetto
(`recall.ts:91`).

**Poi.** Manca il golden set della suite memoria (`05-testing-evals.md §3.1`).
Mancano `decay` e `context specificity` (`knowledge/01-understanding.md`).

**Gemini.** *"Ricerca Ibrida che unisce FTS per parole chiave esatte e Search
Vettoriale per concetti semantici"*, su un canonical event store. E, per i
documenti, `ripgrep` come terza via *"per fare query sul testo dei Markdown
senza dover passare sempre dai vettori"*.

**Verdetto: coincide, e noi abbiamo tre pezzi in più (fusione, grafo,
etichette).** Nessuna azione sul recall.

L'unica idea nuova è **ripgrep sul vault**, e va valutata onestamente: il
nostro vault è già indicizzato con chunking strutturale heading-first
(ADR-0024) e `muffin vault check` confronta disco e indice. Un grep sarebbe un
**secondo percorso di verità** su dati che ne hanno già uno — la classe di bug
che `vault check` esiste per intercettare. Se un giorno serve, la forma giusta
è un ramo di `memory_search`, non un tool nuovo. **RESPINGI come tool
separato.**

---

## 6. Il consolidamento — la corsia che non parte

**Adesso.** `core/memory/ingest.ts:52` (`ingestPending`) ha **un solo chiamante
di produzione**: `cli/memory.ts:171`, cioè `muffin memory extract`, a mano.
(L'altro è `evals/memory/corpus.ts:151`.) Conseguenza misurata: **414 fatti
nel vecchio contro 0 nel nuovo**, 4.107 episodi contro 6. `importance`,
`origin`, `absence.ts` e l'espansione del grafo sono **inerti**.

**Poi.** È la **priorità 1** dichiarata in `04-roadmap.md §M5-bis` e in
`STATE.md`, e servono **due meccanismi**, non uno: la corsia per-turno
asincrona (episodio → coda → estrazione, latenza di minuti — la forma del
vecchio, `src/gateway.ts:2732` → `thinker.ts:581` → `memory_learning.ts:625`)
**e** la manutenzione periodica (dedup, decay, pattern). Un solo job notturno
darebbe un Muffin che ti conosce con 24 ore di ritardo.

**Gemini.** *"Quando l'interazione principale termina, l'Harness passa il
transcript a un job asincrono in background."*

**Verdetto: dice esattamente la cosa che non abbiamo fatto, ed è l'unica
raccomandazione della chat che coincide con la nostra priorità 1.** Vale la
pena registrarlo: un modello che non ha visto il codice, guardando l'architettura
di un assistente personale, mette la corsia asincrona di estrazione fra i
**cinque componenti fondamentali**. Noi l'abbiamo costruita e non l'abbiamo
attaccata a niente.

Nota: Gemini dice "quando l'interazione termina", noi diciamo "a ogni turno,
in asincrono". La differenza conta in chat — una conversazione non "termina",
e legare l'estrazione a un evento che non esiste è il modo per non farla
partire mai. **La nostra formulazione resta.**

---

## 7. Navigare la storia, per data e per surface

**Adesso.** `memory_search` (`agent/tools/memory.ts:33`) prende **una query e
basta**. Nessun filtro per data, nessun filtro per surface, nessuna espansione
di vicinato. Il recall torna item sparsi senza il loro intorno. La CLI ha
`muffin memory search|why`, stessi limiti. Le sessioni sono `.jsonl` per
sessione (`core/session/store.ts`) e **non sono interrogabili** da nessun tool.

**Poi.** Non è in roadmap. `inventario-vecchio-nuovo.md §8` punto 10 nomina
una cosa adiacente (gli span non portano il contenuto del prompt), non questa.

**Gemini.** Due primitive nominate:
- `search_chat_history(query, surface, date_range)`
- `get_thread_context(message_id, window=5)` — *"quando la ricerca trova un
  messaggio rilevante di 6 mesi fa, questo tool permette di leggere i 5
  messaggi prima e i 5 dopo per ricostruire il contesto esatto"*.

**Verdetto: BUCO VERO, ed è il contributo più concreto di tutta la chat.**
Il caso d'uso dell'owner è letterale — *"importante possa navigare i messaggi
anche tra più surface, per trovare i messaggi specifici"* — e oggi non è
servito. Il costo è quasi zero: `episodes` ha già `connector`, `thread_key`,
`created_at`, `tenant_id`; sono due predicati SQL in più su una query che
esiste, e una `WHERE id BETWEEN` per il vicinato.

E c'è una ragione **strutturale** oltre alla comodità: senza vicinato, un
episodio ripescato è una frase senza il suo intorno, e la cosa più facile che
un modello ci faccia sopra è **inventare il contesto mancante**. Il fence dice
"usalo se pertinente"; non dice "questa frase è tagliata".

Due cautele che Gemini non pone e che sono obbligatorie da noi:
- il filtro per surface **non deve poter attraversare il tenant**: la firma è
  `(tenant del turno, surface, range)`, e il tenant non è mai un argomento —
  stessa regola che `searchMemory` già rispetta dopo il leak che aveva il
  tenant cablato;
- il vicinato **eredita il taint massimo della finestra**, non quello
  dell'item trovato. Cinque messaggi prima e cinque dopo, in un gruppo, sono
  cinque occasioni in più per un'iniezione di entrare al tier di chi l'ha
  cercata.

---

## 8. Tool: quali, quanti, e il problema dei troppi

**Adesso.** **Dieci**: `fs_read`, `fs_list`, `fs_write`, `memory_search`,
`shell_run`, `process_list`, `process_kill`, `skill_read`, `http_get`,
`web_search` — più gli `mcp_*` dinamici. La selezione è
`visibleTools(...).slice(0, profile.maxToolsExposed)` (`loop.ts:290`): prima
si filtra per principal (un membro non vede gli `hostOnly`), poi si taglia in
**ordine di registrazione**. Il kernel resta l'enforcement: un membro che
nomina `fs_read` incontra `principal_forbidden`, non "non esiste".

**Poi.** `confronto-harness.md §9` punto 6: la **selezione** per principal e
per turno viene prima di qualunque search — l'ordine di registrazione è
arbitrario e i tool MCP si attaccano ultimi, quindi su un profilo con tetto 10
cadrebbero fuori per primi, **in silenzio**. Il trigger per una tool-search è
"il primo server MCP con >100 tool", non un conteggio nostro. Mancano `todo` e
`clarify` (§9 punto 5).

**Gemini.** (a) Il toolkit di base di un assistente: workspace fs · code
interpreter sandboxed · memory · scheduler · web search & fetch · messaging
push. (b) Sul bloat: *"il naive Find Tool in produzione è fragile e fallisce
spesso"* — overlap semantico, allucinazione dei parametri, +2-3s di latenza.
Tre rimedi: **core tools always-on (5-7) + skill modules caricati a blocchi**
(`load_skill("google_workspace")`), **code-as-action** (un
`execute_python` al posto di 30 micro-tool), **classifier routing** (un SLM
che attiva la maschera di tool pertinente).

**Verdetto: la diagnosi è corretta e converge con la nostra ricerca; il terzo
rimedio è quello che questo progetto ha già bocciato due volte.**

Sul "find tool ingenuo non funziona" siamo d'accordo con numeri:
`research/capability-surface.md` ha verificato che **nessuno dei tre peer usa
embedding per i tool** — OpenClaw usa BM25 lessicale, opt-in e non di default,
con la citazione *"Direct tool exposure is still the right default for small
catalogs"*. A dieci tool il problema non esiste. **Nessuna azione.**

Il **classifier routing** è la parte da respingere, e non per gusto: nel
vecchio Muffin un classificatore d'intento è stato **retrocesso a monitor-only
due volte**, e il classificatore deittico euristico è stato **rimosso**
(ADR-153) perché bloccava l'11% di ricerche legittime
(`knowledge/README.md §Cimitero`). Un router che *toglie* tool sbaglia in
silenzio: il modello non dice "mi manca un tool", risponde peggio. Se un
giorno servirà una selezione, la scala scritta è **ordine → priorità →
rilevanza → search**, e le prime due non sono classificatori.

Il **messaging push come tool del modello** è l'unica riga della lista di
Gemini che è pericolosa da noi: `outward.*` è escluso dai principal autonomi
per policy (`defaults/rot/policy.json`) e `muffin telegram send` è
deliberatamente **un comando dell'owner, non un tool del modello**. Hermes ha
fatto il percorso opposto e poi ha tolto `send_message` dal loop con una PR da
8 file — *"outbound messaging stays outside the agent loop"*. Ci siamo già.

Restano **`todo` e `clarify`**, che Gemini non nomina e che invece mancano
davvero: sono già nella lista di `confronto-harness.md §9`.

---

## 9. Code-as-action, shell, sandbox

**Adesso.** `shell_run` (`agent/tools/shell.ts:42`) è l'**unico tool comando**,
e gira dentro `@anthropic-ai/sandbox-runtime` pinnato esatto
(`core/sandbox/executor.ts`): doppio layer fs+rete, mandatory deny paths sul
RoT e sui secret, env del figlio ricostruito (la chiave API non entra nel
sandbox), **overhead misurato ~16ms/comando** su Seatbelt. Se il probe non
prova un contenimento reale, **il tool non viene registrato affatto**
(`agent/runtime.ts:192`) — mai un run unsandboxed silenzioso. In single-user
`sys.shell` è **sempre ASK**.

**Poi.** ADR-0027: Muffin **non è un coding agent**. Sul codice fa tre cose:
legge, esegue script contenuti, e (differito, ADR-0015 livello b) orchestra un
harness esterno. La capability `dev` è stata **costruita e poi rimossa**.

**Gemini.** *"Niente Bash nativo sull'Host"* — dai un Python interpreter
sandboxed (Docker/E2B), l'agente scrive lo script e legge stdout/stderr. E
come rimedio al tool bloat: *"il modo migliore per gestire troppi tool è non
creare i tool"* — `execute_python(script)` al posto di 30, riduzione della
latenza dell'80%.

**Verdetto: l'avvertimento è giusto e siamo già oltre; il code-as-action come
spazio d'azione primario è già deciso contro, con la ragione scritta.**

Sull'avvertimento: abbiamo il contenimento **e** l'abbiamo misurato, e abbiamo
la proprietà che Gemini non nomina — *sandbox non disponibile ≠ silenziosamente
unsandboxed*. È una lezione interna diretta: il flag del vecchio Muffin era ON
e no-op senza bubblewrap sull'host.

Sul code-as-action: `03-threat-model.md §3-bis` lo dice in una riga —
*"il codice libero elimina la validazione applicativa pre-esecuzione, e il
contenimento OS resta l'unico meccanismo"*. Con dieci tool tipati, scambiare
la validazione applicativa per una riduzione di latenza che non ci serve è un
cattivo affare. E il caso concreto che Gemini porta (batch su 5 PDF, 100
righe di dati) **è già coperto**: `shell_run` nel sandbox fa esattamente
quello. **Nessuna azione**, e la nota di coerenza: 2 peer su 3 convergono
su code-execution *come consegna della tool-retrieval*, cioè per il problema
che a dieci tool non abbiamo.

---

## 10. Web: search, fetch, e il reader che manca

**Adesso.** Due primitive separate, come si deve.
- `web_search` (`agent/tools/search.ts:59`, Tavily): **solo snippet** —
  `include_raw_content`/`include_answer` restano off **con un test**, perché
  pagine intere sarebbero superficie d'iniezione per una capability il cui
  compito è *trovare* la pagina. `hostOnly` (spende i crediti dell'owner),
  `maxTaint 3`. Registrata solo se configurata **e** se l'endpoint è in
  `egress.json`.
- `http_get` (`agent/tools/http.ts:40`): GET only, allowlist egress ri-applicata
  **a ogni hop di redirect**, ogni hostname risolto e ogni indirizzo privato
  rifiutato (SSRF floor, v4-mapped-v6 incluso), corpo tier-3 e recintato.

**Poi.** `12-casi-uso-primitive.md`: **fetch binario** ("mandami il file / le
immagini da quel sito") è marcato ❌ — `http_get` è GET testuale.

**Gemini.** *"Non devi mai passargli l'HTML grezzo: sprecheresti centinaia di
migliaia di token in tag `<div>`, script e CSS."* Pipeline:
URL → Reader Engine (Firecrawl / Jina / Trafilatura) → Clean Markdown, con un
guard che tronca oltre ~4000 token o passa a un modello veloce per
un'estrazione mirata. E, sulla VPS: niente Chrome su IP datacenter — Google
solleva CAPTCHA, Cloudflare blocca; usa un'API di search.

**Verdetto: BUCO VERO, e siamo indietro rispetto al vecchio Muffin.**
Verificato ora a `agent/tools/http.ts:130`: il corpo torna **come testo
grezzo**, HTML compreso, clippato a 50.000 caratteri con head 40k + tail 10k
(`:169`). Il vecchio aveva **Readability** (`src/tools/fetchUrl.ts`) —
`inventario-vecchio-nuovo.md §5` lo marca "PRESENTE, più stretto", e quel
verdetto guardava la sicurezza (SSRF su ogni hop, che è vera e migliore) e ha
mancato la resa. Va corretto lì.

Perché conta più di quanto sembri: 50.000 caratteri di HTML sono ~12k token di
cui forse 800 di testo, in un turno che ha un tetto di 4096 token in uscita e
un profilo consumer da 10 tool. E il troncamento head+tail su HTML taglia
**esattamente a metà del `<body>`** — cioè butta il contenuto e tiene
`<head>` e footer.

La forma giusta da noi non è Firecrawl né Jina (sono servizi terzi: un
endpoint in più in `egress.json`, e la pagina la leggono loro). È
**un'estrazione locale**, e la fetta la delimita la nostra stessa disciplina:
niente parser HTML pesante nella dipendenza — un estrattore che tiene il testo
e i link, davanti a `clipBody`, con il fence che resta dov'è. Il taint non
cambia (tier 3 comunque: pulire non è fidarsi).

Sulla VPS e gli IP datacenter: già risolto, abbiamo scelto Tavily. **Nessuna
azione.**

---

## 11. Kernel di permessi, policy engine, taint

**Adesso.** `core/policy/decide.ts:84`: puro, sincrono, totale. Ogni capability
passa da lì. Una capability senza dichiarazione **non esiste** per il runtime.
Quattro esiti (`allow`/`ask`/`draft`/`deny`), e i rami in ordine: safe mode →
mai-a-runtime (il RoT) → coerenza tenant → `hostOnly` vs membro → vietato ai
principal di sistema → **soffitto di taint** → budget → **egress** → ASK-in-coda
per gli autonomi → classe di rischio.

Il **taint** è l'asse che manca a chiunque altro: nasce dal principal, sale col
recall (`loop.ts:269`) e con ogni tool result tier-3 (`loop.ts:694`), e
invalida la cache delle decisioni prese più in basso (`loop.ts:811`).

**Poi.** `12-casi-uso-primitive.md §rischio`: il capitolo del threat model
sulle **sorgenti in ingresso** (una mail avvelenata che arriva alle 7 mentre
nessuno guarda) non è scritto, e va scritto prima di costruire mail e
calendario.

**Gemini.** Un *Policy Engine* che classifica le azioni in tre classi:
Read-Only/Safe (esecuzione immediata), Low-Risk Write (diretta con undo),
High-Risk Side-Effect (intercettazione obbligatoria, HITL). Più un
*Deterministic Constraint Verifier* che, prima di una scrittura, interroga lo
stato reale e rifiuta il payload (`ConstraintError: Time slot 15:00 is
occupied`).

**Verdetto: la classificazione per rischio è la metà che abbiamo; l'altra metà
Gemini non sa che esiste, e senza di essa il suo firewall è aggirabile.**

Le tre classi sono letteralmente le nostre `risk: low|medium|high` con
`reversible: undoable` → `draft`. E sono anche, riga per riga, il modello
`read_only / always_ask / contextual` del **vecchio** Muffin, che ADR-0013 ha
sostituito **proprio perché** classificare solo l'azione non basta.

Il buco è il **taint**. Un firewall per classe d'azione dice "leggere il web è
sicuro, mandare una mail è rischioso" — e non ha modo di dire *"mandare una
mail è rischioso **in modo diverso** dopo aver letto una pagina web"*. È
fetch-then-act, il pattern d'iniezione più comune del campo. E la parte
divertente: **Gemini lo descrive senza riconoscerlo** — la sua pipeline
`Fetch → Clean Markdown → contesto` (§10) è la prima gamba, il suo policy
engine è la seconda, e in mezzo non c'è niente che leghi le due. Nel nostro
kernel `taint > ceiling` è il ramo a `decide.ts:129`, e la propagazione è
`raiseTaint` sul risultato del tool.

Il *Constraint Verifier* (interrogare lo stato reale prima di scrivere) è
invece un'idea giusta e **applicabile solo dove non abbiamo adapter**:
calendario e mail. Va ricordata quando si costruiscono — non è un componente,
è una proprietà dell'adapter (leggi prima di scrivere, e restituisci l'errore
come fatto di sistema, non come rifiuto generico). **Da annotare in
`12-casi-uso-primitive.md`**, non da costruire ora.

---

## 12. Ambiguità, chiarimento, e la confidenza

**Adesso.** Niente. Il modello non ha un modo dichiarato di dire "non ho capito
chi è Marco": può solo chiedere in prosa, e nella maggior parte dei casi
sceglie invece. Il kernel gatea la **capability**, non la **certezza sugli
argomenti**.

**Poi.** `confronto-harness.md §9` punto 5: tool `todo` + **`clarify`**, marcati
"gap veri contro i casi d'uso".

**Gemini.** Un *Ambiguity & Intent Gate*: l'harness calcola una metrica di
confidenza sui parametri estratti; **se sotto 0.90 su un parametro critico
(chi, quando, quale file), cortocircuita la tool call** e forza una domanda di
chiarimento. Più, dal lato neuroscienza: azioni **epistemiche** (ridurre
incertezza) vs **pragmatiche** (cambiare il mondo), e un ciclo obbligatorio di
uncertainty reduction prima dell'esecuzione.

**Verdetto: la distinzione epistemica/pragmatica è utile e il tool manca; la
soglia sulla confidenza è la cosa peggiore della chat e va respinta con
nome e cognome.**

Sulla soglia: 0.90 di *cosa*? Se è la confidenza autodichiarata dal modello, è
una soglia su un numero che il modello si inventa. Abbiamo la misura in casa:
le confidenze LLM sono **sovrastimate di 15-27 punti**, ed è per quello che
`SUPERSEDE_THRESHOLD 0.75` è marcato come folklore in `STATE.md` e come
*"potrebbe proteggere meno di quanto sembra"*. La stessa famiglia di risultati
dice che un giudice si sposta di **+0,27-0,36** solo cambiando l'assertività
del linguaggio (ADR-0034). Un gate tarato su un'autovalutazione è tarato sulla
sicurezza con cui il modello scrive, non su quanto sa.

Sulla parte buona: la distinzione fra azione epistemica e pragmatica **è già
nel nostro kernel**, ma per caso e non per nome — `fs_read` è low risk,
`outward.send` è high. Renderla esplicita non serve. Serve invece
**`clarify`**: un tool che chiede una cosa sola e chiude il turno, così che
"chiedere" sia una mossa che il modello può *fare* invece di una che deve
*ricordarsi di fare in prosa*. Il costo è basso e il beneficio è misurabile
(un turno che chiede è un turno che non inventa un Marco). **Confermato il
punto 5 di §9, e questa è la ragione migliore che abbiamo per costruirlo.**

---

## 13. Verifica prima di consegnare, repair, output strutturato

**Adesso.** `agent/completion.ts` + `loop.ts:450`: un gate **deterministico**,
un segnale solo — la risposta nomina un tool esposto in questo turno e il turno
non ha chiamato **niente**. Un nudge coi tool nominati, poi la risposta resta e
il fatto va a verbale (`muffin.completion.unresolved`). Mai riscrittura.
La cascata di recovery è **dati nel profilo**, non codice
(`agent/profiles/recovery.ts`): `nudge`, `reinjectTools`, `retryOnce`,
`strictJson`, ordinati; il frontier ne dichiara due, il consumer quattro.
Retry di trasporto separati dal cascade (`loop.ts:87`), backoff esponenziale
con full jitter.

**Poi.** `structuredOutput` è nel `ChatCall` normativo di
`09-contratti-m0-m1.md` e **non ha consumatori** (STATE.md, "resta aperto").

**Gemini.** L'anatomia completa di un runtime harness: pre-execution guard e
context pruning → **constrained decoding / grammar-guided generation**
(Outlines, Instructor, `json_schema` del provider — *"il campionatore scarta a
monte qualsiasi token che violi la grammatica"*) → **verificatori
deterministici** (AST, Zod, test runner) → **targeted repair engine** con rich
diff (non "hai sbagliato, correggi", ma `{failed_snippet, compiler_error,
instruction}`) → **circuit breaker** con retry budget 2-3, model escalation,
fallback deterministico. E, esplicito: *"un grave errore dei sistemi agentici
tradizionali è chiedere a un altro LLM di giudicare l'output. Un Harness
professionale usa esclusivamente verificatori deterministici."*

**Verdetto: la convergenza più forte della chat, e vale come conferma esterna
di ADR-0034.** Gemini arriva da sola a "niente critico LLM, solo verificatori
deterministici" — che è la decisione che `confronto-harness.md §2.4` aveva
marcato *"regge ma indifendibile senza ADR"* e che ADR-0034 ha poi scritto con
i numeri (AUROC ≤0,65 per qualunque giudice LLM; false-success 13-79% a
seconda della famiglia, **peggiore col reasoning acceso**; −31 punti su GAIA
senza gate).

Il resto dell'anatomia mappa così:
- **pre-execution guard / context pruning** → `assemble.ts` + `compact.ts` ✅
- **verificatori deterministici** → `completion.ts` ✅ (ma copre **una classe
  sola**, e ADR-0034 lo dice invece di lasciarlo credere)
- **targeted repair** → `recovery.ts`, in forma più debole: il nostro
  `strictJson` re-istruisce, non porta il diff. Per il tool-calling è meno
  grave che per il codice (l'errore è quasi sempre "argomenti non parsabili",
  e il messaggio esatto lo abbiamo già). **Nessuna azione.**
- **circuit breaker con model escalation** → abbiamo il retry budget (2) e il
  fallback (il turno finisce con `stopped` che significa qualcosa). **Non
  abbiamo l'escalation di modello**, ed è giusto così: ADR-0009 taglia il
  router dinamico, e "se fallisce due volte passa a Sonnet" è un router
  travestito da recovery. **RESPINGI.**
- **constrained decoding** → è il pezzo che manca, e Gemini ha ragione a
  metterlo per primo. Ma il consumatore non c'è: oggi l'unico posto dove uno
  schema è obbligatorio è l'estrazione fatti e il giudice
  (`core/memory/extract.ts`, `judge.ts`), che parsano a mano. **Il modo di
  chiudere `structuredOutput` non è implementarlo in astratto: è cablarlo lì**,
  dove il costo del JSON malformato oggi si paga come `report.errors` e un
  episodio riprovato al giro dopo. Buon candidato, priorità media.

**Nota trovata propagando questo documento (2026-08-14), e vale come nona voce.**
`09-contratti-m0-m1.md §2` è **normativo** e diceva due cose che il codice non
fa: che `strictJson` *"forza structured output"* — mentre `recovery.ts` lo
implementa deliberatamente come turno correttivo testuale, perché `toolChoice`
è `'auto' | 'none'` e `'required'` degraderebbe in silenzio proprio sul modello
debole che è l'unico caso d'uso — e che il profilo per-modello porta un campo
`structuredOutputMode`, che non esiste né nel tipo né nello schema zod
(`agent/profiles/profile.ts:75`) né in nessuno dei due profili spediti. Non è
"dichiarato e non connesso": è **il documento normativo che descrive un codice
diverso da quello che gira**, il che è peggio, perché quel documento vince sui
conflitti per regola scritta. Corretto lì, allineando il contratto alla
decisione che il codice aveva già preso e motivato.

---

## 14. Proattività, e la cascata di Gemini

**Adesso.** `core/scheduler/proactivity.ts:94` (`decideProactive`): funzione
pura come il kernel. Tier >1 → deny · quiet hours → defer · budget → defer. E
il rail sul **cosa**: `ProactiveKind` è un **insieme chiuso** —
`commitment_due`, `deadline_near`, `fact_actionable`, `consolidation`,
`gone_quiet` — più un `anchor` per il dedup. Un'osservazione libera **non è
rappresentabile**: il firehose è incostruibile, non scoraggiato.
Stadio 1 dell'assenza costruito (`core/memory/absence.ts`): la manopola è
**alpha**, il tasso di falsi allarmi, esatto a qualunque lunghezza di storia —
non "media × 3", che a n=2 è un test al 16% e non al 5%.
`muffin observe` **nasce spento**: mostra, `--send` è un atto esplicito.
Su memoria vera: **0 candidati su 0 entità**, perché la memoria è vuota (§6).

**Poi.** Mancano i detector che armano `deadline_near` e `commitment_due`.
L'emendamento a ADR-0028 per `gone_quiet` è **proposta non ratificata**, e la
sua ratifica aspetta un numero che oggi non esiste.

**Gemini.** Una **cascata a filtri progressivi** per i gruppi:
Tier 0 regole deterministiche (menzione, reply, comando) → Tier 1
**classificatore locale / embedding** (<10ms, ONNX/BERT piccolo, distanza
vettoriale dai domini di competenza) → Tier 2 **state machine del gruppo**
(*"se nota un'alta frequenza di messaggi — es. 5 messaggi in 30 secondi — con
domande aperte non risposte… innesca il Tier 3"*) → Tier 3 gate LLM economico
binario. Più due principi: **High Precision, Low Recall** (*"100 volte meglio
che taccia"*) e **Epistemic Interventions** (interviene solo se possiede dati
certi non presenti nel contesto).

**Verdetto: l'architettura a stadi è la nostra e ha un precedente misurato; i
due criteri di Gemini per svegliarsi sono precisamente quelli che hanno
prodotto il firehose che l'owner ha respinto.**

Sulla forma: il cancello a due stadi è `knowledge/03-observing-spine.md`, e
`research/proattivita-quando-parlare.md §1` ha trovato il precedente misurato
(arXiv:2605.30152: +16,7 F1 medio su 14 backbone, 4-83× più veloce del baseline
LLM-come-trigger). **Ma quel paper ha lo Stadio 1 appreso, e noi abbiamo
divergato apposta**: un gate appreso è una superficie che si avvelena con
l'uso e che non si spiega da uno snapshot — le due proprietà per cui il kernel
è una funzione pura. Gemini propone il gate appreso (ONNX/BERT) **senza
nominare il prezzo**. Il prezzo è dichiarato da noi: 220 MB e un componente da
riaddestrare.

Sui criteri, ed è la critica che conta. Gemini fa svegliare l'agente su
**velocità della conversazione** (5 messaggi in 30 secondi) e **similarità
semantica col dominio**. Sono due proxy di "sta succedendo qualcosa", non due
segnali di "c'è una cosa concreta da dire". Il vecchio Muffin è finito
esattamente lì: **228 consegne in 4 mesi, una domanda al giorno per 19 giorni
su 20**, e nessuna mai uscita dallo stato `asked` perché niente scriveva
`answered`. È il *"firehose di 'ho notato X, ho notato Y', vago e
iper-complesso"* che l'owner ha respinto per esperienza diretta.

Il nostro insieme chiuso di `kind` fa la cosa che i principi di Gemini
chiedono — *high precision* ed *epistemic intervention* — ma la fa
**strutturalmente invece che per disciplina**. "Interviene solo se possiede
dati certi" è una regola che qualcuno deve rispettare; `ProactiveKind` è un
enum che qualcuno deve estendere. La differenza è tutta lì, ed è la ragione
per cui ADR-0028 vale più di quella cascata.

**Una cosa da prendere**: Tier 0 include *"risposta a un messaggio del bot"*
come trigger diretto. Ovvio, e per i gruppi (M7) sarà da avere. Non è
proattività — è routing. **Annotato, non prioritario.**

---

## 15. Scheduler, cron a predicato, interrupt engine

**Adesso.** `core/scheduler/jobs.ts` (job store durevole, soft-delete,
`nextFire` via cron-parser, `markRan` che ricalcola da *ora* — catch-up, non
replay degli slot persi) + `core/scheduler/scheduler.ts` con le tre proprietà
di ADR-0022: il tick lancia e ritorna senza attendere (l'heartbeat non dipende
dal ritorno del loop — bug Hermes #25517), un job in volo è saltato dai tick
successivi, il foreground vince e il job in corso riceve l'abort.
`core/scheduler/firelog.ts` è il **latch**: righe mai cancellate, chiave
sull'ancora, e l'ancora porta *quale istanza* dell'evento. **0 job** nel DB
dell'owner.

**Poi.** `12-casi-uso-primitive.md`: il **trigger a predicato** ("quando si è
svegliato — ma dopo il caffè") è *"il pezzo mancante vero"*. Forma decisa: il
job store ha già `cron`, gli si aggiunge un `trigger` che è `cron` **oppure**
`event`, dove `event` è un **insieme chiuso** di predicati — stessa disciplina
di ADR-0028. Se il predicato è testo libero, si è ricostruito il demone che
osserva tutto.

**Gemini.** *"Cron Human Tasks"*: uno scheduler dinamico persistente
(APScheduler/Celery su DB); l'utente chiede "controlla questo sito ogni mattina
per 2 settimane e avvisami se cambia il prezzo", l'agente **non scrive uno
script arbitrario** ma invoca `schedule_task()` registrando un payload
strutturato con cron, **condizione di stop** e azione. Più un *Interrupt &
Multiplexer Engine*: un event bus a cui i worker si iscrivono, e un
multiplexer che sceglie la surface in base allo stato dell'utente (ora del
giorno, presenza, ultimo canale usato).

**Verdetto: lo scheduler coincide e il nostro è più severo; il multiplexer è
ADR-0021 non costruito; l'unica idea nuova è la condizione di stop.**

"Payload strutturato, non script arbitrario" è la nostra regola
(`muffin jobs add --cron`, e il path NL atterra sullo stesso store dopo
conferma). Il *Notification Multiplexer* è ADR-0021 riga per riga — surface di
default, target per-job, coda con TTL e dirottamento dichiarato — con la
differenza che ADR-0021 ha anche la regola che Gemini non ha: **i tenant non
scelgono**, perché una surface di destinazione redirigibile da un gruppo è un
canale di esfiltrazione a costo zero. Il pezzo di ADR-0021 che manca (coda con
TTL, consegna remota) è già in `STATE.md` come "connect owner-gated".

L'**event bus (Redis/NATS)** è la seconda cosa attivamente sbagliata per noi
(la prima è il classifier routing). ADR-0022 dice un processo; il
`SendLock` che già esiste è la primitiva di coordinamento. Gemini generalizza
pattern enterprise a una macchina single-owner: pagheremmo un broker e una
classe di guasti nuova per coordinare processi che abbiamo deciso di non
avere. **RESPINGI.**

La **condizione di stop** è invece un dettaglio buono e assente da noi: un job
"per 2 settimane" oggi si spegne solo se qualcuno lo toglie. È una colonna e un
controllo in `markRan`. **Piccolo, da annotare insieme al trigger a predicato**
— stessa slice, stesso file.

---

## 16. Surface, gateway multi-canale, renderer

**Adesso.** Registro di surface (`cli/surface.ts`), non processi: una surface
si *abilita* e da lì è connessa dentro lo stesso processo. Telegram ha un
renderer suo (`connectors/telegram/render.ts`): markdown → **HTML** (3
caratteri da escapare contro i 18 di MarkdownV2), split che misura l'**HTML
renderizzato** e riapre i blocchi di codice tagliati. Il prompt è funzione del
**tenant**, non della surface (`assemble.ts`).

**Poi.** ADR-0016 §revisione (2026-08-09), verificata su fonte primaria e con
quattro precisazioni:
1. la dichiarazione di capability alimenta **due** consumatori — il renderer
   *e* il prompt (Hermes ha un campo letteralmente chiamato *"System-prompt
   platform hint"*);
2. ma nel prompt va **in coda volatile, mai nel prefisso cacheabile**, e i
   **tool restano uniformi** — mai tool condizionali per surface;
3. Telegram `sendRichMessage` (Bot API 10.1/10.2) rende native tabelle e
   formule → capability `rich-native` opt-in con fallback obbligatorio;
4. il descrittore porta i numeri veri (4096 · 32.768 rich · Discord 2000; TG
   10MB foto/50MB doc), e **un'immagine renderizzata va via `sendDocument`,
   non `sendPhoto`** (che ricomprime in JPEG).
Il contratto di blocchi tipati (`text`/`table`/`image`/`file`) è progettato e
**non costruito**.

**Gemini.** Tre componenti: **Surface Context Injector** (il gateway inietta
nel system prompt un JSON con `capabilities`, `max_character_limit`,
`supported_mime_types`, `output_directive`) → **Core Agent** che produce un
**AST/payload canonico** (`{type: "data_table", headers, rows}`) → **Surface
Adapters** che transpilano (React/GenUI per la dashboard, monospazio o immagine
per Telegram, strip di link e SSML per la voce).

**Verdetto: il disegno coincide quasi esattamente, e l'unico punto in cui
diverge è quello dove abbiamo la meccanica misurata e Gemini ha l'intuizione
sbagliata.**

L'AST canonico è il nostro contratto di blocchi tipati. Gli adapter sono i
nostri renderer per-connector. Il "vincolo di parità" (stesso contenuto, forma
diversa) è ADR-0016 e ADR-0021 punto 5.

La divergenza: Gemini mette il descrittore di capability **nel system prompt**.
`research/m3-caching-and-per-connector-timing.md` ha preso la meccanica del
prompt caching da fonte autoritativa e mostra perché non si può: il caching è
un **prefix match** con ordine `tools → system → messages`, quindi un system
prompt diverso per connector **frammenta la cache per-connector**, e su
processo unico ogni switch Telegram↔Discord la invalida. La regola normativa è
prefisso condiviso, **specializzazione in coda**. Gemini non ha modo di saperlo
— ma è esattamente il tipo di dettaglio in cui un consiglio generico costa
soldi veri a ogni turno.

**Nessuna azione**, e il piano di ADR-0016 §revisione resta quello da eseguire
quando si costruisce il rendering di M4.

---

## 17. Vault, database, secret

**Adesso.** Tre cose separate e ciascuna al posto giusto.
- **Secret**: keychain OS o file cifrato, referenziati per nome
  (`secret://...`), letti da stdin e mai da argv, mai stampati. Il RoT
  (`~/.muffin/rot/`) è sigillato, hashato al boot, e ogni file sigillato ha un
  **lettore dichiarato** (`core/rot/readers.ts`).
- **Database**: `~/.muffin/db/muffin.db` — episodi, grafo, job, budget,
  vettori.
- **Vault**: `~/.muffin/vault/` — i file sono la fonte, l'indice è derivato e
  ricostruibile; chunking strutturale heading-first (ADR-0024);
  `muffin vault check` confronta disco e indice. Struttura: **solo `inbox/`**
  (`connectors/telegram/media.ts`).

**Gemini.** Prima la separazione classica (Vault = HashiCorp/Doppler per le
credenziali, Database = stato operativo; *"l'agente non legge direttamente il
Vault; è l'Harness che inietta i token"*). Poi, corretto dall'owner, il vault
come **workspace PKM**: `inbox/` · `notes/` · `research/` · `artifacts/` ·
`tmp/`.

**Verdetto: la separazione è già nostra e più forte; la sottostruttura è
un'idea buona a costo quasi zero.**

Sulla separazione: *"l'harness inietta i token, l'agente non legge il vault"*
è letteralmente `agent/runtime.ts` — la chiave è letta dentro la closure e non
ne esce mai, e **non entra nemmeno nel sandbox via environ**
(`core/sandbox/executor.ts`, env del figlio ricostruito). In più abbiamo la
cosa che Gemini non nomina: `fs_read` ha una **deny-list** sui secret
(`runtime.ts:151`) — e ce l'ha perché l'audit avversariale del 2026-08-06 trovò
`fs_read` che la saltava e leggeva la chiave API (`STATE.md §Audit
avversariale`, uno dei quattro bypass del containment fs).

Sulla sottostruttura: oggi tutto atterra in `inbox/`, e questo ha un effetto
concreto sul recall — un paper scaricato, una nota scritta e un allegato
ricevuto sono la stessa cosa per l'indice. `12-casi-uso-primitive.md` ha
"il vault che ritorna" fra i cinque casi validati (*"un paper salvato tre mesi
fa che riemerge perché ora stai parlando di quella cosa"*), e quella è
**context specificity**, che ha bisogno di sapere cos'è un artefatto e cosa
una nota. **ADOTTA la sottostruttura**, con una regola nostra: le directory
sono **convenzione, non semantica** — il tier e la provenienza restano
sull'episodio, non sul percorso. Una cartella non è mai un permesso.

---

## 18. Budget e circuit breaker

**Adesso.** `core/budget/budget.ts`: cap **mensile** e cap **giornaliero
per-tenant**, entrambi consultati dal kernel (`decide.ts:137`: sopra il rischio
basso, budget esaurito → deny). Registrato a ogni chiamata al modello
(`loop.ts:402`) — e la riga esiste perché prima non c'era e `exhausted()`
rispondeva `false` per sempre. Quiet hours e budget nel gate di proattività.
`/spend` nel REPL.

**Poi.** Niente di specifico.

**Gemini.** *"Ogni task generato da Muffin deve avere un Hard Budget assegnato
alla creazione: Max_Tokens: 10000, Max_API_Calls: 5, Timeout: 60s"*, con un
middleware che traccia in tempo reale e un circuit breaker che blocca il task e
manda l'errore alla dashboard.

**Verdetto: BUCO VERO, e diventa urgente esattamente quando arriva ADR-0035.**
I nostri cap sono **globali** (mese, giorno-per-tenant). Il cap per-turno è
l'iteration cap del profilo, che conta i giri e non i token. Finché l'unico
consumatore è l'owner davanti al terminale, va bene: se un turno impazzisce lo
vedi. **Con un processo che vive**, i turni autonomi girano di notte, e "il
mese si esaurisce" è un controllo troppo grosso — è la differenza fra un job
rotto che costa €0,50 e uno che si mangia il mese prima delle 7.

La forma da noi non è il middleware di Gemini: il posto giusto è **il job**.
`core/scheduler/jobs.ts` ha già la riga; le servono un budget e un contatore, e
`markRan` sa già chiudere un giro. E la nota che ADR-0035 fa da sé
(*"l'heartbeat di un job non può dipendere dal ritorno del loop"*) vale identica
qui: il conto va tenuto fuori dal turno, non dentro.

**Da mettere nella stessa slice di ADR-0035**, non prima e non dopo.

---

## 19. Undo, draft, audit log

**Adesso.** Il kernel emette `draft` (medium risk + `reversible: 'undoable'` →
`{effect:'draft', undo:{windowSeconds:300}}`, `decide.ts:198`), e il loop lo
**rifiuta onestamente** (`loop.ts:656`): *"il registro di undo non esiste
ancora. Non eseguito"*. Ogni tool call è uno span con principal, tenant,
capability, taint, esito, costo (`core/tracing/`), log append-only locale.

**Poi.** `confronto-harness.md §9` punto 4: **registro staged-pending** —
scritture in attesa persistite, che sopravvivono al riavvio, rivedibili. È un
*adopt-mechanism*: il disegno è di Hermes. ADR-0035 lo nomina fra le cose che
il processo rende rappresentabili.

**Gemini.** *"Muffin non deve mai eseguire operazioni distruttive sul
filesystem diretto. Ogni modifica nel Vault passa per un Internal Versioning
System (un repository Git locale trasparente o una cartella .trash)"*, così che
"annulla l'ultima azione sui file" esegua un `git revert`.

**Verdetto: idea concreta, ma i nostri numeri dicono di costruire il caso
d'uso prima del registro.** Il dato: nel vecchio Muffin `undo_log` ha **zero
righe in quattro mesi**, col tier act-notify-undo **acceso di default**. Un
meccanismo di annullamento che nessuno ha mai usato non è una feature mancante:
è una feature che non è mai servita. ADR-0035 lo dice già —
*"costruire il registro non basta; va costruito il caso d'uso che lo riempie, o
è la dodicesima istanza"*.

Detto ciò, il **git trasparente sul vault** è più economico di un registro
staged-pending generico, e ha un secondo uso che Gemini non nomina: rende
`muffin vault check` capace di dire non solo *"disco e indice divergono"* ma
*"ecco cosa è cambiato"*. Vale la pena tenerlo come **forma candidata** quando
il caso d'uso arriverà, non come lavoro adesso.

---

## 20. Self-modification, skill, VPS

**Adesso.** Runtime SKILL.md (`core/skills/skills.ts`, formato standard
agentskills.io, nessun formato proprio): metadata sempre nel prompt, corpo via
`skill_read` da una porta dedicata contenuta nella dir della skill (entrambi i
lati realpath'd). Skill malformata → **skip con motivo stampato al boot**, mai
mezzo-caricamento silenzioso. **Nessun autodraft**: l'agente non scrive skill.
Il RoT non ha write-path a runtime (`decide.ts:103`, `rot_violation`).

**Poi.** ADR-0014: prima il RoT irraggiungibile, **poi** l'auto-modifica
eval-gated (ratchet API: proposta versionata → eval gate → canary → undo), che
è M6. `03-threat-model.md §f` ha già le due strette: il generatore di proposte
legge **solo fatti già passati dalla pipeline**, mai episodi grezzi; e il
**diff testuale** di voice/prompt va mostrato all'owner, perché una eval
misura il comportamento medio e un backdoor condizionato non lo muove.

**Gemini.** La tabella CLI-vs-agente (OS, runtime, secret, codice core = CLI;
skill/tool modulari, prompt, memoria = agente) e il pattern *"Dynamic Skill
Engine & Git Sandbox"*: `core/` immutabile, `workspace/skills/` mutabile,
l'agente scrive una skill → esegue pytest/linter → hot-reload → git commit, e
se in esecuzione solleva un'eccezione l'harness la disabilita e fa `git
revert`.

**Verdetto: il confine è il nostro e Gemini lo traccia bene; il meccanismo di
gating è più debole del nostro e omette la cosa che l'ha rotta in produzione.**

Il confine coincide fin nei dettagli (l'agente non riscrive il gateway, sì le
skill; i secret li usa e non li riscrive). Dove diverge: il gate di Gemini è
**"passa i test → hot-reload"**. È letteralmente ciò che ha prodotto le 751
skill malevole sul registry di Hermes: *"l'agente può già eseguire lo stesso
codice via terminal senza gate"* è il loro docstring, e il risultato è che la
guardia è spenta. Passare i propri test è un criterio che chi scrive i test
controlla.

Il nostro ordine — **RoT irraggiungibile prima, eval-gate e diff visibile
poi** — è quello giusto e ADR-0014 lo tiene. **Nessuna azione**, e il pezzo di
Gemini che vale la pena ricordare quando si costruirà M6 è il **rollback
automatico all'eccezione** (disabilita e reverti alla prima eccezione non
gestita): è più stretto del nostro "canary + undo", e costa poco.

---

## 21. Delega e sub-agenti

**Adesso.** Non esiste. Un loop, cappato, nessuno spawn.

**Poi.** **ADR-0033**: rinviata, **con il grilletto scritto**. Quando arriverà:
spenta di default, profondità 1 col tool di spawn **bloccato al figlio**,
contesto fresco, sottoinsieme di capability, ritorno trattato come tool result
col suo tier. Il grilletto è misurabile: ≥3 turni `stopped: 'cap'` in un mese
sulla stessa classe di richiesta, oppure ≥3 richieste chiuse e riaperte a mano.

**Gemini.** *"Sub-Agenti e Isolamento del Contesto: per evitare che compiti
complessi inquinino la context window principale, l'agente coordinatore può
generare sub-agenti isolati… raccogliendone solo il risultato finale."*

**Verdetto: già deciso, con più numeri di quanti Gemini ne porti.** Il numero
forte è a favore (+90,2% per orchestrator-workers, Anthropic) e viene con due
postille che Gemini omette: **~15× token**, e *"not a good fit"* proprio dove
gli agenti condividono contesto — che è la forma della quasi totalità dei
nostri turni. Su un profilo da quattro deep-research al mese, 15× non si
ripaga, e **il Gate 1 non lo registra**. **Nessuna azione**, il rinvio regge.

---

## 22. Neuroscienza: cosa è già primitiva e cosa no

Gemini dedica un turno intero alla domanda "perché ci limitiamo al ReAct, la
neuroscienza non ci aiuta?" e propone tre lenti. Vale la pena mapparle, perché
`knowledge/README.md` ha una regola che decide da sola gli esiti: **un
principio diventa una proprietà di una primitiva che esiste, mai un modulo a
lato.**

| Lente di Gemini | Dove vive già da noi | Verdetto |
|---|---|---|
| **System 1 / System 2** (router deterministico o SLM per il 90%, LLM pesante sopra soglia) | corsia `light` vs `main` (`runtime.ts:54`) · cancello a due stadi (§14) · il kernel come funzione pura | **già primitiva** — e come *router per-prompt* è tagliato da ADR-0009 |
| **Active inference / azioni epistemiche** | classe di rischio del kernel, implicitamente | **manca il nome e manca `clarify`** → §12 |
| **Predictive coding** (predici lo stato, elabora solo il delta) | niente | **nessuna incarnazione, e va bene così**: predire l'output di un tool per confrontarlo costa una chiamata in più per risparmiare token; il conto non torna a questa scala |
| **Global Workspace / moduli paralleli su event bus** | niente | **RESPINGI** — è l'event bus di §15 con un'etichetta cognitiva |
| **Silenzio come segnale** (Gemini **non** la nomina) | `core/memory/absence.ts` | nostra, e senza prior art trovata |
| **Importanza ≠ frequenza** (Gemini **non** la nomina) | `facts.importance`, fuori da RRF | nostra |

Le due righe finali sono il punto: la parte di neuroscienza che abbiamo
incarnato davvero è quella che Gemini non nomina, e le dimensioni che restano
scoperte — `trend`, `affect signature`, `context specificity`, e il decay come
pavimento di `significance` — sono scoperte anche nella sua versione. **La
lista di `knowledge/01-understanding.md §Cosa resta da incarnare` non cambia.**

---

## 23. Cosa Gemini non nomina mai — e dove quindi siamo soli

Nove turni, nessuna occorrenza di:

1. **Provenienza e trust tier.** Zero. Il suo policy engine classifica le
   azioni, mai le fonti. È l'asse che rompe fetch-then-act (§11) e il
   memory-poisoning dormiente.
2. **Multi-tenancy.** L'assistente di Gemini ha un utente. Il nostro ha un
   owner e dei gruppi, e il prompt è funzione di **chi parla** — cosa che
   `confronto-harness.md §8` ha verificato che **nessun peer fa**.
3. **Bi-temporalità.** "Chi era il mio commercialista a maggio" non è
   rispondibile in nessuna delle architetture che descrive.
4. **Rug-pull MCP.** Le descrizioni dei tool arrivano da server terzi e vanno
   nella fascia di massima fiducia del prompt; noi pinniamo lo sha256 di
   name+description+inputSchema e sospendiamo al drift — **più severi di tutti
   e tre i peer** (`capability-surface.md`).
5. **Insieme chiuso di trigger proattivi.** Il suo Tier 3 è un LLM che decide
   `{"intervene": boolean}` su testo libero: il firehose è costruibile.
6. **Il costo della cache come vincolo di design.** Vedi §16.
7. **Root of Trust.** Nessuna nozione di un insieme minimo che rende sicuro
   tutto il resto, e nessun "nessun write-path a runtime".
8. **Che una difesa possa essere scritta, testata e collegata a niente.** È la
   famiglia di guasti più costosa di questo repository
   (`docs/lessons.md §"Writing the defence is not connecting it"` — quattro
   trovate in una sola passata; il conteggio corrente, **undici**, sta in
   ADR-0035) e non compare come categoria in nessun consiglio. La regola che ne
   è uscita — *scrivi il test che fallisce senza il cablaggio, non quello che
   prova la logica* — non ha equivalente in nessuna delle anatomie di harness
   che Gemini descrive.

Non è una critica al modello: sono le cose che si vedono solo con il codice
davanti e quattro mesi di produzione alle spalle. Ma è la ragione per cui una
consulenza generica non può essere una roadmap.

---

## 24. Cosa cambia davvero nella lista di lavoro

**Non cambia l'ordine.** Restano davanti, invariati:

0. **Il processo che vive** (ADR-0035) — e §2 gli dà il criterio d'uscita
   giusto: *un turno lungo torna entro 500ms e consegna dopo*.
1. **Il consolidamento, in due meccanismi** — corsia per-turno asincrona +
   manutenzione periodica. Gemini è d'accordo (§6), il che non lo rende più
   urgente ma toglie l'ultimo dubbio che fosse una nostra fissazione.

**Si aggiungono quattro voci piccole**, tutte fuori dal cammino critico e
nessuna sopra i due punti qui sopra:

| # | Cosa | Dove | Costo | Perché ora |
|---|---|---|---|---|
| A | **Estrazione del testo prima di `clipBody`** | `agent/tools/http.ts:130,169` | basso | oggi 50k caratteri di HTML entrano nel contesto e il troncamento head+tail butta il `<body>`; il vecchio Muffin aveva Readability |
| B | **`memory_search` con `surface`, `date_range` e vicinato** | `agent/tools/memory.ts`, `core/memory/recall.ts` | basso | è il caso d'uso letterale dell'owner, i campi ci sono già, e senza vicinato un episodio ripescato è una frase senza intorno |
| C | **Budget per-job** (token, chiamate, timeout) | `core/scheduler/jobs.ts` | basso | i cap globali bastano solo finché c'è un umano davanti — con ADR-0035 non c'è |
| D | **`digests` scritto** (compattazione per sintesi al posto del troncamento a 40) | `core/memory/schema.ts:138`, `agent/loop.ts:62` | medio | la tabella esiste senza scrittori né lettori; il troncamento è l'unica perdita non recuperabile da un tool |

**Da annotare, non da costruire**: la sottostruttura del vault (§17, insieme al
primo lavoro sul vault), la condizione di stop sui job (§15, insieme al trigger
a predicato), il constraint-verifier come proprietà degli adapter mail/calendario
(§11, in `12-casi-uso-primitive.md`), il rollback-all'eccezione per le skill
(§20, in M6).

**Da respingere con la ragione scritta**: event bus / microservizi agentici
(§15 — ADR-0022), classifier routing sui tool (§8 — due retrocessioni in casa),
soglia di confidenza come gate d'ambiguità (§12 — confidenze sovrastimate di
15-27 punti), model escalation nella cascata di recovery (§13 — è un router
travestito), DSPy e prompt compilati (nessun golden set alla scala che serve, e
combatte la decisione "i prompt sono file che l'owner edita"), `ripgrep` come
tool separato sul vault (§5 — secondo percorso di verità).

**Un candidato a sé, priorità media**: cablare `structuredOutput` — non in
astratto, ma su `extract.ts` e `judge.ts`, dove oggi un JSON malformato si paga
come `report.errors` e un episodio riprovato al giro dopo (§13).

---

## Fonti

Conversazione Gemini `share.gemini.google/XhaLDrwb6a07` (3.6 Flash, 2026-08-14,
nove turni, letta per intero).
Codice verificato in questo worktree: `agent/loop.ts` · `agent/runtime.ts` ·
`agent/context/{assemble,compact}.ts` · `agent/providers/types.ts` ·
`agent/profiles/*.json` · `agent/tools/{http,search,memory,shell}.ts` ·
`core/policy/decide.ts` · `core/memory/{recall,ingest,schema,absence}.ts` ·
`core/scheduler/{proactivity,jobs,scheduler,firelog}.ts` ·
`core/session/store.ts` · `core/vault/vault.ts` · `cli/{repl,memory,surface,observe}.ts` ·
`connectors/telegram/{render,presence}.ts`.
Documenti: `02-ontologia.md` · `03-threat-model.md` · `04-roadmap.md` §M5-bis ·
`12-casi-uso-primitive.md` · `adr/{0013,0014,0016,0021,0022,0027,0028,0032,0033,0034,0035}` ·
`research/{confronto-harness,inventario-vecchio-nuovo,capability-surface,system-prompt-architecture,proattivita-quando-parlare,m3-caching-and-per-connector-timing}.md` ·
`knowledge/{README,01-understanding,03-observing-spine,04-learn-from-absence}.md` ·
`docs/lessons.md`.
