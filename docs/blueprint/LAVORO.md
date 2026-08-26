# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Muffin è installato e in uso (25/08/2026).** La milestone RETURN TO OWNER è
chiusa: S1–S4 in `M5-BIS.md` §RETURN, che possiede il dettaglio: qui resta solo
ciò che serve per scegliere il prossimo lavoro.

**Installazione reale**: `~/.muffin` vivo, OpenRouter (famiglia Qwen),
gateway sotto launchd, un job già eseguito da solo. Backup validato.

**Regola di stop attiva.** Niente sviluppo pre-dogfood: il prossimo lavoro
nasce da un failure osservato usando Muffin, da una requirement owner già
decisa, da una migrazione che rimandare renderebbe costosa, o da un rischio
concreto su authority/data/effect. Non da questa lista.

**Aperto per l'owner:** token del bot Telegram; delle 2 chiavi API cancellare
quella da non ruotare (`doctor` le nomina); `muffin jobs remove 922ac8b7`;
billing GitHub per la CI.

**Fatto 25–26/08** (dettaglio = git log): #106..#122. Le ultime due: #121
`muffin update` (release affiancate + flip atomico del symlink, mai mutare
l'albero che gira; `main` è il canale) e #122 memoria appuntata (CRITICAL,
2 giri di judge: iniezione incondizionata a budget 12; pin solo tier-0/said,
gate nel codice — `addFact` E il backfill della migrazione 3; mai nei tenant
group; supersessione vince; `muffin memory pin/unpin`). CI **senza minuti**
(billing): merge con gate locale dichiarato in un commento sulla PR.

**In volo:** niente.

**Coda decisa dall'owner:** 1) test **E2E unico** — install pulita → token →
gateway vivo → conversazione (il «MOLTO IMPORTANTE», oggi provato a pezzi);
2) **ASK durevole** — un'approvazione pendente non sopravvive a un crash;
3) **note di avanzamento sui turni lunghi** — con **validazione della
compaction** (Slipstream, arxiv 2605.08580: un sommario sbagliato è danno
silenzioso — si valida contro la traiettoria, non solo si produce);
4) dedup `gateway↔repl`.

**Conclusioni di design da non riscoprire** (cornice «sistema agentico»:
THESIS §5): `/new` = operazione di CONTESTO,
mai di memoria (pipeline tutte fuori sessione, verificato); superfici
residenti → sessione infinita + compaction, il consolidatore idle è l'analogo
del sonno; identità owner = pre-caricata, la somiglianza è per la coda lunga.
Regole: Linux prima; modificare>aggiungere; esplorare prima di costruire;
su agenti aggiornarsi a OGGI (web). Le lezioni Claude↔Muffin si trasferiscono
SELETTIVAMENTE: Claude è un coding agent, Muffin no (ADR-0027) — ma la porta
«programmare via subagenti» resta aperta, da decidere con un trigger.

**Follow-up registrati (non slice).** Dogfood: REPL muore su input non-TTY;
manca `sys.inspect` (E7, 3 vicoli ciechi su `muffin run`); `doctor` su home
pre-boot dà rimedio sbagliato. Judge: composizione N→1 senza assembler;
`possibly_sent` non distingue crash da in-volo; TOCTOU gateway; repl-lock
assente; finestra pairing; Discord `handle()` non bound; coppie
discord↔telegram (dedup solo con trigger).

**Branch aperti:** nessuno. #84 (README pubblico) è stata aggiornata a HEAD
(fact-check senza claim falsi) e mergiata il 26/08 — in `dev`, che resta
privato: il lancio è un'altra decisione.

**Truth maintenance:** M5-BIS possiede status Gate e classificazione RETURN;
PERCORSO §0 possiede l'ordine, ed è chiuso. Le righe A6/A7/A8 e D12/E6 hanno il
meccanismo in HEAD e restano BLOCKER di Gate solo per i residui DOGFOOD.

**Owner decision pendente:** nessuna.
