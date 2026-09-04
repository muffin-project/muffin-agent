# Muffin nei gruppi — identità, autorità, tenant, e il gate che manca

**Data:** 2026-09-04 · **Stato:** evidence datata, non authority · **Head:**
`dev` `1335aa6` (worktree `slice/ricerca-gruppi`) · **Passo:** ricerca secondo
`docs/RESEARCH.md`, nessuna riga di runtime toccata. Include un episodio di
dogfood vero avvenuto *durante* la stesura di questo documento (§7).

Commissionata dalle parole dell'owner: *«vorrei che riesca a riconoscere owner
tramite uid»* · *«dovremo fare in 3 modi, il reply a muffin, il tag di muffin, e
poi anche in generale»* · *«deve essere sicuro, deve avere tool limitati, deve
avere un suo workspace/vault per il gruppo, anche il concetto di community,
gruppi con topics»* · *«devi distillare i docs online di telegram»*. E, arrivata
a metà ricerca, dal dogfood: *«nel gruppo voglio: vault, web search, voglio
comunque il loop, voglio comunque un minimo di capability e utility,
specialmente in base al gruppo»*.

## 0. La tesi in tre frasi

I tre assi — identità, autorità, tenant — sono **già separati in codice**, e la
separazione regge: verificato leggendo `core/surface/types.ts`, verificato
esplicitamente durante la stesura di questo documento su una conversazione di
gruppo vera dell'owner. Il gate «devo rispondere?» **non esiste**, e delle tre
forme richieste solo la prima (reply) è pienamente deterministica sul lato
Muffin: la seconda (tag) è deterministica *sul lato Telegram* solo a
condizioni che oggi il codice non verifica, e la terza (il caso generale) non
ha un criterio deterministico e non deve averne uno inventato. Il divario più
urgente misurato non è nell'elenco che l'owner ha nominato: è che il gate sui
parametri di `sys.http` — l'unica difesa contro un membro di gruppo che sceglie
i byte di una richiesta di rete — **è già oggi silenziosamente inerte per ogni
turno di gruppo**, misurato eseguendo il kernel vero (§6.1), e questo viene
prima di ogni discussione su `web_search`.

## 1. Lo stato di oggi, misurato

### 1.1 Identità, autorità, tenant sono tre variabili distinte

`identify()` (`core/surface/types.ts:287-318`) decide le tre cose da un'unica
funzione condivisa da ogni connector:

