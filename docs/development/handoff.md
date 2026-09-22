# Handoff operativo

> **Snapshot operativo, non stato corrente.** Prima di agire osservare GitHub/Git.
> Il router pubblico/corrente resta [`docs/STATUS.md`](../STATUS.md); questo file
> serve solo a ridurre il costo di ripresa per il maintainer e può invecchiare.

## Snapshot 2026-09-22

- `dev`: `35bde7b1ce438663becbf6931067d7035011f8a4`
  (merge #633, real runtime-path inference verification).
- `main`: ancora il candidato Community Preview; non promuovere implicitamente.
- PR aperte: **#650** soltanto, draft/HOLD
  (`slice/shell-containment-638-642-645`).
- #608 Community Preview: **chiusa**. Il programma attivo verso il 25 Sep è la
  boundary source-public/pre-alpha in **#464**.

## Appena integrato

- **#648 / #639** — Muffin Home privato: directory 0700, file 0600,
  migrazione same-owner, symlink/ancestor fail-closed. Merge
  `30f401654620d1576b7a62e2bafad53f257584a2`.
- **#633 / #523** — `verifyInferenceRoute()`: provider/config/secret path reale,
  forced inert tool-call probe, requested/resolved model truth,
  `doctor --online` reale, nessun side-effect Session/Memory/Turn/Work.
  Merge `35bde7b1ce438663becbf6931067d7035011f8a4`.
- **#649 / #646** — Git execution-control writes fail-closed, già integrato prima
  di #648.

L'ingresso in `dev` resta `npm run merge -- <pr>`: il gate costruisce il
merge-result, esegue `ci:local` e unisce solo su PASS. I check GitHub hosted
possono ancora risultare rossi/no-run per il problema billing/pre-run già noto;
non interpretarli come test eseguiti falliti.

## Prossimo percorso critico verso il 25 Sep

1. **#624 + #641** — una lane CRITICAL, due claim distinti:
   pathname canonico nella provenance/egress policy + tier-2 disk content non
   può comporre silenziosamente query/path/fragment di rete. Policy già decisa:
   `paramsMaxTaint 2 -> 1`, exact whole owner/input URL exception, nessuna nuova
   provenance architecture salvo necessità provata.
2. **#650 / #638 + #642 + #645** — shell containment. Non merge finché mancano
   evidence Linux/bwrap e una decisione onesta su whole-host read visibility.
3. **#654** — fresh Ubuntu VPS: da login provider/root a runtime Muffin
   non-root, supervisionato, one-command, senza plumbing Unix manuale.
4. **#614**, slice pre-25 bounded — fermare la contaminazione di durable memory
   da request/event one-shot e pinned palesemente errati. La Memory Maintenance /
   dreaming v1 completa resta lavoro da chiudere entro circa un mese, non un
   redesign pre-25.
5. **#464** — publication boundary finale: purge GitHub di cached/dangling
   objects contenenti vecchi dati personali + fresh external retrieval check,
   governance/check pubblici e triage delle vulnerabilità npm osservate nel
   merge gate. Non eseguire `npm audit fix --force` alla cieca.

## Repo hygiene

Remote heads osservate in questo snapshot:

- `main`
- `dev`
- `docs/community-preview-ready`
- `slice/shell-containment-638-642-645`

`slice/shell-containment-638-642-645` è posseduta da PR #650: **non toccare**.

`docs/community-preview-ready` è 1 commit ahead / 62 behind `dev`, senza PR
aperta. La sua unica sostanza è già superseded su `dev`: FUNDING è identico,
README usa vecchi path pre-riorganizzazione, issue-template usa il vecchio
routing “Community Preview support”. Disposizione canonica registrata in #620:
**DELETE, nessuna preservation/reapply**.

Quando si lavora da un checkout con shell:

```bash
npm run igiene
# controllare il verdetto; poi soltanto per i rami classificati "integrati":
npm run igiene -- --pulisci
```

Lo script non cancella mai lavoro abbandonato/non integrato automaticamente.

## Debito non da confondere con il percorso critico

- **#604** — Turn/tool-result storage lifecycle e compaction: non blocker 25 Sep,
  ma non lasciarlo crescere senza bound per mesi.
- **#623** — watcher fs/timing isolation: PARKED, non green-fishing.
- **#622** — Context Receipt: PARKED; utile più avanti per rendere inspectable
  quali memory items entrano nel prompt, non per creare una seconda truth.
- **#503** — merge-gate evidence: ancora aperta. Il gate scrive il verdict JSON,
  ma non soddisfa ancora l'intero claim di raw log + summary + comment update.

## Regola di stop

Il prossimo lavoro nasce da un failure osservato, una requirement owner, una
migrazione costosa o un rischio su authority/data/effect. Non allargare una lane
solo perché durante il review emerge un miglioramento adiacente: chiudere la
claim corrente, poi tracciare separatamente il resto solo se necessario.
