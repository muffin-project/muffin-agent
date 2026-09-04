# Autorità a tre livelli nei gruppi — la proposta dell'owner, falsificata

**Data:** 2026-09-04 · **Stato:** evidence datata, non authority · **Head:**
`dev` `57bc772`. Passo: ricerca secondo `docs/RESEARCH.md`, nessuna riga di
runtime toccata da questo documento (il fix del cedimento in apertura di
`visibleTools`, commit separato sullo stesso ramo, è indipendente e già
verificato). Costruita sopra
`docs/evidence/muffin-nei-gruppi-2026-09-04.md`, che non riapre.

## 0. La domanda, e perché non è già risposta

L'owner ha proposto un modello a tre livelli — **host** (lui, sulla sua
macchina), **group host** (chi amministra un gruppo Telegram), **group
member** — per comandi e per tool, più un'idea specifica: un tool che oggi
chiede conferma (`ask`) potrebbe aprirsi ai membri *a patto che* la conferma
la dia un admin. Per istruzione esplicita di questa repository, **una
proposta dell'owner è un'ipotesi da falsificare, non una specifica da
implementare** — vale per le decisioni passate di Muffin e identicamente per
quelle di oggi, sue comprese.

Questo documento tratta i tre livelli come il candidato B di una tavola di
decisione (§4), non come il punto di partenza. Il verdetto (§5) è che **nessun
livello intermedio è oggi giustificato da un rischio misurato**, e spiega
perché "no" è qui una consegna riuscita quanto "sì" — con un criterio di
falsificazione esplicito per quando dovesse smettere di esserlo.

## 1. Lo stato di oggi, misurato di nuovo

`docs/evidence/muffin-nei-gruppi-2026-09-04.md` §1.4 ha già misurato la
tabella `hostOnly` per capability. Qui la parte che quel documento **non**
copre: l'autorità sui **comandi slash**, e cosa succede eseguendo il kernel
con più tenant/taint sulla stessa capability.

### 1.1 I comandi slash sono già binari, e più stretti di quanto temuto

`connectors/telegram/connector.ts`, `tryCommand()`:

```ts
private async tryCommand(incoming: Incoming): Promise<boolean> {
  if (!this.deps.comandi || !sembraComando(incoming.text)) return false;
  const { principal, sessionKey } = principalFor(incoming, this.deps.config.ownerUserId);
  if (principal.kind !== 'owner') return false;
  ...
```

**Ogni** comando in `agent/comandi.ts` — incluse le quattro leve di ADR-0054
(`/stop`, `/steer`, `/pause`, `/resume`, quest'ultime due capaci di fermare
*tutti* i tenant, non solo quello che le invoca) — è oggi raggiungibile **solo
dall'owner**, verificato leggendo il gate, non supposto. Non esiste un
comando `groupmember` o `grouphost` da qualche parte che questa riga
scavalchi: la lista è vuota, il gate è totale. Il commento sopra la funzione lo
dice esplicitamente e dà la ragione — "un comando mai eseguito ... torna
`false` e il messaggio prosegue come tutti gli altri", perché rivelare che il
comando esiste già è un'informazione a uno sconosciuto.

`/update` non esiste nemmeno come voce di `COMANDI` (grep negativo su
`agent/comandi.ts`): è un'operazione di `cli/update.ts`, mai esposta su
Telegram. La richiesta dell'owner — *«/update sarà hostonly»* — è quindi già
vera per costruzione, non perché qualcosa lo dichiari `hostOnly: true`, ma
perché il comando non esiste sulla superficie dove un non-owner potrebbe
digitarlo. Se `/update` diventasse mai un comando Telegram, erediterebbe lo
stesso gate di ogni altro comando in questo file: nessuna riga nuova da
scrivere, nessun terzo livello da inventare per questo caso specifico.

### 1.2 `ask.audience` è un letterale, non un campo

