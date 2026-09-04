# Brief comune — triage evidence-only verso DAY-1 (17/08)

Sei un worker di TRIAGE (sola lettura sul codice; scrivi UN file). Repo `muffin-agent`, base: `origin/dev` (usa il worktree `/home/user/dev/muffin-agent/.claude/worktrees/loop-orchestration-workflow-e20bef`, che è su `dev` con `node_modules`; NON spostarlo, NON scrivere lì salvo il file che ti assegno; puoi eseguire test con `npx vitest run <file>` e l'harness `npm run test:acceptance` / `npx tsx evals/acceptance/report.ts`). Nessun provider a pagamento. Mai dev/main. **Tempo ≤ 60 minuti.**

Direttiva owner (17/08): «corsa di convergenza verso DAY-1 READY, non altre iterazioni esplorative. UNA ricostruzione completa e un triage evidence-only di tutti i BLOCKER, tutti i ?, i finding audit ancora aperti e le proprietà trasversali. Classifica ogni voce SOLO come READY / BLOCKER / OUT / INVALIDATED, con evidenza attuale. Non trattare i ? come task distinti per forza: riusa acceptance journey e fault-chain integrate quando una prova può validare più proprietà.»

Leggi prima (per intero): `docs/blueprint/gate1/MANDATO-DAY-1.md` (§3 criterio di uscita: READY = impl + unit + integration + cablaggio prod + failure path + scenario di accettazione + doc; §4 dodici invarianti; §5 capability), `docs/blueprint/M5-BIS.md` (regola delle tre risposte; le note sotto le tabelle), `docs/blueprint/research/audit-2026-08-16/README.md` (classificazione dei 24 finding), `evals/acceptance/manifest.ts` e `evals/acceptance/scenarios/*.accept.ts` (cosa è già provato contro il binario vero), `docs/blueprint/STATE.md` START HERE, `docs/ORCHESTRATION.md` §11.

Per OGNI riga assegnata produci una scheda:
- **Stato proposto**: READY | BLOCKER | OUT | INVALIDATED.
- **Evidenza attuale** (file:riga aperti, test eseguiti con esito, scenario di accettazione presente/assente): READY solo se TUTTE le sette condizioni di §3.B sono soddisfatte e le citi; altrimenti BLOCKER con «cosa manca» preciso (implementazione? test di cablaggio? scenario? doc?); OUT solo con una ragione legata ai 14 giorni personali (owner solo, CLI+Telegram privato, macOS dev / Linux VPS prod), mai «è difficile»; INVALIDATED se la premessa della riga non regge più (di' perché e cosa la sostituisce).
- **Journey**: quale scenario di accettazione (esistente o proposto, nome del file) può provare QUESTA riga insieme ad altre — nomina le altre righe che lo stesso scenario coprirebbe. Preferisci fault-chain integrate: inbound → provenance → context → decision → effect → persistence → crash → resume → delivery.
- **Costo stimato per chiudere** (S/M/L) e dipendenze (altre righe/slice).
Poi una sezione «Journey proposte» (max 6) con: nome, righe coperte, passi, punti di crash/fault injection, cosa asserisce; e una «Cosa non ho potuto stabilire».

Scrivi in italiano, compatto, senza prosa di contorno. Non modificare M5-BIS: l'orchestratore consolida. Salva SOLO il file assegnato, poi riferisci in ≤ 15 righe: conteggio per stato proposto, le journey, le 3 righe più costose.
