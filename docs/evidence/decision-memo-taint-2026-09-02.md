# Decision memo — il taint ambientale come segnale di autorità

**Data:** 2026-09-02 · **Stato:** evidence datata, non authority · **Build:** `dev` `1cc7c67`,
installazione reale `dd38d40`.

Commissionata per decidere se il problema misurato il 02/09 sia il numero
(`maxTaint` di `fs.write`) o il modo in cui costruiamo il **decision context** e
separiamo Evidence da Authority. Il bivio owner A/B/C su `docs/work/day1/critical-path.md`
è **sospeso** finché questa domanda non ha una risposta sperimentale.

## 0. Cosa questo memo aggiunge, e cosa non riapre

La domanda è **già registrata come aperta** in casa, dal 29/08:

- `docs/SECURITY.md:404-417` — *"Ambient context taint is the incumbent authority
  signal, and its precision is an open question — not a settled one."* Con la
  barra di falsificazione: un modello task/action-flow può sostituirlo *"only if
  a comparative evaluation demonstrates better utility without material security
  regression, and an ADR written before that comparison exists would be deciding
  the question instead of answering it."*
- `docs/evidence/runtime-foundations-challenge-2026-08-29.md:56-128` — la
  decomposizione dello scalare in sei proprietà e le tre candidate A/B/C.
- `docs/history/design-notes/security-v2-eval-contract-2026-08-29.md` — il
  contratto di eval, 388 righe, con adapter A/B/C e metriche predichiarate.
- `docs/evidence/design-study-ledger-2026-09-02.md:277-300` — `[FINDING]` lo
  scalare è troppo grossolano; `[DESIGN CANDIDATE]` *"Il taint dovrebbe limitare
  dove l'influenza può propagarsi, non paralizzare tutto ciò che viene dopo"*;
  `[OPEN HYPOTHESIS]` la sostituzione richiede eval comparativo.

Quindi questo memo **non propone una nuova architettura**: quel lavoro esiste.
Aggiunge tre cose che il 29/08 non aveva, e che cambiano dove va speso il tempo:

1. la misura di **parità fra superfici** (02/09, binario vero);
2. la misura del **giro in un turno solo**, che esclude la riforma del contesto
   come riparazione sufficiente;
3. l'**asimmetria di sink** ricostruita sul codice, che trasforma l'argomento da
   «il taint è scomodo» in «il taint sorveglia la porta sbagliata».

## 1. Problema osservato

### 1.1 Non è una divergenza di superficie

`evals/acceptance/scenarios/b-parita-superfici.accept.ts`, binario vero, stesso
principal, stesso tenant, stessa history, stessa richiesta:

| superficie | sessione | taint | codice | scritto |
|---|---|---|---|---|
| `run --session parita` | `parita` | 2 | `taint_exceeded` | no |
| `repl` | una per lancio | 2 | `taint_exceeded` | no |
| telegram, gateway vivo | `telegram:<chatId>` | 2 | `taint_exceeded` | no |
| `run`, sessione nuova | per invocazione | 0 | — | **sì** |
| `run`, **un turno solo** | per invocazione | 2 | `taint_exceeded` | no |

Il kernel è identico ovunque. La sola variabile è la **vita della sessione**:

> Surface-specific session lifetime → different context → different ambient taint.

Telegram tiene una sessione per chat, quindi la history reiniettata (finestra 40,
`agent/context/history-taint.ts`) porta il turno a 2 prima che l'owner scriva —
17 messaggi tier-2 su 40 nella sessione reale. La CLI sembrava sana per amnesia,
non per sicurezza: apre una conversazione nuova a ogni invocazione.

**Ma l'ultima riga chiude la scorciatoia.** `leggi → scrivi` dentro un solo
turno, su una sessione appena aperta e senza un byte di history, è ugualmente
`taint_exceeded`: il taint sale **dentro** il turno alla lettura (`DISK_TIER` =
2, `agent/tools/fs.ts:86`) e il soffitto di classe di chi scrive è 1. Nessuna
riforma di *quale* conversazione viene reiniettata — una `Conversation` distinta
dalla `Surface`, la context minimization — può da sola aprire questo percorso.

### 1.2 Lo scalare porta sei significati

