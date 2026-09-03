# Continuità fra superfici e provenienza del recall — 2026-09-03

**Evidence datata, non authority.** Registra due failure osservati dall'owner
sulla propria installazione il 03/09, la ricostruzione sul codice a `dev`
`c06299f`, cosa fanno i peer (fonti primarie lette il 03/09), la tabella di
decisione richiesta da `docs/RESEARCH.md` §«Write the decision table before
code», e un piano di implementazione per l'opzione raccomandata. Non cambia
niente: l'authority resta in `docs/decisions/` e in `docs/ARCHITECTURE.md`.

Nessun dato privato dell'owner è stato letto o copiato. I due conteggi citati
(204 chunk da episodi `role='user'`, 186 da `role='agent'`) sono **misurati
dall'owner** sulla sua installazione il 03/09 e riportati qui come numeri, non
riprodotti.

## 1. I due failure, come li ha detti l'owner

1. **«Non sembra lo stesso Muffin.»** Parlando dalla CLI non sa niente di ciò
   che è stato detto su Telegram, se non quando gli capita di cercare in
   memoria. Un umano solo, un agente solo, una cosa sola — due conversazioni.
2. **«Le sue parole tornano come prove.»** Verbatim di Muffin nella chat
   dell'owner: «i miei output passati sono archiviati come frammenti di memoria
   … potrei "ricordare" la mia parola passata come se fosse un fatto».

Sono la stessa domanda con due facce: **cosa vede un turno del passato, e di chi
sono quelle parole?** Il §2 misura la prima faccia, il §6 chiude la seconda in
poche righe perché la riparazione è già in corso altrove.

## 2. Lo stato misurato (HEAD `dev` `c06299f`, 2026-09-03)

### 2.1 Chi decide l'id di sessione

| fatto | dove |
|---|---|
| Telegram apre **una sessione per chat, per sempre**, con l'id letterale `telegram:<chatId>` — anche per la chat privata dell'owner | `connectors/telegram/connector.ts:1140`, e di nuovo `:1442` |
| Discord fa la stessa cosa con `discord:<channelId>` | `connectors/discord/connector.ts:374` |
| Il REPL apre una sessione **anonima per lancio**: `open()` senza id genera `YYYY-MM-DD-<8 hex>` | `cli/repl.ts:608` → `core/session/store.ts:63` |
| La CLI headless apre una sessione **usa e getta per invocazione**, `run-<data>-<6 hex>`, salvo `--session` | `cli/run.ts:57` |
| Job dello scheduler e run di osservazione aprono id propri, casuali | `agent/scheduler-run.ts:134,290`, `agent/observe-run.ts:53` |

Conseguenza aritmetica, non opinione: fra la chat privata Telegram dell'owner e
il suo terminale non esiste **nessun** id condiviso, e fra due lanci del REPL
nemmeno — la CLI non ha continuità neanche con sé stessa oltre la finestra del
processo.

### 2.2 Cosa vede un turno del proprio passato

`agent/loop.ts:1541` chiama `reinjectedHistory(deps.sessions.read(input.session),
MAX_HISTORY_TURNS)` con `MAX_HISTORY_TURNS = 40` (`agent/loop.ts:173`).

`agent/context/history-taint.ts:95`:

```ts
const spoken = history.filter((m) => m.role === 'user' || m.role === 'assistant');
const kept = spoken.slice(-maxTurns);
return { kept, dropped: spoken.length - kept.length };
```

Quindi: **le righe `tool` non entrano**, e il taglio tiene gli ultimi 40
messaggi parlati **di quel file di sessione e di nessun altro**. `buildContext`
(`agent/loop.ts:3549`) rende ogni riga come `{ role, content }` nudo: nessuna
marca di superficie, nessuna marca di tier — e non ne ha bisogno oggi, perché
tutte le righe della finestra vengono dalla stessa porta e il `role` del
provider distingue già l'owner da Muffin.

Se `dropped > 0` il modello riceve la riga «*N messaggi precedenti di questa
sessione non sono nel contesto … cercalo in memoria invece di indovinare*»
(`agent/loop.ts:3602`). È l'unico ponte verso il resto del passato, ed è
volontario: dipende dal fatto che il modello decida di cercare.

