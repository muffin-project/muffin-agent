# ADR-0048 — I segreti non sono mostrabili: redazione al confine di scrittura

**Stato:** accettato · 2026-08-17 · chiude P34-2, chiude la decisione owner
pendente su "segreti a riposo" (`M5-BIS.md` §E3, `PERCORSO-CRITICO.md` 2.5)

## Contesto

Direttiva owner, 2026-08-17, verbatim: *«i secret non devono mai essere
mostrati o mostrabili, né in logs, né in chat, da nessuna parte»*.

Il mandato iniziale di questa slice leggeva quella frase come un problema di
**redazione**: un valore che assomiglia a un segreto va oscurato ovunque
possa essere scritto — trace, record durevole, sessione, CLI. Una
precisazione successiva dell'owner ha spostato il baricentro prima che il
codice fosse scritto: la redazione testuale è **difesa in profondità**, non
la garanzia. L'invariante vero, verbatim:

> «Un secret value conosciuto non entra mai nel data plane generale di
> Muffin. Viene materializzato solo nel sink privilegiato autorizzato che ne
> ha bisogno, il più tardi possibile, e da lì non torna nel runtime
> osservabile.»

La differenza non è cosmetica. Un detector testuale può sempre mancare una
forma non ancora vista; una garanzia strutturale — "questa funzione ha un
insieme fisso e piccolo di chiamanti, nessuno dei quali è un tool" — si prova
per enumerazione ed è falsificabile da un test che conta i chiamanti.

## Decisione

### 1. Tre classi, e non si trattano allo stesso modo

1. **Segreti conosciuti dal backend** (`muffin secret set`,
   `readSecret`/`locateSecret` — `core/config/config.ts`). **Garanzia
   strutturale.** Il valore risolto esiste solo dentro il sink privilegiato
   che lo ha richiesto — l'header `Authorization` costruito dall'SDK del
   provider, la query firmata verso Tavily, l'URL/header verso Telegram o
   Discord — e non torna mai nel piano generale (tool args/result, messages,
   turns, sessioni, trace, CLI, approval resource, argv, env di un
   sottoprocesso). Questo è **uso**, non esposizione.
2. **`muffin secret set`.** Il valore entra solo da stdin: la sintassi del
   comando (`secret set NOME [--persist]`) non ha uno slot in argv per il
   valore, quindi non è redazione, è assenza del canale.
3. **Stringhe secret-like incollate a mano** (in una chat, dentro un file che
   `fs_read` può leggere). **Detector best-effort**, dichiarato come tale: un
   pattern testuale, non una garanzia di sicurezza. Non copre ogni forma
   possibile e non deve: un falso positivo che cancella contenuto vero è un
   difetto, non prudenza (owner, stessa direttiva).

Il prune periodico e la cifratura a riposo — entrambe valutate — restano
**utili per la privacy generale** (dati vecchi, GDPR) ma non sono la garanzia
dei segreti: un prune lascia il segreto visibile per tutto il tempo in cui
gira, e "mostrabile" è già la violazione che la direttiva chiude.

### 2. La garanzia strutturale (classe 1), e come si prova

`readSecret` ha un insieme fisso di chiamanti in produzione, e la prova è
un'enumerazione eseguibile (`core/config/secret-boundary.test.ts`), non un
argomento:

| chiamante | sink | perché è privilegiato |
|---|---|---|
| `agent/runtime.ts` | l'SDK Anthropic/OpenAI-compat, il backend Tavily | il valore risolto entra **inline** nel costruttore/closure e da lì costruisce solo l'header/la query in uscita; nessuna variabile intermedia lo tiene |
| `cli/surface.ts` | `TelegramApi`/`DiscordApi` | stesso schema: risolto al momento di costruire il client di pairing, mai copiato altrove; una chiamata (`hasSecret`) lo scarta subito |
| `cli/doctor.ts` | nessuno — solo diagnostica | stampa backend, percorso e **lunghezza in caratteri** (mai un carattere del valore — coerente con `«redacted:N»`, che tiene la lunghezza per lo stesso motivo) |

Nessun handler di tool (`agent/tools/*.ts`), nessun connector, nessun punto
di `core/turns/`, `core/session/` o `core/tracing/` chiama `readSecret` — il
test lo verifica per enumerazione dell'intero albero sorgente, non per
lettura di un singolo file, cosicché un nuovo chiamante fuori
dall'allowlist rende il test rosso finché non è una decisione rivista, non
una svista.

