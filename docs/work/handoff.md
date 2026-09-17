# Handoff operativo

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da questa lista e non da una feature list di peer.

**Goal owner:** DAY-1 = *«io installo Muffin sulla VPS»*. Il cutover reale
dell'08/09 (`docs/evidence/cutover-2026-09-08.md`) ha chiuso «dimentica»
(#484/#486, provato in REPL viva) e i difetti dell'installer trovati sulla VPS
(#485), e ha rieseguito la corsia Telegram vera (#487). Secondo verdetto del
reviewer fresco su 2efe207: **`DAY_1_CAN_START: NO` per un solo residuo, ZDR**,
che è una decisione owner — il light `qwen3.7-flash` non ha alcun endpoint ZDR,
il main sì. Nessun cambio a provider o routing è stato fatto.

**Come si trovano le cose.** REPL in **tmux**, tracce, log e il `muffin.db`
vero (`sqlite3 <db> ".backup <dest>"`, mai `cp`); processi di prova fermati per
PID. **Il gate è una porta sola:** `npm run merge -- <pr>` (ci:local in Docker,
cinque job; una PR alla volta, host quieto o `DISCARDED`; `gh pr merge` a mano
è bloccato dal hook). Minuti GitHub tornati il 17/09 (two-tier gate #555:
per slice→dev conta anche il verde hosted). Piano pre-25/09:
`docs/work/source-public-2026-09-25/plan.md`; questo handoff resta solo
l'operativo vivo.

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

**Azioni owner senza codice:** billing GitHub Actions · scelta modello/provider ZDR (track separato dal 25/09, vedi #481 e piano §0/§7) · VPS Hetzner rifatta (x86_64, utente `muffin`, deploy key read-only): install
arrivata a `init`, gateway e sandbox a mano come in `cutover-2026-09-08.md`.
Mac a 4521f83, memoria al backup pre-prova. `rot harden` fatto (06/09).
Risolte e verificate a codice il 17/09 (non più azioni): `origin` già
`muffin-project/muffin-agent` · URL canonici installer già org (PR #541) ·
`e2e:telegram` eseguita due volte, 04/09 (`e2e-telegram-2026-09-04.md`) e 08/09
(`e2e-telegram-2026-09-08.md` + cutover) · base permission org `None` (17/09) ·
merge post-move provati dai gate #534→#552 · description repo impostata,
`delete_branch_on_merge` on · cutover dev→main 17/09 (ok owner, main=3a38a29,
hosted CI verde su push: collegamenti/install/verifica/accettazione; strada:
main rosso su describeBuild→#558→fix #559→re-cutover) · #522 chiusa · #560
chiusa senza merge (superata da #559).

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