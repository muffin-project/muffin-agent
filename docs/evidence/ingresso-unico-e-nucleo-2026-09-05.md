# Ingresso unico e nucleo — evidenza per la decomposizione del loop e la parità fra porte

Data: 2026-09-05 · Worktree in sola lettura: `/private/tmp/claude-501/wt-day1` · Nessun file scritto, nessun accesso a `~/.muffin`.

## §0 Metodo

Cinque letture indipendenti in sola lettura, un disegno, tre giudici. Le letture: (a) `agent/loop.ts` end-to-end, 4428 righe, decomposto in 24 sezioni; (b) `connectors/telegram/*` (connector 2451, updates 372, transcript 506, delivery 222, presence 84, media 178, invito 113, surface 133); (c) `connectors/discord/*` (connector 554, inbox 94, gateway, api, surface); (d) l'assemblaggio `cli/surface.ts`; (e) `core/surface/*` e `core/turns/*`. Il disegno ha proposto un evento tipizzato, un cammino condiviso, nove moduli di loop e un test di parità.

Ogni giudice ha **refutato** il disegno su un asse diverso, e nessuna obiezione è stata scartata.

| Giudice | Lente | Cosa ha refutato (verificato di nuovo qui) |
|---|---|---|
| 1 | pilastri: nucleo stretto, agnosticismo di superficie (`docs/VISION.md` §"Core narrow", `docs/EXTENSIONS.md`:73 e :79, ADR-0021, ADR-0052 §3) | «unico sito di chiamata di `runTurn`» è falso; il nucleo si allarga di ~1600-2000 righe senza criterio; `connectors/shared/` esiste già ed era ignorato; il transcript è rendering Telegram travestito da generico; il gate di gruppo avrebbe un solo chiamante reale |
| 2 | cablaggio: «un meccanismo che funziona non è l'esito giusto» | il test di parità non può forzare il router sul cammino di produzione (è un divieto di import, non un'asserzione positiva); l'asse delle porte non è derivato dalla produzione; la terza clausola è vuota; la mutazione dichiarata dalla fetta 1 non diventa rossa |
| 3 | migrazione: cosa si rompe sull'installazione viva | `turns.surface` è una chiave di instradamento durevole e il piano non ne fissava il valore; `resolve`/`resolveBound` contengono già tre stadi *prima* di `bind`; la consegna fresca non passa da `SurfaceRegistry.deliver`; l'ordine di scrittura dell'approvazione era invertito; le colonne di `telegram_delivery_parts` sono INTEGER |

Verifiche eseguite qui per confermarle: `grep -rn "runTurn(" --include="*.ts" | grep -v test` → **otto** siti non-test (`connectors/discord/connector.ts:473`, `connectors/telegram/connector.ts:1885`, `cli/repl.ts:966`, `cli/run.ts:89`, `agent/scheduler-run.ts:159`, `agent/observe-run.ts:68`, `evals/floor/run.ts:113`, `evals/character/run.ts:304`), più `resumeTurn` guidato da `agent/turn-lane.ts:84`. Righe non-test: `core/` 26 254, `connectors/` 6 455.

## §1 Cosa c'è oggi

### 1.1 `agent/loop.ts` — 4428 righe, cinque export di valore

Superficie pubblica di valore: `MAX_RESUMES` (:934), `enqueueTurn` (:1016), `denyText` (:1063), `runTurn` (:1085), `resumeTurn` (:1290). Tutto il resto è tipo o è privato al modulo, raggiungibile dai test solo attraverso i due entry point — per questo ~28 file di test citano le stesse sezioni.