### 2.3 Cosa cerca il recall, e con quali filtri

`recall()` è chiamato da `agent/loop.ts:1593` con `input.tenant` e due sole
esclusioni: `excludeTurnIds` (i turni già in contesto) ed `excludeEpisodeId` (la
riga appena scritta). **Nessun filtro di connector, di thread, né di ruolo.**

`core/memory/store.ts:764` `searchEpisodes` filtra su `e.tenant_id = ?`, più
`connector`/`since`/`until` **opzionali che il loop non passa mai**, più
l'esclusione dei turni. Non esiste una colonna `role` nella `WHERE`.

Quindi il recall **è già continuo fra superfici** dentro un tenant: la CLI può
ripescare ciò che è stato detto su Telegram. È il motivo per cui l'owner scrive
«se non gli capita di cercare in memoria»: il ponte esiste, ma è lessicale e
vettoriale, cioè si apre solo se la domanda somiglia abbastanza al passato. Un
«come dicevo prima» non somiglia a niente.

### 2.4 Il tenant è già il confine, e non coincide con la superficie

`core/surface/types.ts:241` `identify` è la regola unica che entrambi i
connector attraversano:

- owner in chat **diretta** con id autenticato pari a `ownerUserId` → principal
  `owner`, tenant **`host`**;
- chiunque altro, e l'owner **in un gruppo** → principal `member`, tenant
  `group:<connector>:<conversationId>`.

`cli/repl.ts:857` passa `tenant: 'host'`.

Il fatto che regge tutto il resto di questo documento: **la DM Telegram
dell'owner e la CLI sono già lo stesso tenant `host`**; un gruppo è un tenant
diverso. La separazione che l'owner osserva non è il confine di sicurezza — è
solo l'id di sessione, che nessuna regola condivisa produce.

### 2.5 Come si scrive un episodio dell'agente, e come viene marcato

`agent/loop.ts:2108` scrive la risposta come `role: 'agent'`, `connector:
input.surface`, `threadKey: input.session.id`, `trustTier:
snapshot.intrinsicTaint()` (mai `0` letterale, dal ADR-0044
§Riconciliazione 2026-08-28), `turnId: record.id`.

`core/memory/schema.ts:63` ha già `idx_episodes_tenant_time ON episodes(tenant_id,
created_at)`: una coda cross-superficie ordinata per tempo è già una query
indicizzata, senza migrazione.

### 2.6 L'effetto visibile per l'owner

Con `MAX_HISTORY_TURNS = 40` e un id per porta: venti scambi di storia su
Telegram, venti sul terminale, zero condivisi. Chiedere sul terminale «e quella
cosa di stamattina?» funziona **solo** se il recall pesca — cioè se le parole
della domanda somigliano alle parole di stamattina. Da qui «non sembra lo stesso
Muffin»: non è amnesia, è una porta che possiede una conversazione.

## 3. La decisione esistente, ricostruita

**ADR-0045 — l'unità è l'agente continuo** (accettato 2026-08-16). §1:

> Muffin è un solo agente. Turni, sessioni, job e processi sono unità di lavoro;
> CLI, chat, voce e device sono porte. […] Nessuno di questi può possedere una
> persona, una memoria o una policy separata.

E il suo criterio di falsificazione, verbatim: *«la decisione va rivista se …
cambiare modello o superficie spezza identità, memoria, policy o lavoro»*.
Il failure 1 **è** quel criterio che scatta. Non serve un ADR nuovo per
giustificare il cambiamento: serve applicare quello che c'è.

La Revisione 2026-08-17 dello stesso ADR nomina già la cucitura per nome:

> **`SessionStore`** sembra Evidence ma è usata direttamente come Context, e
> perde la provenienza … la direzione è che il contesto legga l'evidenza con
> provenienza e tier, non un trascritto crudo.

**Vincoli di sicurezza** (`docs/SECURITY.md` §3 «Principals and tenant
boundary», §4 «Provenance and taint»):

