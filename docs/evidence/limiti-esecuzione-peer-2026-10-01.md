# Limiti di esecuzione: fuse per chiamata e ripresa — 2026-10-01

Questione che ha commissionato il documento: #824 — il «riprendi» conversazionale
non riprende: ogni lease concessa da un grant muore in `model_deadline` a 90.0 s
esatti senza mai parlare. Classificazione del claim: STANDARD (verifica in
`agent/profiles/execution.test.ts` + dogfood di una ripresa).

## 1. Evidenza Muffin osservata (installazione dell'owner, aggregata)

Un turno reale con lavoro lungo (19 tool call completate, ~220k token di input
sommati sulle 10 chiamate della lease 0) cede `model_deadline`. Stato successivo,
dai dati correnti:

| lease | durata | tool call | token | esito |
|---|---|---|---|---|
| 0 | ~10 min | 19 | 220k in | cede `model_deadline` (wall) |
| 1 | 90.03 s | 0 | 0 | `model_deadline`, zero attività |
| 2 | 90.02 s | 0 | 0 | `model_deadline`, zero attività |
| 3 | 90.31 s | 0 | 0 | `model_deadline`, zero attività |

Le trace dei tre abort riportano `abort_reason: model_deadline`,
`effective_deadline_ms: 90000` e nessun `ttft_ms`: il provider non ha mai
iniziato a parlare entro il fuso. Le chiamate sane della stessa catena avevano
TTFT 26–57 s. Il pattern: il grant di continuazione re-invia l'intero transcript
di lavoro (l'evidence filtrata dall'harness control) e il messaggio di grant
cambia il prefisso — la cache del provider non copre il primo call della lease
nuova, che paga il prefill completo. Con la pretesa di risposta sotto i 90 s,
ogni ripresa muore prima di produrre: dall'esterno, «riprendi che non riprende
mai», e ogni morte riscalda la riga `continuable` (la finestra d'invito di
`INVITATION_WINDOW_MS` riparte) in un loop guidato solo dalla pazienza
dell'owner.

Corollario di contesto (non un difetto, qui per completezza): un `riprendi`
scritto oltre 2 h dall'ultima cessione con più righe continuabili aperte non è
un rifiuto — è la domanda di disambiguazione voluta da ADR-0092 §3.

## 2. Meccanismo attuale e invariante

`ExecutionBudget.beginModelCall` arma un solo timer per chiamata:
`min(modelCallDeadlineMs, wall restante, budget attivo restante)`; abort =
`model_deadline` → cessione `continuable` (round.ts). Il watchdog di stallo
(25 s) arma **solo dopo** la prima attività (decisione 2026-09-28). Quindi
`modelCallDeadlineMs` è insieme tetto totale della chiamata e bound del
«mai parlato»: un modello lento a iniziare — o un prefill grande — viene
tranciato a prescindere dal fatto che la connessione sia viva.

L'invariante da proteggere non è il numero: è che una chiamata morta si veda
presto, che il turno non occupi la corsia per sempre e che la proprietà di
spesa del lease resti leggibile. Il numero 90 s nasce in
`docs/evidence/interactive-model-budget-2026-09-10.md` come fuse per modelli
locali su laptop, e `consumer-qwen3` l'ha ereditato per copiatura manuale senza
misura propria.

## 3. Peer per problema (sorgenti primarie, consultate 2026-09-30/01-10)

Il problema peer-comparabile non è «quanto dura una chiamata» ma «quando
dichiari una chiamata morta»: i sistemi pertinenti legano il bound al **silenzio
del provider**, non alla durata totale.

- **OpenAI Codex CLI** (`openai/codex`, `codex-rs/model-provider-info/src/lib.rs`,
  consultato 2026-10-01): `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`,
  `DEFAULT_STREAM_MAX_RETRIES = 5`, `DEFAULT_REQUEST_MAX_RETRIES = 4`,
  `DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000`. Nessun tetto totale sulla
  chiamata: una stream che parla vive finché parla; il bound scatta sul
  silenzio e sulla connessione.
- **Anthropic TypeScript SDK** (`resources/messages/messages.ts`, via context7
  2026-10-01): timeout di default 600 s sulle richieste non-streaming; il check
  «long-request» è **interamente saltato quando `stream: true`** — il bound
  Frontier reale non è mai una scadenza totale messa in harness.
- **Hermes** (`docs/evidence/hermes-documentazione.md`): retry limitati (3),
  timeout fail-closed 300 s.
- La classe dei fallimenti è la stessa già misurata da noi il 30/09
  (`shipped.test.ts`): modelli consumer con TTFT alto e variabile su prompt
  grandi. Lì la risposta fu la compattazione (16k char), non il numero.

