# Il difetto è di tipo solo per metà — «riporta successo mentre fallisce», verificato e censito

```
scritto: 2026-08-15
verificato: 2026-08-15
verificato-contro: muffin-agent @ 82214d1 (origin/dev) · node v22.22.2 · git 2.50.1 · typescript (via npx tsc, tsconfig.json di questo repo, strict:true)
modello-strumenti: Sonnet 5 via Claude Code, in un worktree su origin/dev. Eseguito, non solo letto: `npx tsc --noEmit` più volte, inclusi due esperimenti di compilazione mirati (un quinto membro aggiunto a `Decision` in `core/policy/types.ts`, compilato, poi rimosso); `npx vitest run` sui file toccati e sulla suite intera; una prova scratch isolata (fuori repo) per isolare il comportamento di TS2366 dal resto del codice. Il runtime non è stato avviato; nessun `~/.muffin` reale è stato aperto.
invaliderebbe: un consumatore di `Deliver` che non rientra in nessuna delle tre opzioni discusse sotto; una versione di TypeScript che cambia il comportamento di TS2366 sotto `strict`; `cli/doctor.ts` (in riparazione su un'altra sessione mentre questo file viene scritto) se sceglie una forma strutturale diversa da quella raccomandata qui
estende: research/modello-reversibilita.md §1 (identifica per primo l'asimmetria `decide.ts`/`runTool`, stesso giorno, sessione precedente)
```

**Domanda dell'owner**: *«perché questa famiglia di difetti — "riporta successo mentre
fallisce" — continua a nascere? […] sono difetti di tipo, non di disciplina?»*, con
due ipotesi puntuali: `Deliver` non può esprimere «non ho consegnato» perché
ritorna `void`; `doctor` usa una catena di `if` che cade sul ramo verde, mentre
uno `switch` senza `default` romperebbe la build.

**Come leggere le etichette.** ⬤ **misurato** in questa passata, col comando o il
`file:riga` che lo produce. ◐ **letto sulla fonte primaria** (un file di questo
repo, un ADR, la research citata). ○ **riportato**, non ri-verificato qui. La
sezione «Cosa non si è potuto stabilire» è parte del risultato, non una scusa in
coda.

---

## Bottom line

1. **L'ipotesi è vera per metà, e le due metà hanno rimedi diversi** ⬤. La
   dispersione «`switch` esaustivo senza `default`» contro «catena di `if` con
   fallthrough benigno» **è** un difetto di tipo: misurato in entrambe le
   direzioni (§Technical part), rompe la build quando si aggiunge un caso, e ha
   un rimedio meccanico, a costo quasi zero, applicabile ovunque compaia. La
   dispersione dietro `Deliver: (channel, text) => Promise<void>` **non** è
   risolvibile con lo stesso rimedio: TypeScript non ha eccezioni verificate, e
   nessun tipo di funzione può obbligare un'implementazione a lanciare. Il
   rimedio lì è strutturale — spostare la domanda «questo canale è cablato?»
   fuori dalle tre implementazioni e dentro l'unico posto che la deve sapere — e
   costa più di una riga.

2. **`runTool` era il difetto, non un'analogia** ⬤. `research/modello-reversibilita.md`
   §1 lo aveva già nominato leggendo il codice: *"Un esito nuovo che nessuno
   intercetta esegue"* (`agent/loop.ts:649,662,673,698`, sha precedente). Non era
   ancora stato chiuso. In questa slice: un test che dimostra l'esecuzione reale
   del tool su un verdetto sconosciuto (rosso), poi la catena di `if` diventa uno
   `switch (decision.effect)` con `default: return assertNever(decision)` (verde).
   La prova che il rimedio tiene non è letta, è eseguita due volte: un quinto
   membro aggiunto a `Decision` rompe la build **oggi**, puntando esattamente alla
   riga del `default`; rimosso il membro, la build torna pulita — vedi
   §«L'esperimento di compilazione».