`core/policy/types.ts`: `{ effect: 'ask'; ask: { audience: 'owner'; prompt: string } }`.
`core/policy/decide.ts:84-86`, la funzione `ask()`, non prende l'audience come
parametro — lo scrive lei stessa, sempre `'owner'`. Ogni chiamata a `ask()` nel
file (quattro punti: egress fuori allowlist, `gateParams` per l'owner, rischio
`high`, il secondo cancello sul taint della riga `askAbove`) eredita lo stesso
letterale. Estendere l'audience a un terzo valore è, oggi, un cambio di tipo in
un punto solo — non un refactoring — ma resta un cambio di tipo per una cosa
che nessuna capability dichiarata userebbe mai, come il prossimo paragrafo
misura eseguendo.

### 1.3 Eseguito il kernel vero: nessuna capability oggi produce `ask` per un member

Costruito `createDecide` con `POLICY_FLOOR` e ogni `CapabilityDecl` che
`agent/runtime.ts` registra davvero (fs, process, document, http, search,
memory, inspect, skill, shell, wait, todo, send_file, più le due porte
`DOORS`), interrogato per un `member` di tenant di gruppo e per l'owner, a
ogni taint valido (0-3):

| capability | hostOnly | risk | member @taint2 | member @taint3 | owner @taint0 | owner @taint2 |
|---|---|---|---|---|---|---|
| fs.write | true | medium | deny:principal_forbidden | deny:principal_forbidden | draft | **ask** |
| sys.process.kill | true | high | deny:principal_forbidden | deny:principal_forbidden | **ask** | **ask** |
| sys.shell | true | high | deny:principal_forbidden | deny:principal_forbidden | **ask** | **ask** |
| documents.read | false | low | allow | allow | allow | allow |
| memory.read/write, surface.reply | false | low | allow | allow | allow | allow |

(riga completa, dodici capability più due porte, eseguita 2026-09-04 su `dev`
`57bc772`; omesse qui le righe `sys.http`/`sys.search` perché il probe usava
un `resource` sintetico non coerente con `resourceKind: 'url'|'query'` e il
loro esito preciso è già misurato correttamente in
`docs/evidence/muffin-nei-gruppi-2026-09-04.md` §6.1-6.2, che questo
documento non ripete).

**Ogni** capability dichiarata oggi che un member può raggiungere
(`hostOnly: false`) è `risk: 'low'` → sempre `allow`, mai `ask`. **Ogni**
capability che produce `ask` è `hostOnly: true` → negata a un member *prima*
di arrivare a quel ramo. La riga `if (taint > row.askAbove && byRisk.effect
!== 'ask') return ask(...)` (`decide.ts:290-292`) non guarda `principal.kind`,
quindi *potrebbe* produrre un `ask` per un member su una futura capability
`hostOnly: false` a rischio non-basso con un `row.askAbove` raggiungibile a
taint ≤3 — ma non esiste oggi. Falsificabile in un colpo: dichiarare una
capability `hostOnly: false`, `risk: 'medium'|'high'` con un effect row il cui
`askAbove` è ≤3, e osservare se un member la raggiunge in `ask`.

**Conseguenza per l'idea "ask risolto da un admin":** è valutata oggi contro un
insieme vuoto. Non c'è nessun `ask` diretto a un member da redirigere a un
admin, perché nessun member raggiunge mai `ask` — raggiunge `allow` (rischio
basso, sempre aperto) o `deny` (rischio non basso, sempre chiuso da
`hostOnly`). L'idea non è sbagliata in astratto; è una risposta a una
domanda che il sistema non pone ancora, perché non esiste una capability a
metà strada fra "sempre allow per chiunque" e "mai per un member".

## 2. Telegram, dalla fonte, 2026-09-04 — quello che il documento precedente non aveva

