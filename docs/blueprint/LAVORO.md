# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner (27/08), sostituisce «DAY-1 READY» come criterio di selezione:**
un agente *davvero usabile*, non un chatbot, rivisto **modulo per modulo** —
loop, memoria testata, skill di base, tool call/list ben promptate, context
engine, compacting smart, comandi decenti, deep research. Ogni pezzo va
guardato per *come è stato fatto*, non solo per se passa. Design agentici,
paper, docs e peer; documentare. Riferimento owner: Hermes.

**`fs_write` scrive** (`slice/undo-journal`, D2+D3 READY): `draft` non è più un
rifiuto ma «prima la copia, poi l'effetto», il file da fotografare lo dichiara
il tool (`resolveEffectPath`), e `muffin undo` lo rimette — anche l'undo è
reversibile. 6 mutazioni uccise, D2/D3 verdi sul binario vero.

**Prossima claim: `slice/undo-riallinea-il-turno`** (D11, l'altra metà).
`muffin undo` rimette il filesystem e non tocca turno/sessione: dopo un undo la
cronologia dice ancora «ho scritto nuovo.txt» e il modello ci crede.

**Dopo: il tetto di taint.** Dopo un `fs_read` il turno è a 2 e `fs.write` ha
soffitto 1, quindi «leggi, calcola, scrivi» resta rifiutato (#179, 0/9
misurato). ADR-0044 dichiarò il costo per `sys.shell` e liquidò `fs.write` come
gratis «perché già morto». Non lo è più.

**Aperto per l'owner:** token bot Telegram; billing CI; **promozione `dev` →
`main`, PR #163 pronta in draft** — è l'unica cosa che PERCORSO §0 lascia aperta
(«resta l'installazione reale»). Nessuna migrazione nuova: `dev` è a schema 3
come il DB vivo, quindi la promozione non tocca i dati. Non la mergio io.

**CI senza minuti:** merge con gate locale dichiarato in un commento sulla PR.
Rosso in 2s con zero step = fatturazione. Con `mergeable` a `null` si verifica
a mano (`git merge-base --is-ancestor origin/dev HEAD`) e si dichiara.

**Stato macchina, non codice:** l'embedder è giù (ollama non gira) — niente
viene indicizzato, il recall è solo testuale. La cache non prende: 2.8% su 18
chiamate, **0** sul modello vivo (`research/cache-prompt-2026-08-26.md`).

**Dogfood, ne resta una:** `sys.shell` chiede sempre (`decide.ts:245`) — allow
silenzioso solo con `ctx.hardened`, falso perché `rot/` ha lo stesso uid
dell'agente. La via è rendere **vera** quella modalità (utente di servizio, uid
diverso): sulla VPS si può, il meccanismo c'è da #138. Una concessione durevole
contraddirebbe ADR-0003.

**Non riaprire.** `muffin run` non ha timeout di default (`cli/run.ts:59`). Il
tetto tool è 14 (owner, 27/08): un numero senza misura, come lo era 10, e
misurato non è il vincolo (#179). La risposta strutturale è la tool search.

**Da non riperdere.** (a) Le ancore verificano solo il primo intervallo di
`file:A-B,C-D`. (b) Il ramo util-linux di `script` in `cli/main.test.ts` è
scritto e mai eseguito (qui c'è solo BSD, ed è Linux la produzione).
(c) `inputSchema` e lo zod dell'handler restano due copie: `z.toJSONSchema`
le unificherebbe ma cambia i byte del prompt di ogni tool.

**Design da non riscoprire:** THESIS §5 e ADR-0027 (le lezioni di Claude si
trasferiscono SELETTIVAMENTE).

**Coda owner:** ASK durevole; compaction validata (arxiv 2605.08580); dedup
gateway/repl.

**Follow-up.** REPL muore su input non-TTY; `doctor` pre-boot dà rimedio
sbagliato; composizione N→1 senza assembler; `possibly_sent` non distingue
crash da in-volo; TOCTOU gateway; repl-lock assente; finestra pairing; Discord
`handle()` non bound; un 429 persistente spegne il progresso; `runDoctor` in
`cli/` raggiunto da `agent/` con import dinamico.

**Truth maintenance:** M5-BIS possiede status Gate/RETURN, PERCORSO §0
l'ordine. `dev` resta privato.
