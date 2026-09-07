# Handoff operativo

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato usando
Muffin, da una requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da questa lista e non da una feature list di peer.

**Goal owner:** DAY-1 = *«io installo Muffin sulla VPS, quindi deve essere
praticamente pronto»*. Snapshot autoritativo 06/09: 58 righe READY su 60 in
scope; aperte D13 (uso dei tool) e F7 (capacità per stanza). Lo stato corrente
va sempre ricostruito da Git/PR/check + `day1/requirements-status.md` prima di
usare quel conteggio.

**Come si trovano le cose.** REPL in **tmux**, tracce, log e il `muffin.db`
vero — mai `cp`: `sqlite3 <db> ".backup <dest>"`. Fermare un processo di
prova si fa **per PID**: `pkill -f "gateway run"` prende anche quello vivo.

**Il gate è una porta sola:** `npm run merge -- <pr>` costruisce dev+PR in un
worktree e ci fa girare `ci:local` (cinque job nei container: verifica,
accettazione, collegamenti, strumenti, **install**); unisce solo su PASS.
Una PR alla volta, ~12-15 minuti, **con nessun worker che gira**: un vitest
estraneo o load > 10 all'inizio danno `DISCARDED`, da rifare. `gh pr merge`
a mano è bloccato dal hook. I minuti GitHub sono finiti (run morti in 4 s).

## Le decisioni dell'owner

`routing.only: ["alibaba"]`, `dataCollection: "deny"`; ADR-0074 (06/09, «si
chiede solo l'irreversibile, sempre, anche in privato»). Kernel
(ADR-0071/0072): un link citato non chiede, composto+non-owner nega, una ricerca
non chiede mai. Gruppi: senza il suo umano Muffin saluta, avvisa e esce (F4).

07/09: il normale owner **non deve imparare una grande command surface** per
usare Muffin. Conversazione e automazione devono assorbire la meccanica normale;
CLI/TUI/control plane conservano recovery, osservabilità e developer/operator
power. Issue #465 tiene la riconciliazione di questa decisione, non
l'implementazione indiscriminata.

07/09: il repository deve diventare **source-public/pre-alpha appena è sicuro
pubblicarlo**, senza aspettare il product public-alpha. Ci sono già contributor
interessati; contributor ≠ maintainer. La pubblicazione richiede audit di HEAD e
dell'intera history per segreti/private owner data e una decisione licenza
esplicita. Issue #464 possiede questo lavoro.

**Azioni owner senza codice:** billing GitHub Actions · `npm run e2e:telegram`
con un bot vero (B11/B13/B2 datati) · la prima install vera su una VPS x86_64
(A11 è provata solo nel container arm64). `rot harden` è fatto (06/09, rot di
uid 0); ADR-0073 ha avuto il sì e ADR-0074 lo estende a ogni stanza.

## Aperto

**F7** non aspetta più il sì: PR **#462** è aperta e mergeable su `dev`
(`slice/f7-capacita-per-stanza`). Implementa i punti 1/2/3/5 di ADR-0073:
grant capability per stanza, `vault.write` tenant-scoped e grant di `todo`/
`wait`; il punto 4 (ask effimera all'owner da stanza) resta separato. Prima di
agire, osservare se #462 è ancora aperta o è già integrata.

**D13** resta BLOCKER nello snapshot 06/09 (`tool-use-2026-09-06.md`): dopo le
descrizioni riscritte 4 probe su 22 chiedono ancora la shell — servono un
approvatore finto nell'eval, due tool mancanti (porte aperte, SQLite in
lettura), tre giri di misura. L'audit 07/09 aggiunge solo una cautela come
evidence: non trasformare automaticamente ogni shell read in un one-off tool;
la forma va decisa contro eval e policy reali.

**Fase C** (fette 17-21 di `ingresso-unico-e-nucleo-2026-09-05.md`: comandi e
coda, approvazioni, transcript, consegna, provenienza su Discord) non è DAY-1.
`evals/e2e/telegram.ts:66` legge ancora l'owner da `config.json`. Issue #378
tiene l'indice (#371-#377).

**Da Centria (`origin/stage`, 06/09):** entra **D15** (registro degli effetti:
più autonomia ⇒ più sorveglianza); il tetto di spesa c'è già (E1/E2). Dopo la
VPS: revoca con parità (T-028), giudice come sensore versionato, verifica delle
affermazioni negli ADR; auto-merge quando saremo open source.

**Dogfood 06/09 sera, due decisioni owner.** (1) Taint «inutilizzabile»:
ADR-0075 e **D16**, sull'host il taint non nega più, verso l'esterno chiede con
la ragione; fetta kernel dopo #457. (2) Streaming e file negoziati per
`(porta, stanza)`: privato → draft nativo più messaggio finale vero, gruppo e
topic → edit; `sendMessageDraft` non ha chiamanti da #388. Brief pronti.

## Audit ecosistema 07/09

PR **#474** conserva l'audit completo come
`docs/evidence/personal-agent-ecosystem-audit-2026-09-07.md`, aggiorna la
strategia source-public e rende `CONTRIBUTING.md` utilizzabile anche senza
Claude Code. È evidence/product-community docs: **non autorizza feature parity**.

Issue **#463** possiede la riconciliazione: osservare stato reale → leggere
l'audit come evidence → aggiornare solo gli authoritative homes realmente stale
→ produrre **una** prossima claim falsificabile. Il commento su #463 contiene
il brief esatto per la prossima sessione Claude Code e un `/goal` candidato da
rigenerare contro lo stato reale, non da usare come master plan.

Le ipotesi interessanti (Hermes moving benchmark, persistent facets tipo
`Muffin Code`, capability discovery, self-work con verifica indipendente,
steerable workers, ecc.) sono conservate nell'audit. Le issue speculative create
durante la decomposizione sono chiuse `not_planned`: non sono backlog finché
reconciliation/dogfood non crea una claim reale.

**Truth maintenance:** `day1/requirements-status.md` possiede lo stato,
`critical-path.md#ordine-corrente` l'ordine, le Issue il lavoro attribuibile.
`docs/evidence/` conserva ciò che abbiamo osservato/imparato; non possiede la
roadmap.