# La forma del repo — analisi misurata, non rifattorizzazione

**Data:** 2026-09-04 · **Stato:** evidence, proposta — nessuna riga di codice
prodotto sposta un file esistente. **Head:** `slice/forma-del-repo` da
`origin/dev` `91b9528`. Nessun file spostato, nessuna issue GitHub aperta.

Ogni numero qui sotto è prodotto eseguendo un comando su questo albero, oggi,
con `npm ci` fresco (il worktree non aveva `node_modules` reale — il symlink
suggerito nel mandato punta a un checkout la cui `node_modules` è vuota: vedi
§11 per il comando che rimedia). Il metodo di ogni misura è dichiarato dove non
è ovvio, incluso dove il campione è parziale.

## 0. I numeri di partenza, riverificati

```sh
$ find agent core cli -name "*.ts" ! -name "*.test.ts" -exec cat {} + | wc -l
51111
$ find agent core cli -name "*.ts" ! -name "*.test.ts" -exec grep -c "^\s*//\|^\s*\*\|^\s*/\*" {} + \
  | awk -F: '{s+=$2} END {print s}'
23551
$ find agent core cli connectors evals defaults scripts -name "*.ts" ! -name "*.test.ts" | wc -l
216
$ find . -name "*.test.ts" -not -path "*/node_modules/*" -not -path "*/.releases/*" \
    -not -path "*/.codex/*" -not -path "*/.claude/worktrees/*" -not -path "*/.gate-linux/*" | wc -l
249
```

**Tutti e quattro tornano esatti dopo un `git fetch`/`merge --ff-only` a
`origin/dev` `91b9528`** ("a credential does not leave by any door", #351,
integrato durante questa stessa sessione): 51.111 righe non-test, 23.551
commenti (46,08%), 216 file sorgente in `agent/core/cli/connectors/evals/
defaults/scripts` e **249** file di test sull'intero albero (la stessa cifra
dichiarata). `npx vitest run` per intero, sullo stesso HEAD: **249 file di
test, 3184 passati e 3 skippati (3187)** — anche questo esatto rispetto al
mattino. La misura del mandato regge, verificata di nuovo a poche ore di
distanza e dopo un merge reale, non solo al momento in cui è stata scritta.

---

# A. La forma dei test

## A.1 Quanto, dove

```sh
$ for d in agent core cli connectors evals; do
    src=$(find $d -name "*.ts" ! -name "*.test.ts" | wc -l)
    test=$(find $d -name "*.test.ts" | wc -l)
    echo "$d: src=$src test=$test"
  done
agent:      src=39 test=68
core:       src=84 test=85
cli:        src=31 test=35
connectors: src=18 test=35
evals:      src=44 test=13
```

`agent` e `connectors` hanno **quasi due file di test per file sorgente**
(1,74× e 1,94×); `core` è vicino a 1:1; `evals` è invertito (13 test contro 44
file), coerente col suo ruolo — è codice di harness/scenario, non modulo
applicativo, e i suoi consumatori sono gli scenari di accettazione, non
`vitest` da solo.

## A.2 Quanti file di test superano il loro sorgente

```sh
$ for f in $(find agent core cli connectors -name "*.test.ts"); do
    src="${f%.test.ts}.ts"
    [ -f "$src" ] || continue
    tl=$(wc -l < "$f"); sl=$(wc -l < "$src")
    [ "$tl" -gt "$sl" ] && echo "$f $tl $sl"
  done | wc -l
50
```

Su **139 coppie co-locate** (stesso nome, stessa cartella, sorgente e test
entrambi presenti), **50 (36%)** hanno un file di test più lungo del suo
sorgente. I casi più estremi, misurati:

| file di test | righe test | righe sorgente | rapporto |
|---|---|---|---|
| `cli/observe.test.ts` | 647 | 275 | 2,4× |
| `core/scheduler/sendlock.test.ts` | 268 | 126 | 2,1× |
| `core/audio/voce.test.ts` | 125 | 59 | 2,1× |
| `core/turns/lane.test.ts` | 486 | 251 | 1,9× |
| `core/memory/ingest.test.ts` | 1321 | 721 | 1,8× |
| `cli/doctor.test.ts` | 1862 | 1491 | 1,2× (il più grande in assoluto) |
| `cli/gateway.test.ts` | 1253 | 981 | 1,3× |

Questo non è di per sé un difetto — un modulo che governa concorrenza o RoT
merita più scene di quante righe abbia l'implementazione — ma è la metrica
onesta che il mandato chiedeva, ed è quella su cui vale la pena tornare, non
la cartella in cui il file vive (§A.5).

## A.3 Test che provano il computer di chi li esegue