Fonti: `core.telegram.org/bots/api`, `core.telegram.org/bots/api-changelog`,
`telegram.org/blog/communities-editor-invisible-messages`, consultate
2026-09-04. La sezione BotCommandScope della API reference non si è lasciata
recuperare per intero tramite fetch automatico (la pagina eccede la
lunghezza gestita dallo strumento usato); la lettura sotto è quindi
corroborata da tre fonti indipendenti che citano la stessa definizione
ufficiale (le documentazioni di `aiogram` e `python-telegram-bot`, entrambe
wrapper che riproducono verbatim il testo dello spec upstream), non dallo
spec letto riga per riga come nel documento precedente. Segnato qui
esplicitamente come limite della ricerca, non nascosto.

### 2.1 `BotCommandScope*` — un menù, non un cancello

`BotCommandScopeChatAdministrators`, `BotCommandScopeChatMember` e le altre
cinque varianti (sette scope in tutto) controllano **quali comandi
`setMyCommands` elenca nel menù di Telegram per quella classe di utente in
quella chat** — non chi può eseguirli. Conferma testuale, dalla
documentazione derivata: *"used to control which commands are displayed to
different users in different chat contexts"*. Questo è esattamente la trappola
che il brief aveva già nominato prima di questa ricerca: un menù ristretto
agli admin è cosmetico, perché **Telegram consegna comunque l'update** se un
membro digita `/comando` a mano — l'unico cancello reale resta quello che
Muffin stesso applica dopo aver ricevuto l'update, cioè `tryCommand()` (§1.1)
o `decide()`. `BotCommandScope` risolve *scoperta*, non *autorità*: utile per
non mostrare a un membro un comando che comunque gli verrebbe rifiutato, mai
un sostituto del controllo lato Muffin.

### 2.2 Messaggi effimeri (Bot API 10.2/10.3, luglio-agosto 2026) — la vera risposta a "solo tu"

Il documento precedente (§ricerca su `answerCallbackQuery`, non ripetuta qui)
aveva guardato lo strumento sbagliato. Dal changelog ufficiale:

- **Bot API 10.2 (14 luglio 2026):** introduce i messaggi effimeri — un bot
  può inviare un messaggio in un gruppo **visibile solo a una persona
  specifica e al bot**, tramite `EphemeralMessageParameters` sui metodi
  `sendXxx` esistenti (non un metodo nuovo), più `editEphemeralMessageText/
  Media/Caption/ReplyMarkup` e `deleteEphemeralMessage` per il loro ciclo di
  vita. Un messaggio ha `is_ephemeral`, `receiver_user`,
  `ephemeral_message_id`.
- **Bot API 10.3 (24 agosto 2026):** i parametri `receiver_user_id`/
  `callback_query_id` si consolidano in un unico
  `ephemeral_message_parameters`; aggiunto `replace_callback_query_message`.
- Dal blog ufficiale: un comando può essere marcato come effimero, e allora
  **anche il messaggio della persona che lo ha scritto resta invisibile agli
  altri membri**, non solo la risposta del bot — "two-way privacy".

Questo è materialmente diverso da `answerCallbackQuery`/`show_alert`, che resta
legato a un tocco su un bottone inline e a un avviso modale, non a un
messaggio persistente nella chat. Se l'owner intendeva "Muffin mi risponde nel
gruppo ma solo io lo vedo" — la lettura più naturale della frase citata nel
brief — i messaggi effimeri sono il meccanismo giusto, appena disponibile
(agosto 2026), non ancora usato da nessun codice di questo repository (grep
negativo su `ephemeral` in `connectors/`). **Non implementato qui**: è una
capability di superficie (Telegram-specifica), non un cambio di autorità nel
kernel, e la sua adozione è indipendente dalla domanda dei tre livelli — la si
nomina perché risponde direttamente a una frase del brief che altrimenti
resterebbe senza reperto.

### 2.3 `chat_member` — la freschezza dell'"è admin", misurata sulla carta

