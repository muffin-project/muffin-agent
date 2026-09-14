# Piano esecutivo — source-public 25/09/2026 (preview supporter 21/09)

Stato operativo, non autorità semantica. Autorità: `docs/OPEN-SOURCE-STRATEGY.md`
(distribuzione), `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, ADR, DAY-1 in
`docs/work/day1/`, lavoro vivo in Git + `docs/work/handoff.md`.
Fotografato il 14/09/2026 su `dev 879887b` (= `origin/dev`, pulito).

Regola del piano: **ogni voce aperta ha una fase; niente resta orfano.**
La tabella §8 è la prova di copertura totale (32 issue + 4 PR + stato Git).

## §0. Decisioni owner già congelate (14/09)

1. **Licenza: AGPLv3** (supera ADR-0019/MIT). Forma raccomandata: `AGPL-3.0-or-later`
   (tiene aperta la via di aggiornamento; senza "or later" anche il passaggio a
   future versioni AGPL richiede consenso di tutti). Dettaglio legale in §1.1.
2. **21/09: Read a tutti i supporter** (outside collaborator sul repo privato,
   base permission `None`). Niente push, niente Triage generalizzato.
3. **Annuncio countdown: già fatto su Instagram.** Resta da verificare che la
   narrativa distingua source-public/pre-alpha da Public Alpha (§4.3); se manca,
   post correttivo, non silenzio.

Non-bloccanti il pubblico (restano nel loro track): ZDR/DAY-1 start, dogfood 14gg,
Public Alpha gate (#518).

## §1. Fase 1 — Publication safety, CRITICAL (14→19/09, prima di tutto il resto)

Boundary privacy/security: ogni slice qui è CRITICAL per il profilo, anche se il
singolo edit sembra FAST. Gate unico di uscita: §6.

### 1.1 Licenza AGPLv3 + inbound per il futuro "relax" — FATTO il 14/09 (slice/licenza-agpl, PR da aprire)

- [x] Nuova ADR (0078, supera ADR-0019): AGPL-3.0-or-later, motivazione, conseguenze.
- [x] `LICENSE` → testo ufficiale verbatim (34.523 byte, `diff` contro gnu.org pulito);
      `package.json` + `package-lock.json` (voce root) → `AGPL-3.0-or-later`;
      README + `CONTRIBUTING.md` (nota inbound) + `OPEN-SOURCE-STRATEGY.md` §13.
- [x] CI `license-checker`: `scripts/check-dep-licenses.mjs` (reale, falsificato con
      fixture UNLICENSED→exit 1) + step in `ci.yml` (ereditato da `ci:local`).
      Censimento 14/09: 143 dipendenze, 0 fail, 1 copyleft INFO (`node-forge`,
      dual BSD/GPL, usabile inbound). Trovato misurando: ADR-0019 prometteva un
      check che non è mai esistito.
- [x] `TRADEMARK.md` (notice) + first-use evidence (annuncio 14/09, flip 25/09).
- [x] DCO + grant relicense OSI scelto owner il 14/09: ADR-0079,
      `CONTRIBUTOR_AGREEMENT.md`, PR template e controllo nel merge gate per PR
      esterne. I rami storici dell'owner sono esclusi; un nuovo maintainer con
      write richiede una nuova decisione.
- [ ] Resta: verifica rilevamento licenza GitHub dopo il push.

### 1.2 Audit storia + segreti (HEAD + history completa) — scanner FATTO il 14/09

- [x] gitleaks 8.30.1 default ruleset, 1124 commit / 72,6 MB: 100 hit, 6 stringhe
      distinte, tutte fixture sintetiche (dettaglio in
      `docs/evidence/publication-secret-audit-2026-09-14.md`). Zero segreti reali.
      Decisione: **esito A, history pubblicata intatta** (conferma al re-run del gate).
      Nessun `.db`/dump/chiave tracciato, nessun path owner in HEAD.
- [ ] Re-run sullo stesso candidato al gate di cutover.
- [ ] Resta manuale: delete revision #396 su GitHub; review prosa owner-data.

### 1.3 Cutover dev→main + gate install pulita

- [ ] Assorbire PR mergiabili (§2.1) in `dev` via `npm run merge -- <pr>` (unica porta;
      `gh pr merge` a mano è bloccato dall'hook; host quieto o `DISCARDED`→rerun).
- [ ] Promozione `dev`→`main` con review integrata del boundary (BRANCHING.md,
  sezione "Slice -> `dev`" e seguenti):
      suite/journey sul boundary + review della composizione (oggi `main` è 63
      commit indietro a `dev`: chi installa da `main` installerebbe runtime vecchio).
- [ ] Clean-clone gate: da clone pulito, `bootstrap.sh`/`install.sh` da URL org,
      `muffin doctor` verde (o WARN compresi e accettati), primo turno reale con
      risposta. `configured != working` vale anche qui.
- [ ] URL canonici → org: `README.md:149`, `install.sh:4,59`, `bootstrap.sh:17`,
      `docs/INSTALL.md:8,189` da `GiustoPiedimonte/` a `muffin-project/`.

### 1.4 Superficie repo e org (residuo #531)

- [ ] Metadata: description/homepage/topics; `delete_branch_on_merge` on;
      piano branch-protection post-pubblico (oggi nessuna ruleset reale esiste —
      non presumere protezioni ereditate).
- [ ] Verifica GitHub App/connector reinstallata sull'org (il move cambia owning
      account; il lavoro agentico su GitHub si ferma se manca).
- [ ] Verifica `allow_forking`/policy fork org per il flip; base permission `None`,
      accessi espliciti.
- [ ] Potatura branch remoti (~17): `park/`, `wip/handoff-*`, `integrazione-locale`,
      `codex/*` chiusi → delete dopo il cutover. `slice/*` vive solo se con PR aperta.
- [ ] Worktree: assorbire/chiudere `.worktrees/telegram-*` e il worktree esterno
      `muffin-memory-authorship` (ahead 1 → dentro #530 o ramo
      pushato e PR). Al gate: nessun lavoro solo-locale. Mai stash come deposito
      (BRANCHING.md: pila condivisa tra worktree).

## §2. Fase 2 — Preview installabile (14→24/09, in parallelo alla Fase 1)

Obiettivo owner 13/09: clean machine → risposta reale di Muffin. Non fa slittare
il 25 salvo gate rotto.

### 2.1 PR aperte (ordine di merge consigliato)

1. #514 OAuth PKCE core (CRITICAL, non-draft) → sblocca S3.
2. #530 memory authorship (non-draft, mutation-checked) → assorbe anche il worktree esterno.
3. #494 pricing free-router (draft→ready; residuo #499 dentro la stessa slice o
   follow-up dichiarato) → sblocca display onboarding S2.
4. #537 telegram provider failures (draft→finire; nota billing CI sotto).

### 2.2 Slice onboarding #507 (S1–S9, da `alpha-onboarding-2026-09-12.md`)

- S1 bootstrap/install interattivo (#510 già coperto da #520 mergiata — verificare,
  non presumere) · S2 inference-first (#523 probe runtime-path; #524 preset
  prodotto; dipendenze: #502 mergiata ✓, #498 reasoning solo se blocca S2
  altrimenti post-25) · S3 OAuth (#512→#514→UX) · S4 agent-led setup (#516 checkpoint
  CRITICAL: riusare `sys.inspect`, niente `setup.inspect`; ADR-0036/0070/0058 vincolano)
  · S5 restart-after-turn (#515 checkpoint CRITICAL: `wait_for=process_exit` +
  `SIGUSR1`, niente state machine nuova) · S6 seed minimo (#525: una domanda nome,
  lingua inferita, nient'altro) · S7 Tavily OAuth (#521) · S8 Telegram managed
  provisioning (#526, senza relay centrale) · S9 acceptance `configured != working`.
- Watch-item: #372 (surface abilitata a runtime richiede restart) può mordere S8:
  o fix o messaggio esplicito che chiede restart. #500 (model change effettivo o
  pending-restart dichiarato) e #501 (re-run setup derivato al cambio modello)
  sono dentro S2 — senza, l'onboarding mente sul modello attivo.

### 2.3 Strumenti e frizioni

- #503 merge-gate evidence (STANDARD): log+summary sotto `.ci-local/evidence/`,
  commento unico aggiornato per PR. Serve per integrare tutto il resto in sicurezza.
- Minuti GitHub finiti: gate canonico resta `ci:local` in Docker. Prima del 21/09:
  o ricarica billing o dichiara hosted-CI non canonica fino al flip (al pubblico
  hosted torna canonica). Non codificare la quota come policy permanente.

## §3. Fase 3 — Narrativa pubblica e docs (14→24/09)

- #527: verifica post IG (distingue source-public/pre-alpha da Public Alpha?
  nomina il 25/09? niente data Alpha? niente feature-marketing?). Se deriva → post
  correttivo. Poi: post 25/09 (link repo, maturity, install one-command, link
  contribution/security, cosa funziona / cosa NON è promesso) e stop ai countdown
  artificiali.
- #522: frecce stale "open source dopo i 14 giorni" in `requirements-status.md` e
  `ROADMAP.md` → annotare come storiche, modello canonico = OPEN-SOURCE-STRATEGY §10.
- README: wording `PRE-DAY-1` → `source-public/pre-alpha`, badge licenza AGPL,
  URL org. `CONTRIBUTING.md`: path scoped-claim senza founder-context (verifica con
  lettore fresco, umano o agente non-Claude). `SECURITY.md` root: route di
  segnalazione pre-alpha senza SLA inventata.
- Riconciliazione `docs/work/handoff.md`: remote org (non più account personale),
  ZDR come track DAY-1 separata, puntatore a questo piano per il pre-25.

## §4. Fase 4 — 21/09 preview supporter (solo Read)

- Tag candidato stabile (es. `source-public-rc1`) dal `dev` integrato; lista owner
  dei supporter; inviti outside-collaborator Read; base permission `None`.
- Istruzioni ai supporter: cosa guardare, come aprire issue (template bug redatto,
  cfr. #519), cosa NON aspettarsi (niente SLA, niente Public Alpha).
- Nessun merge il 21/09 salvo hotfix publication-safety.

## §5. Fase 5 — Flip 25/09 (checklist del giorno)

1. Pre-flip: §6 tutto verde; `git status` pulito; nessun segreto last-minute.
2. Flip visibility private→public; verifica redirect `GiustoPiedimonte/`→org e
   aggiorna `origin` nei cloni locali.
3. Smoke post-flip da macchina/rete esterna: clone pubblico → install → doctor →
   primo turno reale.
4. Post 25/09 + monitoraggio issue in entrata (triage quotidiano prima settimana).
5. Branch protection pubblica attiva; fork abilitato; topic/description finali.

## §6. Gate di uscita (tutti veri, nessuno "quasi")

- [ ] ADR licenza AGPLv3 mergiata + file/CI/docs allineati.
- [ ] Audit history: esito registrato (intact o rewrite+rotazione) + #396 revision delete.
- [ ] `main` = candidato promosso; clean-clone install gate verde.
- [ ] URL canonici org + metadata + org/App verifiche.
- [ ] Narrativa IG verificata; docs #522 chiusa.
- [ ] Worktree/branch: nessun lavoro solo-locale, potatura fatta.
- **Slip consentito solo per:** licenza irrisolta, storia unsafe, gate install rotto
  (cfr. #527). Mai per feature mancanti.

## §7. Post-25 (placement, non backlog nascosto)

- **Prodotto/dogfood (ordine dal dogfood, non da questo piano):** #529 salience,
  #465 command surface, ZDR→DAY-1 start→14gg→#518 Public Alpha. #481 è brief di
  metodo (PRESERVE, non implementare); #482 audit storico (owner ChatGPT, non delegare).
- **Runtime debts (schedulare contro failure osservati):** #533 gateway autorevole
  (architettura, CRITICAL quando schedulata — research pass obbligatoria per
  RESEARCH.md, sezione "When this pass is mandatory") · #496 retry ownership · #497 governor · #498 reasoning ·
  #499+#377 spend/pricing · #371 SendLock · #372 registry · #374 taint-window
  (stringere o accettare in ADR-0060+SECURITY) · #375 steer-append · #373 anno.
- **Placement ROADMAP invariato** salvo evidence nuova dal dogfood.

## §8. Copertura totale — ogni voce ha una fase

| Voce | Fase |
|---|---|
| #464 epic publication safety | tracker di §1+§6 |
| #527 annuncio | §3 (IG verifica) + §5 |
| #531 org/governance | §1.4 (move già fatto; residuo qui) |
| #522 docs reconcile | §3 |
| #507 tracker onboarding | §2.2 |
| #510 sandbox remedy | §2.2 S1 (verifica #520) |
| #512 OAuth research | §2.2 S3 (→#514) |
| #515 S5 design checkpoint | §2.2 S5 |
| #516 S4 design checkpoint | §2.2 S4 |
| #521 Tavily OAuth | §2.2 S7 |
| #523 inference probe | §2.2 S2 |
| #524 preset prodotto | §2.2 S2 |
| #525 seed minimo | §2.2 S6 |
| #526 managed bot | §2.2 S8 |
| #533 gateway autorevole | post-25, §7 |
| #529 salience | post-25, §7 |
| #503 merge evidence | §2.3 |
| #501 model setup re-run | §2.2 S2 |
| #500 model effective | §2.2 S2 |
| #499 free-router accounting | §2.1 (#494) |
| #498 reasoning | §2.2 condizionale, spillover §7 |
| #497 governor | post-25, §7 |
| #496 retry ownership | post-25, §7 |
| #482 audit storico | guardrail metodo, §7 |
| #481 brief prodotto | guardrail metodo, §7 (non implementare) |
| #465 command surface | post-25, §7 |
| #377 pricing | post-25, §7 (nota in #494) |
| #375/#374/#373/#372/#371 | post-25, §7 (#372 watch-item §2.2) |
| PR #514 / #530 / #494 / #537 | §2.1 (ordine dato) |
| main −63, URL fondatore, metadata | §1.3–1.4 |
| worktree, branch, .releases, billing CI | §1.4 + §2.3 |
| ZDR / DAY-1 / dogfood / #518 | track separato, §0 |

Profili di verifica per ORCHESTRATION.md; branching per BRANCHING.md
(`slice/<claim>` → `npm run merge` → `dev` → promozione `main`, vedi
BRANCHING.md "Slice rules" e la sezione sugli integration checkpoint); si aggiorna solo
la home autorevole resa stolta dal cambio (niente "consistency pass" globali).
