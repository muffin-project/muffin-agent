# ADR-0107 — Un'identità sigillata nel prompt

**Stato: proposta in questa slice, in attesa dell'owner.** Non tocca il
meccanismo del sigillo. Cambia cosa il turno paga sempre, e cosa legge solo
quando serve.

## Contesto

Su un saluto il prefisso fisso misurato nell'audit è ~8,7–9k token, e
`persona.md` + `rot/identity.md` + `voice.md` ne sono ~5,5k (il 61% del primo
passaggio). `voice.md` da solo è ~2,9k. I tre file descrivono lo stesso
carattere in tre registri. Il loop marca un solo breakpoint di cache, sul
system prompt intero; sui turni reali le hit di cache sono 0.

Sui default spediti, stimati con lo stesso `ceil(caratteri / 4)` di
`muffin prompt show`, il prefisso owner è ~5841 token, di cui ~5073 sono i tre
file (persona 1232, identity 1224, voice 2617). Il resto è catalogo skill
(~186) e regole operative (~581). Lo scarto fra 5841 e i ~9k dell'audit è il
tokenizer reale più i tool e una home già riscritta: il difetto è lo stesso.

Hermes tiene un solo `SOUL.md`, un tetto in caratteri, e quattro breakpoint
(prompt fisso + ultimi tre messaggi). OpenClaw ha budget per file e un modo
`minimal`/`none` per subagent e harness. Anthropic e OpenRouter accettano al
massimo quattro `cache_control` per richiesta; un quinto è un 400.

Il registro emotivo non è stile facoltativo. Lavoro, scherzo e momento emotivo
sono comportamento di prodotto. L'etichetta di gruppo non è un esempio: Muffin
torna nelle stanze Telegram, e `identity.md` non arriva al gruppo.

## Decisione

- Il prefisso interattivo owner è un solo file sigillato, `rot/identity.md`,
  più il catalogo delle skill e il blocco operativo. Il file tiene gli
  invarianti, sotto i 1000 token stimati, e dice esplicitamente che il
  registro segue il momento: il lavoro chiude il compito, lo scherzo è corto,
  un momento delicato è caldo e breve, e il freddo con l'owner non è una
  scelta. La storia delle chat (marzo–novembre 2026) è la misura.
- Gli esempi di forma (emoji, soglie, liste di frasi, lunghezza) stanno nella
  skill `voce`, letta con `skill_read`, e nei probe di `evals/character/`
  (tre probe nuovi: verso lo scherzo, verso il lavoro, verso un momento
  emotivo). Il corpo della skill non entra nel prefisso.
- L'etichetta di gruppo sta in `GROUP_PERSONA`, codice, non nella skill.
  È l'unica copia che la stanza riceve. Non si sposta nell'on-demand.
- `persona.md`, `voice.md` e `defaults/v2/*` escono dall'assemblaggio e da
  `muffin init`. `prompt.version` resta, e sceglie solo `WORK_RULES` o
  `WORK_RULES_V2`.
- Ogni blocco ha un tetto in token stimati. Un test su una home di `muffin
  init` fallisce se un blocco o il prefisso owner (tetto 4000) lo supera.
- I job goal usano un prompt `minimal`: una riga di compito, il catalogo, le
  regole operative. Niente patto. Una ripresa lo tiene perché la riga ha
  `jobId`. I turni che parlano all'owner (osservazione, saluto) restano
  interattivi. Estrazione, giudice e rerank della memoria restano i loro
  prompt di compito, con un tetto, e non ricevono il patto.
- Il loop marca il blocco di sistema e fino a tre messaggi di storia
  stabile prima dell'orologio (`origin: runtime`), mai l'orologio e mai
  ciò che viene dopo. Quattro al massimo. Anthropic e OpenRouter
  (`explicitCache`) li mandano come `cache_control`. Gli altri endpoint
  ignorano il marcatore.

## Alternative

Tenere i tre file e tagliarli è il cerotto: il prossimo esempio torna nel
prefisso, e i tre registri restano. Togliere anche gli invarianti di registro
e l'etichetta di gruppo falsifica il prodotto: un saluto diventa un ticket, e
la stanza perde il pavimento che prima arrivava solo da `voice.md`. Copiare
Hermes fino allo scan anti-injection sui file di contesto non è questa
slice: non c'è una misura che lo chieda.

## Falsificatore

- Il prefisso owner di una home nuova supera i 4000 token stimati, o
  l'identità supera i 1000.
- Un probe di cambio registro (lavoro, scherzo, momento emotivo) fallisce
  quando il patto non dice più la regola, o la regola c'è e il comportamento
  no.
- La stanza non contiene più una riga di etichetta che questa decisione
  elenca in `GROUP_PERSONA` (spazio, filo, privacy, nomi, familiarità che non
  si trasferisce, emoji più rare, registro).
- Su Anthropic o OpenRouter una richiesta porta cinque `cache_control`,
  oppure un endpoint che non li capisce li riceve e risponde 400.
- Un marcatore cade sull'orologio o su un messaggio dopo di lui, oppure
  il prefisso marcato del turno N non è un prefisso byte-identico del
  turno N+1.

## Conseguenze

Una home già installata tiene il suo `rot/identity.md` finché l'owner non
risigilla: il file è nel Root of Trust. `persona.md` e `voice.md` già sul
disco non vengono più letti e non vengono cancellati. Il prompt di quelle
home cala dei due file subito, e dell'identità lunga solo dopo il reseal.
Non si migra il testo privato dell'owner dentro il sigillo da questo
repository.