`ChatMemberUpdated`/l'update `chat_member`: Telegram lo consegna quando lo
stato di un membro cambia — promozione o rimozione da amministratore
comprese — **solo se il bot lo ha esplicitamente richiesto in
`allowed_updates`** (non è nel set di default). Nessuna garanzia di latenza
pubblicata oltre "in coda fino a 24 ore se il bot è offline". Questo è un
canale *push*, opt-in, che costa zero chiamate per messaggio ma non offre una
garanzia forte su "quanto è fresco": se il bot processa gli update in ordine
e non ne perde nessuno, una promozione/rimozione arriva come evento a sé,
non allineato a nessun turno in corso.

`getChatMember(chat_id, user_id)` e `getChatAdministrators(chat_id)` restano
l'alternativa *pull*: una chiamata di rete per verifica, live al momento della
chiamata (nessuna cache lato Telegram documentata), il cui costo è quello
misurato in `docs/evidence/muffin-nei-gruppi-2026-09-04.md` §2.5 — non gratis,
va messo in cache con un TTL se interrogato spesso, e nessun codice lo fa
oggi.

**La domanda che l'owner ha posto — "cosa succede a un turno in corso quando
quella risposta cambia" — ha una risposta netta solo se il sistema decide UNA
VOLTA, mai a metà turno.** `tierOf(principal)` è già calcolato una sola volta,
in `identify()`, all'apertura del turno (`docs/evidence/muffin-nei-gruppi-
2026-09-04.md` §1.1) — non ricontrollato ogni tool call. Se mai un segnale
"è admin" entrasse nel kernel, la stessa disciplina si applicherebbe per
costruzione: letto una volta all'apertura (con `chat_member` a tenerlo caldo
fra un turno e l'altro, o una `getChatMember` fresca se il segnale manca),
mai richiamato dentro `decide()` — che deve restare "puro e sincrono,
spiegabile da uno snapshot" (`core/policy/decide.ts:21-30`, commento su
`PolicyContext`). Una promozione a metà turno vale dal turno *successivo*,
mai da quello in corso — la stessa semantica che oggi vale già per `tierOf`.

## 3. Perché "group host" non è oggi una categoria di rischio diversa da "group member"

Il punto che l'evidence precedente aveva già argomentato per l'owner-in-gruppo
(Combinazione C, §3 di quel documento) vale identico, non per analogia ma per
lo stesso meccanismo, per un admin-in-gruppo:

- **Le capability `hostOnly: true` restano ugualmente pericolose,
  indipendentemente da chi le chiede.** `fs_write`, `sys.shell`, `mcp.*`,
  `sys.inspect` toccano il disco, i processi, o i file di **installazioni
  diverse dal tenant che chiama** — un admin di gruppo che le ottenesse
  avrebbe lo stesso accesso di un member qualunque a cose che appartengono
  all'owner, non al suo gruppo. Lo status di amministratore è un ruolo
  *sociale/di moderazione* su quella chat (cancellare messaggi, gestire
  membri — §2.5 del documento precedente), non un fatto sulla fiducia che
  Muffin dovrebbe riporre in quella persona rispetto al disco dell'owner.
- **La minaccia che tiene l'owner-in-gruppo a `member` non discrimina per
  ruolo.** Chiunque altro nel canale vede il contesto in cui un admin parla e
  può costruire un messaggio che, letto subito dopo, sembra continuarne la
  richiesta — esattamente il ragionamento di Combinazione C, e il numero di
  persone che possono tentarlo in un gruppo con admin non è strutturalmente
  diverso da un gruppo senza. Promuovere l'autorità sulla base del ruolo
  Telegram spegnerebbe la stessa difesa, nello stesso posto, per la stessa
  ragione già scritta e non confutata da nuova evidenza.
- **Quello che *cambia* davvero da gruppo a gruppo non è "chi lo amministra",
  è "cosa è acceso per quel gruppo".** La citazione del dogfood nell'evidence
  precedente (§7, §5.4) — *«voglio un minimo di capability e utility,
  specialmente in base al gruppo»* — descrive un asse **per-tenant**
  (quali capability sono abilitate per *questo* gruppo), non un asse
  **per-persona** (chi dentro il gruppo può invocarle). I due si confondono
  facilmente perché "group host" suona come "sblocca di più per questo
  gruppo", ma la persona che sblocca per il gruppo (l'owner, in una
  configurazione) e la persona che quel giorno amministra quella chat
  Telegram sono informazioni indipendenti — un gruppo può cambiare admin
  senza che l'owner abbia mai deciso di fidarsi di più di quel gruppo.

## 4. Tavola di decisione

```
misura Muffin: nessun capability/comando ha oggi un buco fra "aperto a
  chiunque nel tenant" e "chiuso a chiunque non sia l'owner"; l'owner
  propone un terzo livello (group-host) per colmarlo in anticipo.
