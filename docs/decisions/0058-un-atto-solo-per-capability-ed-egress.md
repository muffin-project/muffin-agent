# ADR-0058 — Un atto solo: accendere una capability di rete accende anche l'egress

**Stato:** accettato · 2026-09-03

## Contesto, misurato prima di decidere

Il 03/09/2026, sulla macchina dell'owner: chiave Tavily registrata giusta,
`config.json` giusto, `muffin doctor` verde sulla config — e `web_search`
assente. Il motivo non era in nessuno di quei tre posti:
`agent/runtime.ts` (riga 572) spegne la ricerca al boot con

```
! web_search spento: api.tavily.com non è in rot/egress.json — aggiungilo e rifai `muffin rot reseal`
```

e quella riga non compariva da nessuna parte l'owner stesse guardando in quel
momento — l'ha trovata grepando il proprio log, tre turni dopo.

Misurato lo stesso giorno, fuori dai test:

```
$ grep -rn "egress.json" --include="*.ts" . | grep -v '\.test\.ts'
core/net/egress.ts:42          (il lettore)
core/rot/readers.ts:103        (il registro dei lettori sigillati)
core/config/inventory.ts:123   (l'inventario, sola lettura)
```

**Nessun verbo CLI scriveva `rot/egress.json`.** `cli/search-setup.ts` e
`cli/mcp.ts` non contenevano `egress` né `reseal`. Accendere una capability
che parla con l'esterno erano due atti in due posti, e nulla li teneva
insieme — il secondo posto è per giunta un file sigillato, quindi editarlo a
mano voleva dire anche ricordarsi `muffin rot reseal` dopo.

La domanda dell'owner che inquadra questa slice, testuale:

> «possiamo mettere noi alcune cose negli egress che sappiamo essere sicure?
> o stiamo over engineerizzando sta cosa? o stiamo sbagliando approccio?
> muffin non ha tool perché quella api non sta in un egress» — e poi: «se
> aggiungo un MCP o il search e queste cose, poi ovviamente va aggiunto nei
> vari posti no?»

## L'invariante da non rompere

`muffin rot reseal` è oggi «la parola dell'owner»: l'unica cosa che
distingue una sua modifica da un'intrusione (`docs/SECURITY.md` §12). Un
comando che risigilla parla quindi con la sua autorità, e questo vincola
tutto il resto: **solo l'owner a un terminale vero può far scattare un
allargamento di `rot/egress.json` seguito da un reseal**, mai il modello —
`sys.shell` è l'unico strumento che fa girare comandi arbitrari, e non deve
avere una strada verso questo verbo.

## Alternative pesate

| candidata | forma | perché scartata / accettata |
|---|---|---|
| A — il verbo risigilla dopo conferma esplicita | `muffin search`/`muffin mcp add` chiedono "aggiungo X e risigillo?" e lo fanno | **scelta**: chiedere Tavily *è* l'autorizzazione a parlarle; separare l'atto in due passi è esattamente il difetto misurato sopra |
| B — il verbo prepara e stampa il comando di reseal, senza eseguirlo | come `rot harden`: spiega e propone, non esegue | scartata come default: avrebbe lasciato in piedi il "due atti scollegati" per la maggioranza dei casi (un terminale vero), l'unico dove l'owner è già lì. **Resta il comportamento reale quando non c'è un terminale** — vedi sotto, non è stata buttata, è diventata il ramo non-interattivo |
| C — lasciare com'è, con un errore migliore | migliorare solo il messaggio di `agent/runtime.ts` | scartata: il messaggio a boot era già corretto e comunque non letto nel momento in cui contava; il difetto non è la chiarezza del messaggio, è la mancanza dell'atto |

La scelta è **A per il caso interattivo, B per tutti gli altri** — non una
terza opzione ibrida inventata qui, ma la composizione delle due: la stessa
funzione (`widenEgressForCapability`, `core/rot/egress-writer.ts`) prende
entrambe le strade a seconda che un vero prompt sia stato cablato o no.

## Perché non pre-riempire l'allowlist (la seconda domanda dell'owner)