Nessun peer che consultiamo trancia a 90 s una chiamata che non ha ancora
parlato su un prefill grande; il bound dei peer è 300 s sul silenzio (Codex,
Hermes) o assente con retry (Anthropic streaming).

## 4. Tabella di decisione

```text
Fallimento misurato: ogni lease di continuazione muore in model_deadline a
  90.0 s con zero attività (3/3 riprese, stesso turno, installazione owner).
Meccanismo attuale: un solo bound per chiamata (modelCallDeadlineMs) fa da
  tetto totale E da bound del «mai parlato»; 90 s su entrambi i profili
  consumer (consumer-qwen3 ereditati a mano da consumer-local, mai misurati).
Invariante da proteggere: chiamata morta = vista presto; corsia libera; spesa
  per lease leggibile; nessuna ripresa indefinita senza grant.

Candidato A (aleggiato): innalzare il bound per chiamata dei profili consumer a
  300 s — il bound di silenzio dei peer (Codex default, Hermes fail-closed) —
  sui profili JSON spediti, senza toccare il loop.
  PRO: fissa il pattern osservato (TTFT sani 26–57 s, code OpenRouter oltre
    90 s); un numero solo, dove il numero già vive (profilo = dati, non
    codice); la fuse resta, semplicemente al valore dei peer; niente schema
    migration, niente ADR nuovo (il numero non era in ADR: era in evidence).
  CONTRO: una chiamata truly-dead ora costa 300 s prima di cedere (prima 90);
    il turn wall da 900 s continua a legare il totale del lease.
  Falsificatore: se dopo il cambio le riprese dello stesso tipo di lavoro
    muoiono ancora in model_deadline/zero-attività, il bound non era la causa
    e va aperta la questione forma (C).

Candidato B: spezzare il bound in due campi (tetto totale + bound di prima
  attività), ADR-0092 aveva rimosso un campo analogo.
  CONTRO: ADR-0092 respinse il bound di prima attività perché **non era il
    numero il problema, era la semantica** (abort locale letto come
    provider_empty) e la risoluzione è l'abort osservabile; ri-aggiungere un
    secondo campo subito dopo averne rimosso uno, con il valore di A che già
    copre il caso misurato, è un campo senza consumatore. Da riprendere solo
    se emergono chiamate sane più lente di 300 s.

Candidato C (rimuovi/semplifica): togliere il tetto totale per chiamata,
  restare solo su stall (25 s dopo attività) + turn wall, come Codex.
  CONTRO: una stream che non arriva mai (connect OK, zero byte) oggi è legata
    SOLO dal tetto di chiamata; senza, l'attesa è la wall intera (900 s) prima
    di qualsiasi diagnosi. È una forma corretta per un CLI in foreground con
    Ctrl-C; Muffin è single-lane su superficie: 15 minuti muto su Telegram non
    è un'esperienza, è un guasto. Non scelto oggi; è la forma da valutare se
    #803 (finestra di contesto a budget) rende il replay della continuazione
    strutturalmente più piccolo.

Scelto: A. Allineamento 90 s → 300 s su consumer-local e consumer-qwen3
  (JSON spediti + note dei file + pin in execution.test.ts). DEFAULT_EXECUTION
  (90 s) resta: è il pavimento conservativo per modelli sconosciuti, non il
  profilo di nessuno oggi. Frontier (120 s) non toccato: nessun dato di morte
  su quel percorso.
```

## 5. Conseguenze dichiarate

- Sicurezza/authority: nessuna. Il budget monetario per tenant/giorno e il
  gate dei permessi sono fuori da questo numero.
- Durabilità: nessuna migrazione; i profili sono riletti a ogni build del
  runtime.
- UX: il «mai parlato» si vede dopo 300 s invece di 90; il «parlava e ha
  smesso» resta a 25 s di silenzio.

## 6. Cosa non è cambiato e perché dichiarato

- Il grant di continuazione continua a rimintare budget lease-locali azzerati
  (`buildFreshCounters`, contratto del lease-reset documentato in
  `agent/loop/continuation.ts`): è il design P0-B, non il bug misurato qui.
- Le righe `continuable` non vengono spazzate: sweep respinto in ADR-0092; il
  confine raggiunto in chat è la finestra di 24 h del resolver, quella del
  comando esplicito resta `muffin resume <id>`.
- La compattazione dei tool result non è toccata: con la fuse a 300 s resta il
  modo giusto di tenere basso il prefill, non solo il rischio.

## 7. Misura che falsificherebbe la scelta

Se il 10/2026 mostra riprese che muoiono `model_deadline` a zero-attività
nonostante il bound da peer, la forma del bound è sbagliata e va aperto il
discriminante (B o C), con evidenza di chiamate sane oltre i 300 s.
