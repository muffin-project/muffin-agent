# ADR-0092 — Una chiamata interrotta da noi non è una risposta vuota del provider, e la ripresa appartiene all'invito

**Stato:** accettato · 2026-09-28 · evidenza:
`docs/evidence/abort-locale-e-ripresa-2026-09-28.md` (database, tracce e SDK
dell'installazione viva, 27–28/09/2026). Emenda ADR-0086 nei punti indicati.

## Contesto

ADR-0086 ha introdotto il turno `continuable` partendo da una lettura dei
dati del 18/09: risposte completate con `stop=error`, zero token, nessuna
attività, ~30.0 s l'una, interpretate come stalli dell'upstream dentro una
forma di successo. La misura del 28/09 smentisce quella lettura: le 20
occorrenze `provider_empty` fra il 19/09 e il 28/09 durano tutte fra 30.000 e
30.037 s **su cinque upstream diversi** (Alibaba, Reka, Wafer, DekaLLM,
DeepInfra). Quel timer era il watchdog di prima attività di Muffin
(`firstActivityTimeoutMs = 30_000`), non il provider.

L'abort del watchdog non era osservabile: l'SDK OpenAI termina pulitamente
l'iterazione SSE abortita (`Stream.fromSSEResponse` cattura l'`AbortError` e
fa `return`; probe sul pacchetto installato), quindi `chatStream` usciva senza
eccezione, con `finish_reason` nullo e zero token — la stessa forma di un
upstream che non genera contenuto. Il loop la classificava `provider_empty`,
spendeva tre re-drive sullo stesso percorso e cedeva la lease con una
diagnosi falsa. La coda reale del modello usato (mediana `ttft` 5,5 s, p90
20,9 s, massimo riuscito 29,7 s) dice che il taglio a 30 s colpiva risposte
lente ma sane.

Sullo stesso installazione, la ripresa non rispondeva alla diagnosi:

1. il messaggio di cessione dice «scrivi "riprendi" per continuarlo», ma il
   resolver non legava quell'invito all'id nominato: con un secondo candidato
   nella TTL di 24 h, un «Riprendi» scritto 11 secondi dopo la diagnosi
   diventava una domanda di disambiguazione (misurato il 28/09 alle 08:47);
2. i candidati erano descritti solo dalla classe e dall'ora («turno
   provider_empty (…, 0 tool call completate)») — non rispondibile;
3. `recover()` trattava ogni riga non `done` come «ancora in volo»: un update
   legato a una riga `continuable` restava pendente **per sempre** se nessuno
   la continuava (update `99666230`, legato dal 19/09, «rimando» a ogni
   avvio);
4. la domanda di disambiguazione scriveva la riga con un id nuovo invece del
   workId già reclamato dall'ingresso: composition e consegna puntavano a una
   riga inesistente, e la riga vera restava `delivery = pending`.

Infine l'attesa dei re-drive era muta: fino a due minuti di backoff con
jitter indistinguibili da uno stallo (segnalato dall'owner il 28/09).

## Decisione

1. **Niente watchdog sulla prima attività.** `firstActivityTimeoutMs` esce
   dalla configurazione di esecuzione, dai profili spediti e dalla tassonomia
   degli aborti. Una chiamata che non parla mai è la domanda della deadline
   dura della chiamata (`modelCallDeadlineMs`), che aborta attraverso lo
   stesso segnale e viene riletta dal loop come l'abort che è. Resta il
   watchdog di stallo **dopo** la prima attività (25 s), che misura il
   silenzio di chi ha già parlato.
2. **L'abort è osservabile, e vince sul risultato.** Entrambi gli adapter
   (`openai-compat`, `anthropic`) lanciano `ProviderError('aborted')` quando
   il segnale è scattato e il filo non ha mai mandato il proprio marcatore di
   completamento (`finish_reason` / `stop_reason`). Il loop rilegge la stessa
   verità dopo un risultato a forma di successo: se il segnale è scattato e il
   risultato è vuoto, prende le due porte dell'abort (stop esplicito →
   `aborted`; altrimenti lease ceduta con la classe del watchdog), mai la
   cascata dei vuoti. `ContinuableClass` non produce più
   `model_first_activity_timeout`; le righe scritte prima restano leggibili
   come stringhe.