**Perché non serve spostare la risoluzione dentro l'adapter del provider.**
La domanda era legittima — se `buildRuntime` avesse tenuto il valore
risolto in una variabile riusata altrove, quello sarebbe stato il difetto da
correggere. Non lo fa: `new AnthropicProvider(readSecret(...), baseUrl)` e
l'equivalente per Tavily/OpenAI-compat risolvono **inline**, come argomento
di chiamata — non esiste un `const key = readSecret(...)` che sopravviva
oltre quella riga. Spostare la chiamata dentro il costruttore dell'adapter
avrebbe spostato *dove* avviene la lettura del file senza cambiare *cosa*
succede al valore dopo: finisce comunque dentro l'SDK, che lo tiene per la
vita della richiesta. Verificato leggendo ogni chiamante (tabella sopra) e
non assunto.

**Conseguenze verificate con test, non solo enunciate:**

- `fs_read`/`fs_list`/il tool shell sandboxato non possono leggere nessuno
  dei due backend di `secretDir` (`home`, `persistent` — catena ADR-0039):
  `core/rot/guards.ts` li mette entrambi in `denyRead`, condiviso fra
  `agent/tools/fs.ts` e `core/sandbox/executor.ts`. Provato: hard link e
  symlink terminali chiusi da PR #52 (`agent/tools/fs.test.ts`); i due
  backend letti dentro lo scope, dove solo `denyRead` — non il confine dello
  scope — può negare (`core/rot/guards.test.ts`, mutazione verificata su
  entrambe le voci).
- Un processo sandboxato non eredita segreti via environment:
  `SandboxExecutor.childEnv` ricostruisce l'ambiente del figlio da un
  allowlist fisso, mai da `process.env` per intero — provato con un test che
  ispeziona l'ambiente *effettivo* del figlio (`printenv`), non il codice
  (`core/sandbox/executor.test.ts`, preesistente, riverificato qui).
- `sys.process.list` non espone mai `argv` di un altro processo, solo
  `pid,user,comm` — deciso e commentato in `agent/tools/process.ts` prima di
  questa slice, riletto e confermato qui.