- l'autorità viene dall'identità di trasporto, mai dal contenuto — quindi il
  confine che **non si può toccare** è tenant/principal, non l'id di sessione;
- «History must preserve the taint of content that is reinjected later. A
  session transcript is not a trust laundromat»;
- «Speaker/actor metadata must also survive recall: "trusted" is not equivalent
  to "the owner said this"».

**ADR-0044 §Revisione 2026-08-17 e §Riconciliazione 2026-08-28**: la history
reiniettata alza il **soffitto** del turno (`raiseCeiling`,
`agent/loop.ts:1673`) e non il suo taint intrinseco — quindi la provenienza non
si lava, ma nemmeno si accumula a cricchetto sulle risposte pulite successive.

**ADR-0051**: il modello non sceglie tenant, speaker, taint o stato canonico;
un'inferenza nata da contenuto tier 3 non diventa tier 0 perché Muffin l'ha
riscritta con parole proprie.

### Cosa è sicurezza e cosa è solo «com'è costruito»

| regola | natura |
|---|---|
| un tenant `group:*` non si fonde mai con la conversazione privata dell'owner | **sicurezza**, `SECURITY.md` §3 |
| i byte reiniettati alzano il soffitto del turno | **sicurezza**, `SECURITY.md` §4 + ADR-0044 |
| il recall dice **chi** ha detto una cosa, non solo quanto vale | **sicurezza**, `SECURITY.md` §4 |
| `replyChannel` / `replyTo.channel` restano `telegram:<chatId>` qualificati | **sicurezza operativa**: è l'indirizzo di consegna, non l'identità della conversazione (`connector.ts:1176`) |
| l'id di sessione è la stringa `telegram:<chatId>` | **com'è costruito**. Nessun ADR lo richiede; nasce dal commento «One session per chat, so a conversation continues where it left off and two chats never share one» |
| il REPL apre un id casuale per lancio | **com'è costruito**, `cli/repl.ts:30` |
| `MAX_HISTORY_TURNS = 40` | **com'è costruito**, un letterale senza ADR |

## 4. I peer, confrontati per problema (fonti lette il 2026-09-03)

**Il problema: una identità sola su più canali.**

- **OpenClaw**, `docs.openclaw.ai/concepts/session` — quattro valori di
  `session.dmScope`: `main` (**default**) «All DMs share the main session»;
  `per-peer` «isolate by sender, across channels»; `per-channel-peer` «isolate
  by channel + sender (**recommended**)»; `per-account-channel-peer`. I gruppi
  hanno un asse separato, `session.groupScope`, con `per-group` come default —
  quindi **DM continue e gruppi separati è esattamente la forma che OpenClaw
  spedisce di default**. `session.identityLinks` mappa id per-provider a una
  identità canonica «so the same person shares a DM session across channels».
  Nota adversariale, e non è piccola: la modalità che i loro stessi documenti
  marcano *(recommended)* è quella **isolata**, non quella continua.
- **Zep**, `help.getzep.com` — la memoria è scopata sull'utente, non sul thread:
  «Each user has a user graph and thread history», e «By default, all messages
  added to any thread of that user are ingested into that user's graph». Cioè:
  thread separati per la history, **grafo unico per l'utente** per il recall.
  È letteralmente la forma che Muffin ha già (§2.3 e §2.4): tenant unico per il
  recall, thread separati per il trascritto. Zep dunque **non** è evidenza a
  favore di fondere le sessioni — è evidenza che il pezzo che Muffin ha già è
  quello giusto, e che il pezzo mancante è dove il contesto viene *composto*.
- **Hermes Agent**, `NousResearch/hermes-agent`, `website/docs/user-guide/features/memory.md`
  (`main`, letto il 03/09) — «Memory is scoped per profile by design»; e la
  distinzione che conta per noi: «Memory is for critical facts that should
  always be in context. Session search is for "did we discuss X last week?"».
  La sessione resta per-canale; la continuità la porta il profilo e la ricerca
  sulle sessioni. Hermes è quindi il peer **contro** la fusione degli id.