3. **La ripresa appartiene all'invito.** `resolveContinuation` risolve sulla
   riga continuabile più recente finché è fresca (`INVITATION_WINDOW_MS`, 2 h):
   è quella che la diagnosi ha appena nominato, e un secondo candidato più
   vecchio non deve trasformare l'istruzione in una domanda. Oltre la
   finestra, più candidati tornano ambiguità — e la domanda cita le parole
   della richiesta (`turns.input_text`), non solo la classe.
4. **L'ambiguità scrive la riga che l'evento già nomina.**
   `askWhichContinuation` usa il workId reclamato dall'ingresso; composition,
   consegna e recovery puntano a una riga che esiste.
5. **La finestra di crash non è un deferimento eterno.** `recover()` chiude un
   update legato a una riga `continuable` che ha già consegnato il proprio
   fuoco (il diagnostico è la risposta di quella lease). Se non ha consegnato
   nulla ed è oltre la TTL dell'invito, chiude come `undeliverable` con la
   ragione nel log; se è fresco, rimanda ancora — la finestra fra cessione e
   consegna è un crash, non uno stato stabile.
6. **`doctor` separa le righe raggiungibili in chat da quelle scadute.** Le
   seconde restano lavoro dovuto, ma solo `muffin resume <id>` le tocca; dirle
   «riprendibili con riprendi» manderebbe l'owner a scrivere in vuoto.
7. **L'attesa dei re-drive è visibile.** Ogni re-drive (trasporto o provider
   vuoto) emette `model_retry` con budget, tentativo e attesa dichiarata —
   lo stesso valore passato al `sleep` — prima di dormire; Telegram lo mostra
   nella bozza e nel processo, la CLI in scrollback e in `--debug`.

## Alternative considerate

- **Alzare il watchdog a 60–90 s invece di rimuoverlo**: respinto perché il
  problema misurato non era la soglia ma la semantica — un abort locale
  diventava una risposta del provider. Con l'abort osservabile la soglia
  sarebbe un secondo limite da mantenere senza un consumatore che lo
  giustifichi; la deadline dura già bounded la chiamata.
- **Ereditare lo stato dell'SDK senza toccare gli adapter** (solo il guard nel
  loop): sufficiente per il percorso di produzione, ma lascerebbe il
  contratto di `chatStream` capace di restituire un completamento mai
  avvenuto; entrambe le metà sono economiche e si difendono a vicenda.
- **Ripresa «più recente vince» sempre**: respinto — con due candidati vecchi
  l'owner non può più scegliere quello che voleva; la finestra d'invito tiene
  la determinazione dove la diagnosi ha parlato, e la domanda dove non ha
  parlato.
- **Sweep distruttivo delle righe continuabili scadute**: respinto — la riga è
  lavoro dovuto e resta leggibile; la scadenza decide chi può continuarla, non
  la cancella.
- **Stato d'invito esplicito in una tabella nuova**: respinto per ora —
  l'ordine delle righe continuabili (aggiornate alla cessione) è già la
  risposta, e il campo d'invito dedicato è un completamento, non un
  prerequisito.

## Cosa può smentire la scelta

- Upstream che chiudono davvero lo stream senza `finish_reason` e senza
  errore: oggi verrebbero letti `provider_empty` e re-drivati; se la misura
  mostrasse che è una forma comune, la classificazione va estesa, non
  collassata.
- Modelli che con lease fresche rispondono dove la prima falliva
  sistematicamente: la domanda di ADR-0086 su `recovery_exhausted` resta
  aperta.
- `isContinuationAsk` con falsi positivi/negativi misurati su traffico reale:
  la finestra d'invito non cambia la allowlist; si restringe/allarga con la
  misura, mai con un classificatore.
- Righe continuabili oltre la finestra che nessuno riprende mai: il prossimo
  passo è una superficie che le proponga (`muffin resume`, elenco in
  `doctor`), mai un riavvio automatico — la continuazione resta una
  concessione esplicita dell'owner (ADR-0086, invariato).

## Complementi (non in questa slice)

Invito persistito per sessione; elenco dei continuabili scaduti con id
completo in `doctor`; sweep periodico; `muffin resume` via gateway; livello
Work/Goal esplicito.