3. **`decide.ts` non è protetto per virtù, è protetto per forma** ⬤. Il suo
   `switch (decl.risk)` non ha `default` e non ne ha bisogno: ogni ramo ritorna, e
   la funzione dichiara un tipo di ritorno che esclude `undefined`
   (`Decide = (req) => Decision`, `core/policy/types.ts:98`). Sotto
   `strict: true` questo è **TS2366** — misurato isolando il caso in un
   esperimento scratch fuori repo, non dedotto dalla documentazione del
   compilatore. La forma con `default: assertNever(x)` copre un caso che
   `decide.ts` non incontra (una funzione che non ritorna sempre, come `runTool`,
   che dopo `ask` approvato *continua* invece di ritornare) e per questo è la
   forma generale da raccomandare, non la sua.

4. **Il censimento trova una terza famiglia, non ancora nominata dall'owner: la
   polarità del ramo che conta.** ⬤ `connectors/telegram/connector.ts:263`
   concede l'identità owner solo su un match positivo esplicito
   (`if (outcome.status === 'matched')`); tutto il resto — noto o ignoto — cade
   nel ramo sicuro. `cli/observe.ts:206` filtra i messaggi da inviare con lo
   stesso stile (`.filter(o => o.decision.effect === 'allow')`). `runTool`
   **prima** di questa slice faceva l'opposto: eseguiva il tool per esclusione
   («non è deny, non è draft, non è ask»), non per inclusione. Le due catene di
   `if` di `doctor.ts` e `runTool` condividono questo, non solo l'assenza di
   `switch`: il ramo pericoloso era quello implicito. Un secondo principio,
   indipendente da `assertNever` e a costo zero: **il ramo che esegue o concede
   si scrive per inclusione esplicita, mai per esclusione.**

5. **Il costo di correggere `Deliver` è misurato, non stimato a occhio**: 14
   punti che costruiscono uno `Scheduler` (`grep -rn "new Scheduler("`, contati
   uno per uno), più 10 override inline a forma di `Deliver` nel solo
   `cli/observe.test.ts` (un secondo punto di iniezione, non uno `Scheduler`),
   più le tre implementazioni di produzione stesse — 9 file distinti in totale
   (§«Il costo, misurato»). Tocca inoltre due dei tre file di implementazione
   che un'altra sessione sta modificando in questo momento (`cli/repl.ts`,
   `cli/gateway.ts`). Non è piccolo e sicuro: è la decisione dell'owner
   discussa in §«Tre opzioni per `Deliver`».

---

# Parte concettuale

## Perché lo stesso bug è arrivato tre volte con tre facce diverse

`gatewayDeliver` (`cli/gateway.ts`), il `deliver` del REPL prima del fix di oggi
(`cli/repl.ts`, commit `de1c10e`), e `cli/doctor.ts` sul caso `'error'` sembrano
tre bug indipendenti perché toccano tre file, tre superfici, tre linguaggi di
dominio (consegna, diagnostica). Letti insieme sono due forme, non tre:

- **Forma A — un valore che dovrebbe fallire e invece tace.** `Deliver` ritorna
  `Promise<void>`; l'unico modo di dire «non ho consegnato» è lanciare, e
  lanciare non è nel tipo, è nella prosa del commento. Due implementazioni su
  tre se lo sono ricordate (`printDeliver`, poi `makeReplDeliver` dopo il fix di
  oggi); una no (`gatewayDeliver`, ancora, mentre questo file viene scritto —
  in riparazione altrove).
- **Forma B — un'unione chiusa letta con `if`/`else`, e l'ultimo ramo è quello
  buono.** `ConsolidationOutcome` ha quattro valori; `doctor.ts` tratta `'budget'`
  a parte e fa cadere `'ran' | 'busy' | 'error'` nello stesso `else`, che stampa
  verde. `runTool` aveva la stessa forma su `Decision['effect']`, e l'ha avuta
  almeno due volte: una volta con `draft` (chiuso prima di questa slice, la
  parentesi in `research/modello-reversibilita.md` lo racconta), una volta —
  fino a questa slice — con qualunque quinto valore futuro.