- **identità** — chi parla: sempre l'account, mai il nome visualizzato
  (`IncomingIdentity.authorId`, commento a `core/surface/types.ts:238-251`
  cita testualmente l'owner: *«Le persone dobbiamo riconoscerle SEMPRE per uid
  o cose così, in modo che non si possano fingere l'owner»*);
- **autorità** — `principal.kind`: `'owner'` solo se `incoming.direct === true`
  **e** l'id combacia (`core/surface/types.ts:287-303`). L'owner che scrive
  *dentro* un gruppo produce `kind: 'member'`, mai `'owner'` — è la riga
  305-317, guardata esplicitamente da
  `connectors/telegram/impersonation.test.ts:47-51` (*«does not promote the
  owner to host tenant inside a group»*);
- **tenant** — `` `group:${connector}:${conversationId}` `` (riga 305): la
  stanza, non la persona che vi parla in quel momento.

`tierOf()` (`core/surface/types.ts:330-332`) è una quarta funzione, derivata
dalla sola autorità: `member` → tier 2, sempre, indipendentemente da chi sia il
`member` — l'owner in un gruppo e uno sconosciuto nello stesso gruppo hanno la
stessa trust tier. Questo è **deliberato**, non un difetto: è la riga che rende
impossibile per un membro fingersi l'owner cambiando solo la stanza.

### 1.2 Nessun gate «devo rispondere?» esiste

Verificato leggendo il ciclo di drenaggio: `drain()`
(`connectors/telegram/connector.ts:1096-1160`) itera ogni update non ancora
processato e chiama incondizionatamente `this.resolve(stored, incoming)`
(riga 1131) per **qualunque** update che `parseUpdate` non abbia scartato — un
messaggio privato, un messaggio di gruppo, con o senza menzione, con o senza
reply. `resolve()` porta a `runFresh()` (riga 1297), l'unico punto del file che
chiama il modello — un turno vero, non un rispondente a pattern. Non c'è
nessuna condizione fra `parseUpdate` e `runFresh` che guardi `isPrivate`, le
`entities`, o `reply_to_message`. L'unico filtro upstream di questo file è
quello che Telegram stesso applica lato server con la privacy mode (§2.1) —
e oggi il codice non lo sa, non lo verifica, e non può: non è un campo
dell'update.

### 1.3 Il gruppo ha già la sua sessione, il suo tenant, il suo tier — provato in accettazione

`evals/acceptance/scenarios/b-una-conversazione.accept.ts:286-335` costruisce
un update di un `supergroup` (`chat: { id: -100_500, type: 'supergroup' }`) e
verifica **sui file di sessione realmente scritti**:
`sessions/telegram:-100500.jsonl` esiste ed è diverso da `sessions/owner.jsonl`
(righe 319-325); un fallimento del confine produce l'errore esplicito «il
messaggio di gruppo è finito nella conversazione dell'owner» (riga 331). Questo
non è teoria: è un file scritto da un binario vero, letto da un test vero.

### 1.4 Il tool sandbox: tre capability sono raggiungibili da un gruppo, tutte le altre no

`hostOnly` (`core/policy/types.ts`, campo del `CapabilityDecl`, «never
reachable from a remote tenant, by construction») è oggi un booleano per
capability, non per tenant. Elenco completo per grep
(`agent/tools/*.ts`, 2026-09-04):

| capability | file | `hostOnly` |
|---|---|---|
| `memory.search` (`memory.ts`) | `agent/tools/memory.ts:42` | **`false`** |
| `documents.read` (`document.ts`) | `agent/tools/document.ts:46` | **`false`** |
| `sys.http` (`http.ts`) | `agent/tools/http.ts:53` | **`false`** |
| `sys.search` (`web_search`) | `agent/tools/search.ts:70` | `true` |
| `fs_read`/`fs_write`/… | `agent/tools/fs.ts:194,224,238,254` | `true` |
| `sys.shell` | `agent/tools/shell.ts:44` | `true` |
| `process.*` | `agent/tools/process.ts:32,45` | `true` |
| `mcp.*` | `agent/tools/mcp.ts:49` | `true` |
| `surface.deliver_file` | `agent/tools/deliver.ts:59` | `true` |
| `sys.inspect` | `agent/tools/inspect.ts:55` | `true` |
| `sys.skill` | `agent/tools/skill.ts:31` | `true` |
| `todo.*` | `agent/tools/todo.ts:92` | `true` |
| `sys.wait` | `agent/tools/wait.ts:127` | `true` |

Il kernel applica l'esclusione al livello del principal, non del tool:
`core/policy/decide.ts:143-146` — *«host-only excludes remote tenants, not
autonomous local principals»* — nega ogni capability `hostOnly: true` a un
`principal.kind === 'member'`, indipendentemente dal tenant specifico. Non
esiste oggi un insieme dichiarato *per tenant*: è binario, globale, uguale per
ogni gruppo.

Le due "porte" che il modello non sceglie mai come tool ma che il loop attraversa
da sé — `surface.reply` e `memory.write` (`core/policy/doors.ts:33-74`) — sono
`hostOnly: false` per costruzione: un turno di gruppo deve poter rispondere nel
suo gruppo e scrivere nella sua memoria, o le due funzioni base (rispondere,
ricordare) non esisterebbero per un tenant `group:*`.

`documents.read` è scoperto scoped al tenant **nel codice, non solo nel
commento**: `resourceKind: 'tenant'` (`agent/tools/document.ts:33-46`), e il
commento lo dichiara esplicitamente — *«scoped to the turn's tenant, so a
group's agent can only reach a document indexed for that group»*. Verificato
che non esiste un tool di **scrittura** nel vault/documenti per nessun
principal — grep su tutto `agent/` e `core/`: nessun `documents.write`,
`vault.write`, `document_add` o simile. L'unica strada che oggi popola il
vault è l'ingestione automatica di un allegato in arrivo, mai una scelta
deliberata del modello a metà turno («salva questo link»). Questo vale anche
per l'owner: non è un limite specifico dei gruppi.

### 1.5 Il budget ha già un tetto per tenant, indipendente da quello globale

`core/budget/budget.ts:28-29`: `perTenantDailyUsd`, commento *«Groups are the
noisy ones»*. `tenantExhausted()` (righe 127-130) esclude esplicitamente
`HOST_TENANT` dal tetto giornaliero — la spesa dell'owner non è mai limitata
da questo numero, quella di un gruppo sì, ogni giorno. `decide.ts:171`
consulta `ctx.budgetExhausted(tenant)` per **ogni** capability di rischio non
`low` — `sys.search` incluso, se mai venisse abilitato per i gruppi.

### 1.6 Il corpus avversariale: due porte sono `ALLOW` a ogni taint, per decisione, non per svista

`docs/evidence/eval-taint-corpus-avversariale-2026-09-03.md` §3.3 (righe
136-148): la scena `s7-memoria-e-ricordo` pianta un'istruzione in un file letto
con `fs_read`, la fa riassumere, e osserva `memory.write → allow a taint 2`,
episodio marchiato `trust_tier 2`, **nessun gate**. `core/policy/doors.ts:1-70`
conferma che questo non è un buco dimenticato: `replyCapability` e
`memoryWriteCapability` sono dichiarate `risk: 'low'` di proposito, e la riga
del threat model per entrambe è `ALLOW · ALLOW · ALLOW` ad ogni taint — è
ADR-0055 e lo riconferma ADR-0061 (2026-09-04, proposto, non ancora accettato)
respingendo esplicitamente l'idea di un gate su queste due righe come «una
conferma in più». Per un gruppo questo significa: **qualunque** membro (tutti
tier 2, indistinguibili) può far scrivere nella memoria *del proprio tenant* un
contenuto avvelenato senza che nessun cancello lo fermi; verrà poi recuperato
correttamente etichettato come `gruppo/sconosciuto`
(`core/memory/recall.ts:976-989`, funzione `describeEpisodeSource` — la
riparazione di un bug precedente in cui un ruolo veniva confuso con il tier,
commento riga 967-975), ma l'etichetta non è un cancello: il modello legge la
memoria e decide, e nessuna capability nega un'azione solo perché il contesto
che l'ha suggerita porta quell'etichetta, oltre al tetto di taint che quel
contenuto comunque impone sulle azioni successive del turno.

**Cosa il corpus non copre** (dichiarato lì, non qui): «un membro di un gruppo
che avvelena il contesto di un turno il cui `reply` esce nel gruppo è la scena
che manca» (riga 194-195 del corpus). Nessuna delle sette scene gira su una
superficie remota.

### 1.7 ADR-0061 (proposto, 2026-09-04) ha già nominato la condizione che riaprirebbe questa domanda — verificata qui, e non si è ancora verificata

`docs/decisions/0061-un-solo-confine-non-basta.md`, sezione *Alternative
considerate*: propone e scarta *"la riga `reply` impara la destinazione"*,
dicendo perché **ora** non serve — *«la fuga cross-tenant che la
giustificherebbe non esiste su HEAD, perché `identify()` fa dell'owner-in-un-
gruppo un `member` di quel tenant e ogni capability che tocca il disco o la
shell è `hostOnly: true`»* — e nomina la condizione che la riaprirebbe: *«una
capability `hostOnly: false` che porti byte dell'host dentro un turno di
gruppo»*.

Questa ricerca verifica quella condizione sulle tre capability oggi
`hostOnly: false`: `memory.search` e `documents.read` sono scoped al tenant del
turno per costruzione (§1.4) — non portano byte dell'*host*, portano byte del
*tenant stesso*; `sys.http` porta byte della rete pubblica, non della casa.
**Nessuna delle tre soddisfa oggi la condizione che ADR-0061 ha nominato.** Il
confine non si è ancora rotto su questo asse. Resta rotto su un asse diverso,
che ADR-0061 non copriva: non «byte della casa dentro il gruppo», ma «byte del
gruppo fuori verso la rete» — §6.1.

## 2. Telegram, distillato dalla fonte

Fonti: `core.telegram.org/bots/api` e `core.telegram.org/bots/features`,
consultate 2026-09-04. Sono pagine vive, non versionate con una data propria:
citarle richiede la data di consultazione, non una versione.

### 2.1 Privacy mode — la scoperta che sposta il progetto del punto 2

Dalla pagina Features, sezione *Privacy Mode*: con privacy mode **attiva**
(il default per ogni nuovo bot) e il bot **non admin**, ciò che arriva al bot
in un gruppo è **solo**:

- comandi espliciti al bot (`/comando@nomebot`);
- comandi generici (`/start`) **se il bot è stato l'ultimo a scrivere**;
- messaggi inline;
- **reply** a un messaggio del bot, esplicito o implicito.

Sempre consegnati, a prescindere dalla privacy: messaggi di servizio, messaggi
da chat private, messaggi da canali di cui il bot è membro.

**La menzione semplice (`@nomebot ciao`, senza comando e senza reply) non
compare in questa lista.** Verificato leggendo la sezione per intero: l'elenco
di ciò che *arriva* con privacy attiva nomina solo le quattro voci sopra. Una
menzione nuda non è un comando, non è un reply: con privacy attiva e bot non
admin, **quel messaggio non arriva affatto al bot** — non è che arriva e viene
scartato, è che il server di Telegram non lo consegna. Questo è il fatto che
l'owner ha chiesto di verificare, ed è confermato.

*«Privacy mode is enabled by default for all bots, except bots that were added
to a group as admins (bot admins always receive all messages)»* — un bot admin
non ha privacy: riceve **ogni** messaggio del gruppo, menzioni nude comprese,
e con esse ogni messaggio che oggi, con la privacy di default, non genera
nemmeno un turno.

**Conseguenza per il punto 2 del brief (tag/menzione).** Il gate deterministico
sul lato Muffin per «sono stato menzionato» esiste già e costa zero righe di
codice — **a patto che** la privacy mode sia disattivata (via BotFather,
`/setprivacy`) o il bot sia admin del gruppo. Nessuna delle due condizioni è
verificabile a runtime: la privacy mode non è un campo esposto da nessuna
chiamata dell'API bot, si legge e si cambia solo in BotFather. Il codice non
può sapere in che stato si trova senza che l'owner gliel'abbia detto a
configurazione. **E il prezzo di attivare quella condizione non è isolato al
punto 2**: disattivare la privacy o rendere il bot admin significa che *ogni*
messaggio del gruppo, non solo quelli rivolti a Muffin, arriva al connector —
e senza un gate (§1.2), oggi ognuno aprirebbe un turno vero. Il punto 2 e il
punto 3 (caso generale) sono quindi la stessa domanda vista da due gradi
diversi di apertura, non due domande indipendenti.

### 2.2 Entities — `mention` contro `text_mention`

Dalla API reference, tipo `MessageEntity`: `"mention"` copre un intervallo di
testo che è letteralmente `@username` — nessun id utente allegato, solo
l'offset e la lunghezza dentro `text`. `"text_mention"` è per un utente **senza
username**: porta un campo `user` con l'oggetto `User` intero, incluso l'id
numerico.

Per riconoscere «Muffin è stato menzionato» in modo deterministico quando la
menzione arriva davvero (privacy off o bot admin): cercare fra le `entities`
del messaggio un'entità `type === 'mention'` il cui testo (`message.text`
tagliato su `offset`/`length`) sia uguale, case-insensitive, a `@` +
`me.username` — lo `username` restituito da `getMe`, già interrogato e messo in
cache dal connector all'avvio (`connectors/telegram/connector.ts:746`, log
*«telegram: connesso come @…»*). Zero chiamate API aggiuntive, zero modello:
un confronto di stringhe contro un valore già in memoria.

