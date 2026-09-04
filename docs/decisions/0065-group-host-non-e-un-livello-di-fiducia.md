# ADR-0065 — "Group host" non è un livello di fiducia nel kernel, oggi

**Stato:** accettato · 2026-09-04 · esegue la raccomandazione di
`docs/evidence/autorita-a-tre-livelli-2026-09-04.md`

> Nessun codice implementa questa ADR perché la decisione è di **non**
> aggiungere un meccanismo: non c'è un "accendere" da verificare in
> produzione. Diventa rilevante di nuovo solo se una delle condizioni di
> falsificazione in fondo si verifica — a quel punto è un caso concreto da
> portare, non una rilettura di questo documento.

## Contesto

L'owner ha proposto un'autorità a tre livelli — host (lui), group host (chi
amministra un gruppo Telegram), group member — per comandi slash e per tool,
con l'idea aggiuntiva che un tool oggi `ask` potrebbe aprirsi ai membri se
l'approvazione arriva da un admin. Per la regola di questa repository, una
proposta dell'owner è un'ipotesi da falsificare come qualunque altra: questa
ADR registra il risultato di quel tentativo, eseguito, non solo argomentato.

Oggi (`core/policy/decide.ts:146`, `core/policy/types.ts:203`) l'autorità è
binaria: `hostOnly: boolean` su ogni `CapabilityDecl`, negato a
`principal.kind === 'member'`. I comandi slash (`connectors/telegram/
connector.ts`, `tryCommand()`) sono già più stretti: un letterale `if
(principal.kind !== 'owner') return false` che non lascia spazio a nessun
livello intermedio, per nessun comando. `ask.audience` (`core/policy/
types.ts`) è un letterale `'owner'`, mai un parametro.

## Decisione

1. **Nessuna audience a tre valori entra nel kernel.** `hostOnly` resta
   booleano. La ragione non è di principio ma di evidenza: eseguendo
   `createDecide` con ogni `CapabilityDecl` reale registrata da `agent/
   runtime.ts`, per un member a ogni taint valido, **ogni** capability
   raggiungibile da un member (`hostOnly: false`) è `risk: 'low'` → sempre
   `allow`; **ogni** capability che produrrebbe `ask` è `hostOnly: true` →
   negata a un member prima di arrivarci
   (`docs/evidence/autorita-a-tre-livelli-2026-09-04.md` §1.3). Un livello
   "group-host" sbloccherebbe capability oggi `hostOnly: true` — ma quelle
   restano ugualmente pericolose indipendentemente da chi le chiede: toccano
   disco/processi/MCP dell'installazione, non solo il tenant del gruppo, e
   lo status di amministratore Telegram è un ruolo di moderazione su quella
   chat, non un fatto sulla fiducia che Muffin dovrebbe riporre in quella
   persona verso i file dell'owner. La stessa minaccia che tiene
   l'owner-in-gruppo a `member` (chiunque altro nel canale vede il contesto
   e può manipolarlo — Combinazione C, `docs/evidence/muffin-nei-gruppi-
   2026-09-04.md` §3) vale identica per un admin-in-gruppo.
2. **I comandi slash restano owner-only, senza eccezioni, e senza bisogno di
   un cambio per soddisfare la richiesta specifica su `/update`.** `/update`
   non è oggi un comando raggiungibile da Telegram (assente da `agent/
   comandi.ts`); se lo diventasse, erediterebbe lo stesso gate incondizionato
   di ogni altro comando in quel file. Non c'è una riga da marcare
   `hostOnly` perché il gate non distingue comando per comando: è un unico
   controllo prima dello switch.
3. **"Ask risolto da un admin" non si implementa ora**, non perché sia
   sbagliato in astratto ma perché si applicherebbe oggi a un insieme vuoto:
   nessuna capability dichiarata è insieme `hostOnly: false`, rischio
   non-basso, e produce `ask` per un member (misurato eseguendo il kernel,
   stessa evidenza del punto 1). Un ramo di codice che nessuna capability
   reale attraverserebbe è esattamente il tipo di meccanismo-senza-strada-in-
   produzione che questa repository ha già pagato più volte. Resta un
   candidato a basso costo per quando una capability del genere esisterà
   davvero — vedi §falsificazione.
4. **L'asse che *è* reale e resta fuori scopo qui è per-tenant, non
   per-persona**: quali capability sono abilitate per un gruppo specifico
   (decisione dell'owner in configurazione), non chi dentro quel gruppo le
   invoca. Risponde meglio alla richiesta del dogfood («specialmente in base
   al gruppo», `docs/evidence/muffin-nei-gruppi-2026-09-04.md` §5.4/§7) di
   quanto farebbe un'audience per-persona, perché resta una scelta
   dell'owner e non dipende da un fatto Telegram (chi amministra oggi quella
   chat) che può cambiare senza che l'owner abbia deciso nulla. Richiede una
   propria ricerca prima di una propria implementazione — non è questa ADR.

## Le tre domande che questa ricerca doveva rispondere, anche restando "no"

**Come si stabilisce che qualcuno è admin, e quanto ci si fida della
risposta?** Due strade reali su Telegram, nessuna implementata: `getChatMember`/
`getChatAdministrators` (pull, live al momento della chiamata, un costo di
rete per verifica, nessuna cache lato Telegram) o l'update `chat_member`
(push, opt-in via `allowed_updates`, nessuna garanzia di latenza pubblicata
oltre "in coda fino a 24h se il bot è offline"). Se mai un segnale del genere
entrasse nel Principal, la disciplina sarebbe la stessa già in uso per
`tierOf`: calcolato una volta in `identify()`, mai richiamato dentro
`decide()`, che deve restare puro e sincrono da uno snapshot
(`core/policy/decide.ts`, commento su `PolicyContext`).

