# ADR-0103 — Tutto gira sul gateway

**Stato: adottato dall'owner il 14/10/2026.** Chiude la divergenza osservata
in produzione: lo stesso turno girava in processi diversi con oggetti diversi
(profili, budget, lane, workspace) a seconda di REPL, `run`, gateway o
superficie — e i messaggi arrivavano a volte in uno, a volte in più bolle.
Amenda ADR-0035 (stand-down) e la promessa dello scheduler nel REPL
(ADR-0060): la promessa dei job vive nel gateway, non nella finestra.

## Decisione

- L'unico esecutore dei turni è il gateway vivo e claimed. REPL (`cli/repl.ts`)
  e `run` headless (`cli/run.ts`) senza gateway **non eseguono in locale**:
  falliscono con il rimedio (`muffin gateway install --write --start`),
  mai con un secondo runtime silenzioso. Il caso `conflict` resta invariato.
- Lo scheduler vive solo nel gateway. Il REPL non ne crea nessuno senza
  gateway; con gateway continua a cedere via `standDown` come prima.
- Hatch di test `MUFFIN_EXEC_LOCAL=1`: ripristina il vecchio comportamento
  (owner locale + scheduler in finestra) **solo per i test**. Vive nel
  codice (`core/gateway/ownership.ts:localExecAllowed`), nell'harness di
  accettazione e nel witness G0 — mai documentato agli owner, mai default.
- Eccezioni esplicite, non dimenticanze: `muffin resume` resta locale e
  claim-fenced per disegno (recovery/debug, la race col gateway è detta a
  voce); `muffin observe` resta diagnostica dell'operatore. Entrambi fuori
  dal percorso dei turni dell'owner.

## Alternative scartate

Fallback locale rumoroso: conserva due semantiche e due set di bug — è la
divergenza che questa decisione chiude. Scheduler nel REPL dietro flag:
stesso problema, un interruttore in più. Esecuzione locale per le superfici
servite dal REPL senza gateway: incoerente (l'ingress fallirebbe comunque
col rimedio), quindi le superfici senza gateway dicono come avviarlo.

## Falsificatore e reversibilità

Senza gateway e senza hatch: `run` esce 1 col rimedio e zero chiamate al
modello; il REPL non schedula e non esegue. Con hatch: il vecchio percorso
resta pinnato dai test. Se un'installazione deve davvero girare senza
supervisore, serve una nuova decisione — questa non fornisce scorciatoie.
