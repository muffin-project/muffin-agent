# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner (27/08):** un agente *davvero usabile*, rivisto **modulo per
modulo** — loop, memoria, skill, tool, context engine, compacting, comandi,
deep research; ogni pezzo per *come è fatto*. E tutto ciò che manca prima della
VPS.

**Serata del 27/08 (#197 → #211).** Tre cause del «Muffin risponde male»:
`parseJson` accettava solo `{…}`; il reasoning era **spento** sul turno
conversazionale da #167; `.releases` si annidava.

**Notte del 28/08 (#212 → #218).** I tool riprovano, ma solo se dichiarano il
fallimento transitorio **e** la capability è `rerunnable`. Il modello vede le
immagini, solo base64 e mai una sorgente `url`. Uno stop chiesto tiene giù il
gateway anche su macOS. E una textzone vera: riquadro, multilinea, storia.

**Mattina del 28/08 — pilotato il REPL dentro tmux, che rende lo schermo invece
dei byte.** `npm run build` era `tsc --noEmit`: ho letto «ok» e ho misurato il
binario di ieri sera. Il mandato DAY-1 aveva dichiarato questo rischio parola
per parola e non era mai stato soddisfatto. **In volo: PR #219** (build che
costruisce, Ctrl+J che va a capo — Node lo consegna come `enter`, non come
ctrl+j — Tab che nomina i candidati) e **PR #220** (`prompt show --eco`;
persona.md 7.528 → 4.629 byte, prompt owner 23.648 → 20.770). Entrambe con gate
locale dichiarato; il merge è **bloccato dal classificatore**, lo fa l'owner.

**Regola trovata, che morde chi pota il prompt:** `voice.md` va anche ai
gruppi, `identity.md` no. Una frase di voice.md che sta pure in identity.md non
è un doppione — è l'unica copia che la stanza riceve.

**Prossimo, e serve una decisione dell'owner: C8, le note vocali.** La forma è
già scritta (audio originale = Evidence, transcript = derived con la propria
provenance). Manca il trascrittore, e la scelta non è tecnica: whisper.cpp
locale (un binario in più, gratis, la voce non esce di casa) oppure un'API (una
chiave in più, un costo, e la voce dell'owner che esce). Non la prendo io.

**Sulla macchina.** Verificato dopo l'`update` dell'owner: le release sono
sorelle piatte in `.releases/`, **nessun annidamento** da sbrogliare. Dopo #217
servono `muffin update` **e** `muffin gateway install --write --force` (il
plist installato ha ancora il vecchio `KeepAlive: true`).

**Lasciato all'owner:** `pricing.ts` sottostima **5 famiglie su 8** (qwen3:
tabella 0.1/0.3, reale 0.425/2.55) — tocca il tetto sigillato.

**In volo: PR #186** (`slice/undo-riallinea-il-turno`, D11, MERGEABLE).
CRITICAL, due NON-MERGE riparati; il **terzo giudizio non è mai girato** — è il
prossimo passo, non il merge.

**Il tetto di taint.** Dopo un `fs_read` il turno è a 2 e `fs.write` ha
soffitto 1: «leggi, calcola, scrivi» resta rifiutato (#179, 0/9).

**Telegram** (owner): la patch del 13° anniversario aggiunge **pulsanti** e
**documenti inline**. Dalla fonte prima di toccare il connettore.

**Aperto per l'owner:** token bot Telegram; billing CI; chiave Tavily (senza,
`web_search` non si registra).

**CI senza minuti:** merge con gate locale dichiarato in un commento sulla PR.

**Stato macchina:** la cache non prende — 2.8% su 18 chiamate, **0** sul
modello vivo.

**Dogfood:** `sys.shell` chiede sempre (`decide.ts:245`) — allow silenzioso
solo con `ctx.hardened`, falso perché `rot/` ha lo stesso uid dell'agente.

**Follow-up.** ADR «il REPL è un client del gateway?»; socket v2; review dei
peer dove il 429 l'ha fermata; `doctor` pre-boot dà rimedio sbagliato;
`possibly_sent` non distingue crash da in-volo; TOCTOU gateway; ASK durevole.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