### 2.3 Forum topics — oggi non gestiti, e la posizione motivata

Grep su `connectors/`, `core/`, `agent/` per `message_thread_id`,
`is_topic_message`, `forum_topic_*`: **zero occorrenze**, in codice o test.
`parseUpdate` non legge il campo — un messaggio in un topic e un messaggio nel
canale generale dello stesso supergruppo producono oggi **lo stesso**
`conversationId` (`message.chat.id`), quindi lo stesso tenant, la stessa
sessione, la stessa memoria.

`message_thread_id` è dichiarato dalla API solo per «supergroups and private
chats» — un forum è un supergruppo con i topic abilitati. `is_topic_message`
dice se un dato messaggio appartiene a un topic; i quattro
`forum_topic_created/edited/closed/reopened` sono messaggi di servizio che
annunciano la struttura.

**Posizione motivata: un topic è una sotto-conversazione dello stesso tenant,
non un tenant a sé.** Tre ragioni:

1. **il rischio non cambia per topic.** Chi scrive in un topic è comunque un
   membro dello stesso gruppo, con lo stesso accesso alle stesse persone —
   promuovere il topic a tenant separato non isola nessun rischio nuovo, isola
   solo la memoria dentro uno stesso insieme di persone fidato allo stesso
   modo (o allo stesso modo non fidato);
2. **un tenant per topic moltiplica gli oggetti da governare** (sessione,
   memoria, vault, budget) per un confine che Telegram stesso tratta come
   navigazione dentro una chat, non come una chat diversa — `chat.id` resta lo
   stesso;
3. **la sessione, non il tenant, è il posto giusto per la distinzione.** Se in
   futuro serve continuità separata per topic (due conversazioni nello stesso
   gruppo che non devono confondersi — esattamente il problema che ha motivato
   `sessionKey` in `core/surface/types.ts:182-213`), la soluzione è
   `sessionKey` che include `message_thread_id` quando presente, non un
   secondo tenant. Costa una funzione pura in più nello stesso file che già
   costruisce `sessionKey`, non un secondo schema di vault/memoria/budget.

