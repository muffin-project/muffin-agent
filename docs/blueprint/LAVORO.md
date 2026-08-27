# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da questa lista.

**`fs_write` scrive** — PR #182 (D2+D3 READY, mezza D11): `draft` è «prima la
copia, poi l'effetto», e `muffin undo` la rimette. Resta l'altra metà di D11
(`slice/undo-riallinea-il-turno`): l'undo non tocca turno/sessione, quindi la
cronologia dice ancora «ho scritto» e il modello ci crede.

**Dopo: il tetto di taint.** Dopo un `fs_read` il turno è a 2 e `fs.write` ha
soffitto 1: «leggi, calcola, scrivi» resta rifiutato (#179, 0/9). ADR-0044
dichiarò quel costo per `sys.shell` e liquidò `fs.write` come gratis «perché già
morto». Non lo è più.

**Aperto per l'owner:** token bot Telegram; billing CI; **promozione `dev` →
`main`, PR #163 in draft** — l'unica cosa che PERCORSO §0 lascia aperta.
Nessuna migrazione nuova: `dev` è a schema 3 come il DB vivo. Non la mergio io.

**CI senza minuti:** merge con gate locale dichiarato in un commento sulla PR.
Rosso in 2s con zero step = fatturazione. Con `mergeable` a `null`:
`git merge-base --is-ancestor origin/dev HEAD`, e si dichiara.

**Goal owner (27/08), sostituisce «DAY-1 READY» come criterio di scelta:** un
agente *davvero usabile*, non un chatbot, rivisto **modulo per modulo** — loop,
memoria testata, skill, tool call/list ben promptate, context engine,
compacting, comandi, deep research. Ogni pezzo si guarda per *come è fatto*,
non solo per se passa. Design agentici, paper, docs, peer; documentare.

**Modulo Telegram, da verificare** (owner, 27/08): la patch del 13° anniversario
aggiunge **pulsanti dentro i messaggi** e **documenti inline**
(`telegram.org/blog/welcome-messages-buttons-TG-13`). Dalla fonte prima di
toccare il connettore: cambia cosa Muffin può offrire lì, non come formatta.

**Skill: `defaults/skills/` spedisce due skill** (`slice/skill-di-serie`, D9),
`init` le semina. Trovato misurando: il recinto prendeva un nonce nuovo a ogni
chiamata, quindi il system prompt era **diverso a ogni processo** e la cache non
poteva prendere. Nonce ora per-installazione (`core/skills/nonce.ts`).

**Audit del 27/08, chiuso** (#147→#180). **Resta: l'embedder è giù** sulla
macchina dell'owner (ollama non gira) — niente viene indicizzato, il recall è
solo testuale. Stato della macchina. La cache non prende: 2.8% su 18 chiamate,
**0** sul modello vivo (`research/cache-prompt-2026-08-26.md`).

**Dogfood, ne resta una:** `sys.shell` chiede sempre (`decide.ts:245`) — allow
silenzioso solo con `ctx.hardened`, falso perché `rot/` ha lo stesso uid
dell'agente. La via è rendere **vera** quella modalità (utente di servizio, uid
diverso): sulla VPS si può, il meccanismo c'è da #138.

**Non riaprire.** `muffin run` non ha timeout di default (`cli/run.ts:59`); il
tetto tool è 14 (owner, 27/08) e non è il vincolo (#179).

**Da non riperdere.** Le ancore verificano solo il primo intervallo di
`file:A-B,C-D`; il ramo util-linux di `script` in `cli/main.test.ts` non è mai
eseguito qui (produzione è Linux); `inputSchema` e lo zod dell'handler sono due
copie. **Design:** THESIS §5 e ADR-0027 (le lezioni di Claude si trasferiscono
SELETTIVAMENTE).

**Coda owner:** ASK durevole; compaction validata (arxiv 2605.08580); dedup
gateway/repl.

**Follow-up.** REPL su input non-TTY; `doctor` pre-boot dà rimedio sbagliato;
N→1 senza assembler; `possibly_sent` non distingue crash da in-volo; TOCTOU
gateway; repl-lock; finestra pairing; Discord `handle()` non bound; un 429
persistente spegne il progresso; `runDoctor` in `cli/`; **`web_search` non è
registrato senza chiave Tavily** — niente deep research di serie.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