Ricostruzione del 29/08 (`runtime-foundations-challenge:56-70`), confermata sul
codice oggi. `core/policy/types.ts:33-37` lo dichiara apertamente: *"One scale
for both data and policy, deliberately"*. Quel numero solo deve rappresentare
provenienza, sensibilità, influenza sul control flow, autorità, rischio
dell'effetto e flusso di egress. Un `max()` sul contesto non le distingue.

Il controesempio canonico è dell'owner: *"leggi la doc di Vitest, poi lancia i
test"* — la decisione di lanciare i test è arrivata **prima** della pagina.

### 1.3 L'asimmetria di sink (nuova, e la parte che pesa)

Ricostruita su HEAD. Il kernel non ha una tassonomia dei sink: ha un `Resource`
(`path | url | query | tenant | none`, `core/policy/types.ts:43-56`) e ramifica
su quello. Il risultato, per lo stesso turno a taint 2:

| effetto | capability | classe · soffitto | dove finiscono i byte | esito a taint 2 |
|---|---|---|---|---|
| scrivere un file nello scope | `fs.write` | medium · 1 | disco locale, con checkpoint e `undo` | **DENY** |
| allegare quel file in chat | `surface.send_file` | medium · 1 | la chat dell'owner | **DENY** |
| leggere una skill installata | `skill.read` | · 1 | niente esce | **DENY** |
| eseguire un comando | `sys.shell` | high · **2** | disco locale, **senza journal** | ASK |
| **scrivere la risposta in chat** | *nessuna* | — | la chat dell'owner | **libero, a qualunque taint** |
| **scrivere un episodio di memoria** | *nessuna* | — | store durevole del tenant | **libero** |

Le ultime due righe non passano dal kernel. La risposta esce da
`SurfaceRegistry.deliver(channel, text)` (`core/surface/registry.ts:48`) senza
nessuna decisione; l'episodio è scritto direttamente da `agent/loop.ts` e viene
solo *etichettato* con `intrinsicTaint()`. `outward.send` esiste unicamente come
nome nelle deny list, a guardia di una capability non ancora costruita
(`core/policy/matrix.ts:148`).

Due conseguenze, entrambe verificabili:

- **Il gate più stretto sta sulla porta più innocua.** `fs.write` è locale,
  confinata dallo scope e *reversibile per costruzione*; è l'unica porta con il
  journal, ed è quella chiusa. La porta aperta a taint 2 è la shell, che scrive
  sullo stesso disco senza pre-immagine.
- **Il canale che un'iniezione userebbe davvero non è sorvegliato.** A taint 2 il
  modello non può allegare un file letto, ma può **ricopiarne il contenuto nel
  testo**. `agent/tools/deliver.ts:43-52` dichiara le due cose la stessa classe
  di fiducia — *"same trust class as replying with more text on the same
  channel"* — e il codice le tratta in modo opposto.

Nel threat model quella scelta ha una ragione: il destinatario è l'owner, non un
terzo, e la riga «Outward» riguarda *nuovi* destinatari
(`docs/history/rebuild-2026/03-threat-model.md:46`). La ragione è buona e non è
implementata: è una regola sul **sink**, scritta in prosa, mentre il kernel
decide su un numero che descrive la **provenienza**.

### 1.4 Cosa costa, misurato

Sull'installazione reale, 165 turni: 0 `fs_write`, 0 `surface.send_file`,
0 `http_get`, 0 `web_search`. La porta usata per scrivere è la shell.

## 2. Threat model: cosa deve restare vero

Da `docs/history/rebuild-2026/03-threat-model.md` e ADR-0044/0045/0046.

La trifecta è reale: dati privati dell'owner, contenuto non fidato, strumenti con
effetti ed egress. Nessuna gamba si rimuove; si scopano i dati per tenant, si
tassa la fiducia, si chiude l'egress, si mette HITL sull'irreversibile, si traccia
(`:15`). La catena che deve restare chiusa è **lettura → egress verso una
destinazione scelta dal contenuto**, non «lettura → qualunque effetto».