**Il problema: l'output dell'agente che rientra come prova.** Nessuno dei tre
peer letti documenta un filtro di ruolo sul recall. Zep non dice se e come
tratti i messaggi assistant; Hermes indicizza tutta la history di sessione in
FTS5 senza distinguere ruolo nella documentazione utente. Muffin, con
`describeEpisodeSource` (§6), è **avanti** ai peer letti su questo punto, non
indietro: è un risultato che vale la pena registrare perché contraddice
l'istinto di andare a copiare qualcuno.

Limite dichiarato: le pagine OpenClaw e Zep lette non portano una data né una
versione visibile; Hermes è citato al ramo `main` alla lettura del 03/09. Non ho
letto il **sorgente** di nessuno dei tre, solo la documentazione primaria.

## 5. La tabella di decisione

Failure misurato: *fra la DM Telegram dell'owner e la CLI non esiste nessun id
di sessione condiviso (`connector.ts:1140` vs `repl.ts:608`), quindi la
finestra reiniettata di un turno non contiene mai ciò che è stato detto
sull'altra porta, e l'unico ponte è un recall che si apre solo per somiglianza
lessicale o vettoriale.*

Invariante da non rompere: tenant e principal restano il confine
(`SECURITY.md` §3); i byte reiniettati alzano il soffitto (§4).

