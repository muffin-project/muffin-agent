# ADR-0021 — Surface: tutte connesse, una di default, ogni job sceglie la sua

**Contesto.** Il design precedente (V6) designava "un connector principale" e trattava Telegram come *il* canale remoto. L'owner corregge: la CLI è la superficie principale, ma **Telegram non è privilegiato**; le surface si attivano a scelta, restano **tutte connesse insieme**, una è il **default** per ciò che Muffin dice di sua iniziativa, e **ogni job schedulato può consegnare sul default o su una surface specifica**. È una correzione strutturale, non cosmetica: un'astrazione che privilegia un canale produce codice che assume quel canale ovunque (la lezione è già in casa: il Muffin attuale ha dovuto rifattorizzare un god-file Telegram in transport tipato).

**Decisione.** Il gateway tiene un **registro di surface**, ciascuna con: `id`, stato (`enabled`/`disabled`), credenziali (riferimento a secret), **render capabilities** dichiarate (ADR-0016), e politiche proprie (quiet hours, rate limit). Regole:

1. **Tutte le surface abilitate sono connesse contemporaneamente.** Nessuna è "il" canale: la CLI è sempre presente (L0-1) ma è una surface come le altre nel routing.
2. **Inbound**: qualunque surface abilitata può iniziare una conversazione; la risposta torna **sulla surface e sul thread d'origine**. La memoria è condivisa (stesso tenant `host`, `thread_key` diverso): la stessa conversazione continua cambiando canale, senza che il canale sia parte dell'identità.
3. **Outbound-initiated** (proattività, cron, notifiche, esiti di job lunghi): va sulla **surface di default**, configurabile e cambiabile parlando con Muffin ("da domani il brief mandamelo su Discord"). Il default **non è la CLI** salvo scelta esplicita — un terminale chiuso non è un posto dove consegnare qualcosa (la CLI resta il default solo in installazioni headless/server dove è l'unica).
4. **Ogni job schedulato dichiara il proprio target**: `default` (eredita, e segue il default se cambia) oppure una surface e un thread specifici (`telegram:<thread>`, `discord:<canale>`). È una proprietà del job, decisa quando lo si crea in linguaggio naturale ("ogni lunedì mandami il riepilogo nel gruppo progetto").
5. **La resa si adatta al target, il contenuto no**: il renderer sceglie la forma più ricca supportata dalla surface di destinazione (ADR-0016); il contenuto è identico su ogni canale. Un job che consegna su due surface produce due rese, mai due contenuti.
6. **Fallback dichiarato**: se la surface di destinazione è irraggiungibile (token scaduto, rete giù), il messaggio **non si perde**: resta in coda con TTL e viene consegnato al ripristino o dirottato sul default dopo la scadenza, con nota esplicita del dirottamento. Un annuncio proattivo che sparisce in silenzio è peggio di uno in ritardo.
7. **I tenant non scelgono**: la surface di default e i target dei job sono capability dell'owner (`config.surface`). Un gruppo non può redirigere le consegne — sarebbe un canale di esfiltrazione a costo zero.

**Alternative scartate.** *Un connector principale designato* (il design precedente): produce un'astrazione che si piega intorno a un canale; e sbaglia il caso reale — l'owner vive su più canali contemporaneamente, non su uno. *Una surface attiva per volta, commutabile*: semplifica il routing ma rompe il caso base (scrivo da telefono, continuo da terminale). *Consegna in broadcast su tutte le surface*: rumore moltiplicato per il numero di canali, ed è il modo più rapido per rendere insopportabile la proattività.

**Conseguenze.** Più facile: aggiungere una surface è dichiarare capability e credenziali; la proattività diventa configurabile senza toccare codice; i job hanno un destinatario esplicito invece che implicito. Più difficile: il gateway deve gestire connessioni multiple simultanee con fallimenti indipendenti (una surface giù non deve degradare le altre), e serve una coda di consegna con TTL — pezzi reali, non gratuiti. Il modello di sessione diventa `(tenant, surface, thread)` ovunque, senza scorciatoie.

**Reversibilità.** Alta verso l'aggiunta (una surface in più è una dichiarazione), media verso il ritiro del concetto di default (toccherebbe scheduler e proattività). Segnale che era sbagliata: se dopo mesi il default non viene mai cambiato e nessun job usa un target specifico, il registro è cerimonia — si collassa su "rispondi dove ti hanno scritto, annuncia dove dico io" e si eliminano i target per-job.

---

## §revisione 2026-08-17 — lo streaming è una capability della surface (M5-BIS B11)

Direttiva owner (16/08 sera, sulla slice `slice/streaming`): niente slop, e Hermes/vecchio Muffin come riferimento senza copiarli. Hermes lo dice come conclusione della propria ricerca (`research/hermes-documentazione.md` §3.8): streaming è deciso da due strati separati — la CLI ha un proprio `display.streaming` con fallback automatico, il gateway ha il proprio `streaming.enabled` + `transport: auto|edit|off` — mai un flag globale unico. Lo stesso pattern che ADR-0016 §revisione ha già stabilito per le render capability (dichiarate per surface, non un interruttore di sistema) si applica qui, con un contratto più piccolo:

`Surface` guadagna un campo **richiesto**, `streaming: { transport: 'stdout' | 'edit' | 'off' }` (`core/surface/types.ts`), sullo stesso piano di `limits` — dichiarato, non scoperto al primo tentativo fallito. `'stdout'` per la CLI quando `process.stdout.isTTY` (o `--no-stream` la spegne comunque, per-turno, senza contraddire la capability dichiarata: una capability dice cosa la surface *può* fare, il turno decide se usarla — la stessa distinzione di un browser che supporta una feature e di una pagina che la accende). `'edit'` per Telegram, su entrambi i transport tra cui il connettore sceglie (bozza o `editMessageText` — `connectors/telegram/presence.ts`, dettaglio implementativo che questo campo non deve conoscere). `'off'` per Discord (B17, esplicitamente fuori scope) e per qualunque surface che non dichiara altro.

**A differenza delle render capability, non serve un secondo consumatore.** ADR-0016 §revisione punto 1 impone che una render capability raggiunga *anche* il prompt, in coda, perché il modello deve sapere quale mezzo può usare **prima di generare** — una tabella nativa non è la stessa scelta di una prosa. Lo streaming è un asse diverso: non cambia *cosa* il modello produce, cambia solo *come* il testo già deciso raggiunge l'owner. Il modello non deve mai sapere se sta streammando — lo decide `agent/loop.ts` dopo che il testo esiste, guardando `TurnInput.onDelta`. Quindi questo campo alimenta **un solo consumatore**: il codice che invoca il turno sulla superficie (`cli/repl.ts`, `connectors/telegram/connector.ts`), mai il prompt.

**Il fallback è dichiarato, non implicito, su due piani indipendenti** — lo stesso principio del §6 sopra ("fallback dichiarato" per la consegna), applicato al livello del singolo turno:
- **Provider**: uno stream che si rompe a metà (`ProviderStreamError`) ricade su **una sola** chiamata non-streaming per quel tentativo — mai due chiamate a pagamento in silenzio (`agent/providers/types.ts`, `agent/loop.ts#requestChatResult`).
- **Surface**: al primo edit fallito la superficie si spegne per quella sessione, come Hermes — questo è il comportamento che l'implementazione Telegram di questa stessa slice porta (vedi `STATE.md` per lo stato preciso: alla data di questo emendamento il lato REPL/CLI è chiuso e testato, il lato Telegram è il passo successivo della stessa slice, non ancora atterrato).

**Cosa NON cambia.** Il modello di registro (§Decisione sopra) resta invariato: nessuna surface è privilegiata, `streaming` è dichiarata come `limits` lo è già, e una surface che non implementa nulla di progressivo dichiara onestamente `'off'` invece di lasciare il campo assente — lo stesso principio che tiene `deliverFile` obbligatorio (non opzionale) da quando è stato aggiunto.

**Reversibilità** invariata per il modello di registro. Specifica per questo campo: alta — è un valore dichiarato per surface, aggiungerne un quarto transport o toglierne uno è una modifica locale a un tipo, non un'architettura da disfare.

---

## §revisione 2026-09-03 — il canale è un indirizzo di consegna, non l'identità della conversazione

Questa ADR si contraddiceva, e il codice ha seguito la metà sbagliata. Le due
frasi, verbatim:

- §Decisione punto 2 (**inbound**): *«la stessa conversazione continua cambiando
  canale, senza che il canale sia parte dell'identità»*;
- §Conseguenze: *«Il modello di sessione diventa `(tenant, surface, thread)`
  ovunque, senza scorciatoie»*.

Non possono valere entrambe: se la superficie è una componente della tupla di
sessione, allora il canale **è** parte dell'identità, e la conversazione non
continua cambiando canale. Due connector hanno implementato la seconda —
`telegram:<chatId>` e `discord:<channelId>` scritti a mano come id di sessione —
e l'owner ha misurato il risultato il 2026-09-03: *«non sembra di star parlando
allo stesso muffin»* (`docs/evidence/continuita-e-provenienza-2026-09-03.md` §1).

**Si risolve in favore della regola inbound.** Il canale è un **indirizzo di
consegna**, mai identità di conversazione. ADR-0056 rende la distinzione
eseguibile invece che scritta: `sessionKey` esce da `identify` ed è `owner` per
il principal owner, qualunque porta usi; `replyTo.channel` e `replyChannel`
restano `telegram:<chatId>` pienamente qualificati, ed è la loro separazione da
quella chiave che impedisce a una risposta di uscire dalla porta sbagliata.

**La riga corretta**, che sostituisce quella di §Conseguenze:

> Il modello di sessione è `(tenant, conversazione)`, dove la conversazione la
> decide `identify` e non il connector: `owner` per il principal owner — una
> sola, attraverso tutte le porte — e `<connector>:<conversationId>` per un
> `member`, cioè una per stanza. La superficie resta nell'indirizzo di consegna
> e nella resa (§5 sopra), mai nell'identità.

Nulla del registro cambia: le surface restano tutte connesse, nessuna
privilegiata, i target dei job restano `default` o una surface esplicita (§3-§4).

**Le «alternative scartate» qui sopra lo avevano previsto** — *«un'astrazione che
privilegia un canale produce codice che assume quel canale ovunque»* — e la
previsione si è avverata dentro questa stessa ADR. Misurato su `dev` il
2026-09-03: `connectors/telegram/` sono 9453 righe contro le 2739 di
`connectors/discord/` (3796 contro 1567 escludendo i test), e tutta la
macchineria dell'input mentre un turno è vivo — coda, ack, `/steer`, `/stop`,
`/pause` di ADR-0054 — esiste **solo** su Telegram (`connectors/telegram/connector.ts`,
`connectors/telegram/busy.test.ts`; in `connectors/discord/` non c'è né il tipo
`Controlli` né un turno vivo da fermare). La lezione non è che l'astrazione fosse
sbagliata: è che una frase ambigua in §Conseguenze è bastata a far crescere il
canale privilegiato che §Contesto voleva impedire.

---

## §revisione 2026-09-06 — la negoziazione è per stanza, non per porta

La §revisione 2026-08-17 qui sopra resta vera in tutto ciò che dice, e sbagliava
un dettaglio che nel frattempo è costato: `streaming: {transport}` è **un valore
per porta**. Telegram dichiarava `'edit'` e basta, e chi doveva sapere se *qui
dentro* si potesse mostrare un'anteprima lo deduceva da un booleano `isPrivate`
passato a mano a un renderer (`connectors/telegram/transcript.ts`), insieme a
due pavimenti di edit scritti come costanti accanto. Tre decisioni su *cosa la
piattaforma permette in una stanza*, prese dentro il codice che disegna il
messaggio.

Non è un dettaglio estetico: la Bot API dà risposte diverse per stanza.
`sendMessageDraft` è documentata per «the target **private** chat»; i limiti di
scrittura verso un gruppo non sono quelli di una DM; un topic eredita i limiti
della chat ma non il posto in cui si scrive. Una sola risposta per porta o mente
sui gruppi o rinuncia in privato — e ha rinunciato in privato: la PR #388 ha
tolto l'anteprima perché scadeva dopo trenta secondi, cioè per un rinnovo
mancante, non perché l'anteprima fosse sbagliata.

Direttiva owner del 06/09/2026: il gateway chiede alla porta *«posso mostrare
una bozza? se no posso riscrivere? ogni quanto? posso mandare file? se no come
lo condivido?»*, e la risposta viene da una tabella `(porta, stanza)`.

`Surface` guadagna quindi due membri **richiesti** (`core/surface/types.ts`),
sullo stesso piano di `limits` e per la stessa ragione:

- `places: readonly Place[]` — le stanze che questa porta serve davvero
  (`'direct' | 'group' | 'topic' | 'terminal'`);
- `negotiate(place): Negotiation` — la catena di preferenza per lo stream
  (`'draft' | 'edit' | 'stdout' | 'off'`) e per i file
  (`'native' | 'link' | 'inline' | 'say'`), più il ritmo: `editEveryMs`,
  `maxEditsPerMinute`, `draftTtlMs`.

Tre proprietà, e sono nel codice e non in questa prosa:

1. **Una dichiarazione impossibile non arriva a esistere.** `assertNegotiable`
   è chiamata da `makeIngressPort`, quindi una porta che dichiara `'draft'` in
   una stanza condivisa, o `'native'` senza saper muovere byte, o un tetto di
   edit oltre quello che il suo stesso pavimento lascia passare, fallisce alla
   **registrazione** — non davanti all'owner a metà turno. Nessuna riga di
   quella funzione nomina una piattaforma: la ragione per cui un'anteprima non
   esiste in un gruppo (non c'è *una* riga di composizione da riscrivere) vale
   anche per la porta che non è ancora stata scritta.
2. **Ogni catena ha un fondo.** `stream` finisce con `'off'`, `files` finisce
   con `'say'`. Una catena senza fondo promette che qualcosa funzionerà sempre;
   con il fondo, un file oltre `maxUploadBytes` smette di essere un
   `{delivered:false}` muto e diventa una frase che dice dove sta.
3. **Il campo vecchio non può discordare dalla tabella nuova.**
   `streaming.transport` resta (lo leggono il REPL e `makeIngressPort`), e
   `assertNegotiable` rifiuta una porta il cui `transport` dica il contrario di
   quello che dicono le sue stanze — la stessa scelta che `makeIngressPort`
   aveva già fatto per `ingress.edit`.

**Il consumatore resta uno**, come diceva la §revisione 2026-08-17: il codice
che invoca il turno sulla superficie. Su Telegram sono `apriIlVivo` e
`resumeStream` (`connectors/telegram/connector.ts`), che calcolano la stanza da
ciò che l'ingresso già sa — `direct`, il topic — e passano la `Negotiation` alla
trascrizione. Nessuna logica di Telegram vive fuori dal connettore, e la
trascrizione non deduce più niente da sola. La catena dei file la consuma
`deliverFile` di ciascuna superficie, perché solo la superficie sa quanto pesano
i suoi byte.

**Cosa NON cambia.** Il modello di registro (§Decisione) è invariato: nessuna
surface privilegiata, tutte connesse, i target dei job invariati. Un topic
continua a **non** essere un inquilino (vedi la §revisione sulla `sessionKey`):
è una stanza, quindi entra qui e in `sessionKey`, mai in `tenant`.

**Reversibilità.** Alta: `negotiate` è una funzione dichiarativa per superficie.
Segnale che era sbagliata: se dopo mesi ogni porta risponde la stessa cosa in
ogni stanza, la tabella è cerimonia e si torna a un valore per porta.
