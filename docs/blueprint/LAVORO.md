# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa da rimandare o da
un rischio su authority/data/effect. Non da questa lista.

**Aperto per l'owner:** token bot Telegram; billing CI; **promozione `dev` →
`main`** — l'installazione viva gira su `main`, 44 commit indietro, e `update`
legge `origin/main`: dice «già aggiornato» mentre l'agente non ha #133–#149.

**CI senza minuti:** merge con gate locale dichiarato in un commento sulla PR.
Rosso in 2s con zero step = fatturazione. Se anche `mergeable` resta `null`
(successo), si verifica a mano — `git merge-base --is-ancestor origin/dev HEAD`
— e si dichiara.

## Audit dell'installazione viva (27/08)

Il giro base funziona: `muffin run` risponde in 4.7s, gateway e RoT sani.

**La corsia della memoria era morta dal 25/08**, il giorno del cambio modello
(sonnet-5 → `qwen/qwen3.8-27b`). Causa misurata: `stop=max_tokens · 1502 token
in uscita` — il tetto di 1500 speso a ragionare senza scrivere un carattere di
JSON. Chiuso da #148 (`REASONING_HEADROOM`): `facts` 16 → 17, il primo dal 16
agosto. `doctor` era **verde** su due dei tre giri morti (#147) e diceva
`vector index in sync` con l'embedder giù da due giorni (#149).

**Resta da fare, con le prove già in mano:**

1. **Schema intollerante** (prossima slice): il modello piccolo risponde
   `expected number, received string` e `subjectKind` fuori enum — episodi che
   ora arrivano fino allo schema e muoiono lì.
2. **`supervisione: nessun supervisore`** (`cli/gateway.ts:558`) è un controllo
   solo-systemd stampato ovunque: su macOS contraddice `doctor`.
3. `--version` → `0.0.0`; `memory.rerank` senza span (l'estrazione ce l'ha da
   #148); l'adapter openai-compat non legge il reasoning, quindi quei token si
   pagano e il testo si perde — la via vera per (1) e per il tetto.

Chiuso da #151: la unit inchiodava la directory Cellar di Homebrew, che
l'upgrade cancella (`dirname(process.execPath)` risolve i symlink). Ora prende
la prima directory del PATH il cui `node` porta allo stesso interprete.

**Misurato prima.** La cache non prende — 2.8% su 18 chiamate, **0** sul
modello vivo (`research/cache-prompt-2026-08-26.md`). Il prompt vivo è del 9
agosto (11498 caratteri contro 22477); da #142 `doctor` lo vede.

**Delle quattro lamentele dogfood ne resta una:** `sys.shell` chiede sempre
(`decide.ts:245`) — allow silenzioso solo se `ctx.hardened`, falso perché
`rot/` è dello stesso uid dell'agente. La via è rendere **vera** la modalità
hardened (utente di servizio, `rot/` di un altro uid): sulla VPS si può, il
meccanismo c'è da #138. Una concessione durevole contraddirebbe ADR-0003.

**Non riaprire.** `muffin run` non ha timeout di default (`cli/run.ts:59`).

**Da non riperdere.** (a) `init` fa le domande di #117 **solo su TTY**, mai
testato (via: pty con `script`). (b) `gateway install` **stampa** i comandi del
supervisore, non li esegue. (c) E7: a «che modello usi?» non lo sa. (d)
`inputSchema` non valida niente e `types.ts` promette il contrario. (e) Le
ancore verificano **solo il primo intervallo** di `file:A-B,C-D`.

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
