# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Aperto per l'owner:** token bot Telegram; billing CI; **promozione `dev` →
`main`, PR #163 pronta in draft** — è l'unica cosa che PERCORSO §0 lascia aperta
(«resta l'installazione reale»). Nessuna migrazione nuova: `dev` è a schema 3
come il DB vivo, quindi la promozione non tocca i dati. Non la mergio io.

**CI senza minuti:** merge con gate locale dichiarato in un commento sulla PR.
Rosso in 2s con zero step = fatturazione. Se anche `mergeable` resta `null`
(successo), si verifica a mano — `git merge-base --is-ancestor origin/dev HEAD`
— e si dichiara.

## Audit dell'installazione viva (27/08)

Il giro base funziona: `muffin run` risponde in 4.7s, gateway e RoT sani.

**Chiuso dall'audit** (#147→#174, storia in `docs/lessons.md` e nei commit):
la corsia della memoria morta dal cambio modello (`facts` 16 → **30**), gli
strumenti che mentivano mentre succedeva, `thinking:"off"` portato davvero
(**204 → 85** token), `install --start`, Ctrl+D che usciva 13 senza scrivere
niente, `fs_write` che troncava un file quando il modello scordava `content`.

**Resta aperto qui: l'embedder è giù** sulla macchina dell'owner (ollama non
gira). Da #149 `doctor` lo dice, ma finché resta giù niente di nuovo viene
indicizzato e il recall è solo testuale. Stato della macchina, non del codice.

**Misurato prima.** La cache non prende — 2.8% su 18 chiamate, **0** sul
modello vivo (`research/cache-prompt-2026-08-26.md`). Il prompt vivo è del 9
agosto (11498 contro 22477 caratteri); da #142 `doctor` lo vede.

**Delle quattro lamentele dogfood ne resta una:** `sys.shell` chiede sempre
(`decide.ts:245`) — allow silenzioso solo con `ctx.hardened`, falso perché
`rot/` è dello stesso uid dell'agente. La via è rendere **vera** quella
modalità (utente di servizio, `rot/` di un altro uid): sulla VPS si può, il
meccanismo c'è da #138. Una concessione durevole contraddirebbe ADR-0003.

**Non riaprire.** `muffin run` non ha timeout di default (`cli/run.ts:59`).

**Da non riperdere.** (a) E7: a «che modello usi?» non lo sa. (b) Le ancore
verificano solo il primo intervallo di `file:A-B,C-D`. (c) Il ramo util-linux
di `script` in `cli/main.test.ts` è scritto e mai eseguito: qui c'è solo il
BSD, ed è Linux la produzione. (d) `inputSchema` e lo zod dell'handler restano
due copie: `z.toJSONSchema` (zod 4.4.3, già in albero) genererebbe la prima
dalla seconda, ma cambia i byte del prompt di ogni tool — cache compresa.

**Design da non riscoprire:** THESIS §5 e ADR-0027 (le lezioni di Claude si
trasferiscono SELETTIVAMENTE: non è lo stesso prodotto).

**Coda owner:** ASK durevole; avanzamento con validazione della compaction
(arxiv 2605.08580); dedup gateway/repl.

**Follow-up.** REPL muore su input non-TTY; `doctor` pre-boot dà rimedio
sbagliato; composizione N→1 senza assembler; `possibly_sent` non distingue
crash da in-volo; TOCTOU gateway; repl-lock assente; finestra pairing; Discord
`handle()` non bound; un 429 persistente spegne il progresso.

**Truth maintenance:** M5-BIS possiede status Gate/RETURN, PERCORSO §0
l'ordine. `dev` resta privato.