| Regione | Righe | Contenuto |
|---|---|---|
| tipi (`ToolContext`, budget, approvazioni, `LoopDeps`, `TurnInput`, `TurnResult`) | 68-934 | contratto pubblico, zero logica di turno |
| helper pre-turno (`spendeIlBudget`, `initialTaint`, `enqueueTurn`, `denyText`) | 936-1084 | |
| `runTurn` + helper di prima esecuzione | 1085-1221 | |
| `resumeTurn` + rifiuti terminali | 1223-1496 | |
| imbuto `drive()` + `scriviCorrezioniInSessione` | 1498-1714 | invariante /steer per forma, non per enumerazione |
| `guidaIlTurno` — pre-loop (snapshot, porte kernel, esposizione tool, contesto) | 1716-2207 | |
| `guidaIlTurno` — corpo di iterazione (modello, streaming, retry, gate di completezza, risposta) | 2208-2673 | |
| `guidaIlTurno` — batch di tool call, cap, catch esterno | 2675-2798 | |
| `checkpoint`/`suspendHere` | 2799-2949 | |
| `reconcile` | 2951-3050 | |
| `closeRecord`/`announceEnd`/`recover`/`finish` | 3052-3191 | |
| `closeRow`, `remoteParent`, estrattori di media | 3193-3305 | |
| `runTool` + cluster di helper | 3306-3942 | 536 righe nella sola `runTool` (:3406) |
| WAL + `resourceFor` | 3944-4073 | |
| `buildContext` | 4075-4259 | |
| `makeSnapshot`/`citato` | 4261-4348 | |
| `retryDelayMs`/`drainStream`/`edgeTrimmer` | 4350-4427 | |

Nessuna diramazione per superficie in tutto il file. L'unica resa di un nome di superficie al modello è l'etichetta `[surface]` in `buildContext` (:4178-4180), e resta generica. `resumes` è un `const` calcolato una volta (:1882-1884), **non** uno dei locali mutabili — un worker che lo rendesse mutabile conterebbe due volte contro `MAX_RESUMES`.

### 1.2 Parità Telegram vs Discord, comportamento per comportamento

| # | Comportamento | Telegram | Discord | Test |
|---|---|---|---|---|
| 1 | inbox durevole + esattamente-una-volta | sì — `updates.ts:36` schema, `accept`/`include`/`bind`, `resolve`/`resolveBound` (connector 1683-1796) | sì — `inbox.ts:29-38` (`message_id TEXT PK`), `drainOnce` 376-424 | `updates.test.ts`, `inbound-unit.test.ts`, `connector.test.ts` D2/U1 |
| 2 | identità via `identify()` | sì (`principalFor` 567-577) | sì (`principalFor` 183-188) | `impersonation.test.ts` |
| 3 | pairing | sì (2057-2088) | sì (440-463) — **stesso algoritmo scritto due volte** | `pairing-flow.test.ts` |
| 4 | gate di gruppo `apreUnTurno` | sì (329-358) | **assente per costruzione**: `parseMessage:155-156` rifiuta tutto ciò che non è DM | `gate-di-gruppo.test.ts` |
| 5 | ricorda-senza-rispondere | sì (1593-1655, porta `memoryWriteCapability`) | **assente** | `ricordare-senza-rispondere.test.ts` |
| 6 | comandi slash | sì (`controlla` 1321-1372 in pre-emption, `tryCommand` 2228-2280) | **assente**, e il docstring lo dichiara (55-65) | `comandi-telegram.test.ts`, `busy.test.ts` |
| 7 | corsia occupata + avviso di coda | sì (`vivi` :731, avviso 1384-1399) | metà durevole sì (guard 351-373), avviso e leva **assenti** | `busy.test.ts` |
| 8 | transcript in streaming / edit | sì (`transcript.ts`, 506 righe) | **assente**; `surface.ts:66-69` dichiara `streaming: {transport:'off'}` | `streaming.test.ts` |
| 9 | approvazioni con bottoni | sì (`handleCallback` 2139-2225, approver a `cli/surface.ts:866`) | **assente**: `agent/runtime.ts` risponde `unavailable` perché nessun approver è registrato | `approvazione.test.ts` |
| 10 | ingest allegati + voce | sì (2301-2374, vault + immagine + `deps.voce`) | parziale (532-549): niente immagine, niente audio, **solo `attachments[0]`** (:160) | `document-arrival.test.ts`, `voice-arrival.test.ts` |
| 11 | provenienza inoltro/citazione + recinto | sì (`contentTaintOf` 597-604, `composeTurnText` 623-687) | **assente**: concatena arrivo e testo grezzi (:481) | `forward-taint.test.ts`, `citazione.test.ts` |
| 12 | consegna durevole per parti | sì (`delivery.ts`, tabella a :30-49) | **assente**: `for (const part …)` con un flag per turno (503-507) | `delivery.test.ts` |
| 13 | topic/thread | sì (gate `is_topic_message` 409-412) | non applicabile (DM) | `topic-di-forum.test.ts` |
| 14 | presenza/typing | sì (`presence.ts`) | sì | `presence.test.ts` |
| 15 | invito/uscita | sì (`invito.ts`) | non applicabile | `dove-e-il-mio-umano.test.ts` |
| 16 | stop con budget, salute, backoff | sì (1066-1083, 889-1032) | sì (312-327, `gateway.ts`) | `stop-drenaggio.test.ts`, `salute-superficie.test.ts` |