- Un tool result o un tool args non possono mai portare un valore risolto:
  nessun tool chiama `readSecret`, quindi un `resource` d'approvazione
  (`ApprovalRequest`) può mostrare solo ciò che il modello ha scritto negli
  argomenti — mai un segreto vero, al più uno che *assomiglia* a un segreto
  (classe 3, se l'owner o un file letto lo hanno scritto lì).

### 3. La redazione al confine di scrittura (classe 3, difesa in profondità)

`core/tracing/redact.ts` resta la casa — non più solo per le trace, il
commento in testa lo dice ora esplicitamente — e guadagna: il passaggio di
`secret://<nome>` come valore sempre mostrabile (è un riferimento, non il
segreto), e tre forme etichettate (`Authorization: Bearer <token>`,
`chiave=valore`/`"chiave": "valore"` per query string/form/JSON, il token bot
Telegram `id:hash`). Niente detector di entropia generico: ogni nuova forma
richiede un'etichetta o un prefisso noto accanto al valore, misurata contro
un corpus di 15 falsi-positivi plausibili (numeri di telefono, UUID,
annotazioni di tipo TypeScript, parole isolate) — zero colpi, dichiarato in
`redact.test.ts`.

**Un solo punto di applicazione**: `agent/loop.ts`, dentro `runTool()`, sia
sul ramo di successo sia sul catch, prima che `outcome.content`/`detail`
tocchino una qualunque delle tre strutture che sopravvivono al turno:
`recordOutcome` (→ `turn_tool_calls.content`), `deps.sessions.append` (→ la
sessione JSONL) e il `tool_result` restituito (→ `turns.messages`, scritto da
`closeRecord`/checkpoint). Dimostrato per lettura di ciascun consumatore:
`TurnStore.endToolCall`/`.finish` e `SessionStore.append` scrivono
`content`/`messages` verbatim, senza una seconda trasformazione — quindi
redigere una volta a monte è sufficiente, non solo conveniente
(`agent/secret-redaction.test.ts`, mutazione verificata: rimuovere la
`redactText()` fa cadere sia il test unitario sia lo scenario di
accettazione `E3`).

`span.error` era già coperto (P34-1, chiuso da `053934f` prima di questa
slice) — la redazione qui è idempotente su un valore già redatto, quindi le
due cuciture non divergono.

### 4. Il token Telegram nell'URL — trovato mentre si verificava il sink

`connectors/telegram/api.ts` costruisce ogni richiesta come
`.../bot<token>/<metodo>`: il token vive nel **path**, non in un header (a
differenza di Discord, che usa `Authorization: Bot <token>` — commento
preesistente in `discord/api.ts`, corretto). `media.ts`, nello stesso
connector, già evitava `error.message` per questo — *"la URL carica il bot
token... non deve mai raggiungere un log, una trace o un errore"* — ma
`api.ts`'s `call()`/`upload()` no: un fetch fallito finiva con
`error.message` dentro `TelegramError`, che `connector.ts` logga a ogni
catch. Probato (non assunto) contro il `fetch` di questo Node — DNS,
connessione rifiutata, timeout, URL malformato — `.message` non porta mai
l'URL oggi; ma il token siede nell'unica stringa che un futuro runtime più
verboso includerebbe per prima, e il costo del fix è nullo. Allineato a
`.name`, come `media.ts` già faceva. Test rosso-prima con un fetch avversariale
che *include già* il token nel proprio `.message` (`connectors/telegram/api.test.ts`),
mutazione verificata.

## Alternative scartate

- **Prune periodico delle righe vecchie**, l'opzione che P34-2 lasciava
  aperta. Scartata: lascia il segreto in chiaro per tutto l'intervallo fra
  una scrittura e il prune successivo, e "mostrabile" durante quell'intervallo
  è già la violazione che la direttiva del 17/08 chiude. Resta valida come
  meccanismo di **retention** generale (già `JsonlExporter.pruneOlderThan`
  per le trace), ma non come risposta a questa direttiva.
- **Cifratura a riposo del database/delle sessioni.** Risolve un problema
  diverso — un attaccante con accesso al disco spento — non quello posto qui:
  un processo vivo che scrive un segreto in chiaro in una riga lo ha già
  esposto a chiunque legga quella riga mentre il processo gira, cifrata o no.
  Ortogonale, non alternativa: se un giorno serve, si aggiunge sopra questa
  garanzia, non al suo posto.
- **Un detector di entropia generico** (qualunque stringa ad alta entropia è
  sospetta). Scartato per direttiva esplicita: un numero di telefono, un
  UUID, un hash git hanno entropia comparabile a un token e nessuno di loro è
  un segreto — il costo sarebbe contenuto reale cancellato, non prudenza.
- **Spostare `readSecret` dentro l'adapter del provider.** Considerata e
  respinta con motivazione (§2 sopra): la chiamata è già inline, il valore
  risolto non sopravvive oltre l'argomento di costruzione, e spostare il
  punto di lettura non avrebbe cambiato dove il valore vive dopo.

## Cosa NON copre

- ~~**`muffin init --api-key CHIAVE`**~~ — **chiuso, non più un rischio
  residuo.** Correzione dell'owner, 2026-08-18: *«un secret è un secret anche
  prima di essere registrato nel backend… nessun secret value in argv; la
  compatibilità di script non prevale sulla garanzia»*. Questa ADR lo aveva
  classificato come non-class-1 perché la chiave non è ancora conosciuta dal
  backend nel momento in cui arriva — ragionamento sbagliato: la finestra fra
  «arriva» e «è nel backend» è precisamente quella in cui la shell history e
  `ps` la vedono, e il valore è lo stesso. Vedi §Revisione in fondo.
- **Righe già scritte in `~/.muffin` reale.** Non toccate, non cancellate —
  "le righe non si cancellano" resta valido. Una bonifica una-tantum
  (`muffin secret scrub`) è **proposta**, non implementata: cercherebbe prima
  i valori esatti che il backend conosce oggi (`locateSecretAll` su ogni
  nome noto in `config.json`), poi in seconda passata le forme regex di
  `redact.ts`, su `turns.messages`, `turn_tool_calls.content` e le sessioni
  JSONL — una UPDATE per tabella più una riscrittura di file, plausibilmente
  sopra le ~80 righe che questa slice si è data come tetto per codice non
  discusso con l'owner. La decisione di eseguirlo sui propri dati resta
  dell'owner; nessun test di questa slice tocca `~/.muffin` reale.
- **Segreti incollati a mano dall'owner in chat.** Classe 3: il detector li
  intercetta se assomigliano a una forma nota, non li garantisce. Un token in
  un formato non elencato passa.

## Reversibilità

**Alta.** Nessuna migrazione di schema: `redact.ts` è una funzione pura
aggiunta a un modulo esistente, il punto di applicazione in `agent/loop.ts`
è una chiamata in più su un valore già di passaggio, il fix di
`connectors/telegram/api.ts` cambia una riga per ramo di errore. Tutto
reversibile con un revert del commit; nessuna riga del database cambia
forma. I pattern di `SECRET_VALUE_SHAPES` sono dati, non contratto: se una
forma produce un falso positivo misurato, si toglie in un commit che lo dice.


## Revisione — 2026-08-18: nessun secret value in argv, e non è una deprecazione

**Correzione dell'owner**, dopo il MERGE di questa ADR: *«`muffin init
--api-key CHIAVE` NON può restare come follow-up se la claim è "i secret non
sono mai mostrati o mostrabili". Un secret è un secret anche prima di essere
registrato nel backend. Il judge non deve dare MERGE alla claim globale finché
esiste un entry point supportato che rende un secret visibile in process list o
shell history.»*

**Cosa cambia.** `--api-key <valore>` non è deprecato con un avviso: è
**rifiutato** (`cli/main.ts`, exit 78, e niente viene scritto — un rifiuto che
installa mezza home sarebbe peggio del difetto). Un avviso arriverebbe quando la
history ha già scritto la chiave, e la finestra è esattamente quella.

**Da dove arriva la chiave adesso**, nell'ordine in cui `init` la cerca:

1. **stdin**, quando `init` non è su un terminale — `echo -n "$KEY" | muffin
   init`. È il percorso di script e CI, ed è lo stesso che `muffin secret set`
   usa da sempre (`readFileSync(0)`, mai `argv`).
2. **il prompt nascosto**, quando c'è un TTY (`promptSecret`, nessun eco).
3. **`secret://provider_api_key` già registrato** — la catena dei backend, che è
   ciò che rende `muffin uninstall --yes && muffin init` un ciclo senza
   reincollare niente (ADR-0030 §`--local`).
4. ~~`MUFFIN_API_KEY` nell'ambiente~~ — **chiusa anche questa** (decisione owner,
   2026-08-18): *«la regola "mai mostrabile" vale anche per l'environment del
   processo principale. Il fatto che `/proc/.../environ` abbia permessi più
   stretti di `cmdline` riduce il rischio, ma non cambia la forma: env resta un
   generic carrier del secret.»* Se la variabile è presente, `init` **fallisce
   chiuso** e il messaggio nomina **solo la variabile** e i rimedi: mai il
   valore, mai un prefisso, mai la lunghezza — «mostrabile» include
   «deducibile». Nessun `*_REF` nuovo: per il Gate 1 il backend che esiste
   basta, e un consumatore che lo richieda non c'è.

