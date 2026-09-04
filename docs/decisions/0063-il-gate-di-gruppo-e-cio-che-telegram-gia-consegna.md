# ADR-0063 — Il gate di gruppo è ciò che Telegram già consegna, non un'euristica nuova

**Stato:** proposto · 2026-09-04 · esegue la raccomandazione di
`docs/evidence/muffin-nei-gruppi-2026-09-04.md` §4

> **Proposto, non accettato.** Nessuna riga di codice cambia con questo
> documento, e nessuna riga di codice regge questa decisione finché non è
> implementata. Diventa `accettato` solo con una decisione dell'owner, nello
> stesso commit che implementa il gate in `connectors/telegram/connector.ts`.
> Se l'owner decide diversamente, questo file diventa lineage in
> `docs/history/design-notes/` e la ricerca resta come evidence.

## Contesto

L'owner ha chiesto un gate «devo rispondere?» in tre forme — reply, tag,
caso generale — deterministico, mai un LLM. Oggi **non esiste nessun gate**:
`connectors/telegram/connector.ts:1096-1160` (`drain()`) apre un turno vero
per ogni update che `parseUpdate` non scarta, gruppo o privata, menzionato o
no (`docs/evidence/muffin-nei-gruppi-2026-09-04.md` §1.2).

La ricerca ha trovato un fatto che cambia la forma della domanda:
`core.telegram.org/bots/features`, sezione *Privacy Mode* (consultata
2026-09-04), elenca ciò che un bot con privacy attiva (il default) e non admin
riceve in un gruppo — comandi, comandi generici se il bot ha appena parlato,
messaggi inline, reply — e **una menzione nuda non è nella lista**. Con la
configurazione di default, un messaggio «@nomebot fai X» senza reply non
arriva **al server del connettore**, non solo al gate: Telegram stesso non lo
consegna. Il gate per (1) e per metà di (2) esiste già, fuori dal codice di
questo repository, a costo zero — a patto di non spegnerlo.

## Decisione

1. **Il caso generale (3) non ha un gate**, perché non ha un criterio
   deterministico misurabile — nessuna euristica sul testo viene introdotta.
   Un turno di gruppo parte solo da: un comando esplicito
   (`sembraComando`/`CONTROLLO`, già in `connector.ts:287-291`), una reply a un
   messaggio di Muffin, o una menzione riconosciuta (punto 3).
2. **La reply (1) è il gate implementato per primo**, perché il dato esiste già
   e non richiede nessun cambio di configurazione del bot:
   `reply_to_message.from.id === this.meId` — la stessa condizione che
   `citazione()` (`connector.ts:386-412`) calcola già per etichettare
   `da: 'muffin'`. `drain()` scarta un update di un tenant `group:*` che non
   soddisfi né questa condizione né una delle altre due del punto 1.
