# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner decisa, da una migrazione costosa da
rimandare, o da un rischio su authority/data/effect. Non da questa lista.

**Aperto per l'owner:** token bot Telegram; billing GitHub CI.

**Installazione viva su `main` (26/08):** migrazione 3 sul DB vero, «Yo!»
risponde con l'identità. Trappola del primo update: `cli/update.ts`.

**CI senza minuti:** merge con gate locale dichiarato in un commento sulla PR.
Un check rosso in 2s con zero step è fatturazione, non un test.

**Il prompt vivo è del 9 agosto** — 11498 caratteri contro 22477: `update` non
tocca ciò che `init` ha copiato, e la persona approvata il 17/08 non è mai
arrivata all'agente che gira. `policy.json`/`budgets.json` derivano ma **non**
funzionalmente. Prova: `research/deriva-defaults-2026-08-26.md`. Da #142
`doctor` lo **vede** e propone il `cp` solo per i file mai toccati: adottarlo
resta scelta dell'owner, e il reseal del RoT pure.

**Misurato.** (a) **La cache non prende**, 2.8% su 18 chiamate, e non è il
nostro prefisso: `research/cache-prompt-2026-08-26.md`. (b) Ogni `sys.shell` è
`effect=ask`: la lamentela dell'owner è un dato. (c) `memory.recall` gira
**senza vettori** (`EmbedderUnavailable`). (d) Un `memory.ingest` da solo:
129s, zero chiamate al modello.

**Fatto delle quattro lamentele dogfood:** trace per step (#133), progresso su
REPL (#136) e su Telegram con draft+edit (#143, #145), prompt operativo
(#135). **Resta la terza**: `sys.shell` chiede sempre per `decide.ts:245` —
allow silenzioso solo se `ctx.hardened`, falso perché `rot/` è dello stesso uid
che gira l'agente. La via è **rendere vera** la modalità hardened (utente di
servizio, `rot/` di un altro uid): sulla VPS si può, il meccanismo c'è da #138.
Una concessione durevole contraddirebbe ADR-0003.

**Non riaprire.** `muffin run` non ha un timeout di default (`cli/run.ts:59`);
i 90s erano del mio harness. Il default SDK è 10 min e la guardia «streaming
oltre 10 min» non ci tocca (4096 `max_tokens` contro 21333).

**Da non riperdere.** (a) `init` fa le domande di #117 **solo su TTY**: nessun
test copre il percorso umano (via: pty con `script`). (b) `gateway install`
**stampa** i comandi del supervisore, non li esegue. (c) E7 dal vivo: a «che
modello usi?» dice che non lo sa. (d) **Il confine degli argomenti non
esiste**: `inputSchema` non valida niente e `agent/providers/types.ts` promette
il contrario (`research/tool-design-2026-08-26.md`). (e) Le ancore della mappa
verificano **solo il primo intervallo** di `file:A-B,C-D`.

**Coda owner:** ASK durevole (un'approvazione pendente non sopravvive a un
crash); note di avanzamento con **validazione della compaction** (arxiv
2605.08580); dedup gateway/repl.

**Design da non riscoprire** (THESIS §5): `/new` = operazione di CONTESTO, mai
di memoria; il consolidatore idle è l'analogo del sonno; identità owner
pre-caricata, la somiglianza è per la coda lunga. Claude è un coding agent,
Muffin no (ADR-0027): le lezioni si trasferiscono SELETTIVAMENTE.

**Follow-up registrati.** REPL muore su input non-TTY; `doctor` pre-boot dà
rimedio sbagliato; composizione N→1 senza assembler; `possibly_sent` non
distingue crash da in-volo; TOCTOU gateway; repl-lock assente; finestra
pairing; Discord `handle()` non bound; un 429 persistente spegne il progresso;
`memory.extract`/`memory.rerank` non emettono span.

**Truth maintenance:** M5-BIS possiede status Gate e RETURN, PERCORSO §0
l'ordine. A6/A7/A8 e D12/E6: meccanismo in HEAD, BLOCKER solo per i residui
DOGFOOD. `dev` resta privato.
