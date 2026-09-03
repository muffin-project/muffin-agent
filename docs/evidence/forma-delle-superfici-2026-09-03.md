# Forma delle superfici — CLI vs Telegram, 2026-09-03

**Evidence datata, non authority.** Ricostruzione su codice (`dev` @ `8185a8f`,
worktree `slice/ricerca-forma`), una prova reale in tmux contro il binario vero
e un provider finto, e le fonti esterne lette il 03/09/2026. Non tocca
`docs/work/handoff.md`; non è un ADR.

## Raccomandazione, in tre frasi

Lo streaming diverge fra CLI e Telegram in punti che sono davvero diversi per
piattaforma (edit-vs-append, cadenza dei rate limit) e in un punto che non lo
è affatto: **l'approvazione è cablata come un canale a parte su entrambe le
superfici — un `output.write` grezzo sul terminale, un messaggio Telegram con
tastiera — invece di essere un passo dentro lo stesso flusso di `tool_start` /
`tool_end`**, ed è esattamente per questo che resta lì, non risolta
visivamente, dopo che la si accetta. La riparazione non è un renderer
condiviso — CLI e Telegram restano owner della propria resa — ma **due
piccole modifiche parallele**: il verdetto dell'approvazione deve rientrare
nel vocabolario dei passi (`✓`/`✗`, non un blocco `⚠` a parte) su entrambe le
superfici, e su Telegram il turno ripreso dopo un'approvazione deve tornare ad
avere `onDelta`/`onProgress` — oggi non li ha, ed è la causa strutturale per
cui «quella bolla lì» è l'ultima cosa viva che l'owner vede fino alla risposta
finale. Sul terminale il difetto ha anche una componente concreta e non
cosmetica: il prompt `[s/N]` scrive sullo **stdout** (`cli/textzone.ts:357`),
non sullo stderr che porta tutta l'altra cornice — la stessa violazione di
B11 che la suite esiste per impedire altrove.

## 1. Cosa ha chiesto il coordinatore, e come si è risposto

Il messaggio ricevuto a metà ricerca ha reso l'approvazione la riga più
importante, non l'ultima: **«se appare un popup che chiede conferma poi in
base all'esito va rimesso nello streaming degli altri tool call, non deve
rimanere quella bolla lì»**. La domanda posta era se il «testo che rimane
dopo aver accettato un comando» sulla CLI e la «bolla che rimane» su Telegram
fossero lo stesso difetto in due costumi. **Lo sono**, per la stessa ragione
strutturale: in entrambe le superfici l'approvazione non è un `TurnEvent`
come gli altri — è un canale collaterale che il codice del turno tratta come
un'eccezione, non come un passo. La sezione 3 lo mostra su schermo per la
CLI; la sezione 4 lo mostra sul codice per Telegram, dove non è stato
possibile (né sensato: nessuna chiave a pagamento, nessun bot reale nel
perimetro di questa ricerca) osservarlo su un client vero.

## 2. Le due superfici oggi — tabella comparativa