Il progetto nomina già questa classe di guasto (memoria di sessione: *«test
che provano il mio computer»* — verdi per sempre perché codificano config git
globale, quale `script` c'è, che errno dà il socket). Misurato oggi, è ancora
vero, non una scoperta nuova:

```sh
$ grep -rln "execSync('git config\|homedir()\|os.userInfo" --include="*.test.ts" agent core cli connectors
core/sandbox/probe.test.ts
cli/init.test.ts

$ grep -rln "skipIf" --include="*.test.ts" agent core cli connectors
core/rot/egress-writer.test.ts
core/rot/verify.test.ts
core/rot/harden.test.ts
cli/main.test.ts
```

Sei file, non zero. Non è materia per una riorganizzazione di cartelle — è
materia per una revisione dedicata di quei sei file, fuori da questo scope.

## A.4 Come lo fanno progetti TypeScript reali

**Documentazione ufficiale di Vitest:** la guida non prescrive una posizione.
L'unico requisito è che il nome del file contenga `.test.` o `.spec.`; gli
esempi della guida mostrano `sum.js`/`sum.test.js` nella stessa cartella, ma a
titolo illustrativo, non normativo. Vitest è strutturalmente indifferente alla
domanda che il mandato pone.

**Tre repository reali, letti eseguendo `gh api` contro GitHub, non a
memoria:**

- **`colinhacks/zod`** — dipendenza diretta di questo repository
  (`package.json`). I test vivono **dentro** l'albero sorgente, in
  sottocartelle `tests/` accanto ai moduli che coprono
  (`packages/zod/src/v4/classic/tests/array.test.ts` eccetera): co-locati, non
  in un albero parallelo.
- **`trpc/trpc`** — ibrido misurato: unit test co-locati per file
  (`packages/server/src/observable/operators.test.ts`,
  `packages/server/src/unstable-core-do-not-import/router.test.ts`) **più**
  una cartella `__tests__/` separata per i test che attraversano più moduli.
- **`sst/opencode`** — un agente di coding CLI in TypeScript, il peer più
  comparabile per dominio fra i tre. Non usa Vitest (usa `bun test`), ma la
  sua struttura conferma lo stesso pattern osservato altrove: codice e
  strumenti di verifica vicini, con una toolchain dichiarata esplicitamente
  (`.oxlintrc.json`, `.prettierignore`, `.editorconfig`, `.husky/`) — rilevante
  soprattutto per la Parte D/E, vedi sotto.

**Il verdetto misurato:** ciò che Muffin fa oggi — unit test co-locati per
`agent/`, `core/`, `cli/`, `connectors/`, più `evals/` come cartella dedicata
per accettazione/e2e/system/character/security — è **esattamente** il pattern
ibrido che i due repository TypeScript più comparabili (uno dei quali è una
dipendenza diretta) già usano. Non è una scelta idiosincratica da giustificare;
è la convenzione maggioritaria fra i pari.

## A.5 Cosa costerebbe spostarli — misurato, non assunto

Tre agganci concreti, verificati:

1. **`vitest.config.ts` non ha un `include` esplicito** — solo un `exclude`
   derivato da cosa Git ignora (`vitest.ignored.ts`). Vitest userebbe il suo
   default (`**/*.test.ts`) ovunque i file finissero. **Zero modifiche a
   `vitest.config.ts`** sarebbero necessarie per un trasloco.
2. **Le ancore della mappa dell'architettura.** `docs/derived/architecture-map/ancore.mjs`
   tiene una chiave per citazione, e il suo stesso commento (righe 209-221)
   dice che chi sposta un file citato deve rimappare `path` a mano, o
   l'ancora perde il testo registrato. Contati oggi:
   ```sh
   $ python3 -c "import json; d=json.load(open('docs/derived/architecture-map/ancore.json')); \
     p=[v['path'] for v in d.values() if isinstance(v,dict) and 'path' in v]; \
     print(len(p), len([x for x in p if '.test.ts' in x]))"
   588 7
   ```
   Su 588 ancore totali, **7** puntano a un file di test. Rimapparle a mano è
   un pomeriggio, non una migrazione.
3. **CI.** `.github/workflows/ci.yml` e `accettazione.yml` non hanno filtri
   `paths:`; girano su ogni push. L'unico workflow con filtri di path
   (`strumenti.yml`) è ristretto a `.claude/**` e non tocca `agent/core/cli`.
   **Zero modifiche CI.**

**Costo reale: basso** (un pomeriggio, sette ancore, zero config). Ma il
beneficio non è stato trovato: Vitest è indifferente, i due pari più
comparabili co-locano, e la co-locazione è ciò che rende — per la stessa
ragione data da `typescript.tv` e riconfermata guardando `zod`/`trpc` — un
file spostato o rinominato a portare con sé il proprio test senza una seconda
modifica altrove. **Raccomandazione: non spostare.** Il problema reale
misurato non è la cartella, è la dimensione di 50 file di test (§A.2): quello
merita una revisione dedicata, fuori da questo scope.

---

# B. La dispersione — duplicazioni vere, misurate con `grep` e `knip`

## B.1 File ed export che nessuno importa (`knip`, eseguito)

```sh
$ npx knip
Unused files (1)
docs/derived/architecture-map/post-merge-regen.mjs

Unused exports (26)      Unused exported types (15)
```

Un file morto, 26 export morti, 15 tipi esportati morti — l'elenco completo è
riprodotto in §11. Non tutti sono dispersione: alcuni (`ConfigSchema`,
`SECRET_BACKENDS`) sono probabilmente pensati per un consumatore che non
esiste ancora. Ma è un elenco eseguibile, non un'impressione, e `knip.json`
esiste già in questo repository — nessuno strumento nuovo da adottare, solo
da far girare e leggere.

## B.2 `sleep()`, duplicata quattro volte, non dichiarata

```sh
$ grep -n "function sleep\b" agent/loop.ts connectors/discord/api.ts \
    connectors/telegram/api.ts connectors/telegram/connector.ts
agent/loop.ts:3915:               function sleep(ms: number, signal?: AbortSignal): Promise<void>
connectors/telegram/connector.ts:1891:  function sleep(ms: number, signal?: AbortSignal): Promise<void>
connectors/discord/api.ts:273:          function sleep(ms: number): Promise<void>
connectors/telegram/api.ts:408:         function sleep(ms: number): Promise<void>
```

Due varianti identiche a coppie: la forma abortable (`agent/loop.ts` ↔
`connectors/telegram/connector.ts`, stesso corpo) e la forma semplice
(`discord/api.ts` ↔ `telegram/api.ts`, stesso corpo, `new Promise((resolve) =>
setTimeout(resolve, ms))`). **Nessun commento giustifica la ripetizione** — a
differenza del prossimo caso. Costo di consolidare: basso — funzione pura, un
file di utilità condiviso (`agent/util.ts` o simile), quattro `import` al
posto di quattro dichiarazioni.

## B.3 `backoffMs()`, duplicata due volte — ma questa è dichiarata

```sh
$ sed -n '1902,1912p' connectors/telegram/connector.ts
/**
 * Backoff for the `getMe()` reconnect loop. Capped, with jitter [...]
 * Same shape as `connectors/discord/gateway.ts`'s own `backoffMs`, kept
 * local rather than shared: two three-line functions across two connectors
 * is not yet a module.
 */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return base + Math.floor(Math.random() * 1000);
}
```

`connectors/discord/gateway.ts:164` ha **lo stesso corpo, byte per byte**. A
differenza di §B.2, qui il codice **dichiara di sapere** di duplicare, e dà una
soglia esplicita di quando smetterebbe di valerne la pena ("non ancora un
modulo"). Non lo segnalo come oversight: lo segnalo come **domanda di
convenzione aperta e mai risposta** — quale soglia fa scattare l'estrazione?
Lo stesso file cita un terzo caso dello stesso pattern (`testStall`, fra
`connectors/telegram/connector.ts` e `agent/scheduler-run.ts`). Tre istanze
della stessa policy non scritta in nessun posto valgono una riga in una guida
di stile, non una PR di refactoring.

## B.4 Direttive `eslint-disable` orfane — anticipa la Parte D/E

```sh
$ grep -rn "eslint-disable" --include="*.ts" agent core cli connectors | grep -v node_modules
agent/tool-phrase.ts:102:        // eslint-disable-next-line no-control-regex
core/memory/ingest.test.ts:477:  // eslint-disable-next-line no-control-regex -- asserting these are gone
core/memory/judge.ts:168:        // eslint-disable-next-line no-control-regex -- deliberately matching C0/DEL
cli/textzone.ts:84:              // eslint-disable-next-line no-control-regex
```

Quattro direttive per un linter **che non esiste in questo repository**
(confermato in Parte D). Non sono duplicazione di logica — le tre funzioni
sotto fanno cose diverse (spianare una frase, misurare la larghezza visibile
ANSI, ripulire una risposta grezza del modello) — ma sono un prosa-morta
concreta: un commento che promette una soppressione che nessuno strumento
legge mai. Torna in Parte E come nono caso di deriva, distinto dagli otto
dell'owner.

---

# C. Issue e task su GitHub

## C.1 Stato misurato

```sh
$ gh --version
gh version 2.89.0 (2026-03-26)
$ gh auth status
✓ Logged in to github.com account GiustoPiedimonte (keyring)
  Token scopes: 'gist', 'read:org', 'repo'
$ gh repo view --json visibility,defaultBranchRef -q '.visibility, .defaultBranchRef.name'
PRIVATE
main
$ gh issue list --state all --limit 10   →  (vuoto)
$ gh label list
bug · documentation · duplicate · enhancement · good first issue ·
help wanted · invalid · question · wontfix   (i default di GitHub, mai usati)
```

`gh` è disponibile e autenticato. Lo scope `repo` copre Issue, Milestone e
Label anche su un repository privato — **non serve rendere pubblico il
repository per iniziare questa migrazione**. Manca lo scope `project`: una
board GitHub Projects (v2) richiederebbe `gh auth refresh -s project` prima di
poterla popolare da CLI. Non lo eseguo — è un'azione che allarga
un'autorizzazione, e la propongo soltanto se l'owner vuole anche la board, non
solo Issue.

## C.2 Cosa c'è oggi, e chi lo possiede

| documento | righe | possiede |
|---|---|---|
| `docs/work/handoff.md` | 63 | ordine corrente + aperto-non-bloccante, in prosa compatta |
| `docs/work/day1/critical-path.md` | 335 | **ordine e dipendenze**, dichiarato esplicitamente ("non lo stato") |
| `docs/work/day1/requirements-status.md` | 713 | **inventario per riga**, A1…E-n, ciascuna con stato (READY/BLOCKER/OUT) ed evidenza |
| `docs/ROADMAP.md` | 441 | fasi di prodotto a orizzonte lungo, non lavoro settimanale |

**Nota per non confondere due cose.** `docs/ROADMAP.md` §"GitHub delivery" e
§"Issues are plans" (righe 213-236) parlano di una **capability futura di
Muffin**: l'agente che scrive lui stesso una issue o una PR. Questo memo parla
di una cosa diversa e più vicina: **come il progetto — gli umani — tracciano
oggi il proprio lavoro aperto**. Le due domande condividono la parola
"issue" e nient'altro; non vanno risolte con lo stesso meccanismo.

## C.3 La divisione proposta

**Resta prosa versionata nel repository**, perché è esattamente il materiale
per cui Git è lo strumento giusto — cronologia, diff, citabilità da un ADR:

- **ADR** (`docs/decisions/`) — già la convenzione, invariata.
- **Evidence** (`docs/evidence/`) — già la convenzione, invariata.
- **`docs/ROADMAP.md`** — l'orizzonte lungo, le fasi di prodotto. Non è lavoro
  della settimana, e una issue che vive per mesi senza mai chiudersi è il
  genere di rumore che una issue tracker esiste per evitare.
- **`docs/SECURITY.md`** — il threat model, distinto dal `SECURITY.md` di
  primo livello che manca (Parte D) e che serve a un altro scopo (dove
  segnalare una vulnerabilità, non come sono modellate le minacce).
- **`docs/work/day1/critical-path.md`** — resta prosa **per la parte che è
  ordine e dipendenza** (il diagramma `0→1→2→…→6`), perché una sequenza di
  passi con condizioni non è la forma di una issue GitHub. Diventa **una issue
  di tracciamento sola**, aggiornata a mano, la cui checklist linka le issue
  dei singoli item (`2a`, `2b`, `2c`, `2d`, `4-bis`, …) — pattern GitHub
  standard per un piano con un ordine.

**Diventa una issue GitHub**, una per riga aperta:

- Ogni riga di `requirements-status.md` **oggi `BLOCKER`** (non le `READY` —
  quelle sono chiuse, la loro prova vive già in Git/evidence e riaprirle come
  issue sarebbe duplicare uno stato che il commit già porta). Esempio contato:
  nella sola sezione B, le righe `BLOCKER` sono B2, B10, B11, B13, B15, B16 —
  sei issue dalla sola sezione B.
- Ogni voce di `handoff.md` §"Aperto, non bloccante" — sei voci oggi, sei
  issue.
- **Non** le righe `OUT` — sono deferral deliberate, e la loro casa resta
  `docs/ROADMAP.md`, che è dove `requirements-status.md` stesso rimanda
  (`B9`, `B12`, `B17`).

## C.4 Un esempio lavorato, non un'idea

Per provare che la migrazione è eseguibile e non solo desiderabile, ecco
**una** riga di `requirements-status.md` (B15, oggi `BLOCKER`) trasformata in
una issue reale — non aperta, solo scritta:

> **Titolo:** Owner binding non è nel Root of Trust — `ownerUserId` vive in
> config ordinaria
>
> **Label:** `area:B-runtime-continuity`, `status:blocker`
>
> **Corpo:**
> `identify()` è unica e cablata su Telegram e Discord (provato da test di
> impersonation su entrambi). Resta aperta la metà "protetto": il binding vive
> in `core/config/config.ts:80` (`config.json`, ordinaria), non nel Root of
> Trust. Riferimento: judge PR #42, 2026-08-16 (D1, GROUP_DM senza `guild_id`
> non deriva più `direct: true`). Prossimo passo tracciato:
> `slice/pairing-sigilla`.
>
> _Migrata da `docs/work/day1/requirements-status.md` riga B15,
> `91b9528`._

## C.5 Label proposte

I default di GitHub restano utili per un contributore esterno (`bug`,
`enhancement`, `good first issue`, `help wanted`) e non li tocco. Aggiungerei:

- `area:A-lifecycle` … `area:E-observability` (le cinque sezioni già esistenti
  di `requirements-status.md` — non un'invenzione, un rispecchiamento)
- `status:blocker`, `status:in-progress` (le due che restano dopo aver
  escluso `READY`/`OUT` dalla migrazione)

## C.6 Cosa NON faccio

Non ho aperto nessuna issue, nessuna label, nessun milestone. `gh` prova che
la strada è percorribile oggi (autenticato, scope sufficiente, repository
raggiungibile) — la migrazione stessa è una decisione dell'owner, non
un'esecuzione di questo memo.

---

# D. Cosa serve a un repo pubblico, e cosa manca davvero

## D.1 Misurato, non assunto

```sh
$ ls LICENSE README.md .github/pull_request_template.md
LICENSE  README.md  .github/pull_request_template.md
$ head -3 LICENSE
MIT License
Copyright (c) 2026 Giusto Piedimonte
$ find .github -type f
.github/pull_request_template.md
.github/workflows/{collegamenti,accettazione,strumenti,ci}.yml
```

**Esistono già** (aggiunti oggi stesso, prima di questo memo): `LICENSE`
(MIT), `README.md` (243 righe), `.github/pull_request_template.md`. Non li
rifaccio.

**Mancano davvero, verificato con `find`/`ls`, non a memoria:**
`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, un `SECURITY.md` di primo livello
(disclosure di vulnerabilità — diverso da `docs/SECURITY.md`, che è il threat
model), `.github/ISSUE_TEMPLATE/`.

## D.2 Perché propongo invece di aggiungere

Il mandato permette di aggiungere questi file se sono puramente additivi e
l'owner ne trae vantaggio subito. Non lo faccio per tre di loro, e dico
perché invece di limitarmi a non farlo:

- **`CONTRIBUTING.md`** codifica un processo reale (rami `slice/*`, PR verso
  `dev`, i profili di verifica di `docs/ORCHESTRATION.md`) che è una scelta
  dell'owner da ratificare, non da dedurre da questo memo.
- **`SECURITY.md`** di primo livello ha bisogno di un contatto reale per la
  disclosure privata. Non conosco quale canale l'owner vuole esporre
  pubblicamente, e scrivere un indirizzo a caso in un file che diventerà
  pubblico è peggio che non scriverlo.
- **`CODE_OF_CONDUCT.md`** è quasi puro boilerplate (Contributor Covenant), ma
  porta comunque un campo di contatto per le segnalazioni — stessa ragione del
  punto sopra.

Le tre bozze complete sono in §12, pronte per un commit dell'owner una volta
scelto il contatto. `.github/ISSUE_TEMPLATE/bug_report.md` e
`feature_request.md` sono in §12 allo stesso modo: non richiedono un contatto,
ma dipendono dalle label di §C.5, quindi li tengo insieme alla decisione su
quelle.

## D.3 Il secondo reperto: nessun linter, nessun formatter

```sh
$ find . -maxdepth 2 -iname "*eslint*" -o -iname "*.prettierrc*" -o -iname ".editorconfig" -o -iname "biome.json*" \
  | grep -v node_modules
(vuoto)
$ grep -i eslint package.json
(vuoto)
```

Confermato: zero configurazione di lint, zero formatter, zero
`.editorconfig`. `devDependencies` è `@grammyjs/types
@modelcontextprotocol/server @types/better-sqlite3 @types/node tsx typescript
vitest`; gli script sono `typecheck build compile test test:acceptance
acceptance:report prepare test:acceptance:linux gate:local e2e:telegram
eval:character mappa:regen` — nessuno di lint o format.

**La prova che il buco è reale, non teorico:** quattro `eslint-disable`
orfani già misurati in §B.4. Un contributore ha scritto quella sintassi
pensando (o copiando da un'abitudine) che un ESLint stesse leggendo; nessuno
lo fa.

## D.4 Le opzioni, lette dalla documentazione ufficiale

**Vitest è indifferente** (§A.4) — nessuna delle opzioni sotto cambia niente
per i test.

- **ESLint + typescript-eslint + Prettier.** L'incumbent, il più diffuso, il
  più esteso in regole. Costo di adozione più alto (tre configurazioni), più
  lento su una base di 220 file (le cifre di velocità che circolano — Biome
  10-25× più veloce — vengono da benchmark di blog, non dalla documentazione
  ufficiale, quindi le riporto come indicative e non le uso per decidere).
- **Biome.** Un binario solo, un file di configurazione solo, lint+format+
  organizzazione import insieme. La documentazione ufficiale
  (`biomejs.dev/guides/migrate-eslint-prettier/`) descrive `biome migrate
  eslint --write` / `biome migrate prettier --write` per chi **ha già** una
  configurazione da portare — **non il caso di questo repository**, che
  parte da zero: qui la strada è `biome init` seguito da `biome check
  --write`, più semplice ancora. Il costo dichiarato dalla stessa
  documentazione: "you are unlikely to get exactly the same behavior as
  ESLint" — non un problema qui, visto che non c'è un ESLint da eguagliare.
- **oxlint (+ Prettier o Biome per il formato).** La scelta reale del peer più
  comparabile per dominio, `sst/opencode` (agente di coding CLI in
  TypeScript): `.oxlintrc.json` + `.prettierignore` + `.editorconfig` +
  `.husky/` nel suo repository, misurato con `gh api` in §A.4. Rust, veloce,
  compatibile con un sottoinsieme delle regole ESLint; copertura di regole
  minore dell'ecosistema ESLint completo.

## D.5 Il costo di introdurlo su una base mai formattata

Il primo `format --write` (qualunque sia lo strumento) produce **un diff
meccanico enorme**, che tocca la maggior parte dei 220 file sorgente. Questo è
un costo noto e documentato, non specifico a questo repository — e la
mitigazione è altrettanto documentata **ufficialmente**, da GitHub stesso:
un file `.git-blame-ignore-revs` che elenca il commit di riformattazione,
configurabile con `git config blame.ignoreRevsFile .git-blame-ignore-revs` (
`docs.github.com`, "Viewing a file" — verificato oggi, non a memoria).

**Per questo repository specifico, preservare `git blame` non è un'opzione fra
tante — è strutturale.** Ogni file letto per questo memo porta commenti che
citano una data, una PR, una misura ("misurato il 27/08", "judge #106 giro
2"): la tracciabilità che `git blame` offre è esattamente il meccanismo con
cui questi commenti si verificano o si smentiscono (vedi Parte E). Un
riformattatore che disperde quella tracciabilità senza `.git-blame-ignore-revs`
costerebbe più di quanto il formatter dia.

**Prima o dopo l'apertura?** Prima. La prima PR di un contributore esterno è
il posto più caro per scoprire che lo stile non è imposto — o diventa
bikeshedding in review, o rumore in CI. Assorbire un diff meccanico enorme
sotto la review dell'owner stesso, oggi, costa meno che intrecciarlo con il
primo contributo di uno sconosciuto.

**Raccomandazione, non decisione:** Biome o oxlint+Prettier sono entrambi
difendibili; nessuno dei due tocca l'altro con un costo di uscita alto
(`biome migrate` esiste anche al contrario, e oxlint dichiara compatibilità
parziale con le regole ESLint). Non lo installo in questa PR — configurare un
linter tocca la formattazione di gran parte del codice, che è esattamente il
genere di cambiamento che questo scope esclude. È una PR a sé, non
necessariamente un ADR: nessuna delle due opzioni cambia authority, schema o
runtime — è una scelta di attrezzo, nel senso in cui questo repository le ha
già distinte altrove.

---

# E. Il 46% di commenti — non neutro, misurato per destinazione

*(Sezione riscritta dopo la correzione di rotta del coordinatore: la tesi da
provare è il **drift**, non il volume.)*

## E.1 Gli otto casi, riverificati uno per uno

```sh
$ grep -n "denied here" core/scheduler/commitments.ts
191:  // message is denied here and not merely unlikely to be written.
```

| # | file | stato oggi, verificato |
|---|---|---|
| 1 | `core/scheduler/commitments.ts:191` | **ancora in piedi, senza la riserva.** Il commento gemello di todo.ts (#2) include la clausola "finché la finestra di reiniezione lo copre"; questo no — resta la formulazione assoluta che la finestra di 40 turni smentisce oltre quella finestra (ADR-0060 §Limiti noti). |
| 2 | `agent/tools/todo.ts:60` | **corretto sul nascere**: il commento include già la clausola di finestra ("while the ceiling... still carries the page; beyond that window it can [speak]"). Non è il difetto — è l'esempio di come si scrive lo stesso fatto senza mentire. |
| 3 | `core/memory/spotlight.ts:45` | **auto-corretto a HEAD.** Il testo oggi dice "Falso, e un giudice l'ha eseguito" — la prosa registra la propria smentita passata, non la ripete. |
| 4 | `agent/tools/inspect.ts:115` | **ancora falso.** "Una riga di check, senza il testo di terze parti" — ma `doctor` stampa anche nomi di tool MCP scelti dal server (terze parti), come il commento stesso ammette due righe sotto parlando dell'embedder. |
| 5 | `agent/tools/fs.ts`, riferimento a `fence-non-sposta-decisioni.test.ts` | **non trovato a HEAD** (`grep -rn` sull'intero repository, zero risultati). O è già stato corretto prima di questo memo, o la citazione del coordinatore riporta un nome imparziale diverso da quello reale — non affermo quale delle due, perché non ho eseguito la prova che lo distingue. |
| 6 | `core/config/home-guard.ts` | **auto-corretto a HEAD** (commit `1b70b38`, oggi): il file ora dice esplicitamente "quell'affermazione era sbagliata prima ancora di questo lavoro" — documenta il proprio errore passato. |
| 7 | ADR-0060 §"Cosa la ribalterebbe" | **auto-corretto**: il paragrafo nomina se stesso ("una stesura precedente di questo paragrafo contraddiceva il §1-bis") e dà la versione riparata nello stesso respiro. |
| 8 | `docs/SECURITY.md` | **auto-corretto**: il testo attuale dice "the cost to an attacker is an approved `shell_run`, not code execution" — non la frase citata dal coordinatore. |

**Il fatto più importante di questa tabella non è quale numero ha vinto — è
che quattro casi su otto (3, 6, 7, 8) sono già la *cronaca della propria
correzione*, scritta a mano, dentro il commento stesso o l'ADR stesso.** Il
repository non solo genera drift, **gestisce il proprio drift riscrivendo il
commento con la data e la ragione della correzione** — che è esattamente il
pattern che la regola in E.3 rende superfluo: se quella riga fosse un test,
la correzione sarebbe "il test è tornato verde", non un nuovo paragrafo di
prosa a fianco di quello vecchio.

**Un nono caso, non nell'elenco dell'owner:** `agent/profiles/recovery.ts:134-136`
ammette da solo la propria obsolescenza — *"it does not any more (N1, judge,
2026-08-13; frontier.json is the one this comment forgot to catch up with)"*.
Un commento che sa di essere indietro e lo dice è un passo oltre gli otto
casi: non è stato scoperto da un giudice, si è auto-diagnosticato e non si è
corretto.

## E.2 Il metodo: campione dichiarato, non aneddotico

Campionamento sistematico: ogni 13° file sorgente non-test di `agent/`,
`core/`, `cli/` (154 file totali, ordinati alfabeticamente) →
12 file candidati. Letti per intero **11 su 12** (saltato
`core/memory/judge.ts` per budget — dichiarato, non nascosto). 1126 righe di
commento classificate a mano, blocco per blocco, in quattro destinazioni:

- **WHY** — motiva una scelta di design, spesso con una data o un incidente
  citato → candidato ADR
- **MEASURE** — un numero o un invariante misurato, usato a giustificare una
  costante o un accoppiamento fra file → candidato test
- **WHAT** — ridice cosa fa il codice → candidato cancellazione
- **OTHER** — riferimento tecnico necessario (es. spec di un formato binario)
  o JSDoc di campo che un IDE mostra a un chiamante

| file | righe commento | WHY | MEASURE | WHAT | OTHER |
|---|---|---|---|---|---|
| `agent/audio.ts` | 52 | 28 | 10 | 0 | 14 |
| `agent/profiles/recovery.ts` | 139 | 125 | 0 | 6 | 8 |
| `agent/tools/extract.ts` | 50 | 33 | 17 | 0 | 0 |
| `cli/adopt.ts` | 162 | 140 | 0 | 0 | 22 |
| `cli/observe.ts` | 81 | 71 | 0 | 10 | 0 |
| `cli/trace.ts` | 52 | 45 | 0 | 7 | 0 |
| `core/policy/types.ts` | 177 | 159 | 8 | 10 | 0 |
| `core/tracing/tracer.ts` | 17 | 14 | 0 | 3 | 0 |
| `core/config/inventory.ts` | 78 | 68 | 0 | 10 | 0 |
| `core/gateway/service.ts` | 251 | 221 | 20 | 10 | 0 |
| `core/scheduler/jobs.ts` | 67 | 55 | 7 | 5 | 0 |
| **totale** | **1126** | **959 (85,2%)** | **62 (5,5%)** | **61 (5,4%)** | **44 (3,9%)** |

**Il numero che ribalta l'intuizione di partenza: solo il 5,4% è "cosa fa il
codice" — il candidato più ovvio alla cancellazione è anche il più piccolo.**
L'85,2% è motivazione di design (WHY), spesso densissima, spesso con
riferimenti a date, ADR, PR e incidenti specifici — la classe che la regola
dell'owner sposta in un ADR, non elimina. Il 5,5% (MEASURE) è la parte più
azionabile: un numero che oggi vive solo in prosa e potrebbe fallire un test
invece di invecchiare in silenzio.

## E.3 La regola, valutata riga per riga sul campione

La regola proposta dal coordinatore, per destinazione:

- **cosa fa il codice → si toglie** (il codice lo dice già)
- **perché questa scelta → ADR**, versionato e datato
- **una misura → un test** — un test fallisce quando smette di essere vero,
  un commento no
- **un vincolo sul cambiamento futuro → un test**

Applicata al campione, tre osservazioni misurate, non ipotizzate:

1. **La cancellazione (WHAT) è la mossa più piccola e la più sicura**: 61
   righe su 1126, quasi tutte JSDoc-di-campo ridondante
   (`/** Standard 5-field cron expression. */` sopra `cron: string`) che un
   editor con hover-doc mostra comunque — questi non sono "cattivi", sono
   ridondanti col tipo stesso, e toglierli non perde niente che TypeScript non
   dica già.
2. **Il vero costo è nell'85,2% WHY**, e la regola qui è più delicata di
   "sposta tutto in ADR": molte di queste righe **sono** già la sostanza di un
   ADR (`core/policy/types.ts` cita ADR-0053 riga per riga), e spostarle
   davvero significherebbe *citare* l'ADR invece di *ripeterlo* — non un
   taglio, una deduplicazione fra due posti che oggi dicono la stessa cosa in
   parole diverse (lo stesso genere di dispersione della Parte B, ma in
   prosa invece che in codice). Non l'ho quantificato — richiederebbe
   incrociare ogni blocco WHY con l'ADR che cita, task per un giro dedicato.
3. **Il 5,5% MEASURE è la prova che la domanda dell'owner ha risposta
   positiva.** Candidati concreti, trovati eseguendo, non ipotizzati:
   - `agent/audio.ts` `MAX_AUDIO_BYTES = 20MB`, giustificato in prosa dal
     limite del Bot API di Telegram (`connectors/telegram/media.ts`) — oggi
     un'affermazione, potrebbe essere un test che confronta le due costanti.
   - `agent/tools/extract.ts` `MIN_PLAUSIBLE_EXTRACTED_CHARS = 300`,
     giustificato da una misura citata in `docs/evidence/recupero-dal-web.md`
     (una pagina di 1.325.730 caratteri che un estrattore riduceva a 217) —
     esiste già l'evidence, manca il test di regressione sulla stessa pagina.
   - `core/gateway/service.ts` `TICK_MS = HEARTBEAT_MS` (accoppiamento fra due
     costanti spiegato in prosa, non asserito), `EXIT_ALREADY_RUNNING = 75`,
     `EXIT_STOPPED = 143` (ognuno con un paragrafo che spiega perché quel
     numero e non un altro).

## E.4 Il secondo reperto: adottare un linter non chiude nessuno degli otto

Domanda posta esplicitamente dal coordinatore: un lint avrebbe preso uno degli
otto casi? **Risposta onesta, non quella che avrei preferito trovare: no,
nessuno dei tre strumenti valutati in Parte D (ESLint, Biome, oxlint)
individua una frase falsa.** Tutti e otto sono deriva **semantica** — un
commento che descrive un comportamento che il codice non ha più — e un linter
verifica la forma del codice, non la verità di una frase in un commento.
Confonderli sarebbe l'errore opposto a quello che questo memo vuole evitare:
regola dei commenti e tooling di lint risolvono due problemi diversi, e
adottare l'uno non sostituisce l'altro.

**Ciò che un linter risolverebbe davvero, misurato in questo stesso memo:** i
quattro `eslint-disable-next-line` orfani di §B.4/D.3. Con
`linterOptions.reportUnusedDisableDirectives` (ESLint, configurazione
ufficiale, default `"warn"`) o l'equivalente di Biome/oxlint, quei quattro
diventerebbero un avviso reale al primo giro di CI — non uno degli otto casi
dell'owner, ma la stessa famiglia di prosa-che-mente-perché-nessuno-la-legge-più.

---

## Riepilogo delle raccomandazioni

| area | verdetto | azione proposta |
|---|---|---|
| A — test | non spostare | co-locazione confermata dai pari reali; rivedere i 50 file di test sovradimensionati, non la cartella |
| B — dispersione | consolidare 2, lasciare 1 | `sleep()`×4 → un util condiviso; `backoffMs` documentata → solo una riga di convenzione; 4 `eslint-disable` orfani → si risolvono da soli adottando un linter |
| C — issue GitHub | migrare le righe aperte | issue per ogni `BLOCKER` di `requirements-status.md` e ogni voce di `handoff.md`; `critical-path.md` diventa una issue di tracciamento sola; `ROADMAP.md`/ADR/evidence restano prosa |
| D — file mancanti | proporre, non commitare | bozze pronte in §12 per `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue template — mancano solo un contatto e una ratifica; adottare Biome o oxlint+Prettier, in una PR a sé, prima dell'apertura |
| E — commenti | regola per destinazione, non potatura | WHAT si toglie (5,4%, sicuro); MEASURE diventa test (5,5%, concreto — tre esempi trovati); WHY diventa ADR **quando duplica un ADR esistente**, altrimenti resta (85,2%, la maggioranza legittima) |

Un ADR proposto per la regola dei commenti è in
`docs/decisions/0062-un-commento-vale-per-la-sua-destinazione.md`, numerato
dopo l'ultimo (`0061`, verificato fresco da `origin/dev` oggi). Non cambia
codice.

---

## 11. Comandi eseguiti, riproducibili

Tutti i comandi di misura di questo memo sono riprodotti inline nelle sezioni
sopra, nel punto in cui il numero è citato. Aggiuntivi, non ripetuti sopra:

```sh
$ npx knip   # elenco completo
Unused files (1): docs/derived/architecture-map/post-merge-regen.mjs
Unused exports (26): COMMITMENT_TENANT (agent/commitment-run.ts:31), SOGLIA
  (agent/context/eco.ts:172), spendeIlBudget/replyRefusedText (agent/loop.ts),
  speaksReasoningEffort (agent/providers/openai-compat.ts:134),
  ORIENTAMENTO_USAGE (cli/orientamento.ts:19), COMANDI (cli/repl.ts:46),
  SUPERFICI_NOTE (cli/surface.ts:65), CHANNELS/DEFAULT_CHANNEL/isChannel/
  currentGatewayPid/waitForGatewayPid/UPDATE_USAGE (cli/update.ts), ConfigSchema/
  SECRET_BACKENDS/requireSecretRef (core/config/config.ts), commitmentAnchor/
  LATE_AFTER_MS/recordCommitmentFired/recordCommitmentDenied
  (core/scheduler/commitments.ts), SCENE (evals/security/attacks/corpus.ts:817),
  sinkOf (evals/security/candidate-b.ts:132), FLOW_BY_SCENARIO/FLOW_SCENARIOS/
  flowOf (evals/security/flow.ts)
Unused exported types (15): ApprovalAnswer (agent/loop.ts:287), CapabilityGapKind
  (agent/tools/capability-status.ts:22), Lane (cli/model.ts:34), UpdateStep
  (cli/update.ts:203), InlineButton (connectors/telegram/api.ts:50), RegistryEntry/
  DriftStatus/GitLogResult (core/config/defaults-drift.ts), ControlAnswer
  (core/gateway/control-socket.ts:50), ExtractionUsage (core/memory/extract.ts:260),
  ToolShare/TurnDistribution (core/turns/orientamento-report.ts), Fermato/Controllo/
  Sink (evals/security/attacks/corpus.ts)

$ npx tsc --noEmit -p tsconfig.json          # exit 0
$ npx vitest run docs/collegamenti docs/derived/architecture-map docs/decisions
  # 3 file, 17 test, exit 0
$ npx vitest run                              # 249 file, 3184 passati + 3 skip, exit 0
```

`npm ci` è stato necessario prima di tutto il resto: il worktree suggerito dal
mandato ha un symlink a `node_modules` del checkout principale, che oggi è
**vuoto** (0 byte) — `npx vitest`/`npx knip` funzionano comunque perché `npx`
scarica i pacchetti al volo, ma `npx tsc` da solo risolve al pacchetto npm
letterale `tsc` (un easter-egg npm, non il compilatore) e fallisce finché non si
installa `typescript` per davvero. Segnalato perché il prossimo worktree da
questo mandato ripete lo stesso passo, non perché riguardi la forma del
repository.

---

## 12. Bozze pronte, non commitate (Parte D)

### `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, adattato)

> Bozza completa, contatto da riempire (`[EMAIL DI CONTATTO]`) prima del
> commit. Testo standard Contributor Covenant 2.1, sezioni Pledge/Standards/
> Enforcement Responsibilities/Scope/Enforcement/Guidelines/Attribution,
> con il canale di segnalazione puntato a
> `[EMAIL DI CONTATTO]` o, in alternativa, a una GitHub Security Advisory
> privata sul repository stesso una volta pubblico.

### `SECURITY.md` (primo livello, disclosure — non il threat model)

> **Segnalare una vulnerabilità.** Non aprire una issue pubblica. Scrivere a
> `[EMAIL DI CONTATTO]` o aprire una GitHub Security Advisory privata
> (`Security` → `Advisories` → `Report a vulnerability`). Tempo di risposta
> atteso: [DA DEFINIRE]. Per il modello di minaccia di Muffin — cosa il
> sistema protegge e da chi — vedi `docs/SECURITY.md`, che è un documento
> diverso con uno scopo diverso.

### `CONTRIBUTING.md` (scheletro, da ratificare)

> **Prima di aprire una PR.** Questo repository segue `docs/ORCHESTRATION.md`
> per i profili di verifica (FAST/STANDARD/CRITICAL) e `AGENTS.md`/`CLAUDE.md`
> come router delle convenzioni. Rami `slice/<nome-descrittivo>`, PR verso
> `dev` (non `main` — vedi la memoria di progetto "Worktree da dev, non da
> main"). Lingua: ADR-0020 — codice, identificatori, commit e interfacce
> tecniche in inglese; il materiale di design interno può essere in italiano,
> mai un doppione bilingue. [Sezione da completare con l'owner: come un
> contributore esterno, senza accesso a `docs/work/`, propone un cambiamento —
> probabilmente "apri una issue prima di una PR non banale".]

### `.github/ISSUE_TEMPLATE/bug_report.md`

> Campi: cosa hai fatto, cosa ti aspettavi, cosa è successo, versione/commit,
> piattaforma (macOS/Linux — il repository ha già una distinzione forte fra i
> due, vedi la memoria "Linux prima, macOS poi").

### `.github/ISSUE_TEMPLATE/feature_request.md`

> Campi: quale problema risolve, alternative considerate, se tocca
> authority/effect/schema (in tal caso: leggi prima `docs/RESEARCH.md`).