| | cosa fa | evidenza a favore | contro-evidenza / guasti noti | conseguenze sicurezza / privacy / durabilità | cosa la falsifica |
|---|---|---|---|---|---|
| **A** — sessioni per superficie, si migliora il recall (bias di recency, coda temporale sempre inclusa) | nessun id cambia; `recall()` riceve una coda per tempo oltre ai match | il recall è già cross-superficie e tenant-scopato (§2.3): il cambiamento è locale a un file | non risolve il failure osservato: «come dicevo prima» resta a carico di una euristica di ranking. Aggiunge un secondo meccanismo che decide *cosa è recente* accanto a `reinjectedHistory` che già lo decide — due tagli della stessa cosa, la classe di difetto che `history-taint.ts` è stato scritto per togliere | invariata la sicurezza; ma il taint entra per una via in più, e `recallTaint` usa `raiseTaint` (non `raiseCeiling`), quindi una coda temporale *marcherebbe* il turno invece di limitarlo soltanto — peggio del soffitto | l'owner riprende un discorso dall'altra porta senza nominarlo e la coda temporale lo porta comunque, per tre giorni di dogfood |
| **B** — **una conversazione continua per il tenant dell'owner**, gruppi separati | l'id di sessione diventa una funzione di `identify`: `owner` per il principal owner, la stanza per un `member` | ADR-0045 §1 e il suo criterio di falsificazione (§3); il tenant è già `host` su entrambe le porte (§2.4), quindi non si sposta nessun confine; OpenClaw spedisce esattamente questa forma come default (§4); il fix è ~5 righe più una funzione | l'onere di prova più alto: `evals/acceptance/scenarios/b-parita-superfici.accept.ts` ha **isolato la vita della sessione come l'unica variabile** che faceva divergere il kernel fra superfici — fonderla significa che un `fs_read` su Telegram alza il soffitto del turno CLI successivo, cioè **più ASK**. Hermes tiene le sessioni per canale (§4). E `/new` da una porta archivia la conversazione dell'altra | il confine di sicurezza **non si muove**: `host` era già `host`. Il soffitto cross-superficie è la regola di `SECURITY.md` §4 che finalmente si applica dove i byte vanno davvero, non un buco nuovo. Durabilità: i file di sessione vecchi restano leggibili, nessuna migrazione di schema |  dopo una settimana di dogfood gli ASK sulla CLI attribuibili a taint ereditato da Telegram superano in numero le volte in cui la continuità è servita; **oppure** la finestra da 40 si riempie della chiacchiera dell'altra porta e taglia il filo di quella in uso |
| **C** — coda cross-superficie senza fondere le sessioni | la sessione resta per porta; `buildContext` riceve in più le ultime *k* righe di **Evidence** del tenant, ordinate per tempo, ciascuna con speaker, superficie e tier | è la direzione già scritta in ADR-0045 §Revisione 17/08 («il contesto legga l'evidenza con provenienza e tier, non un trascritto crudo»); Zep è esattamente questa forma (§4); `idx_episodes_tenant_time` esiste già (§2.5); non tocca `/new`, i todo, né la concorrenza | è la slice più grande delle tre: un metodo di store nuovo, un ordinamento nuovo, e soprattutto la **deduplica** fra la coda e la finestra propria (le stesse righe sono in entrambe, con `turnId` per riconoscerle ma anche con due rendering diversi). Ottiene la continuità *quasi* turno per turno, non esattamente | identica a B sul soffitto (gli stessi byte finiscono nella stessa richiesta), più il vantaggio di poter marcare ogni riga con tier e speaker per costruzione | la coda a tempo produce, su una settimana, un contesto che il modello confonde con la conversazione in corso — cioè risponde a Telegram sul terminale |
| **D** — si lascia com'è | niente | il costo zero è reale, e il recall già copre il caso «cercalo» | contraddice frontalmente ADR-0045 §1 e fa scattare il suo criterio di revisione. Il failure è stato osservato, non ipotizzato | nessuna | l'owner, usandolo un'altra settimana, smette di notarlo |

## 6. La seconda faccia, in breve — labelling, ed è già la radice

L'asimmetria è reale e va chiusa **tenendo i due lati come sono, per la ragione
che ciascuno ha**:

- l'estrazione salta `role='agent'` perché le parole dell'agente sono **prova di
  ciò che è stato detto, mai una fonte di fatti** (`agent/observe-run.ts:95`);
- il recall **deve** continuare a pescarle, perché «ne abbiamo già parlato?» si
  risponde solo da lì — toglierle sarebbe una regressione di capacità.

Quindi: **non filtrare, non smettere di indicizzare, marcare**. Ed è già fatto
alla radice: `core/memory/recall.ts:976` `describeEpisodeSource` separa lo
speaker (`role`) dal tier e rende un episodio dell'agente come `Muffin`, con
`· contesto: <tier>` quando il tier non è 0 e ruolo sconosciuto che *fail-closed*
su «origine non attribuita». Attraversa tutte e tre le vie di recupero — FTS
(`:525`), vettoriale (`:615`) e vicinato (`:803`) — ed è provato da
`core/memory/recall-speaker.test.ts` su tutte e tre. `describeTier`, il colpevole
storico, ora rende **solo fatti**, che per costruzione non hanno mai un autore
agente. Il commit è `b9093ba`, 2026-08-19.

Il residuo, ed è documentale: il commento in `agent/loop.ts:2133` predice ancora
che «`describeTier(0)` labels it **«tu»** in front of the model». Il codice si è
mosso, il commento no. Va corretto insieme alla riparazione in corso, perché una
memo che predice un guasto già chiuso è il modo più efficiente per farlo
riaprire.

## 7. Raccomandazione: **B**, con due condizioni

**B** — l'id di sessione diventa una funzione dell'identità: continua per il
tenant dell'owner attraverso le porte, per stanza per un tenant di gruppo.

Perché B e non C, che pure è la direzione già scritta: C cambia **cosa sia un
trascritto**, B cambia **quale trascritto**. Il failure dell'owner è che due
porte possiedono due conversazioni; la causa è una stringa scritta a mano in due
connector, non l'architettura del contesto. B toglie quella causa in ~5 righe più
una funzione condivisa, ed è reversibile riga per riga. C resta la slice giusta
*dopo*, quando il problema che si vuole risolvere sarà «il contesto non porta la
provenienza» e non «le porte non si parlano» — e B non la contraddice, la
prepara: dopo B c'è **una** finestra da rendere con provenienza invece di due.

Le due condizioni, senza le quali B è un peggioramento:

1. **La regola sta in un posto solo.** `identify` (`core/surface/types.ts`) è già
   la funzione che nessun connector può aggirare per decidere chi è l'owner; la
   chiave di sessione esce da lì, non da un letterale per connector. Una regola
   scritta una volta per porta è una regola che verrà scritta diversamente per
   porta — è l'argomento che quel file porta già scritto su sé stesso.
2. **La finestra fusa dice da dove viene ogni riga.** Oggi `buildContext`
   (`agent/loop.ts:3607`) rende `{role, content}` nudo e va bene, perché tutte le
   righe vengono dalla stessa porta. Fondendo, una riga senza marca è una riga di
   cui il modello non sa se è stata detta a voce sul telefono o scritta in un
   terminale — e questa è la stessa classe di errore della seconda faccia,
   spostata dalla memoria al contesto.

**Cosa mi farebbe cambiare idea**, in ordine di forza:

- se dopo una settimana di dogfood gli ASK sul terminale causati dal soffitto
  ereditato da Telegram sono più numerosi delle volte in cui la continuità è
  servita, la risposta giusta non è B ma C con una coda **filtrata per tier 0**
  (che B non può fare, perché una sessione fusa è una sessione intera);
- se la finestra da 40 messaggi, fusa, taglia sistematicamente il filo della
  porta in uso, prima si misura e poi si alza il letterale — ma se alzarlo non
  basta, la scelta è C;
- se emergesse una seconda persona sul tenant `host` (un secondo device
  dell'owner non è questo caso: `identify` lo risolve già come owner), tutta la
  §2.4 andrebbe rifatta.

## 8. Piano di implementazione per B

Otto punti. Nessuno di questi è stato scritto: è il piano, non il diff.

### 8.1 La chiave

`core/surface/types.ts`, accanto a `identify` e `tierOf`: aggiungere
`sessionKey` a `SurfaceIdentity`, **calcolato dentro `identify`** e non da una
funzione esportata a parte, così un connector non può comporlo da sé.

```
principal.kind === 'owner'  → 'owner'
principal.kind === 'member' → `${connector}:${conversationId}`   // invariato
```

`owner` senza connector è il punto: è l'unica stringa che due porte diverse
possono produrre. Il ramo `member` produce **la stringa che i connector già
usano oggi**, quindi per i gruppi non cambia niente — nemmeno il nome del file.

### 8.2 I chiamanti

| file:riga | oggi | dopo |
|---|---|---|
| `connectors/telegram/connector.ts:1140` | `sessions.open(\`telegram:${incoming.chatId}\`)` | `sessions.open(identity.sessionKey)` — `identity` è già in scope, viene da `principalFor` a `:1055` |
| `connectors/telegram/connector.ts:1442` | idem | idem |
| `connectors/discord/connector.ts:374` | `sessions.open(\`discord:${incoming.channelId}\`)` | idem |
| `cli/repl.ts:608` | `sessions.open()` | `sessions.open(OWNER_SESSION)` — il REPL è owner per costruzione (`:857` passa già `tenant: 'host'`) |
| `cli/repl.ts:791` (`/new`) | `sessions.open()`, id nuovo | `sessions.rotate(session)`, id uguale — è ciò che `/new` già significa su Telegram (`cli/surface.ts:479`), e con un id condiviso *deve* significare la stessa cosa |
| `cli/run.ts:57` | id usa e getta per invocazione | **invariato**. Il commento «a script run in a loop should not silently accumulate a conversation» è una proprietà, non un incidente: headless entra nella conversazione dell'owner solo con `--session owner`, esplicito |
| `agent/scheduler-run.ts:134,290`, `agent/observe-run.ts:53` | id casuali | **invariati**. Un job non è l'owner che parla; il suo trascritto non è la conversazione |

`replyTo.channel` e `replyChannel` restano `telegram:<chatId>` pienamente
qualificati (`connector.ts:1173,1181`): sono **indirizzi di consegna**, non
identità di conversazione, e la loro separazione da questa chiave è ciò che
impedisce a una risposta di uscire dalla porta sbagliata. Il commento a `:1176`
lo dice già; dopo B diventa load-bearing e va lasciato lì.

### 8.3 Perché il gruppo resta separato, e si vede

Con `identify` come unica sorgente: un `member` non produce mai `owner`, e
l'owner che parla **in un gruppo** è un `member` di quel tenant
(`core/surface/types.ts:241`, la proprietà che
`connectors/telegram/impersonation.test.ts` già sorveglia). Quindi la
separazione dei gruppi non è una condizione da ricordare in due connector: è una
conseguenza della funzione. È il motivo per cui la chiave va lì e non in un
helper accanto.

### 8.4 `reinjectedHistory` e il soffitto

`agent/context/history-taint.ts:95` **non cambia**, e questo è il punto: la
funzione taglia gli ultimi 40 parlati di ciò che le viene dato; darle un file più
lungo non le insegna niente di nuovo. Cambia il significato, non il codice.

Il soffitto si comporta già bene senza modifiche, e va verificato che continui:

- `SessionMessage` porta già `tier` per riga (`core/session/store.ts`, campo
  `tier`), e `messageTier` risolve una riga vecchia senza campo da `traceId`,
  con `FAIL_CLOSED_CEILING = 3` come ultima spiaggia;
- `agent/loop.ts:1673` fa `snapshot.raiseCeiling(historyTaint(spoken.kept,
  taintByTrace))`. Un `fs_read` o una pagina web letta su Telegram arriva quindi
  al turno CLI come **soffitto**, non come taint intrinseco: quel turno decide a
  quel tier (più ASK, che è corretto) ma la sua risposta non viene *marcata* a
  quel tier (ADR-0044 §Riconciliazione 28/08). Senza questa distinzione B
  sarebbe un cricchetto che sporca il terminale per sempre; con essa il costo
  invecchia fuori dalla finestra da solo.

Niente di tutto ciò è nuovo codice. È la ragione per cui B è piccola: il
meccanismo che rende sicura una sessione fusa **esiste già ed è provato**, ed era
stato costruito per un caso più difficile di questo.

### 8.5 La marca di superficie sulla finestra (condizione 2)

`agent/loop.ts:3607`, il ciclo `for (const m of kept)`: la riga rendered diventa
prefissata quando la superficie di `m` **non è** quella del turno corrente —
qualcosa come `[telegram] …`. Non su ogni riga: una marca che compare ovunque
smette di essere letta, ed è la regola che `core/memory/recall.ts` porta già
scritta per `temporalLabel`. Il dato c'è: `SessionMessage.surface` è scritto a
ogni append (`agent/loop.ts:1690` per l'owner, il ramo assistant per Muffin).

### 8.6 Migrazione

- **Schema: nessuna.** Gli episodi hanno già `tenant_id`, `connector`,
  `thread_key` e `turn_id`; il recall filtra su tenant e non ha mai visto l'id
  di sessione (§2.3). La memoria è già continua e non si accorge del cambio.
- **`todos`**: `agent/loop.ts:1648` legge `todos.open(input.tenant,
  input.session.id)`. Con la chiave condivisa il piano aperto diventa **uno solo**
  per l'owner attraverso le porte. È il comportamento che ADR-0045 §1 vuole («il
  lavoro non è posseduto da una porta»), ma è un cambiamento osservabile e va
  dichiarato nella PR, non scoperto. I todo vecchi restano legati agli id vecchi
  e semplicemente non compaiono più: nessuna riga va persa, nessuna query
  fallisce.
- **File di sessione**: `sessions/telegram:<chatId>.jsonl` e i vari
  `sessions/<data>-<hex>.jsonl` restano dove sono, leggibili, mai cancellati. Il
  costo del non-migrare è **solo la coda pre-cutover**: la prima conversazione
  dopo il cambio parte da un `owner.jsonl` vuoto, e ciò che c'era prima resta
  raggiungibile dal recall, che non ha mai guardato l'id. Se si vuole comunque
  la continuità sopra il taglio, una fusione una-tantum per `createdAt` dei soli
  file dell'owner è possibile e va fatta **archiviando** gli originali con
  `rotate`, mai sovrascrivendoli. Raccomandazione: non farla al primo giro; è
  irreversibile in un modo che il resto di B non è.

### 8.7 Concorrenza, e cosa non protegge

Due porte su un file solo significa che un turno Telegram e un turno REPL possono
appendere allo stesso `owner.jsonl`. `append` usa `appendFileSync` (O_APPEND, una
riga per scrittura): non c'è corruzione, e `read` tollera già una coda troncata.
Quello che **non** è protetto, e va scritto nella PR invece che scoperto: due
turni vivi in parallelo leggono la history all'inizio e vedono ciascuno un
mondo senza l'altro. Oggi è già così fra due chat; dopo B è possibile fra due
porte della stessa conversazione. Non è una regressione di sicurezza — è una
conversazione umana con due bocche, e ADR-0054 (`/stop`, `/steer`) è il posto
dove semmai si affronta, non questa slice.

### 8.8 I test che oggi falliscono e dopo passano

1. **Nuovo, unitario** — `core/surface/types.test.ts`: la DM dell'owner su
   `telegram` e su `discord` producono **la stessa** `sessionKey`; un gruppo ne
   produce una diversa da quella dell'owner e da quella di un altro gruppo;
   l'owner *dentro* un gruppo produce la chiave del gruppo, non `owner`. Oggi
   fallisce perché la funzione non esiste. È il test che rende la §8.3 una
   proprietà e non una promessa.
2. **Nuovo, di accettazione** — accanto a
   `evals/acceptance/scenarios/b-parita-superfici.accept.ts`, con lo stesso
   harness (`install`, `startFakeTelegram`, `privateMessage`): l'owner dice una
   cosa irripetibile nella DM Telegram finta; poi un turno CLI con un provider
   scriptato che rende il proprio contesto; si asserisce che la riga Telegram è
   **nella finestra reiniettata**, non recuperata dal recall (si disattiva la
   memoria, o si sceglie una frase senza token in comune con la domanda, così il
   recall non può essere la spiegazione). *Falsificatore*: rimetti i letterali a
   `connector.ts:1140` e `repl.ts:608` e lo scenario torna rosso. Oggi fallisce.
3. **Nuovo, di provenienza** — lo stesso harness: turno 1 su Telegram legge un
   file (`DISK_TIER` = 2); turno 2 sulla CLI chiede una scrittura; si asserisce
   la **stessa riga di `approvals`** che `b-parita-superfici` già confronta.
   Oggi il turno CLI parte a soffitto 0 e la richiesta passa liscia; dopo B parte
   al soffitto ereditato. È il test che prova che fondere non ha lavato la
   provenienza — cioè l'unico modo di verificare che B non ha aperto un buco.
4. **Da aggiornare, non da cancellare** —
   `evals/acceptance/scenarios/b-parita-superfici.accept.ts`: il suo docstring
   dichiara la vita della sessione come la variabile isolata («la CLI apre una
   sessione nuova a ogni invocazione …, Telegram una per chat, per sempre»).
   Dopo B quella frase è falsa. Lo scenario continua a misurare la parità del
   kernel — e le tre superfici devono restare identiche, che è la sua claim —
   ma deve **forzare esplicitamente** id di sessione distinti per tenere isolata
   la variabile che voleva isolare. Cambiare il codice e lasciare quel commento
   sarebbe esattamente il difetto che la §6 nomina, applicato a un test.

## 9. Cosa non ho verificato

- Non ho eseguito niente: nessun `vitest`, nessuna installazione, nessun turno
  reale. Ogni affermazione di questo documento è una lettura di `dev` `c06299f`
  con `file:riga`, non una misura di runtime.
- Non ho letto il database dell'owner. I due conteggi del §1 sono i suoi, citati.
- Non ho letto il **sorgente** di OpenClaw, Zep o Hermes: solo documentazione
  primaria, e per due delle tre senza una data o una versione sulla pagina.
- Non ho misurato quanto costa davvero il soffitto cross-superficie in ASK
  aggiuntivi. È la misura che decide fra B e C, e non si fa a tavolino: si fa
  con una settimana di dogfood, che è il criterio di revoca scritto al §7.
- Non ho verificato il comportamento di `identify` per una superficie che non
  ha il concetto di «chat diretta» (una futura voce, un pendant). Se una porta
  non può dire `direct: true`, con B non entra nella conversazione dell'owner —
  e va deciso allora, non ora.
