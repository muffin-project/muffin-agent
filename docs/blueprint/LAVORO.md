# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner (27/08), sostituisce «DAY-1 READY» come criterio di scelta:** un
agente *davvero usabile*, non un chatbot, rivisto **modulo per modulo** — loop,
memoria, skill, tool, context engine, compacting, comandi, deep research; ogni
pezzo per *come è fatto*, non per se passa. E **tutto ciò che manca prima di
installare sulla VPS.**

**`fs_write` scrive** (#182): `draft` è «prima la copia, poi l'effetto», il file
lo dichiara il tool (`resolveEffectPath`) e viaggia con la chiamata
(`ToolContext.effectPath`). D2/D3 READY.

**Prossima claim: `slice/undo-riallinea-il-turno`** (D11, l'altra metà): l'undo
rimette il filesystem e non tocca turno/sessione, quindi la cronologia dice
ancora «ho scritto» e il modello ci crede.

**Dopo: il tetto di taint.** Dopo un `fs_read` il turno è a 2 e `fs.write` ha
soffitto 1: «leggi, calcola, scrivi» resta rifiutato (#179, 0/9). ADR-0044
dichiarò quel costo per `sys.shell` e liquidò `fs.write` come gratis «perché già
morto»: non lo è più.

**Linux, misurato il 27/08 in container** (29/31; i 2 rossi sono verdi su
macOS). (a) `gate-linux.sh` dà un **rosso falso**: `bwrap` non monta `/proc`
dentro Docker (né con `SYS_ADMIN`, né con `systempaths=unconfined`), e bwrap
grezzo lì funziona — non è Muffin. (b) Il rimedio di `probe.ts` dice
«bubblewrap and socat», ma serve **anche ripgrep**. (c) Il gate usa `git
archive`: senza `.git`, `doctor` dà 9 warning di deriva e A10 va rosso per
quello. (d) L'installazione globale dal sorgente muore su `tsc: not found`;
clone + dipendenze + compile + link **funziona**, e non è documentato.

**Modulo Telegram, da verificare** (owner, 27/08): la patch del 13° anniversario
aggiunge **pulsanti nei messaggi** e **documenti inline**
(`telegram.org/blog/welcome-messages-buttons-TG-13`). Dalla fonte prima di
toccare il connettore: cambia cosa Muffin può offrire lì.

**Aperto per l'owner:** token bot Telegram; billing CI; **promozione `dev` →
`main`, PR #163 in draft** — l'unica cosa che PERCORSO §0 lascia aperta, e
`dev` è a schema 3 come il DB vivo. Non la mergio io.

**CI senza minuti:** merge con gate locale dichiarato in un commento sulla PR;
rosso in 2s con zero step = fatturazione. Con `mergeable` a `null`:
`git merge-base --is-ancestor origin/dev HEAD`.

**Stato macchina, non codice:** l'embedder è giù (ollama non gira), quindi il
recall è solo testuale. La cache non prende: 2.8% su 18 chiamate, **0** sul
modello vivo (`research/cache-prompt-2026-08-26.md`).

**Dogfood, ne resta una:** `sys.shell` chiede sempre (`decide.ts:245`): allow
silenzioso solo con `ctx.hardened`, falso perché `rot/` ha lo stesso uid
dell'agente. Renderla **vera** sulla VPS si può: il meccanismo c'è da #138.

**Non riaprire.** `muffin run` non ha timeout di default; il tetto tool è 14
(owner, 27/08) e non è il vincolo (#179).

**Da non riperdere.** Le ancore verificano solo il primo intervallo di
`file:A-B,C-D`; `resolved?` in `fsWrite` non è un tipo legato a
`resolveInScope`; `inputSchema` e lo zod dell'handler sono due copie.
**Design:** THESIS §5 e ADR-0027 (le lezioni di Claude si trasferiscono
SELETTIVAMENTE).

**Follow-up.** REPL su input non-TTY; `doctor` pre-boot dà rimedio sbagliato;
N→1 senza assembler; `possibly_sent` non distingue crash da in-volo; TOCTOU
gateway; repl-lock; finestra pairing; Discord `handle()` non bound; un 429
persistente spegne il progresso; ASK durevole; compaction validata (arxiv
2605.08580); **`web_search` non è registrato senza chiave Tavily** — niente
deep research di serie.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
