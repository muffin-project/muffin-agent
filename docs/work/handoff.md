# Handoff operativo

> Purge 17/09: origin riscritto (force-push dev/main). Ogni clone/worktree va
> riagganciato (fetch + rebase `--onto` o re-clone). Resta: purge cache via
> GitHub Support + re-clone personali. Dettagli in #464. **Aggravante 19/09
> (#610): nuovo valore personale entrato dopo il purge in `dev` e slice
> attivi — tree fix già su `dev` (#611), ma il blob resta nella history:
> riscrittura finale + purge servono sul candidato preview congelato, non ora.**

**Programma corrente (unica fonte: issue, non questo file): #608 Community
Preview 21 Sep** (`program/current`). Questo file è solo un hint usa-e-getta:
se contraddice Git/PR/issue osservati, vince l'osservato.

**Osservato 2026-09-20:** `dev` @ `9766c33` (includes #609 + #601). 1 PR
aperta: #597 (draft). #601 e #609 entrambe integrate durante la sessione
(#601 via local door, verdict `pass` in `.ci-local/verdicts/`; #609
convergenza concorrente, non assorbita nella slice #601). #599
chiusa/parcheggiata (coda della lane in #608 da riconciliare).

**Lane di landing (#608): #593 FATTA (merge 7d5f2c9) → #596 FATTA (merge
449ca6c, gate PASS su composizione `df170db`, doctor 106/106 su HEAD
integrato) → #601 FATTA (merge 9766c33: slice ricomposta su `dev`
`8e0d063`, report/scenario 54/54 + `tsc` clean sulla head, ci:local PASS
sul risultato unito — verifica/accettazione/collegamenti/install/strumenti;
GitHub CI ancora in outage pre-step, porta GitHub non disponibile) → #609
FATTA (concorrente) → prossima #597** (+ fix publication/docs piccoli
solo se esplicitamente accettati). Prossima azione: canonical gate su #597,
poi proseguire in ordine. Slice #601 cancellata (remoto + worktree). Freeze + riscrittura history finale + rescan +
purge solo a landing convergente. Ramo `slice/shell-outcome-integrity`
integrato ma non ancora cancellato (follow-up igiene #608).

**Regola di stop.** Il prossimo lavoro nasce da un failure osservato, da una
requirement owner, da una migrazione costosa o da un rischio su
authority/data/effect — non da una feature list di peer.

**Owner decisions (invariate):** `routing.only: ["alibaba"]`,
`dataCollection: "deny"`; ADR-0074 «solo irreversibile, sempre»;
ADR-0071/0072 (link citato ok, composto+non-owner nega, ricerca mai); gruppi:
senza il suo umano saluta/avvisa/esce (F4); command surface piccola (VISION,
#465); source-public/pre-alpha appena sicuro (#464). Moderatori esterni:
ruolo Triage, non Write (#608); tre accessi esterni già attivi = superficie
di disclosure già aperta (accettazione esplicita owner o rimozione
temporanea).
**ADR-0088 (20/09, ACCEPT owner):** Session durevole con Conversation
generation numerate da `/new` esplicito; nessun auto-split per topic;
Principal/Session/Conversation/Turn identità distinte (estende ADR-0056 §4).
