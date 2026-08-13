# ADR-0037 — Il ragionamento torna indietro, e il budget non esiste più

**Stato:** accettato · 2026-08-13 · tocca `agent/providers/`, `agent/loop.ts`, `agent/profiles/`

---

## Contesto

Tre difetti nello stesso punto — il confine tra il loop e il provider Anthropic —
scoperti insieme perché sono la stessa cosa vista da tre lati: **la forma della
richiesta e della risposta non corrispondeva più a quella dell'API dei modelli
che l'installazione di default configura**.

`cli/init.ts:120` scrive `main: 'claude-sonnet-5'` (o `anthropic/claude-sonnet-5`
su un gateway OpenAI-compatibile). `agent/profiles/frontier.json` intercetta
`*claude-sonnet-5*`, `*claude-opus-5*`, `*claude-fable-5*`. Quindi tutto quello
che segue non è un caso limite: è il percorso che prende chiunque installi
Muffin senza passare un flag.

### 1. I blocchi di ragionamento cadevano al confine dell'adapter

Sui modelli 5-series **il thinking è attivo per default, senza configurazione**:
una richiesta che non nomina il campo `thinking` ragiona comunque
(`build-with-claude/thinking`, "Turning thinking on"; letto 2026-08-13). E la
regola sul tool use non è un consiglio:

> **Required:** within a tool-use turn, pass thinking blocks back.
> Pass every `thinking` block back to the API complete and unmodified, alongside
> the `tool_use` block it accompanied.

Noi non lo facevamo, in tre punti che si tenevano a vicenda:

- `agent/providers/anthropic.ts` filtrava la risposta a `TextBlock` e
  `ToolUseBlock`. I blocchi `thinking` — e la `signature` che è l'unica cosa che
  li rende leggibili al server — sparivano lì.
- `agent/providers/types.ts` non aveva un campo su `ChatResult` capace di
  portarli.
