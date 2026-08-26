# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner decisa, da una migrazione costosa da
rimandare, o da un rischio su authority/data/effect. Non da questa lista.

**Aperto per l'owner:** token bot Telegram; billing GitHub CI.

**Installazione viva su `main` (26/08):** migrazione 3 sul DB vero, «Yo!»
risponde con l'identità, `doctor` col solo WARN RoT single-user. Trappola del
primo update: `cli/update.ts`.

**CI senza minuti:** merge con gate locale dichiarato in un commento sulla PR.

**Il prompt vivo è del 9 agosto** — 11498 caratteri contro 22477: `update` non
tocca ciò che `init` ha copiato, e la persona approvata il 17/08 non è mai
arrivata all'agente che gira. `policy.json`/`budgets.json` derivano ma **non**
funzionalmente. Prova e disegno: `research/deriva-defaults-2026-08-26.md`.
Prossima slice, in `doctor`; il reseal del RoT resta scelta dell'owner.

**Misurato con quella vista.** (a) **La cache non prende**, 2.8% su 18
chiamate, e non è il nostro prefisso: `research/cache-prompt-2026-08-26.md`.
(b) Ogni
`sys.shell` è `effect=ask`, nessuna eccezione: la lamentela dell'owner è un
dato. (c) `memory.recall` gira **senza vettori** (`EmbedderUnavailable`).
(d) Un `memory.ingest` da solo: 129s, zero chiamate al modello.

**Ordine deciso.** 1) trace per step **fatto** (#133). 2) **Canale di
progresso**, delegato: NON allargare
`TurnDelta` (porta solo la risposta finale, bufferizzata fino al round terminale
per non ritrattare testo) ma un secondo sink `onProgress` — un evento di
progresso racconta ciò che è già successo, quindi non si ritratta mai.
3) **`sys.shell` chiede sempre**: non è un difetto ma `decide.ts:245` — allow
silenzioso solo se `ctx.hardened`, falso perché `rot/` è dello stesso uid che
gira l'agente. La via è **rendere vera** la modalità hardened (utente di
servizio, `rot/` di un altro uid): sulla VPS si può. Una concessione durevole
contraddirebbe ADR-0003. 4) **Timeout: niente da aggiustare** — `muffin run`
non ha un default (`cli/run.ts:59`), i 90s erano del mio harness; sul filo vale
il default SDK di 10 min, e la guardia «streaming oltre 10 min» non ci tocca
(4096 `max_tokens` contro 21333). 5) **Prompt operativo** (chiedere vs agire,
ripresa dopo un rifiuto), dopo che (1)/(2) danno i log.

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

**Follow-up registrati.** REPL muore su input non-TTY; `doctor` pre-boot dà rimedio sbagliato; composizione N→1 senza assembler;
`possibly_sent` non distingue crash da in-volo; TOCTOU gateway; repl-lock
assente; finestra pairing; Discord `handle()` non bound.

**Truth maintenance:** M5-BIS possiede status Gate e RETURN, PERCORSO §0
l'ordine. A6/A7/A8 e D12/E6: meccanismo in HEAD, BLOCKER solo per i residui
DOGFOOD. `dev` resta privato.
