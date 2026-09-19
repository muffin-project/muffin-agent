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

**Osservato 2026-09-20:** `dev` @ `7d5f2c9` (includes #593). 4 PR aperte:
#596 (ready), #601, #597 (draft), #609 (ready, docs preview). Tutte UNSTABLE
su CI al momento dell'osservazione (verificare se per basi ferme pre-fix).
#599 chiusa/parcheggiata (coda della lane in #608 da riconciliare).

**Lane di landing (#608): #593 FATTA (merge 7d5f2c9, gate PASS su composizione
`61cd8689`) → prossima #596 → #601 → #597** (+ fix publication/docs piccoli
solo se esplicitamente accettati). Prossima azione: canonical gate su #596,
poi proseguire in ordine. Freeze + riscrittura history finale + rescan +
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
