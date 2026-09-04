# ADR-0063 — Il gate di gruppo è nostro, perché l'owner spegne quello di Telegram

**Stato:** accettato · 2026-09-04 · sostituisce la stesura del mattino, il cui
perno è caduto per una decisione dell'owner nello stesso giorno

> La prima stesura si intitolava «il gate è ciò che Telegram già consegna» e
> concludeva che metà del filtro era gratis **a patto di non spegnere la
> privacy mode**. L'owner l'ha spenta di proposito. La ricerca resta valida; la
> conclusione no.

## Contesto

Fino al 04/09/2026 **non esisteva nessun gate**: `drain()` apriva un turno vero
— modello, memoria, tool — per ogni update che `parseUpdate` non scartasse,
gruppo o privata, menzionato o no.

A proteggere l'owner era la *privacy mode* di Telegram, accesa per default, che
a un bot non-admin non consegna nemmeno una menzione nuda
(`core.telegram.org/bots/features`, letta il 04/09/2026). Il filtro esisteva
fuori dal nostro codice, a costo zero.

**L'owner ha deciso di spegnerla.** Vuole che Muffin *veda* la conversazione e
scelga quando parlare, non che riceva solo ciò che gli è indirizzato — perché il
passo successivo è l'intervento spontaneo, e un agente che non vede non può
scegliere. Quella decisione sposta il filtro dentro il nostro codice, e da quel
momento questa funzione è l'unica cosa fra un gruppo attivo e un turno per
messaggio.

**L'ordine è vincolante**: il gate prima, la privacy mode dopo. Al contrario,
ogni riga del gruppo apre un turno vero.

## Due modi di vedere tutto, e non sono equivalenti

La ricerca sulla fonte primaria (04/09/2026) ne dà due:

- **`/setprivacy` su BotFather.** Richiede di **ri-aggiungere il bot al gruppo**
  perché il cambio abbia effetto — *«the bot will need to be re-added to the
  group for this change to take effect»*.
- **Promuovere il bot ad amministratore.** *«bot admins always receive all
  messages»*: un bot admin bypassa la privacy mode a prescindere dal flag.

La seconda strada sblocca anche i **messaggi effimeri** (Bot API 10.2/10.3):
un bot non-admin può mandarne solo entro 15 secondi da un'azione, mentre *«if
the bot is a chat administrator, it can send an ephemeral message to any
non-bot member of the chat at any time»*. È la risposta vera alla richiesta
dell'owner «Telegram permette di ricevere il messaggio solo tu» — un ASK
visibile a lui soltanto dentro un gruppo. Non implementato qui; nominato perché
la scelta admin/non-admin lo decide.

Un tetto da tenere presente per il passo successivo: **20 messaggi al minuto**
per gruppo (`core.telegram.org/bots/faq`).

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

## Una divergenza dichiarata: la menzione si riconosce sul testo

Il punto 3 prescriveva di leggere `message.entities` di tipo `mention` e
confrontare per `offset`/`length`. L'implementazione confronta invece lo
username sul testo, con un confine di parola
(`@nome(?![A-Za-z0-9_])`, case-insensitive).

La ragione è che `Incoming` non porta le entities, e portarle solo per questo
avrebbe allargato la fetta. La differenza pratica: un `@nomebot` dentro un
blocco di codice apre un turno, dove le entities non lo farebbero. È un falso
positivo che costa un turno in più, non un falso negativo che perde un
messaggio — la direzione accettabile fra le due. Il confine di parola copre il
caso che conta davvero, `@nomebot2` che non deve risvegliare `@nomebot`, ed è
provato.

Se un giorno le entities entrano in `Incoming` per un'altra ragione, questo
confronto va sostituito: è la forma che la fonte primaria rende esatta.

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
