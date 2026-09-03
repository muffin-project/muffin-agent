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

1. Se ogni host nominato è già nell'allowlist: niente da fare, niente
   domanda.
2. Altrimenti, se non c'è un `chiediConferma` cablato (nessun terminale
   interattivo): stampa esattamente quali host mancano, dove sta il file, e
   il comando a mano — **candidata B**. Non scrive nulla.
3. Se c'è: una sola domanda, che nomina ogni host mancante e dice cosa
   succede ("lo aggiungo e risigillo il root of trust adesso?"). Solo un
   "sì" esplicito procede.
4. Alla conferma: legge `rot/egress.json`, **aggiunge** gli host nominati
   (mai ne infierisce altri, mai sostituisce l'array, `_comment` e ogni
   altra voce restano), scrive, chiama `seal()` (`core/rot/verify.ts`) — la
   stessa funzione che usa `muffin rot reseal`.

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

`sys.shell` (`agent/tools/shell.ts`) è l'unico modo in cui il modello fa
girare un comando arbitrario. Il suo esecutore
(`core/sandbox/executor.ts`, `spawnCollect`) lancia il figlio con
`stdio: ['ignore', 'pipe', 'pipe']` — **mai un TTY**, e la dichiarazione del
tool lo dice esplicitamente ("no PTY — upstream #419 cluster"). `cli/main.ts`
cablabla `chiediConferma`/`chiediChiave` in `SearchDeps`/l'invocazione di
`cmdMcpAdd` **solo quando `isatty(0)` è vero nel processo reale in quel
momento** — non da un parametro, non da una variabile d'ambiente, non da un
flag: `muffin search`/`muffin mcp add` non hanno un `--yes`/`--force` che
salti la domanda, e questa slice non ne ha aggiunto uno apposta. Senza quella
callback, `widenEgressForCapability` rifiuta incondizionatamente e non
scrive un byte.

Due barriere indipendenti, entrambe provate contro un sandbox vero (non un
finto) in `core/rot/egress-shell-escalation.test.ts`:

1. **stdin non è mai un TTY** dentro il figlio sandboxato — misurato
   lanciando `node -e "process.stdout.write(String(!!process.stdin.isTTY))"`
   attraverso lo stesso `SandboxExecutor` che `agent/runtime.ts` costruisce
   in produzione: stampa `false`.
2. **Anche un tentativo diretto di scrivere `rot/egress.json` dal sandbox è
   negato**, indipendentemente da questo CLI: `core/rot/guards.ts`
   (`mandatoryGuards`) mette `paths(home).rot` in `denyWrite` sempre,
   "whatever the per-call scope says" — la stessa lista con cui
   `agent/runtime.ts` costruisce l'esecutore di produzione. La cintura regge
   anche se le bretelle (il TTY) venissero mai bypassate.

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

## Cosa lo farebbe rivedere

- Un futuro modello di estensione (§10, "network destinations... should be
  declared and reviewable") che dia a un server MCP un vero perimetro di
  rete renderebbe `--host` un input strutturato invece che una dichiarazione
  best-effort — a quel punto questa ADR si aggiorna, non si riscrive da capo.
- Se mai comparisse un secondo modo di eseguire un comando arbitrario del
  modello con uno stdin diverso da `stdio: ['ignore', 'pipe', 'pipe']`, la
  prima barriera di questa ADR andrebbe rimisurata su quel percorso.