3. **La menzione (2) si implementa insieme alla condizione che la rende
   raggiungibile, mai da sola.** Il riconoscimento lato Muffin è un confronto
   deterministico — un'entità `message.entities` di tipo `mention` il cui testo
   (per `offset`/`length` su `message.text`) uguaglia, case-insensitive,
   `@` + `me.username` (cache di `getMe`, già letta in `connector.ts:746`) —
   ma il messaggio arriva al connettore solo se la privacy mode è disattivata
   o il bot è admin del gruppo. Nessuna delle due è oggi un campo di
   configurazione che il codice legge. Prima che (2) funzioni:
   - un campo di configurazione esplicito (`telegramPrivacyModeOff: boolean`
     o simile) che l'owner setta **dopo** aver disattivato la privacy in
     BotFather — mai dedotto, mai controllato a runtime (non è un campo
     dell'API);
   - il gate del punto 1 già implementato e attivo per **ogni** update di
     gruppo, non solo per i messaggi con menzione — perché disattivare la
     privacy mode significa che ogni messaggio del gruppo, non solo quelli
     rivolti a Muffin, raggiunge ora `drain()`.
4. **Il gate vale solo per `principal.kind === 'member'`.** Un turno il cui
   principal è `'owner'` (una DM) non passa da nessuna di queste condizioni:
   non è un restringimento, è già la logica di oggi, resa esplicita qui perché
   il codice del gate deve poter distinguere i due casi per non richiedere
   una reply/menzione anche in privato.

## Cosa questa decisione NON afferma

- **Non decide se, o quando, l'owner disattiverà la privacy mode.** È una
  scelta di configurazione dell'owner sul proprio bot, fuori da questo
  repository. Il punto 3 dice solo cosa deve essere vero nel codice **prima**
  che quella scelta sia sicura da fare.
- **Non tocca l'autorità né il tenant.** Il gate decide se un turno *parte*,
  non chi è il suo principal né dove finiscono i suoi dati — quelle domande
  restano quelle di `docs/evidence/muffin-nei-gruppi-2026-09-04.md` §3, non
  ancora decise.
- **Non chiude il buco di `sys.http` misurato nella stessa ricerca (§6.1).**
  Un turno che *parte* per una reply o una menzione legittima può comunque,
  una volta dentro, fare una `http_get` con una query scelta da contenuto
  tier 2 senza che nessuno la veda — quel problema è indipendente da quale
  messaggio ha aperto il turno, e questa ADR non lo risolve.
- **Non introduce una finestra temporale** («rispondi anche senza tag per N
  secondi dopo l'ultima risposta»): l'evidence (§4.3) la nomina come
  estensione possibile e la scarta per ora, in assenza di una misura su
  conversazioni di gruppo reali.

## Alternative considerate

**Un'euristica sul contenuto del messaggio** («sembra rivolto a un
assistente», «contiene un punto interrogativo e nessun altro destinatario
nominato»). Scartata per vincolo esplicito del brief e della regola di casa:
non è misurabile, e la sua accuratezza dipenderebbe da un modello — esattamente
ciò che il gate deve evitare di chiamare.

**Un LLM economico come classificatore "devo rispondere?".** Scartata: oltre a
violare il vincolo esplicito, sposta il problema invece di risolverlo — un
secondo posto dove un'iniezione può agire (`docs/RESEARCH.md`, criterio
generale su cosa deve restare deterministico), con latenza e costo per ogni
messaggio di un gruppo vivo, non solo per quelli a cui Muffin risponderà.

**Rendere il bot admin invece di disattivare la privacy.** Equivalente per
l'effetto sul gate (entrambi fanno arrivare ogni messaggio), ma admin
concede anche diritti di moderazione (cancellare messaggi, gestire membri) che
qui non servono a niente — un'estensione di capability su Telegram stesso, non
solo di visibilità. Non raccomandata quando la sola disattivazione della
privacy basta.

## Conseguenze

Più facile: il costo di sviluppo è quello misurato in
`docs/evidence/muffin-nei-gruppi-2026-09-04.md` §4 — zero chiamate API
aggiuntive per (1) e (2), un confronto di stringhe contro un valore già in
cache. Più owner-dipendente: (2) non funziona finché l'owner non ha
disattivato la privacy mode sul proprio bot **e** il gate del punto 1 è già
attivo — un ordine di implementazione, non solo di configurazione.

## Reversibilità

**Alta.** Il gate è un filtro *prima* di `runFresh()`, non un cambio di
`identify()`, `tierOf()` o del kernel — toglierlo torna al comportamento di
oggi (un turno per ogni update), non introduce uno stato che sopravvive alla
rimozione.

## Come si prova che il cablaggio c'è

Una sonda che manda a `drain()` tre update sullo stesso tenant `group:*` — un
messaggio senza reply/menzione/comando, uno con `reply_to_message.from.id`
uguale al bot, uno con un'entità `mention` sul suo username — e verifica che
solo gli ultimi due producano un turno (`runFresh` chiamato). Deve fallire da
sola se il filtro viene rimosso da `drain()`, sullo stesso principio con cui
`core/sandbox/home-not-workspace.test.ts` falsifica ADR-0059: un test che
passa anche senza la chiamata non prova questa ADR, prova che il caso non era
coperto.