Il registro ha unificato **solo l'uscita** (`core/surface/registry.ts`: `find` :54, `deliver` :74 con `redactText` a :91, `deliverFile` :98). L'ingresso non ha mai avuto il gemello: ogni funzione inbound è finita dentro un connettore.

## §2 Il disegno, con gli emendamenti dei giudici incorporati

### 2.1 L'evento tipizzato — accettato

`InboundEvent { port, eventId, compositionId, identity: IncomingIdentity, address: {channel, replyTo}, addressing, parts: IngressPart[], receivedAt }`. `identity` è esattamente `IncomingIdentity` (`core/surface/types.ts:236`), passato immutato a `identify()` (:306) e `tierOf()` (:355). La provenienza è **per parte**, non per evento: ogni `IngressPart` porta `source` (`author|forwarded|quoted|caption|catalog|filename|derived`) e il proprio `tier`; il taint del contenuto è `max(part.tier)`, la generalizzazione di `contentTaintOf` (telegram 597-604).

### 2.2 Dove vive — **emendato (giudice 1, accettato)**

Il disegno metteva tredici moduli in `core/ingress/`. Rifiutato: `docs/VISION.md` §"Core narrow" nomina esplicitamente «new messaging platforms» come ciò che non appartiene al nucleo, `docs/EXTENSIONS.md:73` classifica *connector* come contratto di estensione e :79 tiene *renderer* separato, e `connectors/shared/stop-budget.ts` è il precedente già stabilito per esattamente questa deduplicazione.

**Decisione:** il cammino condiviso nasce in `connectors/shared/ingress/`. Un modulo sale in `core/` solo se il suo soggetto è già di core — identità, taint/provenienza, record del turno, porte del kernel. Il PR riporta le righe non-test di `core/` e `connectors/` prima e dopo (oggi 26 254 / 6 455), così «il nucleo resta stretto» è una misura.

### 2.3 Una porta, non un gemello — **emendato (giudice 1, accettato)**

`IngressPort` **contiene** il suo `Surface` e legge da lì `limits` e `streaming`; non esiste un secondo record di capacità. La fetta 19 del disegno originale doveva modificare a mano sia `port.ts` sia `surface.ts`: è il difetto che `connectors/discord/surface.ts:54-56` già documenta per `DISCORD_MAX` («due literal che concordavano oggi e non avevano ragione di concordare domani»). Un test rende rosso il disaccordo fra `port.ingress.edit` e `surface.streaming.transport`.

### 2.4 Il router — **emendato (giudici 2 e 3)**

Due entrate, non una, perché `drain()` ne ha già due: `receive(port, event)` per un evento non legato e `recover(port, stored, workId)` per uno legato. `bind` resta nel connettore, esattamente dove sta oggi (telegram :1711), fra le due. `IngressOutcome` guadagna `{kind:'recovered'}` e `{kind:'deferred'}` perché i cinque rami di `resolveBound` (1721-1789) non sono esprimibili come un `InboundEvent`.

Stadi in `INGRESS_STAGES`, iterati da `receive`: `pair → gate → remember → command → busy → compose → ingest → work → deliver → settle`. Due correzioni sostanziali:

- **stadio 9 (`deliver`)**: la consegna fresca passa dal piano write-ahead della porta (`deliverTelegram` e il suo gemello), **non** da `SurfaceRegistry.deliver`. Instradarla lì non scriverebbe le righe per parte da cui `resolveBound:1760` distingue `sent` da `possibly_sent`, e applicherebbe `redactText` (`registry.ts:91`) che `deliverTo` non applica — un cambio non annunciato dei byte della risposta.
- **`{kind:'queued'}` (occupato o in pausa) non fa settle e non scrive nulla di durevole**: è ciò che fa ri-drenare l'evento al `/resume`.

### 2.5 Cosa **non** si muove — emendamenti accettati