Attaccante: chi può mettere byte davanti a Muffin — una pagina, un file scaricato,
un messaggio di gruppo, un documento inoltrato, un risultato MCP, un episodio di
memoria avvelenato. Non è nel modello la compromissione dell'host (`:113`), e
restano dichiarati residui l'esfiltrazione verso un dominio in allowlist e il
proxy locale raggiungibile da altri processi dello stesso utente (`:117-118`).

Il filesystem locale non ha provenienza: `~/appunti.md` scritto dall'owner e
`~/Downloads/fattura.pdf` arrivato da uno sconosciuto hanno lo stesso `stat`
(ADR-0044:60-63). Questa parte non è in discussione ed è la ragione per cui il
tier della *lettura* non va abbassato.

## 3. Cosa fanno i peer

Fonti primarie, lette il 02/09.

| sistema | gate primario | contenuto non fidato | numeri dichiarati |
|---|---|---|---|
| **CaMeL** (arXiv 2503.18813v2) | capability **per valore** — `sources` + `readers` — e policy Python valutate **prima di ogni tool call**, sulle dipendenze degli argomenti | un LLM privilegiato scrive il piano e non vede mai i dati; un LLM in quarantena li tocca senza tool | AgentDojo 77% task risolti *con sicurezza dimostrabile* vs 84% senza difesa; **2,82× token in input**; attacchi ridotti a ~0 |
| **Progent** (arXiv 2504.11703) | policy simbolica per tool call, generata dal task e ristretta a runtime; ogni aggiornamento è narrowing automatico o expansion con approvazione (*monotonic confinement*) | non lo etichetta: limita lo spazio d'azione al task | ASR **39,9% → 1,0%** su AgentDojo, utility mantenuta; solo **6%** degli aggiornamenti chiede conferma |
| **Design patterns** (arXiv 2506.08837) | sei pattern: action-selector, plan-then-execute, map-reduce, dual LLM, code-then-execute, **context minimization** | principio: *"once an LLM agent has ingested untrusted input, it must be constrained so that it is impossible for that input to trigger any consequential actions"* | nessuna difesa singola basta; si combinano |
| **Claude Code** | regole **per tool e per argomento** (allow/ask/deny), default read-only, **confine della working directory**, comandi di rete mai auto-approvati, classificatore separato in auto mode | `WebFetch` gira in un **context window isolato**; verifica di fiducia per cartella e per server MCP | — |
| **Claude in Chrome** | permessi per sito + conferma obbligatoria sulle azioni ad alto rischio + probe sul contenuto letto + classificatori appena prima dell'esecuzione | probe che avvisano il modello e fanno chiedere conferma | ASR **23,6% senza mitigazioni → 11,2%**; con i tre strati, **0–1%** |
| **OpenAI Atlas** | *watch mode* (conferma esplicita sulle azioni sensibili), *logged-out mode* (togliere l'autorità invece di filtrare i dati), training avversariale | — | dichiarato pubblicamente *"unlikely to ever be fully solved"* |
| **OpenClaw** | **identità prima**: pairing/allowlist decidono chi può istruire l'agente; payload sempre non fidati, dentro marcatori `EXTERNAL_UNTRUSTED_CONTENT` | ammette il limite: i controlli sul richiedente *"do not authenticate or sanitize other content in that model prompt"* | strategia dichiarata: limitare il blast radius, non fidarsi del prompt |

**Il risultato che conta: nessuno di questi sistemi usa uno scalare ambientale
monotòno sull'intera conversazione come gate primario.** Gatano (a) chi può
istruire, (b) quale azione su quale risorsa, (c) verso quale destinazione, e
(d) tengono i byte non fidati fuori dal contesto che decide. Muffin è l'unico che
fa dipendere il permesso di scrivere un file locale dal tier massimo di
*qualunque cosa sia presente* nel contesto.

Due controprove che vanno registrate insieme:

- CaMeL dichiara i propri limiti: onere di scrivere e mantenere le policy,
  affaticamento da conferme, canali laterali, e *"prompt injection attacks are
  not fully solved"*.
- La difesa più semplice può bastare più di quanto la letteratura suggerisca:
  arXiv 2510.05244 mostra che un firewall input/output al confine agente-tool
  **satura i benchmark pubblici** e conclude che gli attacchi in essi sono deboli.

## 4. Proprietà da preservare

Non negoziabili, e ognuna ha già una casa:

1. **L'autorità non deriva mai dal contenuto.** Solo transport facts autenticati
   stabiliscono identità e routing (ADR-0046; ledger `:302-306`).
2. **Il modello non arbitra la sicurezza.** La decisione resta deterministica e
   fuori dal modello (ADR-0045 `:122-123`).
3. **La history non lava la provenienza.** Un riassunto di contenuto tier-3 è
   tier-3 (`docs/SECURITY.md:95-96`).
4. **La catena lettura → egress verso destinazione scelta dal contenuto resta
   chiusa** (ADR-0044).
5. **Soffitti sigillati, allargabili solo per dichiarazione rivedibile**; RoT
   irraggiungibile a runtime (`core/policy/matrix.ts:198-231`).
6. **Un'approvazione non pulisce il taint** (ledger `:283-284`).
7. **Irreversibile e outward restano HITL.**
8. **La decisione deve saper dire perché.** Oggi `sys_inspect` riporta lo scalare
   ma non la sua causa.

E una proprietà che oggi **non** abbiamo, e che la §1.3 dimostra mancante:

9. **La severità del gate deve essere proporzionale al sink**, non alla sola
   provenienza di ciò che è presente.

## 5. Architetture candidate

Riprendono e restringono le candidate del 29/08.

**A — incumbent: scalare ambientale.** Semplice, monotòno, già implementato,
spiegabile. Costa dinieghi falsi e si autorinforza; la pressione a spostare i
soffitti genera eccezioni. *Il bivio A/B/C sospeso oggi è una variante di questa:
sposta il numero, non l'asse.*

**B — provenienza + sink/effetto.** Si tengono le etichette di provenienza; il
kernel decide su una tupla invece che su un numero: `(classe di effetto × sink ×
chi ha scelto la risorsa × reversibilità)`. Il taint ambientale resta come
fallback conservativo quando il flusso non è ricostruibile. È il minimo che
ripara la §1.3, è la forma che usano Claude Code (confine della directory) e
Progent (least privilege per azione), e ha già mezzi pezzi in casa: `Resource`,
`paramsMaxTaint`, l'allowlist di egress. Costo: una tassonomia dei sink nel
kernel e `outward.send` finalmente costruita, cioè far passare la risposta e la
scrittura di memoria dal kernel invece che accanto.

**C — capability per valore (forma CaMeL, ristretta).** Etichettare i *valori*
che finiscono negli argomenti di un'azione, non il turno, e far vedere alla
policy quali byte stanno uscendo. Muffin ne ha già una versione in miniatura per
i parametri di query. La forma piena richiede il taglio pianificatore/quarantena
e costa ~2,8× token, più l'onere di scrivere policy: è un cambio del loop, non
del kernel.

**D — disciplina del contesto (complemento, non alternativa).** Evidence ≠
decision context: i byte non fidati entrano per riferimento o come sintesi
prodotta in quarantena, non crudi. Riduce il taint *ambiente* e renderebbe la
sessione Telegram di nuovo pulita — ma la misura §1.1 dimostra che **da sola non
apre `leggi → scrivi`**, perché non tocca il taint che la lettura stessa produce.
Vale come miglioramento di qualità del contesto, mai come riparazione del bivio.

## 6. Quali benchmark pubblici le distinguono

- **AgentDojo** (97 task, 629 casi di sicurezza, quattro domini: workspace,
  banking, travel, Slack) è l'unico comparabile e separa bene le *famiglie*:
  difese di prompt (sandwiching: ASR 30,8%) contro difese strutturali (CaMeL ~0,
  Progent 1,0%, tool filtering 7,5% ma −11 punti di utility).
- **InjecAgent** e **ASB** aggiungono ampiezza, non discriminazione.
- **Il limite, dichiarato in letteratura:** arXiv 2510.05244 mostra che questi
  benchmark si saturano con una difesa semplice e che i loro attacchi sono
  deboli; le classifiche vanno lette come soglia minima, non come ordinamento.
- **Il limite per noi**, già registrato in `docs/evidence/benchmark-comparabilita-harness.md`:
  i domini di AgentDojo non contengono il caso che ci fa male. Non c'è un task
  «leggi un file locale dell'owner e scrivine un altro per lui». **Nessun
  benchmark pubblico distingue A da B**, perché entrambe si comportano identiche
  sul suo corpus: lì l'azione contesa è quasi sempre egress, che in Muffin è già
  chiusa dall'allowlist.

Conclusione onesta: i benchmark pubblici servono a **non regredire** rispetto allo
stato dell'arte e a validare l'harness, non a scegliere fra le candidate.

## 7. Cosa resta davvero da testare su Muffin

Il seam A/B **esiste già** e nessuno lo ha esteso: `evals/security/baseline.ts`
presenta la stessa azione normalizzata due volte, con il taint di produzione e a
taint 0, e `evals/security/scenarios.ts` ne ha sei fissure a livello di reference
monitor. Quello che manca è esattamente quanto segue.

1. **Il terzo adapter.** Candidate B non esiste in nessuna forma eseguibile. Senza
   di esso l'eval misura solo quanto costa il taint, mai se qualcosa lo batte.
2. **Attack success non è mai stato misurato su Muffin.** Le fixture attuali sono
   *policy-only*: dicono dove la decisione cambia, non se un'iniezione riesce.
   Serve un corpus avversariale che giri sul binario, dove il finto provider
   recita l'attaccante — l'harness di accettazione lo regge già.
3. **Le scene di sink mancano tutte.** Nessuno scenario oppone `send_file` alla
   risposta testuale, o mette la scrittura di memoria sotto attacco. Sono
   precisamente le righe che la §1.3 dimostra scoperte.
4. **Le scene misurate il 02/09 vanno nel corpus**: parità fra superfici, giro in
   un turno solo, e il caso «valore esterno dentro un'azione già autorizzata
   dall'owner, senza che scelga una nuova destinazione».
5. **Metriche predichiarate**, dal contratto del 29/08: task success, attack
   success, ask inutili, deny duri inutili, token/chiamate, e capacità di
   spiegare la decisione.

Kill criterion, dal contratto: se B non domina A su attack success a parità di
utility, l'incumbent resta e il bivio A/B/C torna sul tavolo come scelta di
prodotto, non di architettura.

## 8. Raccomandazione

1. **Non toccare il kernel.** Nessun `maxTaint` si muove prima dell'eval. Il bivio
   A/B/C resta sospeso: è la candidate A travestita da decisione dell'owner, e
   spenderebbe la decisione prima dell'esperimento.
2. **Prossima slice: estendere il seam di sicurezza**, profilo CRITICAL — adapter
   B, corpus avversariale sul binario, scene di sink. È l'unico artefatto che
   manca fra noi e una risposta.
3. **Cominciare comunque il dogfood**, con la shell come porta di scrittura (ASK
   dopo una lettura, ADR-0044 §Revisione 16/08). Serve a due cose: l'owner usa
   Muffin, e ogni rifiuto falso finisce nel corpus con una data. Le limitazioni
   restano dichiarate: niente allegati e niente skill nelle sessioni Telegram
   tainted, e la metà di undo di D11 resta irraggiungibile.
4. **Due riparazioni che non spostano semantica** e si possono fare in parallelo:
   far dire alla decisione *perché* (oggi lo scalare si vede, la causa no), e
   portare la risposta e la scrittura di memoria **dentro** il kernel come
   capability dichiarate — anche solo per poterle misurare. La seconda cambia
   cosa è osservabile, non cosa è permesso; se cambiasse un permesso, è già §5-B
   e aspetta l'eval.
5. **DAY-1 non è READY** e la ragione cambia nome: non «l'owner deve scegliere un
   soffitto», ma «il segnale di autorità è un'ipotesi non ancora falsificata, e
   il gate non è proporzionato al sink».

## Cosa farebbe cambiare idea

- Se l'eval mostra che B (nessun taint ambientale) ha lo stesso attack success di
  A, il taint ambientale non paga la sua complessità e va demolito, non regolato.
- Se una candidate sink-aware alza l'attack success anche di un caso, l'incumbent
  resta e il costo si paga con le conferme.
- Se il corpus avversariale non riesce a produrre **nessun** attacco riuscito
  contro A *né* contro B, allora il vero gate è altrove — allowlist, tenant,
  sandbox — e questo memo ha misurato la cosa sbagliata.
