# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Muffin è installato e in uso (25/08/2026).** RETURN TO OWNER è chiusa: il
dettaglio è in `M5-BIS.md` §RETURN. Installazione reale: `~/.muffin` vivo,
OpenRouter, gateway vivo sotto launchd, backup validato.

**Regola di stop attiva.** Il prossimo lavoro nasce da un failure osservato
usando Muffin, da una requirement owner decisa, da una migrazione costosa da
rimandare, o da un rischio su authority/data/effect. Non da questa lista.

**Aperto per l'owner:** token del bot Telegram; billing GitHub per la CI.

**Fatto 25–26/08** (dettaglio = git log): #106..#127 — fra cui #121 `muffin
update`, #122 memoria appuntata, #126 gate Linux in container, #127 **A10: il
giro dell'owner** (un solo scenario, dalla macchina pulita alla risposta;
gamba Linux provata con `systemd-analyze verify`). CI **senza minuti**: merge
con gate locale dichiarato in un commento sulla PR.

**In volo:** `slice/probe-porta-vera` (CRITICAL): il probe del sandbox deve
significare «ho eseguito qualcosa di contenuto qui», non «bwrap risponde a
una mia invocazione».

**Scoperto il 26/08, da non riperdere.** (a) `init` fa le domande di #117
**solo su TTY**: il percorso che fa un umano non lo prova nessun test (via:
pilotare un pty con `script`). (b) `gateway install` **stampa** i comandi del
supervisore, non li esegue: la catena ha un passo manuale, e il modo di
provarlo è eseguire i comandi che ha stampato. (c) Gate Linux senza CI:
`npm run test:acceptance:linux`. Prima corsa: 28/29, e **un reperto CRITICAL**
— il probe dice `available` mentre l'esecuzione vera muore su `Can't mount
proc`, perché probe ed esecutore invocano bwrap per strade diverse (diretto vs
`SandboxManager`): in un container su VPS `doctor` sarebbe verde e ogni script
fallirebbe. In riparazione. (d) L'installazione viva è 18 commit indietro e `muffin update`
non è mai girato davvero: dopo l'E2E, `dev`→`main` e update reale. (e) E7 dal
vivo: a «che modello usi?» dice che non lo sa.

**Coda decisa dall'owner** (l'E2E è fatto, A10): 1) **ASK durevole** —
un'approvazione pendente non sopravvive a un crash; 2) **note di avanzamento
sui turni lunghi**, con **validazione della compaction** (Slipstream, arxiv
2605.08580: un sommario sbagliato è danno silenzioso — si valida contro la
traiettoria, non solo si produce); 3) dedup `gateway↔repl`.

**Conclusioni di design da non riscoprire** (cornice «sistema agentico»:
THESIS §5): `/new` = operazione di CONTESTO, mai di memoria (pipeline tutte
fuori sessione, verificato); superfici residenti → sessione infinita +
compaction, il consolidatore idle è l'analogo del sonno; identità owner =
pre-caricata, la somiglianza è per la coda lunga. Regole: Linux prima;
modificare>aggiungere; esplorare prima di costruire; su agenti aggiornarsi a
OGGI (web). Le lezioni Claude↔Muffin si trasferiscono SELETTIVAMENTE: Claude
è un coding agent, Muffin no (ADR-0027) — ma la porta «programmare via
subagenti» resta aperta, da decidere con un trigger.

**Follow-up registrati (non slice).** Dogfood: REPL muore su input non-TTY;
manca `sys.inspect` (E7); `doctor` su home pre-boot dà rimedio sbagliato.
Judge: composizione N→1 senza assembler; `possibly_sent` non distingue crash
da in-volo; TOCTOU gateway; repl-lock assente; finestra pairing; Discord
`handle()` non bound; coppie discord↔telegram (dedup solo con trigger).

**Truth maintenance:** M5-BIS possiede status Gate e classificazione RETURN;
PERCORSO §0 l'ordine, ed è chiuso. A6/A7/A8 e D12/E6 hanno il meccanismo in
HEAD, BLOCKER solo per i residui DOGFOOD. `dev` resta privato.

**Owner decision pendente:** nessuna.
