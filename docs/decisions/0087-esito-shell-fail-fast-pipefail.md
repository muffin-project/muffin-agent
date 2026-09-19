# ADR-0087 — L'esito della shell dice il vero: fail-fast e pipefail per ogni comando

**Stato:** proposto · 2026-09-19 · slice `slice/shell-outcome-integrity`

## Contesto

Misurato sul runtime dell'owner, due classi di false-success:

1. **Pipeline.** `vitest ... | tail` falliva, `tail` riusciva, il tool
   registrava `exit=0, is_error=false`.
2. **Shell sequenziale.** `git add` / `git commit` fallivano, il successivo
   `git status` riusciva, il comando complessivo terminava 0 e il tool
   registrava successo mentre l'effetto importante non era avvenuto.

Il modello compensava leggendo `fatal` su stderr. Quella non è una
correttezza: è un'euristica su parole, e la claim di questa slice è che il
`ToolOutcome` di `shell_run` / `shell_run_write` non debba dipenderne.

Ricostruzione del path (PHASE 0, verificata sul codice, non dedotta):

- `agent/tools/shell.ts` → `makeLane` → `SandboxExecutor.runReadOnly` /
  `run` → `execute()` → `SandboxManager.wrapWithSandboxArgv(cmd, undefined,
  …)` → `spawnCollect`.
- La shell è bash su entrambe le piattaforme (srt risolve `bash` via
  `whichSync` e rifiuta di girare senza; su macOS 3.2 di sistema va bene:
  `pipefail`/`errexit` non chiedono niente di più recente).
- Flag: nessuno — `bash -c` con i default. Quindi l'exit di una pipeline è
  l'ULTIMO stage, e l'exit di una lista `;` è l'ULTIMO comando: qualunque
  effetto importante seguito da un'inspection riuscita spariva dall'esito.
- `formatExecOutcome` mappava `code !== 0 || timedOut → isError`, per il resto
  fedele (stdout/stderr integri, troncamento annunciato, timeout kill con
  output parziale). Il bug non era nel mapping: era nel codice in ingresso.
- Timeout/signal: kill `SIGKILL` con `timeoutMs`, `timedOut` solo se
  `signal === 'SIGKILL' && duration >= timeout`; abort del turno ⇒ rigetto
  via evento `error` (il giro lo registra come errore deciso, mai come
  risultato). Un kill da segnale non-timeout usciva come header `exit ?`.
- Effects/WAL (`agent/loop/tool-call.ts`): intent prima dell'handler, outcome
  dopo con `isError` dal tool. Un false-success scriveva `is_error = 0` sul
  record durevole: la resume credeva «fatto» ciò che era «mai avvenuto»,
  e `sys.shell.write` (`rerunnable: false`) non ritentava.
- Le due corsie passano dalla stessa `execute()`: il fix lì copre entrambe,
  più scheduler ed evals. Nessuna rappresentazione strutturata del comando
  esiste (solo stringa libera + `cwd` + `timeout_ms`): non c'era niente da
  estendere, solo una semantica da rendere fedele.

## Decisione

Ogni comando gira sotto `set -eo pipefail`, anteposto in `execute()` —
l'unica porta dell'esecuzione sandboxata — e in nessun singolo tool, così
nessuna corsia può tornare da sola alla vecchia semantica:

- `pipefail`: una pipeline fallisce se UN QUALUNQUE stage fallisce (vince il
  non-zero più a destra). Chiude la classe `vitest | tail`.
- `errexit` (`-e`): il primo comando fallito ferma la sequenza col SUO
  codice — `false; true` fallisce, e `false; touch sentinel` non tocca
  niente. Chiude la classe sequenziale, irraggiungibile per `pipefail` da
  solo (una lista `;` non è una pipeline).

Il contratto, una frase, scritta anche nelle due descrizioni lette dal
modello: **un fallimento non gestito da nessuna parte fallisce l'intera
chiamata; un fallimento gestito esplicitamente dal comando (`cmd ||
fallback`, `if cmd`, `! cmd`, `set +e`) può restare un successo.** Le
eccezioni sono quelle di bash, non un secondo meccanismo inventato qui.

Tre riparazioni inseparabili, stesso diff:

1. **Kill dell'intero gruppo di processo** (`detached: true` + watchdog +
   kill `-pgid` su timeout e su abort, POSIX-only). Misurato: con strict
   mode la shell interna fa fork invece di exec sul comando finale (deve
   sopravvivere per la contabilità degli exit status), il kill colpiva la
   shell in attesa e `echo x && sleep 27` con timeout 1.5s si risolveva a
   27s con l'orfano reparentato a init. Senza group-kill, `timeoutMs`
   smetteva di contenere i comandi composti il giorno stesso in cui
   l'outcome diventava vero. L'esito del kill non cambia (sempre
   `timedOut`, output parziale, `isError`).