Il vuoto di `rot/egress.json` è ciò che rende quell'elenco «l'owner ha detto
sì», non un default che sembra sicurezza; un catalogo di host "che sappiamo
essere sicuri" spedito già dentro l'allowlist sposterebbe il consenso da
"l'owner ha chiesto Tavily" a "chiunque installi Muffin fidandosi di una
lista che non ha scritto lui". Non è over-engineering tenerlo vuoto:
**muffin non ha un tool perché quell'API non sta in un egress era il sintomo
giusto, letto nel posto sbagliato** — mancava la porta, non mancava la
prudenza. Questa slice aggiunge la porta e lascia la prudenza dov'era.

## Il meccanismo

Una funzione sola, `widenEgressForCapability` (`core/rot/egress-writer.ts`),
usata da entrambi i chiamanti — non una copia per `search` e una per `mcp`
(lo stesso difetto già registrato una volta,
`docs/decisions/0055-le-due-porte-passano-dal-kernel.md`):

1. **Prima di tutto**, ogni host nominato deve essere sintatticamente un host
   (`isValidEgressHost`): niente schema, porta, percorso, utente, elenco o
   stringa vuota. Un valore che non lo è si rifiuta subito — mai chiesto, mai
   scritto, mai sigillato — con il perché nel messaggio. Aggiunta dopo la
   review indipendente (vedi "Cosa il giudice ha corretto" sotto): prima di
   questo controllo un `--host` malformato (`https://api.tavily.com/`,
   `api.tavily.com:443`, o una variabile di shell vuota, `--host "$X"` con
   `$X` non impostata) finiva scritto e sigillato **con un messaggio di
   successo sopra**, e la stringa vuota in particolare fa fallire
   `loadEgress()` al prossimo boot: il catch muto in `agent/runtime.ts`
   azzera allora ogni host già approvato.
2. Se ogni host (valido) nominato è già nell'allowlist: niente da fare,
   niente domanda.
3. Altrimenti, se non c'è un `chiediConferma` cablato (nessun terminale
   interattivo): stampa esattamente quali host mancano, dove sta il file, e
   il comando a mano — **candidata B**. Non scrive nulla.
4. Se c'è: una sola domanda, che nomina ogni host mancante e dice cosa
   succede ("lo aggiungo e risigillo il root of trust adesso?"). Solo un
   "sì" esplicito procede.
5. Alla conferma: legge `rot/egress.json`, **aggiunge** gli host nominati
   (mai ne infierisce altri, mai sostituisce l'array, `_comment` e ogni
   altra voce restano), scrive, chiama `seal()` (`core/rot/verify.ts`) — la
   stessa funzione che usa `muffin rot reseal`. Se il sigillo fallisce **dopo**
   che `egress.json`/`manifest.json` sono già stati riscritti (`seal()` scrive
   il manifest per primo e l'anchor per secondo: un permesso negato solo
   sull'anchor lascia i due file già cambiati), entrambi vengono rimessi
   esattamente com'erano prima di rispondere — mai uno stato a metà che
   `verify()` leggerebbe come `anchor_mismatch` la prossima volta.

`cli/search-setup.ts` chiama la funzione con l'host derivato
dall'`endpoint` del provider nel catalogo (`core/config/providers.ts`,
`SEARCH_PROVIDERS.tavily.endpoint`) — mai un URL scelto dal chiamante.
`cli/mcp.ts` la chiama con gli host che l'owner scrive esplicitamente con
`--host`, ripetibile: un server MCP locale è già trusted computing base
(`docs/SECURITY.md` §10 — un processo figlio arbitrario, non contenuto da
questo meccanismo), quindi `--host` non è una richiesta di contenimento; è
la dichiarazione che `rot/egress.json` promette già di essere onesta
("everywhere muffin can reach", commento in `agent/tools/search.ts`), estesa
a un secondo produttore invece di restare vera solo per `sys.http`/
`sys.search`.

## Come il modello ne resta fuori — l'asserzione più importante

