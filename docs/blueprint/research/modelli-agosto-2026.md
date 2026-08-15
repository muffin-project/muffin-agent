# Modelli, agosto 2026 — Qwen 3.8 27B, le corsie, e cosa costerebbe provarle

```
scritto: 2026-08-15
verificato: 2026-08-15
verificato-contro: OpenRouter `/api/v1/models` + `/api/v1/models/{id}/endpoints`,
  fetch diretto 2026-08-15, nessuna chiave (413 modelli in catalogo) · Muffin
  @ origin/dev 947b076 · ADR-0037 letto su slice/gateway 6d2cd214 (non
  ancora in dev) · docs/PRACTICES.md §13 letto su slice/gateway (stessa
  ragione) · HuggingFace (Qwen/Qwen3.8-27B, e il file LICENSE di
  Qwen/Qwen3.8-2.4T-A95B), fetch diretto 2026-08-15
modello-strumenti: Claude Sonnet 5, agente di ricerca dentro Claude Code.
  Repo clonato e letto (Read/Grep/git show su più branch), MAI eseguito —
  nessun test, nessun eval, nessuna chiamata a pagamento. curl/python3 sola
  lettura contro l'API pubblica OpenRouter. WebFetch/WebSearch per
  HuggingFace e fonti terze.
invaliderebbe: un cambio di prezzo o di default_effort per qwen/qwen3.8-27b
  (oggi un solo provider, AkashML — nessuna concorrenza a fare da ancora);
  il percorso openai-compat che inizia a mandare reasoning/thinking (ADR-0037
  lo rifiuta esplicitamente per ora — chiuderebbe il vincolo centrale di
  questa ricerca); un benchmark terzo pubblicato per qwen3.8-27b
  specificamente (oggi il modello ha un giorno di vita e non ne esiste
  nessuno).
estende: docs/blueprint/research/b2-modelli-openrouter-multimodale.md
  (2026-08-04 — stessa domanda, risposta opposta) · docs/blueprint/research/
  a5-modelli-economia.md (2026-08-04 — pricing ed economia di corsia) ·
  docs/blueprint/06-modelli.md §2-bis (il verdetto che questa ricerca
  aggiorna) · rispetta (non contraddice) docs/blueprint/research/
  benchmark-comparabilita-harness.md (2026-08-09) su harness-sensitivity
```

## Bottom line

**Qwen 3.8 27B esiste davvero, da ieri.** Pesi aperti (Apache 2.0), rilasciati
il 14 agosto 2026, dense da 27B, già sul catalogo pubblico OpenRouter
(`qwen/qwen3.8-27b`, $0.45/$3.20 al milione di token in/out). Il glob del
profilo `consumer-local` lo intercetta senza toccare codice. Il documento
`06-modelli.md` §2-bis, che l'8 agosto diceva "il Qwen 3.8 27B non esiste",
va aggiornato — non da questa ricerca, che non tocca codice, ma dalla
prossima slice che lo fa.

Il vincolo che conta di più però non è la licenza né il prezzo: **il modello
ragiona per default a sforzo "xhigh", e non esiste — né sul dev di oggi né
sulla correzione già scritta ma non ancora integrata (ADR-0037) — un modo per
dirgli di smettere sul percorso che lo raggiunge (OpenRouter/openai-compat).**
Con l'output massimo fissato a 4096 token per ogni turno, l'aritmetica
documentata da OpenRouter lascia circa 205 token per la risposta vera: un
rischio meccanico concreto, derivato da fonti primarie, non misurato con una
chiamata reale. Non è un difetto di Qwen — la stessa cosa vale già per Gemini
3.7 Flash e Grok 4.6, appena visti sullo stesso catalogo: il buco è nostro, e
si allarga a ogni modello nuovo che ragiona per default, che oggi è quasi
tutti.

**Raccomandazione in una riga**: primo test su `evals/floor/run.ts --model
qwen/qwen3.8-27b --reps 1` (sei scenari, un run, il harness stesso dichiara
il costo in token reali) — non sulla lane light, e non prima di aver deciso
cosa fare del buco sul reasoning, perché altrimenti il numero che il floor
eval riporta misura quel buco, non il modello.

---

## Parte concettuale — italiano

### Perché questa ricerca, e cosa chiude

`docs/blueprint/STATE.md` §"Aperto (owner)", punto 2, portava una scadenza
esplicita: *"Modello consumer di riferimento: rivalutare a metà agosto se
escono i pesi di Qwen 3.8 (27B); altrimenti eval breve tra Qwen3.6-27B/35B-A3B,
GPT-OSS-20b e l'incumbent Gemma-4."* Oggi è il 15 agosto. La domanda ha già
una risposta scritta nel repo, datata 4 agosto
(`docs/blueprint/06-modelli.md` §2-bis): *"Il 'Qwen 3.8 27B' non esiste"*, con
la nota *"da ri-controllare tra qualche settimana"*. Questa ricerca è quel
ri-controllo, undici giorni dopo — non una ricerca da zero, ma la verifica di
una condizione che una ricerca precedente aveva lasciato esplicitamente aperta
e datata. È esattamente il caso per cui il blocco di freschezza di PRACTICES
§13 esiste: senza una data e un `verificato-contro`, "non esiste" e "non
esiste più" sono indistinguibili a chi legge dopo.

### Cosa ho verificato, e come