Questo non è implementato: è la raccomandazione che questa ricerca consegna, da
verificare col criterio di falsificazione del punto 8.

### 2.4 Tipi di chat

`Chat.type`: `'private' | 'group' | 'supergroup' | 'channel'`. Per un bot:
`private` e `group`/`supergroup` sono l'oggetto di questo documento; un
`channel` è strutturalmente diverso — il bot non è un "membro" nel senso dei
gruppi, riceve `channel_post`/`edited_channel_post` (non `message`), e postare
richiede diritti di amministrazione sul canale. `parseUpdate` oggi legge solo
`update.message ?? update.edited_message` (`connectors/telegram/connector.ts:294`):
un canale non produce nessuno dei due, quindi oggi **un canale non genera
nessun turno** — non per una decisione esplicita, ma perché la forma
dell'update non incontra mai il ramo che la leggerebbe. `group` e `supergroup`
sono intercambiabili per la logica di questo repository: nessun campo distingue
oggi il comportamento fra i due, correttamente — la sola differenza rilevante
qui (i topic) è già coperta da `is_topic_message`, non dal tipo di chat.

### 2.5 Diritti di admin e `getChatMember`

`getChatMember(chat_id, user_id)` restituisce un `ChatMember` la cui variante
`ChatMemberAdministrator` porta i campi `can_delete_messages`,
`can_restrict_members`, `can_promote_members`, `can_change_info` e altri. È
**una chiamata API separata per ogni verifica** — non c'è un campo
sull'`Update` che dica «chi ha scritto è admin»: saperlo costa una round-trip
di rete per messaggio se lo si volesse controllare ad ogni turno, o va messo in
cache con un TTL (i diritti di admin cambiano di rado ma cambiano). Nessun
codice in questo repository chiama oggi `getChatMember` — grep negativo su
`connectors/`.

### 2.6 `allowed_updates` — la difesa più economica, e i suoi limiti reali

`allowed_updates` (parametro di `getUpdates`/`setWebhook`) filtra per **tipo di
update** — `message`, `edited_channel_post`, `callback_query`, `inline_query`,
`poll`, `poll_answer`, `chat_member`, `message_reaction`,
`message_reaction_count`, e altri — non per tipo di chat. **Non esiste un modo
di dire a Telegram «non mandarmi i messaggi di gruppo ma mandami quelli
privati»**: quel filtro è la privacy mode (§2.1), configurata sul bot intero,
non un parametro di polling. Il valore reale di `allowed_updates` per questo
progetto è escludere categorie che oggi arrivano e non servono mai —
`message_reaction`, `message_reaction_count`, `poll_answer` se non si costruisce
mai un sondaggio — riducendo traffico e superficie di parsing, non riducendo
l'esposizione ai gruppi.

### 2.7 Rate limit

Da `core.telegram.org/bots/faq`, sezione sui limiti di invio: **un messaggio al
secondo** per singola chat; **non più di 20 messaggi al minuto** in uno stesso
gruppo; per notifiche di massa a chat diverse, **circa 30 messaggi al
secondo**, salvo broadcast a pagamento. Rilevante per un gruppo vivo con più
turni ravvicinati: il limite di 20/min per gruppo è basso rispetto a una
conversazione animata con più partecipanti che scrivono a raffica, e oggi
**ogni** messaggio apre un turno (§1.2) — un gruppo di dieci persone che
scrivono un messaggio ciascuna in un minuto produrrebbe dieci turni e
rischierebbe di superare il tetto con le sole risposte, prima ancora di
considerare eventuali messaggi di stato.

## 3. I tre assi, separati, con almeno due combinazioni e il loro costo

**Identità** (chi sta parlando), **autorità** (cosa può far fare), **tenant**
(dove finiscono i dati) sono oggi impostati così: identità sempre per uid;
autorità sempre `member` in gruppo, mai `owner`; tenant sempre il gruppo, mai
`host`. Questa è la combinazione **A**, quella in produzione oggi.

### Combinazione A — quella di oggi: nessuna promozione, mai

- **Identità**: per uid, sempre — anche in gruppo, Muffin sa *chi* dei membri
  sta scrivendo (`principal.externalId`), anche se non gli concede niente in
  più per questo.
- **Autorità**: mai promossa. L'owner in un gruppo è un `member` come chiunque
  altro.
- **Tenant**: sempre del gruppo.
- **Costo**: l'owner in un gruppo non può chiedere a Muffin di leggere un file
  sul disco, lanciare uno script, o attingere alla sua memoria privata — anche
  se è **lui** a chiederlo, e anche se lo chiede per un motivo legittimo
  («controlla se ho quel documento nel mio vault personale»). L'unico modo per
  ottenere quelle capability è passare in privato.
- **Perché regge**: è quanto misura ADR-0061 (§1.7) — nessuna capability
  `hostOnly: false` porta oggi byte della casa in un turno di gruppo, quindi
  non c'è niente da promuovere che aprirebbe un buco *se* la promozione ci
  fosse. Il costo è tutto in usabilità, zero in sicurezza aggiuntiva
  guadagnata rispetto a B qui sotto — ma è la combinazione che **non** dipende
  da chi altro è nel gruppo.

### Combinazione B — riconoscere l'owner *come persona*, senza promuoverlo ad autorità

Identità per uid (uguale ad A); **tenant sempre del gruppo** (uguale ad A);
**autorità**: l'owner riconosciuto resta `member`, ma Muffin sa che è *lui* — e
può, per esempio, rivolgersi a lui per nome, non trattare le sue parole come
"gruppo/sconosciuto" di pari peso di uno sconosciuto ai fini di ciò che *dice*
(non ai fini di ciò che gli è *concesso fare*), o dargli priorità nel
riassumere «cosa ho perso» quando riapre la chat.