Le due forme condividono il sintomo (un fallimento diventa un successo agli occhi
di chi guarda) ma non il meccanismo, e quindi non condividono il rimedio. La
domanda dell'owner — «sono difetti di tipo?» — ha risposta diversa per ciascuna.

## Forma B: sì, è un difetto di tipo, e il rimedio è meccanico

Uno `switch` sulla stessa unione chiusa, con un `default` che chiama
`assertNever(x: never)`, rende **rappresentabile nel tipo** l'invariante che
prima viveva solo nella testa di chi scriveva il ramo finale. Non serve che la
funzione ritorni un valore (il vincolo di `decide.ts`): `assertNever` funziona
anche dentro una funzione con `break`/`continue`, perché il compilatore controlla
il tipo dell'argomento passato a `default`, non la forma della funzione che lo
contiene. Questo è il motivo per cui `runTool` — che dopo `ask` approvato
*non* ritorna, continua verso l'esecuzione — poteva **non** essere protetto dalla
stessa proprietà che protegge `decide.ts` (nessun `default`, tipo di ritorno non
`void`) e **poteva** essere protetto da `assertNever` in un `default` esplicito.
Le due tecniche sono parenti, non la stessa: quella di `decide.ts` è gratis ma
si applica solo a funzioni "pure return"; quella con `assertNever` costa una
riga (l'helper) e si applica ovunque.

## Forma A: no, non allo stesso modo — TypeScript non ha eccezioni verificate

Un `Deliver` che *deve* lanciare per dire «non consegnato» non ha, nel tipo
`(channel, text) => Promise<void>`, nessun segnale che lo richieda. Non esiste in
TypeScript un modo di scrivere «questa funzione può lanciare `X`» che il
compilatore verifichi — a differenza di uno `switch` esaustivo, dove il
compilatore *deve* seguire ogni ramo per calcolare il tipo di ritorno. Rendere
questo rappresentabile richiede cambiare la **forma del valore restituito**, non
aggiungere un controllo: il fallimento deve diventare un valore che il chiamante
riceve, non un evento che deve ricordarsi di intercettare. È un cambio di
contratto, non un annotazione in più — vedi §«Tre opzioni per `Deliver`» nella
parte tecnica per il costo misurato.

## Una terza cosa emersa cercando la prima due: la polarità del ramo

Il censimento (§Technical part, tabella) nota una regolarità che l'ipotesi
dell'owner non nominava: in ogni istanza **sicura** trovata, il ramo che compie
l'azione consequenziale (concedere l'identità owner, eseguire il tool, marcare
verde) è raggiunto per **corrispondenza positiva esplicita** su un valore
specifico. In ogni istanza **difettosa**, quel ramo è raggiunto per **esclusione**
— «non è nessuno dei casi che conosco come cattivi» — che è un'altra maniera di
dire «il ramo di default è quello pericoloso». `assertNever` chiude la seconda
forma rendendo l'esclusione un errore di compilazione; scrivere il ramo
consequenziale per inclusione lo chiude anche senza `assertNever`, ed è gratis
oggi stesso — non richiede toccare un tipo, solo l'ordine in cui `runTool` (già
fatto, in questa slice) o un futuro consumatore verificano la condizione.
Non è un'alternativa ad `assertNever`: sono complementari, e insieme coprono
anche il caso — non incontrato qui, ma non escluso — di un `if`/`else` a due rami
dove nessuno dei due è ovviamente «quello sicuro».

## Cosa NON è la stessa famiglia — scartato di proposito

- **Gli ascoltatori di eventi selettivi.** `cli/repl.ts:233` e `cli/gateway.ts:323`
  controllano `if (e.kind === 'delivery_failed')` su `SchedulerEvent` (cinque
  varianti) senza gestire le altre quattro. Non è lo stesso difetto: un
  ascoltatore che ignora gli eventi che non gli servono non sta **decidendo se
  qualcosa è permesso o riuscito**, sta scegliendo a cosa reagire. Nessun ramo
  implicito qui nasconde un successo — gli eventi ignorati restano quello che
  erano, non diventano un esito diverso.
