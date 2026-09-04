# Cinque rami fermi a metà — verdetto per ciascuno, con la prova eseguita

**Data:** 2026-09-04 · **Stato:** evidence datata, non authority · **Head:**
`dev` `57bc772`. **Passo:** censimento e verdetto, non ricerca di design — un
solo ramo (steer-un-imbuto) ha prodotto codice, e per una riparazione
meccanica su un difetto già trovato dal branch fermo stesso.

Commissionato dalle parole dell'owner: *«sono sicuro abbiano cose utili
lasciate a metà, lasciamo troppe cose a metà»*. Cinque rami, un verdetto
ciascuno in una di tre forme — **ripreso** (PR aperta), **scartato** (ragione
scritta e verificata), o **valido ma non ora** — nessuno lasciato senza.

La regola con cui ognuno è stato giudicato, dalla stessa `AGENTS.md`: *un
meccanismo che esiste non è la stessa affermazione dell'esito giusto.* Per
ognuno la domanda non è «il codice del branch è buono» ma «il difetto che
voleva chiudere è ancora aperto su `dev` di oggi» — risposta ottenuta
eseguendo il percorso di produzione, non leggendo il diff e deducendo.

## Sommario

| # | Ramo | Verdetto | PR |
|---|------|----------|----|
| 1 | `wip/deleghe-mai-registrata` | **scartato** — il cerotto #80 è già sostituito dal fix vero | — |
| 2 | `wip/repl-linereader-pipe-eof` | **scartato** — il REPL è stato riscritto, il difetto non riproduce | — |
| 3 | `origin/slice/steer-un-imbuto` | **ripreso** — due fughe vere confermate per esecuzione, riparate | [#390](https://github.com/GiustoPiedimonte/muffin-agent/pull/390) |
| 4 | `origin/slice/le-mie-parole-non-sono-prove` | **scartato** — confermato dal branch stesso, e dal test vivo | — |
| 5 | `origin/integrazione/tre-slice` | **scartato** — la scelta modello/whisper è già in produzione | — |

---

## 1. `wip/deleghe-mai-registrata` — scartato

**Claim del branch** (`201e025`): «la correzione vera dietro il cerotto #80» —
un `MAI_REGISTRATA` condiviso, l'avviso «N chiuse senza registrazione» in
`riprendi`, tre test, la regola di `docs/BRANCHING.md` sul merge commit invece
dello squash.

**Trovato:** la stessa correzione — parola per parola la stessa origine
(«trovata non committata nel worktree insights, sessione del 18/08») — è già
su `dev` dal commit `89e9536` (22/08/2026, *«deleghe: the real fix behind the
cerotto, and the registry reconciled»*), landato subito dopo il cerotto
`3720377`. Il branch WIP è un duplicato fermo dello stesso lavoro che ha
raggiunto `dev` per un'altra strada.

**Prova eseguita**, non dedotta:

```
$ git show origin/dev:.claude/deleghe.mjs | grep -n "MAI_REGISTRATA\|chiuse senza registrazione"
117:const MAI_REGISTRATA = '(mai registrata)';
802:    console.log(`\n⚠ ${mai.length} chiuse senza registrazione: ...`);

$ git show origin/dev:.claude/deleghe.test.ts | grep -n "says why it matters"
210:  it('says why it matters: no mandate and no brief survive for those', () => {

$ git show origin/dev:docs/BRANCHING.md | grep -n -i squash
30:6. Integrate with a merge commit, not a squash. ...
```

Suite reale eseguita su `dev` (worktree `npm ci` pulito):
`.claude/deleghe.test.ts` → **25/25 verde**, inclusa esattamente quella riga
di test. Nessuna modifica necessaria: il ramo non porta niente che `dev` non
abbia già, con lo stesso meccanismo e la stessa origine dichiarata.

## 2. `wip/repl-linereader-pipe-eof` — scartato

**Claim del branch** (`12f5656`): su un input non-TTY, `cli/repl.ts` (allora
basato su `readline/promises` + `rl.question()`) leggeva solo la prima riga di
un chunk (`printf '/spend\n/exit\n' | muffin` perdeva `/exit`), e `close()` non
risolveva mai una domanda pendente — `muffin < /dev/null` usciva 13, senza
`ciao.` e senza `runtime.close()`.

**Trovato:** `cli/repl.ts` è stato riscritto dopo la base del branch (`#218`
ha rimosso `readline` del tutto, sostituito dall'architettura "textzone" con
`process.stdin` in modalità raw/gestita a mano — commento in linea 93-94 di
`cli/repl.ts` su `dev`). Il meccanismo che il branch corregge non esiste più:
non c'è niente da riparare *in quel punto*, perché quel punto è stato sostituito.

**Prova eseguita**, sul binario compilato (`npm run compile`), in un
`MUFFIN_HOME` usa-e-getta (`muffin init` con chiave finta, provider
`anthropic`):

```
$ MUFFIN_HOME=<home-di-prova> node dist/cli/main.js repl < /dev/null
...
ciao.
$ echo $?
0

$ printf '/spend\n/exit\n' | MUFFIN_HOME=<home-di-prova> node dist/cli/main.js repl
...
$0.0000 / $80 questo mese      # /spend ha risposto
oggi: $0.0000
ciao.                          # /exit ha chiuso, non è stato perso
$ echo $?
0
```

Entrambi gli scenari che il branch nomina esplicitamente si comportano oggi
esattamente come il branch li voleva: exit 0, `ciao.` stampato, ogni riga
della pipe servita. Nessun cerotto da applicare; il difetto è chiuso da
un'architettura diversa, non dalla correzione proposta.

## 3. `origin/slice/steer-un-imbuto` — **ripreso** ([PR #390](https://github.com/GiustoPiedimonte/muffin-agent/pull/390))

**Claim del branch** (`80a7c87`): fermato «senza verificare» sul sospetto che
`/steer` fosse superato da ADR-0054, entrato dopo. **Non era superato.**

`/steer` è davvero implementato su `dev` (`agent/comandi.ts`, ADR-0054), ma il
branch fermo porta un *emendamento* a quell'ADR — «un imbuto invece di una
lista di siti» — che descrive un difetto trovato da un giudice indipendente:
il drain delle correzioni `/steer` pendenti era riparato in tre siti diversi
del motore (`agent/loop.ts`), e ogni riparazione lasciava scoperta un'altra
uscita.

**Verificato per esecuzione, non per lettura del diff.** Il file di test del
branch fermo (`agent/steer-imbuto.test.ts`) è stato portato **invariato** sul
`dev` di oggi e fatto girare *prima* di scrivere qualunque riga di fix:

```
$ npx vitest run agent/steer-imbuto.test.ts     # test del branch, codice di dev
 ❯ agent/steer-imbuto.test.ts (8 tests | 4 failed)
   × il provider esaurisce i ritentativi e rilancia: la correzione resta, e il turno dopo la vede
   × l imbuto è portante: se una sessione rotta lo fa fallire, il turno lo dice all owner
   × su /stop non si ripesca niente, e la porta resta vuota
   × una ripresa rifiutata non seppellisce la correzione: il rifiuto la riporta all owner
```

4 fallimenti reali su 8, contro l'`agent/loop.ts` vero di `dev`. I due che
contano di più:

- **il rethrow del provider.** Quando i ritentativi si esauriscono, il motore
  (`drive`, oggi rinominato `guidaIlTurno`) rilancia senza mai passare da
  `finish` — nessuno dei tre drain di sito copre questa uscita, e la
  correzione `/steer` sparisce con il turno.
- **una ripresa rifiutata.** `resumeTurn` rifiuta `model_changed` o
  `resumes_exhausted` **prima** di entrare nel motore: una correzione che la
  sospensione aveva parcheggiato in `record.messages` resta conservata e
  irraggiungibile per sempre — la riga si chiude e nessun modello la vedrà mai.

Gli altri due fallimenti (`/stop` non svuota la coda; una scrittura fallita
resta silenziosa su uno span invece che nel testo del turno) sono difetti
minori della stessa famiglia, misurati dallo stesso test.

**Fix implementato** (rebase a mano del meccanismo del branch fermo su
`agent/loop.ts` di oggi, che nel frattempo era cambiato molto): `drive`
diventa un guardiano attorno al motore rinominato `guidaIlTurno`. Il motore
può uscire solo tornando o lanciando; su entrambe le strade il guardiano
svuota la porta di steer (più `recupero`, ciò che un sito interno ha già
tolto dalla porta senza riuscire a scriverlo) e lo scrive in sessione — tranne
su `aborted`, dove l'owner ha detto `/stop` e la porta si svuota e si butta di
proposito. Una scrittura fallita è ora nominata nel testo del turno.
`resumeTurn` guadagna `codaMaiVista`, che riporta all'owner — nel `detail` del
rifiuto, mai nella sessione, perché il loop non ha modo di distinguere le
proprie frasi da quelle dell'owner oltre quel punto — ciò che il modello non
ha mai visto.

**Prova, per la PR #390:**

- `npx tsc --noEmit` → 0
- `npx vitest run` (piena, 250 file) → **3194/3197** (3 skip preesistenti)
- `agent/steer-imbuto.test.ts` (il test del branch fermo, invariato) → **8/8**
- **Mutazione obbligatoria:** rimosso il drain del ramo di rethrow in `drive`
  → il test portato torna rosso per davvero (`expected +0 to be 1`); ripristino
  da `imbuto-steer-agent-loop-ts-backup-preMutazione.ts` (mai `git checkout
  --`) → verde di nuovo, confermato con `vitest` + `tsc`.
- `npm run mappa:regen` → un'ancora ha seguito il testo che l'estrazione di
  `DriveOptions` ha spostato, riancorata; mappa verde.

## 4. `origin/slice/le-mie-parole-non-sono-prove` — scartato

**Claim del branch stesso** (`2f4a742`): fermato scoprendo che la radice era
già chiusa da `describeEpisodeSource` (`core/memory/recall.ts`, commit
`b9093ba` del 19/08), che marca già lo speaker di ogni episodio indipendentemente
dal trust tier — e cita `recall-speaker.test.ts` come prova che il meccanismo
regge.

**Verificato**, non solo letto sul messaggio di commit:

```
$ git grep -n "function describeEpisodeSource" origin/dev -- core/memory/recall.ts
origin/dev:core/memory/recall.ts:976:function describeEpisodeSource(...)

$ git ls-tree -r origin/dev --name-only | grep recall-speaker
core/memory/recall-speaker.test.ts
```

Il test esiste su `dev`, descrive esattamente l'invariante nominato
(*"recall preserves episode speaker independently from trust"*), e la suite
reale gira verde (2 file, 28 test, incluso questo). Il ramo si autodichiara
superato ed è vero: nessuna riga da riprendere.

## 5. `origin/integrazione/tre-slice` (note vocali) — scartato

**Claim del branch:** decidere fra mandare l'audio a un modello multimodale o
trascriverlo in casa con whisper.cpp — il bivio dell'owner del 28/08/2026.

**Attenzione segnalata nel mandato:** `core/audio/trascrivi.ts` esiste già su
`dev`, quindi *o* il ramo è superato *o* contiene la metà mancante (la
scelta). Verificato quale delle due, non assunto:

```
$ diff <(git show origin/dev:core/audio/voce.ts) <(git show origin/integrazione/tre-slice:core/audio/voce.ts)
(nessuna differenza — byte-identico)

$ diff <(git show origin/dev:agent/providers/modalita.ts) <(git show origin/integrazione/tre-slice:agent/providers/modalita.ts)
(nessuna differenza — byte-identico)

$ diff <(git show origin/dev:core/audio/trascrivi.ts) <(git show origin/integrazione/tre-slice:core/audio/trascrivi.ts)
94 righe di differenza — dev ha IN PIÙ `prerequisitiTrascrizione` (preflight
per `muffin doctor`, misurato sull'installazione dell'owner il 02/09/2026),
assente nel branch fermo.
```

`core/audio/voce.ts::decidiVoce` — il modulo che *fa* la scelta — è
byte-identico fra `dev` e il branch fermo, ed è cablato in produzione:
`cli/surface.ts:476` e `connectors/telegram/connector.ts` lo chiamano
entrambi. `dev` è **avanti**, non indietro: ha lo stesso meccanismo di scelta
più il preflight che `doctor` usa per dirlo prima che arrivi la prima nota
vocale.

**Prova per esecuzione reale**, non mock — compilato `dev` (`npm run
compile`) e fatto girare `core/audio/trascrivi.ts`/`core/audio/voce.ts` con
`ffmpeg` e `whisper-cli` veri di questa macchina e il modello locale
dell'owner (letto in sola lettura, mai copiato nel repo):

```
$ node prova-voce.mjs
--- trascrivi() reale, ffmpeg+whisper-cli veri ---
{"ok":true,"testo":"rather not a vocale."} (1145ms)

--- decidiVoce() con un modello che NON accetta audio ---
{"modo":"trascritto","testo":"rather not a vocale."}

--- decidiVoce() con baseUrl reale e un modello inventato ---
{"modo":"trascritto","testo":"rather not a vocale."}
```

(Trascrizione imprecisa — la voce TTS di macOS che ha letto «prova nota
vocale» non è la voce dell'owner — ma la pipeline reale ha girato per
davvero: `ffmpeg` ha convertito, `whisper-cli` ha trascritto con il modello
`ggml-base.bin` vero, e `audioAccettato` ha fatto una richiesta di rete reale
a `openrouter.ai/api/v1/models` prima di cadere sul ramo locale, esattamente
come documentato.) La suite del branch girata su `dev` (`core/audio/voce.test.ts`,
`core/audio/trascrivi.test.ts`, `connectors/telegram/voice-arrival.test.ts`,
`agent/providers/modalita.test.ts`) è **31/31 verde**.

Nessuna riga da riprendere: la scelta multimodale/whisper è già in produzione,
cablata su entrambe le porte (CLI e Telegram), e `dev` supera il branch fermo
sul preflight di `doctor`.

## Numeri finali

- **PR aperte da questo censimento:** [#390](https://github.com/GiustoPiedimonte/muffin-agent/pull/390) — `slice/imbuto-correzioni-steer`.
- **Rami scartati, con prova eseguita:** `wip/deleghe-mai-registrata`,
  `wip/repl-linereader-pipe-eof`, `slice/le-mie-parole-non-sono-prove`,
  `integrazione/tre-slice`.
- **Rami "validi ma non ora":** nessuno — ogni ramo è arrivato a un verdetto
  definitivo (ripreso o scartato) con prova eseguita, non è rimasto niente in
  sospeso da sbloccare più tardi.
- **Cancellazione dei branch:** non eseguita da questa sessione (vincolo del
  mandato) — il verdetto è scritto qui, la cancellazione la fa l'owner dopo
  averlo letto.