- **Costo di implementazione**: minimo. `identify()` già distingue
  `authorId === ownerId` per decidere `kind`; separare "riconosciuto come
  owner" da "autorizzato come owner" è una terza informazione, non due rami
  alternativi — un campo in più su `SurfaceIdentity` o sul principal
  (`isRecognizedOwner: boolean`, indipendente da `kind`), letto solo da ciò che
  *parla* (system prompt, tono), mai da `decide.ts`.
  Non richiede una migrazione di schema: `tierOf` e ogni verifica del kernel
  restano intatte.
- **Rischio nuovo**: minimo e nominabile — se quel segnale finisse per
  influenzare *anche* una sola decisione del kernel (per esempio: "se
  riconosco l'owner, alzo silenziosamente il taint massimo consentito"),
  Combinazione B **diventerebbe** una variante di autorità-promossa dalla
  porta sbagliata. La difesa è architetturale: quel campo non deve mai
  attraversare `core/policy/`. Falsificabile con un test che pianta il campo
  a `true` con un `principal.kind === 'member'` e verifica che `decide()`
  produca lo stesso identico verdetto con e senza di esso.
- **Perché potrebbe essere quello che l'owner vuole**: risponde esattamente
  alla frase originale — *«riconoscere owner tramite uid»* — senza toccare
  *«deve essere sicuro»*, la frase che segue nella stessa richiesta. Le due non
  sono in tensione se restano su assi diversi.

### Combinazione C — scartata esplicitamente: autorità promossa in gruppo

Menzionata solo per completezza e per essere respinta con la ragione scritta,
non per omissione: se l'owner-in-gruppo diventasse `kind: 'owner'` (o
un'autorità intermedia con accesso a capability `hostOnly: true`), **chiunque
altro nel gruppo vede il contesto in cui l'owner parla** e può costruire un
messaggio che, letto dal modello subito dopo un turno genuino dell'owner,
sembra continuare la sua richiesta. Il gate «un membro non tocca `hostOnly`»
oggi para questo per costruzione, indipendentemente da chi altro è nel canale;
promuovere l'owner spegnerebbe quella difesa proprio nel posto — un gruppo —
dove il numero di persone che possono tentare l'induzione è più alto che
ovunque altro. **Non riaprire questa combinazione senza l'evidenza che
ADR-0061 chiede**: un caso reale in cui l'assenza di autorità-in-gruppo ha
impedito qualcosa che l'owner voleva legittimamente fare da lì.

## 4. Il gate «devo parlare?», nelle tre forme richieste

Questa sezione è distillata in una decisione proposta:
`docs/decisions/0063-il-gate-di-gruppo-e-cio-che-telegram-gia-consegna.md`.

### 4.1 Reply a Muffin — deterministico, e già praticamente pronto

`reply_to_message` è nel messaggio se c'è, sempre, indipendentemente dalla
privacy mode (§2.1: le reply sono nella lista di ciò che arriva anche con
privacy attiva). Il connector legge già `reply_to_message` per la citazione
(`connectors/telegram/connector.ts:386-412`, funzione `citazione`) e sa già
distinguere se il messaggio citato è di Muffin (`da: 'muffin'`, confrontando
`replied.from.id` con `botId`). **Il gate esiste già come dato**: manca solo
usarlo per decidere se aprire un turno nel caso generale non già coperto da
altre condizioni — vedi §4.3. Costo: zero chiamate aggiuntive, il campo è già
letto.

### 4.2 Tag/menzione — deterministico solo a una condizione non verificabile a runtime

Come misurato in §2.1 e §2.2: rilevare una menzione è un confronto di stringhe
sulle `entities` — deterministico, gratuito. Ma **arriva** solo se la privacy
mode è disattivata o il bot è admin, e nessuna delle due condizioni è leggibile
da codice. Tre implicazioni pratiche:

1. con la configurazione di default di un nuovo bot (privacy attiva, non
   admin), oggi la menzione nuda **non arriva mai**, quindi il "gate" per
   questo caso è vuoto per definizione — non c'è niente da filtrare perché non
   c'è niente da ricevere;
2. attivare la ricezione delle menzioni significa attivare la ricezione di
   *ogni* messaggio del gruppo (§2.1) — il costo non è isolabile al solo scopo
   «riconosci quando mi chiamano»;
3. la configurazione stessa (stato della privacy mode) andrebbe registrata
   *da qualche parte che il codice legge* — oggi non esiste un campo di
   configurazione per questo, perché finora non serviva a niente saperlo.

**Raccomandazione**: se l'owner vuole il tag funzionante, la sequenza corretta
è (a) disattivare la privacy mode via BotFather per il bot che userà nei
gruppi; (b) implementare **prima** un gate esplicito lato Muffin che, quando la
privacy è (dichiarata) disattivata, scarta ogni messaggio di gruppo che non sia
un comando, una reply a Muffin, o una menzione — così il costo di "ricevo
tutto" non diventa "rispondo a tutto". Il punto (b) è precisamente il gate che
manca oggi (§1.2), e il tag lo rende necessario invece che opzionale.

### 4.3 Il caso generale — nessun criterio deterministico esiste, e non va inventato

Non c'è un campo dell'update, una entity, o una combinazione di essi che dica
in modo affidabile «questo messaggio, pur non essendo un comando/reply/tag, è
comunque rivolto a Muffin». Qualunque euristica sul *testo* («contiene "muffin"
in minuscolo», «finisce con un punto interrogativo») è esattamente il tipo di
regola che sembra intelligente e non è misurabile, che il brief vieta
esplicitamente. Il ripiego onesto, in ordine di costo crescente:

- **Ripiego minimo (raccomandato ora)**: solo (1) e (2), più i comandi
  espliciti che il connector già riconosce (`sembraComando`,
  `connectors/telegram/connector.ts:289-291`, `CONTROLLO`). Nessun caso
  generale. Un gruppo che vuole Muffin deve rivolgersi a lui — reply, tag, o
  comando. È la stessa postura che la privacy mode di Telegram assume di
  default, e questo documento non ha trovato una ragione per essere più
  permissivi di Telegram stesso su questo punto.
- **Estensione nominabile ma non raccomandata ora**: una finestra temporale
  dopo l'ultima risposta di Muffin in quel gruppo, durante la quale un
  messaggio senza reply/tag viene comunque considerato "rivolto a lui" — è
  deterministico (un timestamp, un confronto), ma sposta il criterio da «cosa
  ha detto la persona» a «quanto tempo è passato», che è una euristica
  comportamentale diversa da quelle vietate solo nel senso che è misurabile,
  non nel senso che sia ovviamente corretta: in un gruppo attivo produce falsi
  positivi (Muffin risponde a un messaggio non per lui, arrivato subito dopo
  la sua ultima risposta) esattamente nella finestra in cui il rumore è più
  alto. Non implementata, non raccomandata senza una misura su conversazioni
  di gruppo reali che dica quanto spesso l'owner vorrebbe che scattasse.
- **Mai**: un LLM che decide se rispondere. Vietato esplicitamente dal brief e
  dalla regola di casa, e comunque introdurrebbe esattamente il costo
  (chiamata a un provider, latenza, un secondo posto dove un'iniezione può
  agire) che il gate deterministico esiste per evitare.

## 5. Workspace, vault, topics, community

### 5.1 Workspace

ADR-0059 (2026-09-03, accettato) ha appena separato **la casa**
(`~/.muffin`, installazione) dal **workspace** (`~/muffin-workspace` o
equivalente, dove un turno scrive) — ma è **uno per installazione**, non uno
per tenant: `resolveWorkspace(home, cwd)` non prende un tenant come argomento
(`core/config/workspace.ts`, citato da ADR-0059 punto 3). Un workspace per
gruppo non esiste e non è previsto da quella decisione. Dargliene uno
costerebbe: uno schema di percorsi (`workspace/tenants/<tenant>/` o simile),
una regola su chi può nominare quel percorso (solo il turno il cui
`ctx.tenant` combacia — lo stesso pattern già usato da `documents.read`),
e — soprattutto — **nessuna capability che scriva lì oggi esiste per un
gruppo**: `fs_write` è `hostOnly: true` (§1.4), quindi anche con un workspace
per tenant un membro di gruppo non avrebbe comunque un tool per scriverci,
a meno di non riaprire `fs_write` per i membri, che è la Combinazione C del
punto 3 applicata al disco invece che all'autorità. La richiesta dell'owner
(«magari salverà link da una parte») non è quindi una richiesta di workspace:
è una richiesta di **vault scrivibile** — punto successivo.

### 5.2 Vault per gruppo

Oggi: `documents.read` è già scoped al tenant (§1.4) — un gruppo legge solo i
documenti indicizzati per il **suo** tenant, non quelli dell'owner. Questo è
già, di fatto, "un vault per gruppo" sul lato lettura, e regge: verificato nel
codice, non nella prosa.

Manca interamente il lato **scrittura deliberata**: non esiste, per nessun
principal, un tool che dica «salva questo». I due soli produttori di scritture
durevoli oggi sono automatici — l'ingestione di un allegato (vault) e la
scrittura di ogni episodio di un turno (`memory.write`, la porta di §1.6) — mai
una scelta esplicita del modello a metà turno. Aggiungere «Muffin, salva questo
link» è quindi una capability **nuova di zecca**, non l'apertura di un
interruttore esistente, e porta con sé domande che questa ricerca non decide
perché eccedono lo scopo (non implementare):

- **effect row**: `memory` (come la porta) o una riga propria? Se `memory`,
  eredita `ALLOW` a ogni taint (§1.6) — un membro di gruppo potrebbe far
  scrivere nel vault del **suo** tenant un link scelto da lui senza che nessuno
  lo veda, che è lo stesso rischio di `s7` applicato a un'azione deliberata
  invece che a un effetto collaterale;
- **reversibilità**: `draft` con undo (come `fs_write`) o `allow` diretto?
  Un `draft` richiederebbe un giornale di scritture del vault che oggi non
  esiste;
- **chi la vede**: se il vault resta scoped al tenant (come `documents.read`),
  un link salvato da un membro è visibile a *tutto* quel gruppo, incluso
  l'owner se mai vi partecipasse — coerente con "è la memoria del gruppo", da
  confermare che sia quello che l'owner intende.

Raccomandazione: trattarla come una slice a sé, con la propria ricerca
(`docs/RESEARCH.md`) prima dell'implementazione — è la prima capability di
scrittura deliberata e selettiva che il sistema avrebbe mai avuto, per
qualunque tenant, owner incluso.

### 5.3 Topics

Vedi §2.3: sotto-conversazione dello stesso tenant, mai implementato oggi,
raccomandazione motivata di non farne un tenant a sé.

### 5.4 Community

L'owner nomina il concetto senza definirlo. **Non serve ancora, ed è una
risposta valida**: non esiste oggi nessun caso d'uso misurato che un tenant
`group:*` non copra già, e nessun codice o test menziona `community:` se non
come possibilità dichiarata nel tipo (`core/policy/types.ts`, commento su
`TenantId`: *«'host' | `group:${connector}:${externalId}` | `community:${slug}`»*)
— il tipo la prevede sintatticamente, niente la produce. Definire "community"
prima di avere un secondo caso concreto (un gruppo che deve condividere memoria
con un altro gruppo? una persona che appartiene a più gruppi con un profilo
comune?) sarebbe progettare uno schema per un requisito che oggi è un nome e
non un problema.

## 6. Il verdetto di sicurezza

### 6.1 Misurato eseguendo il kernel vero, 2026-09-04: il gate sui parametri di `sys.http` è inerte per un turno di gruppo

Eseguito `core/policy/decide.ts` (`createDecide`) con `POLICY_FLOOR`
(`core/policy/matrix.ts`), la dichiarazione reale di `httpCapability`
(`agent/tools/http.ts`) e un host fittizio in allowlist, per un principal
`member` di un tenant di gruppo:

```
member taint=2 http_get allowlisted+query   → {"effect":"allow"}
member taint=3 http_get allowlisted+query   → {"effect":"deny", code:"resource_denied", detail:"params blocked at taint 3 (ceiling 2)"}
member taint=2 http_get allowlisted, no query → {"effect":"allow"}
owner  taint=2 http_get allowlisted+query   → {"effect":"allow"}
```

`gateParams` (`core/policy/decide.ts:343-351`) nega o chiede solo quando
`taint > ceiling`, e `paramsMaxTaint` è **2** (`core/policy/matrix.ts:204`).
`tierOf(member)` è **sempre 2** (`core/surface/types.ts:330-332`), e il taint
di partenza di un turno è `max(tierOf(principal), contentTaint)`
(`agent/loop.ts:948`, commento riga 608). **Un turno di gruppo parte esattamente
al soffitto del gate**, quindi `taint <= ceiling` è vero per costruzione finché
nient'altro nel turno ha alzato il taint a 3 — e `gateParams` restituisce
`null`, cioè nessun cancello, per **ogni** chiamata `http_get` con parametri
verso un host in allowlist fatta da un membro di gruppo che non abbia ancora
letto qualcosa di tier 3. Questo non è un caso limite: è il caso **normale**,
perché ogni contenuto di un gruppo è già tier 2 dal solo fatto di essere stato
scritto lì.

Per l'owner in privata la stessa riga di codice esiste, ma il taint 2 non è la
condizione di partenza: ci arriva solo se il turno ha già letto un inoltro o
una citazione di terzi (`contentTaintOf`, `connectors/telegram/connector.ts:493-499`).
In un gruppo, ci arriva **sempre**, da chiunque scriva. Il gate è lo stesso
codice, ma il suo effetto pratico per i due tenant è opposto: raro per l'owner,
assente per un gruppo.

**Conseguenza misurata, non congetturata**: oggi, un membro qualunque di un
gruppo (tier 2, indistinguibile da uno sconosciuto) può far scegliere al
modello una stringa di query per un `http_get` verso un host già in allowlist
— per esempio un motore di ricerca, un endpoint di traduzione, qualunque host
l'owner abbia già autorizzato per altri scopi — e quella stringa esce senza che
nessuno la veda o la approvi, perché la sola difesa dichiarata per questo
identico scenario (`http.ts`, commento riga 32-36: *«above `paramsMaxTaint` the
owner is asked and shown the whole URL, everyone else refused»*) non scatta
mai in un gruppo. `hostAllowed` decide *dove* può andare la richiesta; niente
decide *cosa* ci può essere scritto sopra, quando chi scrive è già a tier 2 per
definizione.

### 6.2 Prima di `web_search`: la stessa misura si applica identica

`sys.search` usa lo stesso meccanismo — `gateParams(principal, taint,
ctx.matrix.paramsMaxTaint, ...)` sulla `query` (`agent/tools/search.ts:69`,
`resourceKind: 'query'`) — verificato eseguendo il kernel:

```
member taint=2 sys.search (hostOnly:true oggi) → {"effect":"deny", code:"principal_forbidden", detail:"host-only capability"}
```

Oggi `hostOnly: true` intercetta la richiesta *prima* che `gateParams` la
veda, quindi il buco di §6.1 non esiste ancora per `web_search` — ma solo
perché la porta è chiusa a monte, non perché il gate a valle regga. **Se
`hostOnly` diventasse `false` per `sys.search` senza toccare `paramsMaxTaint` o
il punto di partenza del taint di gruppo, si erediterebbe esattamente lo stesso
buco misurato in §6.1**, questa volta su una query di ricerca invece che su un
URL: un membro di gruppo farebbe scegliere al modello il testo di una ricerca
(che esce verso il provider di ricerca configurato) senza che nessuno lo veda.

Il commento che giustifica oggi `hostOnly: true` su `sys.search`
(`agent/tools/search.ts:33-35`) dà come ragione la spesa — *«a group member has
no business spending [the owner's credits]»* — ma quel rischio è **già** coperto
indipendentemente dal `hostOnly`: `perTenantDailyUsd` (§1.5) tetta la spesa di
*qualunque* capability di rischio non basso per il tenant del gruppo, `sys.search`
inclusa se mai fosse abilitata (`risk: 'medium'`, quindi `budgetExhausted(tenant)`
si applica). **La ragione scritta oggi per tenere `web_search` fuori dai gruppi
non è più l'unica difesa contro il suo unico rischio reale**: il rischio reale
non è la spesa (già gestita altrove), è l'identico problema di §6.1 — il testo
che lascia il turno è scelto da un contesto già a tier 2 per definizione, e il
gate pensato per fermarlo a quel tier non fermerebbe niente.

**Conclusione su questo punto, eseguendo l'istruzione ricevuta**: il problema
misurato in §6.1 (`http_get`) viene prima di qualunque discussione su
`web_search`, non dopo. Aprire `web_search` ai gruppi *oggi*, senza prima
correggere o accettare esplicitamente il comportamento di §6.1, aggiungerebbe
un secondo canale con lo stesso buco invece di riusarne uno già misurato. La
correzione non è oggetto di questa ricerca (che non implementa), ma la
direzione è nominabile: o si abbassa `paramsMaxTaint` per la classe di
richieste che un turno di gruppo può fare (renderebbe il gate `ask`/`deny`
invece di `allow` per *ogni* query-carrying request di gruppo, il che è quasi
certamente troppo largo — bloccherebbe anche richieste innocue), o si dà al
gate un secondo criterio oltre al taint assoluto — per esempio "questa query
contiene byte che non erano già nel messaggio più recente del turno" (un
confronto di provenienza, deterministico, nello spirito di
`docs/evidence/confini-per-compito-2026-09-03.md` §0, che propone esattamente
questo per `http_get` in generale, non solo per i gruppi). Nessuna delle due è
implementata qui.

### 6.3 Cosa NON è rotto, verificato e non solo supposto

- Il confine di tenant regge: nessuna capability porta oggi memoria, documenti
  o file dell'owner dentro un turno di gruppo (§1.7).
- I sink misurati dal corpus avversariale che *riescono* senza guardia (`s3`,
  `s6`) usano `fs_read`+`sys.shell`, entrambi `hostOnly: true`: non sono oggi
  raggiungibili da un membro di gruppo. Il corpus lo dice esplicitamente (riga
  200-202): quella scena manca, non è stata misurata fallire.
- `reply` e `memory.write` sono `ALLOW` a ogni taint per **decisione**
  (ADR-0055, riconfermata da ADR-0061), non per svista: restano tali dopo
  questa ricerca, che non trova un'evidenza nuova sufficiente a riaprirle
  (il vincolo esplicito di ADR-0061 stesso).

### 6.4 Il verdetto, esplicito

**Mettere Muffin in un gruppo di persone non fidate è sicuro oggi per
tutto ciò che tocca il disco, la shell, i processi, MCP e i file dell'owner** —
`hostOnly: true` para quell'asse per costruzione, indipendentemente da chi è
nel gruppo. **Non è ugualmente sicuro per due cose più sottili**: (a) la
memoria *di quel gruppo* può essere avvelenata da un qualunque membro senza
guardia (§1.6) — il danno resta dentro quel tenant, ma dentro quel tenant è
totale, per sempre finché quell'episodio non viene rimosso; (b) `http_get` può
oggi far uscire, verso un host già allowlisted, una query scelta da un membro
qualunque senza che nessuno la veda (§6.1) — il danno esce dal tenant, verso la
rete, anche se non verso l'owner.

**Cosa lo renderebbe più sicuro**: (a) è mitigato solo trattando la memoria di
un gruppo di sconosciuti come "non fidata di per sé", cioè non aspettandosi che
sia utile ricordare a lungo termine cose dette in quel gruppo — una scelta di
prodotto, non di codice, finché `memory.write` resta una porta e non un tool;
(b) è corretto da uno dei due meccanismi nominati in §6.2, nessuno dei due
implementato qui.

## 7. Il dogfood, misurato durante questa ricerca

Sul database vivo dell'owner, in aggregato (non copiato qui il contenuto):
un tenant `group:telegram:<id>` ha accumulato **2 turni**, entrambi conclusi
(`done`), e **4 episodi**, tutti `trust_tier 2`; il tenant `host` nello stesso
intervallo ne ha **224** e **464** rispettivamente. Il confine di tenant ha
tenuto — nessuno dei quattro episodi di gruppo è finito nella sessione
dell'owner, verificato per conteggio separato.

Alla domanda «cosa sai fare qui?», Muffin ha risposto correttamente e da solo
di avere tre cose in gruppo — cerca in memoria, legge porzioni di documenti già
indicizzati, fa fetch di URL solo su host in allowlist — e ha detto «in gruppo
ho meno tool che in privato», rifiutandosi di chiamare un tool a vuoto. Questo
combacia esattamente con la tabella di §1.4: le uniche tre capability
`hostOnly: false` sono `memory.search`, `documents.read`, `sys.http`. Non è
stato chiesto al modello di sapere questo — l'ha dedotto correttamente da quali
tool gli erano stati offerti nel prompt di quel turno, il che è la prova più
diretta possibile che il cablaggio (dichiarazione → prompt → comportamento)
funziona end-to-end, non solo nel kernel isolato.

## 8. Cosa farebbe cambiare la raccomandazione

- **Una misura del taint reale di conversazioni di gruppo vive**, non solo la
  garanzia teorica "member → 2": se in pratica il turno arriva quasi sempre a
  3 (per citazioni, inoltri, allegati) il buco di §6.1 sarebbe meno rilevante
  (denyAll invece di allowAll silenzioso) — ma anche più rumoroso, perché ogni
  `http_get` verrebbe negato invece che eseguito. Nessuna misura di questo tipo
  esiste oggi su gruppi reali.
- **Un secondo tenant che condivide dati con il primo**: riaprirebbe la
  domanda "community" (§5.4) con un caso concreto invece che un nome.
- **Un caso reale in cui l'owner, parlando in un gruppo, ha avuto bisogno di
  una capability `hostOnly: true`** e non ha potuto ottenerla passando in
  privato: riaprirebbe la Combinazione C (§3), con l'onere della prova su chi
  la propone, come richiede ADR-0061.
- **Una scena del corpus avversariale eseguita su una superficie remota**
  (`group:telegram:*`) invece che CLI/REPL: sposterebbe §6.3 da "non misurato
  fallire" a un verdetto vero in un senso o nell'altro — è la scena che il
  corpus stesso dichiara mancante.
- **Un utilizzo di `message_thread_id` misurato come necessario** (due
  conversazioni nello stesso forum che si confondono davvero) sposterebbe §2.3
  da raccomandazione a implementazione.

## 9. Domande poste senza reperto

- Il bot che l'owner userà nei gruppi sarà mai reso admin, per una ragione
  diversa dalla menzione (per esempio: cancellare messaggi, gestire membri)?
  Se sì, la privacy mode smette di applicarsi comunque, e il gate di §1.2
  diventa obbligatorio prima di quel giorno, non dopo.
- L'owner vuole che i link "salvati" in un gruppo (§5.2) siano visibili anche a
  lui fuori da quel gruppo, o restino proprietà del tenant del gruppo? Cambia
  se il vault di gruppo è "un vault in più" o "un'estensione filtrata di
  quello dell'owner" — le due hanno costi di schema molto diversi.
- Esiste già, o è prevista, una whitelist di gruppi in cui il bot verrà
  installato — cioè l'owner tratterà "gruppo" come sinonimo di "gruppo che ho
  scelto io" o come "qualunque chat dove qualcuno mi aggiunge"? Cambia
  interamente la lettura di §6.4: il rischio misurato assume "persone non
  fidate", che è il caso peggiore dichiarato nel brief, non necessariamente il
  caso che accadrà.

## 10. Nota sul brief in corso d'opera

Il brief è stato aggiornato a metà ricerca con il dogfood del §7 e la richiesta
di eseguire il kernel prima di raccomandare `web_search` (§6). Questo documento
incorpora entrambi; non esiste una versione precedente da riconciliare, perché
questa è la prima e unica stesura.
