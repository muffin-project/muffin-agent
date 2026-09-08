# Handoff operativo

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da questa lista e non da una feature list di peer.

**Goal owner:** DAY-1 = *«io installo Muffin sulla VPS»*. 63/63 READY dal
07/09, ma il **primo cutover reale (08/09, `docs/evidence/cutover-2026-09-08.md`)
ha dato `DAY_1_CAN_START: NO`** su 4521f83, per due decisioni owner: (F1)
«dimentica» non ha alcun meccanismo mentre VISION lo dichiara intento
ordinario; (F2) ZDR è requisito owner e la config di produzione non lo
soddisfa (`only: alibaba` non-ZDR, `qwen3.7-flash` senza endpoint ZDR). Prima,
meccanico dentro A11: (F3) `install.sh` non persiste il PATH del suo Node e da
`su -` il gateway non parte.

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
con un bot vero (non rieseguita a 4521f83) · scelta modello/provider ZDR · VPS
Hetzner rifatta (x86_64, utente `muffin`, deploy key read-only): install
arrivata a `init`, gateway e sandbox a mano come in `cutover-2026-09-08.md`.
Mac a 4521f83, memoria al backup pre-prova. `rot harden` fatto (06/09).

## Aperto

**F7** è su dev (#462, ADR-0073 punti 1/2/3/5); il punto 4 (ask effimera
all'owner dentro il gruppo) resta aperto, non DAY-1.

**D13 chiusa READY il 07/09** (`tool-use-2026-09-07.md`): zero `ask` in tre
giri puliti; l'unico difetto ripetibile (MCP ignorato per shell) corretto in
`WORK_RULES`, verificato 6/6. Trovato e riparato nello stesso passaggio:
l'eval a modello remoto leggeva il filesystem reale
(`eval-fuga-filesystem-2026-09-07.md`).

**Fase C** (Discord: comandi, coda, approvazioni, consegna) non è DAY-1;
issue #378. D15 chiusa il 07/09. Da Centria: revoca con parità dopo la VPS,
giudice come sensore versionato, verifica delle affermazioni negli ADR.

**Dogfood 06-07/09:** ADR-0075 su dev (#461, D16 READY); streaming e file per
`(porta, stanza)` (#460). Osservato, non lavorato: 15 s senza segno di vita
(`thinking_delta`/`tool_call_delta` scartati); `sys_inspect` senza verdetto per
capability. Critiche vs peer: `critica-moduli-vs-peer-2026-09-07.md`.

## Audit ecosistema 07/09

`docs/evidence/personal-agent-ecosystem-audit-2026-09-07.md` (#474) è evidence,
**non autorizza feature parity**. Issue #463 possiede la riconciliazione, #464
la pubblicazione sicura, #465 la command surface piccola.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato,
`critical-path.md#ordine-corrente` l'ordine, le Issue il lavoro attribuibile.
`docs/evidence/` conserva ciò che abbiamo osservato/imparato; non possiede la
roadmap.