**La forma della garanzia, nelle parole dell'owner.** Il valore *deve* esistere
in RAM: un provider HTTP e Telegram devono materializzare la credenziale per
autenticarsi. La proprietà non è «il segreto non esiste», è **da dove passa**:

```
secret backend  →  consumatore privilegiato  →  sink di autenticazione
```

senza mai passare da: model · env generico · argv · risultato di tool · DB ·
log · superficie · approvazione. È forte e mantenibile perché nomina un
percorso, non un'assenza.

**Anche i server MCP.** `muffin mcp add --env K=VALORE` era l'unico modo
documentato di dare una chiave a un server MCP, e la metteva in `argv`
(reperto del judge di questa PR). Ora `--env` accetta **solo** riferimenti
`secret://nome`: il registro su disco tiene il nome, e il valore si risolve
al momento della connessione dentro `core/mcp/connect.ts` — il sink
privilegiato che avvia il figlio — e finisce nell'**environment del figlio**,
mai in `argv`. `core/config/secret-boundary.test.ts` dichiara questo quarto
chiamante di `readSecret` con la sua ragione. Nota che l'env **del figlio** è
il sink autorizzato di quel consumatore, mentre l'env **del processo
principale** non lo è: la differenza è chi lo riceve, non il meccanismo.

**Il percorso stdin funziona anche con un produttore lento.** `process.stdin.isTTY`
mette fd 0 in non-blocking: con `pass show`/`op read`/`gpg -d` a monte,
`readFileSync(0)` lanciava **EAGAIN**, il `catch` lo inghiottiva e `init`
proseguiva **senza chiave, in silenzio** (misurato dal judge:
`(sleep 3; printf 'sk-…') | muffin init` non salvava niente). Ora si usa
`isatty(0)` da `node:tty`, che non tocca lo stream.