2. **Header del kill da segnale**: `code: null` non-timeout non è più
   `exit ?` ma «killed by a signal … did not complete» (`isError` già vero).
3. La regola di `isError` non cambia (`code !== 0 || timedOut`, con `null`
   già errore): il bug non era lì.

## Alternative scartate (tabella della challenge)

| | Opzione | Evidenza | Esito |
|---|---|---|---|
| A (scelta) | prefisso `set -eo pipefail` alla porta unica | prior art peer sullo stessa classe (sotto); falsificatori RED→GREEN | implementata |
| B | solo `pipefail` | chiude le pipeline, lascia `false; true` e `git add; git status` a 0 — il falsificatore git resta rosso | scartata: insufficiente, misurato |
| C | vietare comandi composti / rappresentazione strutturata | nessuna forma strutturata esiste; parsare la shell è fragile; romperebbe `build && test` reale | scartata: costo senza guadagno di fault-tolerance |
| D | report per-segmento (`PIPESTATUS` strutturato) | nessun peer lo fa per shell libera; il contratto semplice è spiegabile e falsificabile | differita: follow-up se il contratto semplice mostrerà buchi |

Evidenza peer (problema, non marca): `curl | bash` che riporta successo è
`anthropics/claude-code-action#1136`, chiuso con `pipefail`; la nota
«exit-code pitfalls» del 2026-05-20 descrive la stessa classe
`vitest | jq` e raccomanda `pipefail` in testa allo stesso comando. Le
regole di `errexit` sui contesti esenti (`||`, `if`/`while`, `!`) sono del
manuale bash — la gestione esplicita è preservata per costruzione, non per
promessa. Nessun peer riporta esiti per-segmento per shell libera: la
stru­ttura non è lo standard da inseguire.

## Conseguenze

- `core/sandbox/executor.ts`: `STRICT_SHELL_PREFIX`, group-kill in
  `spawnCollect`, una riga di doc su `ExecRequest.command`.
- `agent/tools/shell.ts`: ramo header per `code === null`, una frase di
  contratto in ciascuna descrizione (è ciò che il modello legge per
  scrivere i comandi).
- Flussi che mascheravano fallimenti ora falliscono: è il fix, non una
  regressione. Verificato: nessun comando composto di produzione o di test
  dipendeva dal masking (solo catene `&&` di comandi che riescono).
- `timeoutMs` continua a contenere anche i comandi composti (group-kill);
  l'abort rifiuta subito come prima, senza orfani superstiti.

## Cosa la falsifica

- `core/sandbox/shell-outcome.test.ts` (contenimento reale, entrambe le
  piattaforme come `executor.test.ts`): pipeline, sequenza, fail-fast con
  sentinel, scenario git `;`-separato, timeout con output parziale e bound
  di durata, abort che rifiuta; più le guardie di gestione esplicita
  (`||`, `if`, `!`, `set +e`) che devono restare verdi.
- Mutazione load-bearing: togliere il prefisso fa cadere esattamente i 4
  falsificatori (verificato), nient'altro.
- `agent/tools/shell.test.ts`: il kill da segnale dice «did not complete»,
  non `exit ?`.

## Rischi residui (dichiarati, non rattoppati)

- `cmd | head -n 5` su un produttore infinito ora riporta 141 (SIGPIPE):
  è il destino reale del produttore, e ingoiare 141 sarebbe la stessa
  colpa nell'altra direzione. Dove il troncamento è l'intento, il comando
  lo dice (`… | head -n 5 || true`).
- Command substitution senza `inherit_errexit` (assente su bash 3.2): un
  fallimento interno può ancora nascondersi dietro un successo esterno.
- `{ …; } || fallback` disattiva `errexit` dentro il blocco per regola
  bash: resta gestito esplicitamente dall'`||`, quindi coerente col
  contratto, ma da sapere leggendolo.
- `set +e` nel comando è un opt-out aperto: esplicito, non silenzioso.

## Follow-up esplicito: `git_commit` strutturato (NON implementato qui)

L'outcome fedele dice se il comando ha fallito, non che l'effetto è
avvenuto: «ho committato» resta un'affermazione del modello, non
evidenza. Il target concettuale di un bounded `git_commit` sarebbe —
input `{ cwd, message }`, niente comando libero; esecuzione: HEAD prima
(`rev-parse HEAD`, o ramo non nato), file staged
(`status --porcelain`), `git commit -m`, HEAD dopo + SHA, dirty residui;
`isError` = fallimento del commit, senza interpretazioni.

Non implementato in questa slice, di proposito: è una nuova capability
con riga di policy, semantica di ask (la corsia write chiede sempre),
e modi di fallimento suoi (identità mancante, hook che eseguono codice —
proprio ciò che `nestedGitHooksDirs` contiene —, GPG interattivo che si
pianta). La forma sta sopra; la costruzione è una slice a sé, con i suoi
falsificatori (commit vuoto, hook che fallisce, identità assente).
