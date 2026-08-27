# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner (27/08):** un agente *davvero usabile*, rivisto **modulo per
modulo** — loop, memoria, skill, tool, context engine, compacting, comandi,
deep research; ogni pezzo per *come è fatto*. E tutto ciò che manca prima della
VPS.

**Serata del 27/08 (#197 → #208), su `main`.** Da un failure osservato. Tre
cause misurate: `parseJson` accettava solo `{…}`, quindi un `[]` era un errore
di estrazione **permanente**; il reasoning era **spento** sul turno
conversazionale da #167 (ora `adaptive`, `/think` lo commuta); `.releases` si
annidava a ogni update (`--show-toplevel` risponde col worktree *corrente*, e
una release È un worktree). Ne sono usciti `muffin model|search|adopt`, il
fallback dell'embedder, il socket di controllo (v1, sola osservazione), e una
cornice per ogni comando (`cli/ui.ts`, `cli/STYLES.md`).

**Sulla macchina, prima di toccarla.** L'annidamento `.releases` già esistente
va sbrogliato **a gateway fermo** (il launcher punta lì dentro), e il
*prossimo* update gira ancora il codice vecchio: cade giusto quello dopo.

**Lasciato all'owner:** `core/budget/pricing.ts` sottostima **cinque famiglie su
otto** (qwen3: tabella 0.1/0.3, reale 0.425/2.55). La conseguenza è sul tetto
sigillato, quindi i numeri li mette lui.

**In volo: PR #186** (`slice/undo-riallinea-il-turno`, D11, MERGEABLE).
CRITICAL, due NON-MERGE riparati; il **terzo giudizio non è mai girato** — è il
prossimo passo, non il merge.

**Dopo: il tetto di taint.** Dopo un `fs_read` il turno è a 2 e `fs.write` ha
soffitto 1: «leggi, calcola, scrivi» resta rifiutato (#179, 0/9). ADR-0044
dichiarò quel costo per `sys.shell` e liquidò `fs.write` come gratis «perché già
morto»: non lo è più.

**Chiuso, non riaprire.** Linux (#184, #189). `fs_write` scrive (#182), D2/D3
READY. `muffin run` non ha timeout di default; il tetto tool è 14 (#179).

**Modulo Telegram, da verificare** (owner, 27/08): la patch del 13° anniversario
aggiunge **pulsanti** e **documenti inline**
(`telegram.org/blog/welcome-messages-buttons-TG-13`). Dalla fonte prima di
toccare il connettore.

**Aperto per l'owner:** token bot Telegram; billing CI; chiave Tavily (il
meccanismo c'è da #199, `web_search` non si registra senza).

**CI senza minuti:** merge con gate locale dichiarato in un commento sulla PR;
rosso in 2s con zero step = fatturazione. Con `mergeable` a `null`:
`git merge-base --is-ancestor origin/dev HEAD`.

**Stato macchina, non codice:** ollama non gira (da #185 l'embedder è config).
La cache non prende: 2.8% su 18 chiamate, **0** sul modello vivo
(`research/cache-prompt-2026-08-26.md`).

**Dogfood, ne resta una:** `sys.shell` chiede sempre (`decide.ts:245`): allow
silenzioso solo con `ctx.hardened`, falso perché `rot/` ha lo stesso uid
dell'agente. Renderla **vera** sulla VPS si può: il meccanismo c'è da #138.

**Da non riperdere.** Le ancore verificano solo il primo intervallo di
`file:A-B,C-D`; `inputSchema` e lo zod dell'handler sono due copie.

**Follow-up.** Verifica di forma dopo il flip di `update`; ADR su «il REPL è un
client del gateway?»; socket v2 (liveness dal pidfile al socket); riprendere la
review dei peer dove il 429 l'ha fermata; input multilinea nel REPL
(`tui-2026-08-27.md` raccomanda di **rimandare**); REPL su input non-TTY;
`doctor` pre-boot dà rimedio sbagliato; `possibly_sent` non distingue crash da
in-volo; TOCTOU gateway; repl-lock; finestra pairing; ASK durevole.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