- **`gate.ts` esce dal piano** (giudice 1). `apreUnTurno` resta in Telegram finché una seconda superficie può raggiungere il ramo non-privato: oggi Discord arriva sempre con `direct=true` e le quattro regole sono fatti consegnati da Telegram (`/x@nomebot`, `reply_to_message.from.id`, regex `@username`, e ADR-0063 sulla privacy mode). `addressing` resta calcolato dalla porta.
- **Il transcript non si muove intero** (giudice 1). `connectors/telegram/transcript.ts` importa `escapeHtml`, `splitHtml`, `TELEGRAM_MAX`, `toTelegramHtml` (:4) e li usa nel cuore, non ai bordi (:266, :277, :370, :403-446). Prima si divide *dentro* il connettore — macchina a stati dei segmenti e scheduler di edit (generico) contro escaping, dialetto e budget di lunghezza (per superficie) — e solo la prima metà può muoversi, dietro una porta di rendering esplicita.
- **I comandi estendono il cucito che già funziona** (giudice 1). `agent/comandi.ts` è già agnostico e serve sia `cli/repl.ts:867-872` sia `tryCommand`. Si condivide una fabbrica di `Controlli` + una callback di risposta, non un modulo di comandi solo-chat che il terminale non chiamerebbe. La pre-emption a livello di poller (`controlla` 1321-1372, `gestiti`, `markProcessed`) **resta nella porta**: uno stadio percorso una volta per evento già durevole non può riprodurre una pre-emption di batch.
- **Le approvazioni si provano prima di estrarle** (giudice 1). Si registra un `Approver` Discord accanto a `cli/surface.ts:866` con i componenti nativi di Discord, lasciando intatto `agent/runtime.ts`. L'estrazione condivisa arriva quando due implementazioni reali esistono; il formato del payload di callback resta in ciascuna porta.

### 2.6 Il test di parità — **emendato (giudice 2)**

Quattro `describe`, non tre.