- `agent/loop.ts` **ricostruiva** il turno dell'assistente da `result.text` +
  `result.toolCalls`. Ricostruire è esattamente ciò che la documentazione indica
  come errore ("Echo the assistant message exactly as received: rebuilding the
  message or filtering out `redacted_thinking` blocks triggers a 400 error").

**Perché nessuno se n'era accorto**: perché non fa rumore. Ometterli non è un
400. La documentazione dice che il server *"may strip thinking blocks that would
create an invalid turn structure, or disable thinking when the conversation
history is incompatible with thinking being enabled"*. Il 400 è riservato ai
blocchi **modificati**. Quindi il sintomo era un agente un po' peggiore dalla
seconda iterazione di ogni turno con tool, più la cache persa che la
documentazione attribuisce esplicitamente ai blocchi conservati: *"preserved
thinking blocks enable cache hits during tool use… resulting in token savings in
multistep workflows"*.

Esistono anche i blocchi `redacted_thinking`, con la stessa regola e un payload
diverso — ed è il caso che un filtro per tipo perde per primo. La
documentazione lo nomina a mano: filtrare su `block.type == "thinking"` *"silently
drops `redacted_thinking` blocks and breaks the multi-turn protocol"*. Il nostro
filtro non arrivava nemmeno lì.

### 2. Il cablaggio dichiarato avrebbe dato 400 se qualcuno l'avesse costruito

`anthropic.ts:50-52` emetteva `thinking: {type:'enabled', budget_tokens}` e
`types.ts:44` lo tipizzava `{budgetTokens: number}`. Quella forma è **deprecata
sui modelli 4.6 e restituisce 400 su 4.7 e successivi — Opus 5, Sonnet 5, Fable
5**, cioè esattamente i tre glob di `frontier.json`
(`build-with-claude/extended-thinking`, riquadro di avviso; letto 2026-08-13).

Il rimedio scritto in roadmap §M5-bis punto 2 ("il loop non lo passa") era
quindi **sbagliato nella direzione**: passarlo avrebbe rotto ogni turno frontier.
Il difetto non era un meccanismo spento, era un meccanismo *armato*.

La migrazione documentata è `thinking: {type:'adaptive'}` più
`output_config: {effort}`. Su `effort` la documentazione è esplicita: *"`effort:
"high"` matches the API default; it appears here only to show where the depth
control now lives, and omitting it produces identical behaviour."*

### 3. `temperature: 0` è un 400 sull'installazione di default

`agent/loop.ts:349-350` fissava `maxOutputTokens: 4096` e `temperature: 0`. Su
Opus 4.7 e successivi i parametri di sampling sono stati **rimossi**: *"Setting
`temperature`, `top_p`, or `top_k` to any non-default value on Claude Opus 4.7
or later models, including Claude Opus 5, returns a 400 error"* (guida di
migrazione, letta 2026-08-13). `temperature: 0` non è il default (il default è
`1.0`).

Conseguenza: `muffin init` senza flag scrive provider `anthropic` + modello
`claude-sonnet-5`, e **ogni singolo turno di quella configurazione fallisce con
un 400**. È un difetto peggiore dei primi due — non silenzioso, ma sulla stessa
riga di codice e sulla stessa causa. Non era nel mandato di questa slice; è
stato trovato verificandolo.

### 4. E il vocabolario del profilo era sbagliato per i modelli che intercetta

`thinking: 'allowed' | 'off'` (`profile.ts:47`) era un permesso senza unità.
`'allowed'` permetteva un budget che l'API ha cancellato. `'off'` non mandava
niente — e su un modello 5-series non mandare niente significa **thinking
acceso**, quindi era una dichiarazione che la richiesta contraddiceva.

---

## Decisione

**1. I blocchi di ragionamento attraversano il sistema intatti.** Un tipo
`ThinkingBlock` (`thinking` + `signature`, oppure `redacted_thinking` + `data`)
entra in `ContentBlock`, così un `switch` deve rispondere per entrambi.
`ChatResult.thinking` li porta fuori dall'adapter nell'ordine ricevuto; il loop
li rimette **in testa** al turno dell'assistente che ricostruisce, davanti ai
blocchi `tool_use`. L'adapter li rispedisce campo per campo, mai con uno spread:
un campo nuovo nella forma deve fermare la build, non il turno.

**2. `thinking` diventa `'adaptive' | 'off'`, e il loop lo passa davvero.**
`'adaptive'` → `{type:'adaptive'}`; `'off'` → `{type:'disabled'}`, non "non
mandare niente". `budget_tokens` sparisce dal codice e dai tipi. `effort` non
viene mandato: `"high"` è il default dell'API, quindi aggiungerlo sarebbe un
valore in più libero di derivare a comportamento invariato.

Nessun alias `'allowed'` → `'adaptive'`: un profilo di terze parti che lo dice
ancora viene **scartato al confine** e nominato in `doctor`. Tenerlo funzionante
terrebbe in vita una parola che descrive un budget inesistente, e il modo di
fallire di questo repo è proprio il meccanismo che continua a sembrare a posto.

**3. `sampling: 'deterministic' | 'model-default'` sul profilo.**
`'deterministic'` manda `temperature: 0`; `'model-default'` non manda **nessun
campo** (non `undefined`: un campo assente, che è l'unica forma che quei modelli
accettano). `frontier` è `model-default`, `consumer-local` e `CONSERVATIVE` sono
`deterministic`. Il campo ha un default nello schema zod pari a `deterministic`,
cioè a quello che il loop faceva prima che esistesse: un profilo scritto per il
vecchio schema conserva esattamente il comportamento che aveva.

**4. Il percorso openai-compat dichiara il buco invece di nasconderlo.**
`ChatResult.thinking` è `[]` lì, scritto a mano, e l'header del file spiega
perché (sotto, in Conseguenze).

---

## Alternative scartate

- **Rifare il turno dell'assistente verbatim** (`ChatResult` che porta l'array
  di blocchi intero, e il loop che lo rispedisce senza toccarlo). È letteralmente
  ciò che la documentazione chiede, e uccide il riordino per costruzione. Scartata
  per ampiezza: `text` è normalizzato (unito e trimmato) e viene usato altrove
  nel turno, quindi il verbatim divergerebbe da ciò che finisce in sessione e in
  memoria. Il residuo accettato è scritto sotto, in Conseguenze.
- **Alias `'allowed'` → `'adaptive'`.** Scartata: vedi sopra.
- **Mandare `output_config: {effort: 'high'}`.** Comportamento identico
  all'ometterlo, e un valore in più da tenere allineato. Se un giorno servirà
  `low` per una lane economica, sarà un campo di profilo con la sua misura, non
  un default copiato.
- **Attivare il reasoning su OpenRouter in questa slice.** È opt-in lì e costa
  token che oggi non paghiamo: è una decisione con un prezzo, non una correzione
  di correttezza, e infilarla qui l'avrebbe resa invisibile.
- **Un elenco di modelli dentro l'adapter** ("questi rifiutano `temperature`").
  Sarebbe `if (model === ...)` scritto altrove, e ADR-0022 tiene i parametri
  per-modello nei profili apposta.

---

## Conseguenze

### Spesa e latenza: cosa cambia davvero

La domanda posta esplicitamente era se attivare il thinking adattivo sul profilo
frontier cambi la spesa. **Sul percorso Anthropic diretto, no**, e il meccanismo
è questo: quei modelli ragionano già oggi, perché il loop non mandava il campo e
per i 5-series "campo assente" significa acceso. Mandare `{type:'adaptive'}`
esplicito è, per documentazione, identico a ometterlo. Stiamo rendendo vera una
dichiarazione, non accendendo qualcosa.

Cambia invece in tre casi, tutti dichiarati:

1. **Un modello Anthropic più vecchio dietro un profilo `adaptive`.** Su Opus
   4.8/4.7 il campo assente significa *senza* thinking; mandarlo esplicito lo
   accende, e si paga. Nessun profilo shipped li intercetta oggi (cadono in
   `CONSERVATIVE`, che è `off`), ma chi ne scrive uno deve saperlo.
2. **`gpt-5*` perde `temperature: 0`.** È nei glob di `frontier`, che ora è
   `model-default`. Sui modelli di ragionamento OpenAI il sampling non è
   regolabile comunque, quindi ometterlo è più corretto che mandarlo — ma è un
   cambio di forma della richiesta e va detto.
3. **`retryOnce` su frontier smette di essere inutile.** La nota del profilo
   diceva, correttamente, che a temperatura 0 il retry rispedisce una richiesta
   identica. Alla temperatura propria del modello non lo è più: il passo della
   cascata finalmente fa qualcosa.

### Il percorso openai-compat — accertato, non assunto

L'installazione viva dell'owner passa da OpenRouter con
`anthropic/claude-sonnet-5`, quindi qui una supposizione sbagliata costa a lui e
non a un utente ipotetico. Verificato il 2026-08-13:

- OpenRouter **espone** il reasoning per quel modello: `reasoning`,
  `include_reasoning` e `reasoning_effort` sono nei suoi `supported_parameters`,
  e restituisce `reasoning` / `reasoning_details` con la stessa regola di
  Anthropic ("the entire sequence of consecutive reasoning blocks must match the
  outputs generated by the model during the original request").
- Ma è **opt-in**. Muffin non manda nessuno di quei parametri, quindi non torna
  niente, quindi **oggi non stiamo perdendo niente su quel percorso**. Il difetto
  lì è latente, non attivo — che è una frase diversa da "quel percorso è a
  posto", e la differenza è un parametro di richiesta.
- I tipi dell'SDK OpenAI (v7.4.0, controllato) non hanno alcun campo `reasoning`
  sul messaggio di risposta: attivarlo non è una riga, vuole uno schema al
  confine (PRACTICES §4) e ha un costo in token.
- `temperature` **non è** nei `supported_parameters` di
  `anthropic/claude-sonnet-5` su OpenRouter: il gateway lo normalizza via invece
  di rifiutare, quindi lo `0` che mandavamo da sempre veniva scartato in
  silenzio. Con questa slice smettiamo di mandarlo.

Quindi: sul percorso vivo dell'owner questa slice **non cambia comportamento né
spesa**. La correzione morde sul percorso Anthropic diretto — che è quello che
`muffin init` configura di default e che oggi non funziona affatto per via del
`temperature: 0`.

### Cosa resta non misurato, e quanto costerebbe misurarlo

Detto chiaramente: **nessuna affermazione qui è stata verificata contro l'API
viva.** Tutto è letto dalla documentazione del 2026-08-13 più test con provider
finti. In particolare restano non misurati:

- che `{type:'adaptive'}` esplicito sia davvero identico a ometterlo (documentato,
  non osservato);
- che `temperature: 0` restituisca 400 su **Sonnet 5** nello specifico — la guida
  di migrazione viva ha la sezione per Opus 5, non per Sonnet 5, e la regola per
  Sonnet 5 viene dalla tabella di riferimento. Per Opus 4.7+ la frase è testuale;
- che rispedire i blocchi produca davvero i cache hit che la documentazione
  attribuisce loro;
- il verso in cui OpenRouter traduce l'assenza del parametro `reasoning` verso un
  modello che a monte ragiona per default.

Una misura reale costerebbe: una chiave Anthropic e ~6 richieste (due turni con
tool × tre configurazioni), qualche centesimo di token — ma la spesa è dell'owner
e la decisione è sua. Il test da scrivere, quando si farà, è un `doctor` che
manda un turno-sonda con un tool finto e riporta `usage.cache_read_input_tokens`
alla seconda iterazione: sarebbe un tracer bullet (PRACTICES §2), perché è
esattamente il tipo di proprietà che può smettere di valere in silenzio.

### Reachability

Il test che tiene su tutto è a livello di `runTurn`, non solo di adapter: le due
metà (il filtro nell'adapter, il letterale nel loop) sono **plausibili
singolarmente**, ed è il modo canonico in cui questo repo si fa male. La lista
"meccanismo corretto, raggiunto da niente" ha nove voci e la nona era proprio il
flag `thinking` di questa feature.

Coperto anche l'incrocio fra due regole (PRACTICES §11): `compactToolResults`
riscrive i payload dei `tool_result` in-place e cammina su ogni blocco di ogni
messaggio — un blocco di ragionamento che tornasse modificato sarebbe l'unico
400 rumoroso di tutta quest'area. C'è un test che compatta davvero e verifica che
i blocchi escano identici.

### Da persistere altrove (PRACTICES §12)

`docs/blueprint/04-roadmap.md` §M5-bis punto 2 e `docs/blueprint/STATE.md:103`
descrivono ancora il difetto come "`thinking` dichiarato e mai passato" con il
rimedio sbagliato. Vanno corretti: il rimedio era *passarlo nella forma nuova*,
e c'era un terzo difetto (il `temperature`) sulla stessa riga. Non toccati qui
perché entrambi i file sono in mano a un'altra slice in corso.

---

## Reversibilità

**Alta per la forma della richiesta**, bassa per il tipo.

Tornare a `budget_tokens` è un `revert` di poche righe — ma non è reversibile nel
senso che conta, perché quella forma è un 400: non è una scelta, è una regressione.
Se un giorno l'API reintroducesse un controllo per-richiesta sulla profondità, il
punto di innesto è il campo `thinking` del profilo, che ora ha già la forma
giusta per prendere un terzo valore.

`ThinkingBlock` dentro `ContentBlock` è la parte che costa disfare: ogni `switch`
sul tipo di blocco lo tratta, ed è voluto — è il modo in cui un adapter nuovo è
costretto a rispondere alla domanda invece di ereditare un `default:` silenzioso.

**Segnale che questa decisione era sbagliata**: turni frontier che tornano con
`stop_reason: 'refusal'` o 400 citando `thinking`, oppure una misura reale che
mostra i blocchi rispediti come costo di input senza il corrispettivo cache read.
Nel primo caso si spegne il campo (`thinking` assente resta una forma valida e
l'adapter la supporta già). Nel secondo la leva non è togliere i blocchi — è
`clear_thinking_20251015` del context editing, che è la manopola che l'API
prevede per questo, e che non abbiamo.
