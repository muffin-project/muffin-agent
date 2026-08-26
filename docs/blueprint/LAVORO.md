# Lavoro corrente

Questo è un **handoff operativo**, non una source of truth sul prodotto. Deve
restare piccolo e cancellabile senza perdere conoscenza di Muffin. Lo stato Git
osservato vince quando diverge da questo file.

**Muffin è installato e in uso (25/08/2026).** RETURN TO OWNER è chiusa: il
dettaglio è in `M5-BIS.md` §RETURN. Installazione reale: `~/.muffin` vivo,
OpenRouter, gateway sotto launchd, un job già eseguito da solo, backup validato.

**Regola di stop attiva.** Niente sviluppo pre-dogfood: il prossimo lavoro
nasce da un failure osservato usando Muffin, da una requirement owner già
decisa, da una migrazione che rimandare renderebbe costosa, o da un rischio
concreto su authority/data/effect. Non da questa lista.

**Aperto per l'owner:** token del bot Telegram; billing GitHub per la CI.

**Fatto 25–26/08** (dettaglio = git log): #106..#124 — fra cui #121 `muffin
update` (release affiancate + flip atomico del symlink) e #122 memoria
appuntata (2 giri di judge). CI **senza minuti**: merge con gate locale
dichiarato in un commento sulla PR.

**In volo:** `slice/e2e-giro-owner` (STANDARD): UNO scenario col giro intero
in una casa sola — init → chiave → `gateway install` (unit validata dal
parser della piattaforma) → gateway vivo → conversazione su superficie →
doctor verde → `uninstall` non lascia niente.

**Scoperto il 26/08, da non riperdere.** (a) `init` fa le domande di #117
**solo su TTY**: il percorso che fa un umano non lo prova nessun test (via:
pilotare un pty con `script`). (b) `gateway install` **stampa** i comandi del
supervisore, non li esegue: la catena ha un passo manuale, e il modo di
provarlo è eseguire i comandi che ha stampato. (c) Senza CI il gate Linux si
rifà in locale in un container Docker. (d) L'installazione viva è indietro di
18 commit su `dev` e `muffin update` non è mai stato eseguito davvero: dopo
l'E2E, promozione `dev`→`main` e update reale. (e) E7 riconfermato dal vivo:
a «che modello usi?» risponde che non lo sa — onesto, ma è il buco.

**Coda decisa dall'owner:** 1) **E2E unico** (in volo); 2) **ASK durevole** —
un'approvazione pendente non sopravvive a un crash; 3) **note di avanzamento
sui turni lunghi**, con **validazione della compaction** (Slipstream, arxiv
2605.08580: un sommario sbagliato è danno silenzioso — si valida contro la
traiettoria, non solo si produce); 4) dedup `gateway↔repl`.

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
PERCORSO §0 possiede l'ordine, ed è chiuso. Le righe A6/A7/A8 e D12/E6 hanno il
meccanismo in HEAD e restano BLOCKER di Gate solo per i residui DOGFOOD.
`dev` resta privato: il lancio è un'altra decisione.

**Owner decision pendente:** nessuna.