**Cosa è stato migrato**: harness di accettazione, `evals/memory/acceptance.ts`
e i test della CLI passano la chiave da stdin. Nessun chiamante di produzione o
di test la mette più in `argv` — e il test che lo pinna è in `cli/main.test.ts`
(«una chiave non passa mai per argv»), rosso quando la guardia viene tolta
(mutazione eseguita: `if (false && …)` → 1 fallimento, gli altri 21 verdi).


## Revisione — il produttore lento, e dove vive la regola dell'`env` MCP

Due reperti del secondo giro di judge, entrambi chiusi.

**1. `readFileSync(0)` perdeva la chiave in silenzio, e `isatty` non bastava.**
La prima correzione aveva spostato la guardia (`process.stdin.isTTY` →
`isatty(0)`) credendo che fosse `cmdInit` a mettere fd 0 in non-blocking. Non
lo è: lo mette un tocco di `process.stdin` **a import time** nel grafo dei
moduli — il bisect del judge arriva a `import('./repl.js')`. Quindi il fd resta
non-bloccante comunque, `readFileSync(0)` lancia **EAGAIN** appena i dati non
sono ancora arrivati, e il `catch` lo leggeva come «nessun valore»: `pass show`,
`op read`, `gpg -d` fallivano in silenzio — **su entrambe le porte**, `init` e
`secret set`. Il fail-closed di `MUFFIN_API_KEY` prescriveva due vie e nessuna
delle due si apriva.

Ora una sola primitiva, `readAllStdin`, con retry su EAGAIN e una scadenza, usata
da tutti e due i comandi; un errore di lettura non diventa mai «nessun valore».
Scartato `openSync('/dev/stdin')`: eredita la stessa open file description e
lancia lo stesso EAGAIN (misurato). Il test che mancava — e la ragione per cui il
difetto è sopravvissuto a un giro — è che una pipe immediata riempie il buffer
prima della lettura e maschera il caso: ora c'è un test con un produttore che
ritarda, rosso quando si toglie il retry.

**2. La regola sull'`env` di un server MCP vive nello schema, non nel parser.**
Un `mcp.json` scritto a mano con un token letterale veniva consegnato al figlio
senza obiezioni: la garanzia dipendeva dal fatto che si passasse da `muffin mcp
add`. Ora `core/mcp/registry.ts` rifiuta un valore che **ha la forma** di una
credenziale, riusando il predicato di `core/tracing/redact.ts`
(`looksLikeSecretValue`) invece di ricopiarne la lista.

È **classe 3, e va letto come tale**: riconosce le forme note (`ghp_…`,
`sk-ant-…`, `Bearer …`, `token=…`), non qualunque stringa. La classe 1 resta
strutturale altrove — il valore noto al backend non passa mai di qui, perché
`--env` accetta solo `secret://nome` e la risoluzione avviene nel sink. E
`LANG=C` o `MCP_MODE=strict` continuano a passare: vietare ogni valore letterale
avrebbe rotto la configurazione legittima senza chiudere niente che la classe 1
non chiudesse già.


## Eccezione dichiarata — `evals/character/run.ts` (2026-08-18)

Reperto del judge del terzo giro, registrato invece che lasciato implicito: lo
strumento del **character eval** prende la chiave da una variabile d'ambiente
(`--api-key-env <VAR>`, `requireEnv`). È la forma che l'owner ha rifiutato per
`MUFFIN_API_KEY`, e finché resta così la frase «non esiste un entry point
supportato che trasporti un segreto in argv o in env generico» sarebbe più larga
di ciò che è provato.

Perché resta, e perché non invalida la claim: `evals/character/run.ts` non è un
percorso del prodotto — non parte da `muffin`, non tocca `readSecret`, non
partecipa alla catena *secret backend → consumatore privilegiato → sink*, e non
gira mai in una installazione dell'owner. È uno strumento di misura che si lancia
a mano quando l'owner autorizza una corsa a pagamento. La claim riguarda il
prodotto; qui la nota serve a impedire che qualcuno la citi come prova di
qualcosa che questo file non rispetta.

Chiuderla è la stessa mossa già fatta due volte (`readAllStdin` da stdin, oppure
leggere `secret://` dal backend con `--api-key-ref`): vale quando l'eval smette
di essere uno strumento e diventa qualcosa che gira da solo — a quel punto è
prodotto, e la regola si applica per intero.
