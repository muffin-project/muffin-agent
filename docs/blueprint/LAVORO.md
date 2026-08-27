# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Il prossimo lavoro vero: `slice/undo-journal`** (D2+D3+D11, forma decisa in
M5-BIS §1). `fs_write` non scrive **in nessun caso**: `draft` è ineseguibile
senza registro di undo (#180), e il modello se lo vede offerto lo stesso. Il
ramo `draft` ora ha due test che diventeranno rossi quando atterra.

**Dopo, non prima: il tetto di taint.** Dopo un `fs_read` il turno è a 2 e
`fs.write` ha soffitto 1, quindi «leggi, calcola, scrivi» resta rotto anche col
journal (#179, 0/9 misurato). ADR-0044 dichiarò il costo e chiese il sì
dell'owner **per `sys.shell`**, non per `fs.write` — liquidato come gratis
perché già morto. Non lo è più quando il journal atterra.

**Aperto per l'owner:** token bot Telegram; billing CI; **promozione `dev` →
`main`, PR #163 pronta in draft** — è l'unica cosa che PERCORSO §0 lascia aperta
(«resta l'installazione reale»). Nessuna migrazione nuova: `dev` è a schema 3
come il DB vivo, quindi la promozione non tocca i dati. Non la mergio io.

**CI senza minuti:** merge con gate locale dichiarato in un commento sulla PR.
Rosso in 2s con zero step = fatturazione. Se anche `mergeable` resta `null`
(successo), si verifica a mano — `git merge-base --is-ancestor origin/dev HEAD`
— e si dichiara.

**Audit del 27/08, chiuso** (#147→#180, storia nei commit e in
`docs/lessons.md`). Il giro base funziona. **Resta aperto: l'embedder è giù**
sulla macchina dell'owner (ollama non gira) — `doctor` lo dice da #149, ma
finché resta giù niente viene indicizzato e il recall è solo testuale. Stato
della macchina, non del codice.

**Misurato prima.** La cache non prende — 2.8% su 18 chiamate, **0** sul
modello vivo (`research/cache-prompt-2026-08-26.md`); da #142 `doctor` vede il
prompt vivo vecchio di due settimane.

**Delle quattro lamentele dogfood ne resta una:** `sys.shell` chiede sempre
(`decide.ts:245`) — allow silenzioso solo con `ctx.hardened`, falso perché
`rot/` è dello stesso uid dell'agente. La via è rendere **vera** quella
modalità (utente di servizio, `rot/` di un altro uid): sulla VPS si può, il
meccanismo c'è da #138. Una concessione durevole contraddirebbe ADR-0003.

**Non riaprire.** `muffin run` non ha timeout di default (`cli/run.ts:59`). Il
tetto tool è 14 (owner, 27/08): un numero senza misura, come lo era 10, e
misurato non è il vincolo (#179). La risposta strutturale è la tool search.

**Da non riperdere.** (a) Le ancore verificano solo il primo intervallo di
`file:A-B,C-D`. (b) Il ramo util-linux
di `script` in `cli/main.test.ts` è scritto e mai eseguito: qui c'è solo il
BSD, ed è Linux la produzione. (c) `inputSchema` e lo zod dell'handler restano
due copie: `z.toJSONSchema` (zod 4.4.3, già in albero) genererebbe la prima
dalla seconda, ma cambia i byte del prompt di ogni tool — cache compresa.

**Design da non riscoprire:** THESIS §5 e ADR-0027 (le lezioni di Claude si
trasferiscono SELETTIVAMENTE: non è lo stesso prodotto).

**Coda owner:** ASK durevole; avanzamento con validazione della compaction
(arxiv 2605.08580); dedup gateway/repl.

**Follow-up.** REPL muore su input non-TTY; `doctor` pre-boot dà rimedio
sbagliato; composizione N→1 senza assembler; `possibly_sent` non distingue
crash da in-volo; TOCTOU gateway; repl-lock assente; finestra pairing; Discord
`handle()` non bound; un 429 persistente spegne il progresso; `runDoctor` sta
in `cli/` e `agent/` lo raggiunge con un import dinamico (debito di layering).

**Truth maintenance:** M5-BIS possiede status Gate/RETURN, PERCORSO §0
l'ordine. `dev` resta privato.