- **Le unioni discriminate su booleano.** `VerifyOutcome` (due file diversi,
  `core/rot/verify.ts:36` e `core/mcp/registry.ts:120`) ha `ok: true | ok:
  false`. Un `if (outcome.ok)` su un booleano è esaustivo per costruzione: non
  esiste un terzo valore di `boolean`. Il rischio della Forma B richiede
  un'unione che possa *crescere*; un discriminante booleano non cresce senza
  cambiare il campo stesso, un evento molto più rumoroso di aggiungere una
  stringa a un'unione di stringhe.
- **`mapStopReason` (`agent/providers/anthropic.ts:168`,
  `agent/providers/openai-compat.ts:258`).** Il `default: return 'end'` qui
  esiste perché l'input è una stringa **esterna**, non un'unione TypeScript — il
  formato del provider — quindi un `default` non è evitabile, è imposto dal
  mondo. Il difetto potenziale è diverso e più piccolo: mappare uno stop reason
  sconosciuto sulla lettura *ottimista* (`'end'`, fine pulita) invece che su
  quella *pessimista* (`'error'`, qualcosa di anomalo). Stessa polarità della
  Forma B, meccanismo diverso (non esiste uno `switch` esaustivo possibile
  contro un `string | null` arbitrario), rimedio diverso (cambiare il valore del
  `default`, non introdurre `assertNever`). Non toccato in questa slice.
- **`core/gateway/notify.ts`.** Un fallimento di trasporto sd_notify **è**
  registrato (`failure` nella chiusura di `createNotifier`) e **è** letto una
  volta, subito dopo `ready()` (`core/gateway/service.ts:362`). Non riporta
  successo mentre fallisce — il file dichiara esplicitamente la regola 3 nel suo
  stesso commento di testa. Quello che non fa è ricontrollare `problem()` dopo
  ogni `watchdog()` successivo: un trasporto che si rompe a metà sessione resta
  silenzioso finché systemd non uccide il processo per il watchdog mancato, il
  che **è** comunque visibile (un crash, non un successo finto) solo non con la
  causa scritta accanto. È la famiglia «dichiarato e non collegato», non questa
  — nominato qui solo perché il grep lo ha portato a galla, non incluso nel
  censimento della tabella.

## Raccomandazione

**Fare subito, a costo quasi zero** (valutato «piccolo e sicuro» — fatto in
questa slice dove il file non era già in modifica altrove):

1. `assertNever` come convenzione per ogni `switch` su un'unione chiusa che
   governa una decisione consequenziale (esegue, concede, marca). Un'unica
   funzione, oggi locale a `agent/loop.ts:692`; da promuovere a un modulo
   condiviso (`core/util.ts` non esiste ancora — da creare) nel momento in cui
   un secondo file ne ha bisogno. `cli/doctor.ts` è il prossimo candidato
   naturale, quando la sessione che lo sta riparando converge: la stessa forma
   chiuderebbe il `'error'` di oggi **e** ogni quinto valore futuro di
   `ConsolidationOutcome`, non solo quello nominato.
2. Scrivere per inclusione, non per esclusione, ogni volta che un ramo compie
   l'azione consequenziale di una decisione a unione chiusa. Gratis, zero
   rischio, non richiede toccare un tipo.

**Decisione dell'owner, non "piccola e sicura"**: quale delle tre opzioni in
§«Tre opzioni per `Deliver`» adottare, e quando — dato che le prime due toccano
file oggi in modifica su altre sessioni (`cli/repl.ts`, `cli/gateway.ts`) e tutte
e tre toccano almeno una decina di punti di test. Nessuna implementata qui.

---

# Technical part