> **Revisione, 03/09/2026 — dopo la review di un giudice indipendente.** La
> stesura originaria di questa sezione diceva che lo stdin mai-TTY del figlio
> di `sys.shell` FOSSE la barriera. È falso su Linux: il giudice ha fatto
> girare il `SandboxExecutor` di produzione sotto bwrap e ha allocato un pty
> vero per il grande-figlio con `script -qc "…" /dev/null` — presente e non
> privilegiato — e quel processo osserva `process.stdin.isTTY === true`.
> Su macOS/seatbelt l'allocazione del pty è negata dalla policy (`openpty:
> Operation not permitted`), il che aveva reso il test originale verde per il
> motivo sbagliato, sull'unica piattaforma che questo repository non serve in
> produzione. Il testo sotto è la versione corretta: la barriera vera era già
> la seconda, non la prima, e la relazione fra le due va invertita. Codice e
> test corretti nella stessa PR che ha portato questa nota.

`sys.shell` (`agent/tools/shell.ts`) è l'unico modo in cui il modello fa
girare un comando arbitrario. La barriera che regge, su Linux e su macOS, con
o senza un pty allocato, è **la scrittura negata su `~/.muffin/rot`**:
`core/rot/guards.ts` (`mandatoryGuards`) mette `paths(home).rot` in
`denyWrite` sempre, "whatever the per-call scope says" — la stessa lista con
cui `agent/runtime.ts` costruisce il `SandboxExecutor` di produzione. Fallisce
con `EPERM` sotto seatbelt e `EROFS` sotto bwrap, regge a un pty, a un
grande-figlio, a un interprete lanciato di fresco, e non si aggira
dichiarando lo stesso percorso nel proprio `writeScope` per quella singola
chiamata (mandatorio batte esplicito).

`cli/main.ts` cabla `chiediConferma`/`chiediChiave` in `SearchDeps`/
l'invocazione di `cmdMcpAdd` solo quando `isatty(0)` è vero nel processo reale
in quel momento — non da un parametro, non da una variabile d'ambiente, non
da un flag: `muffin search`/`muffin mcp add` non hanno un `--yes`/`--force`
che salti la domanda. Questo resta un gate utile — un `sys.shell` ordinario
(nessun pty allocato: `stdio: ['ignore', 'pipe', 'pipe']`, mai il caso comune)
non arriva mai alla domanda, e senza quella callback
`widenEgressForCapability` rifiuta incondizionatamente — ma è **ergonomia**,
non la ragione di fondo per cui il modello non può allargare l'egress: quella
ragione è il file system.

Due barriere, entrambe provate contro un sandbox vero (non un finto) in
`core/rot/egress-shell-escalation.test.ts`:

1. **Un tentativo diretto di scrivere `rot/egress.json` dal sandbox è
   negato**, indipendentemente da questo CLI — la barriera vera, provata sia
   sul percorso ordinario sia con un pty allocato apposta (`isTTY===true`),
   dove un pty si può allocare; altrove il test si salta esplicitamente
   (`t.skip()`, mai un `return` silenzioso) con la ragione stampata, e
   `MUFFIN_REQUIRE_SANDBOX=1` (il runner Linux di CI) trasforma quello skip
   in un fallimento.
2. **Sul percorso ordinario (nessun pty), stdin non è mai un TTY** dentro il
   figlio sandboxato — misurato lanciando `node -e
   "process.stdout.write(String(!!process.stdin.isTTY))"`: stampa `false`.
   Vero, utile, e — come sopra — non la ragione per cui il modello non può
   arrivare a scrivere.

`core/rot/egress-writer.test.ts` prova il terzo pezzo, a livello di unità:
senza `chiediConferma`, senza consenso esplicito ("sì"/variazioni), o con un
EOF sulla domanda, la funzione non tocca mai il file e `muffin rot verify`
resta pulito dopo.

## Cosa NON fa questa slice

- Non cambia la matrice di policy, le righe di effetto, né alcuna decisione
  in `core/policy/**`.
- Non pre-riempie l'allowlist con niente: ogni host che finisce in
  `rot/egress.json` è nominato esplicitamente dall'owner (via provider scelto
  o `--host`), mai dedotto da un URL o da un comando.
- Non stabilisce un contenimento di processo per i server MCP: restano
  trusted computing base come da `docs/SECURITY.md` §10, invariato.
- Non tocca `agent/runtime.ts`: il controllo a boot
  (`hostAllowed(endpointHost, egress)`) resta lì, invariato, ed è quello che
  ora trova l'host già presente nel caso comune.

## Cosa il giudice indipendente ha corretto (03/09/2026)

Una prima versione di questa slice è tornata con verdetto ADJUST, non
REJECT: l'esito (un atto solo, l'owner resta l'unica autorità) reggeva, ma
tre punti della prova no. Registrati qui perché il file di codice e i test
cambiano, ma il perché merita di restare leggibile senza riaprire la PR:

1. **La barriera contro `sys.shell` era descritta al contrario.** Vedi la
   revisione in cima a "Come il modello ne resta fuori" sopra — il gate
   `isatty(0)` è ergonomia, la scrittura negata su `rot/` è la barriera.
2. **`--host` non veniva validato come host prima di scrivere e sigillare.**
   `isValidEgressHost` (punto 1 di "Il meccanismo" sopra) chiude sia
   l'iniezione (`https://…`, `…:443`, un elenco, un utente) sia l'incidente
   ordinario (`--host ''` da una variabile di shell non impostata, che senza
   il controllo azzerava silenziosamente ogni host già approvato al prossimo
   boot).
3. **La scrittura e il sigillo non erano atomici.** Un permesso negato solo
   sull'ultimo dei due file che `seal()` scrive (l'anchor, dopo il manifest)
   lasciava `egress.json`/`manifest.json` già cambiati mentre il messaggio
   diceva "niente scritto" — punto 5 di "Il meccanismo" sopra ripristina i
   byte di prima quando questo succede.

Due note più piccole, non bloccanti: il test "non inferisce host non
nominati" usava un host a due sole etichette, che non avrebbe distinto una
mutazione verso un wildcard sul genitore — ora ne usa tre; e `seal(home, '1',
…)` regredisce `rotVersion` a `"1"` a ogni chiamata invece di preservare
quello corrente — corretto leggendo il manifest esistente prima di
risigillare, invece di lasciarlo come nota.

## Revisione — 2026-09-03: i sei follow-up del terzo giro di judge, chiusi

Il terzo giro di judge (68 casi mirati più un fuzz da 3 milioni di stringhe
contro `hostAllowed()`) ha dato MERGE senza blocchi, e sei follow-up non
bloccanti. Nessuna delle decisioni sopra cambia — la conferma, la regola
"solo interattivo", la barriera write-deny restano esattamente quelle. Sei
rinforzi:

1. **Il pavimento anti-SSRF ora vale anche per chi scrive.** `127.0.0.1`,
   `169.254.169.254` (il metadata endpoint cloud) e ogni indirizzo RFC1918
   superavano `DNS_LABEL` — ogni ottetto è cifre, e una sequenza di cifre è
   un'etichetta DNS valida — quindi finivano proposti, confermabili, scritti
   e sigillati. Non erano raggiungibili comunque da `sys.http`:
   `addressVeto` (`agent/tools/http.ts`) chiama `isForbiddenAddress`
   (`core/net/egress.ts`) su ogni hop, indipendentemente da questa allowlist
   — verificato leggendo il codice, non per fiducia. `sys.search` non è
   esposto allo stesso rischio per un motivo diverso: il suo host non viene
   mai da `rot/egress.json`, viene dal catalogo (`SEARCH_PROVIDERS`) — la
   voce nell'allowlist serve solo a spegnere/accendere quell'host fisso,
   `hostAllowed()` non sceglie mai dove connettersi. `--host` di `muffin mcp
   add` non fa mai connettere nulla di suo: dichiara soltanto (§10, MCP resta
   TCB). Non abbiamo trovato un consumatore dell'allowlist che dialoghi con
   un host nominato dall'owner senza passare da `isForbiddenAddress` — se
   in futuro ne comparisse uno, questo non sarebbe più solo un rinforzo, ma
   un buco vero, e andrebbe segnalato come tale. `isValidEgressHost` ora
   rifiuta un letterale IPv4 forbidden (`core/rot/egress-writer.ts`); un
   letterale IPv6 era già escluso da `DNS_LABEL` (contiene `:`).
2. **`rollbackFallito` aveva zero copertura** — l'unica riga owner-facing del
   modulo senza un test. Riprodotto mockando `writeFileSync` per fallire da
   subito dopo la prima scrittura riuscita in poi (stesso metodo del judge),
   cosicché `egress.json` si scriva davvero, `seal()` fallisca sul suo primo
   write e **anche** il tentativo di rimettere `egress.json` com'era fallisca
   — lo stato che il messaggio deve ammettere, mai tacere.
3. **Il messaggio di rollback fallito incollava due percorsi con `/`**
   (`…/egress.json//var/…/manifest.json`, leggibile come un unico percorso
   inesistente). Ora sono separati con " e ".
4. **Nessun tetto sulla lunghezza totale.** `DNS_LABEL` fermava un'etichetta
   oltre i 63 caratteri ma non il nome intero oltre i 253 (RFC 1035 §3.1):
   cinque etichette da 60 caratteri passavano ciascuna il limite di etichetta
   e insieme superavano comunque 253. `isValidEgressHost` ora rifiuta anche
   questo.
5. **`EgressFileSchema` era in modalità strip.** Una chiave che l'owner
   scrive a mano in `rot/egress.json` (una nota, un promemoria) spariva alla
   prossima riscrittura fatta da `widenEgressForCapability`, senza che nulla
   lo dicesse. Delle tre strade — tacere e scartare, tacere e conservare,
   rifiutare e dirlo — scartare in silenzio è la peggiore: distrugge
   qualcosa che una persona ha scritto nel proprio file, senza che se ne
   accorga. Fra le altre due, abbiamo scelto **conservare** (`.loose()` in
   `core/net/egress.ts`) e non **rifiutare**: nessun codice legge mai una
   chiave sconosciuta (`loadEgress` proietta solo su `allow`), quindi
   conservarla non costa niente in sicurezza, mentre rifiutare bloccherebbe
   un `muffin search`/`mcp add` legittimo per una nota che non c'entra con
   la richiesta in corso — lo stesso genere di attrito sproporzionato che
   questo repository ha già segnato altrove come un difetto, non come
   prudenza.
6. **`muffin mcp add --host "$X"` con `$X` vuoto (o un host altrimenti non
   valido, o senza terminale) usciva sempre 0**, anche quando l'host
   nominato non veniva aggiunto — deliberato: il server MCP resta comunque
   approvato, un fallimento sull'egress non disfa un'approvazione già
   scritta (vedi "Il meccanismo" sopra). Ma uno script che lancia quel
   comando e guarda solo l'exit code non aveva modo di accorgersi che
   l'allargamento non è avvenuto: l'output è per un terminale, non per uno
   script. Abbiamo scelto l'**exit code**, non un output più vistoso: `muffin
   mcp list --verify` già usa questa convenzione in questo stesso file
   ("pulito" → 0, "qualcosa da rivedere" → 1) — coerenza con un precedente
   già scritto, non una seconda regola inventata qui. `cmdMcpAdd` ora esce 1
   quando `--host` è stato nominato ma `widenEgressForCapability` non
   aggiunge tutto; la registrazione del server non viene toccata.

Nessuna di queste sei tocca `mandatoryGuards`, `core/sandbox/**`, la
conferma o la regola "solo interattivo" — sono rinforzi sopra un meccanismo
che il terzo giudice ha già accettato, non una revisione della decisione.

## Cosa lo farebbe rivedere

- Un futuro modello di estensione (§10, "network destinations... should be
  declared and reviewable") che dia a un server MCP un vero perimetro di
  rete renderebbe `--host` un input strutturato invece che una dichiarazione
  best-effort — a quel punto questa ADR si aggiorna, non si riscrive da capo.
- Se mai la scrittura negata su `~/.muffin/rot` smettesse di essere
  mandatoria per qualunque `writeScope` — per esempio un cambiamento a monte
  in `@anthropic-ai/sandbox-runtime` che facesse vincere l'allow esplicito sul
  deny — la barriera vera di questa ADR sparirebbe e andrebbe ricostruita,
  non solo ri-testata.