Il metodo è quello che il mandato chiedeva: interrogare l'API pubblica di
OpenRouter (`GET /api/v1/models`, nessuna chiave) invece di fidarmi della
memoria di qualunque modello, mio incluso. L'ho fatta due volte: una sull'
endpoint aggregato (413 modelli, contro i 338 della rilevazione dell'8/4 — la
crescita da sola dice che il catalogo si muove), una su `/models/{id}/
endpoints` per i candidati principali, perché il primo endpoint mostra **un**
prezzo per modello e il secondo mostra **tutti i fornitori che lo servono** —
e i due numeri possono differire di 2× (sotto, §5). Ho letto il codice del
repo alla base che il mandato indica (`origin/dev`, che si è mosso da sotto di
me a metà stesura — vedi `verificato-contro`: ho ri-basato e ri-controllato
ogni riga citata dopo il movimento, non prima). Ho letto un ADR non ancora
integrato (`slice/gateway`) perché è la correzione più recente sullo stesso
meccanismo e ignorarla avrebbe fatto sembrare chiuso un difetto che è solo
spostato. Ho verificato la licenza sulla pagina HuggingFace del modello e sul
file `LICENSE` grezzo di un repository fratello, non su un riassunto di blog.
Nessuna chiamata a un modello, nessuna chiave, nessun account: dove la domanda
richiedeva una chiamata vera, l'ho segnata sotto in "Cosa non si è potuto
stabilire" invece di indovinare.

### 1. Qwen 3.8 27B esiste — la catena di evidenza

Sul catalogo di oggi, `qwen/qwen3.8-27b` (slug canonico
`qwen/qwen3.8-27b-20260814`) esiste, con `hugging_face_id:
"Qwen/Qwen3.8-27B"` popolato — il segnale che distingue un modello con pesi
scaricabili da uno che vive solo dietro un'API chiusa (esattamente il segnale
che l'8 agosto escludeva Qwen3.8, quando esisteva solo `qwen3.8-max` con
`hugging_face_id: null`). Il timestamp di creazione OpenRouter è
**2026-08-14T15:55:10 UTC**; una ricerca web indipendente (non eseguita da me,
letta) colloca il rilascio ufficiale Alibaba lo stesso giorno, "alle 15:00
UTC" — un'ora di scarto compatibile col tempo che OpenRouter impiega a
indicizzare un rilascio nuovo. Ha un fratello più grande uscito due giorni
prima, `qwen/qwen3.8-2.4t-a95b` (2.4T totali, 95B attivi, MoE, la variante
open-weight dello stesso `qwen3.8-max` che ad agosto era ancora chiuso), e il
`qwen3.8-max` stesso resta closed-weight (`hugging_face_id: null`), instradato
oggi su un prezzo per-token identico al fratello aperto — sembra la stessa
rete di pesi dietro due porte diverse, gestita e non gestita.

La licenza è **Apache 2.0**, letta sulla scheda del modello HuggingFace
(non un riassunto — la pagina stessa). Una fonte aggregata (Latent Space, un
sito con una reputazione ragionevole nel settore, non un content-farm) riporta
che *"users flagged potential geographic restrictions... covering the USA, EU,
UK, and Korea"* — lo stesso pattern già visto su MiniMax H3 l'8 agosto, e
`06-modelli.md` aveva già scritto la regola operativa giusta: *"la licenza di
ogni modello open-weight si rilegge al momento dell'adozione, non si assume
dalla famiglia."* Ho seguito quella regola: ho letto il file `LICENSE` grezzo
del repository fratello (`Qwen/Qwen3.8-2.4T-A95B`, la variante Max — il 27B
non pubblica un file `LICENSE` proprio separato, eredita il tag Apache 2.0
sulla scheda). Il file esiste, si chiama "Qwen3.8-Max License" (non un testo
Apache generico — ha condizioni commerciali legate a soglie di ricavi/utenti,
lo schema già visto su altre famiglie cinesi), **e non contiene nessuna
clausola geografica**. Restano due letture in tensione: la scheda del 27B
(Apache 2.0 semplice) e il file legale del fratello Max (licenza custom, ma
senza restrizione di paese). Nessuna delle due fonti che ho letto direttamente
conferma una restrizione USA/UE/UK/Corea per **il 27B** — la preoccupazione
sembrava riferirsi al lancio generale della famiglia, non a una clausola
verificabile nel testo. La tratto come **folklore non confermato**, non come
fatto: chi adotta il modello dovrebbe comunque rileggere la licenza esatta al
momento dell'adozione, come la regola del repo già dice.

### 2. Il vincolo che conta di più: il ragionamento che non si spegne

Qui la ricerca smette di essere "il modello esiste?" e diventa "il modello
regge il nostro profilo?" — la domanda che il mandato chiedeva di verificare
sul codice, non sulla carta.

Il glob `"*qwen3*"` in `agent/profiles/consumer-local.json` intercetta
`qwen/qwen3.8-27b` senza bisogno di modifiche: il matcher è un'espressione
regolare ancorata ma senza vincoli sul prefisso (`agent/profiles/profile.ts`),
quindi "contiene qwen3 da qualche parte" basta, prefisso `qwen/` incluso.
Fin qui, niente da fare. Ma il profilo dichiara `"thinking": "allowed"` per il
frontier e — sul percorso che arriva a Qwen — il campo semplicemente non è
cablato affatto: `agent/providers/openai-compat.ts`, l'adapter che parla con
OpenRouter, non manda **mai** un campo `reasoning` o `thinking` nella
richiesta. L'ho letto riga per riga: il corpo della chiamata a
`chat.completions.create` porta `model`, `max_tokens`, `temperature`,
`messages`, e `tools` se presenti — nient'altro. Il commento in testa al file
lo dice da solo: *"What it does not carry: thinking budgets."*