Terminology, fixed for this part: **closed union** = a TypeScript union of
literal types with a fixed, enumerable member set (e.g. `'a' | 'b' | 'c'`, or a
discriminated union on such a field). **exhaustive switch** = a `switch` whose
`case`s cover every member of a closed union, verifiable by the compiler.
**benign fallthrough** = a branch reached by elimination (not by a positive
match) that is treated as success/allow/ok.

## The empirical result: both directions of the hypothesis, executed

**Direction 1 — an exhaustive switch with a non-`void` return type breaks the
build when the union grows.** Isolated outside the repo, same compiler flags as
`tsconfig.json`:

```ts
type Risk = 'low' | 'medium' | 'high' | 'critical';
type Decision = { effect: 'allow' } | { effect: 'deny' };
function decide(risk: Risk): Decision {
  switch (risk) {
    case 'low': return { effect: 'allow' };
    case 'medium': return { effect: 'allow' };
    case 'high': return { effect: 'deny' };
  }
  // no case for 'critical', no default, no trailing return
}
```

`npx tsc --noEmit` against this repo's exact `compilerOptions` (`strict: true`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `skipLibCheck`) ⬤:

```
switch-case.ts(4,30): error TS2366: Function lacks ending return statement and
return type does not include 'undefined'.
```

TS2366, not TS7030 (`noImplicitReturns`, not set in this repo's `tsconfig.json`
— confirmed by reading the file, no such key present). TS2366 fires under
`strictNullChecks` alone (part of `strict`) whenever a non-`undefined`-inclusive
return type meets a code path that falls off the end of the function. This is
why `core/policy/decide.ts`'s `switch (decl.risk)` is safe with **no** `default`
and **no** `assertNever`: its enclosing function's return type is `Decision`
(`Decide = (req: DecisionRequest) => Decision`, `core/policy/types.ts:98`), never
`undefined`, and every existing case returns.

**Direction 2 — an if-chain with an implicit fallthrough does not break the
build when the union grows**, confirmed with the mirror case:

```ts
type Decision = { effect: 'allow' } | { effect: 'ask' } | { effect: 'draft' }
  | { effect: 'deny' } | { effect: 'quarantine' }; // pretend a 5th verdict landed
async function runToolLike(): Promise<string> {
  const decision = getDecision();
  if (decision.effect === 'deny') return 'refused';
  if (decision.effect === 'draft') return 'draft unavailable';
  if (decision.effect === 'ask') return 'asked';
  return 'EXECUTED THE TOOL'; // no branch for 'quarantine'
}
```

`npx tsc --noEmit`, same flags: exit 0, no diagnostics.

**Direction 3 — the actual fix, verified against the real type, not a toy.**
Before touching `agent/loop.ts`, a test constructed a `decide` returning
`{ effect: 'quarantine' }` (cast through `unknown`, simulating a kernel/loop
version mismatch — `decide` is dependency-injected via `LoopDeps`) and asserted
the tool did not run:

```
agent/loop.test.ts > refuses a policy verdict it does not recognise…
  AssertionError: expected [ 'demo_unknown' ] to deeply equal []
```

Confirmed red: the tool executed. After converting `runTool`'s `if`-chain to
`switch (decision.effect) { … default: return assertNever(decision); }`
(`agent/loop.ts:768-821`, helper at `:692`), the same test is green — the turn
rejects with `unreachable: unhandled variant {"effect":"quarantine"}` instead of
running the tool.

Then the type-level guarantee itself, not just the runtime test, was executed
against the real production type: `core/policy/types.ts`'s `Decision` was
temporarily given a fifth member (`quarantine_experiment_do_not_commit`) and
`npx tsc --noEmit` was run against the whole repo:

```
agent/loop.ts(820,26): error TS2345: Argument of type
'{ effect: "quarantine_experiment_do_not_commit"; }' is not assignable to
parameter of type 'never'.
```

