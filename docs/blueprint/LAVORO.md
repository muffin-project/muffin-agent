# Lavoro corrente

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect. Non da questa lista.

**Goal owner:** un agente *davvero usabile*, rivisto modulo per modulo, e tutto
ciò che manca prima della VPS.

**Come si trovano le cose.** Le slice degli ultimi giorni non sono nate leggendo
il codice: sono nate pilotando il REPL vero dentro **tmux** (`capture-pane` rende
lo schermo; `script` registra i byte e fa concludere il falso), o misurando su
tracce, WAL e sul `muffin.db` vero.

**Il gate.** `npm run gate:local`: clone di HEAD **fuori** dal repository,
`npm ci`, typecheck, build fresh, suite host, accettazione host, e
`evals/acceptance/gate-linux.sh` in Docker. Il verde si scrive
`LOCAL-GATE PASS @ <sha>` e **mai** «CI verde» — GitHub Actions è senza crediti e
questo gira sulla macchina dell'owner. Il clone serve perché la suite lanciata a
mano raccoglieva 945 file dove il repository ne ha 201: `.releases/` (402) e
`.codex/worktrees/` (342) sono invisibili a `git status` e non a vitest.

## Le tre decisioni aperte, tutte dell'owner

1. **Instradamento** (`config.provider.routing`). Oggi 0% di cache: OpenRouter
   manda al più economico dei 12 provider, che non onora i breakpoint. Con
   `only: ["alibaba"]` la cache prende il 95% dal secondo turno e costa **meno**
   (~$0.0009 contro ~$0.0031 a turno). Ma è cinese, e `dataCollection: "deny"`
   non l'ha mai deciso nessuno: oggi `identity.md` e i ricordi vanno a chi costa
   meno, senza vincoli su chi può tenerseli.
2. **`muffin rot harden`** — serve `sudo`, e da lì i reseal servono `sudo`.
   Finché non è fatto, `sys.shell` chiede **sempre** conferma.
3. **C8, note vocali**: whisper.cpp locale o un'API. Decide se la voce dell'owner
   esce di casa.

## Cosa manca per usarlo davvero

`surfaces.enabled = ["cli"]`, un solo segreto. Servono, dall'owner: **token bot
Telegram** (senza, niente telefono), **chiave Tavily** (senza, `web_search` non
si registra), **billing CI**.

## PR aperte

Una sola: **#186** (undo riallinea il turno). 141 commit indietro, 5 conflitti —
SALVAGE, non merge. Il lineage che portava è rientrato con #253; **resta da
decidere la sua altra metà**: `muffin undo` oggi lascia la memoria a dire «ho
scritto»? Se sì è una slice nuova su `dev`, non un rebase. Il non-committato di
quel worktree è salvato in `codex/pr186-safe-legacy` (bae1a40).

## Aperto, non bloccante

**Prossimo grosso:** dichiarare i **permessi** nel prompt. Oggi il kernel rifiuta
alla chiamata e il modello impara per rifiuto — incluso il tetto di taint, per
cui «leggi, calcola, scrivi» è rifiutato *sempre* senza che nessuno gli dica
perché. Codex rende `<permission_profile>`, OpenClaw `## Authorized Senders`. Va
nella coda volatile: il taint cambia dentro il turno.

**Poi:** memory health osservabile — embedder disponibile o no, modalità
lexical/hybrid/vector, arretrato dei vettori, fallimenti del giudice. Il fallback
non va nascosto: oggi un embedder assente degrada il recall a lessicale e non lo
dice a nessuno.

**Altro:** community è solo una forma di stringa (`community:${slug}`), promessa
nel tipo e non capability; `pricing.ts` sottostima 5 famiglie su 8; socket v2;
`possibly_sent` non distingue crash da in-volo.

**Truth maintenance:** M5-BIS possiede status Gate, PERCORSO §0 l'ordine.
`STATE.md` è cronologia, non stato corrente.