| aspetto | CLI (`cli/repl.ts`, `cli/textzone.ts`, `cli/fondo.ts`) | Telegram (`connectors/telegram/connector.ts`, `transcript.ts`, `presence.ts`) |
|---|---|---|
| testo del modello mentre arriva | accumulato e scritto **nudo** su stdout, byte per byte (`cli/repl.ts:885-913`, invariante B11, `cli/repl.test.ts`) | accumulato in `deltaText`, mandato come draft privato (`presence.streamText`, `connectors/telegram/presence.ts:213-219`), al più ogni 1.5s privato / 3s gruppo |
| preambolo prima di un tool | resta nello stesso stdout, indistinguibile dalla risposta finché non arriva un tool | al `boundary` va nella trascrizione come testo del segmento, mai perso (`connectors/telegram/connector.ts:1126-1140`, `transcript.ts` §«One bubble per segment») |
| un passo di tool in corso | niente riga: lo `status-line` (`cli/status-line.ts`) mostra lo spinner mentre vive | riga `⏳ … · Ns` dentro il segmento aperto, che si aggiorna anche senza eventi nuovi (`transcript.ts:264-268`, `report()`'s `tool_start`) |
| un passo di tool finito | una riga `✓`/`✗` scritta una volta, per sempre nello scrollback (`formatProgressLine`, `cli/repl.ts:215-219`) | la stessa riga `⏳` diventa `✓`/`✗` in place, dentro un `editMessageText` (`transcript.ts:171-176`, `render()`) |
| turno finito | riga di chiusura smorzata coi token/costo (`closingLine`, `cli/repl.ts:241-269`) | messaggio finale durevole via `delivery.ts`, mai duplicato (ADR-0046) |
| **approvazione, in attesa** | blocco `⚠ …` scritto a mano fuori dal vocabolario dei passi + prompt `[s/N]` su **stdout** (`cli/repl.ts:639-659`, `cli/textzone.ts:350-357`) — **vedi §3** | messaggio Telegram **a parte**, con tastiera inline (`cli/surface.ts:385-420`, `approvatoreTelegram`) — **vedi §4** |
| **approvazione, risolta** | riga `approvato`/`rifiutato` accodata allo stesso blocco, mai unita al `✓`/`✗` del tool che segue (osservato §3) | lo stesso messaggio viene editato con `\n\n✓ consentito`/`✗ rifiutato` **senza toccare `reply_markup`** (`connector.ts:1431-1442`) — **vedi §4.2** |
| continuazione dopo l'approvazione | stesso processo, stesso turno, stesso `onDelta`/`onProgress`: lo streaming **continua** senza interruzione strutturale | il turno si sospende e riprende sulla **lane del gateway** (`agent/turn-lane.ts`, `resumeTurn(deps, turnId)`) che **non riceve `onDelta`/`onProgress`** — **vedi §4.3** |

## 3. Necessariamente diverso vs accidentalmente diverso

**Necessariamente diverso** (vincolo di piattaforma, non pigrizia):
- edit-in-place (Telegram) contro append-immutabile (terminale): un terminale
  non può "modificare" una riga già scorsa nello scrollback, e la regola di
  `cli/STYLES.md` («resta selezionabile e copiabile») lo vieta comunque; un
  messaggio Telegram esiste apposta per essere editato.
- la cadenza: 1 msg/s per chat, ~20/min per gruppo, ~30/s complessivi sono
  vincoli del server Telegram (Telegram Bot API FAQ, sotto), non c'è
  equivalente per un terminale locale.
- l'unità minima: Telegram non ha un concetto di "riga", solo di "messaggio";
  il terminale ha entrambi. Una tastiera inline (bottoni) esiste solo su
  Telegram — il terminale non ha un analogo nativo, deve simularlo con
  `[s/N]`.

**Accidentalmente diverso** (due persone hanno scritto due cose), da
correggere, elencato dal più piccolo al più grande:

1. **Il prompt di approvazione scrive su stdout, non su stderr — solo sulla
   CLI.** `cli/textzone.ts:350-386` (`readLine`) usa `output.write(prompt)`,
   `output.write('\b \b')`, `output.write(ch)` dove `output` è
   `process.stdout` (passato da `cli/repl.ts:606-612`). Ogni altra riga di
   cornice del turno passa da `process.stderr` — lo stesso file lo scrive
   esplicitamente per `status.line` e per le righe `cosa fa`/`su`/`contesto`
   subito sopra (`cli/repl.ts:640-651`). È l'unico punto della CLI dove la
   cornice sporca lo stdout, cioè l'unico punto che romperebbe
   `muffin > risposte.txt` se un turno con approvazione ci passasse dentro —
   la stessa classe di difetto che B11 esiste per impedire altrove
   (`cli/repl.test.ts` §«a streamed turn's stdout bytes are…»). Nessun
   equivalente su Telegram: lì non esiste "stdout", l'intero canale è
   messaggi.
2. **Il verdetto non usa il vocabolario dei passi, su nessuna delle due.**
   Le altre righe di un tool sono `⏳`/`✓`/`✗` (CLI: `formatProgressLine`,
   `cli/repl.ts:213-224`; Telegram: `transcript.ts:162-192`). L'approvazione
   invece parla con un simbolo suo (`⚠`) e un formato suo su entrambe le
   superfici (CLI: `cli/repl.ts:640-659`; Telegram: `cli/surface.ts:394-407`)
   — nessuna delle due riusa `render()`/`formatProgressLine`. Il fatto che
   sia lo stesso errore concettuale ripetuto due volte, indipendentemente,
   è la prova più diretta che la divergenza è accidentale: nessun vincolo di
   piattaforma impone un vocabolario diverso per «sto aspettando un sì/no»
   rispetto a «sto aspettando che un comando finisca».
3. **Il verdetto non fa mai il percorso indietro verso il passo che l'ha
   generato**, su nessuna delle due. Sulla CLI: l'evento `onProgress`
   `{type:'ask'}` (`agent/loop.ts:3228`) è morto per la CLI in pratica — si
   emette solo quando `deps.approve` risponde `'asked'`, e l'approvatore CLI
   (`cli/repl.ts:639`) risponde sempre `'allow'`/`'deny'` in modo sincrono
   (`agent/loop.ts:3195-3209`: il ramo `if (answer === 'asked')` non è mai
   vero per la CLI), quindi quella riga `⏸ … aspetto la tua approvazione`
   pensata per esistere (`cli/repl.ts:223-224`) non compare mai in un turno
   CLI reale — solo il blocco `⚠` a parte, mai una riga `⏸`→`✓` continua. Su
   Telegram, `transcript.ts`'s `Step.state` include `'waiting'`
   (`transcript.ts:85`, aggiunto da `report()`'s `case 'ask'`,
   `transcript.ts:331-334`) ma **nessun evento lo porta mai a `'done'`**: si
   cerca solo l'ultimo passo `'running'` in `tool_end`
   (`transcript.ts:318-330`), mai un `'waiting'`. La riga `⏸ … aspetto la
   tua approvazione` dentro il segmento resta quindi congelata per sempre,
   anche quando la richiesta è stata decisa altrove — ed è proprio la «bolla
   che resta» di cui parla l'owner, solo che sono **due** bolle non
   riconciliate: il messaggio con la tastiera e la riga `⏸` dentro il
   segmento, che non si parlano.

Questi tre punti — non la cadenza, non l'edit-vs-append — sono ciò che
l'owner descrive con «ignoriamo SEMPRE i nostri docs, modularità,
agnosticismo»: nessuno dei tre discende da un vincolo del Bot API o del
terminale, discendono dall'aver scritto l'approvazione due volte, a mano,
fuori dal meccanismo che già esiste per ogni altro passo di un turno.

## 4. L'approvazione, in dettaglio

### 4.1 Cosa si vede in attesa e dopo — CLI, osservato su schermo reale

Riprodotto con `tmux` + `capture-pane` (mai `script`), un binario vero
(`node --import tsx cli/main.ts`), una home usa-e-getta
(`/private/tmp/claude-501/scratchpad/muffin-throwaway2`) e un `FakeProvider`
(`evals/acceptance/provider.ts`, nessuna chiave a pagamento, nessuna rete
verso un provider reale) scriptato con un `shell_run` che richiede
approvazione. Finestra 90×12 per forzare l'aggancio della scroll region
(`cli/fondo.ts`).

**Subito dopo l'invio, approvazione in attesa** (`tmux capture-pane -p`):

```
╭─ anthropic/claude-sonnet-5 · owner ────────────────────────────────────────────────────╮
│ › esegui il comando echo per favore                                                    │
╰────────────────────────────────────────────────────────────────────────────────────────╯

⚠ sys.shell
   cosa fa: stampa la parola ciao
   su: command: echo ciao · cwd: .
   approvi "sys.shell"? [s/N]
╭─ anthropic/claude-sonnet-5 · owner ────────────────────────────────────────────────────╮
│ ›                                                                                       │
╰────────────────────────────────────────────────────────────────────────────────────────╯
```

La riga `approvi "sys.shell"? [s/N]` — dove va davvero la risposta — è un
testo nudo sopra un riquadro **vuoto** che sembra pronto a ricevere input e
non lo è: chi digita guardando il riquadro (l'abitudine che ogni altro
prompt della stessa sessione insegna) sta guardando nel posto sbagliato.
Battendo `s` la conferma:

```
   approvi "sys.shell"? [s/N] s
```

la `s` compare dopo `[s/N]`, sulla riga nuda — **non** nel riquadro vuoto
sotto, che resta immobile durante tutta l'attesa. Dopo l'Invio, la scrollback
completa (`capture-pane -S -500`, nessuna cornice duplicata: il riquadro non
si ridisegna due volte — quel difetto specifico di `STYLES.md` §«L'ancora del
ridisegno» non c'è) mostra:

```
⚠ sys.shell
   cosa fa: stampa la parola ciao
   su: command: echo ciao · cwd: .
   approvi "sys.shell"? [s/N] s
   approvato

  ✓ eseguo un comando: echo ciao

Fatto, ho stampato ciao.
```

**Cosa resta**, esattamente: il blocco `⚠ … approvato` **non scompare e non
si fonde** con la riga `✓ eseguo un comando: echo ciao` appena sotto — restano
due annunci consecutivi della stessa cosa, in due vocabolari. Non è
duplicazione del riquadro (quello è pulito); è duplicazione **semantica**: il
verdetto e il passo eseguito raccontano lo stesso evento due volte, con due
alfabeti di simboli diversi (`⚠`/testo contro `✓`/frase-passo).

### 4.2 Cosa si vede in attesa e dopo — Telegram, da codice (non riproducibile qui)

Non c'è stato un bot Telegram reale da provare in questa ricerca (nessuna
chiave, nessun token — fuori dal perimetro di una passata di ricerca). La
ricostruzione è quindi sul codice, con lo stesso livello di certezza di un
fatto di wiring:

- **In attesa**: `approvatoreTelegram` (`cli/surface.ts:385-420`) manda un
  messaggio **a parte** dal segmento della trascrizione, con `⚠ <prompt>`,
  la `description` del modello, il comando in `<pre>`, il taint, e una
  tastiera inline `Consenti "…" / Rifiuta`. Nello stesso momento,
  `transcript.report()` (chiamato dal `case 'ask'` di `agent/loop.ts:3228`
  — ma solo se `answer === 'asked'`, che per Telegram è sempre vero) ha già
  scritto una riga `⏸ sys.shell: aspetto la tua approvazione` **dentro** il
  segmento in corso (`transcript.ts:331-334`). Due rappresentazioni
  simultanee della stessa attesa, in due messaggi Telegram diversi.
- **Risolta**: `handleCallback` (`connector.ts:1398-1456`) risponde al
  bottone (`answerCallbackQuery`), scrive la decisione nel registro
  (`approvals.decide`), poi edita **quello stesso messaggio con la
  tastiera** aggiungendo `\n\n✓ consentito`/`✗ rifiutato`
  (`connector.ts:1431-1442`) — **senza passare `reply_markup`**. La riga
  `⏸ … aspetto la tua approvazione` dentro il segmento, invece, **non viene
  mai toccata**: resta `⏸` per sempre, anche a turno concluso (§3, punto 3).

### 4.3 Perché non si può "rimettere nello streaming" senza il fix a monte

`handleCallback` (§4.2) non esegue il turno: chiama solo `wake()`
(`connector.ts:1445`), che riporta la riga da `waiting` a `runnable`
(`core/turns/store.ts`). L'esecuzione vera avviene alla battuta successiva
della **lane del gateway** (`core/turns/lane.ts`), che passa da
`agent/turn-lane.ts`'s `makeLaneRunner` (righe 46-58) a
`resumeTurn(deps, turnId)` (`agent/loop.ts:1121-1124`). La firma di
`resumeTurn` prende **solo** `LoopDeps` e `turnId` — **nessun `onDelta`,
nessun `onProgress`**. Confermato anche da `agent/turn-lane.ts`, che non
importa né costruisce `startTranscript`/`startPresence` in nessun punto (uno
`grep` mirato non trova `onDelta`/`onProgress`/`startTranscript` nel file).

Conseguenza misurabile: un turno ripresto dopo un'approvazione **non ha
alcuna rappresentazione live** — nessuna riga `✓`/`✗` per i tool che gira dopo
l'approvazione, nessun draft che scorre — fino a quando `sendAndRecord`
(`agent/turn-lane.ts:120-131`) consegna il testo finale come messaggio nuovo.
Lo conferma anche `evals/acceptance/scenarios/b-telegram-journey.accept.ts`
(scenario D12, righe 391-476 circa): il modello, scriptato, **ri-chiede lo
stesso `shell_run`** dopo la ripresa («la retry è comportamento di produzione
reale», dice il commento a riga 411-418) — e lo scenario asserisce solo sul
messaggio ASK e sulla tastiera, **mai** su cosa appare fra l'approvazione e
la risposta finale, perché oggi non appare niente da asserire.

Questo è il motivo per cui «rimettere l'esito nello streaming degli altri
tool call» non è un compito di rendering sul messaggio della tastiera: è un
compito di wiring a monte. Finché `resumeTurn`/`makeLaneRunner` non
riacquistano un modo di attaccare `onDelta`/`onProgress` per un turno
ripreso — sull'indirizzo già durevole in `replyTo`/`replyChannel`, esattamente
come fa `runFresh` — non c'è "streaming degli altri tool call" in cui
rientrare: per il tratto fra l'approvazione e la risposta, lo streaming non
esiste.

### 4.4 I documenti Bot API sul folding-back di una tastiera

Fonti lette il 03/09/2026:

- **Telegram Bot API, `editMessageText`**
  (`https://core.telegram.org/bots/api#editmessagetext`, letta il 03/09/2026):
  elenca `reply_markup` come parametro **opzionale** ma **non specifica**
  cosa succede alla tastiera esistente quando viene omesso — né che resta,
  né che viene rimossa. Non è un'omissione di questa ricerca: è
  un'omissione della pagina stessa.
- **`editMessageReplyMarkup`** esiste come metodo **a parte**, dedicato
  esclusivamente a cambiare/rimuovere la tastiera di un messaggio già
  inviato — la sua sola esistenza, come metodo separato da `editMessageText`,
  è il segnale più forte disponibile che il pattern documentato dell'API è
  «un edit cambia solo i campi che passi», non «un edit senza `reply_markup`
  la cancella».
- **Una ricerca su fonti secondarie** (issue tracker di librerie bot,
  `github.com/yagop/node-telegram-bot-api/issues/408`, letta il 03/09/2026)
  non ha prodotto una risposta univoca: un summary automatico ha
  restituito un'affermazione (omettere `reply_markup` la **rimuove**) che
  contraddice la lettura più comune della semantica REST-PATCH dell'API — e
  che non è stata possibile verificare né sulla pagina ufficiale né su
  quell'issue, il cui autore stesso segnala un errore 400 provando
  `editMessageReplyMarkup` con una tastiera vuota in un altro contesto.
  **Non riprodotto, non trovato con certezza**: questa ricerca non ha un
  bot reale contro cui provarlo, e le fonti secondarie si contraddicono.

**Conseguenza per `connector.ts:1431-1442`.** Il codice attuale chiama
`editMessageText` **senza** `reply_markup` per marcare la decisione — che,
sulla base di quanto sopra, è un affidarsi a un comportamento non
documentato, esattamente la categoria che `docs/RESEARCH.md` chiede di non
assumere. **L'alternativa onesta** — quella che il brief chiede quando la
piattaforma non garantisce il fold-back — è smettere di affidarsi
all'omissione ed essere espliciti: passare `reply_markup: { inline_keyboard:
[] }` nello stesso `editMessageText` (o in un `editMessageReplyMarkup`
separato subito prima), così la tastiera sparisce per costruzione e non per
un comportamento che la pagina ufficiale non promette. Rimuovere il
messaggio stesso (`deleteMessage`) romperebbe l'invariante già scritto in
`transcript.ts` («Nothing is deleted») per lo stesso motivo per cui esiste:
un pulsante premuto che scompare senza lasciare traccia è indistinguibile,
per l'owner, da un pulsante mai arrivato.

## 5. Lo stato finale inteso, scritto per intero

**CLI.** Il blocco `⚠`/`[s/N]`/`approvato` sparisce come formato a parte.
Al suo posto, la stessa `write` disciplinata che già scrive `formatProgressLine`
(`cancella` → scrivi → `redraw`, `cli/repl.ts:150-161`) produce:

```
  ⏸ sys.shell: aspetto la tua approvazione
     cosa fa: stampa la parola ciao
     su: command: echo ciao · cwd: .
approvi "sys.shell"? [s/N] s
  ✓ sys.shell: consentito
  ✓ eseguo un comando: echo ciao

Fatto, ho stampato ciao.
```

— una riga `⏸` (non un blocco `⚠` a parte), il prompt scritto su **stderr**
tramite lo stesso canale disciplinato (mai su stdout), e alla risposta una
riga `✓`/`✗` nello stesso alfabeto del resto del turno, seguita — non
preceduta da uno stacco visivo — dal normale `✓ eseguo un comando: …`. Il
riquadro in fondo resta esattamente quello che è già ora fra un turno e
l'altro: vuoto, fermo, e mai il posto dove la risposta `[s/N]` finisce
davvero.

**Telegram.** Due correzioni indipendenti, entrambe necessarie:

1. Il messaggio con la tastiera, una volta deciso, perde la tastiera per
   costruzione (`reply_markup: { inline_keyboard: [] }` esplicito, §4.4) —
   non per omissione.
2. La riga `⏸ sys.shell: aspetto la tua approvazione` dentro il segmento
   della trascrizione **si risolve**: `Transcript` guadagna un modo per
   `report()` di sapere che quella richiesta è stata decisa (un evento
   nuovo, o l'estensione di `'ask'` con un esito) e riscrive quel passo come
   `✓ sys.shell: consentito` / `✗ sys.shell: rifiutato` — esattamente come
   `tool_end` già fa per un passo `'running'`.
3. Il turno ripreso torna a portare `onDelta`/`onProgress` fino
   all'indirizzo durevole (`replyTo`/`replyChannel` già sulla riga) — senza
   questo, il punto 2 ha comunque nulla da mostrare fra la decisione e la
   risposta finale, e la "bolla che resta" torna, solo spostata.

## 6. Dove va un'astrazione condivisa, e cosa non deve inghiottire

**Cosa va condiviso**: il *vocabolario* del passo (`⏳`/`✓`/`✗`/`⏸`→risolto) e
la *decisione* di cosa rappresenta un'approvazione — un passo del turno, non
un evento a parte — sono concetti agnostici dalla superficie, e oggi vivono
duplicati (`cli/repl.ts` §`formatProgressLine` e
`connectors/telegram/transcript.ts` §`render`) con la stessa logica scritta
due volte a mano. `agent/tool-phrase.ts` fa già esattamente questo per il
nome dei tool (`toolPhrase`, `toolLine`) — lo stesso principio si estende
naturalmente a "come si chiama uno stato di un passo", non a come si
disegna.

**Cosa NON deve inghiottire**: il *rendering*. Un renderer condiviso che
producesse byte identici per CLI e Telegram appiattirebbe esattamente le
differenze necessarie della §3 — l'edit-in-place non ha senso su un
terminale, lo stdout nudo non ha senso su Telegram, la tastiera inline non
ha equivalente terminale. La correzione qui non è "un componente Approval
condiviso": è due implementazioni che **condividono il vocabolario e la
decisione strutturale** (l'approvazione è un passo, non un canale a parte) e
restano, per il resto, proprietarie della propria superficie — la stessa
riga che `cli/STYLES.md` traccia già fra "sei ruoli, e nient'altro" (un
vocabolario) e "come si disegnano" (mai condiviso).

## 7. Il test più piccolo che si rompe se le due superfici si riallontanano

Nessun test oggi asserisce cosa appare **fra** un'approvazione risolta e la
risposta finale, né su CLI né su Telegram (verificato: lo scenario D12 di
`b-telegram-journey.accept.ts` si ferma al messaggio con la tastiera, §4.3).
Il test minimo, uno per superficie, entrambi già appoggiati su harness
esistenti:

- **CLI**: un test di wiring reale (stesso genere di
  `cli/repl.test.ts` §B13, non un unit test su `formatProgressLine`
  isolato) che fa girare un turno con un tool ad approvazione automatica
  (`allow` scriptato), applica i byte scritti a `cli/schermo.ts`, e asserisce
  che nella griglia risultante **non compaia mai** la sottostringa `⚠` (il
  vecchio formato) e che la riga generata dall'approvazione preceda
  immediatamente, senza righe vuote fra le due, la riga `✓`/`✗` del tool che
  ne è seguito. Si rompe da solo se il blocco a parte torna.
- **Telegram**: un'estensione dello scenario D12 in
  `b-telegram-journey.accept.ts` che, dopo il click sul bottone `ok:`,
  aspetta la consegna finale e asserisce (a) che il messaggio ASK editato
  **non porti più `reply_markup`** (oggi il campo non viene nemmeno
  ispezionato dopo il click), e (b) che il testo dell'ultimo segmento della
  trascrizione **non contenga** `aspetto la tua approvazione` a turno
  concluso. Il secondo si rompe oggi stesso, senza bisogno di scrivere
  alcuna nuova produzione: è la prova diretta di §4.2-§4.3.

## 8. Fonti esterne, con URL e data di accesso

- Telegram Bot API, `editMessageText`:
  `https://core.telegram.org/bots/api#editmessagetext` — letta 03/09/2026.
  Elenco parametri confermato (`chat_id`, `message_id`, `inline_message_id`,
  `text`, `parse_mode`, `entities`, `link_preview_options`, `reply_markup`);
  nessuna frase sul comportamento di `reply_markup` omesso.
- Telegram Bot API, pagina generale (metodi, per contesto su
  `editMessageReplyMarkup`/`answerCallbackQuery`):
  `https://core.telegram.org/bots/api` — letta 03/09/2026; la pagina è
  troppo lunga per un fetch integrale in un colpo solo (troncata dallo
  strumento), quindi la lettura è stata mirata per frammento (`#ancora`).
- Telegram Bot FAQ, limiti di frequenza:
  `https://core.telegram.org/bots/faq` — letta 03/09/2026. Citazione
  diretta: *"In a single chat, avoid sending more than one message per
  second."*; *"In a group, bots are not be able to send more than 20
  messages per minute."*; *"For bulk notifications, bots are not able to
  broadcast more than about 30 messages per second, unless they enable paid
  broadcasts."* — gli stessi numeri che `connectors/telegram/api.ts:14-16`
  già cita a memoria del codice; confermati qui dalla fonte primaria, non
  solo dal commento.
- `github.com/yagop/node-telegram-bot-api/issues/408` — letta 03/09/2026,
  non conclusiva (vedi §4.4).
- Non rifetchata in questa passata (già distillata da
  `docs/evidence/dogfood-superfici-2026-09-03.md` §3, con le sue date di
  lettura): Codex `insert_history.rs`, Ink `<Static>`, pi-tui README,
  OpenClaw `channels/telegram`, Hermes `gateway.streaming` — nessuna delle
  cinque parla di fold-back di un'approvazione, quindi non aggiungono nulla
  a questa domanda specifica.

## 9. Cosa non è stato possibile riprodurre o trovare

- **Nessun bot Telegram reale**: tutto il §4.2/4.3 è ricostruzione da
  codice, non un'osservazione su un client. Non c'era un token nel
  perimetro di questa ricerca, e usarne uno reale avrebbe voluto dire
  spendere soldi dell'owner o toccare la sua chat reale — entrambi fuori
  mandato per una passata di ricerca.
- **Il comportamento esatto di `reply_markup` omesso in `editMessageText`**:
  non documentato dalla fonte primaria, non risolto in modo affidabile da
  fonti secondarie contraddittorie (§4.4). Trattato come sconosciuto, non
  come assunto.
- **La sezione `sendChatAction` della pagina API ufficiale**: il fetch è
  arrivato troncato prima di quella sezione; il valore usato nel codice
  (`ACTION_RENEW_MS = 4000`, commento «self-cancels after ~5s»,
  `connectors/telegram/presence.ts:31-32`) non è stato riverificato in
  questa passata contro la fonte primaria.

## 10. Comandi eseguiti, con esito

```
git fetch -q origin                                                          → 0
git worktree add -b slice/ricerca-forma /private/tmp/claude-501/worker-forma origin/dev → 0
npm ci (in worker-forma)                                                     → 0
node --import tsx cli/main.ts init --provider openai-compat --base-url … (x2, home usa-e-getta) → 0
tmux new-session/send-keys/capture-pane (riproduzione approvazione CLI)      → osservato, §4.1
npx vitest run docs                                                          → 0 (17 test, 3 file)
```

Home usa-e-getta e provider finti sono stati creati solo sotto
`/private/tmp/claude-501/scratchpad/`, mai sotto `~/.muffin`; nessuna chiave
a pagamento è stata usata; nessun secret è stato stampato (l'unica chiave
scritta è `sk-throwaway-fake-key`, letteralmente inventata per questa prova
e mai valida presso alcun provider).
