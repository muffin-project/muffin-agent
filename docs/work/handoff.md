# Handoff operativo

> Purge 17/09: origin riscritto (force-push dev/main). Ogni clone/worktree va
> riagganciato (fetch + rebase `--onto` o re-clone). Resta: purge cache via
> GitHub Support + re-clone personali. Dettagli in #464.

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato, da una
requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da una feature list di peer.

**Goal owner:** DAY-1 = *«io installo Muffin sulla VPS»*. Residuo unico: ZDR
(decisione owner — light senza endpoint ZDR, main sì). Dal 17/09 l'orchestrazione
di tutto il repo è in questa chat (subagenti liberi).

**Come si trovano le cose.** REPL in tmux; `muffin.db` vero solo via
`sqlite3 .backup`, mai `cp`. Merge: PR su `dev`, solo a check verdi
(`gh pr merge`); niente merge il 21/09 salvo hotfix publication-safety.

## Le decisioni dell'owner

`routing.only: ["alibaba"]`, `dataCollection: "deny"`; ADR-0074 «solo
irreversibile, sempre»; ADR-0071/0072 (link citato ok, composto+non-owner nega,
ricerca mai); gruppi: senza il suo umano saluta/avvisa/esce (F4); command
surface piccola (VISION, #465); source-public/pre-alpha appena sicuro (#464).

**Analisi legacy 17/09 (output in chat):** M5 scartato; DT-02 grace 60s
contestuale; DT-03 standard-first + DT-04 fabbrica (solo scopo); DT-07
monitor-only; DT-13 ambient; DT-14 floor in recall; DT-15 checklist nei todo.
Slice: DT-10 (#567) + DT-05 (#568) in attesa CI; poi DT-09, OAuth, DT-03/04.

**Azioni owner senza codice:** billing GitHub Actions · scelta modello/provider
ZDR (track #481) · VPS Hetzner rifatta (utente `muffin`, deploy key read-only).

## Aperto

**F7** punto 4 (ask effimera nel gruppo) aperto, non DAY-1. **Fase C** Discord
(#378) non DAY-1. Da Centria: revoca con parità dopo la VPS, giudice sensore
versionato, verifica affermazioni negli ADR.