**Cosa succede a un turno in corso quando quella risposta cambia?** Nulla,
per costruzione, con la disciplina sopra: un fatto calcolato all'apertura del
turno vale per tutto il turno, esattamente come oggi `tierOf(principal)` non
si ricalcola a metà. Una promozione o rimozione varrebbe dal turno
successivo. Questa non è una scelta specifica di questa ADR: è l'unica
scelta coerente con un kernel che rifiuta di dipendere da I/O dentro
`decide()`.

**"Ask risolto da un admin" è una cosa che vogliamo?** Argomentata in
entrambi i sensi. A favore: chi risponde a un'`ask` non deve necessariamente
essere chi la merita di più — un admin presente e attento in quel momento
può essere un'approvazione più pronta di un owner altrove, e il costo
architetturale è basso (un valore in più su un letterale, verificato una
volta sola al click, non per ogni messaggio). Contro: introduce una seconda
fonte di autorità delegata di cui il kernel non ha oggi bisogno, per una
categoria di capability che non esiste; e "un admin ha approvato" non è la
stessa garanzia di "l'owner ha approvato" — un gruppo con più admin
distribuisce quella fiducia a persone che l'owner potrebbe non aver scelto
individualmente (in molti gruppi, l'admin è chi lo ha creato o chi altri
admin hanno promosso, non necessariamente chi l'owner di Muffin
approverebbe). La conclusione, misurata: la domanda è prematura, non chiusa
per principio. Vedi falsificazione.

## Cosa questa decisione NON afferma

- Non dice che un'audience a tre livelli sarebbe sbagliata in ogni futuro —
  dice che nessuna capability o comando dichiarato oggi ne trarrebbe un
  beneficio di sicurezza misurabile, e nomina esattamente il reperto che
  cambierebbe la risposta.
- Non tocca `hostOnly` come meccanismo, né la sua applicazione ai comandi
  slash (che restano fuori dal kernel delle capability, gestiti dal gate
  separato in `tryCommand()` — due meccanismi per due superfici diverse,
  non una duplicazione della stessa regola: i comandi non passano da
  `decide()` oggi, e unificarli è una domanda distinta da questa).
- Non implementa i messaggi effimeri di Telegram (Bot API 10.2/10.3,
  `docs/evidence/autorita-a-tre-livelli-2026-09-04.md` §2.2), che rispondono
  a una frase diversa del brief («ricevere il messaggio solo tu») e restano
  una capability di superficie indipendente da questa decisione.
- Non riapre `docs/decisions/0061-un-solo-confine-non-basta.md` né la
  Combinazione C di `docs/evidence/muffin-nei-gruppi-2026-09-04.md` §3: le
  conferma, applicandole a un ruolo (admin) invece che a una persona
  (l'owner), con lo stesso esito.

## Alternative considerate

Le quattro tavolate in `docs/evidence/autorita-a-tre-livelli-2026-09-04.md`
§4: (A) non fare nulla — troppo silenzioso sulla richiesta testuale
dell'owner, ma è di fatto la posizione più vicina a quella scelta; (B)
audience a tre livelli nel kernel — respinta, evidenza al punto 1 sopra; (C)
capability per-tenant — la più promettente, fuori scopo qui, non respinta;
(D) ask risolto da un admin — non respinta, rimandata per assenza di un
bersaglio reale.

## Conseguenze

Zero righe di kernel cambiate da questa ADR. Il costo è tutto nel non aver
ancora una risposta a "voglio dare a QUESTO gruppo qualcosa in più" — che
esisteva anche prima di questa ricerca (nominato come domanda aperta in
`docs/evidence/muffin-nei-gruppi-2026-09-04.md` §9) e resta aperto,
esplicitamente, come lavoro del candidato C.

## Reversibilità

Totale: non c'è niente da disfare. Riaprire questa domanda richiede uno dei
reperti in §falsificazione, non una rilettura di questo documento.

## Falsificazione

- Una capability dichiarata `hostOnly: true` per cui lo status di
  amministratore Telegram sarebbe evidenza di fiducia sufficiente verso il
  disco/i processi/MCP dell'installazione.
- Una capability dichiarata `hostOnly: false`, rischio non-basso, il cui
  `ask` un member raggiungerebbe davvero — sposta il candidato D da vacuo a
  concreto.
- Un caso reale in cui l'owner ha voluto dare a un gruppo specifico una
  capability oggi chiusa a ogni gruppo, e il modo più naturale di farlo
  passava per "chi lo amministra" invece che per "quale gruppo è".

## Come si prova che questa ADR dice il vero

`docs/evidence/autorita-a-tre-livelli-2026-09-04.md` §1.3 include l'esecuzione
reale di `createDecide` con `POLICY_FLOOR` e ogni `CapabilityDecl` registrata
da `agent/runtime.ts`, per un principal `member` a taint 2 e 3, su ogni
capability dichiarata — la tabella mostra `allow` o `deny`, mai `ask`, per
ogni riga. Chiunque dichiari una nuova capability `hostOnly: false` a rischio
non-basso può rieseguire lo stesso probe e osservare se questa ADR è ancora
vera per l'installazione che ha davanti.
