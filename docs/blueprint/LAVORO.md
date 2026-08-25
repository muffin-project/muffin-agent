# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Muffin è installato e in uso (25/08/2026).** La milestone RETURN TO OWNER è
chiusa: S1–S4 in `M5-BIS.md` §RETURN, che possiede il dettaglio: qui resta solo
ciò che serve per scegliere il prossimo lavoro.

**Stato dell'installazione reale**, provato sulla macchina dell'owner:
`~/.muffin` (database di agosto, 29 tabelle, schema v1), provider OpenRouter
con `qwen/qwen3.8-27b` e `qwen/qwen3.7-flash`, gateway vivo sotto launchd, un
job schedulato eseguito da solo. Backup validato prima della migrazione.

**Regola di stop attiva.** Niente sviluppo pre-dogfood: il prossimo lavoro
nasce da un failure osservato usando Muffin, da una requirement owner già
decisa, da una migrazione che rimandare renderebbe costosa, o da un rischio
concreto su authority/data/effect. Non da questa lista.

**Aperto per l'owner:** Telegram non è ancora abilitato (serve il token del
bot); `doctor` segnala due chiavi API, in `~/.muffin/secrets/` (quella usata) e
in `~/.config/muffin/secrets/` — cancellare quella che non si vuole ruotare.

**Follow-up registrati (non slice).** Dall'install: `doctor` su una home che
non ha ancora avviato il codice nuovo mostra un `✗ database` con rimedio
sbagliato («run `muffin init` to create it») su un database che esiste — le
tabelle nuove nascono al primo boot del runtime. Dal judge #90: il meccanismo
N eventi → 1 composizione non ha ancora un assembler che lo chiami (in
produzione resta 1 evento = 1 Work, dichiarato nel codice); `possibly_sent` non
distingue «crashato» da «vivo e in volo» e genera un falso allarme
all'operatore. Dal judge S2: la mutazione interna a `snapshotTo` sopravvive ai
test (difesa in profondità dichiarata); il catch di `cmdRestore` mostra stack
per errori non-`RestoreRefused`; il ramo doctor «behind» è irraggiungibile
finché `MIGRATIONS` è vuota; TOCTOU gateway e assenza di repl-lock restano
dichiarati. Da #78: finestra di pairing, Discord `handle()` non bound. REPL
non-TTY su `wip/repl-linereader-pipe-eof`. `riconcilia.mjs` regex DONE.

**Branch aperti:** solo `slice/readme-open-source-v1` (#84), ferma di proposito
— il README pubblico non contiene falsità ma la milestone non è il lancio.

**Truth maintenance:** M5-BIS possiede status Gate e classificazione RETURN;
PERCORSO §0 possiede l'ordine, ed è chiuso. Le righe A6/A7/A8 e D12/E6 hanno il
meccanismo in HEAD e restano BLOCKER di Gate solo per i residui DOGFOOD.

**Owner decision pendente:** nessuna.