One error, pointing exactly at `default: return assertNever(decision);`. No
other file broke — `cli/observe.ts`'s `d.effect === 'skip' | 'deny' | 'defer'`
matches a *different* type (`core/scheduler/observe.ts`'s `Observation.decision`,
confirmed by import trace, not `core/policy/types.ts`'s `Decision`), so it was
correctly unaffected. The member was then removed and `npx tsc --noEmit`
confirmed clean again (exit 0) before anything was committed.

Full `agent/loop.test.ts`: 41/41 passing after the change, including the three
pre-existing tests for `deny`, `draft`, and the `ask`-then-approved path —
the switch preserves every existing behaviour; it only closes the branch that
had none.

## Census: closed unions, and how each is consumed

| Union | Members | File:line | Dispatch | Benign fallthrough? |
|---|---|---|---|---|
| `RiskClass` | 3 | `core/policy/types.ts:73` | `switch`, no `default`, non-`void` return | No — TS2366 protects it (Direction 1) |
| `Decision['effect']` | 4 | `core/policy/types.ts:56-60` | **was** `if`-chain (`agent/loop.ts`, pre-fix); now `switch` + `assertNever` | **Was yes** (Direction 2); closed this slice |
| `ConsolidationOutcome` | 4 | `core/memory/consolidator.ts:259` | `cli/doctor.ts:311-326`: `if`/`else`, final `else` is `ok()` | **Yes**, on `'error'` — reported by the owner, fix in progress on another session as this is written |
| `ConsolidationOutcome` | 4 | (same) | `cli/memory.ts:398-411`: ternary chain, final branch is `'fallito'` | No — defaults to reporting failure, the safe direction, though still not compiler-checked |
| `PairingOutcome['status']` | 4 | `core/config/pairing.ts:81-85` | `connectors/telegram/connector.ts:263`: positive match on `'matched'` only | No — consequential branch is the explicit match |
| `ProactiveDecision['effect']` (extended with `'skip'` in `Observation`) | 3 (+1) | `core/scheduler/proactivity.ts:106-109`, `core/scheduler/observe.ts` | `cli/observe.ts:79-88` (display text, `verdict()`); `:206` (`.filter(...==='allow')`, the actual gate) | Display fallback only, cosmetic; the actual send-gate (`:206`) matches positively |
| `VerifyOutcome` (RoT) | 2 (boolean-discriminated) | `core/rot/verify.ts:36-45` | `cli/doctor.ts:126-133`: `if (rot.ok) … else if (rot.action==='refuse') … else` | Structurally low-risk: `ok` is `boolean`, cannot silently grow a third value |
| `VerifyOutcome` (MCP) | 2 (boolean-discriminated) | `core/mcp/registry.ts:120-122` | boolean-discriminated, same shape as above | Structurally low-risk |
| `JobOutcome['stopped']` | 6 | `core/scheduler/scheduler.ts:43-48` | `agent/loop.ts:668`: `stopped === 'error' ? 'error' : 'ok'` (tracing status only) | Weak instance: collapses `cap`/`aborted`/`ask` into `'ok'` for an OTel-style binary span status, not a security gate. Not touched. |
| `SchedulerEvent['kind']` | 5 | `core/scheduler/scheduler.ts:71-77` | `cli/repl.ts:233`, `cli/gateway.ts:323`: single `if` on `'delivery_failed'` | Not the same family — selective event listener, not a permission/success gate (see Parte concettuale) |

## Census: `void`/`Promise<void>` callback types

| Type | File:line | Failure signalling | Consequential? |
|---|---|---|---|
| `Deliver` | `core/scheduler/scheduler.ts:54` | Must throw; nothing in the type says so | Yes — `markRan` advances the job regardless (by design); only a throw produces `delivery_failed` |
| `NotifySink` | `core/gateway/notify.ts:61` | Must throw; caught by `createNotifier`'s `send()`, stored in `failure`, read once via `problem()` | Partially — see Parte concettuale, "NOT the same family" |
| `LockOutcome['release']` | `core/lock/durable.ts:38` | N/A — release is best-effort by nature (process is exiting or dropping the lock either way) | No |
| `Composed['record']` | `core/scheduler/observe.ts:53` | Not investigated in this pass — out of scope, flagged in "Cosa non si è potuto stabilire" | Unknown |

`Deliver` is the only entry in this table with a **consequential, silent-by-type**
failure mode that is not already caught elsewhere.

## The cost, measured: every `Deliver`-shaped call site

```
grep -rn "new Scheduler(" --include="*.ts" . | grep -v node_modules | wc -l
```
→ **14** call sites, in 6 files: `evals/system/scheduler.test.ts` (1),
`core/scheduler/scheduler.test.ts` (7), `core/gateway/service.test.ts` (2),
`cli/repl.ts` (1), `cli/gateway.test.ts` (2), `cli/gateway.ts` (1).

```
grep -c "deliver: async (_c, t)" cli/observe.test.ts
```
→ **10**, all in `cli/observe.test.ts` — a separate injection point from
`Scheduler`'s constructor argument: `cmdObserve`'s own `deliver` override
(`cli/observe.ts:40`), not counted in the 14 above.

Deduplicated union of files touched by either grep: `evals/system/scheduler.test.ts`,
`core/scheduler/scheduler.test.ts` (the test file — 7 of the 14 call sites live
here), `core/gateway/service.test.ts`, `cli/repl.ts`, `cli/gateway.ts`,
`cli/gateway.test.ts`, `cli/observe.test.ts` — **7 files**. Neither grep can see
a file that *defines* `Deliver`'s shape without constructing a `Scheduler` or
writing an inline arrow of that shape, so two more must be added by direct
read: `core/scheduler/scheduler.ts` itself (the type declaration, and the
`Scheduler` class's own handling of `this.deliver` — distinct from
`core/scheduler/scheduler.test.ts`, which only calls it) and `cli/observe.ts`
(`printDeliver`'s definition, confirmed absent from both grep patterns).
**9 files in total** would need a signature-shaped edit under Option B or
Option C below (§Three options). Two of the three production implementation
files (`cli/repl.ts`, `cli/gateway.ts`) are under concurrent edit on other
sessions as this is written. This is the number behind "not small, not safe
right now" in the Bottom line.

## Three options for `Deliver`, with cost

The codebase's own dominant idiom for "what happened" is already a tagged
outcome union, not a throw: `VerifyOutcome` (two independent definitions, RoT
and MCP), `PairingOutcome`, `ConsolidationOutcome`, `ProactiveDecision`, and
`Decision` itself all return a discriminated union rather than throwing to
signal an alternate outcome — 8 non-test files each declare one
(`grep -rln "Outcome =" --include="*.ts" core/ agent/ cli/`, excluding tests).
Locking goes further and shares **one** reusable type across independent
call sites instead of one-per-file: `LockOutcome` (`core/lock/durable.ts:38`)
is defined once and returned by `acquire`/`claim` in four different files
(`core/gateway/lock.ts:95`, `core/scheduler/sendlock.ts:113`,
`core/memory/ingest-lock.ts:93`, `core/memory/store.ts:213`) — the exact
shape a shared `DeliveryResult` under Option B, or the `supports`/`send` split
under Option C, would take for `Deliver`. `Deliver`'s throw-to-signal-failure
is the outlier, not the house style, and the precedent for fixing it by
sharing one type rather than inventing a new pattern already exists in this
codebase.

**Option A — de-duplicate, do not retype.** Extract the "channel not wired"
behaviour into one function (e.g. `unwiredChannel(channel, text): never` in
`core/scheduler/scheduler.ts`, printing to stderr and throwing), called by all
three implementations for their non-`cli` branch. *Cost*: 3 files, no signature
change, no test call site touched. *Closes*: the "3 independent chances to
forget" down to "1 shared implementation." *Does not close*: a fourth,
future `Deliver` implementation can still hand-roll the bug from scratch —
nothing in the type stops it.

**Option B — `Deliver` returns a result union.**
`type DeliveryResult = { delivered: true } | { delivered: false; reason: string }`;
`Deliver = (channel, text) => Promise<DeliveryResult>`. Every implementation
must construct one or the other explicitly; `Scheduler.run()` switches on
`.delivered` (itself two-armed and protectable with `assertNever`) instead of
try/catch. *Cost*: the ~9 files above, all `new Scheduler(...)` call sites, all
inline delivers. *Gains*: the "did it work" fact becomes an inspectable value
— a lazy implementation hard-coding `{ delivered: true }` is a visibly wrong
line in review, where a bare `return;` was not. *Does not fully close*: nothing
stops that hard-coded `true` either; the gain is legibility, not a hard
guarantee.

**Option C — split the question from the action.**
`Deliver = { supports(channel: string): boolean; send(channel, text): Promise<void> }`.
`Scheduler.run()` checks `supports()` **before** calling `send()` and raises
`delivery_failed` itself when it is false; `send()` keeps `Promise<void>` and
its own try/catch for genuine transport failures on channels that *are*
supported. *Cost*: same order of magnitude as Option B. *Gains*: the
"is this channel real" fact moves out of three separate imperative duties and
into one required, trivially-correct boolean field that the **consumer**
(`Scheduler`, the one place that needs the guarantee) enforces — no
implementation can omit it, because there is nothing to remember to throw for
the "not wired" case any more. This is also the natural seam for the M4 remote
connect: wiring Telegram delivery becomes "flip `supports('telegram')` to
`true` and implement `send`," not "delete a throw and hope."

No option was implemented in this slice. Option A is low-risk enough to be
"small and safe" on its own, but was left out because it still touches
`cli/repl.ts` and `cli/gateway.ts`, both under concurrent edit as this was
written; it is the cheapest safe follow-up once those land. Options B and C are
the owner's decision named in the Bottom line.

---

## Cosa non si è potuto stabilire

1. **Se `Composed['record']` (`core/scheduler/observe.ts:53`) nasconda un
   fallimento allo stesso modo di `Deliver`.** È un `() => void` chiamato dopo
   una consegna riuscita in `cli/observe.ts:231` per registrare l'episodio. Non
   è stato letto il suo produttore né verificato se un fallimento della
   scrittura vada perso. Fuori dal censimento di questa passata per tempo, non
   per giudizio che sia innocuo.

2. **Quanti altri consumer di unioni chiuse esistono fuori da `core/`, `agent/`,
   `cli/`.** Il censimento ha usato grep mirati su pattern (`.effect ===`,
   `.outcome ===`, `.kind ===`, `.status ===`) e sull'elenco dei tipi
   `export type X = | …`. Un consumer che pattern-matcha senza usare `===` (per
   esempio un lookup in una mappa con fallback) non sarebbe emerso da questi
   grep. `connectors/telegram/` oltre a `connector.ts` non è stato ispezionato
   riga per riga.

3. **Se TS2366 sia documentato come stabile fra versioni minori di TypeScript,
   o sia un dettaglio implementativo.** Il comportamento è stato misurato contro
   la versione risolta da `npx tsc` in questo worktree in questo momento, non
   contro il changelog ufficiale del compilatore. Un futuro bump di
   `typescript` in `package.json` potrebbe cambiare quale diagnostica scatta
   (restarebbe comunque un errore, quasi certamente — ma il codice esatto non è
   garantito da questa passata).

4. **Il costo reale di Option B contro Option C in ore, non in file contati.**
   Il conteggio dei punti di chiamata (§«Il costo, misurato») è un limite
   inferiore sul lavoro meccanico, non una stima di quanto ci vorrebbe a
   scriverlo e rivederlo. Nessuna delle due opzioni è stata prototipata.

5. **Se `cli/doctor.ts` verrà chiuso con la stessa forma (`switch` +
   `assertNever`) raccomandata qui, o con una diversa.** La sessione che lo sta
   riparando non condivide questo file mentre viene scritto; la raccomandazione
   al punto 1 della Bottom line presume che convergano, ma non è verificato.
