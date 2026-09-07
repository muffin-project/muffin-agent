# Handoff operativo

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da questa lista e non da una feature list di peer.

**Goal owner:** DAY-1 = *«io installo Muffin sulla VPS, quindi deve essere
praticamente pronto»*. Snapshot 07/09 dopo D13: **63/63 righe READY, zero
BLOCKER DAY-1.** Ricostruire sempre da Git/PR/check +
`day1/requirements-status.md` prima di usare il conteggio.

**Come si trovano le cose.** REPL in **tmux**, tracce, log e il `muffin.db`
vero (`sqlite3 <db> ".backup <dest>"`, mai `cp`); processi di prova fermati per
PID. **Il gate è una porta sola:** `npm run merge -- <pr>` (ci:local in Docker,
cinque job; una PR alla volta, host quieto o `DISCARDED`; `gh pr merge` a mano
è bloccato dal hook). I minuti GitHub sono finiti.

## Le decisioni dell'owner

`routing.only: ["alibaba"]`, `dataCollection: "deny"`; ADR-0074 (06/09, «si
chiede solo l'irreversibile, sempre, anche in privato»). Kernel
(ADR-0071/0072): un link citato non chiede, composto+non-owner nega, una ricerca
non chiede mai. Gruppi: senza il suo umano Muffin saluta, avvisa e esce (F4).

07/09: la command surface del normale owner resta piccola — conversazione e
automazione assorbono la meccanica, CLI/TUI per recovery e operatori (#465). È
in `docs/VISION.md` ed è **autoritativa sui criteri**: D15 chiedeva `muffin
effetti` come comando normale, e il criterio è stato corretto dentro la sua
claim. Repository **source-public/pre-alpha appena è sicuro** (#464).

**Azioni owner senza codice:** billing GitHub Actions · `npm run e2e:telegram`
con un bot vero (B11/B13/B2 datati) · la prima install vera su una VPS x86_64
(A11 è provata solo nel container arm64). `rot harden` è fatto (06/09, rot di
uid 0); ADR-0073 ha avuto il sì e ADR-0074 lo estende a ogni stanza.

## Aperto

**F7** è su dev (#462, ADR-0073 punti 1/2/3/5); il punto 4 (ask effimera
all'owner dentro il gruppo) resta aperto, non DAY-1.

**D13 chiusa READY il 07/09** (`tool-use-2026-09-07.md`): zero `ask` in tre
giri puliti; l'unico difetto ripetibile (MCP ignorato per shell) corretto in
`WORK_RULES`, verificato 6/6. Trovato e riparato nello stesso passaggio:
l'eval a modello remoto leggeva il filesystem reale
(`eval-fuga-filesystem-2026-09-07.md`).

**Fase C** (Discord: comandi, coda, approvazioni, transcript, consegna) non è
DAY-1; issue #378. D15 (registro effetti) chiusa il 07/09. Da Centria
restano: revoca con parità dopo la VPS, giudice come sensore versionato,
verifica delle affermazioni negli ADR.

**Dogfood 06-07/09 (installato fe8d55e+):** ADR-0075 su dev (#461, D16 READY);
streaming e file per `(porta, stanza)` (#460; le asserzioni e2e sull'anteprima
aspettano il bot vero). Osservato, non lavorato: 15 s senza segno di vita (il
loop scarta `thinking_delta`/`tool_call_delta`); su «analizzati» il modello ha
misurato una volta e ragionato su un ricordo vecchio (`sys_inspect` senza il
verdetto per capability, la memoria riporta le auto-dichiarazioni come fatti).
Critiche vs peer: `critica-moduli-vs-peer-2026-09-07.md`.

## Audit ecosistema 07/09

`docs/evidence/personal-agent-ecosystem-audit-2026-09-07.md` (#474) è evidence,
**non autorizza feature parity**. Issue **#463** possiede la riconciliazione
(stato reale → audit come evidence → solo le case autoritative davvero stale →
una claim per `/goal`); #464 la pubblicazione sicura; #465 la command surface
piccola. Le issue speculative sono chiuse `not_planned`.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato,
`critical-path.md#ordine-corrente` l'ordine, le Issue il lavoro attribuibile.
`docs/evidence/` conserva ciò che abbiamo osservato/imparato; non possiede la
roadmap.