# ADR-0104 — La shell legge solo radici autorizzate

**Stato:** proposto · 2026-10-08 · richiede ratifica owner per il confine di lettura

> Questa proposta corregge nel candidate la regola di lettura della shell. Il
> codice e le prove restano reversibili nel worktree; il cambiamento non va
> installato o dichiarato live prima della ratifica.

## Contesto

La misura Linux del 2026-09-22 dimostrò che il percorso di produzione
`agent/runtime.ts` → `makeShellTool` → `SandboxExecutor.runReadOnly` →
`SandboxManager.wrapWithSandboxArgv` poteva leggere file fuori dal workspace.
Il test `core/sandbox/executor.test.ts` fissava quell'esito come limite noto.
L'approval per chiamata non restringeva i byte che il comando poteva restituire.

La premessa tecnica di ADR-0091 non è più corretta: la versione pin `0.0.71`
di `@anthropic-ai/sandbox-runtime` include `filesystem.allowRead` e la
documenta con un esempio workspace-only. Il backend Windows applica i grant in
sessione; macOS/Linux accettano anche configurazioni per comando. La prova
locale usa il grant di sessione, così il perimetro non dipende dal backend.
Ricerca, source link e misure sintetiche sono in
`docs/evidence/shell-read-allowlist-2026-10-08.md`.

## Decisione proposta

`SandboxExecutor` nega la lettura dalla radice del filesystem e riapre solo:

1. `readScope`, fornito dal runtime fidato (normalmente il workspace) e mai
   costruito dagli argomenti del modello;
2. lo scratch temporaneo dell'executor;
3. il runtime Node in esecuzione, le directory assolute in `PATH` e le radici
   OS/tool necessarie a lanciare programmi;
4. nessuna delle directory protette dai `denyRead` espliciti, che restano
   ripetuti anche nella configurazione per comando.

La corsia read-only continua a non scrivere fuori dallo scratch; la corsia di
scrittura mantiene il workspace come `writeScope`. Rete diretta e AF_UNIX
mantengono i controlli esistenti. `risk: 'high'`, `reversible: 'no'`,
`rerunnable: false` e l'approval a ogni chiamata restano invariati: questa
proposta non cambia autonomia o policy.

## Alternative considerate

| Opzione | Evidenza | Esito |
|---|---|---|
| Mantenere la lettura allow-by-default e la lista finita | È il comportamento attuale; il canary fuori workspace è leggibile nel percorso di produzione | Rifiutata come confine finale: non limita nuovi file personali |
| Usare `allowRead` di SRT con root deny | API già pin, prova macOS positiva e negativa; nessun parser di comandi aggiunto | Scelta proposta |
| Sostituire SRT o analizzare i path nella stringa shell | Introduce un secondo runtime o un parser aggirabile per una garanzia già offerta dal kernel OS | Rifiutata |

## Falsificazione e residui

La prova reale deve mostrare che la shell di produzione legge un file nel
workspace, rifiuta un canary fratello, un `.env` esplicitamente negato e un
symlink verso l'esterno; i test esistenti di scrittura, hook Git e rete devono
continuare a passare. La rimozione del root deny deve far esporre il canary; la
rimozione del grant workspace deve far fallire la lettura positiva.

Le prove sintetiche e la compilazione del candidate sono su macOS. La verifica
Linux CI è ancora necessaria; Windows non è dichiarato verificato. Le radici
OS/tool necessarie alla shell restano un accesso esplicito a contenuti di
sistema e stato dei processi. Il perimetro read-only non è una sandbox di
processi né una promessa che tutti i programmi di terze parti funzionino.
