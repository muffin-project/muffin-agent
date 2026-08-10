# La spina osservante

**Stato: design NUOVO, fondato sul VIVO del vecchio Muffin.** Il vecchio aveva il
meccanismo production-proven (Forma A/B, awareness-loop, `decider.ts` 4-gate, P-I);
il blueprint nuovo l'ha perso (solo riga d'inventario). Qui è ri-espresso come
**primitive messe dove hanno senso**, non come port dei moduli vecchi. Sintesi
dello shaping 2026-08-09.

## Cos'è

La seconda gamba di Muffin è lo **specchio**: osserva la persona nel tempo per
**coprire i buchi cognitivi umani** e restituire punti ciechi. Onboarding-che-impara
e mirror sono **lo stesso meccanismo da due lati** — uno costruisce il
modello-di-te, l'altro lo usa. Tre principi lo governano, sempre:
**provenienza** (detto-vs-inferito), **lettura del momento**,
**alta-confidenza-non-firehose**.

## L'anello

`osserva → modella (con provenienza) → decide se parlare (momento + confidenza) → impara o riflette`

## Il "quando" — il cancello a due stadi (il nodo vero)

Mai un LLM ogni 5 minuti. Il costo si tiene con due stadi, e l'LLM è il secondo.

- **Stadio 1 — cheap, deterministico, event-driven** (non a orologio). Segnali,
  tutti quasi-gratis: àncore di ritmo (buongiorno/buonanotte, **appresi** dal tuo,
  non fissi — profilo circadiano), eventi di attività (primo messaggio, ultimo,
  silenzio lungo, raffica), calendario (in riunione → zitto), stato esplicito
  ("in giro"/DND), + i **flag di tuning** ("non chiedermi X" / "inizia a chiedermi
  X"). Mantiene un **modello-della-giornata leggero**, aggiornato *quando succede
  qualcosa*. **L'assenza è un segnale di stadio-1** (un timer per ciò-che-non-è-
  successo → vedi `04-learn-from-absence.md`). Risponde a una sola domanda binaria:
  *è anche solo un momento?*
- **Stadio 2 — solo su SÌ**, un LLM decide *cosa* dire/chiedere. Gira su una
  manciata di veri momenti al giorno.

*VIVO dal vecchio*: `src/decider.ts` = 4 gate deterministici pre-LLM (cooldown,
salience-floor, DND, context-match), zero LLM — è già lo Stadio-1. L'awareness-loop
(Predictor + Scheduler + Decider, `docs/pillars/planning/README.md`) è la forma
completa da riadattare.

## Il modello-della-persona (il tier USER, appreso)

Sottografo `is_self` + una vista-profilo compilata. Ogni fatto porta **metadata
ricco** (il DB regge): `source` (detto/inferito/importato), `confidence` continua,
conteggio-corroborazioni, primo/ultimo-visto, `silent_since`, importanza, affect.
**Il comportamento scala con la provenienza**: un fatto *detto* muffin lo afferma;
un *inferito* lo tiene come ipotesi e lo copre ("sembra che…"), mai come verità.
È per-utente e **appreso** (onboarding dinamico multi-giorno che legge il momento),
mai shippato — puro-vs-personale.

## Dove la neuroscienza diventa primitiva (i collocamenti)

Nessuno è un "modulo cognitivo": sono **proprietà di 4-5 primitive**.

| Principio | Dove vive | Non |
|---|---|---|
| **Importanza ≠ frequenza** | campo metadata sul fatto (assegnato all'estrazione) + termine di ranking nel recall + protezione dal decay | un "Salience module" (il vecchio trimmato ad-hoc) |
| **Silenzio / assenza** | producer di eventi per il gate (Stadio-1), legge `silent_since` + soglia (media × 3) | un bolt-on nel dream |
| **Detto-vs-inferito + confidence** | colonne sul fatto, lette da recall (peso) e specchio (afferma/ipotizza) | un modulo di belief (rimosso, vedi graveyard) |
| **Common ground / ToM** | infer-then-condition nell'assemblaggio del contesto | una torre "io-so-che-tu-sai" (2° ordine non validato) |
| **Dimenticare-per-complemento** | peso della funzione di decay (importanza × complemento) | un modulo dell'oblio |
| **Affect signature** | EMA cheap (valenza/arousal) che modula encoding e recall | un LLM di sentiment |

## Il riflettere (il mirror, fatto bene)

- **Trigger**: un segnale **concreto, verificabile, azionabile** (impegno con
  scadenza, fatto tier≤1 diventato azionabile, silenzio significativo) — MAI
  "ho notato" vago. Insieme CHIUSO di `kind` (ADR-0028), non stringa libera.
- **Disciplina di provenienza**: riflette con sicurezza sui *detti*, con cautela
  sugli *inferiti* — un'inferenza esce come **domanda/ipotesi**, non asserzione.
  È l'antidoto strutturale al vecchio firehose.
- **Postura anti-firehose**: P-I (information-surfacing rate-limit + decay-on-ignore)
  + cap per finestra + quiet-hours + budget. Grounding empirico *(rettificato
  2026-08-10 sul testo primario)*: Pare-Bench misura la quota di proposte che
  innescano un **gather context** — l'utente non poteva ancora agire — e vale
  74,7% su Gemma 3 4B, ma **17,8% su Claude e 23,4% su GPT-5**. Il gate meccanico
  si giustifica anche col modello buono: uno su sei sbaglia il momento. La soglia
  va alta, non a intuito.
- **La tensione della THESIS**: uno specchio che punto io dove dico io non mostra
  veri punti ciechi. Serve **segnale esterno indipendente** (calendar/github/news)
  che muffin non filtra direttamente — non solo ciò che gli racconti.

*VIVO dal vecchio*: `planning/README` distingue **Forma A** (relazionale: quando
aprire, quando tacere) da **Forma B** (curiosa); `context/HEARTBEAT.md` è la
postura osservativa ("da cosa emergono le osservazioni"). Da riadattare, non
riscrivere.

## Rails (fissi su ogni pezzo)

Vera harness non slop · detto-vs-inferito · puro-muffin separato da il-tuo-muffin ·
importanza ≠ frequenza · **primitive, non moduli a lato**.

## Fonti

`docs/pillars/planning/README.md` · `src/decider.ts` · `docs/foundations/PRINCIPLES.md §P-I`
· `context/HEARTBEAT.md` · `src/memory/{memory_affect_signature,circadian}.ts` ·
`docs/foundations/{UNDERSTANDING,VISION,THESIS}.md` · blueprint `adr/0028-postura-di-proattivita.md`
· Pare-Bench (2026, arXiv:2604.00842, da `REFERENCES.md`)
· `research/proattivita-quando-parlare.md` (sweep 2026-08-10: il cancello a due
stadi ha un precedente misurato in arXiv:2605.30152 — ma là lo Stadio-1 è un
modello *appreso*, il nostro è deterministico, e la divergenza è deliberata;
l'assenza-come-segnale non ha invece prior art trovata, quindi nessun benchmark
su cui tarare) · lo Stadio-1 dell'assenza è costruito: `core/memory/absence.ts`.
