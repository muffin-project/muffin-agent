# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner (27/08):** un agente *davvero usabile*, rivisto **modulo per
modulo** — loop, memoria, skill, tool, context engine, compacting, comandi,
deep research; ogni pezzo per *come è fatto*. E tutto ciò che manca prima della
VPS.

**Serata del 27/08 (#197 → #211).** Tre cause misurate del «Muffin risponde
male»: `parseJson` accettava solo `{…}`; il reasoning era **spento** sul turno
conversazionale da #167; `.releases` si annidava a ogni update. Ne sono usciti
`muffin model|search|adopt`, il fallback dell'embedder, il socket di controllo
(v1) e una cornice per ogni comando.

**Notte del 28/08 (#212 → #215).** B6: i tool riprovano, ma solo se il tool
dichiara il fallimento transitorio **e** la capability è `rerunnable` — è
l'unica cosa fra un retry e un effetto raddoppiato. B10: il modello vede le
immagini (`--image` su `run`; una foto Telegram arriva al turno invece di
diventare «non indicizzato»), solo base64 e mai una sorgente `url`, che sarebbe
un'uscita di rete invisibile al kernel. E `init` non resta più appeso su un
Ctrl+D quando le domande sono due.

**Prossimo, e serve una decisione dell'owner: C8, le note vocali.** La forma è
già scritta (audio originale = Evidence, transcript = derived con la propria
provenance). Manca il trascrittore, e la scelta non è tecnica: whisper.cpp
locale (un binario in più, gratis, la voce non esce di casa) oppure un'API (una
chiave in più, un costo, e la voce dell'owner che esce). Non la prendo io.

**Sulla macchina, prima di toccarla.** L'annidamento `.releases` già esistente
va sbrogliato **a gateway fermo** (il launcher punta lì dentro), e il
*prossimo* update gira ancora il codice vecchio: cade giusto quello dopo.

**Lasciato all'owner:** `pricing.ts` sottostima **5 famiglie su 8** (qwen3:
tabella 0.1/0.3, reale 0.425/2.55) — tocca il tetto sigillato.

**In volo: PR #186** (`slice/undo-riallinea-il-turno`, D11, MERGEABLE).
CRITICAL, due NON-MERGE riparati; il **terzo giudizio non è mai girato** — è il
prossimo passo, non il merge.

**Il tetto di taint.** Dopo un `fs_read` il turno è a 2 e `fs.write` ha
soffitto 1: «leggi, calcola, scrivi» resta rifiutato (#179, 0/9). ADR-0044
dichiarò quel costo per `sys.shell` e liquidò `fs.write` come già morto: non lo
è più.

**Telegram, da verificare** (owner): la patch del 13° anniversario aggiunge
**pulsanti** e **documenti inline**
(`telegram.org/blog/welcome-messages-buttons-TG-13`). Dalla fonte prima di
toccare il connettore.

**Aperto per l'owner:** token bot Telegram; billing CI; chiave Tavily (il
meccanismo c'è da #199, `web_search` non si registra senza).

**CI senza minuti:** merge con gate locale dichiarato in un commento sulla PR;
rosso in 2s con zero step = fatturazione.

**Stato macchina:** la cache non prende — 2.8% su 18 chiamate, **0** sul
modello vivo (`research/cache-prompt-2026-08-26.md`).

**Dogfood:** `sys.shell` chiede sempre (`decide.ts:245`) — allow silenzioso
solo con `ctx.hardened`, falso perché `rot/` ha lo stesso uid dell'agente.
Renderlo vero sulla VPS si può: il meccanismo c'è da #138.

**Follow-up.** Verifica di forma dopo il flip di `update`; ADR su «il REPL è un
client del gateway?»; socket v2 (liveness dal pidfile al socket); riprendere la
review dei peer dove il 429 l'ha fermata; input multilinea nel REPL
(`tui-2026-08-27.md` raccomanda di **rimandare**); REPL su input non-TTY;
`doctor` pre-boot dà rimedio sbagliato; `possibly_sent` non distingue crash da
in-volo; TOCTOU gateway; repl-lock; finestra pairing; ASK durevole.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