Questo da solo sarebbe già un fatto notabile. Quello che lo rende un vincolo
vero è che Qwen3.8-27B **ragiona per default**: il campo `reasoning` del
catalogo OpenRouter porta `default_enabled: true, default_effort: "xhigh"` —
lo sforzo più alto disponibile — e la scheda HuggingFace lo conferma in prosa,
indipendentemente: *"Qwen3.8 models operate in thinking mode by default."*
Due fonti indipendenti, stesso fatto. Non mandare nulla, per questo modello,
non significa "thinking spento": significa "thinking al massimo sforzo,
implicito, mai dichiarato nel trace."

Ho controllato se una correzione recente lo risolva. Esiste: ADR-0037 ("Il
ragionamento torna indietro, e il budget non esiste più", accettato
2026-08-13), ma vive solo su `slice/gateway`, non ancora in `dev` — quindi non
è il codice che questa ricerca deve descrivere come "oggi", ma è troppo
rilevante per ignorarlo. E anche lì, il buco specifico non si chiude: la
sezione "Alternative scartate" dell'ADR nomina esplicitamente l'idea e la
scarta, con la ragione scritta: *"Attivare il reasoning su OpenRouter in
questa slice. È opt-in lì e costa token che oggi non paghiamo: è una decisione
con un prezzo, non una correzione di correttezza, e infilarla qui l'avrebbe
resa invisibile."* È una scelta onesta — non nascondere un costo dentro una
correzione di bug — ma il risultato pratico è che **nessuna versione del
codice, oggi, sa dire a Qwen3.8-27B di ragionare meno o di non ragionare**, sul
percorso che qualunque installazione userebbe per raggiungerlo.

Da qui l'aritmetica (fonte primaria, la documentazione di OpenRouter sui
reasoning token, letta direttamente — non un riassunto): il budget riservato
al ragionamento è `max(min(max_tokens × effort_ratio, 128000), 1024)`, con
`effort_ratio = 0.95` per lo sforzo "xhigh". `agent/loop.ts` fissa
`maxOutputTokens: 4096` per **ogni** turno, di ogni profilo, senza eccezioni —
non è una scelta per Qwen, è la stessa riga che gira per tutti. Con questi due
numeri: `4096 × 0,95 ≈ 3891` token riservati al ragionamento, **circa 205
token liberi per la risposta vera o la tool-call**. La stessa documentazione
OpenRouter dice che `max_tokens` "deve essere strettamente maggiore" del
budget di ragionamento perché resti qualcosa per la risposta finale — qui lo
è, ma di un margine che sembra pensato per un modello che non ragiona affatto,
non per uno che riserva il 95% dello spazio a se stesso. Non l'ho misurato con
una chiamata reale — costerebbe soldi dell'owner per una risposta che
l'aritmetica sopra rende già prevedibile — ma è una previsione che discende da
tre fatti verificati singolarmente, non un'illazione.

Un'ultima cosa che il profilo dichiara e che qui non è in tensione: la lezione
di ADR-0037 sul `temperature: 0` che diventa un errore 400 su Claude 4.7+
**non si applica a Qwen**. `qwen/qwen3.8-27b` elenca `temperature` fra i suoi
`supported_parameters` con un default dichiarato di `1.0`, non un rifiuto
sotto quella soglia — il vincolo di Anthropic è una regola di quella singola
famiglia di API, non una proprietà generale dei modelli con sampling. Il
`temperature: 0` che `agent/loop.ts` manda sempre non è quindi un rischio noto
per Qwen; il ragionamento non sopprimibile sì.

### 3. Le altre due corsie: cosa è cambiato, e cosa (di proposito) no

Sulla corsia **frontier** — quella che intercetta `*claude-sonnet-5*`,
`*claude-opus-5*`, `*claude-fable-5*`, `gpt-5*` — il catalogo di oggi non porta
niente di nuovo da quei due fornitori: nessun Claude oltre Sonnet 5/Opus
5/Fable 5, nessun GPT oltre la famiglia 5.6 già nota dall'8 agosto. È un
risultato negativo, ma verificato, non un'assenza di ricerca: i glob del
profilo restano corretti così come sono.

Intorno a quel perimetro, il catalogo si è mosso: `x-ai/grok-4.6` (12 agosto,
$2/$6 al Mtok, ragionamento **obbligatorio** per default a sforzo "high"),
`google/gemini-3.7-flash` (13 agosto, $0,375/$1,875 al Mtok — il Flash più
economico di sempre, ma anche lui a ragionamento **obbligatorio** per
default), `deepseek/deepseek-v4-pro-0813` (12 agosto, stesso prezzo del
riferimento A5 di agosto: $0,435/$0,87), `z-ai/glm-5.2` (contesto 1M,
$0,462/$1,452, ragionamento acceso per default). Nessuno di questi tocca i
glob attuali — arriverebbero comunque attraverso lo stesso adapter
`openai-compat` già cablato, perché OpenRouter normalizza il formato a
prescindere dal vendor: aggiungerli come corsia sarebbe un cambio di config
(`--model`), non un adapter nuovo (coerente con ADR-0008: un terzo adapter
solo su bisogno dimostrato). Ma il fatto che valga la pena notare **di più**
di ogni singolo modello: **tre di questi quattro ragionano per default**, e
nessuno di questi default è spegnibile sul nostro percorso, per lo stesso
identico motivo di Qwen3.8-27B. Il buco di §2 non è un caso isolato — è
strutturale, e cresce a ogni generazione nuova, perché ragionare-per-default
sta diventando la norma del campo nel 2026, non l'eccezione.

