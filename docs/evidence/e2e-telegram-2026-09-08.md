# Corsia Telegram reale, 2026-09-08 07:45–07:52 — bot di prova, modello vero, owner al telefono

Sorgente della corsia: worktree a `dev` 59f81b8 (+ #486 in attesa di gate), `evals/e2e/telegram.ts`, modello `anthropic/claude-sonnet-5` (default dello script), Bot API vera attraverso il proxy; gateway installato fermato per la durata e riacceso dopo (pid 80609). Filo: fuori dal repository (scratch della corsa, token redatto dallo script); le righe citate qui sotto sono la sua lettura. 

## Verdetti: 7/10 verdi

Verdi: passi in un messaggio vero (4 scritture con «✓ leggo un file»), niente `deleteMessage`, **anteprima con un solo `draft_id` per turno**, **rinnovata dentro i 30 s** (le due asserzioni del 06/09 mai eseguite prima con un bot vero), passi presenti ancora alla fine, niente oltre 4096, `/stop` → «fermato» poi «Interrotto.».

Rossi, e perché:
1. `ASK · comando intero e frase del modello` — **asserzione stantia**: `echo ciao` passa da `shell_run` (sola lettura) che dall'ADR-0074 (06/09) non chiede mai. Sul filo: nessun `reply_markup`, il turno non ha chiesto niente, correttamente. Per misurare D12 la corsia deve usare un comando che scrive (`shell_run_write`).
2. `risposta · nello stesso messaggio dei passi (#388)` — **regex stantia**: l'asserzione cerca `/Totale spesa/i`, il modello ha scritto «Spesa totale: 8,45». Sul filo l'ultima `editMessageText` su #479 contiene i passi e poi la risposta: il comportamento #388 c'è.
3. `coda · due messaggi ricevuti` — **non misurato**: l'owner non ha mandato i due messaggi (0 messaggi sul filo), il passo è scaduto. Era verde il 04/09.

## Correzioni fatte dopo la corsa

I primi due rossi sono stati corretti in #487 (l'ASK si misura su una scrittura, che chiede sempre; la risposta si aspetta come edit del messaggio dei passi). La corsia corretta non è stata rieseguita con un bot: costa tempo dell'owner e modello.

## Osservazioni dell'owner
- «è rimasta una bolla, sparita dopo qualche secondo, possibile bug» → è l'anteprima `sendMessageDraft` (privato, TTL 30 s, forma decisa il 06/09): per la Bot API un draft non può diventare messaggio permanente, quindi poi arriva un messaggio vero. Reperto UX: all'owner sembra un guasto.
- «se abbiamo il draft perché il messaggio non è arrivato lì?» → stessa risposta; da valutare se l'anteprima in privato valga la confusione.
- Le corse precedenti (04/09) esistono: questa aggiunge solo le due asserzioni sull'anteprima a HEAD.