meccanismo attuale: hostOnly binario nel kernel (decide.ts:146); comandi
  slash 100% owner-gated (tryCommand); ask.audience letterale 'owner'.

candidato A — non fare nulla: il binario resta, "group host" non entra
  nel kernel né nei comandi.
  evidenza a favore: nessuna capability o comando oggi trarrebbe beneficio
    di sicurezza dal distinguere admin da member (§3); zero righe, zero
    superficie nuova da mantenere o da compromettere.
  evidenza contro: non risponde alla richiesta testuale dell'owner; se un
    giorno un membro dovesse ottenere qualcosa di più di "solo lettura del
    proprio tenant" (per esempio il vault-scrittura di
    muffin-nei-gruppi §5.2, quando verrà disegnato), l'assenza di un asse
    "chi in questo gruppo può approvarlo" si sentirebbe allora, non ora.

candidato B — audience a tre livelli nel kernel (host/group-host/
  group-member), su CapabilityDecl e su Principal, un solo punto di
  decisione in decide.ts.
  evidenza a favore: è la lettera della richiesta; il tipo esiste già come
    scheletro (Principal ha già 'owner'|'member'|'system'|'agent', un
    valore in più è un cambio piccolo).
  evidenza contro: richiede che qualcosa sappia "è admin" per costruire il
    Principal — oggi zero righe lo fanno (grep confermato nel brief); il
    segnale ha un costo (chiamata di rete o un evento push opt-in, §2.3)
    e una freschezza che il kernel dichiaratamente non vuole gestire da
    solo; e — il punto che decide il candidato — **nessuna capability
    hostOnly:true diventerebbe più sicura da aprire a un admin** (§3): il
    livello risolverebbe un problema che l'evidenza non mostra esistere.
  falsificazione: una capability hostOnly:true per cui "è admin di questo
    gruppo" è evidenza di fiducia sufficiente sarebbe il reperto che manca.

candidato C — un asse per-tenant, non per-persona: quali capability sono
  abilitate per QUESTO gruppo (config dell'owner, non stato Telegram).
  evidenza a favore: risponde alla citazione del dogfood (§3 sopra) meglio
    del candidato B, perché la decisione resta dell'owner (chi configura
    il gruppo) invece che di un fatto Telegram che cambia da solo; non
    dipende da nessuna chiamata a getChatMember; compone con l'asse
    tenant già esistente (perTenantDailyUsd, documents.read scoped al
    tenant).
  evidenza contro: è un meccanismo diverso e nuovo (un secondo campo su
    CapabilityDecl o una tabella tenant→capability), fuori scopo per questo
    documento — richiede la sua ricerca (stessa nota già lasciata da
    muffin-nei-gruppi §5.2 per il vault scrivibile).

