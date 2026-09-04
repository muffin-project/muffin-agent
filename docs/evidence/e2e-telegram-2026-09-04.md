# La corsia reale di Telegram, 04/09/2026

Prima corsa riuscita di `evals/e2e/telegram.ts`: modello vero
(`anthropic/claude-sonnet-5`), Bot API vera, owner al telefono, un proxy locale
che registra ogni chiamata. **9 asserzioni su 9 verdi.**

Chiude B2, B11, B13 e D12 — le righe che il 03/09 il dogfood aveva riaperto
perche' erano verdi sull'harness finto e rotte quando l'owner le usava.

Gli identificatori di chat e di messaggio non sono riportati: sono dati
dell'owner. Contano i rapporti fra le scritture, non i loro numeri.

## Il banco non poteva girare, e nessuno lo sapeva

Le prime due corse sono morte su `surface enable` con `Telegram 0: TimeoutError`
e **filo vuoto**. La diagnosi ovvia — «la richiesta non e' arrivata» — era
sbagliata: la richiesta arrivava, la risposta non partiva.

Il proxy vive nello stesso processo del banco, e il banco lanciava la CLI con
`spawnSync`: l'event loop restava fermo finche' il figlio non usciva, quindi il
proxy non era occupato, **non girava**. Il figlio aspettava i 65s di
`REQUEST_TIMEOUT_MS` e moriva.

Il guasto era entrato quando `surface enable` aveva cominciato a validare il
token contro il server vero. Da allora questo banco non poteva essere superato,
e nessun test lo diceva — perche' il difetto vive solo quando il banco gira
intero. Chiuso, con una regola strutturale: un file che ospita un server nel
proprio processo non usa `spawnSync`.

## Cosa dice il filo

**Trascrizione (B11, B13, D12).** Un messaggio solo, 7 edit successive, zero
`deleteMessage`, niente oltre i 4096 caratteri. Lo stato **finale** di quel
messaggio contiene ancora tutti i passi:

```
✓ leggo un file: spesa.txt
✗ eseguo un comando: echo ciao — interrotto
✓ sys.shell: consentito
✓ eseguo un comando: echo ciao

Totale spesa: … = 8.45.
E `echo ciao` ha risposto, sorprendentemente: ciao
```

Passi **e** risposta nello stesso messaggio: da #388 la risposta finale edita il
messaggio che la scia possiede, invece di aggiungerne uno. Una bolla per turno —
la lamentela dell'owner («mi sta rispondendo due volte») misurata sul suo
`muffin.db` e chiusa.

**ASK (D12).** Comando intero (`command: echo ciao`), frase del modello in
corsivo, contesto del taint («turno a taint 2 — gruppo/sconosciuto»), tastiera
di conferma. Dopo il consenso, il passo passa da `✗ interrotto` a
`✓ consentito` a `✓ eseguito`, e i tre restano visibili.

**Coda (B2).** Secondo messaggio mandato mentre il primo girava: confermato in
**0,1 secondi** («in coda: rispondo appena finisco con quello di prima»), in
risposta al messaggio giusto e **prima** della risposta al primo. Entrambi poi
risposti, nell'ordine.

**`/stop`.** «fermato: il turno in corso si interrompe al prossimo passo», poi
«Interrotto.»

## Due asserzioni sbagliate, non due difetti

La corsa ha dato 7/9. Entrambi i rossi erano il banco:

1. **«risposta come messaggio a parte»** — pretendeva il disegno di ieri. #388 ha
   unito risposta e passi *di proposito*, lo stesso giorno. Un banco che porta
   avanti la specifica di ieri accusa il codice di oggi.
2. **`reply_to_message_id`** — il campo storico. Muffin manda
   `reply_parameters.message_id` (Bot API 7.0), corretto; il banco confrontava
   `NaN`.

Riparate e **rigiocate sul filo gia' registrato**: entrambe verdi, senza
ripetere la corsa. Il filo serve a questo.

## Cosa resta aperto

- Il banco richiede un umano per tre messaggi. Toglierlo vuole un client MTProto
  con l'account personale dell'owner: possibile, non deciso — e' una scelta di
  sicurezza sua, non tecnica.
- Un secondo bot non e' una scorciatoia: Telegram non consegna ai bot i messaggi
  di altri bot (da verificare sulla fonte prima di costruirci sopra).
- Sintetizzare gli update dentro il proxy riporterebbe il finto, cioe' esattamente
  cio' che aveva mentito.