1. `ogni stadio ha una scena su ogni porta` — asse comportamenti da `INGRESS_STAGES` (lo stesso array iterato da `receive`), asse porte da una tabella `INGRESS_PORTS` reale (vedi sotto). Ogni cella è una scena o `{nonApplicabile, adr}`, e l'insieme dei `nonApplicabile` deve essere `deep-equal` a `DIVERGENZE_AMMESSE`. **`gate` e `remember` per Discord entrano nella tabella dal giorno uno**, citando `connectors/discord/connector.ts:155-156`: altrimenti il describe 1 nasce rosso.
2. `la stessa scena produce lo stesso esito su ogni porta` — esegue il router reale contro il trasporto finto della porta e asserisce osservabili (una riga di episodio, un conteggio di chiamate al provider, un messaggio inviato, una riga sospesa), mai spie.
3. `nessun connettore possiede il loop` — la terza clausola originale era vuota: **nessun** file non-test sotto `connectors/` importa `core/turns/store.js` (l'unico hit è un commento in discord :384); le scritture passano da `deps.loop.turns` (telegram :1723/:2106/:2201, discord :520). Riscritta su quei siti di chiamata. Le prime due clausole sono reali: `connectors/telegram/connector.ts:3` e `connectors/discord/connector.ts:2` importano `runTurn` come valore, `transcript.ts:1` è type-only. Lo scan si allarga a `cli/` e `agent/`.
4. **`il connettore entra davvero dal router`** — nuovo, ed è il describe che regge tutto: guida il drain reale del connettore dal suo trasporto finto e asserisce un effetto che solo `receive()` può produrre. Senza, un connettore che inlinea i dieci stadi importando i moduli condivisi resta verde su tutti gli altri tre.

## §3 Le fette, in ordine

**Fase A — decomposizione del loop.** Nessuna tocca i connettori.

| # | Titolo | Scope / file | Verifica eseguibile | Raggio | Parallelo con |
|---|---|---|---|---|---|
| 1 | `agent/loop/types.ts` + barile | tipi e costanti fuori da `agent/loop.ts`; regola: `loop/*` importa `loop/types.js`, mai il barile | `npx tsc --noEmit && npx vitest run agent/ core/ cli/ connectors/`. **Mutazione corretta (giudice 2):** `Object.keys` non vede i tipi cancellati; il test asserisce i cinque export di valore e che nessun file sotto `agent/loop/` importi `../loop.js`; la superficie dei tipi è guardata da `tsc` e si dichiara così | compile-wide (35 importatori), comportamento zero | 10 |
| 2 | `agent/loop/stream.ts` | `retryDelayMs`/`drainStream`/`edgeTrimmer` (4350-4427) + primi unit test | `vitest run agent/loop/stream.test.ts agent/loop.test.ts`. Mut.: `edgeTrimmer` emette lo spazio finale → rosso; `drainStream` ritorna invece di lanciare a stream troncato → rosso | un file | 3, 4, 10 |
| 3 | `agent/loop/context.ts` | `buildContext` (4075-4259), `primoMessaggio` (610-624), estrattori (3260-3300) | `vitest run agent/loop/context.test.ts agent/image-turn.test.ts agent/session-history-taint.test.ts agent/todo-wiring.test.ts`. Mut.: testo prima delle immagini → rosso; via il prefisso `[surface]` → rosso | un file | 2, 4, 10 |
| 4 | `agent/loop/permissions.ts` | `makeSnapshot`/`citato` (4270-4348), `resourceFor` (4053), `denyText`, `initialTaint`, `spendeIlBudget` | `vitest run agent/loop/permissions.test.ts agent/decisioni-invariate-col-recinto.test.ts agent/link-copiato-non-e-composto.test.ts`. Mut.: normalizzare dentro `citato()` → rosso; cache di decisione che sopravvive a un rialzo di taint → rosso | un file + un test assorbito | 2, 3, 10 |
| 5 | `agent/loop/tool-call.ts` | `runTool` (:3406, già funzione top-level parametrizzata) e il suo cluster | `vitest run agent/ask-dice-cosa.test.ts agent/egress-gate.test.ts agent/secret-read.test.ts agent/tool-retry.test.ts agent/turn-record.test.ts agent/crash-resume.test.ts`. Mut.: `recordIntent` dopo l'handler → rosso; risolvere il tool su `exposed` → rosso | 536 righe, movimento puro | 11 |
| 6 | `agent/loop/run-state.ts` (`TurnRun`) | l'unico cambio di forma: i locali mutabili di `guidaIlTurno` diventano `run.*`. **`resumes` resta `const`** (:1882-1884) | `vitest run agent/ && npm run test:acceptance` (incl. `b-continuity`). Mut.: `contextBuilt` da `record.status` → `suspend-resume` e `crash-resume` rossi; `counters()` che ritorna l'oggetto vivo → `resume-checkpoint-budget` rosso | massimo rischio: sbagliare è silenzioso. **Gira da sola** | — |
| 7 | `agent/loop/durability.ts` | `checkpoint` (2821), `suspendHere` (2845), `reconcile` (2982), `finish` (3129), `closeRow` (3203) | `vitest run agent/suspend-resume agent/resume-checkpoint-budget agent/crash-resume agent/steer-sospeso && npm run test:acceptance` (`b-continuity`, `job-fires`, `lane-concurrency`). Mut.: `checkpoint` che ritorna true su scrittura recintata → rosso; `suspendHere` che ingoia una `suspend` fallita → rosso | choke point durevoli | 11, 12, 13 |
| 8 | `agent/loop/round.ts` | corpo di iterazione (2208-2673) + batch tool (2675-2798) | `vitest run agent/loop.test.ts agent/reply-taint agent/completion agent/secret-redaction agent/egress-gate && npm run test:acceptance`. Mut.: secondo tentativo in streaming invece del fallback unico → rosso; porta di risposta *dopo* la chiamata al modello → rosso | cammino a pagamento | 11, 12, 13 |
| 9 | `engine.ts` + `entry.ts`; `agent/loop.ts` diventa barile | 1727-2207 e l'imbuto `drive` (1498-1714) | `npx vitest run && npm run test:acceptance && wc -l agent/loop.ts` (<100). Mut.: drenare lo steer anche in `finish()` → `steer-imbuto` rosso; toglierlo dal ramo throw di `drive()` → `steer` rosso | suite piena, obbligatoria | 11-14 |

**Fase B — ingresso.**

| # | Titolo | Scope / file | Verifica eseguibile | Raggio | Parallelo con |
|---|---|---|---|---|---|
| 10 | `connectors/shared/ingress/types.ts` | `InboundEvent`, `IngressPart`, `IngressPartSource`, `AttachmentRef`, `Addressing`, `IngressPort` (che contiene il suo `Surface`) | `tsc --noEmit && vitest run connectors/shared/ingress/`. Il test costruisce l'evento da un fixture di filo reale per porta e asserisce che `max(part.tier)` uguagli `contentTaintOf` (:597). Mut.: parte `forwarded` con tier 0 → rosso | additivo, zero chiamanti | 1-4 |
| 11 | `compose.ts` — recinto e taint per parte | da telegram 597-695 | `vitest run connectors/shared/ingress/compose.test.ts connectors/telegram/forward-taint citazione posizione media`. Mut.: parte inoltrata senza recinto → rosso; messaggio dell'owner recintato → rosso (byte-identico) | una regione del connettore | 5-9 |
| 12 | `remember.ts` + `pair.ts` | `ricordaSenzaRispondere` (1593-1655) con la porta `memoryWriteCapability` intatta; pairing una volta sola (telegram 2057-2088 / discord 440-463) — **cancellare una delle due copie è la prova più economica che il cammino è reale**. *`gate.ts` non è in questa fetta: vedi §2.5* | `vitest run connectors/shared/ingress/ connectors/telegram/ricordare-senza-rispondere connectors/*/pairing-flow`. Mut.: bypassare la porta del kernel in `remember` → rosso; cancellare il pairing condiviso da una porta → rosso su quella porta | stesso file di 11: sequenziale | 6-9 |
| 13 | `lane.ts` + cucito dei comandi | `vivi` ha **due** scrittori, non uno: `:1883`/`:2024` e il ramo di resume `:1261-1271`; lettori a `:1387` e `:2242-2250`. Solo il controllo owner + `Controlli` + `eseguiComando` diventano condivisi; `controlla` resta nella porta | `vitest run connectors/shared/ingress/ connectors/telegram/busy.test.ts` (incl. `resumeStream tiene vivi onesto`, :345-377) `comandi-telegram` `cli/superfici-una-bocca` `agent/comandi` + `b-busy`, **`b-due-superfici`, `b-parita-superfici`**. Mut.: comandi di controllo dopo la coda → rosso; avviso per drain invece che per evento → rosso | la proprietà dello stato vivo esce dal connettore | 6-9 |
| 14 | router + `ingest` + `work`; Telegram diventa porta | `receive`/`recover`, `INGRESS_STAGES`, unico sito `runTurn` **d'ingresso**; `bind` resta nel connettore; `cli/surface.ts` costruisce una tabella `INGRESS_PORTS` (oggi due `if` a :792 e :923, più :278/:357) | `npx vitest run && npm run test:acceptance` (23 scenari; `b-telegram-journey`, `b-telegram-pairing`, `b-una-conversazione`, `b-immagini-ed-errori`, `b-continuity`, `e2e-giro-owner`). Mut.: saltare `ingest` → `document-arrival`/`voice-arrival` rossi; `runTurn` prima del check di pausa → `busy` rosso; togliere `settle` → `inbound-unit` rosso. **Fallback 14a/14b** se non si chiude verde | il connettore scende da 2451 a ~1400 righe | 9 |
| 15 | Discord diventa porta | `handle()` → costruzione evento + chiamata al router; dichiara `{commands:false, buttons:false, edit:false, typing:true, upload:true}` | `vitest run connectors/discord/ && npm run test:acceptance`. Mut.: `ingress.commands` true senza risposta cablata → errore alla costruzione; messaggio di gilda che passa `parseMessage` → `impersonation` rosso | solo Discord | — |
| 16 | il test di parità (quattro describe) | + fixture per porta; **estrarre `FakeSocket` da `connectors/discord/gateway.test.ts:16`**, oggi locale al file | `vitest run connectors/shared/ingress/parita.test.ts`. Mut. A: reimportare `runTurn` in Discord → describe 3 rosso. B: togliere `busy` da `INGRESS_STAGES` → describe 2 rosso su entrambe. C: inlinare gli stadi nel drain di Discord → **describe 4 rosso**. D: aggiungere un `nonApplicabile` senza toccare `DIVERGENZE_AMMESSE` → describe 1 rosso | solo test, ed è il metro della fase C | — |

**Fase C — parità Discord** (ogni fetta cancella righe da `DIVERGENZE_AMMESSE`).

| # | Titolo | Scope | Verifica | Raggio | Parallelo |
|---|---|---|---|---|---|
| 17 | comandi + avviso di coda | dichiarazione della porta + implementazione della risposta | `vitest run connectors/shared/ingress/parita connectors/discord/ agent/comandi`. Mut.: `if (port.id === 'telegram')` dentro `lane.ts` → parità rossa su Discord | Discord + allowlist | 18 |
| 18 | approvazioni | registra un `Approver` Discord accanto a `cli/surface.ts:866`; **ordine di produzione (giudice 3): parse → owner → `approvals.decide` → cortocircuito `unknown`/`already` → risposta allo spinner → via la tastiera → `resolveAsk` → `turns.wake` → `onWork` solo se `wake` ha ritornato true** | `vitest run connectors/telegram/approvazione agent/approvazione-differita parita && acceptance b-telegram-journey (D12), b-continuity`. Mut.: `allow` invece di `asked` → rosso; spinner prima di `decide` → il secondo click vede «non esiste più» su un'approvazione già concessa; **scena obbligatoria sulla metà di risveglio**, quella che sopravvive a un riavvio | riga durevole di approvazione | 17 |
| 19 | transcript condiviso | **solo dopo la divisione di §2.5**: si muove la macchina a stati, non il dialetto | `vitest run connectors/telegram/streaming transcript && acceptance b-streaming b-telegram-journey`. Mut.: via la guardia privato-only su `live()` → caso di gruppo rosso | cambio reale di capacità | 20 |
| 20 | parti di consegna durevoli per ogni porta | macchina a stati generica; **la tabella Discord usa TEXT** per channel/message/reply id (snowflake > 2^53), l'ALTER di `thread_id` (delivery.ts:70) resta legato alla tabella Telegram | `vitest run connectors/telegram/delivery turn-record parita`. Mut.: ritentare una parte `attempting` → rosso; `rejected` per un errore di rete invece di `possibly_sent` → rosso; snowflake sopra 2^53 non byte-identico → rosso | migrazione additiva | 19 |
| 21 | provenienza reply/forward + media tipizzati su Discord | `message_reference` e forward in `part.source`; una parte per allegato invece di `attachments[0]` (:160) | `vitest run connectors/discord/ parita && npm run test:acceptance`. Mut.: parte citata da altri con tier 0 → rosso; solo il primo allegato → rosso; caso U1 nello schema Zod parte del gate | parsing + schema | — |

## §4 Invarianti

1. **`turns.surface` è una chiave di instradamento durevole.** Colonna `surface TEXT NOT NULL` (`core/turns/store.ts:376`), scritta oggi come literal a `connectors/telegram/connector.ts:1890` e `connectors/discord/connector.ts:476`, e letta da tre mappe indipendenti: `doors` (`cli/surface.ts:892`, letta a :1084), `streams` (:896), `approvers` (`agent/runtime.ts`, popolata solo a `cli/repl.ts:657` e `cli/surface.ts:866`). **Invariante:** ciò che `work` scrive uguaglia `port.id`, che uguaglia la chiave delle tre mappe. Provato da un test che riprende una riga `waiting` con `surface='telegram'` attraverso l'assemblaggio post-fetta-14 — non da una frase.
2. **Schema durevole intoccato, esteso solo in modo additivo:** `telegram_updates`/`telegram_compositions`/`telegram_offset` (`updates.ts:36`), `telegram_delivery_parts` (`delivery.ts:30-49`, colonne INTEGER), `discord_messages` (`inbox.ts:29-38`, `message_id TEXT PK`), più turns/episodes/approvals. La migrazione legacy a `updates.ts:344` continua a girare.
3. **L'esattamente-una-volta resta dove sono le tabelle.** `accept`, `include`/`bind` first-writer-wins, l'ordine settle-prima-di-markProcessed, e la regola di `resolveBound` di non re-invocare mai il modello. Il router è chiamato dopo che l'evento è durevole; non possiede l'idempotenza. `{kind:'queued'}` non fa settle.
4. **Identità di sessione:** `identify()` (`core/surface/types.ts:306`) resta l'unico posto che decide una `sessionKey`; `OWNER_SESSION_KEY = 'owner'` (:225) per l'owner su ogni porta.
5. **Concorrenza dell'owner fra porte: decisione esplicita, non effetto collaterale.** Poiché la chiave dell'owner è `'owner'` ovunque, una corsia condivisa su `sessionKey` fonde Telegram e Discord in un solo turno vivo e rende `/stop` cross-port. O si chiave su `${port.id}:${sessionKey}`, o si emenda ADR-0054 e si scrive la scena di parità che lo asserisce. La fetta 13 **non** è «nessun comportamento nuovo».
6. **EFFECT WAL:** `recordIntent` prima dell'handler (fallimento ⇒ chiamata rifiutata), `recordOutcome` dopo (fallimento ⇒ «forse fatto»); i tre stati di `reconcile` conservano il significato.
7. **Decisioni del kernel:** stessi siti, stessi input, stesso ordine; la porta di risposta è chiesta **prima** della chiamata al modello; `citato()` resta un confronto letterale non normalizzato; l'episodio è timbrato col tier intrinseco, mai col soffitto (ADR-0044).
8. **Superficie di import pubblica:** `agent/loop.js` conserva ogni nome; i 35 importatori compilano intatti.
9. **Testo visibile all'owner byte-identico** attraverso tutta la decomposizione: `denyText`, «📥 in coda», «⏸ in pausa», «[allegato NON ricevuto: …]», «[nota vocale ricevuta ma NON trascritta: …]», le etichette di recinto, le risposte di pairing. Una fetta di parità può darle a una seconda porta; non può riscriverle sulla prima.
10. **I 23 scenari di accettazione restano verdi a ogni confine di fetta**; `npm run test:acceptance` è parte della verifica delle fette 6, 7, 8, 9, 14, 15, 18, 21, e `b-continuity.accept.ts` è nominato esplicitamente per 6, 7, 14, 18.
11. **Direzione delle dipendenze:** nessun file non-test sotto `core/` importa da `connectors/` o `cli/`; nessun modulo di ingresso condiviso contiene un nome di piattaforma in un identificatore o in un ramo. Entrambe asserite meccanicamente.
12. **Stop con budget e salute restano del connettore** e mantengono le garanzie odierne (telegram 1066-1083, discord 312-327), inclusa la distinzione db-chiuso vs guasto di rete (telegram 2433-2447).

## §5 Cosa falsifica questa evidenza

- **Il describe 4 non esiste o non diventa rosso** quando si inlineano gli stadi nel drain di un connettore importando i moduli condivisi. Allora la parità prova solo che il codice condiviso è condiviso, e tutta la fase B poggia su un divieto di import — il pattern che AGENTS.md nomina.
- **`INGRESS_PORT_IDS` resta una lista scritta a mano** accanto agli `if` di `cli/surface.ts:792`/:923. Allora «una terza porta senza fixture è rossa il giorno in cui viene registrata» è falso: basta un terzo `if`.
- **Un turno sospeso sull'installazione viva non trova più la sua porta** dopo la fetta 14: `doors.get(turn.surface)` fallisce in silenzio (`NO_SURFACE` lancia solo dentro la corsia) e `approve` risponde `unavailable`. Se il test di invariante 1 non esiste, questa evidenza è falsificata dal primo riavvio dell'owner.
- **Una consegna fresca instradata su `SurfaceRegistry.deliver`**: zero righe per parte, quindi dopo un crash a metà risposta il recupero registra `sent` per un messaggio che potrebbe non essere mai arrivato — e i byte cambiano per la redazione a `registry.ts:91`.
- **Il transcript si muove intero**: `core`/`shared` acquisisce escaping HTML, `TELEGRAM_MAX` e il dialetto Telegram, contro ADR-0052 §3 («il core non deve contenere euristiche Telegram travestite da regole universali»). Discord è Markdown a 2000 caratteri.
- **`DIVERGENZE_AMMESSE` non contiene `gate` e `remember` per Discord**: il describe 1 nasce rosso, oppure il describe 2 mente quando dice «stesse asserzioni su entrambe le porte» — perché `parseMessage:155-156` rende quelle scene irrealizzabili.
- **La riga di `resumes` diventa mutabile** nella fetta 6: un resume contato due volte contro `MAX_RESUMES` e un turno che rifiuta di riprendere.
- **Il conteggio righe di `core/` cresce oltre ~26 254 + i moduli di identità/taint** senza che il PR lo riporti: allora «il nucleo resta stretto» è tornato a essere un'asserzione.
- **Un rosso che è un timeout è CPU, non un difetto** (fette 2/3/4 e 10/11 girano in parallelo): un worker deve rieseguire il file da solo prima di riportarlo.
- **Costo di verità documentale, dichiarato:** `docs/evidence/` cita righe di `agent/loop.ts` in ~341 punti; dopo la fetta 9 puntano a un barile. Nessun test diventa rosso — quei file sono append-only e fuori da `docs/collegamenti.test.ts`. Il PR della decomposizione lo dice in una riga; non riscrive la storia.