candidato D — "ask risolto da un admin": non un'audience nuova, un
  resolver nuovo per un ask che un member già raggiungerebbe.
  evidenza a favore: architettura a buon mercato — un valore in più sul
    letterale `ask.audience`, verificato una sola volta al momento
    dell'approvazione (non per ogni messaggio, quindi la freschezza conta
    meno che per B); mappa esattamente la frase del brief.
  evidenza contro, misurata eseguendo (§1.3): la categoria a cui si
    applicherebbe — "capability hostOnly:false, risk non-basso, member
    raggiunge ask" — è oggi VUOTA. Non c'è niente da redirigere a un admin
    perché niente lo chiede oggi all'owner nemmeno per un member.
  falsificazione: la prima capability dichiarata hostOnly:false con un
    ask member-raggiungibile riapre la domanda con un caso vero, non
    ipotetico.
```

## 5. Verdetto

**Nessun terzo livello di autorità entra nel kernel oggi.** Non per pigrizia
di ricerca: perché l'evidenza eseguita (§1.3, §3) mostra che il rischio che
un livello "group-host" dovrebbe mitigare non esiste ancora nella superficie
dichiarata — ogni capability aperta a un member è già a rischio basso e
sempre `allow`; ogni capability che chiuderebbe con `ask` invece che `deny`
è già chiusa del tutto a un member da `hostOnly`. Aggiungere un'audience
intermedia oggi sposterebbe complessità (una nuova fonte di verità — "chi è
admin", con un costo e una freschezza propri) senza spostare nessuna
capability reale dalla colonna "sempre chiuso" o "sempre aperto" a "aperto
solo agli admin" — perché quella colonna di mezzo non ha ancora un abitante.

**I comandi slash non hanno bisogno di un terzo livello per la stessa
ragione, e in più partono da una postura più stretta di quella temuta**: sono
già tutti owner-only, `/update` compreso per il fatto di non esistere ancora
su questa superficie (§1.1) — nessuna riga da cambiare per soddisfare quella
riga specifica del brief.

**"Ask risolto da un admin" (candidato D) è l'idea con il costo più basso da
tenere pronta, non da costruire ora**: si applica a un insieme vuoto (§1.3),
quindi implementarla oggi significherebbe aggiungere un ramo che nessun test
onesto potrebbe esercitare senza inventare anche la capability che lo
attraverserebbe — esattamente il tipo di "meccanismo con test verde e nessuna
strada in produzione" che questa repository ha già misurato più volte come
il proprio difetto ricorrente.

**Ciò che è realmente scoperto, e vale la pena nominare come lavoro
successivo** (non qui): l'asse per-tenant del candidato C — quali capability
sono accese per quale gruppo — è la lettura più fedele della frase del
dogfood *«specialmente in base al gruppo»*, indipendente da chi amministra
quella chat, e resta un buco reale ogni volta che l'owner vorrà dare a UN
gruppo (il suo, non uno qualunque) qualcosa di più delle tre capability oggi
`hostOnly: false`. Stessa nota di scope già lasciata per il vault scrivibile
in `docs/evidence/muffin-nei-gruppi-2026-09-04.md` §5.2: la propria ricerca,
prima della propria implementazione.

## 6. Cosa farebbe cambiare questo verdetto

- Una capability dichiarata `hostOnly: true` per cui uno status di
  amministratore Telegram sarebbe evidenza di fiducia sufficiente — non
  ipotizzata qui, non esiste oggi.
- Una capability `hostOnly: false` con `risk` non-basso il cui `ask` un
  member raggiungerebbe — sposterebbe il candidato D da vacuo a concreto.
- Un caso reale in cui l'owner ha voluto dare a un gruppo specifico una
  capability oggi chiusa a tutti i gruppi, e l'unico modo ragionevole di
  farlo passava per "chi lo amministra" invece che per "quale gruppo è" —
  riaprirebbe B contro C con un fatto invece che con un'intuizione.
- Un incidente misurato in cui l'assenza di `BotCommandScope` (o la sua
  presenza scambiata per un cancello) ha causato un comando eseguito da chi
  non doveva poterlo fare — non misurato qui, e la lettura della fonte
  (§2.1) dice che non può succedere per quella via specifica.