Sulla corsia **light** — oggi `claude-haiku-4.5`, cablata come default sia nel
percorso Anthropic diretto (`claude-haiku-4-5-20251001`) sia nel percorso
compat (`anthropic/claude-haiku-4.5`), verificato in `cli/init.ts` — non è
uscito niente di nuovo lato Anthropic. Il candidato più vicino a valere
un'occhiata è lo stesso `gemini-3.7-flash` di sopra, ma con la stessa riserva:
ragionamento obbligatorio per default, quindi lo stesso vincolo di §2 si
applicherebbe **anche di più** qui, perché la corsia light gira da sola dopo
ADR-0038/0040 — è consolidamento notturno ed estrazione a ogni episodio, senza
un turno umano che nota il costo prima che si accumuli. Ho verificato dove la
corsia light viene letta (`core/memory/extract.ts`, `core/memory/judge.ts`,
`core/memory/rerank.ts` — tutti e tre chiamano `provider.chat()` con
`temperature: 0` scritto a mano, **nessuno dei tre imposta un campo di
reasoning**): la stessa assenza vista in §2 vale identica qui, e qui il numero
di chiamate al giorno è più alto e meno sorvegliato. Non ho un candidato da
proporre per light in questa ricerca — nessuno dei modelli nuovi visti risolve
il problema che conta (ragionamento sopprimibile), quindi cambiare il
riferimento oggi sposterebbe solo *quale* modello ragiona senza controllo, non
eliminerebbe il rischio.

### 4. Il modello consumer locale è un asse a sé — cosa resta aperto

