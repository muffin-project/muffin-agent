# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Regola di stop attiva.** Il prossimo lavoro nasce da un failure osservato
usando Muffin, da una requirement owner decisa, da una migrazione costosa da
rimandare, o da un rischio su authority/data/effect. Non da questa lista.

**Aperto per l'owner:** token del bot Telegram; billing GitHub per la CI.

**Installazione viva, aggiornata e verificata (26/08).** `dev`→`main` (#131,
37 commit) e update reale: la macchina dell'owner gira `main`, gateway sotto
launchd. Il primo giro è stato manuale per forza — `update` ship-a nella
versione a cui aggiorni — trappola ora scritta in `cli/update.ts`; da qui in
poi è un comando solo. Migrazione 3 girata sul DB vero (schema v3, tre fatti
identità appuntati, backup pre-migrazione automatico). **Il failure che ha
aperto la giornata è chiuso**: «Yo!» in sessione nuova → «Yo Giusto! …AI
engineer, freelancer, e il mio creatore». `doctor`: unico WARN il RoT
single-user.

**Fatto 25–26/08** (dettaglio = git log): #106..#131 — fra cui #121 `muffin
update`, #122 memoria appuntata, #126/#128 gate Linux in container, #127 **A10
il giro dell'owner**, #129 **sandbox provato dalla porta vera**. CI **senza
minuti**: merge con gate locale dichiarato in un commento sulla PR.

**In volo:** niente.

**Da non riperdere.** (a) `init` fa le domande di #117 **solo su TTY**: il
percorso che fa un umano non lo prova nessun test (via: un pty con `script`).
(b) `gateway install` **stampa** i comandi del supervisore, non li esegue: si
prova eseguendo ciò che ha stampato. (c) E7 dal vivo: a «che modello usi?» dice
che non lo sa. (d) Un turno «Yo!» ha impiegato ~108s (2 passaggi, qwen 27b) e a
90s andava in timeout: il default di `muffin run` va guardato.

**Tool design vs prassi 2026** — confronto con fonti datate in
`research/tool-design-2026-08-26.md`. Siamo avanti dove conta (idempotenza
tenuta invece che dichiarata; taint→egress = lethal trifecta). Il primo dei
quattro scarti vale una slice: **il confine degli argomenti non esiste** — lo
`inputSchema` non valida niente, e un commento in `agent/providers/types.ts`
promette una validazione che non c'è.

**Coda decisa dall'owner** (l'E2E è fatto, A10): 1) **ASK durevole** —
un'approvazione pendente non sopravvive a un crash; 2) **note di avanzamento
sui turni lunghi**, con **validazione della compaction** (Slipstream, arxiv
2605.08580: un sommario sbagliato è danno silenzioso — si valida contro la
traiettoria, non solo si produce); 3) dedup `gateway↔repl`.

**Conclusioni di design da non riscoprire** (cornice «sistema agentico»:
THESIS §5): `/new` = operazione di CONTESTO, mai di memoria; il consolidatore
idle è l'analogo del sonno; identità owner = pre-caricata, la somiglianza è per
la coda lunga. Regole: Linux prima; modificare>aggiungere; esplorare prima di
costruire; su agenti aggiornarsi a OGGI (web). Le lezioni Claude↔Muffin si
trasferiscono SELETTIVAMENTE: Claude è un coding agent, Muffin no (ADR-0027) —
la porta «programmare via subagenti» resta aperta.

**Follow-up registrati (non slice).** Dogfood: REPL muore su input non-TTY;
manca `sys.inspect` (E7); `doctor` pre-boot dà rimedio sbagliato. Judge:
composizione N→1 senza assembler; `possibly_sent` non distingue crash da
in-volo; TOCTOU gateway; repl-lock assente; finestra pairing; Discord
`handle()` non bound; coppie discord↔telegram.

**Truth maintenance:** M5-BIS possiede status Gate e classificazione RETURN;
PERCORSO §0 l'ordine, ed è chiuso. A6/A7/A8 e D12/E6 hanno il meccanismo in
HEAD, BLOCKER solo per i residui DOGFOOD. `dev` resta privato.

**Owner decision pendente:** nessuna.
