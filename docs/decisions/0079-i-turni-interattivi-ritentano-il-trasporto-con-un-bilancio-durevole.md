# ADR-0079 — I turni interattivi ritentano il trasporto con un bilancio durevole

**Stato:** accettato · 2026-09-14 · richiesta esplicita dell'owner («ritenta fino a
10 volte, a distanze crescenti, e riprendi da solo»), verificata contro i turni
Telegram dell'installazione e il percorso di produzione.

## Contesto

La release installata `78ed149` aveva già rimosso il tetto numerico di tool call
per `consumer-local`, ma il turno Telegram poteva ancora chiudersi prima della
risposta. Sui turni recenti il risultato era `error` dopo 2–15 call e molto
prima dei 15 minuti; l'ultimo aveva `delivery=pending`, nessun piano di invio e
la riga Telegram segnalava `Connection error.`. Il conteggio di tool call non
spiega questi arresti.

Sul percorso attuale `MAX_TRANSPORT_RETRIES` vale 2 e il backoff esponenziale con
jitter arriva a 8 secondi. I provider SDK sono configurati con `maxRetries: 0`,
quindi il loop possiede l'intero budget. Quando il budget finisce, il rethrow da
`drive()` non produce un `TurnResult` da consegnare. La PR che introduce una
risposta d'errore sicura e durevole dimostra il percorso di consegna, ma il
budget di retry restava quello corto.

La decisione storica di tenere solo due retry proteggeva da turni che restano
aperti mentre un provider è indisponibile. Il nuovo orizzonte interattivo è
limitato dal budget temporale del turno e dai tetti monetari per tenant; il
problema osservato è invece che pochi guasti transitori interrompono una
richiesta di più passaggi senza una risposta utile.

## Decisione

1. Un turno interattivo ha dieci retry di trasporto oltre alla prima chiamata
   (undici tentativi totali). Il backoff usa full jitter con finestre che
   raddoppiano da 500 ms e si fermano a 120 secondi.
2. Dopo ogni errore transitorio, Muffin salva nel record il budget rimanente
   **prima** di dormire. Se il gateway si riavvia durante l'attesa, il normale
   recupero riprende lo stesso transcript e lo stesso contatore; i tool già
   completati non vengono eseguiti di nuovo.
3. Restano invariati timeout per chiamata, orizzonte massimo del turno,
   annullamento esplicito, permessi degli effetti e budget giornaliero/mensile.
   Errori permanenti, output malformato e abort non entrano nel retry di
   trasporto.
4. L'esaurimento diventa un risultato terminale sicuro e visibile su Telegram.
   Se la consegna fallisce, la risposta già salvata viene ritentata senza
   richiamare il modello.
5. I retry dei tool restano governati dalla loro idempotenza; la lane ausiliaria
   di memoria mantiene due retry, così una ricerca o un consolidamento non
   ereditano il budget più lungo della chat.

## Alternative considerate

- Lasciare due retry: respinto dai turni reali che si fermano presto e dal
  requisito esplicito dell'owner.
- Affidare il retry all'SDK: respinto perché Muffin imposta `maxRetries: 0` e
  perderebbe il conteggio durevole, il backoff comune e il confine di spesa.
- Ripetere il turno o le tool call dopo un errore: respinto perché un tool può
  produrre effetti; si ripete solo la richiesta al modello sul transcript che
  conserva i risultati già registrati.
- Retry illimitato: respinto perché non offre un limite di costo o di attesa.

## Cosa può smentire la scelta

La prova deve mostrare che dieci errori transitori sono seguiti da una risposta
all'undicesimo tentativo, che l'errore terminale raggiunge Telegram in forma
sicura, che un guasto di consegna non richiama il modello e che il ripristino
durante il backoff non azzera i retry. Se ciò non regge sotto CI o se un errore
non transitorio viene ritentato, la scelta non è soddisfatta.

## Evidenza

`docs/evidence/retry-trasporto-turni-interattivi-2026-09-14.md` registra il
percorso misurato, il confronto con i client OpenAI e Hermes e i limiti della
conclusione.