La decisione in `STATE.md` distingue esplicitamente il modello consumer
*locale* (quello che gira sulla macchina dell'owner) dalla domanda "possiamo
provarlo su OpenRouter" che l'owner ha posto. Sono davvero due domande
diverse, e vale la pena tenerle separate qui invece di farle collassare
insieme.

Quello che questa ricerca stabilisce è **capability via inferenza ospitata**:
i pesi esistono, il prezzo è noto, il vincolo di profilo è noto. Quello che
**non** stabilisce è come Qwen3.8-27B si comporta quantizzato su hardware
consumer — token/secondo, degrado di qualità a Q4/Q8, footprint di memoria su
un Mac o un mini-PC. `docs/blueprint/research/a5-modelli-economia.md` §3 ha
già la metodologia e i numeri di classe per la fascia dimensionale vicina
(30B-A3B su RTX 5090, Mac M4, Strix Halo); non li ho ri-derivati qui perché
sono ortogonali alla domanda di questa ricerca (Qwen3.8-27B è **denso**, non
MoE come la maggior parte di quei riferimenti — un 27B denso non gira alla
velocità di un 3B attivo, è un profilo di calcolo diverso, e non ho trovato
in questa sessione un benchmark tok/s specifico per un denso 27B quantizzato
su hardware consumer 2026). Provarlo su OpenRouter prima è comunque
l'ordine giusto: verifica se il modello **serve** prima di spendere in
capacità di calcolo per farlo girare in locale — le due domande non vanno
confuse, ma non vanno nemmeno invertite.

### 5. Una nota di metodo che vale la pena portare avanti

Controllando `qwen/qwen3.6-27b` per il tavolo comparativo (sotto, parte
tecnica), il prezzo che l'endpoint aggregato `/models` mostra oggi
($0,60/$3,60) non coincide con quello che `b2-modelli-openrouter-
multimodale.md` aveva registrato l'8 agosto ($0,289/$2,40). Non è stato un
rincaro: interrogando `/models/{id}/endpoints` per lo stesso modello risultano
**nove** fornitori di inferenza indipendenti, con un prezzo che va da
$0,289/$2,40 (Morph, il più economico — lo stesso numero del report dell'8
agosto) a $0,60/$3,60 (CoreWeave, il più caro). L'endpoint aggregato mostra
**un** fornitore, non necessariamente il più economico, e quale fornitore
mostri può cambiare fra un fetch e l'altro. Per `qwen/qwen3.8-27b`
specificamente questo non è un problema — un solo fornitore lo serve oggi
(AkashML, atteso per un rilascio di un giorno), quindi il prezzo aggregato e
quello reale coincidono — ma è la ragione per cui ogni prezzo citato sotto, per
i modelli con più fornitori, riporta il fornitore più economico verificato su
`/endpoints`, non il primo numero incontrato.

### 6. Quanto costerebbe provarlo sui nostri eval

Tre harness, tre risposte diverse. `evals/system/acceptance.test.ts` (M3) **non
chiama mai un modello** — il file lo dichiara da solo (*"No model is called —
every property here is deterministic"*): costo zero, e irrilevante per
confrontare candidati, perché non misura niente che dipenda dal modello.

`evals/floor/run.ts` è il candidato giusto per un primo assaggio: sei scenari
(`sequencing`, `breadth`, `recovery`, `horizon`, `context`, `abstention`), un
turno reale per scenario attraverso il loop vero, e il harness stesso misura
`inputTokens`/`outputTokens` reali per ogni run e li stampa insieme a
un'unità di costo normalizzata a listino Sonnet — pensata apposta per
confrontare modelli diversi senza confondere "modello economico" con
"harness economico" (lo stesso principio di `benchmark-comparabilita-
harness.md`). Il file stesso lo chiama *"a few honest runs, not a sweep"*. Non
ho un numero storico di token per questi sei scenari — non è mai stato
eseguito su Qwen in questa sessione, e non l'ho eseguito io — ma la struttura
(system prompt di Muffin, ~19KB di testo fra `persona.md`, `voice.md`,
`identity.md`, più fino a 10 schema di tool per il profilo consumer-local, più
alcuni passaggi di tool-call per scenario) rende plausibile un ordine di
grandezza fra 1.000 e 4.000 token di input e 200-800 di output per scenario,
**escludendo il reasoning**. A $0,45/$3,20 al Mtok, sei scenari a un `rep`
starebbero via ampio margine sotto **$0,10** su quella sola base — ma
l'aritmetica di §2 dice che il vero costo dipende da quanti token di
ragionamento il modello consuma prima di rispondere, che quel calcolo non
include e che nessuna fonte letta in questa sessione quantifica per Qwen su
compiti di tool-calling brevi. Il numero vero è quello che il harness stampa
dopo un run reale, non questa stima.

`evals/memory/acceptance.ts` (M2) è più composito: cinque turni sulla corsia
`main` (`ask()`, ognuno un processo separato — `--model qwen/qwen3.8-27b`
sostituirebbe il default `anthropic/claude-sonnet-5` senza toccare una riga,
il file lo dimostra da solo usando `qwen/qwen3.6-27b` come esempio nel proprio
commento d'intestazione) più due chiamate `memory extract` sulla corsia
`light` — la seconda, sul cambio di commercialista, per costruzione dello
scenario dovrebbe attivare anche il giudice di contraddizione
(`core/memory/ingest.ts`), quindi realisticamente 5 chiamate main + almeno 3
chiamate light per un passaggio completo. Puntare `main` su Qwen3.8-27B qui
userebbe la corsia consumer-local per l'intero test di accettazione memoria,
non solo per un tool-call isolato — un segnale più realistico del vincolo di
§2 rispetto al floor eval, ma anche più costoso se il buco sul reasoning si
manifesta su cinque turni invece che sei scenari brevi.

### Raccomandazione

**Primo passo, budget quasi nullo**: `evals/floor/run.ts --model
qwen/qwen3.8-27b --reps 1`, sulla corsia consumer-local (è dove il profilo lo
mette già, senza modifiche). Sei chiamate reali, il harness stesso riporta
token e unità di costo — l'ordine di grandezza atteso è sotto il dollaro anche
se il reasoning gonfia l'output di qualche multiplo. **Non** sulla corsia
light: il modello ragiona per default e la light gira senza supervisione, il
posto sbagliato per scoprire un buco di cablaggio.

**Cosa guardare nel risultato, non solo se passa**: `outputTokens` per
scenario. Se è nell'ordine delle centinaia coerente con risposte brevi, il
buco di §2 non sta mordendo (forse il modello si auto-limita nonostante il
default, o l'harness gli lascia margine sufficiente). Se `outputTokens` è
vicino al tetto di 4096 per turno, o se scenari con tool-call falliscono per
`max_tokens` esaurito, quella è la conferma empirica dell'aritmetica di §2 —
e a quel punto la domanda successiva non è più "Qwen3.8-27B è abbastanza
bravo", è "vogliamo scrivere il cablaggio del reasoning per openai-compat
prima di valutare qualunque modello che ragiona per default", perché senza
quello ogni confronto misura il buco, non i modelli.

**Cosa mi farebbe cambiare idea**: un secondo fornitore che serva
`qwen3.8-27b` a un prezzo sostanzialmente diverso (oggi un solo fornitore,
nessun'ancora); un run reale che mostri `outputTokens` bassi nonostante
`default_effort: xhigh` (vorrebbe dire che la mia lettura dell'aritmetica
OpenRouter non si applica come previsto a questo specifico endpoint); o la
conferma primaria (non aggregata) della restrizione geografica di §1 — in tal
caso la licenza, non il reasoning, diventerebbe il vincolo che chiude la
porta, indipendentemente da quanto il modello sia bravo.

---

## Parte tecnica — English, ASD-STE100

### 1. OpenRouter catalogue, live data, 2026-08-15

The Qwen model `qwen/qwen3.8-27b` exists on the public OpenRouter catalogue.
`GET https://openrouter.ai/api/v1/models` requires no key and returned 413
models at fetch time, up from 338 on 2026-08-04. `GET /api/v1/models/
qwen%2Fqwen3.8-27b-20260814/endpoints` lists inference providers per model;
prices below use the cheapest verified provider where more than one exists.

**Qwen 3.8 27B — full record.**

| Field | Value | Source |
|---|---|---|
| id / canonical slug | `qwen/qwen3.8-27b` / `qwen/qwen3.8-27b-20260814` | `/models` |
| Created (OpenRouter) | 2026-08-14T15:55:10 UTC | `/models`, field `created` |
| `hugging_face_id` | `Qwen/Qwen3.8-27B` | `/models` |
| License | Apache 2.0 | HuggingFace model card |
| Architecture | Dense, 27B parameters | HuggingFace model card |
| Modality | text + image + video → text | `/models`, `architecture.modality` |
| Context length | 262,144 tokens native (HF card states extensible to 1,000,000) | `/models`, HF card |
| Max completion tokens | 131,072 | `/models`, `top_provider` |
| Price, input | $0.45 / Mtok | `/models`, `pricing.prompt` × 1e6 |
| Price, output | $3.20 / Mtok | `/models`, `pricing.completion` × 1e6 |
| Inference providers | 1 (AkashML) | `/endpoints` |
| `reasoning.default_enabled` | `true` | `/models` |
| `reasoning.default_effort` | `xhigh` | `/models` |
| `reasoning.mandatory` | `false` | `/models` |
| `default_parameters` | `temperature: 1, top_p: 0.95, top_k: 20` | `/models` |
| `supported_parameters` | includes `temperature`, `top_p`, `top_k`, `tools`, `tool_choice`, `structured_outputs`, `reasoning`, `reasoning_effort`, `include_reasoning` | `/models` |

**Comparison table, 20-40B open-weight candidates, live prices 2026-08-15.**
Price columns show the cheapest verified provider from `/endpoints` where the
model has more than one; single-provider models show that one price.

| Model | Arch. | Ctx | Price in/out per Mtok | License | Reasoning default | Providers |
|---|---|---|---|---|---|---|
| `qwen/qwen3.8-27b` | Dense 27B | 262K | $0.45 / $3.20 | Apache 2.0 | on, `xhigh` | 1 |
| `qwen/qwen3.6-27b` | Dense 27B | 262K | $0.289 / $2.40 | Apache 2.0 | on, effort unset | 9 |
| `qwen/qwen3.5-27b` | Dense 27B | 262K | $0.195 / $1.56 | Apache 2.0 | not mandatory, `default_enabled` absent | not checked |
| `qwen/qwen3.6-35b-a3b` | MoE 35B/3B active | 262K | $0.14 / $1.00 | Apache 2.0 | on, effort unset | not checked |
| `google/gemma-4-26b-a4b-it` (incumbent) | MoE 25B/3.8B active | 262K | $0.07 / $0.34 | Apache 2.0 | **off** by default | 8 |
| `openai/gpt-oss-20b` | MoE 21B/3.6B active | 131K | $0.03 / $0.13 | Apache 2.0 | **mandatory**, `medium` | not checked |
| `mistralai/mistral-small-3.2-24b` | Dense 24B | 256K | $0.094 / $0.25 | Apache 2.0 | not a reasoning model | not checked |
| `z-ai/glm-4.7-flash` | MoE ~30B/3B active | 203K | $0.06 / $0.40 | MIT | on, effort unset | not checked |

`gemma-4-26b-a4b-it` is the only candidate in this table with reasoning **off**
by default. This is a code-relevant fact, not a capability ranking — see §2
below.

**Adjacent releases, last 14 days, checked for reasoning defaults because that
is the property this research treats as decision-relevant.**

| Model | Created | Price in/out per Mtok | Reasoning default |
|---|---|---|---|
| `x-ai/grok-4.6` | 2026-08-12 | $2.00 / $6.00 | **mandatory**, `high` |
| `google/gemini-3.7-flash` | 2026-08-13 | $0.375 / $1.875 | **mandatory**, `medium` |
| `deepseek/deepseek-v4-pro-0813` | 2026-08-12 | $0.435 / $0.87 | not mandatory, `high` |
| `z-ai/glm-5.2` | (recent) | $0.462 / $1.452 | on by default, `high` |
| `qwen/qwen3.8-2.4t-a95b` | 2026-08-12 | $2.00 / $6.00 (+ $0.25 cache read) | **mandatory**, `xhigh` |

No new Anthropic or OpenAI model appeared on the catalogue in the last 14
days. `frontier.json`'s glob set (`*claude-sonnet-5*`, `*claude-opus-5*`,
`*claude-fable-5*`, `gpt-5*`) needs no update on the vendor axis as of this
date.

### 2. Codebase constraints, verified by file and line (against `origin/dev` @ `947b076`)

| Finding | File : line | What it says |
|---|---|---|
| `qwen3.8-27b` matches `consumer-local` | `agent/profiles/consumer-local.json:4` | `"match": ["*gemma*", "*qwen3*", "*gpt-oss*", "*mistral-small*", "*glm-*"]` — substring `qwen3` matches, no code change needed |
| Match is a substring, not a prefix | `agent/profiles/profile.ts:118-121` | `globMatch` turns `*` into `.*`, anchors `^...$`, case-insensitive — the provider prefix (`qwen/`) does not block a match |
| The OpenRouter adapter never sends a reasoning field | `agent/providers/openai-compat.ts:93-108` | Request body carries `model`, `max_tokens`, `temperature`, `messages`, optional `tools`/`tool_choice` only. Header comment, line 20-21: "What it does not carry: thinking budgets." |
| `maxOutputTokens` is hardcoded for every turn | `agent/loop.ts:355-356` | `maxOutputTokens: 4096, temperature: 0,` — unconditional, not read from the profile |
| ADR-0037 exists but is not merged | `docs/blueprint/adr/0037-il-ragionamento-torna-indietro.md`, commit `6d2cd214` | Present on branch `slice/gateway` only; `git merge-base --is-ancestor` against `origin/dev` returns false |
| ADR-0037 explicitly declines to wire OpenRouter reasoning | ADR-0037, section "Alternative scartate" | States enabling reasoning on OpenRouter was considered and rejected for that slice, as a priced decision, not a correctness fix |
| Internal budget table under-prices the `qwen3` family | `core/budget/pricing.ts:29` | `['qwen3', { inputPerMTok: 0.1, outputPerMTok: 0.3 }]` — a flat rate for any model id containing "qwen3". Real `qwen3.8-27b` output price is $3.20/Mtok, over 10× the hardcoded figure |
| Light lane has the same gap as main | `core/memory/extract.ts:157`, `core/memory/judge.ts:135`, `core/memory/rerank.ts:84` | Each sets `temperature: 0` directly on the `ChatCall`; none sets a reasoning field |
| Light lane bypasses the profile system entirely | `agent/runtime.ts:131` (profile selection keys off `config.models.main` only); confirmed no other call site of `selectProfile`/`loadProfiles` outside `agent/profiles/` | `maxToolsExposed`, `thinking`, and `sampling` fields never apply to extraction/judge/rerank calls |
| `config.models.deep` is declared but unconsumed | `core/config/config.ts:35` | Schema field exists; no runtime reader found in `agent/`, `core/`, or `cli/` |
| `gpt-oss`'s mandatory "harmony" format is unimplemented | `docs/blueprint/06-modelli.md:24`; zero matches for "harmony" in `agent/`, `core/`, `cli/` | Flagged as an integration risk, not yet resolved in code |

### 3. Reasoning-budget arithmetic for `qwen/qwen3.8-27b` under current code

Source: OpenRouter reasoning-tokens documentation, fetched directly.
Verbatim: *"effort_ratio is 0.95 for max and xhigh effort... budget_tokens =
max(min(max_tokens * {effort_ratio}, 128000), 1024)"* and *"Reasoning tokens
are counted as output tokens for billing purposes."*

```
max_tokens (agent/loop.ts:355)        = 4096
effort_ratio for "xhigh" (OpenRouter)  = 0.95
reasoning budget                       = min(4096 * 0.95, 128000) = 3891
tokens left for the visible answer     ≈ 4096 - 3891 = 205
```

This is a derived consequence of three independently verified facts (the
hardcoded constant, the model's default effort, OpenRouter's published
formula), not a measurement against a live request. No request was sent to
`qwen/qwen3.8-27b` in this research.

### 4. Eval harness cost mechanics

| Harness | Model calls per pass | Model-dependent cost? | Source |
|---|---|---|---|
| `evals/system/acceptance.test.ts` (M3) | 0 | No | File docstring, line 23-24: "No model is called — every property here is deterministic." |
| `evals/floor/run.ts` | 6 scenarios × `reps` (default 1) | Yes — real `inputTokens`/`outputTokens` measured and printed per run, plus a Sonnet-normalised cost unit | `evals/floor/run.ts:174-211`; scenario ids at `evals/floor/scenarios.ts:34` |
| `evals/memory/acceptance.ts` (M2) | 5 main-lane turns + ≥2 light-lane `memory extract` calls (the second likely also triggers the contradiction judge) | Yes — no built-in token/cost report | `evals/memory/acceptance.ts:124,136,142,159,165` (the five `ask()` calls), lines 125 and 143 (`memory extract`) |

Both `evals/floor/run.ts` and `evals/memory/acceptance.ts` accept a
`--model`/`--light-model` flag pointed at any OpenRouter id; `evals/memory/
acceptance.ts`'s own header comment already documents `--model
qwen/qwen3.6-27b` as a usage example, and `evals/floor/run.ts`'s documents the
same. No code change is required to point either harness at
`qwen/qwen3.8-27b`; both require a real `LLM_API_KEY`/`OPENROUTER_API_KEY` and
were not run in this research.

---

## Cosa non si è potuto stabilire

- **Il comportamento reale di Qwen3.8-27B dentro il loop di Muffin.**
  L'aritmetica di §2/parte tecnica §3 è una previsione da fonti primarie, non
  una misura: nessuna chiamata è stata fatta al modello. Costerebbe l'ordine
  di un run `evals/floor/run.ts --reps 1` (sei chiamate) — pochi centesimi
  probabili, ma il punto stesso di questa voce è che non lo so con certezza
  finché qualcuno non lo esegue.
- **La restrizione geografica per Qwen3.8-27B.** Una fonte aggregata
  (Latent Space) riporta che "users flagged" una possibile esclusione di
  USA/UE/UK/Corea; due fonti più dirette che ho letto (la scheda HuggingFace
  del 27B, il file `LICENSE` grezzo del repository fratello 2.4T) non la
  confermano. Non ho trovato una dichiarazione ufficiale Alibaba che risolva
  la tensione. Andrebbe riletta la licenza esatta del 27B (non del Max) prima
  di qualunque adozione oltre un test.
- **Qualità in italiano.** Nessun benchmark pubblico esiste ancora per
  `qwen3.8-27b` specificamente — il modello ha un giorno di vita alla data di
  questa ricerca. Lo stesso vuoto che `b2-modelli-openrouter-multimodale.md`
  §5 aveva già trovato per l'intera famiglia Qwen3.5/3.6 l'8 agosto resta
  aperto, ora esteso al 3.8. L'unico dato interno comparabile resta l'eval
  pairwise Gemma-4 vs GLM-4.7-Flash del 13 giugno, che non include nessun
  modello Qwen.
- **Se il vincolo di temperatura documentato per Claude 4.7+ (ADR-0037) abbia
  un equivalente per Qwen3.8-27B.** I `supported_parameters` del catalogo
  dicono di no (temperature è accettata, con default 1.0, nessun segnale di
  rifiuto sotto soglia) — ma è un'inferenza dai metadati del catalogo, non una
  chiamata che ha verificato l'assenza di un errore.
- **Il costo reale di un passaggio `evals/memory/acceptance.ts` con
  `--model qwen/qwen3.8-27b`.** Ho la meccanica esatta (5 chiamate main + ≥2
  light) e i prezzi esatti, ma non un conteggio di token storico per questo
  specifico harness: la stima in "Quanto costerebbe provarlo" è un ordine di
  grandezza dichiarato come tale, non una misura.
- **Se GPT-OSS-20b, altro candidato consumer-local con reasoning
  obbligatorio, funzioni oggi nel loop.** Il formato "harmony" che richiede è
  citato come rischio non verificato già in `06-modelli.md:24`, e questa
  ricerca non lo ha chiuso — resta un secondo candidato con un vincolo di
  cablaggio distinto, non indagato qui perché fuori dal mandato specifico su
  Qwen.
- **Tok/s e degrado di qualità di Qwen3.8-27B quantizzato in locale**, l'asse
  a sé del "modello consumer di riferimento" (§4). Nessun benchmark hardware
  per un denso 27B specifico è stato trovato in questa sessione; i
  riferimenti di `a5-modelli-economia.md` §3 sono per la classe MoE 30B-A3B,
  un profilo di calcolo diverso.

---

## Fonti, con il motivo per cui contano

- **OpenRouter, `GET /api/v1/models` e `/api/v1/models/{id}/endpoints`**
  (fetch diretto, 2026-08-15, nessuna chiave). Ci interessa perché è la fonte
  di verità primaria per id esatti, prezzi, provider e `supported_parameters`
  — non un aggregatore, il dato che il nostro `openai-compat.ts` consuma
  davvero.
- **HuggingFace, `Qwen/Qwen3.8-27B`** (scheda modello, fetch diretto
  2026-08-15). Ci interessa per la licenza (tag strutturato, non un
  riassunto) e per la conferma indipendente del "thinking mode by default" già
  visto sul campo `reasoning` di OpenRouter — due fonti concordi sullo stesso
  fatto decisivo.
- **HuggingFace, `Qwen/Qwen3.8-2.4T-A95B/blob/main/LICENSE`** (fetch diretto,
  2026-08-15). Ci interessa perché è il testo legale grezzo, non una pagina di
  marketing: ha risolto (parzialmente) la tensione sulla restrizione
  geografica riportata altrove.
- **OpenRouter, documentazione sui reasoning token**
  (`openrouter.ai/docs/guides/best-practices/reasoning-tokens`, fetch diretto
  2026-08-15). Ci interessa perché fornisce la formula esatta
  (`effort_ratio`, `budget_tokens`) che rende l'aritmetica della parte tecnica
  §3 un calcolo e non una stima — è la fonte che chiunque valuti un altro
  modello a ragionamento-per-default dovrà rileggere.
- **Latent Space, "Qwen 3.8 Max(2.4T) and 27B..."** (aggregatore, letto non
  verificato riga per riga sul sito). Ci interessa per il sospetto di
  restrizione geografica e per benchmark di terze parti sul **Max**
  (SWE-bench 87.3%, Vals Index 66.1) — riportati, non misurati, e da non
  confondere con il 27B: nessuno di quei numeri è sul modello che questa
  ricerca valuta.
- **`docs/blueprint/06-modelli.md` §2-bis** (repo, 2026-08-04). Ci interessa
  perché è il documento che questa ricerca aggiorna: diceva "non esiste",
  fissava la data del ricontrollo, ed è il posto dove la prossima slice che
  tocca codice dovrebbe portare il verdetto nuovo.
- **`docs/blueprint/research/b2-modelli-openrouter-multimodale.md`**
  (repo, 2026-08-04). Ci interessa perché è la stessa identica domanda,
  undici giorni prima, con la catena di evidenza che questa ricerca ricalca e
  ribalta — compreso il metodo (endpoint pubblico, non memoria).
- **`docs/blueprint/adr/0037-il-ragionamento-torna-indietro.md`**
  (repo, branch `slice/gateway`, non in `dev`). Ci interessa perché è la
  correzione più recente sullo stesso confine loop↔provider, e perché nomina
  esplicitamente — e rifiuta per ora, con la ragione scritta — il cablaggio
  che risolverebbe il vincolo centrale di questa ricerca.
- **`docs/blueprint/research/benchmark-comparabilita-harness.md`**
  (repo, 2026-08-09). Ci interessa perché fissa la regola che questa ricerca
  rispetta: nessun numero di benchmark citato qui è trattato come un
  confronto valido fra modelli, perché lo scaffold da solo può muovere un
  punteggio di decine di punti a modello invariato.
